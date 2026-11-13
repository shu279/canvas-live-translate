import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { PresentationSync } from "../src/presentation-sync.ts";

function fixture(markup = "<div class='markdown-preview-view'><p>最初の文章</p><p>次の文章</p></div>") {
  const dom = new JSDOM(`<main><section id="source">${markup}</section><section id="copy"></section></main>`);
  const source = dom.window.document.querySelector<HTMLElement>("#source")!;
  const target = dom.window.document.querySelector<HTMLElement>("#copy")!;
  const sync = new PresentationSync(target);
  const prepare = (node: ChildNode): Node | null => {
    if (node.nodeType === 1 && (node as Element).matches("script, button, .cm-editor")) return null;
    const clone = node.cloneNode(false);
    if (clone.nodeType === 1) {
      for (const attr of Array.from((clone as Element).attributes)) {
        if (/^on/i.test(attr.name) || attr.name === "contenteditable") (clone as Element).removeAttribute(attr.name);
      }
    }
    return clone;
  };
  const refresh = () => sync.sync(Array.from(source.childNodes), prepare);
  return { dom, source, target, sync, refresh };
}

test("appending new source paragraphs retains existing translated Text and element identities", () => {
  const f = fixture();
  f.refresh();
  const wrapper = f.target.firstChild!;
  const paragraphs = [...f.target.querySelectorAll("p")];
  const text = paragraphs[0].firstChild!;
  text.nodeValue = "A much longer English translation that must keep its layout.";
  const added = f.source.ownerDocument.createElement("p");
  added.textContent = "新しく読み込んだ文章";
  f.source.firstChild!.appendChild(added);
  f.refresh();
  assert.equal(f.target.firstChild, wrapper);
  assert.equal(f.target.querySelector("p"), paragraphs[0]);
  assert.equal(paragraphs[0].firstChild, text);
  assert.equal(text.nodeValue, "A much longer English translation that must keep its layout.");
  assert.equal(f.target.querySelectorAll("p")[2].textContent, "新しく読み込んだ文章");
  assert.equal(f.sync.sourceFor(text), f.source.querySelector("p")!.firstChild);
  assert.equal(f.source.querySelector("p")!.textContent, "最初の文章");
});

test("equivalent native subtree redraw preserves translations and maps copies to the new native nodes", () => {
  const f = fixture();
  f.refresh();
  const wrapper = f.target.firstChild!;
  const translated = f.target.querySelector("p")!.firstChild!;
  translated.nodeValue = "The original paragraph remains translated.";
  const replacement = f.source.firstChild!.cloneNode(true) as HTMLElement;
  replacement.classList.add("host-layout-updated");
  replacement.style.minHeight = "1800px";
  f.source.replaceChildren(replacement);
  f.refresh();
  assert.equal(f.target.firstChild, wrapper);
  assert.equal(f.target.querySelector("p")!.firstChild, translated);
  assert.equal(translated.nodeValue, "The original paragraph remains translated.");
  assert.equal(f.sync.sourceFor(translated), replacement.querySelector("p")!.firstChild);
  assert.equal(f.sync.sourceFor(wrapper), replacement);
  assert.ok((wrapper as HTMLElement).classList.contains("host-layout-updated"));
  assert.equal((wrapper as HTMLElement).style.minHeight, "1800px");
});

test("an actual source edit resets only the edited Text while unchanged neighbours stay translated", () => {
  const f = fixture();
  f.refresh();
  const first = f.target.querySelectorAll("p")[0].firstChild!;
  const second = f.target.querySelectorAll("p")[1].firstChild!;
  first.nodeValue = "Old first translation";
  second.nodeValue = "Keep the second translation";
  f.source.querySelector("p")!.firstChild!.nodeValue = "編集された文章";
  f.refresh();
  assert.equal(f.target.querySelector("p")!.firstChild, first);
  assert.equal(first.nodeValue, "編集された文章");
  assert.equal(f.target.querySelectorAll("p")[1].firstChild, second);
  assert.equal(second.nodeValue, "Keep the second translation");
  assert.equal(f.source.querySelectorAll("p")[1].textContent, "次の文章");
});

