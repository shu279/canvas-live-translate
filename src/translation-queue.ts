import type { TranslationPart } from "./translation-core";

/** The provider must align these entries by explicit input IDs, not by guessing order. */
export interface QueueBatchResult {
  translations: Array<string | null>;
  issue?: string;
}

export interface TranslationQueueStats {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  activeRequests: number;
  paused: boolean;
}

export interface TranslationJob {
  key: string;
  part: TranslationPart;
  /** Larger priorities are processed first (for example, on-screen cards). */
  priority?: number;
  isCurrent?: () => boolean;
  onResult: (translation: string) => void | Promise<void>;
  onFailure?: (message: string) => void;
}

export interface TranslationQueueOptions {
  translate: (parts: TranslationPart[], signal: AbortSignal) => Promise<QueueBatchResult>;
  getCached?: (key: string) => string | undefined;
  cacheResult?: (key: string, value: string) => void;
  onProgress?: (stats: TranslationQueueStats) => void;
  onError?: (error: Error, fatal: boolean) => void;
  concurrency?: number;
  maxItems?: number;
  maxCharacters?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  dispatchDelayMs?: number;
}

interface Subscriber {
  active: boolean;
  isCurrent?: () => boolean;
  onResult: TranslationJob["onResult"];
  onFailure?: TranslationJob["onFailure"];
}

interface WorkItem {
  key: string;
  part: TranslationPart;
  priority: number;
  sequence: number;
  state: "queued" | "active" | "completed" | "failed";
  attempts: number;
  readyAt: number;
  subscribers: Set<Subscriber>;
  result?: string;
  failure?: string;
}

interface ErrorDetails {
  fatal?: boolean;
  retryable?: boolean;
  retryAfterMs?: number;
  status?: number;
  code?: string;
}

const MAX_RETRY_DELAY_MS = 60_000;

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(1, Math.floor(value))) : fallback;
}

/**
 * One scheduler is owned by one enabled Canvas session. It batches/deduplicates
 * API work, not DOM nodes: every source key may have several presentation targets.
 * Destroying the session suppresses all later display/cache callbacks, even when
 * the host network adapter cannot physically cancel an already-sent request.
 */
export class TranslationQueue {
  // requestUrl cannot physically abort an HTTP request. Keep old sessions in this
  // shared budget until their promises settle, including after toggle/tab changes.
  private static globalActiveRequests = 0;
  private static readonly waitingQueues = new Set<TranslationQueue>();
  private readonly items = new Map<string, WorkItem>();
  private readonly controllers = new Set<AbortController>();
  private readonly concurrency: number;
  private readonly maxItems: number;
  private readonly maxCharacters: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly dispatchDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = 0;
  private activeRequests = 0;
  private sequence = 0;
  private destroyed = false;
  private paused = false;
  private globalReadyAt = 0;
  private progressScheduled = false;
  private readonly reportedErrors = new Set<string>();

  constructor(private readonly options: TranslationQueueOptions) {
    this.concurrency = positiveInteger(options.concurrency, 3, 6);
    this.maxItems = positiveInteger(options.maxItems, 24, 64);
    this.maxCharacters = positiveInteger(options.maxCharacters, 6500, 20_000);
    this.maxAttempts = positiveInteger(options.maxAttempts, 3, 5);
    this.retryBaseMs = Math.max(0, options.retryBaseMs ?? 500);
    this.dispatchDelayMs = Math.max(0, options.dispatchDelayMs ?? 30);
  }

  get stats(): TranslationQueueStats {
    let completed = 0;
    let failed = 0;
    for (const item of this.items.values()) {
      if (item.state === "completed") completed++;
      if (item.state === "failed") failed++;
    }
    return {
      total: this.items.size,
      completed,
      failed,
      pending: this.items.size - completed - failed,
      activeRequests: this.activeRequests,
      paused: this.paused
    };
  }

  /** Returns an unsubscribe callback for targets removed/replaced by Obsidian. */
  enqueue(request: TranslationJob): () => void {
    if (this.destroyed) return () => {};
    const subscriber: Subscriber = {
      active: true,
      isCurrent: request.isCurrent,
      onResult: request.onResult,
      onFailure: request.onFailure
    };
    let item = this.items.get(request.key);
    if (!item) {
      let cached: string | undefined;
      try { cached = this.options.getCached?.(request.key); } catch { /* A cache failure must not stop translation. */ }
      item = {
        key: request.key,
        part: { ...request.part },
        priority: request.priority ?? 0,
        sequence: this.sequence++,
        state: typeof cached === "string" && cached.trim() !== "" ? "completed" : "queued",
        attempts: 0,
        readyAt: 0,
        subscribers: new Set(),
        result: cached
      };
      this.items.set(request.key, item);
    } else {
      item.priority = Math.max(item.priority, request.priority ?? 0);
    }
    item.subscribers.add(subscriber);
    if (item.state === "completed" && item.result !== undefined) {
      this.deliver(subscriber, item.result);
      item.subscribers.delete(subscriber);
    } else if (item.state === "failed") {
      this.deliverFailure(subscriber, item.failure ?? "Translation could not be completed.");
    }
    this.notifyProgress();
    this.schedule(this.dispatchDelayMs);
    return () => {
      subscriber.active = false;
      item!.subscribers.delete(subscriber);
      // Do not cancel shared in-flight work when one card leaves the viewport.
      if (item!.state === "queued" && item!.subscribers.size === 0) {
        this.items.delete(item!.key);
        this.notifyProgress();
      }
    };
  }

