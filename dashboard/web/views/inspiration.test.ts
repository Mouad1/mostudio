import assert from "node:assert/strict";
import { test } from "node:test";
import type { InspirationShelf } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { mount } from "./inspiration.ts";

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
  files: any[] = [];

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
        if (
          (selector.startsWith("#") && child.getAttribute("id") === selector.slice(1)) ||
          (selector.startsWith(".") && child.classList.contains(selector.slice(1))) ||
          child.tagName.toLowerCase() === selector.toLowerCase() ||
          (selector.includes("[") && this.matchesAttr(child, selector))
        ) {
          results.push(child);
        }
        traverse(child);
      }
    };
    traverse(this);
    return results;
  }

  private matchesAttr(el: MockElement, selector: string): boolean {
    const match = selector.match(/\[([^=\]]+)(?:="?([^"\]]+)"?)?\]/);
    if (!match) return false;
    const attrName = match[1]!;
    const attrVal = match[2];
    const actual = el.getAttribute(attrName);
    if (actual === null) return false;
    if (attrVal === undefined) return true;
    return actual === attrVal;
  }
}

function setupMockDom() {
  const originalDoc = (globalThis as any).document;
  const originalNode = (globalThis as any).Node;

  (globalThis as any).Node = MockNode;
  (globalThis as any).document = {
    createElement(tag: string) {
      return new MockElement(tag);
    },
    createTextNode(text: string) {
      return new MockTextNode(text);
    },
  };

  return () => {
    (globalThis as any).document = originalDoc;
    (globalThis as any).Node = originalNode;
  };
}

function createSampleShelves(): InspirationShelf[] {
  return [
    {
      kind: "shorts",
      folder: "/ws/inspiration/shorts",
      links: [
        { url: "https://www.instagram.com/reel/123", platform: "instagram", note: "pacing hook" },
      ],
      files: [
        { name: "hook-notes.md", path: "shorts/hook-notes.md", sizeBytes: 1024, kind: "note" },
      ],
    },
    {
      kind: "long",
      folder: "/ws/inspiration/long",
      links: [
        { url: "https://www.youtube.com/watch?v=abc", platform: "youtube" },
      ],
      files: [
        { name: "ref.mp4", path: "long/media/ref.mp4", sizeBytes: 2048576, kind: "media" },
      ],
    },
  ];
}

test("inspiration view renders intro, shelves, links, and files", async () => {
  const cleanup = setupMockDom();
  try {
    const root = new MockElement("div");
    const shelves = createSampleShelves();

    const mockApi: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/inspiration") {
          return { shelves } as any;
        }
        throw new Error("unexpected GET: " + path);
      },
    };

    const unmount = mount(root as any, mockApi as any);
    await new Promise((r) => setTimeout(r, 20));

    // Check intro text
    assert.ok(
      root.textContent.includes(
        "Save videos you like. mostudio keeps them in your folder for reference."
      )
    );

    // Check shelf copy
    assert.ok(root.textContent.includes("Short-form (vertical)"));
    assert.ok(
      root.textContent.includes(
        "Reels, Shorts, TikToks: links, clips, screenshots, notes"
      )
    );
    assert.ok(root.textContent.includes("Long-form (landscape)"));
    assert.ok(
      root.textContent.includes(
        "YouTube videos, podcasts, interviews: links, clips, notes"
      )
    );

    // Check links and files are listed
    assert.ok(root.textContent.includes("https://www.instagram.com/reel/123"));
    assert.ok(root.textContent.includes("pacing hook"));
    assert.ok(root.textContent.includes("hook-notes.md"));
    assert.ok(root.textContent.includes("https://www.youtube.com/watch?v=abc"));
    assert.ok(root.textContent.includes("ref.mp4"));

    unmount();
  } finally {
    cleanup();
  }
});

