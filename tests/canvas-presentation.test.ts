import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { CanvasPresentation } from "../src/canvas-presentation.ts";
import { findTranslatableNodes } from "../src/canvas-dom.ts";

function fixture() {
  const dom = new JSDOM(`<main><div class="canvas-node"><div class="canvas-node-content"><div class="markdown-preview-view markdown-rendered"><p>原文は日本語です。</p><ul><li><input type="checkbox" checked>完了した項目</li></ul><span class="math">x_t</span><code>日本語のコード</code></div></div></div><div class="canvas-node-label">研究計画</div></main>`);
  const root = dom.window.document.querySelector("main")!;
  const layer = new CanvasPresentation(root);
  const original = root.querySelector(".markdown-preview-view")!;
  return { dom, root, layer, original };
}

test("translation exists only on disposable clone; JA mode keeps exact original text", () => {
  const { root, layer, original } = fixture();
  const before = original.outerHTML;
  layer.refresh();
  const nodes = findTranslatableNodes(root, true);
  assert.deepEqual(nodes.map(n => n.data), ["原文は日本語です。", "完了した項目", "研究計画"]);
  nodes.forEach(n => { n.data = "English translation"; });
  assert.equal(original.outerHTML, before);
  assert.equal(root.querySelector<HTMLInputElement>(".clt-native-presentation input")!.disabled, true);
  layer.destroy();
  assert.equal(root.querySelector(".clt-native-presentation"), null);
  assert.equal(original.outerHTML, before);
  assert.equal(root.textContent!.includes("English translation"), false);
  assert.equal(root.querySelector(".canvas-node-label")!.textContent, "研究計画");
});

test("detached Canvas cards are cleaned before reuse (English cannot survive into JA)", () => {
  const { root, layer } = fixture();
  layer.refresh();
  findTranslatableNodes(root, true).forEach(n => { n.data = "English"; });
  const card = root.querySelector(".canvas-node")!;
  card.remove();
  layer.destroy();
  root.appendChild(card);
  assert.equal(card.querySelector(".clt-native-presentation"), null);
  assert.equal(card.textContent!.includes("English"), false);
});

test("external source changes update the persistent reading clone without carrying an edited paragraph's old English", () => {
  const { root, layer, original } = fixture();
  layer.refresh();
  const first = root.querySelector<HTMLElement>(".clt-native-presentation")!;
  first.scrollTop = 90;
  findTranslatableNodes(root, true)[0].data = "Old translation";
  original.querySelector("p")!.textContent = "更新された原文";
  layer.refresh();
  const second = root.querySelector<HTMLElement>(".clt-native-presentation")!;
  assert.equal(first, second);
  assert.equal(second.scrollTop, 90);
  assert.equal(second.querySelector("p")!.textContent, "更新された原文");
  assert.equal(original.querySelector("p")!.textContent, "更新された原文");
  layer.destroy();
});

test("refresh reuses a translated clone when the original did not change", () => {
  const { root, layer } = fixture();
  layer.refresh();
  const old = root.querySelector(".clt-native-presentation");
  findTranslatableNodes(root, true)[0].data = "English";
  layer.refresh();
  assert.equal(root.querySelector(".clt-native-presentation"), old);
  assert.equal(old!.querySelector("p")!.textContent, "English");
  layer.destroy();
});

test("a late image load cannot replay an older position over a wheel movement awaiting its scroll event", () => {
  const { dom, root, layer, original } = fixture();
  const image = dom.window.document.createElement("img");
  original.appendChild(image);
  layer.refresh();
  const overlay = root.querySelector<HTMLElement>(".clt-native-presentation")!;
  overlay.scrollTop = 90;
  overlay.dispatchEvent(new dom.window.Event("scroll"));
  // Browser default wheel action happens before the next scroll event.
  overlay.scrollTop = 150;
  overlay.querySelector("img")!.dispatchEvent(new dom.window.Event("load"));
  assert.equal(overlay.scrollTop, 150);
  layer.destroy();
  dom.window.close();
});

test("clone stays translatable during transient native editing class but never includes real editor", () => {
  const { root, layer } = fixture();
  root.querySelector(".canvas-node")!.classList.add("is-editing");
  layer.refresh();
  assert.ok(findTranslatableNodes(root, true).length > 0);
  layer.destroy();
});

test("a Markdown note with an embedded webview still translates its text, but never clones the webview", () => {
  const { root, layer } = fixture();
  const content = root.querySelector(".canvas-node-content")!;
  content.appendChild(root.ownerDocument.createElement("webview"));
  layer.refresh();
  assert.ok(root.querySelector(".clt-native-presentation"));
  assert.equal(root.querySelector(".clt-native-presentation webview"), null);
  assert.ok(findTranslatableNodes(root, true).some(node => node.data === "原文は日本語です。"));
  layer.destroy();
});

