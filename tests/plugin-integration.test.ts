import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { Script } from "node:vm";
import { webcrypto } from "node:crypto";
import { resolve } from "node:path";
import { createObsidianMock, installElementHelpers, type MockRequest, type MockResponse } from "./fixtures/obsidian-mock.ts";

const pause = (milliseconds = 0) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const defaultMarkup = `<div class="canvas-node" data-card="one"><div class="canvas-node-content"><div class="markdown-preview-view markdown-rendered"><p data-source="problem">問題は長期記憶です。</p><p data-source="idea">提案は重要です。</p><pre><code>翻訳しないコード</code></pre><span class="katex">保護する数式</span><input type="checkbox" checked></div></div></div>`;
const dictionary: Record<string, string> = {
  "問題は長期記憶です。": "The problem is long-term memory.",
  "提案は重要です。": "The proposal is important.",
  "更新した日本語です。": "This Japanese text was updated.",
  "再試行する箇所です。": "This segment was retried."
};
let compiled: Promise<string> | undefined;

function productionBundle(): Promise<string> {
  return compiled ??= build({
    entryPoints: [resolve("src/main.ts")],
    bundle: true, write: false, minify: true,
    platform: "browser", target: "es2022", format: "cjs",
    external: ["obsidian", "electron"], logLevel: "silent"
  }).then(result => result.outputFiles[0].text);
}

interface InputText { id: string; text: string; }
function textsFrom(request: MockRequest): InputText[] {
  const body = JSON.parse(request.body);
  return JSON.parse(body.messages.find((message: { role: string }) => message.role === "user").content).texts;
}
function success(request: MockRequest, choose: (text: InputText) => string | undefined = text => dictionary[text.text] ?? "Translated research text."): MockResponse {
  const translations = Object.fromEntries(textsFrom(request).flatMap(text => {
    const value = choose(text);
    return value === undefined ? [] : [[text.id, value]];
  }));
  return {
    status: 200, headers: {},
    text: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ translations }) } }] })
  };
}

async function eventually(condition: () => boolean, message: string, timeout = 4000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (condition()) return;
    await pause(5);
  }
  assert.fail(message);
}

async function fixture(options: {
  markup?: string;
  settings?: Record<string, unknown>;
  request?: (request: MockRequest, index: number) => Promise<MockResponse>;
} = {}) {
  const dom = new JSDOM(`<body><main class="view-content"><div class="canvas">${options.markup ?? defaultMarkup}</div></main></body>`, {
    url: "https://obsidian.test/", pretendToBeVisual: true
  });
  installElementHelpers(dom.window);
  const requests: MockRequest[] = [];
  const host = createObsidianMock(dom.window.document, {
    loadData: { settings: { apiSecretName: "test-openai", model: "gpt-6-luna", translateNotion: false, concurrency: 1, ...options.settings }, cache: {} },
    request: async request => {
      requests.push(request);
      return options.request ? options.request(request, requests.length - 1) : success(request);
    }
  });
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  let editCount = 0;
  const nodes = new Map<string, any>();
  for (const [index, nodeEl] of Array.from(root.querySelectorAll<HTMLElement>(".canvas-node")).entries()) {
    const node: any = {
      nodeEl, isEditing: false,
      startEditing() { editCount++; this.isEditing = true; nodeEl.classList.add("is-editing"); },
      child: { showPreview() { node.isEditing = false; nodeEl.classList.remove("is-editing"); } }
    };
    nodes.set(String(index), node);
  }
  const leaf = { view: { getViewType: () => "canvas", containerEl: root, canvas: { nodes } } };
  host.app.workspace.activeLeaf = leaf;
  const module = { exports: {} as any };
  const context = {
    module, exports: module.exports,
    require: (name: string) => {
      if (name === "obsidian") return host.module;
      throw new Error(`Unexpected runtime dependency: ${name}`);
    },
    window: dom.window, document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    TextEncoder, AbortController, URL, crypto: webcrypto,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, console
  };
  new Script(await productionBundle(), { filename: "canvas-live-translate.production.cjs" }).runInNewContext(context);
  const Plugin = module.exports.default;
  const plugin = new Plugin(host.app, { version: "0.2.0-test" });
  await plugin.onload();
  async function command(id: string, waitForTransition = true) {
    const registered = host.state.commands.get(id);
    assert.ok(registered, `Command ${id} was not registered`);
    if (registered.callback) registered.callback();
    else assert.equal(registered.checkCallback(false), true);
    if (waitForTransition) await plugin.transitionWork;
  }
  async function stop() {
    await command("show-original-canvas");
    plugin.unload();
    await plugin.transitionWork;
    dom.window.close();
  }
  return { dom, root, nodes, host, plugin, requests, command, stop, editCount: () => editCount };
}

