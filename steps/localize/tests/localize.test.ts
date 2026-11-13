import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { Config, PickedProvider, ProviderRegistry, Word } from "../../../core/src/index.ts";
import { NoProviderError, runStep, writeJsonAtomic } from "../../../core/src/index.ts";
import { groupUnits, toCut } from "../src/group.ts";
import { batches, createLocalize, parseLang } from "../src/localize.ts";

const sleeps: number[] = [];
const localize = createLocalize({ sleep: async (ms) => { sleeps.push(ms); } });
import { arabicScriptPct, buildMessages, parseReply } from "../src/prompt.ts";

const config: Config = { billing: "free-only", projectsRoot: "/x", inspirationRoot: "/x", home: "/x" };
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
const picks: { private?: boolean; prefer?: string }[] = [];
function registry(ids: string[]): ProviderRegistry {
  return {
    async pick(_cap, opts) {
      picks.push({ private: opts?.private, prefer: opts?.prefer });
      const id = ids.find((i) => !(opts?.exclude ?? []).includes(i));
      if (!id) throw new NoProviderError("llm", []);
      return fakeProvider(id);
    },
    async recordUse() {},
    async markExhausted() {},
  };
}

const realFetch = globalThis.fetch;
type Body = { messages: { role: string; content: string }[] };
let bodies: { host: string; body: Body }[] = [];
/** Fake chat endpoint: `reply(host, units)` returns the message content for that provider. */
function fakeLlm(reply: (host: string, units: { id: number; text: string }[]) => string): void {
  bodies = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    const host = new URL(url).host.split(".")[0] as string;
    bodies.push({ host, body });
    const units = JSON.parse(body.messages[1]?.content ?? "{}").units;
    return new Response(JSON.stringify({ choices: [{ message: { content: reply(host, units) } }] }), { status: 200 });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
  picks.length = 0;
});

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "mostudio-localize-"));
  for (const d of ["transcript", "cut"]) await mkdir(join(dir, d), { recursive: true });
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const W = (w: string, start: number, end: number): Word => ({ w, start, end });
async function seed(words: Word[], keep: { start: number; end: number }[]) {
  await writeJsonAtomic(join(dir, "transcript", "words.json"), { language: "ar", words, segments: [] });
  await writeJsonAtomic(join(dir, "cut", "edl.json"), { source: "m.mp4", fadeSec: 0.01, keep, removed: [], outDurationSec: keep.reduce((s, k) => s + k.end - k.start, 0) });
}
const run = (ids: string[], params: Record<string, unknown> = {}) => runStep(dir, localize, { params, config, providers: registry(ids), force: true });
const units = async () => JSON.parse(await readFile(join(dir, "localize", "units.json"), "utf8"));

test("toCut keeps transcript order, drops removed words and records the keep index", () => {
  const out = toCut([W("a", 1, 1.4), W("b", 0.9, 1.6), W("cut", 3, 3.5), W("c", 5.2, 5.5)], [{ start: 0, end: 2 }, { start: 5, end: 6 }]);
  assert.deepEqual(out, [
    { w: "a", start: 1, end: 1.4, seg: 0 },
    { w: "b", start: 0.9, end: 1.6, seg: 0 },
    { w: "c", start: 2.2, end: 2.5, seg: 1 },
  ]);
});

test("groupUnits splits on gaps over 0.6 s, keep boundaries, 7 s and 18 words", () => {
  const cw = (w: string, start: number, end: number, seg = 0) => ({ w, start, end, seg });
  const gap = groupUnits([cw("a", 0, 0.5), cw("b", 0.6, 1), cw("c", 1.7, 2)]);
  assert.deepEqual(gap.map((u) => u.text), ["a b", "c"]);
  assert.deepEqual(gap[0], { id: 1, start: 0, end: 1, text: "a b", src: "a b" });
  assert.equal(gap[1]?.id, 2);
  assert.deepEqual(groupUnits([cw("a", 0, 0.5, 0), cw("b", 0.5, 1, 1)]).map((u) => u.text), ["a", "b"]);
  const long = Array.from({ length: 16 }, (_, i) => cw(`w${i}`, i * 0.5, i * 0.5 + 0.5));
  assert.deepEqual(groupUnits(long).map((u) => u.end - u.start <= 7), [true, true]);
  assert.equal(groupUnits(long)[0]?.text.split(" ").length, 14);
  const many = Array.from({ length: 20 }, (_, i) => cw(`w${i}`, i * 0.2, i * 0.2 + 0.2));
  assert.deepEqual(groupUnits(many).map((u) => u.text.split(" ").length), [18, 2]);
  assert.deepEqual(groupUnits([]), []);
});

test("parseLang defaults to source and rejects others", () => {
  assert.equal(parseLang(undefined), "source");
  assert.equal(parseLang(""), "source");
  assert.equal(parseLang("arabizi"), "arabizi");
  assert.throws(() => parseLang("darija"), /unknown lang "darija" \(expected source, arabizi, fr, en\)/);
});

