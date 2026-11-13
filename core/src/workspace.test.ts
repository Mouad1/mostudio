import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { findWorkspace, loadProvidersFile, PACKAGE_ROOT, resolveShared } from "./workspace.ts";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "mostudio-workspace-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("findWorkspace walks up to the folder with mostudio.config.json", () => {
  const ws = join(tmp, "ws");
  const nested = join(ws, "sub", "dir");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(ws, "mostudio.config.json"), "{}");

  assert.equal(findWorkspace(nested), ws);
  assert.equal(findWorkspace(ws), ws);
  assert.equal(findWorkspace(tmp), undefined);
});

test("resolveShared prefers the workspace copy, falls back to the package", () => {
  const ws = join(tmp, "shared-ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "providers.json"), "[]");

  // Local file exists in workspace -> prefers workspace copy
  assert.equal(resolveShared(ws, "providers.json"), join(ws, "providers.json"));

  // File does not exist in workspace -> falls back to package
  assert.equal(resolveShared(ws, "workflows"), join(PACKAGE_ROOT, "workflows"));
});

test("loadProvidersFile reads the package providers.json for an empty workspace", async () => {
  const ws = join(tmp, "empty-ws");
  mkdirSync(ws, { recursive: true });

  const providers = await loadProvidersFile(ws);
  assert.ok(Array.isArray(providers));
  assert.ok(providers.length > 0);
  assert.ok(providers.some((p) => p.id === "groq" || p.id === "cloudflare" || p.id === "openai"));
});