test("inspiration view paste box adds links and displays toast with Move button", async () => {
  const cleanup = setupMockDom();
  try {
    const root = new MockElement("div");
    let currentShelves = createSampleShelves();
    const calls: { method: string; path: string; body?: any }[] = [];

    const mockApi: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/inspiration") {
          return { shelves: currentShelves } as any;
        }
        throw new Error("unexpected GET: " + path);
      },
      async send(method: "POST" | "PUT" | "DELETE", path: string, body?: any) {
        calls.push({ method, path, body });
        if (method === "POST" && path === "/api/inspiration/links") {
          const kind = body.kind ?? "shorts";
          const newLink = { url: body.url, platform: "youtube" as const, note: body.note };
          return { kind, link: newLink } as any;
        }
        if (method === "DELETE" && path === "/api/inspiration/links") {
          return { ok: true } as any;
        }
        throw new Error(`unexpected send: ${method} ${path}`);
      },
    };

    const unmount = mount(root as any, mockApi as any);
    await new Promise((r) => setTimeout(r, 20));

    // Find textarea and paste button
    const textarea = root.querySelector("textarea") as MockElement;
    assert.ok(textarea, "must have a textarea for pasting links");
    textarea.value = "check https://youtu.be/viral123";

    const addBtn = root.querySelector(".btn-add-links") as MockElement;
    assert.ok(addBtn, "must have an add button");
    addBtn.click();

    await new Promise((r) => setTimeout(r, 20));

    // Verify API called
    const postCall = calls.find((c) => c.method === "POST" && c.path === "/api/inspiration/links");
    assert.ok(postCall, "should call POST /api/inspiration/links");
    assert.equal(postCall.body.url, "https://youtu.be/viral123");

    // Verify toast is displayed
    assert.ok(root.textContent.includes("Added to Short-form"));

    // Toast has a Move button
    const moveBtn = root.querySelector(".btn-toast-move") as MockElement;
    assert.ok(moveBtn, "toast should have a Move button");

    // Click Move
    moveBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    // Verify DELETE called for original kind and POST called for target kind "long"
    const delCall = calls.find((c) => c.method === "DELETE" && c.path === "/api/inspiration/links");
    assert.ok(delCall, "should call DELETE /api/inspiration/links");
    assert.equal(delCall.body.url, "https://youtu.be/viral123");
    assert.equal(delCall.body.kind, "shorts");

    const reAddCall = calls.filter((c) => c.method === "POST" && c.path === "/api/inspiration/links")[1];
    assert.ok(reAddCall, "should re-add to long shelf");
    assert.equal(reAddCall.body.kind, "long");

    unmount();
  } finally {
    cleanup();
  }
});

test("inspiration view Show folder in Finder invokes API", async () => {
  const cleanup = setupMockDom();
  try {
    const root = new MockElement("div");
    const shelves = createSampleShelves();
    const calls: { method: string; path: string; body?: any }[] = [];

    const mockApi: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/inspiration") {
          return { shelves } as any;
        }
        throw new Error("unexpected GET: " + path);
      },
      async send(method: "POST" | "PUT" | "DELETE", path: string, body?: any) {
        calls.push({ method, path, body });
        return { ok: true } as any;
      },
    };

    const unmount = mount(root as any, mockApi as any);
    await new Promise((r) => setTimeout(r, 20));

    const finderBtns = root.querySelectorAll(".btn-show-finder");
    assert.equal(finderBtns.length, 2, "each shelf should have a Show in Finder button");

    finderBtns[0]!.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(calls[0], {
      method: "POST",
      path: "/api/show-in-finder",
      body: { path: "/ws/inspiration/shorts" },
    });

    unmount();
  } finally {
    cleanup();
  }
});

test("inspiration view remove link and remove file invoke DELETE APIs", async () => {
  const cleanup = setupMockDom();
  try {
    const root = new MockElement("div");
    const shelves = createSampleShelves();
    const calls: { method: string; path: string; body?: any }[] = [];

    const mockApi: Partial<Api> = {
      async get(path: string) {
        if (path === "/api/inspiration") {
          return { shelves } as any;
        }
        throw new Error("unexpected GET: " + path);
      },
      async send(method: "POST" | "PUT" | "DELETE", path: string, body?: any) {
        calls.push({ method, path, body });
        return { ok: true } as any;
      },
    };

    const unmount = mount(root as any, mockApi as any);
    await new Promise((r) => setTimeout(r, 20));

    const removeLinkBtn = root.querySelector(".btn-remove-link") as MockElement;
    assert.ok(removeLinkBtn, "must have remove link button");
    removeLinkBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    const delLinkCall = calls.find(
      (c) => c.method === "DELETE" && c.path === "/api/inspiration/links"
    );
    assert.ok(delLinkCall);
    assert.equal(delLinkCall.body.url, "https://www.instagram.com/reel/123");
    assert.equal(delLinkCall.body.kind, "shorts");

    const removeFileBtn = root.querySelector(".btn-remove-file") as MockElement;
    assert.ok(removeFileBtn, "must have remove file button");
    removeFileBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    const delFileCall = calls.find(
      (c) => c.method === "DELETE" && c.path === "/api/inspiration/files"
    );
    assert.ok(delFileCall);
    assert.equal(delFileCall.body.path, "shorts/hook-notes.md");

    unmount();
  } finally {
    cleanup();
  }
});
