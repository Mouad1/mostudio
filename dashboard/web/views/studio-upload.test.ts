import assert from "node:assert/strict";
import { test } from "node:test";
import { MEDIA_EXTS } from "../lib/studio.ts";
import type { Api } from "../lib/api.ts";
import { renderStudioUpload } from "./studio-upload.ts";

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

  async dispatchEvent(evt: { type: string; [key: string]: any }) {
    const fns = this.eventListeners[evt.type] || [];
    for (const fn of fns) {
      await fn(evt);
    }
  }

  async click() {
    await this.dispatchEvent({ type: "click", target: this, preventDefault: () => {} });
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

function createMockApi(handlers: {
  get?: (url: string) => Promise<any>;
  send?: (method: string, url: string, body?: any) => Promise<any>;
  upload?: (path: string, file: any, onProgress: (fraction: number) => void) => any;
}): Api {
  return {
    get: (handlers.get as any) ?? (async () => ({} as any)),
    send: (handlers.send as any) ?? (async () => ({} as any)),
    text: async () => "",
    putText: async () => {},
    upload: (handlers.upload as any) ?? (() => ({ done: Promise.resolve({} as any), abort: () => {} })),
    events: () => () => {},
    fileUrl: (id, rel) => `/api/projects/${id}/files/${rel}`,
  };
}

test("renderStudioUpload displays dropzone text and hidden file input", () => {
  const cleanupDom = setupMockDom();
  try {
    const mockApi = createMockApi({});
    const el = renderStudioUpload({
      api: mockApi,
      projectId: "2026-11-14-test",
      onUploaded: () => {},
    });

    assert.ok(el.textContent.includes("Drop your video here"));
    assert.ok(el.textContent.includes("or choose a file"));

    const input = el.querySelector("input[type=file]") || el.querySelector("input");
    assert.ok(input, "hidden file input should be present");
    assert.equal(input.getAttribute("accept"), MEDIA_EXTS.join(","));
  } finally {
    cleanupDom();
  }
});

test("renderStudioUpload handles keyboard navigation (Enter/Space opens picker)", async () => {
  const cleanupDom = setupMockDom();
  try {
    const mockApi = createMockApi({});
    const el = renderStudioUpload({
      api: mockApi,
      projectId: "2026-11-14-test",
      onUploaded: () => {},
    });

    const input = el.querySelector("input")!;
    let inputClicked = false;
    input.addEventListener("click", () => {
      inputClicked = true;
    });

    let prevented = false;
    await (el as any).dispatchEvent({
      type: "keydown",
      key: "Enter",
      preventDefault: () => { prevented = true; },
    });
    assert.ok(inputClicked, "Enter should trigger input click");
    assert.ok(prevented);

    inputClicked = false;
    prevented = false;
    await (el as any).dispatchEvent({
      type: "keydown",
      key: " ",
      preventDefault: () => { prevented = true; },
    });
    assert.ok(inputClicked, "Space should trigger input click");
    assert.ok(prevented);
  } finally {
    cleanupDom();
  }
});

test("renderStudioUpload handles dragover and dragleave", async () => {
  const cleanupDom = setupMockDom();
  try {
    const mockApi = createMockApi({});
    const el = renderStudioUpload({
      api: mockApi,
      projectId: "2026-11-14-test",
      onUploaded: () => {},
    });

    let prevented = false;
    await (el as any).dispatchEvent({
      type: "dragover",
      preventDefault: () => { prevented = true; },
    });
    assert.ok(prevented);
    assert.ok(el.classList.contains("drag-over"));

    await (el as any).dispatchEvent({ type: "dragleave" });
    assert.ok(!el.classList.contains("drag-over"));
  } finally {
    cleanupDom();
  }
});

test("renderStudioUpload uploads file with progress and calls onUploaded", async () => {
  const cleanupDom = setupMockDom();
  try {
    let uploadedPath = "";
    let uploadCalled = false;

    const mockApi = createMockApi({
      upload(path: string, _file: any, onProgress: (fraction: number) => void) {
        uploadCalled = true;
        return {
          done: (async () => {
            onProgress(0.5);
            return { path: "uploads/clip.mov", sizeBytes: 1000 };
          })(),
          abort() {},
        };
      },
    });

    const el = renderStudioUpload({
      api: mockApi,
      projectId: "2026-11-14-test",
      onUploaded: (path) => {
        uploadedPath = path;
      },
    });

    const fakeFile = { name: "clip.mov", size: 10_000_000 };
    await (el as any).dispatchEvent({
      type: "drop",
      preventDefault: () => {},
      dataTransfer: { files: [fakeFile] },
    });

    assert.ok(uploadCalled);
    assert.ok(el.textContent.includes("of 10 MB"));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(uploadedPath, "uploads/clip.mov");
  } finally {
    cleanupDom();
  }
});

test("renderStudioUpload auto-creates project when projectId not given", async () => {
  const cleanupDom = setupMockDom();
  try {
    let projectCreatedWithSlug = "";
    let uploadedToUrl = "";

    const mockApi = createMockApi({
      async send(method: string, path: string, body?: any) {
        if (method === "POST" && path === "/api/projects") {
          projectCreatedWithSlug = body.slug;
          return { id: "2026-11-14-summer-trip", dir: "/tmp", steps: {}, pending: [], running: false, interrupted: [], uploads: [] };
        }
        throw new Error("unexpected api call");
      },
      upload(path: string, _file: any, _onProgress: (fraction: number) => void) {
        uploadedToUrl = path;
        return {
          done: Promise.resolve({ path: "uploads/summer-trip.mp4", sizeBytes: 500 }),
          abort() {},
        };
      },
    });

    const el = renderStudioUpload({
      api: mockApi,
      onUploaded: () => {},
    });

    const fakeFile = { name: "Summer Trip (2026).mp4", size: 5_000_000 };
    await (el as any).dispatchEvent({
      type: "drop",
      preventDefault: () => {},
      dataTransfer: { files: [fakeFile] },
    });

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(projectCreatedWithSlug, "summer-trip-2026");
    assert.ok(uploadedToUrl.includes("/api/projects/2026-11-14-summer-trip/uploads"));
  } finally {
    cleanupDom();
  }
});

test("renderStudioUpload allows cancelling upload", async () => {
  const cleanupDom = setupMockDom();
  try {
    let aborted = false;

    const mockApi = createMockApi({
      upload() {
        return {
          done: new Promise(() => {}),
          abort() {
            aborted = true;
          },
        };
      },
    });

    const el = renderStudioUpload({
      api: mockApi,
      projectId: "2026-11-14-test",
      onUploaded: () => {},
    });

    const fakeFile = { name: "clip.mp4", size: 1_000_000 };
    await (el as any).dispatchEvent({
      type: "drop",
      preventDefault: () => {},
      dataTransfer: { files: [fakeFile] },
    });

    const cancelBtn = el.querySelector(".btn-cancel-upload") || el.querySelector("button");
    assert.ok(cancelBtn, "Cancel button should exist while uploading");
    assert.ok(cancelBtn.textContent.includes("Cancel upload"));

    await (cancelBtn as any).click();
    assert.ok(aborted, "Clicking cancel button must call abort()");
  } finally {
    cleanupDom();
  }
});
