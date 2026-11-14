import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { defaultWorkspace, findWorkspace, loadProvidersFile, PACKAGE_ROOT, readAppSettings, resolveShared, writeAppSettings, loadLayeredEnv } from "./workspace.ts";
import { homedir } from "node:os";

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

test("defaultWorkspace returns Movies/mostudio in homedir", () => {
  assert.equal(defaultWorkspace(), join(homedir(), "Movies", "mostudio"));
});

test("readAppSettings returns {} when missing or invalid", async () => {
  const home = join(tmp, "missing-home");
  assert.deepEqual(await readAppSettings(home), {});

  const badHome = join(tmp, "bad-home");
  mkdirSync(badHome, { recursive: true });
  writeFileSync(join(badHome, "settings.json"), "not json");
  assert.deepEqual(await readAppSettings(badHome), {});
});

test("writeAppSettings merges patches and persists atomically", async () => {
  const home = join(tmp, "app-home");
  const s1 = await writeAppSettings(home, { workspace: "/path/to/ws" });
  assert.deepEqual(s1, { workspace: "/path/to/ws" });
  assert.deepEqual(await readAppSettings(home), { workspace: "/path/to/ws" });

  const s2 = await writeAppSettings(home, { animatedCaptions: true });
  assert.deepEqual(s2, { workspace: "/path/to/ws", animatedCaptions: true });
  assert.deepEqual(await readAppSettings(home), { workspace: "/path/to/ws", animatedCaptions: true });
});

test("layered env: app < workspace < process, with sources", () => {
  const home = join(tmp, "env-home"), ws = join(tmp, "env-ws");
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(home, ".env"), "A=app\nB=app\nC=app\n");
  writeFileSync(join(ws, ".env.local"), "B=ws\nC=ws\n");
  const { env, sources } = loadLayeredEnv({ home, root: ws, processEnv: { C: "proc" } });
  assert.deepEqual([env.A, env.B, env.C], ["app", "ws", "proc"]);
  assert.deepEqual([sources.A, sources.B, sources.C], ["app", "workspace", "process"]);
});
