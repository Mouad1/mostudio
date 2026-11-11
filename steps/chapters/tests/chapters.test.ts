import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { Config, PickedProvider, ProviderRegistry, Word } from "../../../core/src/index.ts";
import { NoProviderError, runStep, writeJsonAtomic } from "../../../core/src/index.ts";
import { chapters, formatYoutube, parseChapters, postProcess } from "../src/chapters.ts";
import { buildTranscript } from "../src/prompt.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", home: "/x" };
const fakeProvider = (id: string): PickedProvider => ({
  id,
  capabilities: ["llm"],
  kind: "openai-compat",
  baseUrl: `https://${id}.example/v1`,
  model: `${id}-model`,
  limits: {},
  reset: { tz: "UTC" },
  flags: { commercial_ok: true, trains_on_data: false, renewable: true },
  priority: { llm: 1 },
  key: { reveal: () => "k" } as PickedProvider["key"],
  envValues: {},
});
function registry(ids: string[]): ProviderRegistry {
  return {
    async pick(_cap, opts) {
      const id = ids.find((i) => !(opts?.exclude ?? []).includes(i));
      if (!id) throw new NoProviderError("llm", []);
      return fakeProvider(id);
    },
    async recordUse() {},
    async markExhausted() {},
  };
}

const realFetch = globalThis.fetch;
let bodies: { url: string; body: { messages: { role: string; content: string }[] } }[] = [];
function fakeLlm(replies: Record<string, string>): void {
  bodies = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    bodies.push({ url, body: JSON.parse(String(init.body)) });
    const host = new URL(url).host.split(".")[0];
    return new Response(JSON.stringify({ choices: [{ message: { content: replies[host] ?? "{}" } }] }), { status: 200 });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mostudio-chapters-"));
  for (const d of ["transcript", "cut"]) await mkdir(join(dir, d), { recursive: true });
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const W = (w: string, start: number, end: number): Word => ({ w, start, end });
/** words every 1 s for `n` seconds with a pause (1.5 s) every `every` words; returns words + total duration */
function talk(n: number, every = 20): Word[] {
  const out: Word[] = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    out.push(W(`w${i}`, t, t + 0.5));
    t += 0.5 + (i % every === every - 1 ? 1.5 : 0.5);
  }
  return out;
}
async function seed(words: Word[], keep: { start: number; end: number }[]) {
  await writeJsonAtomic(join(dir, "transcript", "words.json"), { language: "en", words, segments: [] });
  await writeJsonAtomic(join(dir, "cut", "edl.json"), { source: "m.mp4", fadeSec: 0.01, keep, removed: [], outDurationSec: keep.reduce((s, k) => s + k.end - k.start, 0) });
}
const run = (ids: string[], params: Record<string, unknown> = {}) => runStep(dir, chapters, { params, config, providers: registry(ids), force: true });

test("chapters are sorted, first at 0, short ones merged", async () => {
  await seed(talk(240), [{ start: 0, end: 300 }]);
  fakeLlm({ gem: JSON.stringify({ chapters: [{ start: 120, title: "Middle" }, { start: 5, title: "Intro" }, { start: 123, title: "Too close" }, { start: 200, title: "End" }] }) });
  const r = await run(["gem"]);
  assert.equal(r.metrics.fallback, false);
  assert.equal(r.metrics.provider, "gem");
  assert.equal(r.metrics.firstAtZero, true);
  const saved = JSON.parse(await readFile(join(dir, "chapters", "chapters.json"), "utf8")) as { start: number; title: string }[];
  assert.deepEqual(saved.map((c) => c.title), ["Intro", "Middle", "End"]);
  assert.equal(saved[0].start, 0);
  assert.ok(saved.every((c, i) => i === 0 || c.start - saved[i - 1].start >= 10));
});

