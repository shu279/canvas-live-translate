import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { CanvasPresentation } from "../src/canvas-presentation.ts";

/**
 * Deterministic CSSOM model, not a browser layout engine. Paragraph height is
 * deliberately longer after translation; scrollTop obeys native-style bounds.
 * This exposes the regression that JSDOM's unbounded scrollTop alone misses.
 */
function fixture(paragraphs = 30) {
  const dom = new JSDOM(`<main><div class="canvas-node"><div class="canvas-node-content"><div class="markdown-preview-view markdown-rendered"></div></div></div></main>`, { pretendToBeVisual: true });
  const root = dom.window.document.querySelector<HTMLElement>("main")!;
  const source = root.querySelector<HTMLElement>(".markdown-preview-view")!;
  const positions = new WeakMap<HTMLElement, number>();
  const writes = new WeakMap<HTMLElement, number>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  dom.window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  dom.window.cancelAnimationFrame = id => { frames.delete(id); };
  const flushFrame = () => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(0));
  };
  const height = (element: HTMLElement) => Math.max(1, Math.ceil((element.textContent?.length ?? 0) / 60)) * 24 + 12;
  const scrollBox = (element: HTMLElement) => element.closest<HTMLElement>(".clt-native-presentation")
    ?? element.closest<HTMLElement>(".markdown-preview-view");
  const isScroller = (element: HTMLElement) => element.matches(".clt-native-presentation, .markdown-preview-view");
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get() { return isScroller(this) ? 320 : 0; } },
    offsetHeight: { configurable: true, get() { return isScroller(this) ? 320 : this.matches("p") ? height(this) : 0; } },
    clientWidth: { configurable: true, get() { return 400; } },
    offsetWidth: { configurable: true, get() { return 400; } },
    scrollHeight: { configurable: true, get() { return [...this.querySelectorAll<HTMLElement>("p")].reduce((sum, paragraph) => sum + height(paragraph), 0); } },
    scrollTop: {
      configurable: true,
      get() {
        const bounded = Math.min(positions.get(this) ?? 0, Math.max(0, this.scrollHeight - this.clientHeight));
        positions.set(this, bounded);
        return bounded;
      },
      set(value: number) {
        positions.set(this, Math.min(Math.max(0, value), Math.max(0, this.scrollHeight - this.clientHeight)));
        writes.set(this, (writes.get(this) ?? 0) + 1);
      }
    }
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const element = this as HTMLElement;
    if (isScroller(element)) return new dom.window.DOMRect(20, 30, 400, 320);
    if (element.matches("p")) {
      const box = scrollBox(element);
      if (box) {
        let before = 0;
        for (const paragraph of box.querySelectorAll<HTMLElement>("p")) {
          if (paragraph === element) break;
          before += height(paragraph);
        }
        return new dom.window.DOMRect(20, 30 + before - box.scrollTop, 400, height(element));
      }
    }
    return new dom.window.DOMRect();
  };
  const addParagraph = () => {
    const paragraph = dom.window.document.createElement("p");
    paragraph.dataset.source = String(source.children.length);
    paragraph.textContent = `日本語の段落 ${source.children.length}`;
    source.appendChild(paragraph);
    return paragraph;
  };
  for (let index = 0; index < paragraphs; index++) addParagraph();
  const layer = new CanvasPresentation(root);
  layer.refresh();
  const overlay = () => root.querySelector<HTMLElement>(".clt-native-presentation")!;
  const english = (index: number) => `Paragraph ${index}. ` + "An English translation retaining the research meaning and established terminology. ".repeat(5);
  const translateAll = () => overlay().querySelectorAll("p").forEach((paragraph, index) => {
    // Match production: update Text.data, preserving its DOM identity.
    (paragraph.firstChild as Text).data = english(index);
  });
  const maximum = () => overlay().scrollHeight - overlay().clientHeight;
  const scrollEvent = () => overlay().dispatchEvent(new dom.window.Event("scroll"));
  const close = () => { layer.destroy(); dom.window.close(); };
  return { dom, root, source, layer, overlay, english, translateAll, maximum, addParagraph, flushFrame, frames, scrollEvent, writes, height, close };
}

test("lazy source append retains a deep scroll position, the scroll box, and already translated Text identities", () => {
  const f = fixture();
  try {
    f.translateAll();
    const overlay = f.overlay();
    const texts = [...overlay.querySelectorAll("p")].map(paragraph => paragraph.firstChild as Text);
    overlay.scrollTop = f.maximum() - 80;
    f.scrollEvent();
    const before = overlay.scrollTop;
    assert.ok(before > 4000, "Fixture must start beyond the short Japanese layout's maximum");
    f.addParagraph();
    f.layer.refresh();
    assert.equal(f.overlay(), overlay);
    assert.equal(overlay.scrollTop, before, "Refreshing must not clamp through a short intermediate Japanese clone");
    texts.forEach((text, index) => {
      assert.equal(overlay.querySelectorAll("p")[index].firstChild, text);
      assert.equal(text.data, f.english(index));
    });
    assert.match(f.source.querySelector("p")!.textContent!, /日本語/);
    assert.equal(f.source.querySelector("p")!.textContent!.includes("English"), false);
  } finally { f.close(); }
});

