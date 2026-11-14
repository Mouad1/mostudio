import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProbeResult, SettingField } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { mount } from "./settings.ts";

class MockNode {
  parentNode: MockNode | null = null;
  childNodes: (MockElement | MockTextNode)[] = [];

  get children(): MockElement[] {
    return this.childNodes.filter((c): c is MockElement => c instanceof MockElement);
  }

  appendChild<T extends MockNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child as any);
    return child;
  }

  replaceChildren(...nodes: (MockNode | string | null | undefined | false)[]) {
    this.childNodes = [];
    for (const n of nodes) {
      if (!n) continue;
      if (typeof n === "string") {
        this.appendChild(new MockTextNode(n));
      } else {
        this.appendChild(n as any);
      }
    }
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.childNodes = [new MockTextNode(v)];
  }
}

class MockTextNode extends MockNode {
  text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  override get textContent(): string {
    return this.text;
  }
  override set textContent(v: string) {
    this.text = v;
  }
}

class MockElement extends MockNode {
  tagName: string;
  attributes: Record<string, string> = {};
  eventListeners: Record<string, Function[]> = {};
  value: string = "";
  checked: boolean = false;
  disabled: boolean = false;
  type: string = "text";

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name === "value") this.value = value;
    if (name === "type") this.type = value;
    if (name === "disabled") this.disabled = true;
    if (name === "checked") this.checked = true;
  }

  getAttribute(name: string): string | null {
    if (name === "disabled") return this.disabled ? "" : null;
    if (name === "checked") return this.checked ? "" : null;
    if (name === "value") return this.value;
    if (name === "type") return this.type;
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
    if (name === "disabled") this.disabled = false;
    if (name === "checked") this.checked = false;
  }

  get className(): string {
    return this.attributes["class"] || "";
  }
  set className(v: string) {
    this.attributes["class"] = v;
  }

  classList = {
    add: (...cls: string[]) => {
      const cur = new Set((this.attributes["class"] || "").split(" ").filter(Boolean));
      cls.forEach((c) => cur.add(c));
      this.attributes["class"] = Array.from(cur).join(" ");
    },
    remove: (...cls: string[]) => {
      const cur = new Set((this.attributes["class"] || "").split(" ").filter(Boolean));
      cls.forEach((c) => cur.delete(c));
      this.attributes["class"] = Array.from(cur).join(" ");
    },
    toggle: (cls: string) => {
      const cur = new Set((this.attributes["class"] || "").split(" ").filter(Boolean));
      if (cur.has(cls)) cur.delete(cls);
      else cur.add(cls);
      this.attributes["class"] = Array.from(cur).join(" ");
      return cur.has(cls);
    },
    contains: (cls: string) => {
      const cur = new Set((this.attributes["class"] || "").split(" ").filter(Boolean));
      return cur.has(cls);
    },
  };

  addEventListener(name: string, fn: Function) {
    this.eventListeners[name] = this.eventListeners[name] || [];
    this.eventListeners[name]!.push(fn);
  }

  removeEventListener(name: string, fn: Function) {
    this.eventListeners[name] = (this.eventListeners[name] || []).filter((f) => f !== fn);
  }

  dispatchEvent(event: { type: string; [key: string]: any }): boolean {
    const list = this.eventListeners[event.type] || [];
    for (const fn of list) {
      fn(event);
    }
    return true;
  }

  click() {
    this.dispatchEvent({ type: "click" });
  }

  querySelector(selector: string): MockElement | null {
    const all = this.querySelectorAll(selector);
    return all[0] ?? null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const traverse = (el: MockElement) => {
      for (const child of el.children) {
        if (this.matchesSelector(child, selector)) {
          results.push(child);
        }
        traverse(child);
      }
    };
    traverse(this);
    return results;
  }

  private matchesSelector(el: MockElement, selector: string): boolean {
    if (selector.includes("[")) {
      const tagMatch = selector.match(/^([a-zA-Z0-9_-]+)\[/);
      if (tagMatch && el.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) {
        return false;
      }
      return this.matchesAttr(el, selector);
    }
    if (selector.startsWith("#")) {
      return el.getAttribute("id") === selector.slice(1);
    }
    if (selector.startsWith(".")) {
      return el.classList.contains(selector.slice(1));
    }
    if (selector.includes(".")) {
      const parts = selector.split(".");
      const tag = parts[0];
      const classes = parts.slice(1);
      if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
      for (const c of classes) {
        if (!el.classList.contains(c)) return false;
      }
      return true;
    }
    return el.tagName.toLowerCase() === selector.toLowerCase();
  }

  private matchesAttr(el: MockElement, selector: string): boolean {
    const match = selector.match(/\[([^=\]]+)(?:=['"]?([^'"\]]+)['"]?)?\]/);
    if (!match) return false;
    const attrName = match[1]!;
    const attrVal = match[2];
    const actual = el.getAttribute(attrName);
    if (actual === null) return false;
    if (attrVal === undefined) return true;
    return actual === attrVal;
  }
}

