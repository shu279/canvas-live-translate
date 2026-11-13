import test from "node:test";
import assert from "node:assert/strict";
import { TranslationQueue, type QueueBatchResult, type TranslationQueueOptions } from "../src/translation-queue.ts";

const pause = (milliseconds = 0) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const part = (source: string) => ({ source, context: "" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function createQueue(options: TranslationQueueOptions) {
  return new TranslationQueue({ dispatchDelayMs: 0, retryBaseMs: 0, ...options });
}

async function eventually(condition: () => boolean, description: string) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await pause(2);
  }
  assert.fail(description);
}

async function settled(queue: TranslationQueue) {
  await eventually(() => queue.stats.pending === 0 && queue.stats.activeRequests === 0,
    `Queue did not settle: ${JSON.stringify(queue.stats)}`);
}

test("deduplicates queued and active source keys but delivers to every current card", async () => {
  const response = deferred<QueueBatchResult>();
  const calls: string[][] = [];
  const received: string[] = [];
  const cached: string[] = [];
  const queue = createQueue({
    translate: async parts => {
      calls.push(parts.map(item => item.source));
      return response.promise;
    },
    cacheResult: (key, value) => cached.push(`${key}:${value}`)
  });
  queue.enqueue({ key: "same", part: part("同じ文章"), onResult: value => { received.push(`first:${value}`); } });
  queue.enqueue({ key: "same", part: part("同じ文章"), onResult: value => { received.push(`second:${value}`); } });
  await eventually(() => calls.length === 1, "Initial batch did not start");
  queue.enqueue({ key: "same", part: part("同じ文章"), onResult: value => { received.push(`third:${value}`); } });
  response.resolve({ translations: ["The same text"] });
  await settled(queue);
  assert.deepEqual(calls, [["同じ文章"]]);
  assert.deepEqual(received, ["first:The same text", "second:The same text", "third:The same text"]);
  assert.deepEqual(cached, ["same:The same text"]);
  assert.equal(queue.stats.total, 1);
  queue.destroy();
});

test("uses the persistent cache and in-session results without further API calls", async () => {
  let calls = 0;
  const received: string[] = [];
  const queue = createQueue({
    getCached: key => key === "cached" ? "Cached translation" : undefined,
    translate: async () => { calls++; return { translations: ["New translation"] }; }
  });
  queue.enqueue({ key: "cached", part: part("保存済み"), onResult: value => { received.push(value); } });
  queue.enqueue({ key: "new", part: part("新規"), onResult: value => { received.push(value); } });
  await settled(queue);
  queue.enqueue({ key: "new", part: part("新規"), onResult: value => { received.push(value); } });
  await pause(5);
  assert.equal(calls, 1);
  assert.deepEqual(received, ["Cached translation", "New translation", "New translation"]);
  queue.destroy();
});

test("prioritizes on-screen text and obeys the worker and batch limits", async () => {
  const starts: string[][] = [];
  let active = 0;
  let maximumActive = 0;
  const releases: Array<() => void> = [];
  const queue = createQueue({
    concurrency: 2,
    maxItems: 1,
    translate: async parts => {
      starts.push(parts.map(item => item.source));
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return { translations: parts.map(item => `English ${item.source}`) };
    }
  });
  for (const [key, priority] of [["offscreen", 0], ["visible-a", 10], ["visible-b", 10]] as const) {
    queue.enqueue({ key, part: part(key), priority, onResult: () => {} });
  }
  await eventually(() => starts.length === 2, "Two workers did not start");
  assert.deepEqual(starts, [["visible-a"], ["visible-b"]]);
  assert.equal(maximumActive, 2);
  releases.shift()!();
  await eventually(() => starts.length === 3, "Freed worker did not continue queued work");
  assert.deepEqual(starts[2], ["offscreen"]);
  releases.splice(0).forEach(release => release());
  await settled(queue);
  assert.equal(maximumActive, 2);
  queue.destroy();
});