test("repeated lazy append and translation can reach the new bottom without snapping back", () => {
  const f = fixture();
  try {
    f.translateAll();
    const overlay = f.overlay();
    overlay.scrollTop = f.maximum();
    const initial = overlay.scrollTop;
    for (let step = 0; step < 5; step++) {
      f.scrollEvent();
      const before = overlay.scrollTop;
      f.addParagraph();
      f.layer.refresh();
      assert.equal(f.overlay(), overlay);
      assert.equal(overlay.scrollTop, before);
      const last = overlay.querySelectorAll("p").item(overlay.querySelectorAll("p").length - 1);
      f.layer.setTranslation(last.firstChild as Text, f.english(30 + step));
      f.flushFrame();
      assert.equal(overlay.scrollTop, before, "Translation appended below the reading position must not move it");
      overlay.scrollTop = f.maximum();
      assert.ok(overlay.scrollTop > before);
    }
    assert.ok(overlay.scrollTop > initial);
    const last = overlay.querySelectorAll("p").item(34);
    assert.equal(last.getBoundingClientRect().bottom, overlay.getBoundingClientRect().bottom);
  } finally { f.close(); }
});

test("a delayed translation above the viewport retains the same visible paragraph offset", () => {
  const f = fixture();
  try {
    f.translateAll();
    const overlay = f.overlay();
    const paragraphs = [...overlay.querySelectorAll<HTMLElement>("p")];
    const anchor = paragraphs[20];
    overlay.scrollTop = paragraphs.slice(0, 20).reduce((sum, paragraph) => sum + f.height(paragraph), 0) + 8;
    f.scrollEvent();
    const beforeTop = overlay.scrollTop;
    const beforeOffset = anchor.getBoundingClientRect().top - overlay.getBoundingClientRect().top;
    const firstText = paragraphs[0].firstChild as Text;
    const oldText = firstText.data;
    f.layer.setTranslation(firstText, oldText.repeat(2));
    assert.equal(firstText.data, oldText, "Translation should wait for the batched frame");
    f.flushFrame();
    assert.equal(firstText.data, oldText.repeat(2));
    assert.ok(overlay.scrollTop > beforeTop, "Extra height above the reading paragraph must be compensated");
    assert.equal(anchor.getBoundingClientRect().top - overlay.getBoundingClientRect().top, beforeOffset);
  } finally { f.close(); }
});

test("source scroll follows the matching paragraph, and anchor correction does not feed back as user scrolling", () => {
  const f = fixture();
  try {
    f.translateAll();
    const overlay = f.overlay();
    const paragraphs = [...overlay.querySelectorAll<HTMLElement>("p")];
    overlay.scrollTop = paragraphs.slice(0, 20).reduce((sum, paragraph) => sum + f.height(paragraph), 0) + 8;
    f.scrollEvent();
    const nativeParagraphs = [...f.source.querySelectorAll<HTMLElement>("p")];
    assert.equal(f.source.scrollTop, nativeParagraphs.slice(0, 20).reduce((sum, paragraph) => sum + f.height(paragraph), 0) + 8);
    const nativeWrites = f.writes.get(f.source);
    const firstText = paragraphs[0].firstChild as Text;
    f.layer.setTranslation(firstText, firstText.data.repeat(2));
    f.flushFrame();
    f.scrollEvent();
    assert.equal(f.writes.get(f.source), nativeWrites, "Programmatic anchor correction must not ask native rendering to scroll again");
    overlay.scrollTop += 40;
    f.scrollEvent();
    assert.ok(f.writes.get(f.source)! > nativeWrites!, "Subsequent actual reader scrolling must still reach native rendering");
  } finally { f.close(); }
});

test("destroy cancels queued frame translations and a stale result cannot rewrite the detached preview", () => {
  const f = fixture();
  try {
    const text = f.overlay().querySelector("p")!.firstChild as Text;
    const original = text.data;
    f.layer.setTranslation(text, "A translation arriving after OFF");
    assert.equal(f.frames.size, 1);
    f.layer.destroy();
    assert.equal(f.frames.size, 0);
    f.flushFrame();
    assert.equal(text.data, original);
    assert.equal(f.root.querySelector(".clt-native-presentation"), null);
    f.layer.setTranslation(text, "Another stale result");
    f.flushFrame();
    assert.equal(text.data, original);
    assert.equal(f.frames.size, 0);
  } finally { f.close(); }
});