test("production bundle registers controls and translates only disposable previews, not native source", async () => {
  const f = await fixture();
  try {
    const original = f.root.querySelector(".canvas-node-content > .markdown-rendered")!;
    const originalMarkup = original.outerHTML;
    assert.equal(f.host.state.commands.get("toggle-canvas-translation").checkCallback(true), true);
    assert.equal(f.host.state.status!.textContent, "Canvas: JA");
    assert.equal(f.requests.length, 0);
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation [data-source='problem']")?.textContent === dictionary["問題は長期記憶です。"], "English preview was not rendered");
    assert.equal(original.outerHTML, originalMarkup);
    assert.equal(f.root.querySelectorAll(".clt-native-presentation").length, 1);
    assert.equal(f.root.querySelector(".clt-native-presentation code")!.textContent, "翻訳しないコード");
    assert.equal(f.root.querySelector(".clt-native-presentation .katex")!.textContent, "保護する数式");
    assert.equal((f.root.querySelector(".clt-native-presentation input") as HTMLInputElement).disabled, true);
    assert.deepEqual(f.host.state.vaultWrites, []);
    const body = JSON.parse(f.requests[0].body);
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.reasoning_effort, "none");
    assert.equal(body.store, false);
    assert.match(f.host.state.status!.textContent!, /Canvas: EN/);
    await f.command("toggle-canvas-translation");
    assert.equal(f.root.querySelector(".clt-native-presentation"), null);
    assert.equal(original.outerHTML, originalMarkup);
    assert.equal(f.host.state.status!.textContent, "Canvas: JA");
  } finally { await f.stop(); }
});

test("English interaction stays read-only and scrollable, then original editing is restored", async () => {
  const f = await fixture();
  try {
    const node = f.nodes.get("0");
    const originalStartEditing = node.startEditing;
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Translation did not finish");
    const overlay = f.root.querySelector<HTMLElement>(".clt-native-presentation")!;
    const paragraph = overlay.querySelector("p")!;
    paragraph.dispatchEvent(new f.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    node.startEditing();
    assert.equal(f.editCount(), 0);
    assert.ok(overlay.textContent!.includes("long-term memory"));
    const input = new f.dom.window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "oops" });
    paragraph.dispatchEvent(input);
    assert.equal(input.defaultPrevented, true);
    Object.defineProperties(overlay, { scrollHeight: { value: 600 }, clientHeight: { value: 100 } });
    const wheel = new f.dom.window.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
    paragraph.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, false);
    assert.equal(overlay.scrollTop, 0, "Synthetic JSDOM events have no browser wheel default action");
    overlay.scrollTop = 80;
    overlay.dispatchEvent(new f.dom.window.Event("scroll"));
    assert.equal(overlay.scrollTop, 80);
    await f.command("show-original-canvas");
    assert.equal(node.startEditing, originalStartEditing);
    node.startEditing();
    assert.equal(f.editCount(), 1);
    assert.equal(f.root.querySelector(".clt-native-presentation"), null);
  } finally { await f.stop(); }
});

test("late provider completion after OFF cannot restore English or populate its cancelled-session cache", async () => {
  let release!: () => void;
  const f = await fixture({ request: async request => {
    await new Promise<void>(resolve => { release = resolve; });
    return success(request);
  } });
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => f.requests.length === 1, "API mock did not start");
    await f.command("show-original-canvas");
    release();
    await pause(30);
    assert.equal(f.root.querySelector(".clt-native-presentation"), null);
    assert.ok(f.root.textContent!.includes("問題は長期記憶です。"));
    assert.equal(f.host.state.status!.textContent, "Canvas: JA");
    assert.equal(Object.keys(f.plugin.cache).length, 0);
    assert.deepEqual(f.host.state.vaultWrites, []);
  } finally { release?.(); await f.stop(); }
});

