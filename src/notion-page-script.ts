/** Serializable guest-page protocol. This module never sees an API key. */
export interface NotionPageRequest {
  action: "collect" | "apply" | "restore";
  session: string;
  expectedUrl: string;
  revision?: number;
  patches?: Array<{ id: string; source: string; translated: string }>;
  limit?: number;
}

export interface NotionPagePart {
  id: string;
  source: string;
  context: string;
}

export interface NotionPageResponse {
  status: "ready" | "not-ready" | "wrong-page" | "restored";
  revision: number;
  parts: NotionPagePart[];
  applied?: number;
  truncated?: boolean;
}

/**
 * Everything used by this function must be declared INSIDE it: it is serialized
 * and evaluated by Electron in the existing Notion webview's isolated process.
 * Do not pass host capabilities, credentials, cookies, or executable model text.
 */
export function notionPageAction(request: NotionPageRequest): NotionPageResponse {
  type Entry = { node: Text; source: string; context: string };
  type State = {
    href: string;
    revision: number;
    source: HTMLElement;
    pageContent: HTMLElement;
    overlay: HTMLDivElement;
    article: HTMLDivElement;
    scroller: HTMLElement | null;
    entries: Map<string, Entry>;
    translations: Map<string, string>;
    dirty: boolean;
    observer: MutationObserver;
    dispose: () => void;
    sourceScroll: number;
  };

  const response = (status: NotionPageResponse["status"], revision = 0): NotionPageResponse =>
    ({ status, revision, parts: [] });
  const allowed = (value: string): boolean => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && ["notion.so", "notion.site", "notion.com"]
        .some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
    } catch { return false; }
  };
  const pageIdentity = (url: string): string => url.split("#", 1)[0];
  // Both the host and the guest check the actual URL on EVERY request. A card
  // can navigate between collection and an API result, including to another site.
  if (!allowed(location.href) || !allowed(request.expectedUrl) ||
      pageIdentity(location.href) !== pageIdentity(request.expectedUrl)) return response("wrong-page");
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(request.session)) return response("wrong-page");

  const stateKey = `__canvasLiveTranslateNotion_${request.session}`;
  const globals = window as unknown as Record<string, unknown>;
  let state = globals[stateKey] as State | undefined;
  if (request.action === "restore") {
    state?.dispose();
    delete globals[stateKey];
    return response("restored");
  }

  const japanese = /[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/u;
  const protectedSelector = [
    "script", "style", "noscript", "code", "pre", "svg", "math", "input", "textarea", "button", "select",
    ".katex", ".MathJax", ".math", ".notion-code-block", ".notion-equation-block", "[data-clt-skip]"
  ].join(",");
  const contextSelector = "p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,figcaption,[data-clt-block]";
  const pageContent = Array.from(document.querySelectorAll<HTMLElement>(".notion-page-content"))
    .find(element => !element.closest("[data-clt-notion-presentation]"));

  if (request.action === "collect" && (!pageContent || !document.body)) {
    state?.dispose();
    delete globals[stateKey];
    return response("not-ready");
  }
  if (state && (state.href !== pageIdentity(location.href) || !state.overlay.isConnected ||
      (request.action === "collect" && state.pageContent !== pageContent))) {
    state.dispose();
    delete globals[stateKey];
    state = undefined;
  }

  if (!state && request.action === "collect" && pageContent) {
    // Use the native page scroller when available: it also contains the title,
    // page properties, and cover. Never clone the workspace/sidebar/login UI.
    const sourceScroller = pageContent.closest<HTMLElement>(".notion-scroller");
    const source = sourceScroller ?? pageContent;
    const overlay = document.createElement("div");
    overlay.setAttribute("data-clt-notion-presentation", request.session);
    overlay.setAttribute("role", "region");
    overlay.setAttribute("aria-label", "Read-only Notion translation");
    overlay.tabIndex = 0;
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;overflow:auto;overscroll-behavior:contain;box-sizing:border-box;user-select:text;-webkit-user-select:text;cursor:text;";
    const colors = getComputedStyle(source);
    const bodyColors = getComputedStyle(document.body);
    overlay.style.backgroundColor = colors.backgroundColor !== "rgba(0, 0, 0, 0)" && colors.backgroundColor !== "transparent"
      ? colors.backgroundColor : bodyColors.backgroundColor !== "rgba(0, 0, 0, 0)" && bodyColors.backgroundColor !== "transparent"
        ? bodyColors.backgroundColor : matchMedia("(prefers-color-scheme: dark)").matches ? "#191919" : "#fff";
    overlay.style.color = colors.color;
    overlay.style.font = colors.font || bodyColors.font;
    const bar = document.createElement("div");
    bar.textContent = "Translation · Read-only";
    bar.setAttribute("data-clt-skip", "");
    bar.style.cssText = "position:sticky;top:0;z-index:2;padding:5px 12px;font:11px/1.5 system-ui,sans-serif;opacity:.82;background:inherit;border-bottom:1px solid #8884;";
    const article = document.createElement("div");
    article.style.cssText = "min-height:100%;width:100%;box-sizing:border-box;user-select:text;-webkit-user-select:text;";
    overlay.append(bar, article);

    // This presentation consists of detached clones; the site's editor DOM and
    // its React state are not changed. Prevent delegated editing/navigation, while
    // native text selection, copying, keyboard scrolling and wheel scrolling work.
    const stopDelegation = (event: Event): void => {
      // Focus the read-only presentation, not the live editor below it. This also
      // keeps subsequent typing/paste and keyboard scrolling in the safe layer.
      if (event.type === "pointerdown" || event.type === "mousedown") overlay.focus({ preventScroll: true });
      event.stopImmediatePropagation();
    };
    const blockWrite = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
    const clickGuard = (event: Event): void => {
      const target = event.target instanceof Element ? event.target : null;
      // Links remain legible, but opening them requires returning to the original
      // page. This prevents inherited Notion delegated handlers editing originals.
      if (target?.closest("a,button,input,textarea,select,[role='button']")) event.preventDefault();
      event.stopImmediatePropagation();
    };
    const keyGuard = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && ["c", "a"].includes(event.key.toLowerCase())) {
        event.stopImmediatePropagation();
        return;
      }
      if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End", " ", "Escape", "Shift", "Control", "Meta", "Alt"].includes(event.key)) {
        event.stopImmediatePropagation();
        return;
      }
      event.preventDefault(); event.stopImmediatePropagation();
    };
    for (const name of ["pointerdown", "mousedown", "touchstart", "dblclick"])
      overlay.addEventListener(name, stopDelegation, true);
    overlay.addEventListener("click", clickGuard, true);
    for (const name of ["beforeinput", "paste", "cut", "drop", "dragstart", "submit"])
      overlay.addEventListener(name, blockWrite, true);
    overlay.addEventListener("keydown", keyGuard, true);

    const current: State = {
      href: pageIdentity(location.href), revision: 0, source, pageContent, overlay, article,
      scroller: sourceScroller, entries: new Map(), translations: new Map(), dirty: true,
      observer: new MutationObserver(() => { current.dirty = true; }),
      sourceScroll: sourceScroller?.scrollTop ?? 0,
      dispose: () => {
        current.observer.disconnect();
        // Overlapping EN sessions can occur during a very fast off/on toggle.
        // Release only this session; restore the pre-plugin flag after the last.
        const lock = inputLocks.get(source);
        lock?.owners.delete(request.session);
        if (lock && lock.owners.size === 0) {
          if (lock.original === null) source.removeAttribute("inert");
          else source.setAttribute("inert", lock.original);
          inputLocks.delete(source);
        }
        overlay.remove();
      }
    };
    // An ephemeral accessibility/input flag (not page content) prevents Tab from
    // reaching the real Notion editor hidden behind the presentation. Restore its
    // prior value exactly; the original rich text and editor state are untouched.
    type InputLock = { original: string | null; owners: Set<string> };
    const locksKey = "__canvasLiveTranslateNotionInputLocks_v2";
    const inputLocks = (globals[locksKey] ??= new WeakMap<HTMLElement, InputLock>()) as WeakMap<HTMLElement, InputLock>;
    let inputLock = inputLocks.get(source);
    if (!inputLock) {
      inputLock = { original: source.getAttribute("inert"), owners: new Set() };
      inputLocks.set(source, inputLock);
    }
    inputLock.owners.add(request.session);
    source.setAttribute("inert", "");
    // Mirroring just scroll position (not input events) lets Notion lazy-load more
    // existing blocks. It never writes page contents or accesses Notion APIs.
    overlay.addEventListener("scroll", () => {
      if (!current.scroller?.isConnected) return;
      const maxOverlay = overlay.scrollHeight - overlay.clientHeight;
      const maxSource = current.scroller.scrollHeight - current.scroller.clientHeight;
      if (maxOverlay > 0 && maxSource > 0) {
        current.scroller.scrollTop = Math.max(0, Math.min(1, overlay.scrollTop / maxOverlay)) * maxSource;
        current.sourceScroll = current.scroller.scrollTop;
      }
    }, { passive: true });
    document.body.append(overlay);
    current.observer.observe(source, { subtree: true, childList: true, characterData: true });
    globals[stateKey] = current;
    state = current;
  }
  if (!state) return response("not-ready");

  if (request.action === "apply") {
    if (request.revision !== state.revision || state.dirty) return response("ready", state.revision);
    let applied = 0;
    for (const patch of (request.patches ?? []).slice(0, 500)) {
      if (typeof patch.id !== "string" || typeof patch.source !== "string" || typeof patch.translated !== "string" ||
          !patch.translated.trim() || patch.translated.length > 40000) continue;
      const entry = state.entries.get(patch.id);
      if (!entry?.node.isConnected || entry.source !== patch.source || entry.node.data !== entry.source) continue;
      // Model output is text only. It is never interpreted as HTML or script.
      entry.node.data = patch.translated;
      state.translations.set(`${entry.source}\u0000${entry.context}`, patch.translated);
      applied++;
    }
    return { ...response("ready", state.revision), applied };
  }

  if (state.dirty) {
    const oldTop = state.overlay.scrollTop;
    const clone = state.source.cloneNode(true) as HTMLElement;
    // Strip all stateful/editable/executable content from the detached copy before
    // it reaches the live DOM. Retain normal Markdown/layout, images and math.
    for (const unwanted of clone.querySelectorAll("script,style,noscript,iframe,webview,object,embed,form")) unwanted.remove();
    for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
      if (element.classList.contains("notion-selectable") || element.hasAttribute("data-block-id")) element.setAttribute("data-clt-block", "");
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on") || name === "id" || name === "name" || name === "tabindex" ||
            name === "contenteditable" || name === "autofocus" || name === "draggable" ||
            (name.startsWith("data-") && name !== "data-clt-block")) element.removeAttribute(attribute.name);
      }
      if (element.getAttribute("role") === "textbox") element.removeAttribute("role");
      if (element instanceof HTMLElement) {
        element.contentEditable = "false";
        element.draggable = false;
        element.style.userSelect = "text";
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement || element instanceof HTMLButtonElement) element.disabled = true;
      if (element instanceof HTMLAnchorElement) {
        try {
          const link = new URL(element.getAttribute("href") ?? "", location.href);
          if (!["https:", "http:"].includes(link.protocol)) element.removeAttribute("href");
        } catch { element.removeAttribute("href"); }
        element.title = "Return to the original page to open this link.";
        element.removeAttribute("target");
        element.tabIndex = -1;
      }
    }
    clone.removeAttribute("inert");
    clone.style.height = "auto";
    clone.style.minHeight = "100%";
    clone.style.maxHeight = "none";
    clone.style.overflow = "visible";
    clone.style.position = "relative";
    clone.style.transform = "none";
    // content-visibility can otherwise leave cloned off-screen text unrendered.
    for (const node of clone.querySelectorAll<HTMLElement>("[style*='content-visibility']")) node.style.contentVisibility = "visible";
    state.article.replaceChildren(clone);
    state.overlay.scrollTop = oldTop || state.sourceScroll;
    state.revision++;
    state.entries.clear();
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    const candidates: Text[] = [];
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (text.parentElement && !text.parentElement.closest(protectedSelector) && japanese.test(text.data)) candidates.push(text);
    }
    // Build all contexts before applying remembered translations, so no English
    // neighbor can leak into a later entry's original context/cache identity.
    const entries = candidates.map((node, index): [string, Entry] => {
      const block = node.parentElement?.closest(contextSelector) ?? node.parentElement;
      const context = (block?.textContent ?? node.data).replace(/\s+/gu, " ").trim().slice(0, 480);
      return [String(index), { node, source: node.data, context: context === node.data.trim() ? "" : context }];
    });
    for (const [id, entry] of entries) {
      state.entries.set(id, entry);
      const remembered = state.translations.get(`${entry.source}\u0000${entry.context}`);
      if (remembered) entry.node.data = remembered;
    }
    // Bound view-local memory; persistent/deduplicated cache lives in the host.
    if (state.translations.size > 5000) {
      for (const key of Array.from(state.translations.keys()).slice(0, state.translations.size - 5000)) state.translations.delete(key);
    }
    state.dirty = false;
  }

  const maxParts = Math.max(1, Math.min(500, request.limit ?? 300));
  const parts: NotionPagePart[] = [];
  let chars = 0;
  let truncated = false;
  // Prefer text currently on screen, then translate the rest of loaded content.
  const currentEntries = Array.from(state.entries.entries()).sort((a, b) => {
    const inView = (entry: Entry): number => {
      const rect = entry.node.parentElement?.getBoundingClientRect();
      return rect && rect.bottom >= 0 && rect.top <= innerHeight ? 0 : 1;
    };
    return inView(a[1]) - inView(b[1]);
  });
  for (const [id, entry] of currentEntries) {
    if (!entry.node.isConnected || entry.node.data !== entry.source) continue;
    if (parts.length >= maxParts || chars + entry.source.length + entry.context.length > 120000) { truncated = true; break; }
    if (entry.source.length > 20000) { truncated = true; continue; }
    parts.push({ id, source: entry.source, context: entry.context });
    chars += entry.source.length + entry.context.length;
  }
  return { status: "ready", revision: state.revision, parts, truncated };
}

/** JSON is encoded as data, never interpolated into executable code. */
export function buildNotionPageScript(request: NotionPageRequest): string {
  return `(${notionPageAction.toString()})(${JSON.stringify(request)})`;
}
