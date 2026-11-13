import { PRESENTATION_SELECTOR } from "./canvas-presentation";

/**
 * Canvas can cache copies of inactive cards outside the attached view. Removing
 * the live overlay alone does not clean those copies. While this Canvas is in
 * its original mode, discard any marked copies that the host later restores.
 * Source text is never inferred from English and no editor/file data is set.
 */
export interface OriginalCanvasView {
  restore(): void;
  destroy(): void;
}

type RecordLike = Record<string, unknown>;
type Method = (this: unknown, ...args: unknown[]) => unknown;
const SOURCE_SELECTOR = ".clt-source-container, .clt-label-source, .clt-text-readonly";
const ARTIFACT_SELECTOR = `${PRESENTATION_SELECTOR}, ${SOURCE_SELECTOR}`;
const PREVIEW_SELECTOR = ".markdown-preview-view, .markdown-embed-content, .markdown-rendered";

function record(value: unknown): RecordLike | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? value as RecordLike : null;
}

function element(value: unknown): HTMLElement | null {
  // Use nodeType, not instanceof, so pop-out windows are supported too.
  return value !== null && typeof value === "object" && (value as Node).nodeType === 1
    ? value as HTMLElement : null;
}

function canvasNodes(value: unknown): RecordLike[] {
  const view = record(value);
  const nodes = (record(view?.canvas) ?? view)?.nodes;
  try {
    const values = record(nodes)?.values;
    const entries = typeof values === "function" ? Array.from((values as Method).call(nodes) as Iterable<unknown>)
      : Array.isArray(nodes) ? nodes : record(nodes) ? Object.values(nodes as RecordLike) : [];
    return entries.map(record).filter((node): node is RecordLike => node !== null);
  } catch { return []; }
}

function nativeScopes(node: RecordLike): HTMLElement[] {
  const child = record(node.child);
  const preview = record(child?.previewMode);
  return [node.nodeEl, node.containerEl, node.contentEl, child?.containerEl, preview?.containerEl]
    .map(element).filter((value): value is HTMLElement => value !== null);
}

function matchesWithin(scope: HTMLElement, selector: string): HTMLElement[] {
  return [...(scope.matches(selector) ? [scope] : []), ...scope.querySelectorAll<HTMLElement>(selector)];
}

function clean(scope: HTMLElement): Set<HTMLElement> {
  const cards = new Set<HTMLElement>();
  for (const artifact of matchesWithin(scope, ARTIFACT_SELECTOR)) {
    const card = artifact.closest<HTMLElement>(".canvas-node");
    if (card) cards.add(card);
    if (artifact.matches(PRESENTATION_SELECTOR)) artifact.remove();
    else artifact.classList.remove("clt-source-container", "clt-label-source", "clt-text-readonly");
  }
  return cards;
}

export function createOriginalCanvasView(root: HTMLElement, canvas?: unknown): OriginalCanvasView {
  let active = true;
  let observing = false;
  const canRestore = () => active && !root.classList.contains("canvas-live-translate-enabled");
  const Observer = root.ownerDocument.defaultView?.MutationObserver;

  function refreshPreviews(nodes: RecordLike[], affected?: Set<HTMLElement>): void {
    const refreshed = new Set<RecordLike>();
    for (const node of nodes) {
      const scopes = nativeScopes(node);
      const editing = () => node.isEditing === true || scopes.some(scope => scope.matches(".is-editing") || scope.closest(".canvas-node.is-editing"));
      if (editing()) continue;
      if (affected && !scopes.some(scope => Array.from(affected).some(card => scope === card || card.contains(scope) || scope.contains(card)))) continue;
      const child = record(node.child);
      const preview = record(child?.previewMode) ?? child;
      if (!preview || refreshed.has(preview) || typeof preview.rerender !== "function") continue;
      if (!scopes.some(scope => scope.matches(PREVIEW_SELECTOR) || scope.querySelector(PREVIEW_SELECTOR))) continue;
      refreshed.add(preview);
      const container = element(preview.containerEl);
      const scroll = container?.matches(PREVIEW_SELECTOR) ? container
        : container?.querySelector<HTMLElement>(PREVIEW_SELECTOR)
          ?? scopes.flatMap(scope => matchesWithin(scope, PREVIEW_SELECTOR)).find(item => !item.closest(PRESENTATION_SELECTOR));
      const top = scroll?.scrollTop ?? 0, left = scroll?.scrollLeft ?? 0;
      let position: unknown;
      try {
        if (typeof preview.getScroll === "function") position = (preview.getScroll as Method).call(preview);
      } catch { /* A closed preview may no longer expose its logical position. */ }
      const restoreScroll = () => {
        if (!canRestore() || editing()) return;
        try {
          if (typeof position === "number" && Number.isFinite(position) && typeof preview.applyScroll === "function") {
            (preview.applyScroll as Method).call(preview, position);
          } else if (scroll) scroll.scrollTop = top;
          if (scroll) scroll.scrollLeft = left;
        } catch { /* A host view may have been disposed during rendering. */ }
      };
      try {
        // MarkdownPreviewView.rerender(true) redraws from its current source;
        // unlike showPreview/startEditing it does not change the card's mode.
        const result = (preview.rerender as Method).call(preview, true);
        restoreScroll();
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          void Promise.resolve(result).then(restoreScroll, () => {});
        }
      } catch { /* Capability fallback: disposable-layer cleanup still works. */ }
    }
  }

  const observer = Observer ? new Observer(records => {
    if (!canRestore()) return;
    const affected = new Set<HTMLElement>();
    let changed = false;
    for (const mutation of records) {
      for (const added of mutation.addedNodes) {
        const scope = element(added);
        if (!scope || (!scope.matches(ARTIFACT_SELECTOR) && !scope.querySelector(ARTIFACT_SELECTOR))) continue;
        changed = true;
        for (const card of clean(scope)) affected.add(card);
      }
    }
    if (changed) refreshPreviews(canvasNodes(canvas), affected);
  }) : null;

  function restore(): void {
    if (!canRestore()) return;
    const nodes = canvasNodes(canvas);
    const scopes = new Set([root, ...nodes.flatMap(nativeScopes)]);
    for (const scope of scopes) clean(scope);
    if (observer && !observing) {
      // Detached native caches are cleaned above and again when reinserted.
      // Observe only the view root so deleted cards are not retained forever.
      observer.observe(root, { childList: true, subtree: true });
      observing = true;
    }
    refreshPreviews(nodes);
  }

  restore();
  return { restore, destroy() { active = false; observer?.disconnect(); } };
}
