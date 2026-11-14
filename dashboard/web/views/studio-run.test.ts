import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectStatus, RunEvent, WorkflowInfo } from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { mountStudioRun, renderStudioRun } from "./studio-run.ts";

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
  value: string = "";
  scrollTop: number = 0;
  scrollHeight: number = 100;
  clientHeight: number = 50;

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

  get disabled(): boolean {
    return "disabled" in this.attributes;
  }
  set disabled(v: boolean) {
    if (v) this.attributes["disabled"] = "";
    else delete this.attributes["disabled"];
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
          (selector.startsWith("[") && selector.endsWith("]") &&
            child.getAttribute(selector.slice(1, -1).split("=")[0]!) ===
              (selector.slice(1, -1).split("=")[1]?.replace(/['"]/g, "") ?? "")) ||
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
    confirm: () => true,
    location: { hash: "#studio", search: "" },
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
      { step: "transcribe", approve: false },
      { step: "cut", approve: false },
      { step: "localize", approve: false },
      { step: "captions", approve: true },
      { step: "mix", approve: false },
      { step: "assemble", approve: false },
      { step: "qa", approve: false },
    ],
  },
  {
    name: "reel",
    title: "Instagram Reel",
    steps: [
      { step: "ingest", approve: false },
      { step: "cut", approve: false },
      { step: "captions", approve: true },
      { step: "assemble", approve: false },
    ],
  },
];

function createTestApi(handlers: {
  get?: (url: string) => Promise<any>;
  send?: (method: string, url: string, body?: any) => Promise<any>;
  text?: (url: string) => Promise<string>;
  events?: (projectId: string, onEvent: (ev: RunEvent) => void) => () => void;
}): Api {
  return {
    get: handlers.get ?? (async () => ({})),
    send: handlers.send ?? (async () => ({})),
    text: handlers.text ?? (async () => ""),
    putText: async () => {},
    upload: () => ({ done: Promise.resolve({} as any), abort: () => {} }),
    events: handlers.events ?? (() => () => {}),
    fileUrl: (proj, rel) => `/api/projects/${proj}/files/${rel}`,
  };
}

test("studio-run renders workflow picker and locks if project has recorded workflow", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      workflow: "short",
      steps: {},
      pending: [],
      running: false,
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };

    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        if (url === "/api/projects/2026-11-14-clip/replacements") return { text: "" };
        return {};
      },
    });

    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, {
      api,
      projectId: status.id,
      initialStatus: status,
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(root.textContent.includes("What are you making?"));
    assert.ok(root.textContent.includes("Short clip"));
    assert.ok(root.textContent.includes("Instagram Reel"));

    // Workflow is locked to short
    const shortCard = root.querySelectorAll(".workflow-card").find((c) => c.textContent.includes("Short clip"));
    const reelCard = root.querySelectorAll(".workflow-card").find((c) => c.textContent.includes("Instagram Reel"));
    assert.ok(shortCard?.classList.contains("selected"));
    assert.ok(shortCard?.classList.contains("locked") || root.textContent.includes("locked"));

    // Clicking reelCard should NOT change workflow because it is locked
    if (reelCard) await reelCard.click();
    assert.ok(shortCard?.classList.contains("selected"));
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("studio-run renders mode cards with title and help text", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      steps: {},
      pending: [],
      running: false,
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };

    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        return {};
      },
    });

    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, {
      api,
      projectId: status.id,
      initialStatus: status,
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(root.textContent.includes("Review before finishing"));
    assert.ok(root.textContent.includes("pauses at the captions"));
    assert.ok(root.textContent.includes("Do it all for me"));
    assert.ok(root.textContent.includes("still stops and tells you why"));
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("primary button starts run with buildRunRequest", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      steps: {},
      pending: [],
      running: false,
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };

    let sentRunBody: any = null;
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        return {};
      },
      send: async (method, url, body) => {
        if (method === "POST" && url === "/api/projects/2026-11-14-clip/run") {
          sentRunBody = body;
          return { started: true };
        }
      },
    });

    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, {
      api,
      projectId: status.id,
      initialStatus: status,
    });
    await new Promise((r) => setTimeout(r, 20));

    const startBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("Make my video"));
    assert.ok(startBtn, "Make my video button should be present");

    await startBtn.click();
    assert.ok(sentRunBody);
    assert.equal(sentRunBody.workflow, "short");
    assert.equal(sentRunBody.mode, "manual");
    assert.equal(sentRunBody.source, "uploads/raw.mp4");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("primary button stops running project with confirmation", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      workflow: "short",
      steps: {},
      pending: [],
      running: true,
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };

    let cancelCalled = false;
    let confirmPrompt = "";
    (globalThis as any).window.confirm = (msg: string) => {
      confirmPrompt = msg;
      return true;
    };

    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        return {};
      },
      send: async (method, url) => {
        if (method === "POST" && url === "/api/projects/2026-11-14-clip/cancel") {
          cancelCalled = true;
          return { cancelled: true };
        }
      },
    });

    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, {
      api,
      projectId: status.id,
      initialStatus: status,
    });
    await new Promise((r) => setTimeout(r, 20));

    const stopBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("Stop"));
    assert.ok(stopBtn, "Stop button must be present when running");

    await stopBtn.click();
    assert.equal(cancelCalled, true);
    assert.equal(confirmPrompt, "Stop this run? Finished steps are kept.");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("captions review: fix words and apply fixes", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      workflow: "short",
      steps: {
        captions: {
          step: "captions",
          status: "pass",
          startedAt: new Date(1000).toISOString(),
          endedAt: new Date(2000).toISOString(),
          durationMs: 1000,
          inputsHash: "h",
          metrics: {},
          verdicts: [],
          artifacts: ["captions/captions.txt"],
          awaitingApproval: true,
        },
      },
      pending: ["captions"],
      running: false,
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };

    let replacementsSaved: string | null = null;
    let rerunBody: any = null;
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        if (url === "/api/projects/2026-11-14-clip/replacements") return { text: "teh => the" };
        return {};
      },
      text: async (url) => {
        if (url.includes("captions.txt")) return "First line\nSecond line";
        return "";
      },
      send: async (method, url, body) => {
        if (method === "PUT" && url === "/api/projects/2026-11-14-clip/replacements") {
          replacementsSaved = body?.text;
          return { ok: true };
        }
        if (method === "POST" && url === "/api/projects/2026-11-14-clip/rerun") {
          rerunBody = body;
          return { started: true };
        }
      },
    });

    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, {
      api,
      projectId: status.id,
      initialStatus: status,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Captions text and editor should be visible
    assert.ok(root.textContent.includes("Fix words"));
    const textarea = root.querySelector("textarea");
    assert.ok(textarea, "Fix words textarea should exist");
    assert.equal(textarea.getAttribute("placeholder"), "One fix per line: wrong => right");

    textarea.value = "teh => the\nwrld => world";

    const applyBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("Apply fixes"));
    assert.ok(applyBtn, "Apply fixes button should exist");

    await applyBtn.click();
    assert.equal(replacementsSaved, "teh => the\nwrld => world");
    assert.deepEqual(rerunBody, { step: "captions" });
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("done state renders video player and Show in Finder", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      workflow: "short",
      steps: {
        assemble: {
          step: "assemble",
          status: "pass",
          startedAt: new Date(1000).toISOString(),
          endedAt: new Date(2000).toISOString(),
          durationMs: 1000,
          inputsHash: "h",
          metrics: {},
          verdicts: [],
          artifacts: ["renders/final.mp4"],
        },
      },
      pending: [],
      running: false,
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };

    let finderBody: any = null;
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        return {};
      },
      send: async (method, url, body) => {
        if (method === "POST" && url === "/api/show-in-finder") {
          finderBody = body;
          return { ok: true };
        }
      },
    });

    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, {
      api,
      projectId: status.id,
      initialStatus: status,
    });
    await new Promise((r) => setTimeout(r, 20));

    const video = root.querySelector("video");
    assert.ok(video, "Video element should exist in done state");
    assert.equal(video.getAttribute("src"), "/api/projects/2026-11-14-clip/files/renders/final.mp4");

    const finderBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("Show in Finder"));
    assert.ok(finderBtn, "Show in Finder button must exist");

    await finderBtn.click();
    assert.deepEqual(finderBody, { path: "renders/final.mp4", projectId: "2026-11-14-clip" });

    // Primary button in done state says Make it again
    const againBtn = root.querySelectorAll("button").find((b) => b.textContent.includes("Make it again"));
    assert.ok(againBtn, "Make it again button must exist when done");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("live SSE events update stepper and refetch status on run-end", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      workflow: "short",
      steps: {},
      pending: [],
      running: false,
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };

    let emitEvent!: (ev: RunEvent) => void;
    let statusFetchCount = 0;

    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        if (url === "/api/projects/2026-11-14-clip") {
          statusFetchCount++;
          return status;
        }
        return {};
      },
      events: (_proj, onEvent) => {
        emitEvent = onEvent;
        return () => {};
      },
    });

    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, {
      api,
      projectId: status.id,
      initialStatus: status,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Send step-start event
    emitEvent({
      id: 1,
      at: new Date().toISOString(),
      type: "step-start",
      step: "transcribe",
    });
    await new Promise((r) => setTimeout(r, 10));

    // transcribe should now show Running…
    const transcribeBadge = root.querySelectorAll(".step-badge-running");
    assert.ok(transcribeBadge.length > 0, "Transcribe step should be running");

    // Send run-end event
    emitEvent({
      id: 2,
      at: new Date().toISOString(),
      type: "run-end",
      status: "done",
    });
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(statusFetchCount >= 1, "Status should be refetched on run-end");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});
