import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { scaffoldWorkspace } from "./scaffold.ts";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "mostudio-scaffold-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("scaffold creates once, then keeps", async () => {
  const ws = join(tmp, "fresh-ws");
  const first = await scaffoldWorkspace(ws);
  assert.ok(first.every((e) => e.status === "created"));
  assert.ok(existsSync(join(ws, "inspiration/shorts/media")));
  assert.match(readFileSync(join(ws, "inspiration/long/README.md"), "utf8"), /does not read them automatically yet/);
  const second = await scaffoldWorkspace(ws);
  assert.ok(second.every((e) => e.status === "kept"));
});

test("never overwrites existing links or config", async () => {
  const ws = join(tmp, "custom-ws");
  mkdirSync(join(ws, "inspiration", "shorts"), { recursive: true });
  const customConfig = "{\"billing\":\"allow-paid\",\"custom\":true}\n";
  const customLinks = "https://example.com/clip # custom note\n";
  writeFileSync(join(ws, "mostudio.config.json"), customConfig);
  writeFileSync(join(ws, "inspiration/shorts/links.txt"), customLinks);

  const res = await scaffoldWorkspace(ws);
  const configEntry = res.find((e) => e.path === "mostudio.config.json");
  const linksEntry = res.find((e) => e.path === "inspiration/shorts/links.txt");
  assert.equal(configEntry?.status, "kept");
  assert.equal(linksEntry?.status, "kept");

  assert.equal(readFileSync(join(ws, "mostudio.config.json"), "utf8"), customConfig);
  assert.equal(readFileSync(join(ws, "inspiration/shorts/links.txt"), "utf8"), customLinks);
});

test("no .gitignore outside a git repo; only missing lines inside one", async () => {
  // Outside git repo
  const wsNoGit = join(tmp, "no-git-ws");
  const resNoGit = await scaffoldWorkspace(wsNoGit);
  assert.equal(existsSync(join(wsNoGit, ".gitignore")), false);
  assert.equal(resNoGit.some((e) => e.path === ".gitignore"), false);

  // Inside fresh git repo (.git exists, no .gitignore)
  const wsGitFresh = join(tmp, "git-fresh-ws");
  mkdirSync(join(wsGitFresh, ".git"), { recursive: true });
  const resGitFresh = await scaffoldWorkspace(wsGitFresh);
  assert.ok(existsSync(join(wsGitFresh, ".gitignore")));
  assert.equal(resGitFresh.find((e) => e.path === ".gitignore")?.status, "created");
  const freshContent = readFileSync(join(wsGitFresh, ".gitignore"), "utf8");
  assert.equal(freshContent, ".env.local\nprojects/\ninspiration/**/media/\n");

  // Inside git repo with pre-existing partial .gitignore
  const wsGitPartial = join(tmp, "git-partial-ws");
  mkdirSync(join(wsGitPartial, ".git"), { recursive: true });
  writeFileSync(join(wsGitPartial, ".gitignore"), "# User ignores\n.env.local\n");
  const resGitPartial = await scaffoldWorkspace(wsGitPartial);
  assert.equal(resGitPartial.find((e) => e.path === ".gitignore")?.status, "kept");
  const partialContent = readFileSync(join(wsGitPartial, ".gitignore"), "utf8");
  assert.equal(partialContent.match(/\.env\.local/g)?.length, 1);
  assert.match(partialContent, /^projects\/$/m);
  assert.match(partialContent, /^inspiration\/\*\*\/media\/$/m);
});

test("path with spaces and accents", async () => {
  const ws = join(tmp, "Mes vidéos été");
  const entries = await scaffoldWorkspace(ws);
  assert.ok(entries.length > 0);
  assert.ok(existsSync(join(ws, "mostudio.config.json")));
  assert.ok(existsSync(join(ws, "projects/README.md")));
});