test("keeps partial successes and retries only missing items to a bounded limit", async () => {
  const calls: string[][] = [];
  const received: string[] = [];
  const failures: string[] = [];
  const notices: string[] = [];
  const queue = createQueue({
    maxAttempts: 3,
    translate: async parts => {
      calls.push(parts.map(item => item.source));
      return { translations: parts.map(item => item.source === "bad" ? null : `English ${item.source}`), issue: "One invalid segment" };
    },
    onError: (error, fatal) => { notices.push(`${fatal}:${error.message}`); }
  });
  for (const key of ["first", "bad", "last"]) {
    queue.enqueue({
      key, part: part(key),
      onResult: value => { received.push(value); },
      onFailure: value => { failures.push(`${key}:${value}`); }
    });
  }
  await settled(queue);
  assert.deepEqual(calls, [["first", "bad", "last"], ["bad"], ["bad"]]);
  assert.deepEqual(received, ["English first", "English last"]);
  assert.deepEqual(failures, ["bad:One invalid segment"]);
  assert.deepEqual(notices, ["false:One invalid segment"]);
  assert.equal(queue.stats.completed, 2);
  assert.equal(queue.stats.failed, 1);
  assert.equal(queue.stats.paused, false);
  queue.destroy();
});

test("malformed multi-item results are retried in progressively smaller batches", async () => {
  const sizes: number[] = [];
  const queue = createQueue({
    concurrency: 1,
    maxItems: 8,
    translate: async parts => {
      sizes.push(parts.length);
      return { translations: parts.length === 1 ? ["Recovered"] : parts.map(() => null) };
    }
  });
  for (let i = 0; i < 8; i++) queue.enqueue({ key: String(i), part: part(`項目 ${i}`), onResult: () => {} });
  await settled(queue);
  assert.equal(sizes[0], 8);
  assert.equal(sizes.filter(size => size === 2).length, 4);
  assert.equal(sizes.filter(size => size === 1).length, 8);
  assert.equal(sizes.length, 13);
  assert.equal(queue.stats.completed, 8);
  queue.destroy();
});

test("fatal authentication failure pauses once and manual retry resumes only unfinished work", async () => {
  let authenticationBroken = true;
  const calls: string[] = [];
  const received: string[] = [];
  const errors: boolean[] = [];
  const queue = createQueue({
    concurrency: 1,
    maxItems: 1,
    translate: async parts => {
      calls.push(parts[0].source);
      if (authenticationBroken) throw Object.assign(new Error("API key invalid"), { fatal: true, retryable: false, status: 401 });
      return { translations: ["English"] };
    },
    onError: (_error, fatal) => { errors.push(fatal); }
  });
  for (const key of ["one", "two"]) queue.enqueue({ key, part: part(key), onResult: () => { received.push(key); } });
  await eventually(() => queue.stats.paused, "Fatal failure did not pause");
  await pause(5);
  assert.deepEqual(calls, ["one"]);
  assert.deepEqual(errors, [true]);
  assert.equal(queue.stats.failed, 1);
  assert.equal(queue.stats.pending, 1);
  authenticationBroken = false;
  queue.retryFailed();
  await settled(queue);
  assert.deepEqual(calls, ["one", "one", "two"]);
  assert.deepEqual(received, ["one", "two"]);
  assert.equal(queue.stats.paused, false);
  queue.destroy();
});

test("rate-limit cooldown prevents other workers from starting fresh queued requests", async () => {
  let calls = 0;
  const queue = createQueue({
    concurrency: 2,
    maxItems: 1,
    translate: async () => {
      calls++;
      throw Object.assign(new Error("OpenAI API returned HTTP 429"), { status: 429, retryable: true, retryAfterMs: 1000 });
    }
  });
  for (let i = 0; i < 5; i++) queue.enqueue({ key: String(i), part: part(`項目 ${i}`), onResult: () => {} });
  await eventually(() => calls === 2, "Initial workers did not start");
  await pause(20);
  assert.equal(calls, 2);
  queue.destroy();
});

test("nonfatal nonretryable failures do not block later cards", async () => {
  const received: string[] = [];
  let calls = 0;
  const queue = createQueue({
    concurrency: 1,
    maxItems: 1,
    translate: async parts => {
      calls++;
      if (parts[0].source === "failed") throw Object.assign(new Error("Refused"), { retryable: false, fatal: false });
      return { translations: ["Successful"] };
    }
  });
  for (const key of ["failed", "later"]) queue.enqueue({ key, part: part(key), onResult: value => { received.push(value); } });
  await settled(queue);
  assert.equal(calls, 2);
  assert.deepEqual(received, ["Successful"]);
  assert.equal(queue.stats.failed, 1);
  assert.equal(queue.stats.completed, 1);
  assert.equal(queue.stats.paused, false);
  queue.destroy();
});

