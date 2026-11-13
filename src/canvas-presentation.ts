import { PresentationSync } from "./presentation-sync";
import { captureScrollAnchor, restoreScrollAnchor, scrollScale, ScrollSnapshot } from "./canvas-scroll-anchor";

/**
 * A disposable reading layer. Native preview/editor DOM is NEVER translated.
 * Removing this layer (including while detached) therefore restores Japanese
 * without having to guess which English strings used to be Japanese.
 */
export const PRESENTATION_SELECTOR = ".clt-native-presentation, .clt-label-presentation";
const PREVIEW_LAYOUT_SELECTOR = ".markdown-preview-view, .markdown-rendered, .markdown-embed, .markdown-embed-content, .markdown-preview-sizer";
const PADDING_PROPERTIES = ["padding-top", "padding-right", "padding-bottom", "padding-left"] as const;

interface Presentation {
  source: HTMLElement;
  overlay: HTMLElement;
  signature: string;
  label: boolean;
  sync: PresentationSync;
  anchor?: ScrollSnapshot;
  correctedScroll?: { top: number; left: number };
  position?: { value: string; priority: string };
  scrollHandler?: () => void;
  loadHandler?: () => void;
}

function sourceChildren(source: HTMLElement): ChildNode[] {
  return Array.from(source.childNodes).filter(node =>
    !(node.nodeType === 1 && (node as Element).matches(PRESENTATION_SELECTOR)));
}

function signature(source: HTMLElement): string {
  return sourceChildren(source).map(node => node.nodeType === 1
    ? (node as Element).outerHTML : node.textContent ?? "").join("");
}

/**
 * The extra presentation wrapper changes native direct-child selectors such as
 * `.canvas-node-content > .markdown-preview-view`. Preserve their resolved
 * padding on the matching clone, instead of guessing a fixed card inset or
 * adding a second inset to themes that already provide one.
 */
function prepareNode(node: ChildNode): Node | null {
  if (node.nodeType !== 1) return node.cloneNode(false);
  const source = node as HTMLElement;
  if (source.matches(`script, style, iframe, webview, object, embed, .markdown-source-view, .cm-editor, textarea, select, button, form, ${PRESENTATION_SELECTOR}`)) return null;
  if (source.tagName === "INPUT" && source.getAttribute("type") !== "checkbox") return null;
  const clone = source.cloneNode(false) as HTMLElement;
  clone.classList.remove("is-editing");
  for (const attr of Array.from(clone.attributes)) {
    if (/^on/i.test(attr.name) || attr.name === "autofocus" || attr.name === "contenteditable") clone.removeAttribute(attr.name);
  }
  if (clone.getAttribute("role") === "textbox") clone.removeAttribute("role");
  if (clone.tagName === "INPUT") (clone as HTMLInputElement).disabled = true;
  const href = clone.getAttribute("href");
  if (href && /^(?:javascript|data|vbscript):/i.test(href.trim())) clone.removeAttribute("href");
  if (source.matches(PREVIEW_LAYOUT_SELECTOR)) {
    const computed = source.ownerDocument.defaultView?.getComputedStyle(source);
    for (const property of PADDING_PROPERTIES) {
      const value = computed?.getPropertyValue(property);
      if (value) clone.style.setProperty(property, value, "important");
    }
  }
  return clone;
}

