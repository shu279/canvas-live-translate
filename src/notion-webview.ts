import { buildNotionPageScript, NotionPageRequest, NotionPageResponse } from "./notion-page-script";

/** The only Electron capabilities this adapter uses, on an existing Canvas card. */
export interface NotionWebviewElement extends HTMLElement {
  getURL?: () => string;
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
}

export interface NotionAdapterStatus {
  found: number;
  ready: number;
  loading: number;
  unsupported: number;
  failed: number;
  truncated: boolean;
  restoreFailed: number;
}

export interface NotionRestoreResult { restored: number; failed: number; }

export interface WebTranslationTarget {
  id: string;
  source: string;
  context: string;
  isCurrent: () => boolean;
  /** False means the source document changed before this result arrived. */
  apply: (translated: string) => Promise<boolean>;
}

export interface NotionWebviewOptions {
  onChange?: () => void;
  onStatus?: (status: NotionAdapterStatus) => void;
  pollIntervalMs?: number;
  rpcTimeoutMs?: number;
  restoreTimeoutMs?: number;
}

interface PendingPatch {
  id: string;
  source: string;
  translated: string;
  revision: number;
  epoch: number;
  resolve: (success: boolean) => void;
}

interface Slot {
  id: number;
  session: string;
  element: NotionWebviewElement;
  epoch: number;
  revision: number;
  url: string;
  eventHandler: () => void;
  patches: PendingPatch[];
  flushScheduled: boolean;
  touched: boolean;
  unresponsive: boolean;
  restoring: Promise<boolean> | null;
  latestRequestExpiry: number;
}

const RPC_TIMEOUT_MS = 2000;
const RESTORE_TIMEOUT_MS = 4500;
const WEBVIEW_EVENTS = ["dom-ready", "did-navigate", "did-navigate-in-page", "did-stop-loading"];

function timeoutMs(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(30000, Math.floor(value))) : fallback;
}

/** Exact HTTPS hostname allowlist; misleading suffixes and URL credentials do not count. */
export function isNotionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      ["notion.so", "notion.site", "notion.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

function pageIdentity(value: string): string {
  return value.split("#", 1)[0];
}

function readActualUrl(element: NotionWebviewElement): string {
  // Never use src for executing code: a loaded webview may have navigated away.
  try { return typeof element.getURL === "function" ? element.getURL() : ""; }
  catch { return ""; }
}

function isResponse(value: unknown): value is NotionPageResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NotionPageResponse>;
  return ["ready", "not-ready", "wrong-page", "restored"].includes(candidate.status ?? "") &&
    Number.isSafeInteger(candidate.revision) && Array.isArray(candidate.parts);
}

/**
 * Translation runs inside an existing, user-opened Notion web card. No Notion
 * API, cookie access, login, browser security override or separate server is used.
 * A detached read-only DOM snapshot is shown over the source page; original
 * editable content stays untouched underneath it.
 */