test("OFF cleans detached translated cards before Canvas can recycle them", async () => {
  const f = await fixture();
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Translation did not finish");
    const card = f.root.querySelector<HTMLElement>(".canvas-node")!;
    card.remove();
    await f.command("show-original-canvas");
    assert.equal(card.querySelector(".clt-native-presentation"), null);
    assert.equal(card.querySelector(".clt-source-container"), null);
    assert.ok(card.textContent!.includes("問題は長期記憶です。"));
    f.root.querySelector(".canvas")!.appendChild(card);
    await pause(20);
    assert.equal(f.root.querySelector(".clt-native-presentation"), null);
    assert.equal(f.host.state.status!.textContent, "Canvas: JA");
  } finally { await f.stop(); }
});

test("rapid OFF/ON transitions retain one current layer and respect old nonabortable request capacity", async () => {
  let releaseOld!: () => void;
  const f = await fixture({ request: async (request, index) => {
    if (index === 0) await new Promise<void>(resolve => { releaseOld = resolve; });
    return success(request);
  } });
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => f.requests.length === 1, "First API request did not start");
    await f.command("show-original-canvas");
    await f.command("toggle-canvas-translation", false);
    await f.command("toggle-canvas-translation", false);
    await f.command("toggle-canvas-translation", false);
    await f.plugin.transitionWork;
    await pause(80);
    assert.equal(f.requests.length, 1, "A cancelled but still-running request must consume capacity");
    assert.equal(f.root.querySelectorAll(".clt-native-presentation").length, 1);
    releaseOld();
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Final session did not translate");
    assert.equal(f.requests.length, 2);
    assert.equal(f.root.querySelectorAll(".clt-native-presentation").length, 1);
    assert.equal(f.root.querySelector(".canvas-node-content > .markdown-rendered [data-source='problem']")!.textContent, "問題は長期記憶です。");
  } finally { releaseOld?.(); await f.stop(); }
});

test("JA removes a separately cached English card when Canvas later reinserts it without opening the card", async () => {
  const f = await fixture();
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Translation did not finish");
    // This is a separate host-owned copy, not the detached original already
    // tracked by CanvasPresentation.entries.
    const cached = f.root.querySelector<HTMLElement>(".canvas-node")!.cloneNode(true) as HTMLElement;
    await f.command("show-original-canvas");
    f.root.querySelector(".canvas")!.appendChild(cached);
    await eventually(() => cached.querySelector(".clt-native-presentation") === null, "Cached English survived reinsertion in JA");
    assert.ok(cached.textContent!.includes("問題は長期記憶です。"));
    assert.ok(!cached.textContent!.includes("long-term memory"));
    assert.equal(f.editCount(), 0);
    assert.equal(f.host.state.status!.textContent, "Canvas: JA");
    assert.deepEqual(f.host.state.vaultWrites, []);
  } finally { await f.stop(); }
});

test("OFF redraws a native cached preview from Japanese source without entering edit mode", async () => {
  const f = await fixture();
  try {
    const node = f.nodes.get("0");
    const native = f.root.querySelector<HTMLElement>(".canvas-node-content > .markdown-rendered")!;
    const original = native.innerHTML;
    let rendered = 0;
    node.child.previewMode = {
      containerEl: native,
      rerender(full: boolean) { assert.equal(full, true); rendered++; native.innerHTML = original; }
    };
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Translation did not finish");
    // Model a host renderer retaining flattened translated sections after
    // the presentation wrapper itself has been removed.
    native.innerHTML = f.root.querySelector<HTMLElement>(".clt-native-presentation .markdown-rendered")!.innerHTML;
    await f.command("show-original-canvas");
    assert.equal(native.innerHTML, original);
    assert.equal(rendered, 1);
    assert.equal(f.editCount(), 0);
    assert.equal(node.isEditing, false);
    assert.equal(f.host.state.status!.textContent, "Canvas: JA");
    assert.deepEqual(f.host.state.vaultWrites, []);
  } finally { await f.stop(); }
});