export class CanvasPresentation {
  private entries = new Map<HTMLElement, Presentation>();
  private byOverlay = new Map<HTMLElement, Presentation>();
  private pendingTranslations = new Map<Text, { value: string; current: () => boolean }>();
  private cancelFrame: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly root: HTMLElement) {}

  refresh(): void {
    if (this.stopped) return;
    for (const [source, entry] of this.entries) {
      if (!this.root.contains(source)) {
        // A detached card can be recycled later by Canvas. Clean it NOW.
        this.remove(entry);
        this.entries.delete(source);
      }
    }

    const containers = new Map<HTMLElement, boolean>();
    for (const node of this.root.querySelectorAll<HTMLElement>(".canvas-node")) {
      const content = node.querySelector<HTMLElement>(".canvas-node-content");
      if (!content || content.closest(PRESENTATION_SELECTOR)) continue;
      const preview = Array.from(content.querySelectorAll<HTMLElement>(
        ".markdown-rendered, .markdown-preview-view, .markdown-embed-content"
      )).find(element => !element.closest(PRESENTATION_SELECTOR));
      if (preview) containers.set(content, false);
    }
    for (const label of this.root.querySelectorAll<HTMLElement>(".canvas-node-label, .canvas-edge-label")) {
      if (!label.closest(PRESENTATION_SELECTOR) && !label.closest(".clt-source-container")) containers.set(label, true);
    }

    for (const [source, entry] of this.entries) {
      if (!containers.has(source)) { this.remove(entry); this.entries.delete(source); }
    }
    for (const [source, label] of containers) {
      const nextSignature = signature(source);
      const existing = this.entries.get(source);
      if (existing && existing.overlay.parentElement === source && existing.signature === nextSignature) continue;
      if (existing && existing.overlay.parentElement === source) {
        // Keep the scroll box AND unchanged translated text alive. Replacing
        // them with a shorter Japanese clone clamps scrollTop before cached
        // English is reapplied and repeatedly pulls a long card upwards.
        const anchor = label ? undefined : captureScrollAnchor(existing.overlay);
        existing.sync.sync(sourceChildren(source), prepareNode);
        existing.signature = nextSignature;
        if (anchor) this.restorePosition(existing, anchor);
        continue;
      }
      const originalScroll = this.originalScroll(source);
      const scrollTop = existing?.overlay.scrollTop ?? originalScroll.top;
      const scrollLeft = existing?.overlay.scrollLeft ?? originalScroll.left;
      if (existing) this.remove(existing);

      const overlay = source.ownerDocument.createElement(label ? "span" : "div");
      overlay.className = label ? "clt-label-presentation" : "clt-native-presentation";
      overlay.dataset.cltPresentation = "true";
      // Obsidian displays aria-label as a hover tooltip. Keep the reading layer
      // free of that intrusive popup; language/read-only state is in the status
      // bar and the interaction controller supplies aria-readonly.
      if (!label) overlay.tabIndex = 0;
      const sync = new PresentationSync(overlay);
      sync.sync(sourceChildren(source), prepareNode);

      const entry: Presentation = { source, overlay, sync, signature: nextSignature, label };
      const position = source.ownerDocument.defaultView?.getComputedStyle(source).position;
      if (!position || position === "static") {
        entry.position = { value: source.style.getPropertyValue("position"), priority: source.style.getPropertyPriority("position") };
        source.style.setProperty("position", "relative");
      }
      source.classList.add(label ? "clt-label-source" : "clt-source-container");
      source.appendChild(overlay);
      overlay.scrollTop = scrollTop;
      overlay.scrollLeft = scrollLeft;
      if (!label) {
        entry.anchor = captureScrollAnchor(overlay);
        entry.scrollHandler = () => {
          const corrected = entry.correctedScroll;
          entry.correctedScroll = undefined;
          entry.anchor = captureScrollAnchor(overlay);
          // Our anchor correction is not a new user scroll. Feeding it back
          // into native lazy rendering can create a redraw/scroll feedback loop.
          if (corrected && Math.abs(corrected.top - overlay.scrollTop) < 0.5 && Math.abs(corrected.left - overlay.scrollLeft) < 0.5) return;
          this.syncOriginalScroll(entry, entry.anchor);
        };
        overlay.addEventListener("scroll", entry.scrollHandler, { passive: true });
        entry.loadHandler = () => {
          const anchor = entry.anchor;
          if (!anchor) return;
          // A wheel's default action can move the reader before its scroll
          // event is delivered. A coincident image load must not replay the
          // older saved position over that newer movement.
          if (Math.abs(overlay.scrollTop - anchor.top) >= 0.5 || Math.abs(overlay.scrollLeft - anchor.left) >= 0.5) {
            entry.anchor = captureScrollAnchor(overlay);
            return;
          }
          this.restorePosition(entry, anchor);
        };
        // Image layout can finish after its markup was inserted.
        overlay.addEventListener("load", entry.loadHandler, true);
      }
      this.entries.set(source, entry);
      this.byOverlay.set(overlay, entry);
    }
  }

  /** Apply all ready translations together, retaining the reader's paragraph. */
  setTranslation(node: Text, value: string, current: () => boolean = () => true): void {
    if (this.stopped) return;
    this.pendingTranslations.set(node, { value, current });
    if (this.cancelFrame) return;
    const view = this.root.ownerDocument.defaultView;
    const flush = () => { this.cancelFrame = null; this.flushTranslations(); };
    if (view?.requestAnimationFrame) {
      const frame = view.requestAnimationFrame(flush);
      this.cancelFrame = () => view.cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(flush, 0);
      this.cancelFrame = () => clearTimeout(timer);
    }
  }

  private flushTranslations(): void {
    if (this.stopped) return;
    const changes = Array.from(this.pendingTranslations);
    this.pendingTranslations.clear();
    const anchors = new Map<Presentation, ScrollSnapshot>();
    const ready: Array<[Text, string]> = [];
    for (const [node, update] of changes) {
      const overlay = node.parentElement?.closest<HTMLElement>(PRESENTATION_SELECTOR);
      const entry = overlay && this.byOverlay.get(overlay);
      if (!entry || !this.root.contains(node) || !update.current() || node.data === update.value) continue;
      if (!entry.label && !anchors.has(entry)) anchors.set(entry, captureScrollAnchor(entry.overlay));
      ready.push([node, update.value]);
    }
    for (const [node, value] of ready) node.data = value;
    for (const [entry, anchor] of anchors) this.restorePosition(entry, anchor);
  }

  private restorePosition(entry: Presentation, anchor: ScrollSnapshot): void {
    const { overlay } = entry;
    const top = overlay.scrollTop, left = overlay.scrollLeft;
    restoreScrollAnchor(overlay, anchor);
    if (Math.abs(top - overlay.scrollTop) >= 0.5 || Math.abs(left - overlay.scrollLeft) >= 0.5) {
      entry.correctedScroll = { top: overlay.scrollTop, left: overlay.scrollLeft };
    }
    entry.anchor = captureScrollAnchor(overlay);
  }

  private syncOriginalScroll(entry: Presentation, anchor: ScrollSnapshot): void {
    const candidates = Array.from(entry.source.querySelectorAll<HTMLElement>(".markdown-preview-view, .markdown-embed-content"))
      .filter(element => !element.closest(PRESENTATION_SELECTOR)).reverse();
    for (const point of anchor.anchors) {
      const original = entry.sync.sourceFor(point.element);
      if (!original || original.nodeType !== 1 || !entry.source.contains(original)) continue;
      const element = original as HTMLElement;
      const scroll = candidates.find(candidate => candidate.contains(element) && candidate.scrollHeight > candidate.clientHeight + 1);
      if (!scroll) continue;
      const box = element.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
      if (box.height <= 0 || viewport.height <= 0) continue;
      // English and Japanese need not have the same height. Mirror the visible
      // paragraph into the original view so native lazy rendering loads the
      // corresponding section, instead of copying an unrelated pixel offset.
      const insideOffset = Math.max(point.offset, -(box.height / scrollScale(scroll) - 1));
      const target = scroll.scrollTop + (box.top - viewport.top) / scrollScale(scroll) - insideOffset;
      this.assignOriginalScroll(scroll, target, entry.overlay.scrollLeft);
      return;
    }
    const scroll = candidates.find(candidate => candidate.scrollHeight > candidate.clientHeight + 1);
    if (!scroll) return;
    const range = Math.max(0, entry.overlay.scrollHeight - entry.overlay.clientHeight);
    const fraction = range > 0 ? Math.min(1, Math.max(0, anchor.top / range)) : 0;
    this.assignOriginalScroll(scroll, fraction * (scroll.scrollHeight - scroll.clientHeight), entry.overlay.scrollLeft);
  }

  private assignOriginalScroll(scroll: HTMLElement, top: number, left: number): void {
    const target = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, top));
    if (Math.abs(scroll.scrollTop - target) >= 0.5) scroll.scrollTop = target;
    if (Math.abs(scroll.scrollLeft - left) >= 0.5) scroll.scrollLeft = left;
  }

  /** Ignore translation's own mutations, but always react to source updates. */
  isOwnMutation(record: MutationRecord): boolean {
    const element = record.target.nodeType === 1 ? record.target as Element : record.target.parentElement;
    if (element?.closest(PRESENTATION_SELECTOR)) return true;
    if (record.type === "childList") {
      const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)];
      return nodes.length > 0 && nodes.every(node => node.nodeType === 1 && (node as Element).matches(PRESENTATION_SELECTOR));
    }
    return false;
  }

  destroy(): void {
    this.stopped = true;
    this.cancelFrame?.(); this.cancelFrame = null;
    this.pendingTranslations.clear();
    for (const entry of this.entries.values()) this.remove(entry);
    this.entries.clear();
    this.byOverlay.clear();
    // Also remove orphan layers after a host re-parent/DOM clone.
    this.root.querySelectorAll(PRESENTATION_SELECTOR).forEach(node => node.remove());
    this.root.querySelectorAll(".clt-source-container, .clt-label-source").forEach(node =>
      node.classList.remove("clt-source-container", "clt-label-source"));
  }

  private originalScroll(source: HTMLElement): { top: number; left: number } {
    const scroll = source.querySelector<HTMLElement>(".markdown-preview-view, .markdown-embed-content");
    return { top: scroll?.scrollTop ?? 0, left: scroll?.scrollLeft ?? 0 };
  }

  private remove(entry: Presentation): void {
    if (entry.scrollHandler) entry.overlay.removeEventListener("scroll", entry.scrollHandler);
    if (entry.loadHandler) entry.overlay.removeEventListener("load", entry.loadHandler, true);
    if (!entry.label) this.syncOriginalScroll(entry, entry.anchor ?? captureScrollAnchor(entry.overlay));
    this.byOverlay.delete(entry.overlay);
    entry.overlay.remove();
    entry.source.classList.remove("clt-source-container", "clt-label-source");
    if (entry.position && entry.source.style.getPropertyValue("position") === "relative") {
      if (entry.position.value) entry.source.style.setProperty("position", entry.position.value, entry.position.priority);
      else entry.source.style.removeProperty("position");
    }
  }
}