test("youtube.txt uses mm:ss and h:mm:ss past an hour", () => {
  assert.equal(formatYoutube([{ start: 0, title: "A" }, { start: 65, title: "B" }]), "00:00 A\n01:05 B\n");
  assert.equal(formatYoutube([{ start: 0, title: "A" }, { start: 3725, title: "B" }]), "00:00 A\n1:02:05 B\n");
});

test("invalid JSON from the model falls back to the next provider", async () => {
  await seed(talk(240), [{ start: 0, end: 300 }]);
  fakeLlm({ bad: "not json at all", good: "```json\n" + JSON.stringify({ chapters: [{ start: 0, title: "One" }, { start: 100, title: "Two" }, { start: 200, title: "Three" }] }) + "\n```" });
  const r = await run(["bad", "good"]);
  assert.equal(r.metrics.provider, "good");
  assert.equal(r.metrics.fallback, false);
  assert.equal(bodies.length, 2);
  assert.ok(parseChapters('{"chapters":[{"start":1,"title":"x"}]}', 10).length === 1);
  assert.throws(() => parseChapters('{"chapters":[{"start":99,"title":"x"}]}', 10));
  assert.throws(() => parseChapters('{"chapters":[]}', 10));
  assert.throws(() => parseChapters('{"chapters":[{"start":1,"title":""}]}', 10));
});

test("no LLM available: pause-based chapters with fallback warn", async () => {
  await seed(talk(400, 50), [{ start: 0, end: 500 }]);
  fakeLlm({});
  const r = await run([]);
  assert.equal(r.metrics.fallback, true);
  assert.equal(r.metrics.provider, "none");
  assert.equal(r.metrics.firstAtZero, true);
  assert.ok((r.metrics.chapterCount as number) >= 2);
  assert.ok((r.metrics.minChapterSec as number) >= 10);
  assert.equal(bodies.length, 0);
  const txt = await readFile(join(dir, "chapters", "youtube.txt"), "utf8");
  assert.ok(txt.startsWith("00:00 w0 w1 w2 w3 w4 w5\n"));
  assert.equal(r.status, "warn");
  assert.ok(r.verdicts.some((v) => v.metric === "fallback" && !v.ok));
});

test("transcript sent to the model is in the cut timeline", async () => {
  // source 0-10 removed; keep 10-100 → source word at 10 appears at [00:00]
  const words = [W("alpha", 2, 2.5), W("beta", 10, 10.5), W("gamma", 40, 40.5), W("delta", 41, 41.5), W("omega", 95, 95.5)];
  const t = buildTranscript(words.filter((w) => w.start >= 10).map((w) => ({ ...w, start: w.start - 10, end: w.end - 10 })));
  assert.match(t, /^\[00:00\] beta/);
  assert.ok(!t.includes("alpha"));
  await seed(words, [{ start: 10, end: 100 }]);
  fakeLlm({ gem: JSON.stringify({ chapters: [{ start: 0, title: "a" }] }) });
  await run(["gem"]);
  const user = bodies[0].body.messages.find((m) => m.role === "user")?.content ?? "";
  assert.match(user, /\[00:00\] beta\n\[00:30\] gamma delta/);
  assert.match(user, /\[01:25\] omega/);
  assert.ok(!user.includes("alpha"));
});

test("video under 30 s gets a single chapter at 0 without calling the model", async () => {
  await seed(talk(10), [{ start: 0, end: 12 }]);
  fakeLlm({});
  const r = await run(["gem"]);
  assert.equal(r.metrics.chapterCount, 1);
  assert.equal(bodies.length, 0);
});

test("postProcess snaps to sentence starts, trims titles on a word boundary", () => {
  const words = [W("a", 0, 1), W("b", 1.1, 2), W("c", 60, 61), W("d", 61.1, 62), W("e", 120, 121)];
  const out = postProcess([{ start: 4, title: "x" }, { start: 63, title: "word ".repeat(20) }], words, 130);
  assert.equal(out[0].start, 0);
  assert.equal(out[1].start, 60);
  assert.ok(out[1].title.length <= 50 && !out[1].title.endsWith(" "));
});