test("batches cuts consecutive slices", () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(batches(Array.from({ length: 41 }, (_, i) => i)).length, 3);
});

test("parseReply validates ids, text and script", () => {
  assert.deepEqual([...parseReply('```json\n{"units":[{"id":2,"text":" b  x "},{"id":"1","text":"a"}]}\n```', [1, 2])], [[2, "b x"], [1, "a"]]);
  assert.throws(() => parseReply("nope", [1]), /not valid JSON/);
  assert.throws(() => parseReply('{"lines":[]}', [1]), /no units array/);
  assert.throws(() => parseReply('{"units":[{"id":3,"text":"a"}]}', [1]), /unexpected unit id/);
  assert.throws(() => parseReply('{"units":[{"id":1,"text":"a"},{"id":1,"text":"b"}]}', [1]), /twice/);
  assert.throws(() => parseReply('{"units":[{"id":1,"text":" "}]}', [1]), /empty text/);
  assert.throws(() => parseReply('{"units":[{"id":1,"text":"salam دابا"}]}', [1]), /Arabic script/);
  assert.throws(() => parseReply('{"units":[{"id":1,"text":"a"}]}', [1, 2]), /missing 1/);
});

test("buildMessages has a lang-specific system prompt and the units as JSON", () => {
  const m = buildMessages("arabizi", [{ id: 1, text: "دابا" }]);
  assert.match(m[0]?.content as string, /Arabizi/);
  assert.match(m[0]?.content as string, /do NOT translate/);
  assert.match(m[0]?.content as string, /Modern Standard Arabic/);
  assert.deepEqual(JSON.parse(m[1]?.content as string), { units: [{ id: 1, text: "دابا" }] });
  assert.match(buildMessages("fr", [])[0]?.content as string, /French/);
  assert.match(buildMessages("en", [])[0]?.content as string, /English/);
});

test("arabicScriptPct counts tokens with Arabic letters", () => {
  assert.equal(arabicScriptPct(["salam دابا", "ok"]), 33.3);
  assert.equal(arabicScriptPct([]), 0);
});

test("lang=source: units from the cut transcript, no LLM, metrics", async () => {
  await seed([W("دابا", 0, 0.4), W("غادي", 0.5, 0.9), W("cut", 3, 3.5), W("نشرح", 5.1, 5.5)], [{ start: 0, end: 1 }, { start: 5, end: 6 }]);
  fakeLlm(() => "{}");
  const r = await run([]);
  assert.equal(r.status, "pass", JSON.stringify(r));
  assert.deepEqual(r.metrics, { unitCount: 2, fallbackUnits: 0, arabicScriptPct: 0, lang: "source" });
  assert.equal(bodies.length, 0);
  const j = await units();
  assert.equal(j.lang, "source");
  assert.equal(j.provider, undefined);
  assert.deepEqual(j.units, [
    { id: 1, start: 0, end: 0.9, text: "دابا غادي", src: "دابا غادي" },
    { id: 2, start: 1.1, end: 1.5, text: "نشرح", src: "نشرح" },
  ]);
});

test("lang=arabizi: batches of 20, bad reply rotates, provider recorded", async () => {
  const words = Array.from({ length: 45 }, (_, i) => W(`كلمة${i}`, i * 2, i * 2 + 0.5)); // gaps > 0.6 s: one unit per word
  await seed(words, [{ start: 0, end: 100 }]);
  fakeLlm((host, us) =>
    host === "bad" ? JSON.stringify({ units: us.map((u) => ({ id: u.id, text: u.text })) }) : JSON.stringify({ units: us.map((u) => ({ id: u.id, text: `kelma ${u.id}` })) }),
  );
  const r = await run(["bad", "good"], { lang: "arabizi", prefer: "bad" });
  assert.equal(r.status, "pass", JSON.stringify(r));
  assert.equal(r.metrics.unitCount, 45);
  assert.equal(r.metrics.arabicScriptPct, 0);
  assert.equal(r.metrics.fallbackUnits, 0);
  assert.deepEqual(r.provider, { id: "good", model: "good-model" });
  assert.deepEqual(bodies.map((b) => b.host), ["bad", "good", "bad", "good", "bad", "good"]);
  assert.deepEqual(bodies.map((b) => JSON.parse(b.body.messages[1]?.content ?? "").units.length), [20, 20, 20, 20, 5, 5]);
  assert.equal(picks[0]?.private, true);
  assert.equal(picks[0]?.prefer, "bad");
  const j = await units();
  assert.equal(j.lang, "arabizi");
  assert.deepEqual(j.provider, { id: "good", model: "good-model" });
  assert.equal(j.units[0].text, "kelma 1");
  assert.equal(j.units[0].src, "كلمة0");
  assert.equal(j.units[44].text, "kelma 45");
});

