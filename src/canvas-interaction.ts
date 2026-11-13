/**
 * Scoped, reversible interaction guards for the translated Canvas presentation.
 *
 * Canvas has no public rendering/editing API. Its optional startEditing /
 * child.showPreview hooks are capability checked; DOM guards remain in place
 * when a host version or another plugin does not expose those hooks.
 * This module never updates node data, editor text, or vault files.
 */

export interface ReadOnlyCanvasController {
  refresh(): void;
  destroy(): void;
}

type UnknownRecord = Record<string, unknown>;
type AnyMethod = (this: unknown, ...args: unknown[]) => unknown;

interface MethodPatch {
  object: UnknownRecord;
  originalDescriptor: PropertyDescriptor | undefined;
  original: AnyMethod;
  wrapper: AnyMethod;
}

interface AttributePatch {
  element: HTMLElement;
  name: string;
  previous: string | null;
  applied: string;
}

const PRESENTATION_SELECTOR = ".clt-native-presentation";
const PREVIEW_SELECTOR = `${PRESENTATION_SELECTOR}, .markdown-preview-view, .markdown-embed-content, .markdown-rendered`;
const LABEL_SELECTOR = ".canvas-node-label, .canvas-edge-label, .clt-label-presentation";
const TOOLBAR_SELECTOR = ".canvas-menu, .canvas-node-toolbar, .canvas-selection-menu";
const NON_CONTENT_UI = ".canvas-controls, .view-header, .view-actions, .canvas-card-menu";

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? value as UnknownRecord : null;
}

function asElement(value: unknown): HTMLElement | null {
  // Do not use global instanceof: Obsidian pop-out windows have another realm.
  return value !== null && typeof value === "object" && (value as Node).nodeType === 1
    ? value as HTMLElement : null;
}

function eventElement(event: Event): HTMLElement | null {
  const direct = asElement(event.target);
  if (direct) return direct;
  return event.target && typeof event.target === "object"
    ? asElement((event.target as Node).parentElement) : null;
}

function nativeTextCard(element: HTMLElement | null): HTMLElement | null {
  const card = element?.closest<HTMLElement>(".canvas-node") ?? null;
  if (!card) return null;
  // Web-page cards have no host Markdown preview. A Markdown card may itself
  // contain an iframe, so a descendant iframe alone must not bypass its guard.
  return card.querySelector(`${PREVIEW_SELECTOR}, .markdown-source-view, .cm-editor`)
    ? card : null;
}

function canvasNodes(value: unknown): UnknownRecord[] {
  const record = asRecord(value);
  const canvas = asRecord(record?.canvas) ?? record;
  const nodes = canvas?.nodes;
  try {
    if (nodes && typeof (nodes as { values?: unknown }).values === "function") {
      return Array.from((nodes as { values(): Iterable<unknown> }).values())
        .map(asRecord).filter((node): node is UnknownRecord => node !== null);
    }
    if (Array.isArray(nodes)) return nodes.map(asRecord).filter((node): node is UnknownRecord => node !== null);
    if (asRecord(nodes)) return Object.values(nodes as UnknownRecord).map(asRecord)
      .filter((node): node is UnknownRecord => node !== null);
  } catch {
    // A changing/unloaded Canvas must not break the surrounding Obsidian view.
  }
  return [];
}

function isEditControl(element: HTMLElement): boolean {
  const control = element.closest<HTMLElement>("button, .clickable-icon, [role='button']");
  if (!control || !control.closest(TOOLBAR_SELECTOR)) return false;
  if (control.querySelector(".lucide-square-pen, .lucide-pencil, .lucide-pencil-line, .lucide-file-pen")) return true;
  const label = `${control.getAttribute("aria-label") ?? ""} ${control.getAttribute("title") ?? ""}`.trim();
  return /^(edit(?:\s|$)|編集)/iu.test(label);
}

/** Exported for fixture tests; does not depend on Canvas private APIs. */
export function findCardScrollContainer(element: HTMLElement): HTMLElement | null {
  const card = nativeTextCard(element);
  if (!card) return null;
  const presentation = element.closest<HTMLElement>(PRESENTATION_SELECTOR)
    ?? card.querySelector<HTMLElement>(PRESENTATION_SELECTOR);
  // The presentation layer deliberately owns the entire card's scrolling.
  // Hidden native previews must never become the scroll target underneath it.
  if (presentation) return presentation;

  const candidates: HTMLElement[] = [];
  let current: HTMLElement | null = element;
  while (current && current !== card) {
    if (current.matches(PREVIEW_SELECTOR)) candidates.push(current);
    current = current.parentElement;
  }
  candidates.push(...card.querySelectorAll<HTMLElement>(PREVIEW_SELECTOR));
  return candidates.find(candidate => candidate.scrollHeight > candidate.clientHeight + 1) ?? null;
}