test("OFF restores exact translated text retained by a native renderer outside its original overlay", async () => {
  const f = await fixture();
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Translation did not finish");
    const translated = f.root.querySelector(".clt-native-presentation [data-source='problem']")!.firstChild!;
    const native = f.root.querySelector(".canvas-node-content > .markdown-rendered [data-source='problem']")!;
    native.replaceChildren(translated);
    await f.command("show-original-canvas");
    assert.equal(native.textContent, "問題は長期記憶です。");
    assert.equal(translated.textContent, "問題は長期記憶です。");
    assert.equal(f.editCount(), 0);
    assert.deepEqual(f.host.state.vaultWrites, []);
  } finally { await f.stop(); }
});

test("closing a Canvas tab releases its original-view observer while inactive live tabs stay protected", async () => {
  const f = await fixture();
  try {
    const workspace = f.host.app.workspace as any;
    let leaves = [workspace.activeLeaf];
    workspace.getLeavesOfType = () => leaves;
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Translation did not finish");
    await f.command("show-original-canvas");
    assert.equal(f.plugin.originalViews.size, 1);
    f.root.remove();
    workspace.emit("layout-change");
    assert.equal(f.plugin.originalViews.size, 1, "A detached but still-open Canvas needs its guard");
    leaves = [];
    workspace.emit("layout-change");
    assert.equal(f.plugin.originalViews.size, 0, "Closed Canvas observers must be released");
  } finally { await f.stop(); }
});

test("a missing structured entry retries only that text and does not pause the Canvas", async () => {
  const markup = `<div class="canvas-node"><div class="canvas-node-content"><div class="markdown-rendered"><p>問題は長期記憶です。</p><p>再試行する箇所です。</p></div></div></div>`;
  const f = await fixture({ markup, request: async (request, index) => success(request, text =>
    index === 0 && text.text === "再試行する箇所です。" ? undefined : dictionary[text.text]) });
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Valid neighbour was lost");
    assert.equal(f.plugin.session.queue.stats.paused, false);
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("was retried") ?? false, "Missing entry did not retry");
    assert.equal(f.requests.length, 2);
    assert.deepEqual(textsFrom(f.requests[1]).map(item => item.text), ["再試行する箇所です。"]);
    assert.equal(f.plugin.session.queue.stats.failed, 0);
    assert.equal(f.plugin.session.queue.stats.paused, false);
    assert.ok(!f.host.state.notices.some(message => /paused|stopped/i.test(message)));
    assert.equal(f.root.querySelector(".canvas-node-content > .markdown-rendered")!.textContent, "問題は長期記憶です。再試行する箇所です。");
  } finally { await f.stop(); }
});

test("source changes refresh the presentation and reuse cache for unchanged neighbouring text", async () => {
  const f = await fixture();
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Initial translation did not finish");
    const native = f.root.querySelector(".canvas-node-content > .markdown-rendered [data-source='problem']")!;
    native.textContent = "更新した日本語です。";
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("was updated") ?? false, "Source update was not detected");
    assert.equal(native.textContent, "更新した日本語です。");
    assert.equal(f.requests.length, 2);
    assert.deepEqual(textsFrom(f.requests[1]).map(item => item.text), ["更新した日本語です。"]);
    assert.equal(f.root.querySelectorAll(".clt-native-presentation").length, 1);
  } finally { await f.stop(); }
});

