import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectStatus, ProjectSummary, WorkflowInfo } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { mount } from "./studio.ts";

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
    location: {
      hash: "#studio",
      search: "",
    },
  };

  return () => {
    (globalThis as any).document = originalDoc;
    (globalThis as any).Node = originalNode;
    (globalThis as any).window = originalWin;
  };
}

const mockWorkflows: WorkflowInfo[] = [
  {
    name: "short",
    title: "Short clip",
    steps: [
      { step: "ingest", approve: false },
      { step: "cut", approve: false },
      { step: "captions", approve: true },
      { step: "assemble", approve: false },
    ],
  },
];

function createMockApi(handlers: {
  get?: (url: string) => Promise<any>;
  send?: (method: string, url: string, body?: any) => Promise<any>;
}): Api {
  return {
    get: (handlers.get as any) ?? (async () => ({} as any)),
    send: (handlers.send as any) ?? (async () => ({} as any)),
    text: async () => "",
    putText: async () => {},
    upload: () => ({ done: Promise.resolve({} as any), abort: () => {} }),
    events: () => () => {},
    fileUrl: (id, rel) => `/api/projects/${id}/files/${rel}`,
  };
}

test("studio mounts and lists projects with date, name, badge", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const mockProjects: ProjectSummary[] = [
      { id: "2026-11-14-demo-clip", lastStatus: "done", workflow: "short" },
      { id: "2026-11-13-empty-project", lastStatus: "new" },
    ];
    const mockStatusDone: ProjectStatus = {
      id: "2026-11-14-demo-clip",
      dir: "/tmp/demo",
      workflow: "short",
      steps: {},
      pending: [],
      running: false,
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
      media: { file: "media/ingest.mp4", durationSec: 15.2, width: 1080, height: 1920 },
    };

    const mockApi = createMockApi({
      async get(path: string) {
        if (path === "/api/projects") {
          return { projects: mockProjects };
        }
        if (path === "/api/projects/2026-11-14-demo-clip") {
          return mockStatusDone;
        }
        if (path === "/api/workflows") {
          return { workflows: mockWorkflows };
        }
        if (path.includes("/replacements")) {
          return { text: "" };
        }
        throw new Error("unexpected path: " + path);
      },
    });

    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));

    // Check project list rendered
    assert.ok(root.textContent.includes("demo-clip"));
    assert.ok(root.textContent.includes("2026-11-14"));
    assert.ok(root.textContent.includes("empty-project"));
    assert.ok(root.textContent.includes("New video"));

    // First project is selected and has media + uploads
    assert.ok(root.textContent.includes("uploads/raw.mp4"));
    assert.ok(root.textContent.includes("media/ingest.mp4"));

    // studio-run view is mounted into workspace
    assert.ok(root.textContent.includes("What are you making?"));
    assert.ok(root.textContent.includes("Review mode"));
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("studio renders dropzone when project has no media and no uploads", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const mockProjects: ProjectSummary[] = [
      { id: "2026-11-14-empty-project", lastStatus: "new" },
    ];
    const mockStatusEmpty: ProjectStatus = {
      id: "2026-11-14-empty-project",
      dir: "/tmp/empty",
      steps: {},
      pending: [],
      running: false,
      interrupted: [],
      uploads: [],
    };

    const mockApi = createMockApi({
      async get(path: string) {
        if (path === "/api/projects") {
          return { projects: mockProjects };
        }
        if (path === "/api/projects/2026-11-14-empty-project") {
          return mockStatusEmpty;
        }
        if (path === "/api/workflows") {
          return { workflows: mockWorkflows };
        }
        throw new Error("unexpected path: " + path);
      },
    });

    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(root.textContent.includes("Drop your video here"));
    assert.ok(root.textContent.includes("or choose a file"));
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("clicking New video switches to new project dropzone", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const mockProjects: ProjectSummary[] = [
      { id: "2026-11-14-existing", lastStatus: "done" },
    ];
    const mockStatus: ProjectStatus = {
      id: "2026-11-14-existing",
      dir: "/tmp",
      steps: {},
      pending: [],
      running: false,
      interrupted: [],
      uploads: ["uploads/v1.mov"],
    };

    const mockApi = createMockApi({
      async get(path: string) {
        if (path === "/api/projects") return { projects: mockProjects };
        if (path === "/api/projects/2026-11-14-existing") return mockStatus;
        if (path === "/api/workflows") return { workflows: mockWorkflows };
        if (path.includes("/replacements")) return { text: "" };
        throw new Error("unexpected path: " + path);
      },
    });

    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));

    // Shows existing media/uploads initially
    assert.ok(root.textContent.includes("uploads/v1.mov"));

    // Find New video button
    const newBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("New video"));
    assert.ok(newBtn, "New video button must exist");

    await (newBtn as any).click();
    await new Promise((r) => setTimeout(r, 10));

    // Now dropzone is visible
    assert.ok(root.textContent.includes("Drop your video here"));
  } finally {
    cleanup?.();
    cleanupDom();
  }
});
