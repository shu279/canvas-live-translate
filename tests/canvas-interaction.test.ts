import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { createReadOnlyCanvasController, findCardScrollContainer } from "../src/canvas-interaction.ts";

function fixture() {
  const dom = new JSDOM(`<!doctype html><main id="root"><div class="canvas-wrapper">
    <div class="canvas-node is-selected"><div class="canvas-node-content">
      <div class="markdown-preview-view markdown-rendered native-source"><p>日本語の原文</p></div>
      <div class="canvas-node-content-blocker"></div>
      <div class="clt-native-presentation"><div class="markdown-preview-view markdown-rendered">
        <p class="translated">Translated English research notes</p>
        <input type="checkbox" class="task-list-item-checkbox">
        <a href="https://example.org" class="external-link">Paper</a>
      </div></div>
    </div></div>
    <div class="canvas-menu"><button aria-label="Edit"><svg class="lucide-square-pen"></svg></button></div>
  </div></main>`, { pretendToBeVisual: true });
  const document = dom.window.document;
  const root = document.getElementById("root")!;
  const card = root.querySelector<HTMLElement>(".canvas-node")!;
  const presentation = root.querySelector<HTMLElement>(".clt-native-presentation")!;
  const text = presentation.querySelector<HTMLElement>("p")!;
  const source = root.querySelector<HTMLElement>(".native-source")!;
  Object.defineProperties(presentation, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1000 }
  });
  return { dom, root, card, presentation, text, source };
}

test("clone clicks cannot enter native editing and English stays in place", () => {
  const f = fixture();
  let editingCalls = 0;
  const node = { nodeEl: f.card, isEditing: false, startEditing() { editingCalls++; this.isEditing = true; } };
  const original = node.startEditing;
  const controller = createReadOnlyCanvasController(f.root, { nodes: new Map([["n", node]]) });
  f.card.addEventListener("click", () => node.startEditing());
  f.text.dispatchEvent(new f.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  node.startEditing(); // Also guard a one-click plugin calling the private hook.
  assert.equal(editingCalls, 0);
  assert.equal(node.isEditing, false);
  assert.equal(f.text.textContent, "Translated English research notes");
  assert.equal(f.source.textContent, "日本語の原文");
  assert.equal(f.presentation.getAttribute("aria-readonly"), "true");
  assert.equal(f.dom.window.document.activeElement, f.presentation);
  controller.destroy();
  assert.equal(node.startEditing, original);
  node.startEditing();
  assert.equal(editingCalls, 1);
  f.dom.window.close();
});

test("existing editing node returns to preview without changing its source", () => {
  const f = fixture();
  let previewCalls = 0;
  f.card.classList.add("is-editing");
  const node = {
    nodeEl: f.card, isEditing: true, startEditing() {},
    child: { showPreview() { previewCalls++; } }
  };
  const controller = createReadOnlyCanvasController(f.root, { canvas: { nodes: [node] } });
  assert.equal(previewCalls, 1);
  assert.equal(node.isEditing, false);
  assert.equal(f.card.classList.contains("is-editing"), false);
  assert.equal(f.source.textContent, "日本語の原文");
  controller.refresh();
  assert.equal(previewCalls, 1);
  controller.destroy();
  f.dom.window.close();
});

test("vertical trackpad wheel keeps native scrolling without rewriting scrollTop or panning Canvas", () => {
  const f = fixture();
  let changes = 0;
  let pans = 0;
  const controller = createReadOnlyCanvasController(f.root, undefined, () => { changes++; });
  f.card.addEventListener("wheel", () => { pans++; });
  assert.equal(findCardScrollContainer(f.text), f.presentation);
  let position = 140.25;
  let scriptWrites = 0;
  Object.defineProperty(f.presentation, "scrollTop", {
    configurable: true,
    get: () => position,
    set: (value: number) => { scriptWrites++; position = value; }
  });
  for (const deltaY of [0.75, 1.25, 12.5, 125]) {
    const wheel = new f.dom.window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
    f.text.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, false, "The browser must retain the scroll default action");
  }
  // JSDOM does not perform the browser's wheel default action. The contract is
  // to leave it uncancelled, with no competing scripted scrollTop writes.
  assert.equal(scriptWrites, 0);
  assert.equal(f.presentation.scrollTop, 140.25);
  assert.equal(f.source.scrollTop, 0);
  assert.equal(pans, 0);
  assert.equal(changes, 0, "Scanning follows real scroll events, not each wheel input");
  position = 800;
  const atEnd = new f.dom.window.WheelEvent("wheel", { deltaY: 500, bubbles: true, cancelable: true });
  f.text.dispatchEvent(atEnd);
  assert.equal(f.presentation.scrollTop, 800);
  assert.equal(atEnd.defaultPrevented, false);
  assert.equal(pans, 0, "Canvas cannot pan when a scrollable overlay is at its end");
  assert.equal(scriptWrites, 0);
  controller.destroy();
  f.dom.window.close();
});

