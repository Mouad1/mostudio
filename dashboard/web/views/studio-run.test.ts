import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectStatus, RunEvent, WorkflowInfo } from "../../src/types.ts";
import { ApiFailure, type Api } from "../lib/api.ts";
import { revealLabel } from "../lib/platform.ts";
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
      state: "new",
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

test("the other workflow's card on a locked project says why and offers a new project", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      workflow: "rough-cut",
      steps: {},
      pending: [],
      running: false,
      state: "done",
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };
    const workflows: WorkflowInfo[] = [
      { name: "rough-cut", title: "Long video (YouTube)", steps: [{ step: "ingest", approve: false }] },
      { name: "short", title: "Short vertical video", steps: [{ step: "ingest", approve: false }] },
    ];
    const api = createTestApi({
      get: async (url) => (url === "/api/workflows" ? { workflows } : {}),
    });
    let newProjectClicks = 0;
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, {
      api,
      projectId: status.id,
      initialStatus: status,
      onNewProject: () => {
        newProjectClicks++;
      },
    });
    await new Promise((r) => setTimeout(r, 20));

    const cards = root.querySelectorAll(".workflow-card");
    const longCard = cards.find((c) => c.getAttribute("data-workflow") === "rough-cut")!;
    const shortCard = cards.find((c) => c.getAttribute("data-workflow") === "short")!;
    assert.equal(longCard.getAttribute("aria-pressed"), "true");
    assert.equal(longCard.getAttribute("aria-disabled"), null);
    assert.equal(shortCard.getAttribute("aria-disabled"), "true");
    assert.equal(shortCard.getAttribute("aria-pressed"), "false");
    const reason = "This project made a Long video. Start a new project for a Short.";
    assert.ok(shortCard.textContent.includes(reason), shortCard.textContent);

    const newBtn = root.querySelectorAll("button").find((b) => b.textContent === "New project");
    assert.ok(newBtn, "a New project action is offered");
    await newBtn!.click();
    assert.equal(newProjectClicks, 1);
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
      state: "new",
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

