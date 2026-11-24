import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Word } from "../../../core/src/index.ts";
import { darijaPrompt } from "../src/darija.ts";
import { dropCollapsedRuns, dropPromptEcho, isPromptEcho } from "../src/echo.ts";
import type { Segment } from "../src/whisper-cpp.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const USER_PROMPT = "mostudio, moseo, soukpay, Claude Code, agents, projets, 2026, reconversion, intelligence artificielle";
const PROMPT = darijaPrompt(USER_PROMPT);

/** Raw Groq verbose_json -> the words/segments transcribe works on. */
function groq(name: string): { words: Word[]; segments: Segment[] } {
  const j = fixture(name);
  return {
    words: j.words.map((w: { word: string; start: number; end: number }) => ({ w: w.word.trim(), start: w.start, end: w.end })),
    segments: j.segments.map((s: Segment) => ({ start: s.start, end: s.end, text: s.text })),
  };
}
const text = (ws: Word[]) => ws.map((w) => w.w).join(" ");

test("dropCollapsedRuns: Groq's repeated sentence and French translations (<= 20 ms per word) are dropped", () => {
  const { words, segments } = groq("groq-darija-w0.json");
  const out = dropCollapsedRuns(words, segments);
  const t = text(out.words);
  // the first sentence appears once, the French translations are gone
  assert.equal(t.split("السلام").length - 1, 1, t);
  assert.doesNotMatch(t, /L'objectif|partager|Je connais|beaucoup|servissent/);
  // the speech itself (Darija with French code-switching) is kept
  assert.match(t, /^السلام أصدقاء، أخيراً درت الفيديو الأول، story الأولى\. الـ objective ديال هاد/);
  assert.match(t, /plus ou moins ما كيقدروش et mesurer la valeur ajoutée ديالهم par rapport à ce que donne l'AI\. وهاتش/);
  // 8 repeated + 14 + 23 translated words, counting the segment-final word that takes the leftover time
  assert.equal(out.dropped, 8 + 14 + 28);
  assert.equal(words.length - out.words.length, out.dropped);
  // segment text follows the kept words, so captions and the cut never see the dropped text
  assert.equal(out.segments.length, segments.length);
  assert.equal(out.segments[0]?.text, " السلام أصدقاء، أخيراً درت الفيديو الأول، story الأولى.");
  assert.doesNotMatch(out.segments.map((s) => s.text).join(" "), /L'objectif|Je connais/);
});

test("dropCollapsedRuns: words go to segments in transcript order, so a repeat timed past the next segment's start leaves its own segment", () => {
  // Groq timed segment 0's repeated tail at 5.60-5.72 s, after segment 1 starts (5.42 s)
  const { words, segments } = groq("groq-darija-w0-inverted.json");
  const out = dropCollapsedRuns(words, segments);
  assert.equal(out.segments[0]?.text, " سلام أصدقاء، أخيرا درت لفيديو الإول... sotarii l'èoulâ.");
  assert.doesNotMatch(out.segments.map((s) => s.text).join(" "), /قدرت|L'objectif de cette chaîne/);
  assert.match(out.segments[1]?.text ?? "", /^ الواجيكتيف ديال هاد/);
});

test("dropCollapsedRuns keeps short real words and runs of fewer than 3 collapsed words", () => {
  const words: Word[] = [
    { w: "a", start: 0, end: 0.02 },
    { w: "b", start: 0.02, end: 0.04 },
    { w: "c", start: 0.1, end: 0.4 },
    { w: "d", start: 0.4, end: 0.45 },
  ];
  const segments: Segment[] = [{ start: 0, end: 0.45, text: " a b c d" }];
  assert.deepEqual(dropCollapsedRuns(words, segments), { words, segments, dropped: 0 });
});

test("dropCollapsedRuns removes a segment left without words", () => {
  const words: Word[] = [
    { w: "real", start: 0, end: 0.5 },
    { w: "x", start: 1, end: 1.02 },
    { w: "y", start: 1.02, end: 1.04 },
    { w: "z", start: 1.04, end: 1.06 },
  ];
  const segments: Segment[] = [
    { start: 0, end: 0.5, text: " real" },
    { start: 1, end: 1.06, text: " x y z" },
  ];
  const out = dropCollapsedRuns(words, segments);
  assert.deepEqual(out.words.map((w) => w.w), ["real"]);
  assert.deepEqual(out.segments, [segments[0]]);
  assert.equal(out.dropped, 3);
});

test("isPromptEcho: a segment copied from the prompt, not speech that shares a few prompt words", () => {
  // Groq on the 5 s tail window (near silence) returned the tail of the built-in prompt
  const echo = groq("groq-darija-w2-echo.json").segments[0] as Segment;
  assert.equal(isPromptEcho(echo.text, PROMPT), true);
  // real speech sharing the 3-word run "بزاف ديال الناس" with the prompt
  assert.equal(isPromptEcho(" كنعرف بزاف ديال الناس اللي كيخدموا الـ AI و اللي plus ou moins ما كيقدروش", PROMPT), false);
  // the user's names list read back
  assert.equal(isPromptEcho(" mostudio, moseo, soukpay, Claude Code", PROMPT), true);
  // a short real reply that happens to be in the prompt is kept (under 4 words)
  assert.equal(isPromptEcho(" ماشي مشكل", PROMPT), false);
  assert.equal(isPromptEcho(" anything", undefined), false);
});

test("dropPromptEcho drops the echoed segment of pass A and its words, nothing else", () => {
  const a = fixture("darija-intro-pass-a.json");
  const out = dropPromptEcho(a.words, a.segments, PROMPT);
  assert.equal(out.segments.length, a.segments.length - 1);
  assert.ok(out.segments.every((s: Segment) => s.start < 62), JSON.stringify(out.segments.at(-1)));
  assert.equal(out.dropped, 17);
  assert.ok(out.words.every((w: Word) => w.start < 62));
  assert.equal(out.words.length, a.words.length - 17);
  assert.deepEqual(dropPromptEcho(a.words, a.segments, undefined), { words: a.words, segments: a.segments, dropped: 0 });
});
