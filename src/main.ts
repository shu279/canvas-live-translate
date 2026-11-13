import { App, Modal, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, WorkspaceLeaf } from "obsidian";
import { extractContext, findTranslatableNodes, isEditableOrProtected, translationPriority } from "./canvas-dom";
import { CanvasPresentation, PRESENTATION_SELECTOR } from "./canvas-presentation";
import { createReadOnlyCanvasController } from "./canvas-interaction";
import { createOriginalCanvasView, OriginalCanvasView } from "./canvas-original-view";
import { NotionAdapterStatus, NotionWebviewController, WebTranslationTarget } from "./notion-webview";
import { translateWithOpenAI, TranslationError } from "./openai-translation";
import { makeCacheKey, splitWhitespace, TranslationPart } from "./translation-core";
import { TranslationQueue } from "./translation-queue";

interface TranslateSettings {
  apiSecretName: string;
  model: string;
  targetLanguage: string;
  glossary: string;
  concurrency: number;
  translateNotion: boolean;
}
interface SavedState { settings: TranslateSettings; cache: Record<string, string>; }
interface NativeTarget { source: string; key?: string; translated?: string; unsubscribe?: () => void; }
interface CanvasSession {
  root: HTMLElement;
  view: WorkspaceLeaf["view"];
  presentation: CanvasPresentation;
  interaction: ReturnType<typeof createReadOnlyCanvasController>;
  web: NotionWebviewController | null;
  queue: TranslationQueue;
  observer: MutationObserver;
  nativeTargets: Map<Text, NativeTarget>;
  webTargets: Map<string, { key: string; target: WebTranslationTarget; unsubscribe: () => void }>;
  keyPromises: Map<string, Promise<string>>;
  settings: TranslateSettings;
  timer: number | null;
  scanning: boolean;
  scanAgain: boolean;
  webScanning: boolean;
  destroyed: boolean;
  lastError: string;
  notifiedFatal: boolean;
  notionStatus: NotionAdapterStatus | null;
  onScroll: () => void;
}
const DEFAULT_SETTINGS: TranslateSettings = {
  apiSecretName: "", model: "gpt-6-luna", targetLanguage: "English",
  glossary: "Keep established English research terms such as Attention, Key, Value, Query, KV Cache, Visual Token, and Prototype in English.",
  concurrency: 3, translateNotion: true
};
const MAX_CACHE_ENTRIES = 15000;

export default class CanvasLiveTranslate extends Plugin {
  settings: TranslateSettings = { ...DEFAULT_SETTINGS };
  private cache: Record<string, string> = {};
  private enabled = false;
  private session: CanvasSession | null = null;
  private saveTimer: number | null = null;
  private statusEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private shuttingDown = false;
  private transitioning = false;
  private transitionId = 0;
  private transitionWork: Promise<void> = Promise.resolve();
  private restoreError = "";
  private pendingRestores = new Set<NotionWebviewController>();
  private originalViews = new Map<HTMLElement, OriginalCanvasView>();
  private cacheWritesSinceTrim = 0;