function setupDOM() {
  (globalThis as any).Node = MockNode;
  (globalThis as any).HTMLElement = MockElement;
  (globalThis as any).HTMLInputElement = MockElement;
  (globalThis as any).document = {
    createElement(tag: string) {
      return new MockElement(tag);
    },
    createTextNode(text: string) {
      return new MockTextNode(text);
    },
  };
}

const SAMPLE_FIELDS: SettingField[] = [
  {
    name: "GROQ_API_KEY",
    kind: "secret",
    providers: ["groq"],
    label: "Groq key",
    help: "Free. Used for transcription and AI steps.",
    getKeyUrl: "https://console.groq.com/keys",
    recommended: true,
    source: "app",
    masked: "••••1234",
  },
  {
    name: "GEMINI_API_KEY",
    kind: "secret",
    providers: ["gemini"],
    label: "Google Gemini key",
    help: "Free. Used for AI steps.",
    getKeyUrl: "https://aistudio.google.com/apikey",
    recommended: true,
    source: "unset",
    masked: "",
  },
  {
    name: "MISTRAL_API_KEY",
    kind: "secret",
    providers: ["mistral"],
    label: "Mistral key",
    help: "Optional backup provider.",
    recommended: false,
    source: "process",
    masked: "••••5678",
  },
  {
    name: "WHISPER_MODELS_DIR",
    kind: "path",
    providers: ["whisper-cpp"],
    label: "Whisper models directory",
    help: "Directory containing ggml-*.bin models for local Whisper.",
    recommended: false,
    source: "unset",
    masked: "",
  },
];

function createMockApi(overrides: Partial<Api> = {}): Api {
  return {
    get: async <T>(path: string): Promise<T> => {
      if (path === "/api/settings") {
        return {
          keysFile: "/Users/test/.env",
          fields: SAMPLE_FIELDS,
          animatedCaptions: false,
        } as unknown as T;
      }
      throw new Error(`Unexpected GET ${path}`);
    },
    send: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      throw new Error(`Unexpected ${method} ${path}`);
    },
    text: async () => "",
    putText: async () => {},
    upload: () => ({ done: Promise.resolve({} as any), abort: () => {} }),
    events: () => () => {},
    fileUrl: () => "",
    ...overrides,
  };
}

test("mount fetches settings and renders header and recommended/more sections", async () => {
  setupDOM();
  const root = new MockElement("div");
  const api = createMockApi();

  const cleanup = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(root.textContent.includes("Your keys stay on this Mac, in /Users/test/.env."));
  assert.ok(root.textContent.includes("Recommended"));
  assert.ok(root.textContent.includes("More providers"));

  // Check recommended groups
  const geminiCard = root.querySelector("[data-provider='gemini']");
  assert.ok(geminiCard, "Gemini card rendered");
  const groqCard = root.querySelector("[data-provider='groq']");
  assert.ok(groqCard, "Groq card rendered");

  // Check more providers inside details
  const details = root.querySelector("details");
  assert.ok(details, "Details tag for more providers rendered");
  const mistralCard = details.querySelector("[data-provider='mistral']");
  assert.ok(mistralCard, "Mistral card rendered inside details");

  cleanup();
});

test("provider card displays masked value or Not set, source text and Get a key link", async () => {
  setupDOM();
  const root = new MockElement("div");
  const api = createMockApi();

  const cleanup = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  const groqCard = root.querySelector("[data-provider='groq']")!;
  assert.ok(groqCard.textContent.includes("••••1234"));
  assert.ok(groqCard.textContent.includes("Saved in mostudio"));
  const groqLink = groqCard.querySelector("a[href='https://console.groq.com/keys']");
  assert.ok(groqLink, "Get a key link exists for groq");
  assert.equal(groqLink.getAttribute("target"), "_blank");

  const geminiCard = root.querySelector("[data-provider='gemini']")!;
  assert.ok(geminiCard.textContent.includes("Not set"));

  cleanup();
});

test("Change button reveals password input with show/hide toggle", async () => {
  setupDOM();
  const root = new MockElement("div");
  const api = createMockApi();

  const cleanup = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  const groqCard = root.querySelector("[data-provider='groq']")!;
  const changeBtn = groqCard.querySelector(".change-btn")!;
  assert.ok(changeBtn, "Change button exists");

  changeBtn.click();

  const secretInput = groqCard.querySelector("input[type='password']") || groqCard.querySelector(".secret-input");
  assert.ok(secretInput, "Password input revealed");
  assert.equal(secretInput.getAttribute("autocomplete"), "off");
  assert.equal(secretInput.getAttribute("spellcheck"), "false");

  const toggleBtn = groqCard.querySelector(".toggle-visibility-btn")!;
  assert.ok(toggleBtn, "Show/Hide toggle button exists");
  assert.equal(toggleBtn.textContent, "Show");

  toggleBtn.click();
  assert.equal(secretInput.getAttribute("type"), "text");
  assert.equal(toggleBtn.textContent, "Hide");

  toggleBtn.click();
  assert.equal(secretInput.getAttribute("type"), "password");
  assert.equal(toggleBtn.textContent, "Show");

  cleanup();
});

