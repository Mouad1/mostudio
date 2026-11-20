import assert from "node:assert/strict";
import { test } from "node:test";
import { errorBox } from "./error-box.ts";

class MockNode {
  childNodes: any[] = [];
  appendChild(child: any) {
    this.childNodes.push(child);
    return child;
  }
}

class MockTextNode extends MockNode {
  textContent: string;
  constructor(text: string) {
    super();
    this.textContent = text;
  }
}

class MockElement extends MockNode {
  tagName: string;
  attributes: Record<string, string> = {};
  className = "";

  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
    if (name === "class") this.className = value;
  }
  getAttribute(name: string) {
    return this.attributes[name];
  }
  addEventListener() {}
}

test("errorBox renders title, advice, action and raw message details", () => {
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

  try {
    const rawMsg = 'No provider available for "stt": groq: no-key';
    const box = errorBox(rawMsg) as any;

    assert.equal(box.tagName, "div");
    assert.equal(box.className, "error-box");

    // Children: h3 (title), p (advice), a (action link), details
    const [titleEl, adviceEl, actionEl, detailsEl] = box.childNodes;

    assert.equal(titleEl.tagName, "h3");
    assert.equal(titleEl.childNodes[0].textContent, "No transcription service available");

    assert.equal(adviceEl.tagName, "p");
    assert.equal(adviceEl.childNodes[0].textContent, "Add a free Groq key so mostudio can turn speech into text.");

    assert.equal(actionEl.tagName, "a");
    assert.equal(actionEl.getAttribute("href"), "#settings");
    assert.equal(actionEl.childNodes[0].textContent, "Open settings");

    assert.equal(detailsEl.tagName, "details");
    const [summaryEl, preEl] = detailsEl.childNodes;
    assert.equal(summaryEl.tagName, "summary");
    assert.equal(summaryEl.childNodes[0].textContent, "Details");

    assert.equal(preEl.tagName, "pre");
    const codeEl = preEl.childNodes[0];
    assert.equal(codeEl.tagName, "code");
    assert.equal(codeEl.childNodes[0].textContent, rawMsg);
  } finally {
    (globalThis as any).document = originalDoc;
    (globalThis as any).Node = originalNode;
  }
});

test("errorBox renders without action link when not applicable", () => {
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

  try {
    const rawMsg = "cancelled by user";
    const box = errorBox(rawMsg) as any;

    assert.equal(box.tagName, "div");
    // Children: h3, p, details (null action link omitted)
    const childTags = box.childNodes.map((c: any) => c.tagName);
    assert.deepEqual(childTags, ["h3", "p", "details"]);
  } finally {
    (globalThis as any).document = originalDoc;
    (globalThis as any).Node = originalNode;
  }
});

test("errorBox hides Details when they only repeat the message", () => {
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
  try {
    const tags = (msg: string) => (errorBox(msg) as any).childNodes.map((c: any) => c.tagName);
    // The upload refusal: the advice already is the server's message.
    assert.deepEqual(
      tags("mostudio can't read this file (it may be damaged or not a real video/audio file). Try exporting it again."),
      ["h3", "p"],
    );
    assert.deepEqual(tags("mostudio can't use this file type (.py). Use a video or audio file."), ["h3", "p"]);
    // An unmapped one-line message is shown as the advice (capitalised): nothing more to show.
    assert.deepEqual(tags("something odd happened"), ["h3", "p"]);
    // More than the advice shows (a stack, a second line, the engine's own words): keep Details.
    assert.deepEqual(tags("something odd happened\n    at run (x.ts:1:1)"), ["h3", "p", "details"]);
    assert.deepEqual(tags("ffmpeg: moov atom not found"), ["h3", "p", "details"]);
  } finally {
    (globalThis as any).document = originalDoc;
    (globalThis as any).Node = originalNode;
  }
});