test("a native preview without an overlay retains temporary manual scroll fallback", () => {
  const f = fixture();
  f.presentation.remove();
  Object.defineProperties(f.source, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1000 }
  });
  let changes = 0;
  let pans = 0;
  const controller = createReadOnlyCanvasController(f.root, undefined, () => { changes++; });
  f.card.addEventListener("wheel", () => { pans++; });
  const wheel = new f.dom.window.WheelEvent("wheel", { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true });
  f.source.querySelector("p")!.dispatchEvent(wheel);
  assert.equal(findCardScrollContainer(f.source), f.source);
  assert.equal(f.source.scrollTop, 48);
  assert.equal(wheel.defaultPrevented, true);
  assert.equal(pans, 0);
  assert.equal(changes, 1);
  controller.destroy();
  f.dom.window.close();
});

test("pinch zoom, shift-horizontal pan, horizontal trackpad, and Space-wheel pass through", () => {
  const f = fixture();
  const controller = createReadOnlyCanvasController(f.root);
  let pans = 0;
  f.card.addEventListener("wheel", () => { pans++; });
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 200 }]) {
    const wheel = new f.dom.window.WheelEvent("wheel", { deltaY: 50, bubbles: true, cancelable: true, ...modifiers });
    f.text.dispatchEvent(wheel);
    assert.equal(wheel.defaultPrevented, false);
    assert.equal(f.presentation.scrollTop, 0);
  }
  assert.equal(pans, 4);
  f.presentation.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true }));
  const zoom = new f.dom.window.WheelEvent("wheel", { deltaY: 50, bubbles: true, cancelable: true });
  f.text.dispatchEvent(zoom);
  assert.equal(zoom.defaultPrevented, false);
  assert.equal(pans, 5);
  f.dom.window.document.dispatchEvent(new f.dom.window.KeyboardEvent("keyup", { key: " ", code: "Space", bubbles: true }));
  const scroll = new f.dom.window.WheelEvent("wheel", { deltaY: 50, bubbles: true, cancelable: true });
  f.text.dispatchEvent(scroll);
  assert.equal(scroll.defaultPrevented, false);
  assert.equal(pans, 5, "A normal wheel after releasing Space returns to native card scrolling");
  assert.equal(f.presentation.scrollTop, 0);
  controller.destroy();
  f.dom.window.close();
});

test("read-only blocks checkbox changes, edit toolbar, paste and typing, but keeps copy and keyboard scrolling", () => {
  const f = fixture();
  const controller = createReadOnlyCanvasController(f.root);
  const checkbox = f.presentation.querySelector<HTMLInputElement>("input")!;
  checkbox.click();
  assert.equal(checkbox.checked, false);
  const edit = new f.dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  f.root.querySelector("button")!.dispatchEvent(edit);
  assert.equal(edit.defaultPrevented, true);
  for (const name of ["beforeinput", "paste", "cut", "drop", "compositionstart"]) {
    const event = new f.dom.window.Event(name, { bubbles: true, cancelable: true });
    f.presentation.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, name);
  }
  for (const key of ["a", "Enter", "F2", "Backspace", "Delete"]) {
    const event = new f.dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    f.presentation.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, key);
  }
  const copy = new f.dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
  f.presentation.dispatchEvent(copy);
  assert.equal(copy.defaultPrevented, false);
  const down = new f.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
  f.presentation.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  assert.equal(f.presentation.scrollTop, 40);
  const bottom = new f.dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
  f.presentation.dispatchEvent(bottom);
  assert.equal(f.presentation.scrollTop, 800);
  controller.destroy();
  f.dom.window.close();
});

test("native links and webpage cards are not treated as editable note inputs", () => {
  const f = fixture();
  const webCard = f.dom.window.document.createElement("div");
  webCard.className = "canvas-node";
  webCard.innerHTML = "<webview></webview>";
  f.root.append(webCard);
  let activations = 0;
  const webNode = { nodeEl: webCard, startEditing() { activations++; } };
  const controller = createReadOnlyCanvasController(f.root, { nodes: [webNode] });
  const linkEvent = new f.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  f.presentation.querySelector("a")!.dispatchEvent(linkEvent);
  assert.equal(linkEvent.defaultPrevented, false);
  const webEvent = new f.dom.window.Event("beforeinput", { bubbles: true, cancelable: true });
  webCard.querySelector("webview")!.dispatchEvent(webEvent);
  assert.equal(webEvent.defaultPrevented, false);
  assert.equal(webCard.classList.contains("clt-text-readonly"), false);
  webNode.startEditing();
  assert.equal(activations, 1, "webview activation is not a Markdown editing operation");
  controller.destroy();
  f.dom.window.close();
});

