import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { extractContext, findTranslatableNodes } from "../src/canvas-dom.ts";

function createFixture(markup: string) {
  const dom = new JSDOM(`<main id="canvas">${markup}</main>`);
  Object.assign(globalThis, { NodeFilter: dom.window.NodeFilter });
  return { dom, canvas: dom.window.document.getElementById("canvas")! };
}

test("translates rendered text and embedded Markdown cards while protecting code and math", () => {
  const { canvas } = createFixture(`
    <div class="canvas-node">
      <div class="markdown-rendered"><p>問題は長期記憶です。</p><pre><code>数式は編集しない</code></pre><span class="katex">翻訳禁止</span></div>
    </div>
    <div class="canvas-node">
      <div class="markdown-embed-content"><p>アイデアはPrototypeです。</p><img alt="日本語の図" src="x.png"></div>
    </div>
    <div class="canvas-node-label">研究グループ</div>
    <div class="canvas-edge-label">次の処理</div>
  `);
  const result = findTranslatableNodes(canvas);
  assert.deepEqual(result.map(node => node.data.trim()), [
    "問題は長期記憶です。", "アイデアはPrototypeです。", "研究グループ", "次の処理"
  ]);
});

test("never changes text in Canvas editors or contenteditable elements", () => {
  const { canvas } = createFixture(`
    <div class="canvas-node is-editing"><div class="markdown-rendered">変更中の原文</div></div>
    <div class="canvas-node"><div class="markdown-rendered">
      <div contenteditable="true">入力欄の原文</div>
      <div class="cm-editor"><div class="cm-content">エディターの原文</div></div>
      <p>読み取り専用の文章</p>
    </div></div>
  `);
  assert.deepEqual(findTranslatableNodes(canvas).map(node => node.data.trim()), ["読み取り専用の文章"]);
});

test("context can use tracked original fragments after a neighbor was translated", () => {
  const { canvas } = createFixture(`
    <div class="canvas-node"><div class="markdown-rendered">
      <p>この手法は <strong>重要</strong> です。</p>
    </div></div>
  `);
  const [first, second, third] = findTranslatableNodes(canvas);
  first.data = "This method is ";
  assert.equal(extractContext(second, node => node === first ? "この手法は " : node.data), "この手法は 重要 です。");
  assert.equal(third.data.trim(), "です。");
});
