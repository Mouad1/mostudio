import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ProjectStatus,
  ProjectSummary,
  RunEvent,
  ToolInfo,
} from "../../src/types.ts";
import type { Api } from "../lib/api.ts";
import { mount } from "./tools.ts";

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

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name === "disabled") this.disabled = true;
    if (name === "value") this.value = value;
  }

  getAttribute(name: string): string | null {
    if (name === "disabled") return this.disabled ? "" : null;
    if (name === "value") return this.value;
    return this.attributes[name] ?? null;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
    if (name === "disabled") this.disabled = false;
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
    if (selector.includes("[")) {
      return this.matchesAttr(el, selector);
    }
    return el.tagName.toLowerCase() === selector.toLowerCase();
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

const sampleTools: ToolInfo[] = [
  {
    name: "cut",
    title: "Remove silences and retakes",
    summary: "Tighten video by trimming silent gaps and retakes.",
    inputs: ["media/ingest.json", "transcript/words.json"],
    outputs: ["cut/edl.json"],
    params: [
      {
        name: "pace",
        type: "string",
        optional: true,
        label: "Pace",
        help: "Cut pacing",
        choices: [
          { value: "natural", label: "Natural" },
          { value: "tight", label: "Tight" },
        ],
      },
      {
        name: "retakes",
        type: "boolean",
        optional: true,
        label: "Retakes",
        help: "Remove retakes",
        input: "toggle",
      },
      {
        name: "maxGap",
        type: "number",
        optional: true,
        label: "Max gap",
        help: "Max gap seconds",
        input: "number",
        advanced: true,
      },
    ],
    gate: [{ metric: "cutsCount", op: ">=", value: 0, level: "warn" }],
    workflows: ["short", "rough-cut"],
  },
  {
    name: "localize",
    title: "Darija / Arabizi subtitles",
    summary: "Subtitle translation.",
    inputs: ["transcript/words.json"],
    outputs: ["localize/units.json"],
    params: [],
    gate: [],
    workflows: ["short"],
  },
  {
    name: "captions",
    title: "Captions",
    summary: "Generate captions for the video.",
    inputs: ["media/ingest.json", "transcript/words.json", "cut/edl.json", "localize/units.json", "edits/*"],
    outputs: ["captions/captions.txt"],
    params: [
      {
        name: "style",
        type: "string",
        optional: true,
        label: "Style",
        help: "Caption style",
        choices: [{ value: "short", label: "Short" }],
      },
    ],
    gate: [],
    workflows: ["short"],
  },
  {
    name: "transcribe",
    title: "Transcribe speech",
    summary: "Speech to text.",
    inputs: ["media/ingest.json"],
    outputs: ["transcript/words.json"],
    params: [
      {
        name: "prefer",
        type: "string",
        optional: true,
        label: "Preferred provider",
        help: "Preferred provider",
        input: "provider",
        advanced: true,
      },
      {
        name: "sourceFile",
        type: "string",
        optional: true,
        label: "Source file",
        help: "Source file",
        input: "file",
      },
    ],
    gate: [],
    workflows: ["short"],
    capability: "stt",
  },
];

const sampleProjects: ProjectSummary[] = [
  { id: "2026-11-14-test-project", lastStatus: "new" },
];

const sampleStatus: ProjectStatus = {
  id: "2026-11-14-test-project",
  dir: "/tmp/test",
  steps: {
    ingest: {
      step: "ingest",
      status: "pass",
      startedAt: "2026-11-14T00:00:00Z",
      endedAt: "2026-11-14T00:00:01Z",
      durationMs: 1000,
      inputsHash: "abc",
      metrics: {},
      verdicts: [],
      artifacts: [],
    },
    transcribe: {
      step: "transcribe",
      status: "pass",
      startedAt: "2026-11-14T00:00:01Z",
      endedAt: "2026-11-14T00:00:02Z",
      durationMs: 1000,
      inputsHash: "def",
      metrics: {},
      verdicts: [],
      artifacts: [],
    },
  },
  pending: [],
  running: false,
  interrupted: [],
  uploads: ["take1.mp4", "music.mp3"],
};

function createMockApi(overrides?: {
  tools?: ToolInfo[];
  projects?: ProjectSummary[];
  status?: ProjectStatus;
  onPostStep?: (path: string, body: any) => void;
}): Api & { sent: any[]; eventListeners: ((e: RunEvent) => void)[] } {
  const sent: any[] = [];
  const eventListeners: ((e: RunEvent) => void)[] = [];

  const tools = overrides?.tools ?? sampleTools;
  const projects = overrides?.projects ?? sampleProjects;
  const projStatus = overrides?.status ?? sampleStatus;

  const api = {
    sent,
    eventListeners,
    async get<T>(path: string): Promise<T> {
      if (path === "/api/tools") {
        return { tools } as any;
      }
      if (path === "/api/projects") {
        return { projects } as any;
      }
      if (path.includes("/files/")) {
        return [] as any;
      }
      if (path.startsWith("/api/projects/")) {
        return projStatus as any;
      }
      throw new Error(`Unhandled GET: ${path}`);
    },
    async send<T>(method: string, path: string, body?: any): Promise<T> {
      sent.push({ method, path, body });
      if (overrides?.onPostStep && method === "POST" && path.includes("/steps/")) {
        overrides.onPostStep(path, body);
      }
      return {} as any;
    },
    async text() {
      return "";
    },
    async putText() {},
    upload() {
      return { done: Promise.resolve({} as any), abort() {} };
    },
    events(projectId: string, onEvent: (e: RunEvent) => void) {
      eventListeners.push(onEvent);
      return () => {
        const idx = eventListeners.indexOf(onEvent);
        if (idx !== -1) eventListeners.splice(idx, 1);
      };
    },
    fileUrl(projectId: string, rel: string) {
      return `/api/projects/${projectId}/files/${rel}`;
    },
  };

  return api as any;
}

test("renders grid of tool cards with title, summary, and workflows", async () => {
  const cleanupDom = setupMockDom();
  const root = new MockElement("div");
  const api = createMockApi();

  const unmount = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  const cards = root.querySelectorAll(".tool-card");
  assert.equal(cards.length, 4);

  const cutCard = cards[0]!;
  assert.match(cutCard.querySelector(".tool-card-title")!.textContent, /Remove silences and retakes/);
  assert.match(cutCard.querySelector(".tool-card-summary")!.textContent, /Tighten video/);

  const chips = cutCard.querySelectorAll(".tool-workflow-chip");
  assert.equal(chips.length, 2);
  assert.equal(chips[0]!.textContent, "short");
  assert.equal(chips[1]!.textContent, "rough-cut");

  unmount();
  await new Promise((r) => setTimeout(r, 10));
  cleanupDom();
});

test("clicking card opens tool detail panel with inputs, advanced options, and technical details", async () => {
  const cleanupDom = setupMockDom();
  const root = new MockElement("div");
  const api = createMockApi();

  const unmount = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  // Click cut card
  const cutCard = root.querySelector('[data-tool="cut"]')!;
  cutCard.click();

  const panel = root.querySelector(".tool-detail-panel");
  assert.ok(panel, "Detail panel should exist");

  // Project select
  const projSelect = panel!.querySelector(".tool-project-select");
  assert.ok(projSelect, "Project select should exist");

  // Inputs generated from params: choices, toggle, advanced
  const paceSelect = panel!.querySelector('select[name="pace"]');
  assert.ok(paceSelect, "Pace choices select should exist");

  const retakesCheck = panel!.querySelector('input[name="retakes"][type="checkbox"]');
  assert.ok(retakesCheck, "Retakes toggle should exist");

  // Advanced options tucked inside <details><summary>More options</summary>
  const moreOptions = panel!.querySelector("details.tool-advanced");
  assert.ok(moreOptions, "Advanced options details should exist");
  assert.match(moreOptions!.querySelector("summary")!.textContent, /More options/);
  const maxGapInput = moreOptions!.querySelector('input[name="maxGap"]');
  assert.ok(maxGapInput, "Max gap should be inside advanced details");

  // Technical details
  const techDetails = panel!.querySelector("details.tool-tech-details");
  assert.ok(techDetails, "Technical details details should exist");
  assert.match(techDetails!.querySelector("summary")!.textContent, /Technical details/);
  assert.match(techDetails!.textContent, /media\/ingest\.json/);
  assert.match(techDetails!.textContent, /cut\/edl\.json/);

  unmount();
  await new Promise((r) => setTimeout(r, 10));
  cleanupDom();
});

test("tool with capability stt renders provider options and file select renders uploads", async () => {
  const cleanupDom = setupMockDom();
  const root = new MockElement("div");
  const api = createMockApi();

  const unmount = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  // Click transcribe card
  const transcribeCard = root.querySelector('[data-tool="transcribe"]')!;
  transcribeCard.click();
  await new Promise((r) => setTimeout(r, 20));

  const panel = root.querySelector(".tool-detail-panel")!;
  const providerSelect = panel.querySelector('select[name="prefer"]')!;
  assert.ok(providerSelect, "Provider select should exist");
  // Should contain groq, cloudflare, whisper-cpp for stt
  const options = providerSelect.querySelectorAll("option");
  const values = options.map((o) => o.value);
  assert.ok(values.includes("groq"));
  assert.ok(values.includes("cloudflare"));

  // File select should contain project uploads
  const fileSelect = panel.querySelector('select[name="sourceFile"]')!;
  assert.ok(fileSelect, "File select should exist");
  const fileOptions = fileSelect.querySelectorAll("option").map((o) => o.value);
  assert.ok(fileOptions.includes("take1.mp4"));
  assert.ok(fileOptions.includes("music.mp3"));

  unmount();
  await new Promise((r) => setTimeout(r, 20));
  cleanupDom();
});

test("run button is disabled with message when steps are missing, enabled when prerequisites met", async () => {
  const cleanupDom = setupMockDom();
  const root = new MockElement("div");
  const api = createMockApi();

  const unmount = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  // Click cut: dependencies are ingest (pass) and transcribe (pass) -> met!
  const cutCard = root.querySelector('[data-tool="cut"]')!;
  cutCard.click();

  const cutBtn = root.querySelector(".tool-run-button") as MockElement;
  assert.ok(cutBtn, "Run button should exist");
  assert.equal(cutBtn.disabled, false, "Run button should be enabled when prerequisites met");

  // Click captions: missing cut and localize!
  const captionsCard = root.querySelector('[data-tool="captions"]')!;
  captionsCard.click();

  const captionsBtn = root.querySelector(".tool-run-button") as MockElement;
  assert.equal(captionsBtn.disabled, true, "Run button should be disabled when prerequisites missing");

  const missingMsg = root.querySelector(".tool-missing-message");
  assert.ok(missingMsg, "Missing message should be displayed");
  // STEP_LABELS: cut -> "Cut silences", localize -> "Subtitles"
  assert.match(missingMsg.textContent, /Run Cut silences, Subtitles first/);

  unmount();
  await new Promise((r) => setTimeout(r, 10));
  cleanupDom();
});

test("clicking run calls POST /api/projects/:id/steps/:name with params and force flag", async () => {
  const cleanupDom = setupMockDom();
  const root = new MockElement("div");
  let postedPath = "";
  let postedBody: any = null;
  const api = createMockApi({
    onPostStep(path, body) {
      postedPath = path;
      postedBody = body;
    },
  });

  const unmount = mount(root as any, api);
  await new Promise((r) => setTimeout(r, 10));

  const cutCard = root.querySelector('[data-tool="cut"]')!;
  cutCard.click();

  // Set force checkbox
  const forceCheckbox = root.querySelector(".tool-force-checkbox") as MockElement;
  forceCheckbox.checked = true;

  // Set pace
  const paceSelect = root.querySelector('select[name="pace"]') as MockElement;
  paceSelect.value = "tight";

  const runBtn = root.querySelector(".tool-run-button") as MockElement;
  runBtn.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(postedPath, "/api/projects/2026-11-14-test-project/steps/cut");
  assert.deepEqual(postedBody, {
    params: { pace: "tight" },
    force: true,
  });

  // Check event handling: emit a log event
  assert.equal(api.eventListeners.length, 1);
  const onEvent = api.eventListeners[0]!;
  onEvent({ type: "log", step: "cut", message: "Finding cut boundaries...", id: 1, at: "2026-11-14T00:00:00Z" });

  const logs = root.querySelector(".tool-logs");
  assert.ok(logs, "Logs container should exist");
  assert.match(logs.textContent, /Finding cut boundaries\.\.\./);

  unmount();
  assert.equal(api.eventListeners.length, 0, "Unsubscribe should be called on unmount");
  await new Promise((r) => setTimeout(r, 10));
  cleanupDom();
});