test("a pure embedded web card does not become a native Markdown presentation", () => {
  const { root, layer } = fixture();
  root.querySelector(".markdown-preview-view")!.remove();
  root.querySelector(".canvas-node-content")!.appendChild(root.ownerDocument.createElement("webview"));
  layer.refresh();
  assert.equal(root.querySelector(".clt-native-presentation"), null);
  layer.destroy();
});

test("translated cards preserve container and preview padding from native direct-child selectors", () => {
  const { dom, root, layer, original } = fixture();
  const style = dom.window.document.createElement("style");
  style.textContent = `
    .canvas-node-content { padding: 8px 12px 10px 14px; }
    .markdown-preview-view { padding: 0; }
    .canvas-node-content > .markdown-preview-view { padding: 16px 20px 18px 22px; }
    ${readFileSync(new URL("../styles.css", import.meta.url), "utf8")}
  `;
  dom.window.document.head.appendChild(style);
  root.classList.add("canvas-live-translate-enabled", "canvas-live-translate-readonly");
  const before = original.outerHTML;
  const nativePadding = dom.window.getComputedStyle(original).padding;
  layer.refresh();
  const overlay = root.querySelector<HTMLElement>(".clt-native-presentation")!;
  const preview = overlay.querySelector<HTMLElement>(".markdown-preview-view")!;
  assert.equal(dom.window.getComputedStyle(overlay).padding, "8px 12px 10px 14px");
  assert.equal(dom.window.getComputedStyle(preview).padding, nativePadding);
  assert.equal(nativePadding, "16px 20px 18px 22px");
  assert.equal(original.outerHTML, before);
  layer.destroy();
  assert.equal(original.outerHTML, before);
});

test("embedded note padding keeps theme zeroes and avoids adding a second fixed inset", () => {
  const dom = new JSDOM(`<style>
    .canvas-node-content { padding: 0; }
    .markdown-embed, .markdown-embed-content, .markdown-preview-view { padding: 40px; }
    .canvas-node-content > .markdown-embed { padding: 9px 17px; }
    .canvas-node-content > .markdown-embed > .markdown-embed-content { padding: 0; }
    .canvas-node-content > .markdown-embed > .markdown-embed-content > .markdown-preview-view { padding: 5px 7px; }
    ${readFileSync(new URL("../styles.css", import.meta.url), "utf8")}
  </style><main class="canvas-live-translate-enabled canvas-live-translate-readonly">
    <div class="canvas-node"><div class="canvas-node-content"><div class="markdown-embed"><div class="markdown-embed-content"><div class="markdown-preview-view markdown-rendered"><p>日本語</p></div></div></div></div></div>
  </main>`);
  const root = dom.window.document.querySelector("main")!;
  const layer = new CanvasPresentation(root);
  layer.refresh();
  const overlay = root.querySelector<HTMLElement>(".clt-native-presentation")!;
  assert.equal(dom.window.getComputedStyle(overlay).padding, "0px");
  assert.equal(dom.window.getComputedStyle(overlay.querySelector(".markdown-embed")!).padding, "9px 17px");
  assert.equal(dom.window.getComputedStyle(overlay.querySelector(".markdown-embed-content")!).padding, "0px");
  assert.equal(dom.window.getComputedStyle(overlay.querySelector(".markdown-preview-view")!).padding, "5px 7px");
  layer.destroy();
});

test("translation layers do not advertise an Obsidian aria-label or title hover tooltip", () => {
  const { root, layer } = fixture();
  layer.refresh();
  const overlays = root.querySelectorAll<HTMLElement>(".clt-native-presentation, .clt-label-presentation");
  assert.equal(overlays.length, 2);
  for (const overlay of overlays) {
    assert.equal(overlay.hasAttribute("aria-label"), false);
    assert.equal(overlay.hasAttribute("title"), false);
  }
  assert.equal(root.querySelector<HTMLElement>(".clt-native-presentation")!.tabIndex, 0);
  layer.destroy();
});

test("recycled translation layers remain hidden in Japanese mode before DOM cleanup", () => {
  const { dom, root, layer } = fixture();
  const style = dom.window.document.createElement("style");
  style.textContent = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  dom.window.document.head.appendChild(style);
  root.classList.add("canvas-live-translate-enabled");
  layer.refresh();
  const saved = Array.from(root.querySelectorAll<HTMLElement>(".clt-native-presentation, .clt-label-presentation"))
    .map(overlay => {
      assert.equal(dom.window.getComputedStyle(overlay).display, "block");
      return overlay.cloneNode(true) as HTMLElement;
    });
  layer.destroy();
  root.classList.remove("canvas-live-translate-enabled");
  for (const overlay of saved) {
    root.appendChild(overlay);
    assert.equal(dom.window.getComputedStyle(overlay).display, "none");
  }
});
