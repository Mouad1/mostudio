import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check } from "../../../core/src/index.ts";
import type { SetupState } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { mount } from "./setup.ts";

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
  disabled: boolean = false;
  type: string = "";

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name === "type") this.type = value;
    if (name === "value") this.value = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
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
    contains: (cls: string) => {
      const cur = new Set((this.attributes["class"] || "").split(" ").filter(Boolean));
      return cur.has(cls);
    },
  };

  addEventListener(name: string, fn: Function) {
    this.eventListeners[name] = this.eventListeners[name] || [];
    this.eventListeners[name]!.push(fn);
  }

  click() {
    const fns = this.eventListeners["click"] || [];
    for (const fn of fns) {
      fn({ target: this, preventDefault: () => {} });
    }
  }

  querySelector(selector: string): MockElement | null {
    const all = this.querySelectorAll(selector);
    return all[0] ?? null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const parts = selector.split(",").map((s) => s.trim());
    const results: MockElement[] = [];

    const matchesOne = (el: MockElement, sel: string): boolean => {
      if (sel.startsWith(".")) {
        return el.classList.contains(sel.slice(1));
      }
      if (sel.startsWith("#")) {
        return el.getAttribute("id") === sel.slice(1);
      }
      if (sel.includes("[")) {
        const m = sel.match(/\[([a-zA-Z0-9_-]+)(?:=['"](.*)['"])?\]/);
        if (m) {
          const attr = m[1]!;
          const val = m[2];
          if (val !== undefined) return el.getAttribute(attr) === val;
          return el.getAttribute(attr) !== null;
        }
      }
      return el.tagName.toLowerCase() === sel.toLowerCase();
    };

    const traverse = (el: MockElement) => {
      for (const child of el.children) {
        if (parts.some((p) => matchesOne(child, p))) {
          results.push(child);
        }
        traverse(child);
      }
    };

    traverse(this);
    return results;
  }
}

function setupMockDom() {
  const originalDoc = (globalThis as any).document;
  const originalNode = (globalThis as any).Node;
  const originalWin = (globalThis as any).window;

  (globalThis as any).Node = MockNode;
  (globalThis as any).document = {
    createElement(tag: string) {
      return new MockElement(tag);
    },
    createTextNode(text: string) {
      return new MockTextNode(text);
    },
  };
  (globalThis as any).window = {
    location: { hash: "" },
  };

  return () => {
    (globalThis as any).document = originalDoc;
    (globalThis as any).Node = originalNode;
    (globalThis as any).window = originalWin;
  };
}

function baseState(overrides?: Partial<SetupState>): SetupState {
  return {
    needsSetup: true,
    workspace: null,
    suggestedWorkspace: "/Users/test/Movies/mostudio",
    checks: [
      {
        name: "node",
        label: "App runtime",
        ok: true,
        required: true,
        detail: "v22.18.0",
      },
      {
        name: "ffmpeg",
        label: "Video engine (ffmpeg)",
        ok: true,
        required: true,
        detail: "ffmpeg 7.0",
      },
    ],
    hasAiKey: false,
    packaged: false,
    version: "0.0.0",
    ...overrides,
  };
}

test("Step 1: folder configuration and Show in Finder", async () => {
  const cleanupDom = setupMockDom();
  try {
    const root = new MockElement("div");
    let workspaceCalledWith = "";
    let finderCalledWith = "";

    const api: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/setup") {
          return baseState({ workspace: null }) as any;
        }
        throw new Error("unexpected GET: " + path);
      },
      async send(method: string, path: string, body: any) {
        if (method === "POST" && path === "/api/setup/workspace") {
          workspaceCalledWith = body.path;
          return {
            entries: [{ path: body.path + "/projects", status: "created", purpose: "Projects" }],
            state: baseState({ workspace: body.path }),
          } as any;
        }
        if (method === "POST" && path === "/api/show-in-finder") {
          finderCalledWith = body.path;
          return { ok: true } as any;
        }
        throw new Error(`unexpected send ${method} ${path}`);
      },
    };

    mount(root as any, api as any);
    await new Promise((r) => setTimeout(r, 10));

    // Check heading
    const heading = root.querySelector("h1");
    assert.ok(heading);
    assert.equal(heading.textContent, "Where should mostudio keep your videos?");

    // Check input prefilled
    const input = root.querySelector("input");
    assert.ok(input);
    assert.equal(input.value, "/Users/test/Movies/mostudio");

    // Click "Use this folder"
    const buttons = root.querySelectorAll("button");
    const useFolderBtn = buttons.find((b) => b.textContent.includes("Use this folder"));
    assert.ok(useFolderBtn, "Use this folder button must exist");

    useFolderBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(workspaceCalledWith, "/Users/test/Movies/mostudio");

    // Verify Show in Finder button appeared
    const finderBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("Show in Finder"));
    assert.ok(finderBtn, "Show in Finder button must exist after scaffold");
    finderBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(finderCalledWith, "/Users/test/Movies/mostudio/projects");

    // Continue to step 2
    const continueBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("Continue"));
    assert.ok(continueBtn, "Continue button must exist");
    continueBtn.click();

    // Now on step 2
    const step2Heading = root.querySelector("h1");
    assert.equal(step2Heading?.textContent, "Checking your Mac");
  } finally {
    cleanupDom();
  }
});