  async onload(): Promise<void> {
    const data = await this.loadData() as Partial<SavedState> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.settings.concurrency = Math.max(1, Math.min(6, Math.floor(Number(this.settings.concurrency) || 3)));
    this.cache = Object.fromEntries(Object.entries(data?.cache ?? {}).filter(([key, value]) =>
      /^[a-f0-9]{64}$/.test(key) && typeof value === "string" && value.trim()));
    this.limitCacheSize();
    this.addSettingTab(new CanvasTranslateSettingsTab(this.app, this));
    this.addCommand({
      id: "toggle-canvas-translation", name: "Toggle Japanese / English in the active Canvas",
      checkCallback: checking => {
        if (!this.getActiveCanvasLeaf() && !this.enabled) return false;
        if (!checking) void this.toggle();
        return true;
      }
    });
    this.addCommand({
      id: "show-original-canvas", name: "Show original Japanese (stop translation and unlock editing)",
      callback: () => { this.enabled = false; void this.rebind(); }
    });
    this.addCommand({
      id: "retry-canvas-translation", name: "Retry untranslated Canvas text",
      checkCallback: checking => {
        if (!this.session || !this.enabled) return false;
        if (!checking) {
          this.session.lastError = ""; this.session.notifiedFatal = false;
          this.session.queue.retryFailed(); this.scheduleScan(this.session, 0);
        }
        return true;
      }
    });
    this.addCommand({ id: "translation-status", name: "Show translation status", callback: () => this.showDiagnostics() });
    this.ribbonEl = this.addRibbonIcon("languages", "Toggle Canvas translation", () => { void this.toggle(); });
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    this.statusEl.addEventListener("click", () => { void this.toggle(); });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      const root = this.getActiveCanvasLeaf()?.view.containerEl;
      if (this.enabled && this.session?.root !== root) void this.rebind();
    }));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.pruneOriginalViews()));
    this.refreshStatus();
  }

  onunload(): void {
    this.shuttingDown = true; this.enabled = false; this.transitionId++;
    const previous = this.session; this.session = null;
    if (previous) void this.closeSession(previous).catch(() => {
      new Notice("Canvas translation could not restore a Notion card. Reload that card or restart Obsidian.", 9000);
    });
    for (const original of this.originalViews.values()) original.destroy();
    this.originalViews.clear();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    void this.saveState();
  }
  async saveSettings(restart = false): Promise<void> {
    await this.saveState();
    if (restart && this.enabled) await this.rebind();
  }
  async useFastPreset(): Promise<void> {
    this.settings.model = "gpt-6-luna"; this.settings.concurrency = 3;
    await this.saveSettings(true);
    new Notice("Fast / low-cost preset: GPT-6 Luna, no reasoning, 3 parallel requests.");
  }
  clearCache(): void {
    this.cache = {}; this.queueSave();
    if (this.enabled) void this.rebind();
    new Notice("Translation cache cleared. Current content will be translated again.");
  }
  private getActiveCanvasLeaf(): WorkspaceLeaf | null {
    const leaf = this.app.workspace.activeLeaf;
    return leaf?.view.getViewType() === "canvas" ? leaf : null;
  }
  private async toggle(): Promise<void> {
    if (!this.enabled) {
      if (!this.getActiveCanvasLeaf()) { new Notice("Open an Obsidian Canvas first."); return; }
      if (!this.settings.apiSecretName || !this.app.secretStorage.getSecret(this.settings.apiSecretName)) {
        new Notice("Choose an OpenAI API key in Canvas Live Translate settings first.", 7000); return;
      }
    }
    this.enabled = !this.enabled;
    await this.rebind();
  }

  /** Serialize OFF/ON and tab changes: old webview restoration must finish first. */
  private rebind(): Promise<void> {
    this.pruneOriginalViews();
    const ticket = ++this.transitionId;
    this.transitioning = true; this.refreshStatus();
    this.transitionWork = this.transitionWork.catch(() => {}).then(async () => {
      if (ticket !== this.transitionId || this.shuttingDown) return;
      const previous = this.session; this.session = null;
      try {
        if (previous) await this.closeSession(previous);
        for (const controller of this.pendingRestores) {
          const restored = await controller.restoreOriginals();
          if (restored.failed) throw new Error("A Notion card could not restore its original view.");
          this.pendingRestores.delete(controller);
        }
        this.restoreError = "";
        if (ticket !== this.transitionId || this.shuttingDown) return;
        const leaf = this.getActiveCanvasLeaf();
        if (!this.enabled) {
          // The explicit original-view command also repairs host snapshots
          // when no active translation session remains to tear down.
          if (leaf && leaf.view.containerEl !== previous?.root) this.restoreNativeCanvas(leaf.view);
          return;
        }
        if (leaf) this.session = this.createSession(leaf);
      } catch (error) {
        this.enabled = false;
        this.restoreError = error instanceof Error ? error.message : "A translated web card could not be restored.";
        new Notice(`${this.restoreError} Reload the affected web card or restart Obsidian.`, 10000);
      } finally {
        if (ticket === this.transitionId) this.transitioning = false;
        this.refreshStatus();
      }
    });
    return this.transitionWork;
  }

  private createSession(leaf: WorkspaceLeaf): CanvasSession {
    const root = leaf.view.containerEl;
    this.originalViews.get(root)?.destroy();
    this.originalViews.delete(root);
    const settings = { ...this.settings };
    const presentation = new CanvasPresentation(root);
    // Clean up layers that the host might have duplicated/reparented.
    new CanvasPresentation(root).destroy();
    root.classList.add("canvas-live-translate-enabled");
    const session: CanvasSession = {
      root, view: leaf.view, settings, presentation, web: null, nativeTargets: new Map(), webTargets: new Map(), keyPromises: new Map(),
      timer: null, scanning: false, scanAgain: false, webScanning: false, destroyed: false,
      lastError: "", notifiedFatal: false, notionStatus: null, onScroll: () => this.scheduleScan(session)
    } as CanvasSession;
    session.interaction = createReadOnlyCanvasController(root, leaf.view, () => this.scheduleScan(session));
    session.queue = new TranslationQueue({
      concurrency: settings.concurrency,
      translate: async (parts, signal) => {
        const key = this.app.secretStorage.getSecret(settings.apiSecretName);
        if (!key) throw new TranslationError("OpenAI API key is missing. Choose a key in settings.", { fatal: true, retryable: false });
        return translateWithOpenAI(key, settings.model, settings.targetLanguage, settings.glossary, parts, { signal });
      },
      getCached: key => this.cache[key],
      cacheResult: (key, value) => {
        if (!this.isCurrent(session)) return;
        this.cache[key] = value;
        if (++this.cacheWritesSinceTrim >= 100) { this.limitCacheSize(); this.cacheWritesSinceTrim = 0; }
        this.queueSave();
      },
      onProgress: () => { if (this.isCurrent(session)) this.refreshStatus(); },
      onError: (error, fatal) => {
        if (!this.isCurrent(session)) return;
        session.lastError = error.message;
        if (fatal && !session.notifiedFatal) {
          session.notifiedFatal = true;
          new Notice(`Canvas translation paused: ${error.message} Fix the setting, then run Retry untranslated Canvas text.`, 10000);
        }
        this.refreshStatus();
      }
    });
    if (settings.translateNotion) {
      session.web = new NotionWebviewController(root, {
        onChange: () => this.scheduleScan(session),
        onStatus: status => {
          if (!this.isCurrent(session)) return;
          session.notionStatus = status; this.refreshStatus();
        }
      });
    }
    session.observer = new MutationObserver(records => {
      if (records.some(record => !presentation.isOwnMutation(record))) this.scheduleScan(session);
    });
    session.observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "contenteditable"] });
    root.addEventListener("scroll", session.onScroll, { capture: true, passive: true });
    root.addEventListener("wheel", session.onScroll, { passive: true });
    this.scheduleScan(session, 0);
    return session;
  }
  private isCurrent(session: CanvasSession): boolean {
    return !this.shuttingDown && this.enabled && !session.destroyed && this.session === session;
  }
  private async closeSession(session: CanvasSession): Promise<void> {
    session.destroyed = true; session.observer.disconnect();
    if (session.timer !== null) window.clearTimeout(session.timer);
    session.root.removeEventListener("scroll", session.onScroll, true);
    session.root.removeEventListener("wheel", session.onScroll);
    session.queue.destroy();
    // Native preview renderers can retain/reparent descendants of a clone.
    // Restore our exact tracked writes before releasing those DOM references.
    for (const [node, target] of session.nativeTargets) this.restoreNativeTarget(node, target);
    session.presentation.destroy(); session.interaction.destroy();
    session.root.classList.remove("canvas-live-translate-enabled");
    session.nativeTargets.clear(); session.webTargets.clear(); session.keyPromises.clear();
    this.restoreNativeCanvas(session.view);
    if (session.web) {
      this.pendingRestores.add(session.web);
      const result = await session.web.destroy();
      if (result.failed) throw new Error("A Notion card could not restore its original view.");
      this.pendingRestores.delete(session.web);
    }
  }
  private restoreNativeTarget(node: Text, target: NativeTarget): void {
    target.unsubscribe?.();
    if (target.translated !== undefined && node.data === target.translated) node.data = target.source;
  }
  private restoreNativeCanvas(view: WorkspaceLeaf["view"]): void {
    const root = view.containerEl;
    const existing = this.originalViews.get(root);
    if (existing) existing.restore();
    else this.originalViews.set(root, createOriginalCanvasView(root, view));
    this.pruneOriginalViews();
  }
  private pruneOriginalViews(): void {
    const workspace = this.app.workspace;
    if (typeof workspace.getLeavesOfType !== "function") return;
    const liveRoots = new Set(workspace.getLeavesOfType("canvas").map(leaf => leaf.view.containerEl));
    for (const [root, controller] of this.originalViews) {
      if (liveRoots.has(root)) continue;
      controller.destroy(); this.originalViews.delete(root);
    }
  }
  private scheduleScan(session: CanvasSession, delay = 120): void {
    if (session.destroyed || !this.enabled || session.timer !== null) return;
    session.timer = window.setTimeout(() => {
      session.timer = null;
      if (this.isCurrent(session)) void this.scanCanvas(session);
    }, delay);
  }
  private async scanCanvas(session: CanvasSession): Promise<void> {
    if (!this.isCurrent(session)) return;
    if (session.scanning) { session.scanAgain = true; return; }
    session.scanning = true;
    try {
      session.interaction.refresh(); session.presentation.refresh(); session.interaction.refresh();
      for (const [node, target] of session.nativeTargets) {
        if (!session.root.contains(node) || !node.parentElement?.closest(PRESENTATION_SELECTOR) ||
            (node.data !== target.source && node.data !== target.translated)) {
          this.restoreNativeTarget(node, target); session.nativeTargets.delete(node);
        }
      }
      const candidates = findTranslatableNodes(session.root, true)
        .filter(node => !session.nativeTargets.has(node))
        .map(node => ({ node, priority: translationPriority(node, session.root) }))
        .sort((a, b) => b.priority - a.priority);
      await Promise.all(candidates.slice(0, 600).map(async ({ node, priority }) => {
        if (!this.isCurrent(session)) return;
        const source = node.data;
        const { prefix, core, suffix } = splitWhitespace(source);
        const target: NativeTarget = { source };
        session.nativeTargets.set(node, target);
        const context = extractContext(node, child => session.nativeTargets.get(child)?.source ?? child.data);
        const part = { source: core, context };
        const key = await this.cacheKey(session, part);
        target.key = key;
        const current = () => this.isCurrent(session) && session.root.contains(node) &&
          Boolean(node.parentElement?.closest(PRESENTATION_SELECTOR)) && !isEditableOrProtected(node) &&
          session.nativeTargets.get(node) === target && (node.data === source || node.data === target.translated);
        if (!current()) { session.nativeTargets.delete(node); return; }
        target.unsubscribe = session.queue.enqueue({ key, part, priority, isCurrent: current,
          onResult: value => {
            if (!current()) return;
            target.translated = `${prefix}${value}${suffix}`;
            session.presentation.setTranslation(node, target.translated, current);
          }
        });
      }));
      const priorities = new Map<string, number>();
      for (const [node, target] of session.nativeTargets) {
        if (target.key && session.root.contains(node)) {
          priorities.set(target.key, Math.max(priorities.get(target.key) ?? 0, translationPriority(node, session.root)));
        }
      }
      for (const item of session.webTargets.values()) priorities.set(item.key, Math.max(priorities.get(item.key) ?? 0, 70));
      session.queue.setPriorities(priorities);
      if (candidates.length > 600) session.scanAgain = true;
      if (session.web && !session.webScanning) void this.scanWeb(session);
    } catch (error) {
      session.lastError = error instanceof Error ? error.message : "Could not scan Canvas content.";
      this.refreshStatus();
    } finally {
      session.scanning = false;
      if (session.scanAgain) { session.scanAgain = false; this.scheduleScan(session); }
    }
  }
  private async scanWeb(session: CanvasSession): Promise<void> {
    if (!session.web || !this.isCurrent(session)) return;
    session.webScanning = true;
    try {
      for (const [id, item] of session.webTargets) {
        if (!item.target.isCurrent()) { item.unsubscribe(); session.webTargets.delete(id); }
      }
      const targets = await session.web.collect();
      if (!this.isCurrent(session)) return;
      await Promise.all(targets.map(async target => {
        if (session.webTargets.has(target.id)) return;
        const { prefix, core, suffix } = splitWhitespace(target.source);
        const part = { source: core, context: target.context === core ? "" : target.context };
        const key = await this.cacheKey(session, part);
        const current = () => this.isCurrent(session) && target.isCurrent();
        if (!current() || session.webTargets.has(target.id)) return;
        const unsubscribe = session.queue.enqueue({ key, part, priority: 70, isCurrent: current,
          onResult: async value => {
            if (!current()) return;
            const applied = await target.apply(`${prefix}${value}${suffix}`);
            if (!applied && this.isCurrent(session)) {
              session.webTargets.get(target.id)?.unsubscribe();
              session.webTargets.delete(target.id); this.scheduleScan(session);
            }
          }
        });
        session.webTargets.set(target.id, { key, target, unsubscribe });
      }));
    } catch (error) {
      if (this.isCurrent(session)) {
        session.lastError = error instanceof Error ? error.message : "Could not read a Notion web card.";
        this.refreshStatus();
      }
    } finally { session.webScanning = false; }
  }
  private cacheKey(session: CanvasSession, part: TranslationPart): Promise<string> {
    const identity = JSON.stringify([part.source, part.context]);
    let key = session.keyPromises.get(identity);
    if (!key) {
      const { model, targetLanguage, glossary } = session.settings;
      key = makeCacheKey(model, targetLanguage, glossary, part); session.keyPromises.set(identity, key);
    }
    return key;
  }
  private refreshStatus(): void {
    if (!this.statusEl) return;
    const stats = this.session?.queue.stats;
    let label = "Canvas: JA";
    if (this.transitioning) label = this.enabled ? "Canvas: preparing…" : "Canvas: restoring…";
    else if (this.restoreError) label = "Canvas: restore error";
    else if (this.enabled && !this.session) label = "Canvas: EN (inactive)";
    else if (stats?.paused) label = "Canvas: EN · paused";
    else if (this.enabled && stats) label = `Canvas: EN 🔒${stats.pending ? ` ${stats.completed}/${stats.total}` : ""}${stats.failed ? ` · ${stats.failed} failed` : ""}`;
    const notion = this.session?.notionStatus;
    if (notion?.unsupported) label += " · Notion unsupported";
    if (notion?.failed) label += ` · Notion ${notion.failed} failed`;
    else if (notion?.loading) label += " · Notion loading";
    this.statusEl.setText(label); this.statusEl.setAttribute("title", this.diagnosticText());
    this.statusEl.setAttribute("aria-label", this.enabled ? "Show original Japanese and unlock editing" : "Show read-only English translation");
    this.ribbonEl?.setAttribute("aria-pressed", String(this.enabled));
  }
  private diagnosticText(): string {
    const session = this.session, stats = session?.queue.stats, web = session?.notionStatus;
    return [
      `Canvas Live Translate ${this.manifest.version}`,
      `Mode: ${this.transitioning ? "switching" : this.enabled ? "translated / read-only" : "original"}`,
      `Model: ${session?.settings.model ?? this.settings.model}`,
      `Parallel requests: ${session?.settings.concurrency ?? this.settings.concurrency}`,
      stats ? `Unique parts: ${stats.total}; translated: ${stats.completed}; pending: ${stats.pending}; failed: ${stats.failed}; active: ${stats.activeRequests}` : "No active translation queue.",
      web ? `Notion cards: ${web.found}; ready: ${web.ready}; loading: ${web.loading}; unsupported: ${web.unsupported}; failed: ${web.failed}${web.truncated ? "; more content on subsequent scans" : ""}` : "Notion: not scanned or disabled.",
      this.restoreError || session?.lastError ? `Last issue: ${this.restoreError || session?.lastError}` : "No reported issue.",
      "Switch to Japanese to edit. Use Retry untranslated Canvas text for remaining failures."
    ].join("\n");
  }
  private showDiagnostics(): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText("Canvas translation status");
    modal.contentEl.createEl("pre", { text: this.diagnosticText(), cls: "clt-diagnostics" }); modal.open();
  }
  private limitCacheSize(): void {
    const keys = Object.keys(this.cache);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CACHE_ENTRIES))) delete this.cache[key];
  }
  private queueSave(): void {
    if (this.shuttingDown) return;
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.saveState(); }, 1200);
  }
  private async saveState(): Promise<void> {
    this.limitCacheSize();
    await this.saveData({ settings: this.settings, cache: this.cache } satisfies SavedState);
  }
}

class CanvasTranslateSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: CanvasLiveTranslate) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h2", { text: "Canvas Live Translate" });
    containerEl.createEl("p", { text: "English mode is read-only and scrollable. A removable translation layer is displayed; original .md / .canvas text and Notion content are not edited. Toggle to Japanese to edit." });
    containerEl.createEl("p", { text: "Native card text and supported, open Notion web-card text are sent to the OpenAI API while translation is ON. API usage has costs. Existing translations are cached locally." });
    new Setting(containerEl).setName("OpenAI API key")
      .setDesc("Choose an Obsidian SecretStorage secret. No API key is saved in data.json or sent into a web page.")
      .addComponent(element => new SecretComponent(this.app, element).setValue(this.plugin.settings.apiSecretName)
        .onChange(async value => { this.plugin.settings.apiSecretName = value ?? ""; await this.plugin.saveSettings(true); }));
    new Setting(containerEl).setName("Fast / low-cost preset")
      .setDesc("GPT-6 Luna with reasoning disabled and 3 concurrent requests.")
      .addButton(button => button.setButtonText("Use fast preset").onClick(async () => { await this.plugin.useFastPreset(); this.display(); }));
    new Setting(containerEl).setName("OpenAI model")
      .setDesc("Default: gpt-6-luna. Custom models need Chat Completions and strict structured outputs. Apply text-setting changes by toggling OFF and ON.")
      .addText(component => component.setPlaceholder("gpt-6-luna").setValue(this.plugin.settings.model)
        .onChange(async value => { this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Parallel requests")
      .setDesc("3 is the default. Increase only if your API rate limits allow it; higher does not guarantee lower latency.")
      .addDropdown(component => {
        for (let value = 1; value <= 6; value++) component.addOption(String(value), String(value));
        component.setValue(String(this.plugin.settings.concurrency)).onChange(async value => {
          this.plugin.settings.concurrency = Number(value); await this.plugin.saveSettings(true);
        });
      });
    new Setting(containerEl).setName("Translate Notion web cards")
      .setDesc("For Add web page cards on notion.so / notion.site / notion.com, using the existing desktop webview. No Notion token or separate server. Inaccessible iframes are reported as unsupported. Images and PDFs are excluded.")
      .addToggle(component => component.setValue(this.plugin.settings.translateNotion).onChange(async value => {
        this.plugin.settings.translateNotion = value; await this.plugin.saveSettings(true);
      }));
    new Setting(containerEl).setName("Target language").setDesc("Source detection is Japanese.")
      .addText(component => component.setValue(this.plugin.settings.targetLanguage).onChange(async value => {
        this.plugin.settings.targetLanguage = value.trim() || "English"; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("Terminology and style").setDesc("Keep technical terms consistent across research notes.")
      .addTextArea(component => component.setValue(this.plugin.settings.glossary).onChange(async value => {
        this.plugin.settings.glossary = value; await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("Clear translation cache")
      .setDesc("Re-translates current content. Changed source text already has its own cache key.")
      .addButton(button => button.setButtonText("Clear cache").onClick(() => this.plugin.clearCache()));
  }
}
