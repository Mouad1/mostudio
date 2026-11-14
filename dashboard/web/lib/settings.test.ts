import assert from "node:assert/strict";
import { test } from "node:test";
import type { SettingField } from "../../src/types.ts";
import { dirtyValues, groupFields, sourceText } from "./settings.ts";

function f(
  name: string,
  providers: string[],
  recommended: boolean = false,
  kind: "secret" | "text" | "path" = "secret",
  source: "app" | "workspace" | "process" | "unset" = "unset",
  masked: string = ""
): SettingField {
  return {
    name,
    kind,
    providers,
    label: name,
    help: "",
    recommended,
    source,
    masked,
  };
}

test("groupFields puts recommended providers first and sorts alphabetically", () => {
  const g = groupFields([
    f("MISTRAL_API_KEY", ["mistral"]),
    f("GROQ_API_KEY", ["groq"], true),
    f("GEMINI_API_KEY", ["gemini"], true),
    f("WHISPER_MODELS_DIR", [], false, "path"),
  ]);
  assert.deepEqual(g.recommended.map((x) => x.id), ["gemini", "groq"]);
  assert.deepEqual(g.more.map((x) => x.id), ["mistral"]);
  assert.deepEqual(g.paths.map((x) => x.name), ["WHISPER_MODELS_DIR"]);
  assert.equal(g.recommended[0].title, "Google Gemini");
  assert.equal(g.recommended[1].title, "Groq");
  assert.equal(g.more[0].title, "Mistral");
});

test("groupFields handles multiple providers and custom provider titles", () => {
  const g = groupFields([
    f("MULTI_KEY", ["cloudflare", "openrouter"], false),
    f("CUSTOM_KEY", ["unknownprovider"], false),
  ]);
  assert.equal(g.more.length, 3);
  const cf = g.more.find((x) => x.id === "cloudflare")!;
  const or = g.more.find((x) => x.id === "openrouter")!;
  const unk = g.more.find((x) => x.id === "unknownprovider")!;
  assert.equal(cf.title, "Cloudflare");
  assert.equal(or.title, "Openrouter");
  assert.equal(unk.title, "Unknownprovider");
  assert.equal(cf.fields[0].name, "MULTI_KEY");
  assert.equal(or.fields[0].name, "MULTI_KEY");
});

test("dirtyValues only reports changes", () => {
  assert.deepEqual(dirtyValues([f("A", [])], { A: "new" }), { A: "new" });
  assert.deepEqual(dirtyValues([f("A", [])], {}), {});
  assert.deepEqual(dirtyValues([f("A", [])], { A: "" }), {});
  assert.deepEqual(
    dirtyValues([f("A", [], false, "secret", "app", "••••1234")], { A: "••••1234" }),
    {}
  );
  assert.deepEqual(
    dirtyValues([f("PATH", [], false, "path", "app", "/old/path")], { PATH: "/old/path" }),
    {}
  );
  assert.deepEqual(
    dirtyValues([f("PATH", [], false, "path", "app", "/old/path")], { PATH: "/new/path" }),
    { PATH: "/new/path" }
  );
});

test("sourceText formats sources accurately", () => {
  assert.equal(sourceText(f("A", [], false, "secret", "app")), "Saved in mostudio");
  assert.equal(
    sourceText(f("A", [], false, "secret", "workspace")),
    "Set in this workspace's .env.local (overrides mostudio)"
  );
  assert.match(
    sourceText({ source: "process" } as SettingField),
    /can't be changed here/
  );
  assert.equal(sourceText(f("A", [], false, "secret", "unset")), "Not set");
});