test("lazy Markdown additions keep the focused translated scroll box and submit only newly discovered text", async () => {
  const f = await fixture();
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Initial translation did not finish");
    const overlay = f.root.querySelector<HTMLElement>(".clt-native-presentation")!;
    const paragraph = overlay.querySelector<HTMLElement>("[data-source='problem']")!;
    const translated = paragraph.firstChild!;
    overlay.focus(); overlay.scrollTop = 120;
    const native = f.root.querySelector<HTMLElement>(".canvas-node-content > .markdown-rendered")!;
    const extra = f.dom.window.document.createElement("p");
    extra.dataset.source = "lazy";
    extra.textContent = "更新した日本語です。";
    native.appendChild(extra);
    await f.plugin.scanCanvas(f.plugin.session);
    assert.equal(f.root.querySelector(".clt-native-presentation"), overlay);
    assert.equal(overlay.querySelector("[data-source='problem']")!.firstChild, translated);
    assert.equal(translated.textContent, dictionary["問題は長期記憶です。"]);
    assert.equal(overlay.scrollTop, 120);
    assert.equal(f.dom.window.document.activeElement, overlay);
    await eventually(() => overlay.querySelector("[data-source='lazy']")?.textContent === dictionary["更新した日本語です。"], "Lazy text did not translate");
    assert.equal(f.requests.length, 2);
    assert.deepEqual(textsFrom(f.requests[1]).map(item => item.text), ["更新した日本語です。"]);
    // A native full DOM redraw of unchanged source retains translations too.
    native.innerHTML = native.innerHTML;
    await f.plugin.scanCanvas(f.plugin.session);
    assert.equal(overlay.querySelector("[data-source='problem']")!.firstChild, translated);
    assert.equal(overlay.scrollTop, 120);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.host.state.vaultWrites, []);
  } finally { await f.stop(); }
});

test("settings render, clamp concurrency, and save secret references without API-key material", async () => {
  const f = await fixture({ settings: { concurrency: 999, model: "custom-model" } });
  try {
    assert.equal(f.plugin.settings.concurrency, 6);
    f.host.state.settingsTabs[0].display();
    assert.ok(f.host.state.controls.some(item => item.name === "Translate Notion web cards"));
    assert.ok(f.host.state.controls.some(item => item.name === "Fast / low-cost preset"));
    await f.plugin.useFastPreset();
    assert.equal(f.plugin.settings.model, "gpt-6-luna");
    assert.equal(f.plugin.settings.concurrency, 3);
    const saved = f.host.state.saves.at(-1);
    assert.equal(saved.settings.apiSecretName, "test-openai");
    assert.equal(JSON.stringify(saved).includes("unit-test-not-a-real-key"), false);
    assert.equal(f.requests.length, 0);
    await f.command("translation-status");
    assert.ok(f.dom.window.document.querySelector("pre.clt-diagnostics")?.textContent?.includes("gpt-6-luna"));
  } finally { await f.stop(); }
});

test("fatal API authentication errors pause once and the retry command resumes the same targets", async () => {
  let authenticationBroken = true;
  const f = await fixture({ request: async request => authenticationBroken
    ? { status: 401, headers: {}, text: JSON.stringify({ error: { code: "invalid_api_key", message: "Test credential is invalid" } }) }
    : success(request) });
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => f.plugin.session?.queue.stats.paused === true, "Authentication error did not pause");
    assert.match(f.host.state.status!.textContent!, /paused/);
    assert.equal(f.host.state.notices.filter(message => /paused/.test(message)).length, 1);
    assert.equal(f.requests.length, 1);
    authenticationBroken = false;
    await f.command("retry-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Manual retry did not update original subscribers");
    assert.equal(f.plugin.session.queue.stats.paused, false);
    assert.equal(f.plugin.session.queue.stats.failed, 0);
    assert.equal(f.requests.length, 2);
    assert.equal(f.root.querySelector(".canvas-node-content > .markdown-rendered [data-source='problem']")!.textContent, "問題は長期記憶です。");
  } finally { await f.stop(); }
});

test("enabling without a secret leaves the Canvas original and does not contact the provider", async () => {
  const f = await fixture({ settings: { apiSecretName: "" } });
  try {
    await f.command("toggle-canvas-translation");
    assert.equal(f.plugin.enabled, false);
    assert.equal(f.host.state.status!.textContent, "Canvas: JA");
    assert.equal(f.root.querySelector(".clt-native-presentation"), null);
    assert.equal(f.requests.length, 0);
    assert.ok(f.host.state.notices.some(message => /API key/.test(message)));
  } finally { await f.stop(); }
});

