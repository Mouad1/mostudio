import assert from "node:assert/strict";
import { test } from "node:test";
import { h, openDetailsKeys, restoreOpenDetails } from "./dom.ts";

test("open details survive a re-render, matched by data-key then position", () => {
  const details = (attrs: Record<string, string>) => {
    const a: Record<string, string> = { ...attrs };
    return {
      getAttribute: (n: string) => (n in a ? a[n]! : null),
      setAttribute: (n: string, v: string) => {
        a[n] = v;
      },
      attrs: a,
    };
  };
  const host = (els: ReturnType<typeof details>[]) => ({ querySelectorAll: () => els as unknown as ArrayLike<Element> });

  const before = [details({ "data-key": "error:boom", open: "" }), details({}), details({ open: "" })];
  const keys = openDetailsKeys(host(before));
  assert.deepEqual([...keys], ["error:boom", "#2"]);

  const after = [details({}), details({ "data-key": "error:boom" }), details({})];
  restoreOpenDetails(host(after), keys);
  assert.deepEqual(after.map((d) => "open" in d.attrs), [false, true, true]);
});

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
  eventListeners: Record<string, Function[]> = {};
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
  addEventListener(name: string, fn: Function) {
    this.eventListeners[name] = this.eventListeners[name] || [];
    this.eventListeners[name]!.push(fn);
  }
}

test("h creates elements and sets attributes and children safely", () => {
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
    let clicked = false;
    const el = h(
      "div",
      { id: "box", class: "card", onclick: () => { clicked = true; } },
      "Hello ",
      h("span", { class: "bold" }, "World"),
      null,
      undefined,
      false
    ) as any;

    assert.equal(el.tagName, "div");
    assert.equal(el.getAttribute("id"), "box");
    assert.equal(el.className, "card");
    assert.equal(el.childNodes.length, 2);
    assert.equal(el.childNodes[0].textContent, "Hello ");
    assert.equal(el.childNodes[1].tagName, "span");
    assert.equal(el.childNodes[1].childNodes[0].textContent, "World");

    el.eventListeners["click"][0]();
    assert.equal(clicked, true);
  } finally {
    (globalThis as any).document = originalDoc;
    (globalThis as any).Node = originalNode;
  }
});