  /** Manual retry is explicit; a permanently bad segment is never retried forever. */
  retryFailed(): void {
    if (this.destroyed) return;
    this.paused = false;
    this.globalReadyAt = 0;
    this.reportedErrors.clear();
    for (const item of this.items.values()) {
      if (item.state === "failed" || item.state === "queued") {
        item.state = "queued";
        item.attempts = 0;
        item.readyAt = 0;
        item.failure = undefined;
      }
    }
    this.notifyProgress();
    this.schedule(0);
  }

  /** Recompute priorities after a pan/scroll; values may go down as well as up. */
  setPriorities(priorities: ReadonlyMap<string, number>): void {
    if (this.destroyed) return;
    for (const [key, priority] of priorities) {
      const item = this.items.get(key);
      if (item?.state === "queued" && Number.isFinite(priority)) item.priority = priority;
    }
    this.schedule(0);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    TranslationQueue.waitingQueues.delete(this);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const item of this.items.values()) {
      for (const subscriber of item.subscribers) subscriber.active = false;
      item.subscribers.clear();
    }
    this.items.clear();
  }

  private current(subscriber: Subscriber): boolean {
    if (this.destroyed || !subscriber.active) return false;
    try { return subscriber.isCurrent?.() ?? true; } catch { return false; }
  }

  private prune(item: WorkItem): boolean {
    for (const subscriber of item.subscribers) {
      if (!this.current(subscriber)) item.subscribers.delete(subscriber);
    }
    return item.subscribers.size > 0;
  }

  private deliver(subscriber: Subscriber, result: string): void {
    if (!this.current(subscriber)) return;
    try {
      const pending = subscriber.onResult(result);
      if (pending) void pending.catch(() => {
        this.deliverFailure(subscriber, "The translation was received, but the card could not be updated.");
      });
    } catch {
      this.deliverFailure(subscriber, "The translation was received, but the card could not be updated.");
    }
  }

  private deliverFailure(subscriber: Subscriber, message: string): void {
    if (!this.current(subscriber)) return;
    try { subscriber.onFailure?.(message); } catch { /* Presentation callbacks cannot break queue progress. */ }
  }

  private notifyProgress(): void {
    if (this.destroyed || this.progressScheduled) return;
    this.progressScheduled = true;
    queueMicrotask(() => {
      this.progressScheduled = false;
      if (this.destroyed) return;
      try { this.options.onProgress?.(this.stats); } catch { /* UI callback only. */ }
    });
  }

  private report(error: Error, fatal: boolean): void {
    if (this.destroyed) return;
    const signature = `${fatal}:${error.message}`;
    if (this.reportedErrors.has(signature)) return;
    this.reportedErrors.add(signature);
    try { this.options.onError?.(error, fatal); } catch { /* UI callback only. */ }
  }

  private schedule(delay: number): void {
    if (this.destroyed || this.paused || this.activeRequests >= this.concurrency) return;
    if (TranslationQueue.globalActiveRequests >= this.concurrency) {
      TranslationQueue.waitingQueues.add(this);
      return;
    }
    const dueAt = Date.now() + Math.max(0, delay);
    if (this.timer !== null && this.timerDueAt <= dueAt) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, delay));
  }

  private takeBatch(now: number): WorkItem[] {
    const available: WorkItem[] = [];
    for (const item of this.items.values()) {
      if (item.state !== "queued") continue;
      if (!this.prune(item)) {
        this.items.delete(item.key);
        continue;
      }
      if (item.readyAt <= now) available.push(item);
    }
    available.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    const first = available[0];
    if (!first) return [];
    // Format failures are isolated progressively: 24 -> 6 -> 1, by default.
    const limit = first.attempts === 0 ? this.maxItems
      : first.attempts === 1 ? Math.max(1, Math.floor(this.maxItems / 4)) : 1;
    const batch: WorkItem[] = [];
    let characters = 0;
    for (const item of available) {
      if (item.attempts !== first.attempts) continue;
      const size = item.part.source.length + (item.part.context === item.part.source ? 0 : item.part.context.length);
      if (batch.length > 0 && characters + size > this.maxCharacters) continue;
      batch.push(item);
      characters += size;
      if (batch.length >= limit) break;
    }
    return batch;
  }

  private pump(): void {
    if (this.destroyed || this.paused) return;
    if (TranslationQueue.globalActiveRequests >= this.concurrency) {
      TranslationQueue.waitingQueues.add(this);
      return;
    }
    TranslationQueue.waitingQueues.delete(this);
    const now = Date.now();
    if (this.globalReadyAt > now) {
      this.schedule(this.globalReadyAt - now);
      return;
    }
    while (this.activeRequests < this.concurrency && TranslationQueue.globalActiveRequests < this.concurrency) {
      const batch = this.takeBatch(now);
      if (batch.length === 0) break;
      for (const item of batch) {
        item.state = "active";
        item.attempts++;
      }
      this.activeRequests++;
      TranslationQueue.globalActiveRequests++;
      const controller = new AbortController();
      this.controllers.add(controller);
      void this.runBatch(batch, controller).finally(() => {
        this.controllers.delete(controller);
        this.activeRequests--;
        TranslationQueue.globalActiveRequests--;
        for (const waiting of TranslationQueue.waitingQueues) waiting.schedule(0);
        if (this.destroyed) return;
        this.notifyProgress();
        this.schedule(0);
      });
    }
    this.notifyProgress();
    if (this.activeRequests >= this.concurrency) return;
    if (TranslationQueue.globalActiveRequests >= this.concurrency) {
      TranslationQueue.waitingQueues.add(this);
      return;
    }
    let earliest = Infinity;
    for (const item of this.items.values()) {
      if (item.state === "queued") earliest = Math.min(earliest, item.readyAt);
    }
    if (earliest !== Infinity) this.schedule(Math.max(0, earliest - Date.now()));
  }

  private finish(item: WorkItem, translation: string): void {
    if (this.destroyed) return;
    item.state = "completed";
    item.result = translation;
    try { this.options.cacheResult?.(item.key, translation); } catch { /* Retain the in-session result. */ }
    for (const subscriber of item.subscribers) this.deliver(subscriber, translation);
    item.subscribers.clear();
  }

  /** Returns true only when this attempt permanently exhausted the job. */
  private failOrRetry(item: WorkItem, error: Error, retryable: boolean, retryAfterMs = 0): boolean {
    if (retryable && item.attempts < this.maxAttempts && this.prune(item)) {
      const backoff = this.retryBaseMs * 2 ** Math.max(0, item.attempts - 1);
      item.state = "queued";
      item.readyAt = Date.now() + Math.min(MAX_RETRY_DELAY_MS, Math.max(backoff, retryAfterMs));
      return false;
    }
    item.state = "failed";
    item.failure = error.message;
    for (const subscriber of item.subscribers) this.deliverFailure(subscriber, error.message);
    return true;
  }

  private async runBatch(batch: WorkItem[], controller: AbortController): Promise<void> {
    try {
      const result = await this.options.translate(batch.map(item => item.part), controller.signal);
      if (this.destroyed || controller.signal.aborted) return;
      const issue = new Error(result.issue || "Some text did not receive a usable translation.");
      let permanentlyFailed = false;
      batch.forEach((item, index) => {
        const translated = result.translations?.[index];
        if (typeof translated === "string" && translated.trim() !== "") {
          this.finish(item, translated);
        } else {
          permanentlyFailed = this.failOrRetry(item, issue, true) || permanentlyFailed;
        }
      });
      if (permanentlyFailed) this.report(issue, false);
    } catch (caught) {
      if (this.destroyed || controller.signal.aborted) return;
      const error = caught instanceof Error ? caught : new Error("The translation request failed.");
      const details = error as Error & ErrorDetails;
      const fatal = details.fatal === true;
      const retryable = !fatal && details.retryable !== false;
      const retryAfterMs = Number.isFinite(details.retryAfterMs) ? Math.max(0, details.retryAfterMs!) : 0;
      const rateLimited = details.status === 429 || details.code === "rate_limit_exceeded";
      if (rateLimited || retryAfterMs > 0) {
        // All workers observe one cooldown; concurrent failures do not start a retry storm.
        const cooldown = Math.min(MAX_RETRY_DELAY_MS, Math.max(retryAfterMs, rateLimited ? 1000 : 0));
        this.globalReadyAt = Math.max(this.globalReadyAt, Date.now() + cooldown);
      }
      if (fatal) this.paused = true;
      let permanentlyFailed = false;
      for (const item of batch) {
        permanentlyFailed = this.failOrRetry(item, error, retryable, retryAfterMs) || permanentlyFailed;
      }
      if (fatal || permanentlyFailed) this.report(error, fatal);
    }
  }
}