export class NotionWebviewController {
  private readonly session = `clt_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
  private readonly slots = new Map<NotionWebviewElement, Slot>();
  private readonly operationChains = new WeakMap<NotionWebviewElement, Promise<void>>();
  private readonly pendingRestores = new Set<Slot>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly rpcTimeoutMs: number;
  private readonly restoreTimeoutMs: number;
  private nextId = 0;
  private destroyed = false;
  private collecting: Promise<WebTranslationTarget[]> | null = null;
  private destroying: Promise<NotionRestoreResult> | null = null;
  private restoringOriginals: Promise<NotionRestoreResult> | null = null;
  private status: NotionAdapterStatus = { found: 0, ready: 0, loading: 0, unsupported: 0, failed: 0, truncated: false, restoreFailed: 0 };

  constructor(private readonly root: HTMLElement, private readonly options: NotionWebviewOptions = {}) {
    this.rpcTimeoutMs = timeoutMs(options.rpcTimeoutMs, RPC_TIMEOUT_MS);
    this.restoreTimeoutMs = timeoutMs(options.restoreTimeoutMs, RESTORE_TIMEOUT_MS);
    // Guest-page DOM mutations are invisible to a MutationObserver in Obsidian.
    // A light collection poll catches Notion lazy rendering, without sending any
    // text to the API until the host's shared cache/scheduler decides it is needed.
    this.timer = setInterval(() => {
      if (!this.destroyed && this.root.isConnected && this.slots.size) this.options.onChange?.();
    }, Math.max(600, options.pollIntervalMs ?? 1600));
  }

  getStatus(): NotionAdapterStatus { return { ...this.status }; }

  refresh(): void {
    if (this.destroyed) return;
    const found = new Set(this.root.querySelectorAll<NotionWebviewElement>(".canvas-node webview"));
    for (const [element, slot] of this.slots) {
      if (found.has(element) && element.isConnected) continue;
      this.detachSlot(slot);
      this.slots.delete(element);
      this.pendingRestores.add(slot);
      void this.restoreSlot(slot);
    }
    for (const element of found) {
      if (this.slots.has(element)) continue;
      const advertisedUrl = element.getAttribute("src") ?? "";
      const actualUrl = readActualUrl(element);
      if (!isNotionUrl(actualUrl) && !isNotionUrl(advertisedUrl)) continue;
      const slot: Slot = {
        id: ++this.nextId, session: `${this.session}_${this.nextId}`, element, epoch: 0, revision: -1, url: actualUrl,
        eventHandler: () => {
          slot.epoch++;
          slot.revision = -1;
          slot.url = readActualUrl(element);
          slot.unresponsive = false;
          this.resolvePatches(slot, false);
          this.options.onChange?.();
        },
        patches: [], flushScheduled: false, touched: false, unresponsive: false, restoring: null, latestRequestExpiry: 0
      };
      for (const event of WEBVIEW_EVENTS) element.addEventListener(event, slot.eventHandler);
      this.slots.set(element, slot);
    }
  }

  async collect(): Promise<WebTranslationTarget[]> {
    if (this.destroyed) return [];
    if (this.collecting) return this.collecting;
    this.collecting = this.collectAll();
    try { return await this.collecting; }
    finally { this.collecting = null; }
  }

  private async collectAll(): Promise<WebTranslationTarget[]> {
    this.refresh();
    const status: NotionAdapterStatus = { found: 0, ready: 0, loading: 0, unsupported: 0, failed: 0, truncated: false, restoreFailed: this.status.restoreFailed };
    for (const frame of this.root.querySelectorAll<HTMLIFrameElement>(".canvas-node iframe")) {
      if (!isNotionUrl(frame.getAttribute("src") ?? "")) continue;
      // Do not try contentDocument, disable web security, or tunnel around CORS.
      status.found++; status.unsupported++;
    }
    const targets: WebTranslationTarget[] = [];
    await Promise.all(Array.from(this.slots.values(), async slot => {
      if (this.destroyed || !slot.element.isConnected) return;
      const url = readActualUrl(slot.element);
      if (!isNotionUrl(url)) {
        if (isNotionUrl(slot.element.getAttribute("src") ?? "") && !url) { status.found++; status.loading++; }
        return;
      }
      status.found++;
      if (typeof slot.element.executeJavaScript !== "function") { status.unsupported++; return; }
      if (pageIdentity(url) !== pageIdentity(slot.url)) {
        slot.url = url; slot.epoch++; slot.revision = -1; slot.unresponsive = false;
        this.resolvePatches(slot, false);
      }
      const epoch = slot.epoch;
      try {
        const result = await this.execute(slot, {
          action: "collect", session: slot.session, expectedUrl: url, limit: 300
        });
        if (this.destroyed || epoch !== slot.epoch || !slot.element.isConnected ||
            pageIdentity(readActualUrl(slot.element)) !== pageIdentity(url)) return;
        if (!isResponse(result)) { status.failed++; return; }
        if (result.status !== "ready") { status.loading++; return; }
        slot.revision = result.revision;
        status.ready++;
        status.truncated ||= Boolean(result.truncated);
        const revision = result.revision;
        for (const part of result.parts.slice(0, 500)) {
          if (!part || typeof part.id !== "string" || !/^\d{1,7}$/.test(part.id) ||
              typeof part.source !== "string" || part.source.length > 20000 ||
              typeof part.context !== "string" || part.context.length > 1000) continue;
          const isCurrent = (): boolean => !this.destroyed && !slot.unresponsive && slot.element.isConnected &&
            epoch === slot.epoch && revision === slot.revision && isNotionUrl(readActualUrl(slot.element)) &&
            pageIdentity(readActualUrl(slot.element)) === pageIdentity(url);
          targets.push({
            id: `notion:${slot.id}:${epoch}:${revision}:${part.id}`,
            source: part.source,
            context: part.context,
            isCurrent,
            apply: translated => {
              if (!isCurrent()) return Promise.resolve(false);
              return new Promise<boolean>(resolve => {
                slot.patches.push({ id: part.id, source: part.source, translated, revision, epoch, resolve });
                if (!slot.flushScheduled) {
                  slot.flushScheduled = true;
                  // One guest execution per host batch, not one per text fragment.
                  queueMicrotask(() => { void this.flushPatches(slot); });
                }
              });
            }
          });
        }
      } catch {
        // Never log guest errors: they can contain page text or private URLs.
        status.failed++;
      }
    }));
    if (!this.destroyed) {
      const changed = JSON.stringify(status) !== JSON.stringify(this.status);
      this.status = status;
      if (changed) this.options.onStatus?.(this.getStatus());
    }
    return targets;
  }

  private async flushPatches(slot: Slot): Promise<void> {
    slot.flushScheduled = false;
    const patches = slot.patches.splice(0);
    if (!patches.length) return;
    const current = patches.filter(patch => patch.epoch === slot.epoch && patch.revision === slot.revision);
    const invalid = patches.filter(patch => !current.includes(patch));
    invalid.forEach(patch => patch.resolve(false));
    const url = readActualUrl(slot.element);
    if (this.destroyed || !slot.element.isConnected || !isNotionUrl(url) || !slot.element.executeJavaScript || !current.length) {
      current.forEach(patch => patch.resolve(false));
      return;
    }
    try {
      const result = await this.execute(slot, {
        action: "apply", session: slot.session, expectedUrl: url, revision: slot.revision,
        patches: current.map(({ id, source, translated }) => ({ id, source, translated }))
      });
      const valid = !this.destroyed && current.every(patch => patch.epoch === slot.epoch) &&
        isResponse(result) && result.status === "ready" && result.revision === slot.revision;
      // A partial DOM mismatch should be retried by collection, not falsely marked
      // as a permanently translated node. Cache successes still remain in host.
      const appliedAll = valid && result.applied === current.length;
      current.forEach(patch => patch.resolve(Boolean(appliedAll)));
      if (!appliedAll && !this.destroyed) this.options.onChange?.();
    } catch { current.forEach(patch => patch.resolve(false)); }
  }

  private resolvePatches(slot: Slot, success: boolean): void {
    slot.patches.splice(0).forEach(patch => patch.resolve(success));
  }

  private detachSlot(slot: Slot): void {
    slot.epoch++;
    for (const event of WEBVIEW_EVENTS) slot.element.removeEventListener(event, slot.eventHandler);
    this.resolvePatches(slot, false);
  }

  /** Serialize guest operations, including those from a removed/reinserted card. */
  private execute(slot: Slot, request: NotionPageRequest, timeout = this.rpcTimeoutMs): Promise<unknown> {
    if (request.action !== "restore" && slot.unresponsive) return Promise.reject(new Error("Notion card is not responding"));
    // Mark as potentially injected before queueing, so removal in the same tick
    // still schedules cleanup AFTER an already-queued collection operation.
    if (request.action === "collect") slot.touched = true;
    const expiresAt = Date.now() + timeout;
    if (request.action !== "restore") slot.latestRequestExpiry = Math.max(slot.latestRequestExpiry, expiresAt);
    const timedRequest: NotionPageRequest = {
      ...request, expiresAt,
      ...(request.action === "restore" ? { cancelUntil: slot.latestRequestExpiry } : {})
    };
    const epoch = slot.epoch;
    const previous = this.operationChains.get(slot.element) ?? Promise.resolve();
    const execution = previous.then(async () => {
      if (Date.now() >= expiresAt) throw new Error("Notion card operation timed out");
      if (request.action !== "restore" && (this.destroyed || slot.unresponsive || epoch !== slot.epoch ||
          this.slots.get(slot.element) !== slot || !slot.element.isConnected))
        return { status: "not-ready", revision: 0, parts: [] } satisfies NotionPageResponse;
      const actualUrl = readActualUrl(slot.element);
      if (!isNotionUrl(actualUrl) || pageIdentity(actualUrl) !== pageIdentity(request.expectedUrl))
        return { status: "wrong-page", revision: 0, parts: [] } satisfies NotionPageResponse;
      if (typeof slot.element.executeJavaScript !== "function") throw new Error("Webview execution unavailable");
      return slot.element.executeJavaScript(buildNotionPageScript(timedRequest), false);
    });
    const bounded = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (slot.epoch === epoch) slot.unresponsive = true;
        reject(new Error("Notion card operation timed out"));
      }, timeout);
      execution.then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); reject(error); });
    });
    // A hung guest call must not block restoration forever. Expiry and guest
    // cancellation tombstones prevent its late execution from reviving a clone.
    this.operationChains.set(slot.element, bounded.then(() => undefined, () => undefined));
    return bounded;
  }

  private restoreSlot(slot: Slot): Promise<boolean> {
    if (slot.restoring) return slot.restoring;
    const work = this.performRestoreSlot(slot);
    slot.restoring = work;
    const clear = () => { if (slot.restoring === work) slot.restoring = null; };
    void work.then(clear, clear);
    return work;
  }

  private async performRestoreSlot(slot: Slot): Promise<boolean> {
    if (!slot.touched) {
      // A not-yet-loaded or unsupported card was never injected; it cannot have
      // a translated overlay and must not cause a spurious JA restoration error.
      this.pendingRestores.delete(slot);
      return true;
    }
    const url = readActualUrl(slot.element);
    if (url && !isNotionUrl(url)) {
      // Cross-origin navigation has disposed of the original page document.
      this.pendingRestores.delete(slot);
      return true;
    }
    if (!url || typeof slot.element.executeJavaScript !== "function") {
      this.pendingRestores.add(slot);
      return false;
    }
    try {
      const result = await this.execute(slot, {
        action: "restore", session: slot.session, expectedUrl: url
      }, this.restoreTimeoutMs);
      if (isResponse(result) && result.status === "restored") {
        this.pendingRestores.delete(slot);
        return true;
      }
    } catch { /* Report below; never claim that a failed restore succeeded. */ }
    this.pendingRestores.add(slot);
    return false;
  }

  /** May be called again after destroy() to retry failed guest restoration. */
  async restoreOriginals(): Promise<NotionRestoreResult> {
    if (this.restoringOriginals) return this.restoringOriginals;
    this.restoringOriginals = (async () => {
      const slots = Array.from(this.pendingRestores);
      const outcomes = await Promise.all(slots.map(slot => this.restoreSlot(slot)));
      const result = { restored: outcomes.filter(Boolean).length, failed: outcomes.filter(value => !value).length };
      this.status.restoreFailed = result.failed;
      this.options.onStatus?.(this.getStatus());
      return result;
    })();
    try { return await this.restoringOriginals; }
    finally { this.restoringOriginals = null; }
  }

  async destroy(): Promise<NotionRestoreResult> {
    if (this.destroying) return this.destroying;
    this.destroyed = true;
    clearInterval(this.timer);
    const slots = Array.from(this.slots.values());
    slots.forEach(slot => { this.detachSlot(slot); this.pendingRestores.add(slot); });
    this.slots.clear();
    this.destroying = this.restoreOriginals();
    return this.destroying;
  }
}
