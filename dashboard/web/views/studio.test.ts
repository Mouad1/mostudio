import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectStatus, ProjectSummary, RunEvent, WorkflowInfo } from "../../src/types.ts";
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

/** `project`: the project named in the address bar (?project=<id>), as when a project URL is opened or reloaded. */
function setupMockDom(project?: string) {
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
  const location = { pathname: "/", hash: "#studio", search: project ? `?project=${project}` : "" };
  (globalThis as any).window = {
    location,
    history: {
      state: null,
      replaceState(_state: unknown, _title: string, url: string) {
        const hashAt = url.indexOf("#");
        const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
        const q = beforeHash.indexOf("?");
        location.search = q === -1 ? "" : beforeHash.slice(q);
        location.hash = hashAt === -1 ? "" : url.slice(hashAt);
      },
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
  events?: Api["events"];
  upload?: Api["upload"];
}): Api {
  return {
    get: (handlers.get as any) ?? (async () => ({} as any)),
    send: (handlers.send as any) ?? (async () => ({} as any)),
    text: async () => "",
    putText: async () => {},
    upload: handlers.upload ?? (() => ({ done: Promise.resolve({} as any), abort: () => {} })),
    events: handlers.events ?? (() => () => {}),
    fileUrl: (id, rel) => `/api/projects/${id}/files/${rel}`,
  };
}

test("studio mounts and lists projects with date, name, badge", async () => {
  const cleanupDom = setupMockDom("2026-11-14-demo-clip");
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
      state: "new",
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
    // The project's kind reads in plain words, not the workflow id.
    assert.equal(root.querySelector(".project-workflow")!.textContent, "Short");

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

test("a fresh tab with no project in the address bar opens New video, not the last project", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const gets: string[] = [];
    const mockApi = createMockApi({
      async get(path: string) {
        gets.push(path);
        if (path === "/api/projects") return { projects: [{ id: "2026-11-14-last", lastStatus: "done", workflow: "short" }] };
        throw new Error("unexpected path: " + path);
      },
    });
    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(root.textContent.includes("last"), "the project is listed");
    assert.ok(root.textContent.includes("Drop your video here"), "the New video dropzone is shown");
    assert.deepEqual(gets, ["/api/projects"], "the last project is not opened");
    assert.equal(root.querySelector(".active"), null, "no project is highlighted");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("opening a project puts it in the address bar (a reload stays in it); New video takes it out", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const id = "2026-11-14-picked";
    const status: ProjectStatus = { id, dir: "/tmp", steps: {}, pending: [], running: false, state: "new", interrupted: [], uploads: ["uploads/v.mov"] };
    const mockApi = createMockApi({
      async get(path: string) {
        if (path === "/api/projects") return { projects: [{ id, lastStatus: "new" }] };
        if (path === `/api/projects/${id}`) return status;
        if (path === "/api/workflows") return { workflows: mockWorkflows };
        if (path.includes("/replacements")) return { text: "" };
        throw new Error("unexpected path: " + path);
      },
    });
    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));
    const loc = (globalThis as any).window.location;

    await (root.querySelector(".studio-project-item") as any).click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(root.textContent.includes("uploads/v.mov"), "the project opens");
    assert.equal(loc.search, `?project=${id}`);
    assert.equal(loc.hash, "#studio");

    const newBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("New video"));
    await (newBtn as any).click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(loc.search, "");
    assert.equal(loc.hash, "#studio");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("studio renders dropzone when project has no media and no uploads", async () => {
  const cleanupDom = setupMockDom("2026-11-14-empty-project");
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
      state: "new",
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
  const cleanupDom = setupMockDom("2026-11-14-existing");
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
      state: "new",
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

test("project list badge follows the server state after a run ends", async () => {
  const cleanupDom = setupMockDom("2026-11-14-darija");
  let cleanup: (() => void) | undefined;
  try {
    const id = "2026-11-14-darija";
    const projects: ProjectSummary[] = [{ id, lastStatus: "running", workflow: "short" }];
    const runningStatus: ProjectStatus = {
      id,
      dir: "/tmp",
      workflow: "short",
      steps: {},
      pending: ["ingest", "cut", "captions", "assemble"],
      running: true,
      state: "running",
      interrupted: [],
      uploads: ["darija-01.mp4"],
    };
    let serverStatus = runningStatus;
    let emit!: (e: RunEvent) => void;
    const mockApi = createMockApi({
      async get(path: string) {
        if (path === "/api/projects") return { projects };
        if (path === `/api/projects/${id}`) return serverStatus;
        if (path === "/api/workflows") return { workflows: mockWorkflows };
        throw new Error("unexpected path: " + path);
      },
      events: (_id, onEvent) => {
        emit = onEvent;
        return () => {};
      },
    });

    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));
    const badge = () => root.querySelector(".studio-project-item")!.querySelector(".step-badge")!.textContent;
    assert.equal(badge(), "Running…");

    // Ingest failed: steps not run yet are still "pending", but nothing awaits review.
    serverStatus = {
      ...runningStatus,
      running: false,
      state: "failed",
      steps: {
        ingest: {
          step: "ingest",
          status: "fail",
          startedAt: new Date(0).toISOString(),
          endedAt: new Date(0).toISOString(),
          durationMs: 0,
          inputsHash: "",
          metrics: {},
          verdicts: [],
          artifacts: [],
          error: "boom",
        },
      },
    };
    emit({ id: 1, at: new Date().toISOString(), type: "run-end", status: "failed", stoppedAt: "ingest", error: "boom" });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(badge(), "Failed");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("Current media and Uploads refresh from the server when a run ends", async () => {
  const cleanupDom = setupMockDom("2026-11-14-darija");
  let cleanup: (() => void) | undefined;
  try {
    const id = "2026-11-14-darija";
    const projects: ProjectSummary[] = [{ id, lastStatus: "running", workflow: "short" }];
    const runningStatus: ProjectStatus = {
      id,
      dir: "/tmp",
      workflow: "short",
      steps: {},
      pending: [],
      running: true,
      state: "running",
      interrupted: [],
      uploads: ["uploads/old.mp4"],
      media: { file: "media/old.mp4", durationSec: 10, width: 1920, height: 1080 },
    };
    let serverStatus = runningStatus;
    let emit!: (e: RunEvent) => void;
    const mockApi = createMockApi({
      async get(path: string) {
        if (path === "/api/projects") return { projects };
        if (path === `/api/projects/${id}`) return serverStatus;
        if (path === "/api/workflows") return { workflows: mockWorkflows };
        throw new Error("unexpected path: " + path);
      },
      events: (_id, onEvent) => {
        emit = onEvent;
        return () => {};
      },
    });

    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));
    const media = () => root.querySelector(".studio-current-media")!.textContent;
    assert.ok(media().includes("media/old.mp4"));

    serverStatus = {
      ...runningStatus,
      running: false,
      state: "done",
      uploads: ["uploads/new.mp4", "uploads/old.mp4"],
      media: { file: "media/new.mp4", durationSec: 42, width: 1080, height: 1920 },
    };
    emit({ id: 1, at: new Date().toISOString(), type: "run-end", status: "done" });
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(media().includes("media/new.mp4"), media());
    assert.ok(media().includes("42.0s"));
    assert.ok(root.querySelector(".studio-uploads-card")!.textContent.includes("uploads/new.mp4"));
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("Add or replace video uploads into the open project and shows the new upload", async () => {
  const cleanupDom = setupMockDom("2026-11-14-darija");
  let cleanup: (() => void) | undefined;
  try {
    const id = "2026-11-14-darija";
    const projects: ProjectSummary[] = [{ id, lastStatus: "done", workflow: "short" }];
    let serverStatus: ProjectStatus = {
      id,
      dir: "/tmp",
      workflow: "short",
      steps: {},
      pending: [],
      running: false,
      state: "done",
      interrupted: [],
      uploads: ["uploads/old.mp4"],
      media: { file: "media/old.mp4", durationSec: 10, width: 1920, height: 1080 },
    };
    const uploadUrls: string[] = [];
    const posts: string[] = [];
    const mockApi = createMockApi({
      async get(path: string) {
        if (path === "/api/projects") return { projects };
        if (path === `/api/projects/${id}`) return serverStatus;
        if (path === "/api/workflows") return { workflows: mockWorkflows };
        throw new Error("unexpected path: " + path);
      },
      async send(method: string, url: string) {
        posts.push(`${method} ${url}`);
        return {};
      },
      upload: ((url: string) => {
        uploadUrls.push(url);
        serverStatus = { ...serverStatus, uploads: ["uploads/new.mp4", "uploads/old.mp4"] };
        return { done: Promise.resolve({ path: "uploads/new.mp4", sizeBytes: 3 }), abort: () => {} };
      }) as any,
    });

    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));

    const control = root.querySelector(".studio-add-video");
    assert.ok(control, "project page has an Add or replace video control");
    assert.equal(control!.getAttribute("aria-label"), "Add or replace video");
    assert.ok(control!.textContent.includes("Add or replace video"));

    await (control as any).dispatchEvent({
      type: "drop",
      preventDefault: () => {},
      dataTransfer: { files: [{ name: "new.mp4", size: 3 }] },
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(uploadUrls, [`/api/projects/${id}/uploads?name=new.mp4`]);
    assert.deepEqual(posts, [], "uploads into the open project, never creates a new one");
    const uploads = root.querySelector(".studio-uploads-card")!.textContent;
    assert.ok(uploads.indexOf("uploads/new.mp4") < uploads.indexOf("uploads/old.mp4"), uploads);
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("the project's workflow label appears in the list once its first run records it", async () => {
  const cleanupDom = setupMockDom("2026-11-14-first-run");
  let cleanup: (() => void) | undefined;
  try {
    const id = "2026-11-14-first-run";
    const projects: ProjectSummary[] = [{ id, lastStatus: "new" }];
    const fresh: ProjectStatus = {
      id,
      dir: "/tmp",
      steps: {},
      pending: [],
      running: false,
      state: "new",
      interrupted: [],
      uploads: ["uploads/clip.mp4"],
    };
    let serverStatus = fresh;
    let emit!: (e: RunEvent) => void;
    const mockApi = createMockApi({
      async get(path: string) {
        if (path === "/api/projects") return { projects };
        if (path === `/api/projects/${id}`) return serverStatus;
        if (path === "/api/workflows") return { workflows: mockWorkflows };
        throw new Error("unexpected path: " + path);
      },
      events: (_id, onEvent) => {
        emit = onEvent;
        return () => {};
      },
    });

    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(root.querySelector(".project-workflow"), null);

    serverStatus = { ...fresh, workflow: "short", running: true, state: "running" };
    emit({ id: 1, at: new Date().toISOString(), type: "run-end", status: "failed", stoppedAt: "ingest" });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(root.querySelector(".project-workflow")?.textContent, "Short");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

/** Window and document listeners the studio registers, so a test can fire focus/visibility. */
function listenTo(target: any): Record<string, Function[]> {
  const listeners: Record<string, Function[]> = {};
  target.addEventListener = (name: string, fn: Function) => {
    (listeners[name] ??= []).push(fn);
  };
  target.removeEventListener = (name: string, fn: Function) => {
    listeners[name] = (listeners[name] ?? []).filter((f) => f !== fn);
  };
  return listeners;
}

test("the project list refreshes on focus and when the tab becomes visible, without remounting the open project", async () => {
  const cleanupDom = setupMockDom("2026-11-14-open");
  let cleanup: (() => void) | undefined;
  try {
    const winListeners = listenTo((globalThis as any).window);
    const docListeners = listenTo((globalThis as any).document);
    (globalThis as any).document.visibilityState = "visible";
    const id = "2026-11-14-open";
    const projects: ProjectSummary[] = [{ id, lastStatus: "done", workflow: "short" }];
    const status: ProjectStatus = {
      id,
      dir: "/tmp",
      workflow: "short",
      steps: {},
      pending: [],
      running: false,
      state: "done",
      interrupted: [],
      uploads: ["uploads/a.mp4"],
    };
    const mockApi = createMockApi({
      async get(path: string) {
        if (path === "/api/projects") return { projects: [...projects] };
        if (path === `/api/projects/${id}`) return status;
        if (path === "/api/workflows") return { workflows: mockWorkflows };
        throw new Error("unexpected path: " + path);
      },
    });

    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));
    const runView = root.querySelector(".studio-run-container");
    assert.ok(runView);

    // Another tab creates a project; this tab regains focus.
    projects.unshift({ id: "2026-11-15-other-tab", lastStatus: "new" });
    for (const fn of winListeners.focus ?? []) fn({ type: "focus" });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(root.textContent.includes("other-tab"), "the new project appears in the list");
    assert.equal(root.querySelector(".studio-run-container"), runView, "the open project is not remounted");

    projects.unshift({ id: "2026-11-15-third", lastStatus: "new" });
    for (const fn of docListeners.visibilitychange ?? []) fn({ type: "visibilitychange" });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(root.textContent.includes("third"));
    assert.equal(root.querySelector(".studio-run-container"), runView);

    cleanup();
    cleanup = undefined;
    assert.equal((winListeners.focus ?? []).length, 0, "listeners are removed on unmount");
    assert.equal((docListeners.visibilitychange ?? []).length, 0);
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("the project list refreshes after a refused upload, keeping the refusal on screen", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    let listGets = 0;
    const mockApi = createMockApi({
      async get(path: string) {
        if (path === "/api/projects") {
          listGets++;
          return { projects: [] };
        }
        throw new Error("unexpected path: " + path);
      },
      async send(method: string) {
        if (method === "POST") {
          return { id: "2026-11-15-broken", dir: "/tmp", steps: {}, pending: [], running: false, state: "new", interrupted: [], uploads: [] };
        }
        return { ok: true };
      },
      upload: (() => ({ done: Promise.reject(new Error("mostudio can't read this file")), abort: () => {} })) as any,
    });

    const root = new MockElement("div");
    cleanup = mount(root as any, mockApi);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(listGets, 1);

    const zone = root.querySelector(".studio-dropzone")!;
    await (zone as any).dispatchEvent({
      type: "drop",
      preventDefault: () => {},
      dataTransfer: { files: [{ name: "broken.mp4", size: 3 }] },
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(listGets, 2, "the list is fetched again after the refusal");
    assert.ok(root.textContent.includes("mostudio can't read this file"), "the refusal stays visible");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});
