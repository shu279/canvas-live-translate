import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { captureScrollAnchor, restoreScrollAnchor, scrollScale } from "../src/canvas-scroll-anchor.ts";

function fixture(scale = 1) {
  const dom = new JSDOM(`<main><p id="a">First paragraph</p><p id="b">Second paragraph</p><p id="c">Third paragraph</p></main>`, { pretendToBeVisual: true });
  const container = dom.window.document.querySelector<HTMLElement>("main")!;
  const positions: Record<string, number> = { a: 100, b: 160, c: 220 };
  Object.defineProperties(container, {
    offsetHeight: { value: 200 }, clientHeight: { value: 200 },
    offsetWidth: { value: 400 }, clientWidth: { value: 400 },
    scrollHeight: { configurable: true, value: 2000 }
  });
  container.getBoundingClientRect = () => new dom.window.DOMRect(30, 40, 400 * scale, 200 * scale);
  for (const block of container.querySelectorAll<HTMLElement>("p")) {
    block.getBoundingClientRect = () => new dom.window.DOMRect(30, 40 + (positions[block.id] - container.scrollTop) * scale, 380 * scale, 50 * scale);
  }
  container.scrollTop = 110;
  container.scrollLeft = 12;
  return { dom, container, positions };
}

for (const scale of [0.5, 2]) {
  test(`growth above the viewport preserves the reading paragraph at Canvas scale ${scale}`, () => {
    const f = fixture(scale);
    assert.equal(scrollScale(f.container), scale);
    const snapshot = captureScrollAnchor(f.container);
    assert.deepEqual(snapshot.anchors.map(anchor => anchor.element.id), ["a", "b", "c"]);
    assert.equal(snapshot.anchors[0].offset, -10);
    for (const key of Object.keys(f.positions)) f.positions[key] += 80;
    f.container.scrollLeft = 99;
    restoreScrollAnchor(f.container, snapshot);
    assert.equal(f.container.scrollTop, 190);
    assert.equal(f.container.scrollLeft, 12);
    assert.equal((snapshot.anchors[0].element.getBoundingClientRect().top - f.container.getBoundingClientRect().top) / scale, -10);
    f.dom.window.close();
  });
}

test("shrinking translated content above the viewport keeps the same paragraph offset", () => {
  const f = fixture();
  const snapshot = captureScrollAnchor(f.container);
  for (const key of Object.keys(f.positions)) f.positions[key] -= 60;
  restoreScrollAnchor(f.container, snapshot);
  assert.equal(f.container.scrollTop, 50);
  f.dom.window.close();
});

test("a removed first anchor uses the next surviving paragraph", () => {
  const f = fixture();
  const snapshot = captureScrollAnchor(f.container);
  snapshot.anchors[0].element.remove();
  f.positions.b += 45;
  f.positions.c += 45;
  restoreScrollAnchor(f.container, snapshot);
  assert.equal(f.container.scrollTop, 155);
  f.dom.window.close();
});

test("missing anchors fall back to saved pixels and clamp to available content", () => {
  const f = fixture();
  const snapshot = captureScrollAnchor(f.container);
  f.container.replaceChildren();
  f.container.scrollTop = 0;
  restoreScrollAnchor(f.container, snapshot);
  assert.equal(f.container.scrollTop, 110);
  Object.defineProperty(f.container, "scrollHeight", { configurable: true, value: 250 });
  restoreScrollAnchor(f.container, snapshot);
  assert.equal(f.container.scrollTop, 50);
  f.dom.window.close();
});

test("very large reflow deltas are bounded by native scroll limits", () => {
  const f = fixture();
  const snapshot = captureScrollAnchor(f.container);
  f.positions.a += 10000;
  restoreScrollAnchor(f.container, snapshot);
  assert.equal(f.container.scrollTop, 1800);
  f.dom.window.close();
});

test("zero-layout documents use saved scroll pixels without fabricated anchors", () => {
  const dom = new JSDOM("<main><p>Layout-less text</p></main>");
  const container = dom.window.document.querySelector<HTMLElement>("main")!;
  container.scrollTop = 140.25;
  container.scrollLeft = 12.5;
  const snapshot = captureScrollAnchor(container);
  assert.equal(scrollScale(container), 1);
  assert.deepEqual(snapshot.anchors, []);
  container.scrollTop = 0;
  container.scrollLeft = 0;
  restoreScrollAnchor(container, snapshot);
  assert.equal(container.scrollTop, 140.25);
  assert.equal(container.scrollLeft, 12.5);
  dom.window.close();
});

test("unchanged and subpixel positions do not write scrollTop or scrollLeft", () => {
  const f = fixture();
  let top = 110, left = 12, writes = 0;
  Object.defineProperties(f.container, {
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { writes++; top = value; } },
    scrollLeft: { configurable: true, get: () => left, set: (value: number) => { writes++; left = value; } }
  });
  const snapshot = captureScrollAnchor(f.container);
  restoreScrollAnchor(f.container, snapshot);
  f.positions.a += 0.25;
  restoreScrollAnchor(f.container, snapshot);
  assert.equal(writes, 0);
  assert.equal(top, 110);
  assert.equal(left, 12);
  f.dom.window.close();
});

test("hit testing prefers the deepest visible paragraph and avoids scanning the whole note", () => {
  const f = fixture();
  const paragraph = f.container.querySelector<HTMLElement>("#a")!;
  const item = f.dom.window.document.createElement("li");
  paragraph.before(item);
  item.appendChild(paragraph);
  const span = f.dom.window.document.createElement("span");
  paragraph.appendChild(span);
  f.dom.window.document.elementFromPoint = () => span;
  f.container.querySelectorAll = () => { throw new Error("The hit-test path must not scan a long note"); };
  const snapshot = captureScrollAnchor(f.container);
  assert.equal(snapshot.anchors.length, 1);
  assert.equal(snapshot.anchors[0].element, paragraph);
  f.dom.window.close();
});
