import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { after, before, test } from "node:test";
import { getSecret, loadConfig, loadEnvFile } from "./config.ts";

let tmp: string;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mostudio-config-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("env file parses quotes and comments", async () => {
  const f = join(tmp, ".env.local");
  await writeFile(f, `# comment\n\nA="x y"\nB=z\nC='q r'\nD=\nE=a#b\n`);
  assert.deepEqual(loadEnvFile(f), { A: "x y", B: "z", C: "q r", D: "", E: "a#b" });
});

test("missing env file gives empty object", () => {
  assert.deepEqual(loadEnvFile(join(tmp, "nope.env")), {});
});

test("secret never serializes its value", () => {
  assert.equal(
    JSON.stringify({ k: getSecret("GROQ_API_KEY", { GROQ_API_KEY: "abc" }) }),
    '{"k":"[secret:GROQ_API_KEY]"}',
  );
});

test("secret hides value in toString, template and inspect", () => {
  const s = getSecret("K", { K: "supersecret" });
  assert.ok(s);
  assert.equal(s.reveal(), "supersecret");
  assert.equal(`${s}`, "[secret:K]");
  assert.ok(!inspect(s).includes("supersecret"));
  assert.ok(!inspect({ nested: s }, { depth: 5 }).includes("supersecret"));
});

test("getSecret undefined when missing or empty", () => {
  assert.equal(getSecret("K", {}), undefined);
  assert.equal(getSecret("K", { K: "" }), undefined);
});

test("loadConfig defaults when file missing", async () => {
  const c = await loadConfig(tmp, {});
  assert.deepEqual(c, {
    billing: "free-only",
    projectsRoot: join(tmp, "projects"),
    inspirationRoot: join(tmp, "inspiration"),
    home: join(homedir(), ".mostudio"),
  });
});

test("loadConfig reads file, resolves projectsRoot, honours MOSTUDIO_HOME", async () => {
  const root = await mkdtemp(join(tmp, "r-"));
  await writeFile(
    join(root, "mostudio.config.json"),
    JSON.stringify({ billing: "allow-paid", projectsRoot: "out" }),
  );
  const c = await loadConfig(root, { MOSTUDIO_HOME: "/x/home" });
  assert.deepEqual(c, {
    billing: "allow-paid",
    projectsRoot: join(root, "out"),
    inspirationRoot: join(root, "inspiration"),
    home: "/x/home",
  });
});

test("inspirationRoot defaults to <root>/inspiration and resolves relative paths", async () => {
  const root = await mkdtemp(join(tmp, "insp-"));
  const def = await loadConfig(root, {});
  assert.equal(def.inspirationRoot, join(root, "inspiration"));

  await writeFile(
    join(root, "mostudio.config.json"),
    JSON.stringify({ inspirationRoot: "my-inspiration" }),
  );
  const rel = await loadConfig(root, {});
  assert.equal(rel.inspirationRoot, join(root, "my-inspiration"));

  await writeFile(
    join(root, "mostudio.config.json"),
    JSON.stringify({ inspirationRoot: "/custom/inspiration" }),
  );
  const abs = await loadConfig(root, {});
  assert.equal(abs.inspirationRoot, "/custom/inspiration");
});

test("non-string inspirationRoot throws error", async () => {
  const root = await mkdtemp(join(tmp, "insp-bad-"));
  await writeFile(
    join(root, "mostudio.config.json"),
    JSON.stringify({ inspirationRoot: 123 }),
  );
  await assert.rejects(loadConfig(root, {}), /mostudio\.config\.json: inspirationRoot must be a string/);
});

test("loadConfig rejects invalid billing", async () => {
  const root = await mkdtemp(join(tmp, "bad-"));
  await writeFile(join(root, "mostudio.config.json"), JSON.stringify({ billing: "yolo" }));
  await assert.rejects(loadConfig(root, {}), /billing/);
});

test("env file: quoted value with trailing comment, export, '=' in value, CRLF", async () => {
  const f = join(tmp, "e2.env");
  await writeFile(
    f,
    `A="abc" # note\r\nB='d e'   # n\r\nexport C=v\r\nD=b=c\r\nE="has # hash"\r\nF=plain # c\r\n`,
  );
  assert.deepEqual(loadEnvFile(f), { A: "abc", B: "d e", C: "v", D: "b=c", E: "has # hash", F: "plain" });
});
