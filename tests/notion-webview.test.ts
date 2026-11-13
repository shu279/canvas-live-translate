import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";
import type { NotionPageRequest, NotionPageResponse } from "../src/notion-page-script.ts";
import type { NotionWebviewController, NotionWebviewElement } from "../src/notion-webview.ts";

// Test the actual production serialization, not tsx's instrumented function text.
// The minified embedded function must not reference host-only bundle variables.
const guestBundle = buildSync({
  entryPoints: ["src/notion-page-script.ts"], bundle: true, write: false,
  format: "iife", globalName: "CltGuest", platform: "browser", target: "es2022", minify: true
}).outputFiles[0].text;
const hostBundle = buildSync({
  entryPoints: ["src/notion-webview.ts"], bundle: true, write: false,
  format: "iife", globalName: "CltHost", platform: "browser", target: "es2022", minify: true
}).outputFiles[0].text;

const URL = "https://research.notion.site/Research-0123456789abcdef";
const SESSION = "clt_fixture_12345678";

function createGuest(markup = `
  <div class="notion-scroller">
    <h1>研究ノート</h1>
    <div class="notion-page-content">
      <div class="notion-selectable" data-block-id="source-id"><p contenteditable="true">長期記憶を圧縮する。</p></div>
      <p>重要な <strong>手法</strong> です。</p>
      <pre><code>翻訳しないコード</code></pre>
      <span class="katex">翻訳しない数式</span>
      <img src="https://example.com/figure.png" alt="Figure">
      <input type="checkbox" checked>
      <a href="https://arxiv.org/abs/2501.05510">論文を開く</a>
    </div>
  </div>`, url = URL) {
  const dom = new JSDOM(`<html><body>${markup}</body></html>`, { url, runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.matchMedia = (() => ({ matches: false })) as typeof dom.window.matchMedia;
  dom.window.eval(`${guestBundle};globalThis.CltGuest = CltGuest;`);
  const api = (dom.window as any).CltGuest as { buildNotionPageScript: (request: NotionPageRequest) => string };
  const action = (partial: Partial<NotionPageRequest> = {}): NotionPageResponse => {
    const request: NotionPageRequest = { action: "collect", session: SESSION, expectedUrl: dom.window.location.href, ...partial };
    const script = api.buildNotionPageScript(request);
    // Different context (the real Electron guest) has no CltGuest helper globals.
    const old = (dom.window as any).CltGuest;
    delete (dom.window as any).CltGuest;
    try { return dom.window.eval(script); }
    finally { (dom.window as any).CltGuest = old; }
  };
  return { dom, action };
}

function createHost(guest: JSDOM, options: { rpcTimeoutMs?: number; restoreTimeoutMs?: number } = {}) {
  const host = new JSDOM(`<main><div class="canvas-node"><webview src="${URL}"></webview></div></main>`, { url: "https://obsidian.local", runScripts: "outside-only" });
  host.window.eval(`${hostBundle};globalThis.CltHost = CltHost;`);
  const api = (host.window as any).CltHost as {
    NotionWebviewController: new (root: HTMLElement, options?: object) => NotionWebviewController;
    isNotionUrl: (url: string) => boolean;
  };
  const element = host.window.document.querySelector("webview") as unknown as NotionWebviewElement;
  element.getURL = () => guest.window.location.href;
  const calls: string[] = [];
  element.executeJavaScript = async code => { calls.push(code); return guest.window.eval(code); };
  const controller = new api.NotionWebviewController(host.window.document.querySelector("main")!, { pollIntervalMs: 60000, ...options });
  return { host, element, controller, calls, api };
}

test("production guest translation changes only sanitized clone, never original Notion editor", async () => {
  const { dom, action } = createGuest();
  const original = dom.window.document.querySelector(".notion-scroller")!;
  const originalHtml = original.innerHTML;
  const first = action();
  assert.equal(first.status, "ready");
  assert.ok(first.parts.some(part => part.source === "研究ノート"));
  assert.ok(first.parts.some(part => part.source === "長期記憶を圧縮する。"));
  assert.ok(!first.parts.some(part => /翻訳しない/u.test(part.source)));
  const part = first.parts.find(part => part.source === "長期記憶を圧縮する。")!;
  const result = action({ action: "apply", revision: first.revision, patches: [{ ...part, translated: "Compress long-term memory." }] });
  assert.equal(result.applied, 1);
  const overlay = dom.window.document.querySelector("[data-clt-notion-presentation]")!;
  assert.ok(overlay.textContent?.includes("Compress long-term memory."));
  assert.equal(original.innerHTML, originalHtml);
  assert.equal(original.querySelector("[contenteditable='true']")?.textContent, "長期記憶を圧縮する。");
  assert.equal(overlay.querySelectorAll("[contenteditable='true']").length, 0);
  assert.equal(overlay.querySelectorAll("[data-block-id]").length, 0);
  assert.equal(overlay.querySelectorAll("img").length, 1);
  assert.equal(overlay.querySelector<HTMLInputElement>("input")?.disabled, true);
  assert.equal(overlay.querySelector<HTMLInputElement>("input")?.checked, true);
  assert.equal(original.hasAttribute("inert"), true);
  const tab = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  overlay.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true, "Tab must not escape to the original editor");
  action({ action: "restore" });
  assert.equal(dom.window.document.querySelector("[data-clt-notion-presentation]"), null);
  assert.equal(original.innerHTML, originalHtml);
  assert.equal(original.hasAttribute("inert"), false);
  dom.window.close();
});

test("guest never interprets model output as markup or executable code", () => {
  const { dom, action } = createGuest();
  const first = action();
  const part = first.parts[0];
  const text = `<img src=x onerror="window.pwned=true"> literal </script>`;
  action({ action: "apply", revision: first.revision, patches: [{ ...part, translated: text }] });
  const overlay = dom.window.document.querySelector("[data-clt-notion-presentation]")!;
  assert.ok(overlay.textContent?.includes(text));
  assert.equal(overlay.querySelector("img[onerror]"), null);
  assert.equal((dom.window as any).pwned, undefined);
  dom.window.close();
});

test("dynamic source updates refresh snapshot and reuse prior translations", async () => {
  const { dom, action } = createGuest();
  const original = dom.window.document.querySelector(".notion-page-content")!;
  const first = action();
  const part = first.parts.find(part => part.source === "長期記憶を圧縮する。")!;
  action({ action: "apply", revision: first.revision, patches: [{ ...part, translated: "Compress long-term memory." }] });
  const paragraph = dom.window.document.createElement("p"); paragraph.textContent = "新しい観測";
  original.append(paragraph);
  await new Promise(resolve => dom.window.queueMicrotask(resolve));
  const next = action();
  assert.ok(next.revision > first.revision);
  assert.ok(next.parts.some(item => item.source === "新しい観測"));
  assert.ok(!next.parts.some(item => item.source === "長期記憶を圧縮する。"));
  assert.ok(dom.window.document.querySelector("[data-clt-notion-presentation]")?.textContent?.includes("Compress long-term memory."));
  assert.equal(action({ action: "apply", revision: first.revision, patches: [{ ...part, translated: "STALE" }] }).applied, undefined);
  original.remove();
  await new Promise(resolve => dom.window.queueMicrotask(resolve));
  assert.equal(action().status, "not-ready");
  assert.equal(dom.window.document.querySelector("[data-clt-notion-presentation]"), null);
  dom.window.close();
});

test("guest guards every operation against wrong origin and page navigation", () => {
  const { dom, action } = createGuest();
  const first = action();
  assert.equal(action({ action: "apply", expectedUrl: "https://evil.example/", revision: first.revision, patches: [] }).status, "wrong-page");
  assert.equal(action({ action: "restore", expectedUrl: "https://notion.site.evil.example/" }).status, "wrong-page");
  assert.ok(dom.window.document.querySelector("[data-clt-notion-presentation]"));
  assert.equal(action({ session: "';alert(1);//" }).status, "wrong-page");
  dom.window.history.pushState({}, "", "/another-page");
  assert.equal(action({ action: "apply", expectedUrl: URL, revision: first.revision, patches: [] }).status, "wrong-page");
  dom.window.close();
});

test("not-ready Notion sign-in UI is not captured or translated", () => {
  const { dom, action } = createGuest('<h1>ログインしてください</h1><input type="password" value="do-not-read">');
  assert.equal(action().status, "not-ready");
  assert.equal(dom.window.document.querySelector("[data-clt-notion-presentation]"), null);
  dom.window.close();
});

test("clone strips event attributes, active embed/form tags and editing inputs", () => {
  const { dom, action } = createGuest(`<div class="notion-page-content"><p onclick="alert(1)" contenteditable="true" data-block-id="secret">文です</p><script>window.pwned=true</script><iframe src="https://x.test"></iframe><form><input value="secret"></form><a href="javascript:alert(1)">説明</a></div>`);
  action();
  const overlay = dom.window.document.querySelector("[data-clt-notion-presentation]")!;
  assert.equal(overlay.querySelectorAll("[onclick],script,iframe,form,[contenteditable='true'],[data-block-id]").length, 0);
  assert.equal(overlay.querySelector("a")?.hasAttribute("href"), false);
  const event = new dom.window.Event("beforeinput", { bubbles: true, cancelable: true });
  overlay.querySelector("p")!.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  dom.window.close();
});

test("host batches patches, shares no credentials, and restores on disable", async () => {
  const { dom: guest } = createGuest();
  const { host, controller, calls } = createHost(guest);
  try {
    const targets = await controller.collect();
    assert.ok(targets.length >= 2);
    assert.equal(controller.getStatus().ready, 1);
    const before = calls.length;
    const outcomes = await Promise.all(targets.slice(0, 2).map((target, i) => target.apply(`Translated ${i}`)));
    assert.deepEqual(outcomes, [true, true]);
    assert.equal(calls.length, before + 1, "patches use a single guest RPC");
    assert.ok(calls.every(code => !/Bearer|apiKey|Authorization/.test(code)));
    await controller.destroy();
    assert.equal(guest.window.document.querySelector("[data-clt-notion-presentation]"), null);
    assert.equal(targets[0].isCurrent(), false);
    assert.equal(await targets[0].apply("late"), false);
  } finally { await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("host rejects deceptive hosts and doesn't inject into cross-origin iframe", async () => {
  const { dom: guest } = createGuest();
  const { host, controller, api } = createHost(guest);
  try {
    for (const url of ["http://notion.so/x", "https://notion.so.evil.test/x", "https://user:password@notion.so/x", "javascript:alert(1)", "https://evilnotion.so/x"])
      assert.equal(api.isNotionUrl(url), false, url);
    for (const url of ["https://app.notion.com/p/abc", "https://www.notion.so/abc", "https://example.notion.site/abc"])
      assert.equal(api.isNotionUrl(url), true, url);
    host.window.document.querySelector("webview")!.remove();
    const frame = host.window.document.createElement("iframe"); frame.src = URL;
    host.window.document.querySelector(".canvas-node")!.append(frame);
    assert.equal((await controller.collect()).length, 0);
    assert.equal(controller.getStatus().unsupported, 1);
  } finally { await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("host invalidates pending results after Notion page navigation", async () => {
  const { dom: guest } = createGuest();
  const { host, element, controller, calls } = createHost(guest);
  try {
    const targets = await controller.collect();
    guest.window.history.pushState({}, "", "/new-note");
    element.dispatchEvent(new host.window.Event("did-navigate-in-page"));
    const before = calls.length;
    assert.equal(targets[0].isCurrent(), false);
    assert.equal(await targets[0].apply("stale result"), false);
    assert.equal(calls.length, before);
  } finally { await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("rapid disable waits for guest collection before restoring the overlay", async () => {
  const { dom: guest } = createGuest();
  const { host, element, controller } = createHost(guest);
  let release: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const real = element.executeJavaScript!;
  let first = true;
  element.executeJavaScript = async code => { if (first) { first = false; await wait; } return real(code); };
  try {
    const collecting = controller.collect();
    const destroyed = controller.destroy();
    release!();
    await Promise.all([collecting, destroyed]);
    assert.equal(guest.window.document.querySelector("[data-clt-notion-presentation]"), null);
  } finally { await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("disable serializes restore after a delayed translation patch", async () => {
  const { dom: guest } = createGuest();
  const { host, element, controller } = createHost(guest);
  const targets = await controller.collect();
  let release: (() => void) | undefined;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const real = element.executeJavaScript!;
  element.executeJavaScript = async code => {
    if (code.includes('"action":"apply"')) { markStarted!(); await wait; }
    return real(code);
  };
  try {
    const applying = targets[0].apply("Late English translation");
    await started;
    const destroying = controller.destroy();
    release!();
    assert.equal(await applying, false, "cancelled sessions must not report applied text");
    const result = await destroying;
    assert.equal(result.failed, 0);
    assert.equal(guest.window.document.querySelector("[data-clt-notion-presentation]"), null);
  } finally { release!(); await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("detached then reattached webview cannot revive the old translation session", async () => {
  const { dom: guest } = createGuest();
  const { host, element, controller } = createHost(guest);
  try {
    const oldTargets = await controller.collect();
    assert.equal(await oldTargets[0].apply("Old English"), true);
    const parent = element.parentElement!;
    element.remove(); controller.refresh();
    parent.append(element);
    const currentTargets = await controller.collect();
    assert.equal(oldTargets[0].isCurrent(), false);
    assert.equal(await oldTargets[0].apply("stale"), false);
    assert.ok(currentTargets.length > 0);
    assert.notEqual(currentTargets[0].id, oldTargets[0].id);
    assert.equal(guest.window.document.querySelectorAll("[data-clt-notion-presentation]").length, 1);
    const result = await controller.destroy();
    assert.equal(result.failed, 0);
    assert.equal(guest.window.document.querySelector("[data-clt-notion-presentation]"), null);
  } finally { await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("failed original restoration is reported and can be explicitly retried", async () => {
  const { dom: guest } = createGuest();
  const { host, element, controller } = createHost(guest);
  try {
    await controller.collect();
    const real = element.executeJavaScript!;
    element.executeJavaScript = async code => {
      if (code.includes('"action":"restore"')) throw new Error("Simulated Electron failure");
      return real(code);
    };
    const failed = await controller.destroy();
    assert.equal(failed.failed, 1);
    assert.equal(controller.getStatus().restoreFailed, 1);
    assert.ok(guest.window.document.querySelector("[data-clt-notion-presentation]"));
    element.executeJavaScript = real;
    const retry = await controller.restoreOriginals();
    assert.equal(retry.failed, 0);
    assert.equal(retry.restored, 1);
    assert.equal(controller.getStatus().restoreFailed, 0);
    assert.equal(guest.window.document.querySelector("[data-clt-notion-presentation]"), null);
  } finally { await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("overlapping off/on sessions release only their own original-page input lock", () => {
  const { dom, action } = createGuest();
  const original = dom.window.document.querySelector(".notion-scroller")!;
  action();
  action({ session: "clt_second_session_12345" });
  assert.equal(dom.window.document.querySelectorAll("[data-clt-notion-presentation]").length, 2);
  action({ action: "restore" });
  assert.equal(original.hasAttribute("inert"), true);
  assert.equal(dom.window.document.querySelectorAll("[data-clt-notion-presentation]").length, 1);
  action({ action: "restore", session: "clt_second_session_12345" });
  assert.equal(original.hasAttribute("inert"), false);
  assert.equal(dom.window.document.querySelectorAll("[data-clt-notion-presentation]").length, 0);
  original.setAttribute("inert", "original-value");
  const freshSession = "clt_third_session_12345";
  assert.equal(action({ session: freshSession }).status, "ready");
  action({ action: "restore", session: freshSession });
  assert.equal(original.getAttribute("inert"), "original-value");
  dom.window.close();
});

test("not-yet-loaded cards never produce a false original-restoration failure", async () => {
  const { dom: guest } = createGuest();
  const { host, element, controller } = createHost(guest);
  try {
    element.getURL = () => "";
    element.executeJavaScript = undefined;
    assert.equal((await controller.collect()).length, 0);
    assert.equal(controller.getStatus().loading, 1);
    assert.equal((await controller.destroy()).failed, 0);
  } finally { await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("detaching before queued collection starts still schedules cleanup after it", async () => {
  const { dom: guest } = createGuest();
  const { host, element, controller } = createHost(guest);
  try {
    const collecting = controller.collect();
    element.remove(); controller.refresh();
    const restoring = controller.destroy();
    await Promise.all([collecting, restoring]);
    assert.equal(guest.window.document.querySelector("[data-clt-notion-presentation]"), null);
  } finally { await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("guest rejects expired requests and cancelled sessions even when collection arrives after restore", () => {
  const { dom, action } = createGuest();
  let now = 1000;
  dom.window.Date.now = () => now;
  try {
    assert.equal(action({ expiresAt: 999 }).status, "not-ready");
    assert.equal(dom.window.document.querySelector("[data-clt-notion-presentation]"), null);
    assert.equal(action({ action: "restore", expiresAt: 1100, cancelUntil: 1300 }).status, "restored");
    now = 1200;
    assert.equal(action({ expiresAt: 1300 }).status, "not-ready", "Cancellation must outlive the restore deadline");
    assert.equal(dom.window.document.querySelector("[data-clt-notion-presentation]"), null);
    assert.equal(action({ session: "clt_new_session_12345", expiresAt: 1400 }).status, "ready");
    now = 1301;
    assert.equal(action({ expiresAt: 1300 }).status, "not-ready", "Expired calls remain invalid after tombstone pruning");
    assert.equal(dom.window.document.querySelectorAll("[data-clt-notion-presentation]").length, 1);
  } finally { dom.window.close(); }
});

test("hung collection times out without repeated calls, and a late execution cannot revive the restored overlay", { timeout: 4000 }, async () => {
  const { dom: guest } = createGuest();
  const { host, element, controller, calls } = createHost(guest, { rpcTimeoutMs: 100, restoreTimeoutMs: 500 });
  const real = element.executeJavaScript!;
  let lateCode = "";
  let collectCalls = 0;
  let finish!: (value: unknown) => void;
  element.executeJavaScript = code => {
    if (code.includes('"action":"collect"')) {
      collectCalls++;
      lateCode = code;
      return new Promise(resolve => { finish = resolve; });
    }
    return real(code);
  };
  try {
    assert.equal((await controller.collect()).length, 0);
    assert.equal(controller.getStatus().failed, 1);
    const savedCode = lateCode;
    assert.equal((await controller.collect()).length, 0);
    assert.equal(lateCode, savedCode, "Do not keep issuing requests to an unresponsive card");
    assert.equal(collectCalls, 1);
    assert.equal((await controller.destroy()).failed, 0);
    assert.equal(calls.filter(code => code.includes('"action":"restore"')).length, 1);
    const late = guest.window.eval(lateCode);
    finish(late);
    assert.equal(late.status, "not-ready");
    assert.equal(guest.window.document.querySelector("[data-clt-notion-presentation]"), null);
    assert.equal(guest.window.document.querySelector(".notion-scroller")!.hasAttribute("inert"), false);
  } finally { await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("a hung translation patch releases its caller and cannot apply after original restoration", { timeout: 4000 }, async () => {
  const { dom: guest } = createGuest();
  const { host, element, controller } = createHost(guest, { rpcTimeoutMs: 100, restoreTimeoutMs: 500 });
  const real = element.executeJavaScript!;
  let lateCode = "";
  let finish!: (value: unknown) => void;
  try {
    const targets = await controller.collect();
    element.executeJavaScript = code => {
      if (!code.includes('"action":"apply"')) return real(code);
      lateCode = code;
      return new Promise(resolve => { finish = resolve; });
    };
    assert.equal(await targets[0].apply("Late English"), false);
    assert.equal(targets[0].isCurrent(), false);
    assert.equal((await controller.destroy()).failed, 0);
    const late = guest.window.eval(lateCode);
    finish(late);
    assert.equal(late.status, "not-ready");
    assert.equal(guest.window.document.querySelector("[data-clt-notion-presentation]"), null);
  } finally { await controller.destroy(); host.window.close(); guest.window.close(); }
});

test("hung restoration reports failure and concurrent explicit retries share one guest call", { timeout: 4000 }, async () => {
  const { dom: guest } = createGuest();
  const { host, element, controller } = createHost(guest, { rpcTimeoutMs: 100, restoreTimeoutMs: 150 });
  const real = element.executeJavaScript!;
  let release!: () => void;
  try {
    await controller.collect();
    element.executeJavaScript = () => new Promise(() => {});
    assert.equal((await controller.destroy()).failed, 1);
    assert.equal(controller.getStatus().restoreFailed, 1);
    assert.ok(guest.window.document.querySelector("[data-clt-notion-presentation]"));
    let retryCalls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    element.executeJavaScript = async code => { retryCalls++; await gate; return real(code); };
    const first = controller.restoreOriginals();
    const second = controller.restoreOriginals();
    release();
    const results = await Promise.all([first, second]);
    assert.equal(retryCalls, 1);
    assert.ok(results.every(result => result.failed === 0 && result.restored === 1));
    assert.equal(controller.getStatus().restoreFailed, 0);
    assert.equal(guest.window.document.querySelector("[data-clt-notion-presentation]"), null);
    assert.equal(guest.window.document.querySelector(".notion-scroller")!.hasAttribute("inert"), false);
  } finally { release?.(); await controller.destroy(); host.window.close(); guest.window.close(); }
});
