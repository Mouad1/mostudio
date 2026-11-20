import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const ALL_RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1]!.trim(),
  body: m[2]!,
}));

/** Rules whose selector list contains exactly `selector` (media-query rules included). */
function rules(selector: string): { selector: string; body: string }[] {
  return ALL_RULES.filter((r) => r.selector.split(",").some((s) => s.trim() === selector));
}

/** The last rule whose selector contains `needle`, as { selector, body }. */
function lastRule(needle: string): { selector: string; body: string } | undefined {
  return ALL_RULES.filter((r) => r.selector.includes(needle)).at(-1);
}

test("inspiration shelves shrink to a 390 px phone instead of overflowing (QA M6)", () => {
  // A grid track of plain 1fr can't shrink below its longest unbreakable URL.
  const tracks = rules(".inspiration-shelves").map((r) => /grid-template-columns:\s*([^;]+);/.exec(r.body)?.[1]);
  assert.ok(tracks.length > 0);
  for (const t of tracks) {
    const bare = (t ?? "").replace(/minmax\(0,\s*1fr\)/g, "");
    assert.doesNotMatch(bare, /1fr/, `track "${t}" must be minmax(0, 1fr)`);
  }
  const has = (selector: string, decl: RegExp) =>
    assert.ok(rules(selector).some((r) => decl.test(r.body)), `${selector} needs ${decl}`);
  has(".inspiration-shelf", /min-width:\s*0/);
  has(".btn-remove-file", /flex-shrink:\s*0/);
  has(".btn-remove-link", /flex-shrink:\s*0/);
  has(".dropzone-idle-content", /flex-wrap:\s*wrap/);
});

test("keyboard focus is visible on every interactive element (QA m5)", () => {
  const rule = lastRule(":focus-visible");
  assert.ok(rule, "a :focus-visible rule exists");
  for (const sel of ["button", "select", "input", "textarea", "a", '[role="button"]', "[tabindex]"]) {
    assert.ok(rule!.selector.includes(sel), `focus ring covers ${sel}`);
  }
  assert.match(rule!.body, /outline:\s*2px solid var\(--accent\)/);
});