test("newly inserted paragraphs cannot consume unchanged translated siblings during a full redraw", () => {
  const f = fixture();
  f.refresh();
  const first = f.target.querySelectorAll("p")[0];
  const second = f.target.querySelectorAll("p")[1];
  first.firstChild!.nodeValue = "First translation";
  second.firstChild!.nodeValue = "Second translation";
  f.source.innerHTML = "<div class='markdown-preview-view'><p>追加の冒頭</p><p>最初の文章</p><p>次の文章</p></div>";
  f.refresh();
  const paragraphs = [...f.target.querySelectorAll("p")];
  assert.equal(paragraphs[1], first);
  assert.equal(paragraphs[2], second);
  assert.deepEqual(paragraphs.map(p => p.textContent), ["追加の冒頭", "First translation", "Second translation"]);
});

test("reordering and removing source nodes keeps surviving translated nodes and removes obsolete mappings", () => {
  const f = fixture("<div><p>甲</p><p>乙</p><p>丙</p></div>");
  f.refresh();
  const originals = [...f.source.querySelectorAll("p")];
  const copies = [...f.target.querySelectorAll("p")];
  copies.forEach((copy, index) => { copy.firstChild!.nodeValue = `Translated ${index}`; });
  originals[2].parentElement!.prepend(originals[2]);
  originals[1].remove();
  f.refresh();
  assert.deepEqual([...f.target.querySelectorAll("p")], [copies[2], copies[0]]);
  assert.deepEqual([...f.target.querySelectorAll("p")].map(p => p.textContent), ["Translated 2", "Translated 0"]);
  assert.equal(f.sync.sourceFor(copies[1]), undefined);
  assert.equal(f.sync.sourceFor(copies[2]), originals[2]);
});

test("moving a native paragraph across parents preserves its translated identity", () => {
  const f = fixture("<div data-source='a'><p>移動する文章</p></div><div data-source='b'><p>別の文章</p></div>");
  f.refresh();
  const native = f.source.querySelector("p")!;
  const copy = f.target.querySelector("p")!;
  copy.firstChild!.nodeValue = "Move this translated paragraph.";
  f.source.querySelector("[data-source='b']")!.appendChild(native);
  f.refresh();
  assert.equal(f.target.querySelector("[data-source='b']")!.lastChild, copy);
  assert.equal(copy.textContent, "Move this translated paragraph.");
  assert.equal(f.sync.sourceFor(copy), native);
});

test("unchanged refresh performs no DOM writes and preserves text selection", () => {
  const f = fixture();
  f.refresh();
  const text = f.target.querySelector("p")!.firstChild!;
  text.nodeValue = "Translated paragraph";
  const selection = f.dom.window.getSelection()!;
  const range = f.source.ownerDocument.createRange();
  range.setStart(text, 2); range.setEnd(text, 7); selection.addRange(range);
  const observer = new f.dom.window.MutationObserver(() => {});
  observer.observe(f.target, { childList: true, subtree: true, attributes: true, characterData: true });
  f.refresh();
  assert.deepEqual(observer.takeRecords(), []);
  assert.equal(selection.anchorNode, text);
  assert.equal(selection.anchorOffset, 2);
  assert.equal(selection.focusOffset, 7);
  observer.disconnect();
});

test("sanitization exclusions keep source mapping exact and never mutate the source", () => {
  const f = fixture("<div><script>bad()</script><p onclick='bad()' contenteditable='true'>原文<strong>強調</strong></p><button>除外</button><p>末尾</p></div>");
  const before = f.source.innerHTML;
  f.refresh();
  const native = f.source.querySelector("p")!;
  const copy = f.target.querySelector("p")!;
  assert.equal(f.target.querySelector("script,button,[onclick],[contenteditable]"), null);
  assert.equal(f.sync.sourceFor(copy), native);
  assert.equal(f.sync.sourceFor(copy.querySelector("strong")!.firstChild!), native.querySelector("strong")!.firstChild);
  assert.equal(f.source.innerHTML, before);
});

test("replacement wrappers are filled before old content is removed", () => {
  const f = fixture("<div><p>長い既存本文</p></div>");
  f.refresh();
  const old = f.target.firstChild!;
  const remove = f.target.removeChild.bind(f.target);
  let checked = false;
  f.target.removeChild = ((node: Node) => {
    if (node === old) {
      assert.equal(f.target.querySelector("article p")!.textContent, "新しい本文");
      checked = true;
    }
    return remove(node);
  }) as typeof f.target.removeChild;
  f.source.innerHTML = "<article><p>新しい本文</p></article>";
  f.refresh();
  assert.equal(checked, true);
  assert.equal(f.target.textContent, "新しい本文");
});
