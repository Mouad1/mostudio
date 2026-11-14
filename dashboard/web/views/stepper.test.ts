import assert from "node:assert/strict";
import { test } from "node:test";
import type { PipelineState, StepCard } from "../lib/pipeline.ts";
import { renderStepper, badgeText } from "./stepper.ts";

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

  click() {
    const fns = this.eventListeners["click"] || [];
    for (const fn of fns) {
      fn({ target: this, preventDefault: () => {} });
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
      }
      for (const child of el.children) {
        walk(child);
      }
    };
    for (const child of this.children) {
      walk(child);
    }
    return results;
  }
}

// Setup global DOM mocks
(globalThis as any).Node = MockNode;
(globalThis as any).document = {
  createElement: (tag: string) => new MockElement(tag),
  createTextNode: (text: string) => new MockTextNode(text),
};

function createCard(step: string, state: StepCard["state"], extra: Partial<StepCard> = {}): StepCard {
  return {
    step,
    approve: false,
    state,
    logs: [],
    ...extra,
  };
}

test("badgeText returns exact human copy", () => {
  assert.equal(badgeText(createCard("ingest", "idle")), "Waiting");
  assert.equal(badgeText(createCard("ingest", "running")), "Running…");
  assert.equal(badgeText(createCard("ingest", "pass")), "Done");
  assert.equal(badgeText(createCard("ingest", "pass", { autoApproved: true })), "Approved automatically");
  assert.equal(badgeText(createCard("cut", "warn")), "Done with warnings");
  assert.equal(badgeText(createCard("cut", "fail")), "Failed");
  assert.equal(badgeText(createCard("mix", "cached")), "Reused");
  assert.equal(badgeText(createCard("captions", "awaiting")), "Needs your review");
  assert.equal(badgeText(createCard("assemble", "interrupted")), "Interrupted");
  assert.equal(badgeText(createCard("assemble", "cancelled")), "Stopped");
});

test("renderStepper renders cards, labels, badges and elapsed time", () => {
  const state: PipelineState = {
    workflow: "short",
    mode: "manual",
    running: false,
    lastEventId: 10,
    cards: [
      createCard("ingest", "pass", { durationMs: 4_000 }),
      createCard("cut", "running", { startedAt: 100 }),
      createCard("captions", "idle"),
    ],
  };

  let selectedStep: string | null = null;
  const el = renderStepper(state, {
    selected: "cut",
    onSelect: (step) => {
      selectedStep = step;
    },
  }) as unknown as MockElement;

  const cardElements = el.querySelectorAll(".step-card");
  assert.equal(cardElements.length, 3);

  // First card: ingest (Import)
  const c0 = cardElements[0]!;
  assert.equal(c0.querySelector(".step-card-label")?.textContent, "Import");
  assert.equal(c0.querySelector(".step-badge")?.textContent, "Done");
  assert.equal(c0.classList.contains("selected"), false);
  assert.equal(c0.querySelector(".step-card-elapsed")?.textContent, "0:04");

  // Second card: cut (Cut silences) - selected
  const c1 = cardElements[1]!;
  assert.equal(c1.querySelector(".step-card-label")?.textContent, "Cut silences");
  assert.equal(c1.querySelector(".step-badge")?.textContent, "Running…");
  assert.equal(c1.classList.contains("selected"), true);

  // Third card: captions (Captions) - idle
  const c2 = cardElements[2]!;
  assert.equal(c2.querySelector(".step-card-label")?.textContent, "Captions");
  assert.equal(c2.querySelector(".step-badge")?.textContent, "Waiting");
  assert.equal(c2.classList.contains("selected"), false);

  // Click on first card
  c0.click();
  assert.equal(selectedStep, "ingest");
});