test("no provider succeeds: source text kept, fallbackUnits and arabicScriptPct warn", async () => {
  await seed([W("دابا", 0, 0.4), W("غادي", 0.5, 0.9)], [{ start: 0, end: 1 }]);
  fakeLlm(() => "not json");
  sleeps.length = 0;
  const r = await run(["a"], { lang: "fr" });
  assert.equal(r.status, "warn", JSON.stringify(r));
  assert.equal(r.metrics.fallbackUnits, 1);
  assert.deepEqual(sleeps, [8000], "one retry after a pause before keeping source");
  assert.equal(r.metrics.arabicScriptPct, 100);
  const j = await units();
  assert.equal(j.units[0].text, "دابا غادي");
  assert.equal(j.provider, undefined);
});

test("a failing batch is split in halves; only the units that still fail keep source text", async () => {
  const words = Array.from({ length: 12 }, (_, i) => W(`كلمة${i}`, i * 2, i * 2 + 0.5));
  await seed(words, [{ start: 0, end: 100 }]);
  // the model chokes on any request with more than 6 units, and always on unit 12
  fakeLlm((_host, us) => (us.length > 6 || us.some((u) => u.id === 12) ? "not json" : JSON.stringify({ units: us.map((u) => ({ id: u.id, text: `kelma ${u.id}` })) })));
  sleeps.length = 0;
  const r = await run(["a"], { lang: "arabizi" });
  // 12 → 6 ok + 6 fail → 3 ok + 3 fail (≤ 5: retried once) → 3 kept in source
  assert.equal(r.metrics.fallbackUnits, 3, JSON.stringify(r));
  assert.deepEqual(sleeps, [8000]);
  const j = await units();
  assert.equal(j.units[5].text, "kelma 6");
  assert.equal(j.units[8].text, "kelma 9");
  assert.equal(j.units[9].text, "كلمة9");
});

test("unknown lang fails the step", async () => {
  await seed([W("a", 0, 0.4)], [{ start: 0, end: 1 }]);
  const r = await run([], { lang: "es" });
  assert.equal(r.status, "fail");
  assert.match(r.error ?? "", /unknown lang "es"/);
});

test("isOverloaded: 429/503/auth status, timeouts and aborts; not bad replies", async () => {
  const { isOverloaded } = await import("../src/localize.ts");
  assert.equal(isOverloaded(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(isOverloaded(new Error("gemini HTTP 429: slow down")), true);
  assert.equal(isOverloaded(new Error("The operation was aborted due to timeout")), true);
  assert.equal(isOverloaded(new Error("model reply is not valid JSON")), false);
  assert.equal(isOverloaded(Object.assign(new Error("x"), { status: 400 })), false);
});

test("an overloaded provider is skipped for later batches", async () => {
  const words = Array.from({ length: 25 }, (_, i) => W(`كلمة${i}`, i * 2, i * 2 + 0.5));
  await seed(words, [{ start: 0, end: 100 }]);
  bodies = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const host = new URL(url).host.split(".")[0] as string;
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push({ host, body });
    if (host === "busy") return new Response("high demand", { status: 503 });
    const us = JSON.parse(body.messages[1]?.content ?? "{}").units as { id: number }[];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ units: us.map((u) => ({ id: u.id, text: `k${u.id}` })) }) } }] }), { status: 200 });
  }) as typeof fetch;
  const r = await run(["busy", "ok"], { lang: "en", prefer: "busy" });
  assert.equal(r.metrics.fallbackUnits, 0, JSON.stringify(r));
  assert.deepEqual(bodies.map((b) => b.host), ["busy", "ok", "ok"]);
});

test("fr/en lines carry a character budget from their duration; arabizi does not", async () => {
  const { charBudget } = await import("../src/prompt.ts");
  assert.equal(charBudget(0, 2), 30);
  assert.equal(charBudget(0, 0.3), 12, "short units still get a usable line");
  const u = [{ id: 1, text: "دابا", start: 1, end: 3 }];
  const fr = buildMessages("fr", u);
  assert.deepEqual(JSON.parse(fr[1]?.content as string).units, [{ id: 1, text: "دابا", max: 30 }]);
  assert.match(fr[0]?.content as string, /"max"/);
  const az = buildMessages("arabizi", u);
  assert.deepEqual(JSON.parse(az[1]?.content as string).units, [{ id: 1, text: "دابا" }]);
});

test("no LLM provider left at all: no splitting, no waiting, source kept", async () => {
  const words = Array.from({ length: 25 }, (_, i) => W(`كلمة${i}`, i * 2, i * 2 + 0.5));
  await seed(words, [{ start: 0, end: 100 }]);
  sleeps.length = 0;
  const r = await run([], { lang: "fr" });
  assert.equal(r.metrics.fallbackUnits, 25, JSON.stringify(r));
  assert.deepEqual(sleeps, []);
});
