/** Minimal test-only host. No network, key storage, or vault writes are real. */
export interface MockRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
export interface MockResponse {
  status: number;
  text: string;
  headers: Record<string, string>;
}

export function installElementHelpers(window: any): void {
  const prototype = window.HTMLElement.prototype;
  prototype.addClass = function (...names: string[]) { this.classList.add(...names); };
  prototype.removeClass = function (...names: string[]) { this.classList.remove(...names); };
  prototype.setText = function (value: string) { this.textContent = value; };
  prototype.empty = function () { this.replaceChildren(); };
  prototype.createEl = function (tag: string, options: { text?: string; cls?: string } = {}) {
    const child = this.ownerDocument.createElement(tag);
    if (options.text !== undefined) child.textContent = options.text;
    if (options.cls) child.className = options.cls;
    this.appendChild(child);
    return child;
  };
}

export function createObsidianMock(document: Document, configuration: {
  loadData?: unknown;
  request: (request: MockRequest) => Promise<MockResponse>;
}) {
  const state = {
    commands: new Map<string, any>(),
    settingsTabs: [] as any[],
    notices: [] as string[],
    saves: [] as any[],
    vaultWrites: [] as string[],
    registeredEvents: [] as { off: () => void }[],
    controls: [] as any[],
    status: null as HTMLElement | null,
    ribbon: null as HTMLElement | null
  };
  const events = new Map<string, Set<(...args: any[]) => void>>();
  const workspace = {
    activeLeaf: null as any,
    on(name: string, callback: (...args: any[]) => void) {
      let listeners = events.get(name);
      if (!listeners) { listeners = new Set(); events.set(name, listeners); }
      listeners.add(callback);
      return { off: () => listeners!.delete(callback) };
    },
    emit(name: string, ...args: any[]) { events.get(name)?.forEach(callback => callback(...args)); }
  };
  const app = {
    document,
    workspace,
    secretStorage: { getSecret: (name: string) => name === "test-openai" ? "unit-test-not-a-real-key" : undefined },
    vault: {
      modify: () => { state.vaultWrites.push("modify"); throw new Error("Forbidden test vault write"); },
      create: () => { state.vaultWrites.push("create"); throw new Error("Forbidden test vault write"); },
      append: () => { state.vaultWrites.push("append"); throw new Error("Forbidden test vault write"); }
    }
  };

  class Plugin {
    app: typeof app;
    manifest: { version: string };
    constructor(receivedApp: typeof app, manifest = { version: "0.2.0-test" }) {
      this.app = receivedApp;
      this.manifest = manifest;
    }
    async loadData() { return configuration.loadData ?? null; }
    async saveData(data: unknown) { state.saves.push(JSON.parse(JSON.stringify(data))); }
    addSettingTab(tab: unknown) { state.settingsTabs.push(tab); }
    addCommand(command: any) { state.commands.set(command.id, command); }
    addRibbonIcon(_icon: string, title: string, callback: () => void) {
      const button = document.createElement("button");
      button.title = title;
      button.addEventListener("click", callback);
      document.body.appendChild(button);
      state.ribbon = button;
      return button;
    }
    addStatusBarItem() {
      const element = document.createElement("span");
      document.body.appendChild(element);
      state.status = element;
      return element;
    }
    registerEvent(reference: { off: () => void }) { state.registeredEvents.push(reference); }
    unload() {
      (this as any).onunload?.();
      state.registeredEvents.splice(0).forEach(reference => reference.off());
    }
  }
  class PluginSettingTab {
    containerEl = document.createElement("div");
    constructor(public app: unknown, public plugin: unknown) {}
  }
  class Notice { constructor(text: string) { state.notices.push(String(text)); } }
  class Modal {
    titleEl = document.createElement("h1");
    contentEl = document.createElement("div");
    constructor(_app: unknown) {}
    open() { document.body.append(this.titleEl, this.contentEl); }
  }
  class Control {
    value: unknown;
    label = "";
    options = new Map<string, string>();
    change?: (value: any) => unknown;
    click?: () => unknown;
    setValue(value: unknown) { this.value = value; return this; }
    setPlaceholder(_value: string) { return this; }
    setButtonText(value: string) { this.label = value; return this; }
    addOption(key: string, text: string) { this.options.set(key, text); return this; }
    onChange(callback: (value: any) => unknown) { this.change = callback; return this; }
    onClick(callback: () => unknown) { this.click = callback; return this; }
  }
  class SecretComponent extends Control { constructor(_app: unknown, _element: unknown) { super(); } }
  class Setting {
    name = "";
    constructor(public containerEl: HTMLElement) {}
    setName(name: string) { this.name = name; return this; }
    setDesc(_description: string) { return this; }
    private control(kind: string, callback: (component: Control) => unknown) {
      const control = new Control();
      callback(control);
      state.controls.push({ name: this.name, kind, control });
      return this;
    }
    addComponent(callback: (element: HTMLElement) => unknown) { callback(document.createElement("div")); return this; }
    addText(callback: (component: Control) => unknown) { return this.control("text", callback); }
    addTextArea(callback: (component: Control) => unknown) { return this.control("textarea", callback); }
    addToggle(callback: (component: Control) => unknown) { return this.control("toggle", callback); }
    addDropdown(callback: (component: Control) => unknown) { return this.control("dropdown", callback); }
    addButton(callback: (component: Control) => unknown) { return this.control("button", callback); }
  }

  return {
    app,
    state,
    module: { Plugin, PluginSettingTab, Notice, Modal, Setting, SecretComponent, App: class {}, WorkspaceLeaf: class {}, requestUrl: configuration.request }
  };
}