test("a Markdown note containing an iframe still has its text editing guarded", () => {
  const f = fixture();
  f.source.append(f.dom.window.document.createElement("iframe"));
  let calls = 0;
  const node = { nodeEl: f.card, startEditing() { calls++; } };
  const controller = createReadOnlyCanvasController(f.root, { nodes: [node] });
  node.startEditing();
  assert.equal(calls, 0);
  assert.equal(findCardScrollContainer(f.text), f.presentation);
  controller.destroy();
  f.dom.window.close();
});

test("destroy restores attributes/hooks and does not overwrite another plugin's later wrapper", () => {
  const f = fixture();
  f.presentation.setAttribute("tabindex", "-1");
  const editor = f.dom.window.document.createElement("div");
  editor.className = "cm-content";
  editor.setAttribute("contenteditable", "true");
  f.card.append(editor);
  let calls = 0;
  const node = { nodeEl: f.card, startEditing() { calls++; } };
  const controller = createReadOnlyCanvasController(f.root, { nodes: new Map([["a", node]]) });
  const protectedMethod = node.startEditing;
  const laterWrapper = () => protectedMethod.call(node);
  node.startEditing = laterWrapper;
  assert.equal(editor.getAttribute("contenteditable"), "false");
  controller.destroy();
  controller.destroy();
  assert.equal(node.startEditing, laterWrapper);
  node.startEditing();
  assert.equal(calls, 1);
  assert.equal(editor.getAttribute("contenteditable"), "true");
  assert.equal(f.presentation.getAttribute("tabindex"), "-1");
  assert.equal(f.presentation.hasAttribute("aria-readonly"), false);
  assert.equal(f.card.classList.contains("clt-text-readonly"), false);
  assert.equal(f.root.classList.contains("canvas-live-translate-readonly"), false);
  const wheel = new f.dom.window.WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
  f.text.dispatchEvent(wheel);
  assert.equal(wheel.defaultPrevented, false);
  f.dom.window.close();
});

test("refresh picks up newly rendered nodes without touching text or data", () => {
  const f = fixture();
  let calls = 0;
  const nodes = new Map();
  const controller = createReadOnlyCanvasController(f.root, { nodes });
  const node = { nodeEl: f.card, startEditing() { calls++; }, text: "保存した日本語" };
  nodes.set("later", node);
  controller.refresh();
  node.startEditing();
  assert.equal(calls, 0);
  assert.equal(node.text, "保存した日本語");
  controller.destroy();
  node.startEditing();
  assert.equal(calls, 1);
  f.dom.window.close();
});

test("inherited startEditing is restored by deleting the instance patch", () => {
  const f = fixture();
  class NodeStub {
    nodeEl = f.card;
    calls = 0;
    startEditing() { this.calls++; }
  }
  const node = new NodeStub();
  const controller = createReadOnlyCanvasController(f.root, { nodes: [node] });
  assert.equal(Object.hasOwn(node, "startEditing"), true);
  controller.destroy();
  assert.equal(Object.hasOwn(node, "startEditing"), false);
  node.startEditing();
  assert.equal(node.calls, 1);
  f.dom.window.close();
});

test("presentation CSS hides native originals and direct-text labels but keeps translation visible", () => {
  const f = fixture();
  const style = f.dom.window.document.createElement("style");
  style.textContent = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  f.dom.window.document.head.append(style);
  f.root.classList.add("canvas-live-translate-enabled");
  f.card.querySelector(".canvas-node-content")!.classList.add("clt-source-container");
  const label = f.dom.window.document.createElement("span");
  label.className = "canvas-node-label clt-label-source";
  label.append("原文ラベル");
  const translatedLabel = f.dom.window.document.createElement("span");
  translatedLabel.className = "clt-label-presentation";
  translatedLabel.textContent = "Translated label";
  label.append(translatedLabel);
  f.root.append(label);
  const controller = createReadOnlyCanvasController(f.root);
  const computed = (element: Element) => f.dom.window.getComputedStyle(element);
  assert.equal(computed(f.source).visibility, "hidden");
  assert.equal(computed(f.source.querySelector("p")!).visibility, "hidden");
  assert.equal(computed(f.presentation).visibility, "visible");
  assert.equal(computed(f.presentation).position, "absolute");
  assert.equal(computed(f.presentation).overflowY, "auto");
  assert.equal(computed(f.presentation).getPropertyValue("overscroll-behavior"), "contain");
  assert.equal(computed(f.presentation).getPropertyValue("overflow-anchor"), "none");
  assert.equal(computed(f.presentation).scrollBehavior, "auto");
  assert.equal(computed(label).visibility, "hidden");
  assert.equal(computed(translatedLabel).visibility, "visible");
  assert.equal(computed(f.card.querySelector(".canvas-node-content-blocker")!).display, "none");
  assert.equal(findCardScrollContainer(f.source), f.presentation, "hidden source never becomes the scroll owner");
  controller.destroy();
  f.root.classList.remove("canvas-live-translate-enabled");
  assert.equal(computed(f.source).visibility, "visible");
  f.dom.window.close();
});
