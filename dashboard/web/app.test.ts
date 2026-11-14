import assert from "node:assert/strict";
import { test } from "node:test";
import type { SetupState } from "../src/types.ts";
import { initApp, routes } from "./app.ts";
import type { Api } from "./lib/api.ts";

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
}

class MockElement extends MockNode {
  tagName: string;
  attributes: Record<string, string> = {};
  eventListeners: Record<string, Function[]> = {};

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
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

  removeEventListener(name: string, fn: Function) {
    this.eventListeners[name] = (this.eventListeners[name] || []).filter((f) => f !== fn);
  }

  querySelector(selector: string): MockElement | null {
    const all = this.querySelectorAll(selector);
    return all[0] ?? null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const traverse = (el: MockElement) => {
      for (const child of el.children) {
        if (
          (selector.startsWith("#") && child.getAttribute("id") === selector.slice(1)) ||
          (selector.startsWith(".") && child.classList.contains(selector.slice(1))) ||
          child.tagName.toLowerCase() === selector.toLowerCase()
        ) {
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

  const winListeners: Record<string, Function[]> = {};
  let currentHash = "";

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
    location: {
      get hash() {
        return currentHash;
      },
      set hash(val: string) {
        if (currentHash !== val) {
          currentHash = val;
          for (const fn of winListeners["hashchange"] || []) {
            fn();
          }
        }
      },
    },
    addEventListener(name: string, fn: Function) {
      winListeners[name] = winListeners[name] || [];
      winListeners[name]!.push(fn);
    },
    removeEventListener(name: string, fn: Function) {
      winListeners[name] = (winListeners[name] || []).filter((f) => f !== fn);
    },
  };

  return () => {
    (globalThis as any).document = originalDoc;
    (globalThis as any).Node = originalNode;
    (globalThis as any).window = originalWin;
  };
}

test("app initializes with #setup when needsSetup is true", async () => {
  const cleanupDom = setupMockDom();
  try {
    assert.ok(routes["#setup"], "#setup route must be registered");

    const container = new MockElement("div");
    let needsSetupVal = true;

    const mockApi: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/setup") {
          return {
            needsSetup: needsSetupVal,
            workspace: null,
            suggestedWorkspace: "/Users/test/Movies/mostudio",
            checks: [],
            hasAiKey: false,
            packaged: false,
            version: "0.0.0",
          } as SetupState as any;
        }
        throw new Error("unexpected path: " + path);
      },
    };

    const app = await initApp(container as any, mockApi as any);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal((globalThis as any).window.location.hash, "#setup");

    // The main container should contain the setup view
    const main = container.querySelector("#main-content");
    assert.ok(main);
    assert.ok(main.textContent.includes("Where should mostudio keep your videos?"));

    app.destroy();
  } finally {
    cleanupDom();
  }
});

test("app initializes with #studio when needsSetup is false", async () => {
  const cleanupDom = setupMockDom();
  try {
    assert.ok(routes["#studio"], "#studio route must be registered");

    const container = new MockElement("div");

    const mockApi: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/setup") {
          return {
            needsSetup: false,
            workspace: "/Users/test/Movies/mostudio",
            suggestedWorkspace: "/Users/test/Movies/mostudio",
            checks: [],
            hasAiKey: true,
            packaged: false,
            version: "0.0.0",
          } as SetupState as any;
        }
        if (path === "/api/projects") {
          return { projects: [] };
        }
        throw new Error("unexpected path: " + path);
      },
    };

    const app = await initApp(container as any, mockApi as any);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal((globalThis as any).window.location.hash, "#studio");

    const main = container.querySelector("#main-content");
    assert.ok(main);
    assert.ok(main.textContent.includes("Projects"));

    app.destroy();
  } finally {
    cleanupDom();
  }
});