test("Reveal button is only rendered for source === 'app' and reveals value for 30s", async () => {
  setupDOM();
  let revealedName = "";
  const root = new MockElement("div");
  const api = createMockApi({
    send: async <T>(method: string, path: string, body?: any): Promise<T> => {
      if (method === "POST" && path === "/api/settings/reveal") {
        revealedName = body.name;
        return { value: "gsk_live_secret_key" } as unknown as T;
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  });

  const cleanup = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  // Groq has source "app", so Reveal button should exist
  const groqCard = root.querySelector("[data-provider='groq']")!;
  const groqRevealBtn = groqCard.querySelector(".reveal-btn");
  assert.ok(groqRevealBtn, "Groq has reveal button");

  // Gemini has source "unset", so Reveal button should NOT exist
  const geminiCard = root.querySelector("[data-provider='gemini']")!;
  const geminiRevealBtn = geminiCard.querySelector(".reveal-btn");
  assert.equal(geminiRevealBtn, null, "Gemini does not have reveal button");

  // Click Groq reveal
  groqRevealBtn!.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(revealedName, "GROQ_API_KEY");
  assert.ok(groqCard.textContent.includes("gsk_live_secret_key"));

  cleanup();
});

test("Test connection calls /api/settings/test with provider and dirty edits", async () => {
  setupDOM();
  let testedPayload: any = null;
  const root = new MockElement("div");
  const api = createMockApi({
    send: async <T>(method: string, path: string, body?: any): Promise<T> => {
      if (method === "POST" && path === "/api/settings/test") {
        testedPayload = body;
        return {
          provider: body.provider,
          ok: true,
          status: 200,
          message: "Groq responded in 120ms",
          ms: 120,
        } as unknown as T;
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  });

  const cleanup = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  const groqCard = root.querySelector("[data-provider='groq']")!;
  // Reveal input and type a new key
  const changeBtn = groqCard.querySelector(".change-btn")!;
  changeBtn.click();

  const secretInput = groqCard.querySelector(".secret-input")!;
  secretInput.setAttribute("value", "gsk_new_val");
  secretInput.value = "gsk_new_val";
  secretInput.dispatchEvent({ type: "input" });

  const testBtn = groqCard.querySelector(".test-connection-btn")!;
  assert.ok(testBtn, "Test connection button exists");
  testBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(testedPayload, {
    provider: "groq",
    values: { GROQ_API_KEY: "gsk_new_val" },
  });

  assert.ok(groqCard.textContent.includes("Groq responded in 120ms"));
  const resultEl = groqCard.querySelector(".test-result");
  assert.ok(resultEl);
  assert.ok(resultEl.classList.contains("test-result-success"));

  cleanup();
});

test("Animated captions toggle and sticky Save changes bar", async () => {
  setupDOM();
  let savedPayload: any = null;
  const root = new MockElement("div");
  const api = createMockApi({
    send: async <T>(method: string, path: string, body?: any): Promise<T> => {
      if (method === "PUT" && path === "/api/settings") {
        savedPayload = body;
        return {
          keysFile: "/Users/test/.env",
          fields: SAMPLE_FIELDS,
          animatedCaptions: body.animatedCaptions ?? false,
        } as unknown as T;
      }
      throw new Error(`Unexpected ${method} ${path}`);
    },
  });

  const cleanup = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  const saveBar = root.querySelector(".settings-save-bar");
  assert.ok(saveBar, "Save bar exists");
  assert.ok(saveBar.classList.contains("hidden"), "Save bar initially hidden");

  const switchInput = root.querySelector(".animated-captions-switch")!;
  assert.ok(switchInput, "Animated captions switch exists");
  assert.ok(
    root.textContent.includes("Moving word-by-word captions. Needs internet the first time and takes longer to render.")
  );

  // Toggle switch
  switchInput.checked = true;
  switchInput.dispatchEvent({ type: "change" });

  assert.ok(!saveBar.classList.contains("hidden"), "Save bar visible after toggle");

  const saveBtn = saveBar.querySelector(".save-changes-btn")!;
  assert.ok(saveBtn, "Save changes button exists");
  saveBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(savedPayload, {
    animatedCaptions: true,
  });

  cleanup();
});