test("switching Canvas tabs restores the old view and translates the new view using shared cache", async () => {
  const f = await fixture();
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => f.root.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "Initial view did not translate");
    const secondRoot = f.dom.window.document.createElement("main");
    secondRoot.innerHTML = `<div class="canvas">${defaultMarkup}</div>`;
    f.dom.window.document.body.appendChild(secondRoot);
    f.host.app.workspace.activeLeaf = { view: { getViewType: () => "canvas", containerEl: secondRoot, canvas: { nodes: new Map() } } };
    f.host.app.workspace.emit("active-leaf-change");
    await f.plugin.transitionWork;
    await eventually(() => secondRoot.querySelector(".clt-native-presentation")?.textContent?.includes("long-term memory") ?? false, "New view did not translate");
    assert.equal(f.root.querySelector(".clt-native-presentation"), null);
    assert.ok(f.root.textContent!.includes("問題は長期記憶です。"));
    assert.equal(f.requests.length, 1, "Repeated source text should be served from the shared translation cache");
    f.host.app.workspace.activeLeaf = { view: { getViewType: () => "markdown", containerEl: secondRoot } };
    f.host.app.workspace.emit("active-leaf-change");
    await f.plugin.transitionWork;
    assert.equal(secondRoot.querySelector(".clt-native-presentation"), null);
    assert.equal(f.host.state.status!.textContent, "Canvas: EN (inactive)");
  } finally { await f.stop(); }
});

test("a native cleanup failure still unlocks Canvas and restores web cards", async () => {
  const f = await fixture();
  try {
    await f.command("toggle-canvas-translation");
    await eventually(() => !!f.root.querySelector(".clt-native-presentation"), "Missing presentation");
    const session = f.plugin.session;
    const destroyQueue = session.queue.destroy.bind(session.queue);
    session.queue.destroy = () => { destroyQueue(); throw new Error("Cleanup failure"); };
    let restored = 0;
    session.web = { destroy: async () => { restored++; return { failed: 0, restored: 1 }; } };
    await f.command("show-original-canvas");
    assert.equal(restored, 1);
    assert.equal(f.root.classList.contains("canvas-live-translate-enabled"), false);
    assert.equal(f.root.querySelector(".clt-native-presentation"), null);
    assert.match(f.plugin.restoreError, /could not be completely restored/);
    assert.equal(f.plugin.transitioning, false);
    await f.command("show-original-canvas");
    assert.equal(f.plugin.restoreError, "");
  } finally { await f.stop(); }
});

test("a hung web restoration releases the transition and allows an explicit retry", { timeout: 4000 }, async () => {
  const f = await fixture();
  const originalTimeout = f.dom.window.setTimeout.bind(f.dom.window);
  // Exercise the production timeout path without waiting eight real seconds.
  f.dom.window.setTimeout = ((handler: any, delay?: number, ...args: any[]) =>
    originalTimeout(handler, delay === 8000 ? 20 : delay, ...args)) as typeof f.dom.window.setTimeout;
  try {
    await f.command("toggle-canvas-translation");
    const controller = {
      destroy: () => new Promise(() => {}),
      restoreOriginals: async () => ({ failed: 0, restored: 1 })
    };
    f.plugin.session.web = controller;
    await f.command("show-original-canvas");
    assert.equal(f.plugin.transitioning, false);
    assert.match(f.plugin.restoreError, /within 8 seconds/);
    assert.equal(f.root.classList.contains("canvas-live-translate-enabled"), false);
    await f.command("show-original-canvas");
    assert.equal(f.plugin.restoreError, "");
    assert.equal(f.plugin.pendingRestores.size, 0);
  } finally { await f.stop(); }
});

test("a failed obsolete transition cannot turn off a newer requested English session", async () => {
  const f = await fixture();
  let finish!: (value: { failed: number; restored: number }) => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  try {
    await f.command("toggle-canvas-translation");
    f.plugin.session.web = {
      destroy: () => { began(); return new Promise(resolve => { finish = resolve; }); },
      restoreOriginals: async () => ({ failed: 0, restored: 1 })
    };
    await f.command("show-original-canvas", false);
    await started;
    await f.command("toggle-canvas-translation", false);
    finish({ failed: 1, restored: 0 });
    await f.plugin.transitionWork;
    assert.equal(f.plugin.enabled, true);
    assert.ok(f.plugin.session);
    assert.equal(f.plugin.restoreError, "");
  } finally { finish?.({ failed: 0, restored: 1 }); await f.stop(); }
});
