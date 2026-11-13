import { containsJapanese, SKIP_SELECTOR, splitWhitespace } from "./translation-core";
import { PRESENTATION_SELECTOR } from "./canvas-presentation";

/** Only rendered Canvas content, never the underlying Markdown editor. */
const CONTENT_SELECTOR = [
  ".canvas-node .markdown-rendered",
  ".canvas-node .markdown-embed-content",
  ".canvas-node-label",
  ".canvas-edge-label"
].join(", ");

const CONTEXT_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, figcaption";

export function isEditableOrProtected(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent) return true;
  // A native node may still have is-editing briefly while another plugin's
  // handler runs. Our inert presentation must remain English in that case.
  const presentation = parent.closest(PRESENTATION_SELECTOR);
  if (presentation) {
    let current: Element | null = parent;
    while (current && current !== presentation) {
      if (current.matches(SKIP_SELECTOR)) return true;
      current = current.parentElement;
    }
    return false;
  }
  return Boolean(parent.closest(SKIP_SELECTOR));
}

export function findTranslatableNodes(root: HTMLElement, presentationOnly = false): Text[] {
  const found: Text[] = [];
  const seen = new Set<Text>();

  for (const container of root.querySelectorAll<HTMLElement>(presentationOnly ? PRESENTATION_SELECTOR : CONTENT_SELECTOR)) {
    if (!container.closest(PRESENTATION_SELECTOR) && container.closest(".is-editing, .markdown-source-view, [contenteditable='true']")) continue;
    const walker = container.ownerDocument.createTreeWalker(container, 4 /* SHOW_TEXT */);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!seen.has(node) && !isEditableOrProtected(node) && containsJapanese(node.data)) {
        found.push(node);
        seen.add(node);
      }
    }
  }

  return found;
}

export function extractContext(node: Text, originalText: (node: Text) => string): string {
  const parent = node.parentElement;
  const block = parent?.closest(CONTEXT_SELECTOR) ?? parent;
  if (!block) return splitWhitespace(node.data).core;

  const walker = block.ownerDocument.createTreeWalker(block, 4 /* SHOW_TEXT */);
  let text = "";
  while (walker.nextNode() && text.length < 900) {
    const child = walker.currentNode as Text;
    text += originalText(child);
  }
  const normalized = text.replace(/\s+/gu, " ").trim();
  const core = splitWhitespace(originalText(node)).core;
  // The most common case is a whole paragraph. Do not send it twice.
  if (normalized === core) return "";
  const index = normalized.indexOf(core);
  const start = index < 0 ? 0 : Math.max(0, index - 120);
  return normalized.slice(start, start + Math.max(280, Math.min(core.length + 100, 600)));
}

/** Priority only, not an authorization filter: all loaded card content can queue. */
export function translationPriority(node: Text, root: HTMLElement): number {
  const parent = node.parentElement;
  if (!parent) return 0;
  const rect = parent.getBoundingClientRect();
  const viewport = root.getBoundingClientRect();
  const card = parent.closest<HTMLElement>(".canvas-node");
  const cardRect = card?.getBoundingClientRect();
  const intersects = (box: DOMRect, boundary: DOMRect) => box.bottom > boundary.top && box.top < boundary.bottom &&
    box.right > boundary.left && box.left < boundary.right;
  if (intersects(rect, viewport) && (!cardRect || intersects(rect, cardRect))) return 100;
  if (cardRect && intersects(cardRect, viewport)) return 20;
  return 0;
}
