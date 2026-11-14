import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api } from "../lib/api.ts";
import type { Preview } from "../lib/previews.ts";
import { renderPreview } from "./previews.ts";

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

  get className(): string {
    return this.attributes["class"] || "";
  }
  set className(v: string) {
    this.attributes["class"] = v;
  }

  classList = {
    contains: (cls: string) => {
      const cur = new Set((this.attributes["class"] || "").split(" ").filter(Boolean));
      return cur.has(cls);
    },
  };

  addEventListener(name: string, fn: Function) {
    this.eventListeners[name] = this.eventListeners[name] || [];
    this.eventListeners[name]!.push(fn);
  }

  async click() {
    const fns = this.eventListeners["click"] || [];
    for (const fn of fns) {
      await fn({ target: this, preventDefault: () => {} });
    }
  }

  querySelector(selector: string): MockElement | null {
    const all = this.querySelectorAll(selector);
    return all[0] ?? null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const walk = (el: MockElement) => {
      if (selector.startsWith(".") && el.classList.contains(selector.slice(1))) {
        results.push(el);
      } else if (selector.startsWith("[") && selector.endsWith("]")) {
        const [attr, val] = selector.slice(1, -1).split("=");
        const cleanVal = val?.replace(/['"]/g, "");
        if (cleanVal !== undefined ? el.getAttribute(attr!) === cleanVal : el.getAttribute(attr!) !== null) {
          results.push(el);
        }
      } else if (el.tagName.toLowerCase() === selector.toLowerCase()) {
        results.push(el);
      }
      for (const child of el.children) {
        walk(child);
      }
    };
    if (selector.startsWith(".") && this.classList.contains(selector.slice(1))) {
      results.push(this);
    } else if (this.tagName.toLowerCase() === selector.toLowerCase()) {
      results.push(this);
    }
    for (const child of this.children) {
      walk(child);
    }
    return results;
  }

  getContext(type: string) {
    if (type === "2d") {
      return {
        clearRect: () => {},
        fillRect: () => {},
        fillStyle: "",
      };
    }
    return null;
  }
}

// Setup global DOM mocks
(globalThis as any).Node = MockNode;
(globalThis as any).document = {
  createElement: (tag: string) => new MockElement(tag),
  createTextNode: (text: string) => new MockTextNode(text),
};

function createMockApi(handlers: {
  get?: (url: string) => Promise<any>;
  send?: (method: string, url: string, body?: any) => Promise<any>;
  text?: (url: string) => Promise<string>;
}): Api {
  return {
    get: handlers.get ?? (async () => ({})),
    send: handlers.send ?? (async () => ({})),
    text: handlers.text ?? (async () => ""),
    fileUrl: (proj, rel) => `/api/projects/${proj}/files/${rel}`,
    putText: async () => {},
    upload: () => ({ done: Promise.resolve({} as any), abort: () => {} }),
    events: () => () => {},
  };
}

test("renderPreview media-info fetches json and renders metadata", async () => {
  const p: Preview = { kind: "media-info", path: "media/ingest.json", label: "Your video" };
  const api = createMockApi({
    get: async (url) => {
      assert.equal(url, "/api/projects/p1/files/media/ingest.json");
      return {
        file: "media/test.mp4",
        durationSec: 12.34,
        width: 1920,
        height: 1080,
        fps: 30,
        videoCodec: "h264",
      };
    },
  });

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  assert.ok(el.classList.contains("preview-media-info"));
  assert.ok(el.textContent.includes("1920x1080"));
  assert.ok(el.textContent.includes("12.34s"));
  assert.ok(el.textContent.includes("30 fps"));
});

test("renderPreview video renders video tag and Show in Finder button", async () => {
  const p: Preview = { kind: "video", path: "renders/final.mp4", label: "Your video" };
  let finderCalledWith: any = null;
  const api = createMockApi({
    send: async (method, url, body) => {
      if (method === "POST" && url === "/api/show-in-finder") {
        finderCalledWith = body;
        return { ok: true };
      }
    },
  });

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  const video = el.querySelector("video");
  assert.ok(video);
  assert.equal(video?.getAttribute("src"), "/api/projects/p1/files/renders/final.mp4");

  const btn = el.querySelector(".btn-finder");
  assert.ok(btn);
  await btn?.click();
  assert.deepEqual(finderCalledWith, { path: "renders/final.mp4", projectId: "p1" });
});

test("renderPreview audio renders audio player and waveform canvas", async () => {
  const p: Preview = { kind: "audio", path: "audio/mix.wav", label: "Sound" };
  let peaksUrl = "";
  const api = createMockApi({
    get: async (url) => {
      peaksUrl = url;
      return { peaks: [0.1, 0.5, 0.9, 0.3] };
    },
  });

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  const audio = el.querySelector("audio");
  assert.ok(audio);
  assert.equal(audio?.getAttribute("src"), "/api/projects/p1/files/audio/mix.wav");
  const canvas = el.querySelector("canvas");
  assert.ok(canvas);
  assert.ok(peaksUrl.includes("/api/projects/p1/peaks"));
  assert.ok(decodeURIComponent(peaksUrl).includes("audio/mix.wav"));
});

test("renderPreview words renders words with timestamps and low confidence underlines", async () => {
  const p: Preview = { kind: "words", path: "transcript/words.json", label: "What was said" };
  const api = createMockApi({
    get: async () => ({
      words: [
        { w: "hello", start: 0, end: 0.5, conf: 0.95 },
        { w: "unclear", start: 0.6, end: 1.0, conf: 0.4 },
        { w: "world", start: 1.2, end: 1.8, conf: 0.8 },
      ],
    }),
  });

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  assert.ok(el.textContent.includes("[00:00.00] hello"));
  assert.ok(el.textContent.includes("[00:00.60] unclear"));
  const lowConf = el.querySelector(".low-conf");
  assert.ok(lowConf);
  assert.equal(lowConf?.textContent, "unclear");
});

test("renderPreview edl renders segment bar, counts by reason, and new total duration", async () => {
  const p: Preview = { kind: "edl", path: "cut/edl.json", label: "What was cut" };
  const api = createMockApi({
    get: async () => ({
      sourceDurationSec: 10,
      outDurationSec: 5,
      keep: [{ start: 0, end: 5 }],
      removed: [
        { start: 5, end: 7, reason: "silence" },
        { start: 7, end: 8, reason: "filler" },
        { start: 8, end: 10, reason: "retake" },
      ],
    }),
  });

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  const bar = el.querySelector(".edl-bar");
  assert.ok(bar);
  const segments = el.querySelectorAll(".edl-segment");
  assert.equal(segments.length, 4);

  assert.ok(el.textContent.includes("1 silence"));
  assert.ok(el.textContent.includes("1 filler"));
  assert.ok(el.textContent.includes("1 retake"));
  assert.ok(el.textContent.includes("00:05.00")); // new total duration
});

test("renderPreview units renders subtitle lines", async () => {
  const p: Preview = { kind: "units", path: "localize/units.json", label: "Subtitle lines" };
  const api = createMockApi({
    get: async () => ({
      units: [
        { id: 1, start: 0, end: 2, text: "First subtitle line" },
        { id: 2, start: 2.5, end: 4.5, text: "Second subtitle line" },
      ],
    }),
  });

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  assert.ok(el.textContent.includes("First subtitle line"));
  assert.ok(el.textContent.includes("Second subtitle line"));
  assert.ok(el.textContent.includes("00:00.00"));
});

test("renderPreview captions loads captions.txt and renders lines", async () => {
  const p: Preview = { kind: "captions", path: "captions/captions.txt", label: "Captions" };
  const api = createMockApi({
    text: async () => "Line one\nLine two\nLine three",
  });

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  assert.ok(el.textContent.includes("Line one"));
  assert.ok(el.textContent.includes("Line two"));
  assert.ok(el.textContent.includes("Line three"));
});

test("renderPreview text renders with Copy button", async () => {
  let copiedText = "";
  if (typeof navigator === "undefined") {
    (globalThis as any).navigator = {};
  }
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (t: string) => {
        copiedText = t;
      },
    },
    configurable: true,
  });

  const p: Preview = { kind: "text", path: "chapters/youtube.txt", label: "Chapters" };
  const api = createMockApi({
    text: async () => "00:00 Intro\n01:30 Middle\n03:00 End",
  });

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  assert.ok(el.textContent.includes("00:00 Intro"));
  const copyBtn = el.querySelector(".btn-copy");
  assert.ok(copyBtn);
  await copyBtn?.click();
  assert.equal(copiedText, "00:00 Intro\n01:30 Middle\n03:00 End");
  const copyNotice = el.querySelector(".copy-notice");
  assert.equal(copyNotice?.textContent, "Copied!");
});

test("renderPreview image renders img with correct src and alt", async () => {
  const p: Preview = { kind: "image", path: "renders/contact-sheet.jpg", label: "Contact sheet" };
  const api = createMockApi({});

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  const img = el.querySelector("img");
  assert.ok(img);
  assert.equal(img?.getAttribute("src"), "/api/projects/p1/files/renders/contact-sheet.jpg");
  assert.equal(img?.getAttribute("alt"), "Contact sheet");
});

test("renderPreview report loads text and renders in pre element", async () => {
  const p: Preview = { kind: "report", path: "renders/qa.md", label: "QA Report" };
  const api = createMockApi({
    text: async () => "# QA Report\nEverything passed.",
  });

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  const pre = el.querySelector("pre");
  assert.ok(pre);
  assert.ok(pre?.textContent.includes("# QA Report"));
});

test("renderPreview handles load errors gracefully", async () => {
  const p: Preview = { kind: "report", path: "renders/missing.md", label: "Missing Report" };
  const api = createMockApi({
    text: async () => {
      throw new Error("File not found");
    },
  });

  const el = (await renderPreview(p, api, "p1")) as unknown as MockElement;
  assert.ok(el.querySelector(".preview-error"));
  assert.ok(el.textContent.includes("File not found"));
});