function preventMutation(event: Event): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * Install guards for one active Canvas. The optional second argument can be
 * either the private Canvas instance or its containing Canvas view.
 */
export function createReadOnlyCanvasController(
  root: HTMLElement,
  canvas?: unknown,
  onChange?: () => void
): ReadOnlyCanvasController {
  let active = true;
  let refreshing = false;
  let spaceHeld = false;
  const patches: MethodPatch[] = [];
  const currentPatches = new WeakMap<object, MethodPatch>();
  const attributePatches = new Map<HTMLElement, Map<string, AttributePatch>>();
  const markedCards = new Set<HTMLElement>();
  const listeners: Array<() => void> = [];
  const rootHadClass = root.classList.contains("canvas-live-translate-readonly");
  root.classList.add("canvas-live-translate-readonly");

  function patchAttribute(element: HTMLElement, name: string, applied: string): void {
    let attributes = attributePatches.get(element);
    if (!attributes) {
      attributes = new Map();
      attributePatches.set(element, attributes);
    }
    if (!attributes.has(name)) {
      attributes.set(name, { element, name, previous: element.getAttribute(name), applied });
    }
    if (element.getAttribute(name) !== applied) element.setAttribute(name, applied);
  }

  function keepPreview(node: UnknownRecord): boolean {
    const element = asElement(node.nodeEl) ?? asElement(node.containerEl);
    if (!element || !root.contains(element) || !nativeTextCard(element)) return false;
    const isEditing = node.isEditing === true || element?.classList.contains("is-editing");
    if (!isEditing) return false;
    const child = asRecord(node.child);
    if (typeof child?.showPreview !== "function") return false;
    try {
      const result = (child.showPreview as AnyMethod).call(child);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(result).then(() => { if (active) onChange?.(); }, () => {});
      }
      // This is ephemeral view state, never node text or Canvas JSON data.
      node.isEditing = false;
      element?.classList.remove("is-editing");
      return true;
    } catch {
      // The scoped beforeinput/paste guards still protect an unexpected editor.
      return false;
    }
  }

  function patchNode(node: UnknownRecord): void {
    const element = asElement(node.nodeEl) ?? asElement(node.containerEl);
    // A LinkNode can use startEditing to *activate* its webview for scrolling.
    // Do not block that; embedded Notion has its own page-local read-only guard.
    if (!element || !root.contains(element) || !nativeTextCard(element)) return;
    const method = node.startEditing;
    if (typeof method !== "function") return;
    if (currentPatches.get(node)?.wrapper === method) return;
    const original = method as AnyMethod;
    const originalDescriptor = Object.getOwnPropertyDescriptor(node, "startEditing");
    const wrapper: AnyMethod = function (...args: unknown[]): unknown {
      if (!active) return original.apply(this, args);
      const thisNode = asRecord(this);
      if (thisNode) keepPreview(thisNode);
      onChange?.();
      return undefined;
    };
    try {
      // Per-instance patch only, never a process-wide/prototype replacement.
      node.startEditing = wrapper;
      if (node.startEditing !== wrapper) return;
      const patch = { object: node, originalDescriptor, original, wrapper };
      patches.push(patch);
      currentPatches.set(node, patch);
    } catch {
      // Frozen host objects fall back to DOM guards instead of breaking toggle.
    }
  }

  function refresh(): void {
    if (!active || refreshing) return;
    refreshing = true;
    let changed = false;
    try {
      for (const node of canvasNodes(canvas)) {
        patchNode(node);
        changed = keepPreview(node) || changed;
      }
      for (const card of root.querySelectorAll<HTMLElement>(".canvas-node")) {
        if (!nativeTextCard(card)) continue;
        if (!card.classList.contains("clt-text-readonly")) {
          card.classList.add("clt-text-readonly");
          markedCards.add(card);
        }
        for (const presentation of card.querySelectorAll<HTMLElement>(PRESENTATION_SELECTOR)) {
          patchAttribute(presentation, "tabindex", "0");
          patchAttribute(presentation, "aria-readonly", "true");
        }
        // A second plugin may bypass startEditing and focus CodeMirror directly.
        // Disallow DOM input while the clone remains the visible presentation.
        for (const editable of card.querySelectorAll<HTMLElement>("[contenteditable='true'], [contenteditable='plaintext-only']")) {
          patchAttribute(editable, "contenteditable", "false");
          patchAttribute(editable, "aria-readonly", "true");
        }
        for (const input of card.querySelectorAll<HTMLElement>("textarea, input:not([type='checkbox']):not([type='radio']):not([type='button'])")) {
          patchAttribute(input, "readonly", "");
        }
      }
    } finally {
      refreshing = false;
    }
    if (changed) onChange?.();
  }

  function listen(target: EventTarget, name: string, fn: EventListener, options: AddEventListenerOptions = { capture: true }): void {
    target.addEventListener(name, fn, options);
    listeners.push(() => target.removeEventListener(name, fn, options));
  }

  function scopedMutation(event: Event): void {
    const element = eventElement(event);
    if (!element || !root.contains(element)) return;
    if (nativeTextCard(element) || element.closest(LABEL_SELECTOR)) preventMutation(event);
  }

  function pointerGuard(event: Event): void {
    const element = eventElement(event);
    if (!element) return;
    refresh();
    const card = nativeTextCard(element);
    if (!card) return;
    if (element.closest("input, textarea, select, button, [role='checkbox'], [role='switch']")) {
      preventMutation(event);
      return;
    }
    const presentation = element.closest<HTMLElement>(PRESENTATION_SELECTOR);
    if (presentation && !element.closest("a[href], .internal-link, .external-link")) {
      // Let browser text selection and scrollbar dragging happen, but don't
      // bubble a body click to Canvas's edit/move handlers or one-click plugins.
      event.stopImmediatePropagation();
    }
  }

  function clickGuard(event: Event): void {
    const element = eventElement(event);
    if (!element) return;
    if (isEditControl(element)) {
      preventMutation(event);
      return;
    }
    const card = nativeTextCard(element);
    if (!card) return;
    if (element.closest("input, textarea, select, button, [role='checkbox'], [role='switch']")) {
      preventMutation(event);
      return;
    }
    const presentation = element.closest<HTMLElement>(PRESENTATION_SELECTOR);
    if (presentation && !element.closest("a[href], .internal-link, .external-link")) {
      event.stopImmediatePropagation();
      presentation.focus({ preventScroll: true });
    }
  }

  function doubleClickGuard(event: Event): void {
    const element = eventElement(event);
    if (!element || element.closest("a[href], .internal-link, .external-link")) return;
    if (nativeTextCard(element) || element.closest(LABEL_SELECTOR) || isEditControl(element)) {
      // Preserve the browser's word-selection default in a presentation clone.
      if (element.closest(PRESENTATION_SELECTOR)) event.stopImmediatePropagation();
      else preventMutation(event);
    }
  }

  function wheelGuard(event: Event): void {
    const wheel = event as WheelEvent;
    if (wheel.ctrlKey || wheel.metaKey || wheel.shiftKey || spaceHeld) return;
    if (Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY) || wheel.deltaY === 0) return;
    const element = eventElement(event);
    const scroll = element && findCardScrollContainer(element);
    if (!scroll || scroll.scrollHeight <= scroll.clientHeight + 1) return;
    if (scroll.matches(PRESENTATION_SELECTOR)) {
      // Let Chromium own trackpad momentum, fractional wheel deltas and the
      // scrollbar. Rewriting scrollTop for every wheel event interrupts that
      // native motion and competes with content-height/anchor adjustments.
      // The overlay's overscroll-behavior contains scrolling at either edge;
      // stopping propagation keeps Canvas from also treating it as a pan.
      if (element?.closest(PRESENTATION_SELECTOR) === scroll) event.stopImmediatePropagation();
      return;
    }
    // A newly rendered card may briefly have only its native preview. Keep the
    // existing fallback until the independent presentation layer is ready.
    const unit = wheel.deltaMode === 1 ? 16 : wheel.deltaMode === 2 ? scroll.clientHeight : 1;
    const previous = scroll.scrollTop;
    scroll.scrollTop = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, previous + wheel.deltaY * unit));
    // Retain the wheel within the card even at its edge. Otherwise a professor
    // presentation unexpectedly pans the entire Canvas at the end of a note.
    preventMutation(event);
    if (scroll.scrollTop !== previous) onChange?.();
  }

  function keyGuard(event: Event): void {
    const keyboard = event as KeyboardEvent;
    const element = eventElement(event);
    if (!element || element.closest(NON_CONTENT_UI)) return;
    if (keyboard.code === "Space" || keyboard.key === " ") spaceHeld = true;
    const card = nativeTextCard(element);
    const label = element.closest(LABEL_SELECTOR);
    const isCanvasBackground = element.matches(".canvas, .canvas-wrapper, .canvas-node-container") || element === root;
    const selectedCard = isCanvasBackground
      ? nativeTextCard(root.querySelector<HTMLElement>(".canvas-node.is-selected")) : null;
    const scopedCard = card ?? selectedCard;
    if (!scopedCard && !label) return;
    // Native links and read-only controls retain Enter navigation.
    if (keyboard.key === "Enter" && element.closest("a[href], .internal-link, .external-link")) return;

    const command = keyboard.ctrlKey || keyboard.metaKey;
    if (command) {
      if (["v", "x", "z", "y"].includes(keyboard.key.toLowerCase())) preventMutation(event);
      return; // Copy, Select All, Find, app shortcuts, and zoom remain available.
    }
    if (keyboard.altKey) return;
    const presentation = element.closest<HTMLElement>(PRESENTATION_SELECTOR);
    if (presentation && ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(keyboard.key)) {
      const previous = presentation.scrollTop;
      const maximum = Math.max(0, presentation.scrollHeight - presentation.clientHeight);
      const jump = keyboard.key === "PageDown" || keyboard.key === "PageUp" ? presentation.clientHeight * 0.9 : 40;
      const target = keyboard.key === "Home" ? 0 : keyboard.key === "End" ? maximum
        : previous + (["ArrowUp", "PageUp"].includes(keyboard.key) ? -jump : jump);
      presentation.scrollTop = Math.max(0, Math.min(maximum, target));
      preventMutation(event);
      if (presentation.scrollTop !== previous) onChange?.();
      return;
    }
    if (["Enter", "F2", "Backspace", "Delete"].includes(keyboard.key) ||
        (keyboard.key.length === 1 && keyboard.key !== " ") || keyboard.isComposing) {
      preventMutation(event);
    }
  }

  for (const name of ["pointerdown", "mousedown", "touchstart"]) listen(root, name, pointerGuard, { capture: true, passive: false });
  listen(root, "click", clickGuard);
  listen(root, "dblclick", doubleClickGuard);
  listen(root, "wheel", wheelGuard, { capture: true, passive: false });
  for (const name of ["beforeinput", "paste", "cut", "drop", "compositionstart"]) listen(root, name, scopedMutation);
  listen(root, "keydown", keyGuard);
  listen(root.ownerDocument, "keyup", event => {
    const key = event as KeyboardEvent;
    if (key.code === "Space" || key.key === " ") spaceHeld = false;
  });
  if (root.ownerDocument.defaultView) listen(root.ownerDocument.defaultView, "blur", () => { spaceHeld = false; });
  refresh();

  return {
    refresh,
    destroy(): void {
      if (!active) return;
      active = false;
      spaceHeld = false;
      listeners.splice(0).forEach(remove => remove());
      for (const patch of patches.reverse()) {
        // Never discard a wrapper installed by a different plugin after ours.
        // If it retained our function, active=false makes ours pass through.
        if (patch.object.startEditing !== patch.wrapper) continue;
        try {
          if (patch.originalDescriptor) Object.defineProperty(patch.object, "startEditing", patch.originalDescriptor);
          else delete patch.object.startEditing;
        } catch { /* Unloading must remain safe if the host object was frozen. */ }
      }
      for (const attributes of attributePatches.values()) {
        for (const patch of attributes.values()) {
          if (patch.element.getAttribute(patch.name) !== patch.applied) continue;
          if (patch.previous === null) patch.element.removeAttribute(patch.name);
          else patch.element.setAttribute(patch.name, patch.previous);
        }
      }
      attributePatches.clear();
      for (const card of markedCards) card.classList.remove("clt-text-readonly");
      markedCards.clear();
      if (!rootHadClass) root.classList.remove("canvas-live-translate-readonly");
    }
  };
}