test("mode cards expose the selected state and answer the keyboard; quick-setting selects are labelled", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      steps: {},
      pending: [],
      running: false,
      state: "new",
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };
    const api = createTestApi({
      get: async (url) => (url === "/api/workflows" ? { workflows: mockWorkflows } : {}),
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    const mode = (m: string) => root.querySelectorAll(".mode-card").find((c) => c.getAttribute("data-mode") === m)!;
    assert.equal(mode("manual").getAttribute("aria-pressed"), "true");
    assert.equal(mode("auto").getAttribute("aria-pressed"), "false");
    await mode("auto").dispatchEvent({ type: "keydown", key: "Enter", preventDefault: () => {} });
    assert.equal(mode("auto").getAttribute("aria-pressed"), "true");
    assert.equal(mode("manual").getAttribute("aria-pressed"), "false");

    const wf = root.querySelectorAll(".workflow-card").find((c) => c.getAttribute("data-workflow") === "short")!;
    assert.equal(wf.getAttribute("aria-pressed"), "true");

    for (const cls of ["select-lang", "select-pace"]) {
      const select = root.querySelector(`.${cls}`)!;
      const id = select.getAttribute("id");
      assert.ok(id, `${cls} has an id`);
      const label = root.querySelectorAll("label").find((l) => l.getAttribute("for") === id);
      assert.ok(label, `${cls} has a label`);
    }
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
      state: "new",
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
      state: "running",
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
      pending: [],
      running: false,
      state: "awaiting-approval",
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
      state: "done",
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

    const finderBtn = root.querySelectorAll("button").find((b) => b.textContent.includes(revealLabel()));
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
      state: "new",
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

function failedStatus(): ProjectStatus {
  return {
    id: "2026-11-14-clip",
    dir: "/tmp/clip",
    workflow: "short",
    steps: {
      ingest: {
        step: "ingest",
        status: "fail",
        startedAt: new Date(1000).toISOString(),
        endedAt: new Date(1000).toISOString(),
        durationMs: 0,
        inputsHash: "",
        metrics: {},
        verdicts: [],
        artifacts: [],
        error: "fileParam source must be an absolute path to an existing file",
      },
    },
    pending: ["ingest", "transcribe", "cut", "localize", "captions", "mix", "assemble", "qa"],
    running: false,
    state: "failed",
    interrupted: [],
    uploads: ["darija-01.mp4"],
  };
}

test("failed project after reload: failed step is Failed, nothing asks for review", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status = failedStatus();
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        return {};
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(!root.textContent.includes("Needs your review"));
    assert.ok(!root.textContent.includes("Approve & continue"));
    assert.equal(root.querySelectorAll(".step-badge-awaiting").length, 0);
    const ingest = root.querySelectorAll(".step-card").find((c) => c.getAttribute("data-step") === "ingest");
    assert.ok(ingest?.textContent.includes("Failed"));
    const transcribe = root.querySelectorAll(".step-card").find((c) => c.getAttribute("data-step") === "transcribe");
    assert.ok(transcribe?.textContent.includes("Waiting"));
    // The failed step is selected and its message is on screen.
    assert.match(root.textContent, /fileParam source must be an absolute path/i);
    // The detail chip uses the same words as the cards, not the raw state name.
    assert.equal(root.querySelector(".step-detail-header")?.querySelector(".step-badge")?.textContent, "Failed");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

function buttonWith(root: MockElement, text: string): MockElement | undefined {
  return root.querySelectorAll("button").find((b) => b.textContent.includes(text));
}

test("a run that ends before the start request returns: Stop goes away, Retry shows", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const fresh: ProjectStatus = { ...failedStatus(), workflow: undefined, steps: {}, state: "new", pending: [] };
    let emitEvent!: (ev: RunEvent) => void;
    let serverStatus: ProjectStatus = fresh;
    const at = new Date().toISOString();
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        if (url === "/api/projects/2026-11-14-clip") return serverStatus;
        return {};
      },
      events: (_p, onEvent) => {
        emitEvent = onEvent;
        return () => {};
      },
      send: async (method, url) => {
        if (method === "POST" && url === "/api/projects/2026-11-14-clip/run") {
          // The whole run happens before the 202 reaches the page.
          serverStatus = failedStatus();
          emitEvent({ id: 1, at, type: "run-start", kind: "workflow", name: "short", mode: "manual" });
          emitEvent({ id: 2, at, type: "step-start", step: "ingest" });
          emitEvent({ id: 3, at, type: "step-end", result: failedStatus().steps.ingest! });
          emitEvent({ id: 4, at, type: "run-end", status: "failed", stoppedAt: "ingest", error: "fileParam source must be an absolute path to an existing file" });
          await new Promise((r) => setTimeout(r, 5));
          return { started: true };
        }
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: fresh.id, initialStatus: fresh });
    await new Promise((r) => setTimeout(r, 20));

    await buttonWith(root, "Make my video")!.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(buttonWith(root, "Stop"), undefined, "Stop must not stick after the run ended");
    assert.ok(buttonWith(root, "Retry"), "Retry is offered after a failure");
    assert.equal(root.querySelector(".select-lang")?.disabled, false, "quick settings are enabled again");
    const ingest = root.querySelectorAll(".step-card").find((c) => c.getAttribute("data-step") === "ingest");
    assert.ok(ingest?.textContent.includes("Failed"));
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("a missed run-end is caught by the status check while running", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const running: ProjectStatus = { ...failedStatus(), steps: {}, running: true, state: "running" };
    let serverStatus: ProjectStatus = running;
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        if (url === "/api/projects/2026-11-14-clip") return serverStatus;
        return {};
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: running.id, initialStatus: running, tickMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(buttonWith(root, "Stop"), "running at first");

    serverStatus = failedStatus(); // the run ended; no event reached the page
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(buttonWith(root, "Stop"), undefined);
    assert.ok(buttonWith(root, "Retry"));
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("Retry re-runs the project's workflow", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status = failedStatus();
    let runBody: any = null;
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        return {};
      },
      send: async (method, url, body) => {
        if (method === "POST" && url === "/api/projects/2026-11-14-clip/run") {
          runBody = body;
          return { started: true };
        }
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    await buttonWith(root, "Retry")!.click();
    assert.equal(runBody?.workflow, "short");
    assert.equal(runBody?.mode, "manual");
    assert.equal(runBody?.force, undefined, "cached steps are reused, nothing forced");
    assert.ok(buttonWith(root, "Stop"), "running after Retry");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("an open error Details panel stays open across re-renders", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status = failedStatus();
    // Details only appear when they add something to the advice, e.g. a stack.
    status.steps.ingest!.error += "\n    at ingest (steps/ingest/src/ingest.ts:1:1)";
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        return {};
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    const details = root.querySelector("details");
    assert.ok(details, "the failed step shows an error with Details");
    details.setAttribute("open", ""); // the user opens it

    // Anything that re-renders, e.g. picking a review mode.
    await root.querySelectorAll(".mode-card").find((c) => c.getAttribute("data-mode") === "auto")!.click();

    const after = root.querySelector("details");
    assert.notEqual(after, details, "the panel was re-rendered");
    assert.equal(after?.getAttribute("open"), "", "and is still open");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

function awaitingCaptionsStatus(): ProjectStatus {
  const r = (step: string, extra: object = {}) => ({
    step,
    status: "pass" as const,
    startedAt: new Date(1000).toISOString(),
    endedAt: new Date(2000).toISOString(),
    durationMs: 1000,
    inputsHash: `h-${step}`,
    metrics: {},
    verdicts: [],
    artifacts: [],
    ...extra,
  });
  return {
    id: "2026-11-14-clip",
    dir: "/tmp/clip",
    workflow: "short",
    steps: {
      ingest: r("ingest"),
      transcribe: r("transcribe"),
      cut: r("cut"),
      localize: r("localize"),
      captions: r("captions", { awaitingApproval: true as const }),
    },
    pending: ["mix", "assemble", "qa"],
    running: false,
    state: "awaiting-approval",
    interrupted: [],
    uploads: ["raw.mp4"],
  };
}

test("Approve & continue sends the step that waits for review", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status = awaitingCaptionsStatus();
    let approveBody: any = null;
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        if (url.endsWith("/replacements")) return { text: "" };
        return {};
      },
      send: async (method, url, body) => {
        if (method === "POST" && url === "/api/projects/2026-11-14-clip/approve") {
          approveBody = body;
          return { started: true };
        }
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    // Only captions needs review.
    assert.deepEqual(
      root
        .querySelectorAll(".step-card")
        .filter((c) => c.querySelector(".step-badge-awaiting"))
        .map((c) => [c.getAttribute("data-step"), c.textContent.includes("Needs your review")]),
      [["captions", true]],
    );
    // Select another step first: Approve must still name captions.
    await root.querySelectorAll(".step-card").find((c) => c.getAttribute("data-step") === "ingest")!.click();
    await root.querySelector(".btn-run-approve")!.click();
    assert.deepEqual(approveBody, { step: "captions", continue: true, mode: "manual" });
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("a refused approve shows the server's message", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status = awaitingCaptionsStatus();
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        if (url.endsWith("/replacements")) return { text: "" };
        return {};
      },
      send: async () => {
        throw new ApiFailure(409, 'no passing result for step "captions"; run it first');
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    await root.querySelector(".btn-run-approve")!.click();
    const alert = root.querySelector(".run-action-error");
    assert.ok(alert, "an error is shown");
    assert.equal(alert.getAttribute("role"), "alert");
    assert.ok(alert.textContent.includes('no passing result for step "captions"; run it first'));
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("a refused run shows the server's message", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status = failedStatus();
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        return {};
      },
      send: async () => {
        throw new ApiFailure(409, "This project is already running.");
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    await buttonWith(root, "Retry")!.click();
    assert.ok(root.querySelector(".run-action-error")?.textContent.includes("This project is already running."));
    assert.ok(buttonWith(root, "Retry"), "still offers Retry");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("captions that don't wait for review have no Approve button", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status = awaitingCaptionsStatus();
    delete status.steps.captions!.awaitingApproval;
    status.state = "new";
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        if (url.endsWith("/replacements")) return { text: "" };
        return {};
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));
    await root.querySelectorAll(".step-card").find((c) => c.getAttribute("data-step") === "captions")!.click();

    assert.ok(root.textContent.includes("Fix words"));
    assert.equal(buttonWith(root, "Approve & continue"), undefined);
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("Spoken language: Arabizi subtitles default to Darija and the run sends transcribe.dialect", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      steps: {},
      pending: [],
      running: false,
      state: "new",
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };
    const bodies: any[] = [];
    const api = createTestApi({
      get: async (url) => (url === "/api/workflows" ? { workflows: mockWorkflows } : {}),
      send: async (_m, url, body) => {
        if (url.endsWith("/run")) bodies.push(body);
        return { started: true };
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    const spoken = () => root.querySelector(".select-spoken")!;
    assert.ok(spoken(), "Spoken language select is shown");
    const id = spoken().getAttribute("id");
    assert.ok(root.querySelectorAll("label").find((l) => l.getAttribute("for") === id), "it has a label");
    assert.equal(spoken().value, "auto");

    const lang = root.querySelector(".select-lang")!;
    lang.value = "arabizi";
    await lang.dispatchEvent({ type: "change", target: lang });
    assert.equal(spoken().value, "darija", "Arabizi subtitles switch the speech to Darija");

    const start = () => root.querySelectorAll("button").find((b) => b.textContent.includes("Make my video"))!;
    await start().click();
    assert.equal(bodies[0].params.transcribe.dialect, "darija");
    assert.equal(bodies[0].params.localize.lang, "arabizi");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("Spoken language: a project that ran in Darija remembers it; Auto-detect clears it", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      steps: {},
      pending: [],
      running: false,
      state: "new",
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
      params: { transcribe: { dialect: "darija" } },
    };
    const bodies: any[] = [];
    const api = createTestApi({
      get: async (url) => (url === "/api/workflows" ? { workflows: mockWorkflows } : {}),
      send: async (_m, url, body) => {
        if (url.endsWith("/run")) bodies.push(body);
        return { started: true };
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    const spoken = root.querySelector(".select-spoken")!;
    assert.equal(spoken.value, "darija");
    spoken.value = "auto";
    await spoken.dispatchEvent({ type: "change", target: spoken });

    await root.querySelectorAll("button").find((b) => b.textContent.includes("Make my video"))!.click();
    assert.equal(bodies[0].params.transcribe.dialect, "");
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("Quick settings show the remembered values; picking Default forgets one", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      steps: {},
      pending: [],
      running: false,
      state: "new",
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
      params: { transcribe: { dialect: "darija" }, localize: { lang: "arabizi" }, cut: { pace: "tight" } },
    };
    const bodies: any[] = [];
    const api = createTestApi({
      get: async (url) => (url === "/api/workflows" ? { workflows: mockWorkflows } : {}),
      send: async (_m, url, body) => {
        if (url.endsWith("/run")) bodies.push(body);
        return { started: true };
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(root.querySelector(".select-lang")!.value, "arabizi");
    assert.equal(root.querySelector(".select-pace")!.value, "tight");
    assert.equal(root.querySelector(".select-spoken")!.value, "darija");

    const lang = root.querySelector(".select-lang")!;
    lang.value = "";
    await lang.dispatchEvent({ type: "change", target: lang });
    assert.equal(root.querySelector(".select-lang")!.value, "");

    await root.querySelectorAll("button").find((b) => b.textContent.includes("Make my video"))!.click();
    // The cleared subtitles language is sent empty so the server forgets it; untouched pace is left alone.
    assert.equal(bodies[0].params.localize.lang, "");
    assert.equal(bodies[0].params.cut, undefined);
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("re-running a finished project: no stale 'ready', later steps wait, old render marked previous", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const pass = (step: string) => ({
      step,
      status: "pass" as const,
      startedAt: new Date(1000).toISOString(),
      endedAt: new Date(2000).toISOString(),
      durationMs: 1000,
      inputsHash: "h",
      metrics: {},
      verdicts: [],
      artifacts: [],
    });
    const steps: ProjectStatus["steps"] = {};
    for (const s of mockWorkflows[0]!.steps) steps[s.step] = pass(s.step);
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      workflow: "short",
      steps,
      pending: [],
      running: false,
      state: "done",
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };
    let emitEvent!: (ev: RunEvent) => void;
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        if (url === "/api/projects/2026-11-14-clip") return { ...status, running: true, state: "running" };
        return {};
      },
      events: (_p, onEvent) => {
        emitEvent = onEvent;
        return () => {};
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(root.textContent.includes("Your video is ready!"));

    const at = new Date().toISOString();
    emitEvent({ id: 1, at, type: "run-start", kind: "workflow", name: "short", mode: "auto" });
    emitEvent({ id: 2, at, type: "step-start", step: "transcribe" });
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(!root.textContent.includes("Your video is ready!"), "no stale ready message during the run");
    const done = root.querySelector(".studio-done-section")!;
    assert.ok(done, "the final-video panel stays, re-labelled");
    assert.match(done.textContent, /Making your video again/);
    assert.match(done.textContent, /Previous version/);

    const badge = (step: string) =>
      root.querySelectorAll(".step-card").find((c) => c.getAttribute("data-step") === step)!.textContent;
    assert.match(badge("transcribe"), /Running/);
    assert.match(badge("qa"), /Waiting/);
    assert.doesNotMatch(badge("qa"), /Done/);
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("a step done with warnings says which check it missed, in plain words", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      workflow: "short",
      steps: {
        transcribe: {
          step: "transcribe",
          status: "warn",
          startedAt: new Date(1000).toISOString(),
          endedAt: new Date(2000).toISOString(),
          durationMs: 1000,
          inputsHash: "h",
          metrics: { meanConfidence: 0.68 },
          verdicts: [
            {
              metric: "meanConfidence",
              actual: 0.68,
              threshold: { metric: "meanConfidence", op: ">=", value: 0.7, level: "warn" },
              ok: false,
            },
          ],
          artifacts: [],
        },
      },
      pending: [],
      running: false,
      state: "new",
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };
    const api = createTestApi({
      get: async (url) => (url === "/api/workflows" ? { workflows: mockWorkflows } : {}),
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    const card = root.querySelectorAll(".step-card").find((c) => c.getAttribute("data-step") === "transcribe")!;
    await card.click();
    const notes = root.querySelector(".step-gate-notes");
    assert.ok(notes, "the missed checks are listed");
    assert.match(notes.textContent, /Transcription confidence 0\.68 \(aim ≥ 0\.7\)/);
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("the Sound waveform is fetched once per mix, not on every redraw", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const mix = (endedAt: number) => ({
      step: "mix",
      status: "pass" as const,
      startedAt: new Date(1000).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: 1000,
      inputsHash: "h",
      metrics: {},
      verdicts: [],
      artifacts: ["audio/mix.wav"],
    });
    let status: ProjectStatus = {
      id: "2026-11-14-clip",
      dir: "/tmp/clip",
      workflow: "short",
      steps: { mix: mix(2000) },
      pending: [],
      running: false,
      state: "new",
      interrupted: [],
      uploads: ["uploads/raw.mp4"],
    };
    let peaksFetches = 0;
    let emitEvent!: (ev: RunEvent) => void;
    const api = createTestApi({
      get: async (url) => {
        if (url === "/api/workflows") return { workflows: mockWorkflows };
        if (url.includes("/peaks")) {
          peaksFetches++;
          return { peaks: [0.5] };
        }
        if (url === "/api/projects/2026-11-14-clip") return status;
        return {};
      },
      events: (_p, onEvent) => {
        emitEvent = onEvent;
        return () => {};
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    const mixCard = () => root.querySelectorAll(".step-card").find((c) => c.getAttribute("data-step") === "mix")!;
    await mixCard().click();
    await mixCard().click();
    await mixCard().click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(peaksFetches, 1, "one fetch for one mix, however often the page redraws");

    // A new mix (Sound ran again) is fetched once more.
    status = { ...status, steps: { mix: mix(9000) } };
    const at = new Date().toISOString();
    emitEvent({ id: 1, at, type: "step-end", result: mix(9000) });
    emitEvent({ id: 2, at, type: "run-end", status: "done" });
    await new Promise((r) => setTimeout(r, 20));
    await mixCard().click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(peaksFetches, 2);
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

function soundCheckFailed(extra: { accepted?: true } = {}): ProjectStatus {
  return {
    id: "2026-11-14-clip",
    dir: "/tmp/clip",
    workflow: "short",
    steps: {
      mix: {
        step: "mix",
        status: "fail",
        startedAt: new Date(1000).toISOString(),
        endedAt: new Date(2000).toISOString(),
        durationMs: 1000,
        inputsHash: "h-mix",
        metrics: { driftSec: 0.033, integratedLufs: -14 },
        verdicts: [
          { metric: "driftSec", actual: 0.033, threshold: { metric: "driftSec", op: "<=", value: 0.02, level: "fail" }, ok: false },
          { metric: "integratedLufs", actual: -14, threshold: { metric: "integratedLufs", op: "between", value: [-15, -13], level: "fail" }, ok: true },
        ],
        artifacts: ["audio/mix.wav"],
        ...extra,
      },
    },
    pending: extra.accepted ? ["assemble", "qa"] : ["mix", "assemble", "qa"],
    running: false,
    state: extra.accepted ? "new" : "failed",
    interrupted: [],
    uploads: ["uploads/raw.mp4"],
  };
}

test("a missed quality check says what failed, what to do, and offers Continue anyway", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const status = soundCheckFailed();
    const sent: [string, string, any][] = [];
    const api = createTestApi({
      get: async (url) => (url === "/api/workflows" ? { workflows: mockWorkflows } : {}),
      send: async (method, url, body) => {
        sent.push([method, url, body]);
        return { started: true };
      },
    });
    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: status.id, initialStatus: status });
    await new Promise((r) => setTimeout(r, 20));

    const box = root.querySelector(".check-failed-box");
    assert.ok(box, "the failed check is explained");
    assert.match(box.textContent, /Sound didn't pass its quality check/);
    assert.match(box.textContent, /Sound drifts 0\.03s from the picture \(aim ≤ 0\.02s\)\./);
    assert.match(box.textContent, /lips match the voice/);
    // Details: every check with its number
    const details = box.querySelector("details");
    assert.ok(details, "Details are reachable");
    assert.match(details.textContent, /✗ driftSec = 0\.03 \(target ≤ 0\.02\)/);
    assert.match(details.textContent, /✓ integratedLufs = -14/);
    // Retry is still there; Continue anyway accepts and goes on
    assert.ok(buttonWith(root, "Retry"));
    await buttonWith(root, "Continue anyway")!.click();
    assert.deepEqual(sent, [["POST", "/api/projects/2026-11-14-clip/accept", { step: "mix", continue: true, mode: "manual" }]]);
  } finally {
    cleanup?.();
    cleanupDom();
  }
});

test("a crash has no Continue anyway; an accepted check reads Accepted by you", async () => {
  const cleanupDom = setupMockDom();
  let cleanup: (() => void) | undefined;
  try {
    const api = createTestApi({
      get: async (url) => (url === "/api/workflows" ? { workflows: mockWorkflows } : {}),
    });
    const crashed = new MockElement("div");
    cleanup = mountStudioRun(crashed as any, { api, projectId: "2026-11-14-clip", initialStatus: failedStatus() });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(buttonWith(crashed, "Continue anyway"), undefined);
    assert.equal(crashed.querySelector(".check-failed-box"), null);
    cleanup();

    const root = new MockElement("div");
    cleanup = mountStudioRun(root as any, { api, projectId: "2026-11-14-clip", initialStatus: soundCheckFailed({ accepted: true }) });
    await new Promise((r) => setTimeout(r, 20));
    const mixCard = root.querySelectorAll(".step-card").find((c) => c.getAttribute("data-step") === "mix")!;
    assert.match(mixCard.textContent, /Accepted by you/);
    assert.ok(!mixCard.textContent.includes("Failed"));
    await mixCard.click();
    const note = root.querySelector(".check-accepted-note");
    assert.ok(note, "the panel says the result was kept");
    assert.match(note.textContent, /You kept this result/);
    assert.match(note.textContent, /Sound drifts 0\.03s/);
    assert.equal(buttonWith(root, "Continue anyway"), undefined);
    assert.equal(buttonWith(root, "Retry"), undefined);
  } finally {
    cleanup?.();
    cleanupDom();
  }
});