test("Step 2: Checking your Mac blocks on required check failure", async () => {
  const cleanupDom = setupMockDom();
  try {
    const root = new MockElement("div");

    const checks: Check[] = [
      {
        name: "ffmpeg",
        label: "Video engine (ffmpeg)",
        ok: false,
        required: true,
        detail: "ffmpeg not found",
        fix: "brew install ffmpeg",
      },
      {
        name: "whisper",
        label: "Offline transcription",
        ok: false,
        required: false,
        detail: "not installed",
        fix: "Optional. Cloud transcription works without it.",
      },
    ];

    const api: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/setup") {
          return baseState({ workspace: "/Users/test/Movies/mostudio", checks }) as any;
        }
        throw new Error("unexpected GET: " + path);
      },
    };

    mount(root as any, api as any);
    await new Promise((r) => setTimeout(r, 10));

    const heading = root.querySelector("h1");
    assert.equal(heading?.textContent, "Checking your Mac");

    // Has Optional tag for optional check
    assert.ok(root.textContent.includes("Optional"));

    // Shows fix for ffmpeg
    assert.ok(root.textContent.includes("brew install ffmpeg"));

    // Continue button must NOT be clickable/present when required check fails
    const continueBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("Continue"));
    assert.ok(!continueBtn || continueBtn.disabled, "Continue must be blocked when required check fails");
  } finally {
    cleanupDom();
  }
});

test("Step 3 & 4: Groq key test, save, and skip", async () => {
  const cleanupDom = setupMockDom();
  try {
    const root = new MockElement("div");
    let testCalledWith: any = null;
    let putSettingsCalledWith: any = null;

    const api: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/setup") {
          return baseState({
            workspace: "/Users/test/Movies/mostudio",
            checks: [{ name: "node", label: "Node", ok: true, required: true, detail: "ok" }],
            hasAiKey: false,
          }) as any;
        }
        throw new Error("unexpected GET: " + path);
      },
      async send(method: string, path: string, body: any) {
        if (method === "POST" && path === "/api/settings/test") {
          testCalledWith = body;
          return { provider: "groq", ok: true, ms: 120, message: "Groq API key is valid" } as any;
        }
        if (method === "PUT" && path === "/api/settings") {
          putSettingsCalledWith = body;
          return {} as any;
        }
        throw new Error(`unexpected send ${method} ${path}`);
      },
    };

    mount(root as any, api as any);
    await new Promise((r) => setTimeout(r, 10));

    // Should start at Step 3
    const heading = root.querySelector("h1");
    assert.equal(heading?.textContent, "Add your free Groq key");

    // Check 3 instructions
    assert.ok(root.textContent.includes("1. Open console.groq.com/keys and sign in."));
    assert.ok(root.textContent.includes("2. Create a key and copy it."));
    assert.ok(root.textContent.includes("3. Paste it here."));

    // Password input
    const input = root.querySelector("input");
    assert.ok(input);
    assert.equal(input.type, "password");
    input.value = "gsk_123456789";

    // Test button
    const testBtn = root.querySelectorAll("button").find((b) => b.textContent.trim() === "Test");
    assert.ok(testBtn, "Test button exists");
    testBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(testCalledWith, {
      provider: "groq",
      values: { GROQ_API_KEY: "gsk_123456789" },
    });
    assert.ok(root.textContent.includes("Groq API key is valid"));

    // Save button
    const saveBtn = root.querySelectorAll("button").find((b) => b.textContent.trim() === "Save");
    assert.ok(saveBtn, "Save button exists");
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.deepEqual(putSettingsCalledWith, {
      values: { GROQ_API_KEY: "gsk_123456789" },
    });

    // Should now be at Step 4: You're ready
    const step4Heading = root.querySelector("h1");
    assert.equal(step4Heading?.textContent, "You're ready");

    // Make my first video button navigates to #studio
    const makeBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("Make my first video"));
    assert.ok(makeBtn, "Make my first video button exists");
    makeBtn.click();
    assert.equal((globalThis as any).window.location.hash, "#studio");
  } finally {
    cleanupDom();
  }
});

test("Step 3: 'I\\'ll do this later' advances to Step 4 with warning", async () => {
  const cleanupDom = setupMockDom();
  try {
    const root = new MockElement("div");

    const api: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/setup") {
          return baseState({
            workspace: "/Users/test/Movies/mostudio",
            checks: [{ name: "node", label: "Node", ok: true, required: true, detail: "ok" }],
            hasAiKey: false,
          }) as any;
        }
        throw new Error("unexpected GET: " + path);
      },
    };

    mount(root as any, api as any);
    await new Promise((r) => setTimeout(r, 10));

    const skipLink = root.querySelectorAll("a, button").find((el) =>
      el.textContent.includes("I'll do this later")
    );
    assert.ok(skipLink, "I'll do this later link must exist");

    skipLink.click();
    await new Promise((r) => setTimeout(r, 10));

    // Shows message
    assert.ok(root.textContent.includes("Transcription won't work until you add a key."));

    // Advanced to step 4
    const heading = root.querySelector("h1");
    assert.equal(heading?.textContent, "You're ready");

    const makeBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("Make my first video"));
    assert.ok(makeBtn);
  } finally {
    cleanupDom();
  }
});