test("destroy aborts the session and ignores all late display/cache/error callbacks", async () => {
  const response = deferred<QueueBatchResult>();
  let signal: AbortSignal | undefined;
  const effects: string[] = [];
  const queue = createQueue({
    translate: async (_parts, passedSignal) => { signal = passedSignal; return response.promise; },
    cacheResult: () => { effects.push("cache"); },
    onError: () => { effects.push("error"); }
  });
  queue.enqueue({ key: "one", part: part("原文"), onResult: () => { effects.push("display"); } });
  await eventually(() => signal !== undefined, "Request did not start");
  queue.destroy();
  assert.equal(signal!.aborted, true);
  response.resolve({ translations: ["English"] });
  await pause(5);
  assert.deepEqual(effects, []);
  assert.equal(queue.stats.total, 0);
});

test("disconnected subscribers are skipped and unsubscribing one shared card does not cancel another", async () => {
  const response = deferred<QueueBatchResult>();
  let started = false;
  let connected = true;
  const received: string[] = [];
  const queue = createQueue({ translate: async () => { started = true; return response.promise; } });
  const unsubscribe = queue.enqueue({ key: "same", part: part("原文"), onResult: () => { received.push("unsubscribed"); } });
  queue.enqueue({ key: "same", part: part("原文"), isCurrent: () => connected, onResult: () => { received.push("disconnected"); } });
  queue.enqueue({ key: "same", part: part("原文"), onResult: () => { received.push("retained"); } });
  await eventually(() => started, "Request did not start");
  unsubscribe();
  connected = false;
  response.resolve({ translations: ["English"] });
  await settled(queue);
  assert.deepEqual(received, ["retained"]);
  queue.destroy();
});

test("callback failures cannot cause a successful API request to be retransmitted", async () => {
  let calls = 0;
  const queue = createQueue({
    translate: async () => { calls++; return { translations: ["English"] }; },
    cacheResult: () => { throw new Error("Storage unavailable"); },
    onProgress: () => { throw new Error("UI unavailable"); }
  });
  queue.enqueue({ key: "one", part: part("原文"), onResult: () => { throw new Error("Detached card"); } });
  await settled(queue);
  assert.equal(calls, 1);
  assert.equal(queue.stats.completed, 1);
  queue.destroy();
});

test("nonabortable requests from destroyed sessions still consume the shared worker budget", async () => {
  const oldResponse = deferred<QueueBatchResult>();
  let oldStarted = false;
  let newStarted = false;
  const oldQueue = createQueue({
    concurrency: 1,
    translate: async () => { oldStarted = true; return oldResponse.promise; }
  });
  oldQueue.enqueue({ key: "old", part: part("前のCanvas"), onResult: () => {} });
  await eventually(() => oldStarted, "Old request did not start");
  oldQueue.destroy();
  const newQueue = createQueue({
    concurrency: 1,
    translate: async () => { newStarted = true; return { translations: ["New Canvas"] }; }
  });
  newQueue.enqueue({ key: "new", part: part("新しいCanvas"), onResult: () => {} });
  await pause(10);
  assert.equal(newStarted, false);
  oldResponse.resolve({ translations: ["Old Canvas"] });
  await settled(newQueue);
  assert.equal(newStarted, true);
  newQueue.destroy();
});

test("scrolling reprioritizes queued text in both directions without restarting active work", async () => {
  const activeResponse = deferred<QueueBatchResult>();
  const starts: string[] = [];
  const queue = createQueue({
    concurrency: 1, maxItems: 1,
    translate: async parts => {
      starts.push(parts[0].source);
      if (parts[0].source === "active") return activeResponse.promise;
      return { translations: ["English"] };
    }
  });
  queue.enqueue({ key: "active", part: part("active"), priority: 1000, onResult: () => {} });
  queue.enqueue({ key: "old-visible", part: part("old-visible"), priority: 100, onResult: () => {} });
  queue.enqueue({ key: "new-visible", part: part("new-visible"), priority: 0, onResult: () => {} });
  await eventually(() => starts.length === 1, "Active request did not start");
  queue.setPriorities(new Map([["old-visible", 0], ["new-visible", 100], ["active", -1]]));
  activeResponse.resolve({ translations: ["English"] });
  await settled(queue);
  assert.deepEqual(starts, ["active", "new-visible", "old-visible"]);
  queue.destroy();
});