test("app navigates to #inspiration", async () => {
  const cleanupDom = setupMockDom();
  try {
    assert.ok(routes["#inspiration"], "#inspiration route must be registered");

    const container = new MockElement("div");

    const mockApi: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/setup") {
          return {
            needsSetup: false,
            workspace: "/Users/test/Movies/mostudio",
            suggestedWorkspace: "/Users/test/Movies/mostudio",
            checks: [],
            hasAiKey: true,
            packaged: false,
            version: "0.0.0",
          } as SetupState as any;
        }
        if (path === "/api/projects") {
          return { projects: [] };
        }
        if (path === "/api/inspiration") {
          return { shelves: [] };
        }
        throw new Error("unexpected path: " + path);
      },
    };

    const app = await initApp(container as any, mockApi as any);
    await new Promise((r) => setTimeout(r, 20));

    await app.navigate("#inspiration");
    await new Promise((r) => setTimeout(r, 20));

    assert.equal((globalThis as any).window.location.hash, "#inspiration");

    const main = container.querySelector("#main-content");
    assert.ok(main);
    assert.ok(main.textContent.includes("Save videos you like. mostudio keeps them in your folder for reference."));

    app.destroy();
  } finally {
    cleanupDom();
  }
});

test("app navigates to #tools", async () => {
  const cleanupDom = setupMockDom();
  try {
    assert.ok(routes["#tools"], "#tools route must be registered");

    const container = new MockElement("div");

    const mockApi: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/setup") {
          return {
            needsSetup: false,
            workspace: "/Users/test/Movies/mostudio",
            suggestedWorkspace: "/Users/test/Movies/mostudio",
            checks: [],
            hasAiKey: true,
            packaged: false,
            version: "0.0.0",
          } as SetupState as any;
        }
        if (path === "/api/projects") {
          return { projects: [] };
        }
        if (path === "/api/tools") {
          return { tools: [] };
        }
        throw new Error("unexpected path: " + path);
      },
    };

    const app = await initApp(container as any, mockApi as any);
    await new Promise((r) => setTimeout(r, 20));

    await app.navigate("#tools");
    await new Promise((r) => setTimeout(r, 20));

    assert.equal((globalThis as any).window.location.hash, "#tools");

    const main = container.querySelector("#main-content");
    assert.ok(main);
    assert.ok(main.textContent.includes("Tools"));

    app.destroy();
  } finally {
    cleanupDom();
  }
});

test("app navigates to #settings", async () => {
  const cleanupDom = setupMockDom();
  try {
    assert.ok(routes["#settings"], "#settings route must be registered");

    const container = new MockElement("div");

    const mockApi: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/setup") {
          return {
            needsSetup: false,
            workspace: "/Users/test/Movies/mostudio",
            suggestedWorkspace: "/Users/test/Movies/mostudio",
            checks: [],
            hasAiKey: true,
            packaged: false,
            version: "0.0.0",
          } as SetupState as any;
        }
        if (path === "/api/projects") {
          return { projects: [] };
        }
        if (path === "/api/settings") {
          return {
            keysFile: "/Users/test/.env",
            fields: [],
            animatedCaptions: false,
          };
        }
        throw new Error("unexpected path: " + path);
      },
    };

    const app = await initApp(container as any, mockApi as any);
    await new Promise((r) => setTimeout(r, 20));

    await app.navigate("#settings");
    await new Promise((r) => setTimeout(r, 20));

    assert.equal((globalThis as any).window.location.hash, "#settings");

    const main = container.querySelector("#main-content");
    assert.ok(main);
    assert.ok(main.textContent.includes("Settings"));
    assert.ok(main.textContent.includes("Your keys stay on this Mac"));

    app.destroy();
  } finally {
    cleanupDom();
  }
});

test("app shows version in footer from /api/setup", async () => {
  const cleanupDom = setupMockDom();
  try {
    const container = new MockElement("div");
    const mockApi: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/setup") {
          return {
            needsSetup: false,
            workspace: "/Users/test/Movies/mostudio",
            suggestedWorkspace: "/Users/test/Movies/mostudio",
            checks: [],
            hasAiKey: true,
            packaged: false,
            version: "0.1.0",
          } as SetupState as any;
        }
        if (path === "/api/projects") return { projects: [] };
        throw new Error("unexpected: " + path);
      },
    };
    const app = await initApp(container as any, mockApi as any);
    const footer = container.querySelector(".nav-footer");
    assert.ok(footer);
    assert.equal(footer.textContent, "mostudio 0.1.0");
    app.destroy();
  } finally {
    cleanupDom();
  }
});
