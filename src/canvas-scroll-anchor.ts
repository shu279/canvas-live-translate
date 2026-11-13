/** Keep the paragraph being read stationary while translated content reflows. */
export interface ScrollSnapshot {
  top: number;
  left: number;
  anchors: Array<{ element: HTMLElement; offset: number }>;
}

const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, pre, table, img, .math-block";
const EPSILON = 0.5;

function realRect(rect: DOMRect): boolean {
  return Number.isFinite(rect.top) && Number.isFinite(rect.bottom) && rect.height > 0 && rect.width > 0;
}

/** Bounding rectangles include Canvas zoom; scrollTop and offsetHeight do not. */
export function scrollScale(container: HTMLElement): number {
  const rect = container.getBoundingClientRect();
  const height = container.offsetHeight || container.clientHeight;
  const width = container.offsetWidth || container.clientWidth;
  const scale = height > 0 && rect.height > 0 ? rect.height / height
    : width > 0 && rect.width > 0 ? rect.width / width : 1;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function captureScrollAnchor(container: HTMLElement): ScrollSnapshot {
  const snapshot: ScrollSnapshot = { top: container.scrollTop, left: container.scrollLeft, anchors: [] };
  const rect = container.getBoundingClientRect();
  if (!realRect(rect)) return snapshot;
  const document = container.ownerDocument;
  const view = document.defaultView;
  const top = Math.max(rect.top, 0);
  const bottom = Math.min(rect.bottom, view?.innerHeight || rect.bottom);
  const left = Math.max(rect.left, 0);
  const right = Math.min(rect.right, view?.innerWidth || rect.right);
  if (bottom <= top || right <= left) return snapshot;
  const candidates = new Map<HTMLElement, DOMRect>();
  const add = (block: HTMLElement | null) => {
    if (!block || block === container || !container.contains(block) || candidates.has(block)) return;
    const bounds = block.getBoundingClientRect();
    if (realRect(bounds) && bounds.bottom > top && bounds.top < bottom) candidates.set(block, bounds);
  };

  // Hit testing finds a small set near the viewport, even in very long notes.
  // closest() prefers a paragraph inside a list item to its tall outer item.
  if (typeof document.elementFromPoint === "function") {
    const height = bottom - top, width = right - left;
    for (const y of [top + Math.min(2, height / 2), top + height * 0.12, top + height * 0.4, top + height * 0.72, bottom - Math.min(2, height / 2)]) {
      for (const x of [left + Math.min(20, width / 4), left + width / 2, right - Math.min(20, width / 4)]) {
        try { add(document.elementFromPoint(x, y)?.closest<HTMLElement>(BLOCK_SELECTOR) ?? null); }
        catch { /* A detached/pop-out document may not support hit testing. */ }
      }
    }
  }
  // Layout-less fixtures return earlier. This scan is needed only if hit
  // testing is unavailable or the visible content is behind another surface.
  if (!candidates.size) {
    for (const block of container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) add(block);
  }
  const deepest = [...candidates.keys()].filter(block =>
    ![...candidates.keys()].some(other => other !== block && block.contains(other)));
  const scale = scrollScale(container);
  deepest.sort((a, b) => {
    const aTop = candidates.get(a)!.top, bTop = candidates.get(b)!.top;
    // A paragraph crossing the top edge is the current reading block.
    return Math.max(aTop, top) - Math.max(bTop, top);
  });
  snapshot.anchors = deepest.slice(0, 3).map(element => ({ element, offset: (candidates.get(element)!.top - rect.top) / scale }));
  return snapshot;
}

function boundedTop(container: HTMLElement, value: number): number {
  if (!Number.isFinite(value)) return container.scrollTop;
  // No dimensions means there is no layout (for example JSDOM); retain the
  // useful saved pixels instead of treating a zero scrollHeight as a clamp.
  const maximum = container.clientHeight > 0 ? Math.max(0, container.scrollHeight - container.clientHeight) : Infinity;
  return Math.min(maximum, Math.max(0, value));
}

export function restoreScrollAnchor(container: HTMLElement, snapshot: ScrollSnapshot): void {
  let target = snapshot.top;
  const rect = container.getBoundingClientRect();
  if (realRect(rect)) {
    const scale = scrollScale(container);
    for (const anchor of snapshot.anchors) {
      if (!container.contains(anchor.element) || !Number.isFinite(anchor.offset)) continue;
      const bounds = anchor.element.getBoundingClientRect();
      if (!realRect(bounds)) continue;
      const delta = (bounds.top - rect.top) / scale - anchor.offset;
      target = container.scrollTop + delta;
      break;
    }
  }
  const top = boundedTop(container, target);
  // Even assigning the same position can interrupt native trackpad momentum.
  if (Math.abs(container.scrollTop - top) >= EPSILON) container.scrollTop = top;
  if (Number.isFinite(snapshot.left) && Math.abs(container.scrollLeft - snapshot.left) >= EPSILON) container.scrollLeft = snapshot.left;
}
