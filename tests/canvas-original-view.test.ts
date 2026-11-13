import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createOriginalCanvasView } from "../src/canvas-original-view.ts";

const cardMarkup = `<div class="canvas-node clt-text-readonly"><div class="canvas-node-content clt-source-container"><div class="markdown-preview-view markdown-rendered"><p>研究計画は日本語です。</p><code>original English code</code></div><div class="clt-native-presentation" data-clt-presentation="true"><div class="markdown-preview-view markdown-rendered"><p>The research plan is in English.</p></div></div></div></div>`;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function fixture(markup = cardMarkup) {
  const dom = new JSDOM(`<body><main><div class="canvas">${markup}</div></main></body>`, { pretendToBeVisual: true });
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const card = root.querySelector<HTMLElement>(".canvas-node")!;
  const preview = card?.querySelector<HTMLElement>(".canvas-node-content > .markdown-preview-view")!;
  return { dom, root, card, preview };
}

test("JA cleans an untracked cached card when it is reinserted after translation was stopped", async () => {
  const f = fixture();
  const cached = f.card.cloneNode(true) as HTMLElement;
  const nativeBefore = f.preview.outerHTML;
  const controller = createOriginalCanvasView(f.root);
  try {
    assert.equal(f.root.querySelector(".clt-native-presentation"), null);
    assert.equal(f.preview.outerHTML, nativeBefore);
    f.root.querySelector(".canvas")!.appendChild(cached);
    await tick();
    assert.equal(cached.querySelector(".clt-native-presentation"), null);
    assert.equal(cached.querySelector(".clt-source-container"), null);
    assert.equal(cached.textContent, "研究計画は日本語です。original English code");
    assert.equal(f.preview.outerHTML, nativeBefore);
  } finally { controller.destroy(); f.dom.window.close(); }
});

test("JA cleans detached cached card DOM retained by the Canvas node map", () => {
  const f = fixture();
  const cached = f.card.cloneNode(true) as HTMLElement;
  const detachedContent = cached.querySelector<HTMLElement>(".canvas-node-content")!;
  const nodes = new Map([["cached", { nodeEl: cached, contentEl: detachedContent }]]);
  const controller = createOriginalCanvasView(f.root, { canvas: { nodes } });
  try {
    assert.equal(cached.isConnected, false);
    assert.equal(cached.querySelector(".clt-native-presentation"), null);
    assert.equal(cached.querySelector(".clt-source-container"), null);
    f.root.querySelector(".canvas")!.appendChild(cached);
    assert.equal(cached.textContent, "研究計画は日本語です。original English code");
  } finally { controller.destroy(); f.dom.window.close(); }
});

test("JA refreshes a cached native reading preview from source without entering edit mode and retains logical scroll", async () => {
  const f = fixture();
  f.preview.querySelector("p")!.textContent = "Old cached English reading preview";
  let rerenders = 0;
  let appliedScroll: number | undefined;
  const forbidden = () => { assert.fail("Original-view restoration must not edit, save, focus or change modes"); };
  const previewMode = {
    containerEl: f.preview,
    getScroll: () => 7.25,
    applyScroll: (value: number) => { appliedScroll = value; },
    rerender(full?: boolean) {
      assert.equal(full, true);
      rerenders++;
      f.preview.querySelector("p")!.textContent = "研究計画は日本語です。";
    },
    set: forbidden, clear: forbidden
  };
  const node = {
    nodeEl: f.card, isEditing: false, startEditing: forbidden, setData: forbidden,
    child: { previewMode, showPreview: forbidden, setViewData: forbidden, focus: forbidden }
  };
  const controller = createOriginalCanvasView(f.root, { canvas: { nodes: new Map([["one", node]]), requestSave: forbidden } });
  try {
    await tick();
    assert.equal(f.preview.querySelector("p")!.textContent, "研究計画は日本語です。");
    assert.equal(appliedScroll, 7.25);
    assert.equal(node.isEditing, false);
    assert.equal(rerenders, 1, "Rerender's DOM mutations must not cause a restoration loop");
    await tick();
    assert.equal(rerenders, 1);
  } finally { controller.destroy(); f.dom.window.close(); }
});

test("JA preserves native pixel scroll when preview logical-scroll hooks are unavailable", async () => {
  const f = fixture();
  f.preview.scrollTop = 240;
  f.preview.scrollLeft = 12;
  const previewMode = {
    containerEl: f.preview,
    rerender() { f.preview.scrollTop = 0; f.preview.scrollLeft = 0; }
  };
  const controller = createOriginalCanvasView(f.root, { nodes: [{ nodeEl: f.card, child: { previewMode } }] });
  try {
    await tick();
    assert.equal(f.preview.scrollTop, 240);
    assert.equal(f.preview.scrollLeft, 12);
  } finally { controller.destroy(); f.dom.window.close(); }
});

test("optional native hooks are safe to omit or reject, and an active editor keeps its focus and mode", async () => {
  const f = fixture();
  f.card.classList.add("is-editing");
  const input = f.dom.window.document.createElement("textarea");
  input.value = "編集中の原文";
  f.card.appendChild(input);
  input.focus();
  const editingNode = {
    nodeEl: f.card, isEditing: true,
    child: { previewMode: { containerEl: f.preview, rerender() { assert.fail("Do not rerender an active editor"); } } }
  };
  const other = f.card.cloneNode(true) as HTMLElement;
  other.classList.remove("is-editing");
  const throwingNode = {
    nodeEl: other,
    child: { previewMode: { containerEl: other.querySelector(".markdown-preview-view"), rerender() { throw new Error("Unloaded preview"); } } }
  };
  let controller!: ReturnType<typeof createOriginalCanvasView>;
  try {
    assert.doesNotThrow(() => { controller = createOriginalCanvasView(f.root, { nodes: [editingNode, throwingNode, { nodeEl: other }] }); });
    await tick();
    assert.equal(f.dom.window.document.activeElement, input);
    assert.equal(input.value, "編集中の原文");
    assert.equal(editingNode.isEditing, true);
    assert.equal(f.card.classList.contains("is-editing"), true);
    assert.equal(f.root.querySelector(".clt-native-presentation"), null);
  } finally { controller?.destroy(); f.dom.window.close(); }
});

test("the JA cleanup observer does not remove overlays from a new English session", async () => {
  const f = fixture();
  const cached = f.card.cloneNode(true) as HTMLElement;
  const controller = createOriginalCanvasView(f.root);
  try {
    f.root.classList.add("canvas-live-translate-enabled");
    f.root.querySelector(".canvas")!.appendChild(cached);
    controller.restore();
    await tick();
    assert.ok(cached.querySelector(".clt-native-presentation"), "Guard must skip an active English session");
    controller.destroy();
    f.root.classList.remove("canvas-live-translate-enabled");
    const later = cached.cloneNode(true) as HTMLElement;
    f.root.querySelector(".canvas")!.appendChild(later);
    await tick();
    assert.ok(later.querySelector(".clt-native-presentation"), "Destroyed controller must no longer mutate the DOM");
  } finally { controller.destroy(); f.dom.window.close(); }
});
