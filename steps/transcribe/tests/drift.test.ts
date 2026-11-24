import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Word } from "../../../core/src/index.ts";
import { readsAsFrenchOnly, readsAsMsa } from "../src/darija.ts";
import { driftedSegments, replaceDrift } from "../src/drift.ts";
import { dropCollapsedRuns } from "../src/echo.ts";
import type { Segment } from "../src/whisper-cpp.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

/** Raw Groq verbose_json, after the collapsed-run filter, as transcribe sees it. */
function pass(name: string): { words: Word[]; segments: Segment[] } {
  const j = fixture(name);
  const words = j.words.map((w: { word: string; start: number; end: number }) => ({ w: w.word.trim(), start: w.start, end: w.end }));
  const out = dropCollapsedRuns(words, j.segments.map((s: Segment) => ({ start: s.start, end: s.end, text: s.text })));
  return { words: out.words, segments: out.segments };
}
const text = (ws: Word[]) => ws.map((w) => w.w).join(" ");

test("readsAsMsa flags the drift seen on the real clip, not the Darija around it", () => {
  // forced-ar pass without the Darija prompt (pass B of 2026-11-23): MSA from ~27 s
  const b = fixture("darija-intro-pass-b.json");
  const flagged = b.segments.filter((s: Segment) => readsAsMsa(s.text)).map((s: Segment) => s.text.trim());
  assert.ok(flagged.includes("وهذا ما سنشاركه معكم"), flagged.join(" | "));
  assert.ok(flagged.includes("في هذا الشأن"), flagged.join(" | "));
  assert.ok(b.segments.filter((s: Segment) => s.start < 27).every((s: Segment) => !readsAsMsa(s.text)));
  // Darija lines of pass A stay unflagged
  assert.equal(readsAsMsa("الـ objective ديال هاد la chain هو باش نبارتاجي معاكم les meilleures pratiques de l'AI."), false);
  assert.equal(readsAsMsa("وهاتش اللي غادي نحرر أن نبارتشي معاكم حدا من الحاجات اللي هادين"), false);
});

// Labels by Gemini 4 Neon (Darija review, 2026-11-24) on real Groq output of the intro clip, after the collapsed-run filter
const MSA_OR_GARBLED = [
  // run 6: a Darija first sentence hid a garbled second one with MSA datives
  "السلام يا اصدقاء، اخيراً درت الفيديو الأول، story الأولى. ال مهاجمة العيدة لنا هي اشتراك لكم في محاولات الهاتف العددي،",
  "السلام يا أصدقاء، آخيراً درت الفيديو الأول. story الأولى. الآية الأولى من هذا الشأن هو أن نشارك معكم التجربة الأفضل من الموارد الAI",
  // a retry once accepted for "w hadi we7da men l7ajat li": one Darija word (وغادي) outweighed the MSA
  "ومسورة قيمة الـ AI وغادي نشارك لكم بحاجاتنا",
  "الواجب لهذه الكبيرة لدينا هو لكي نبدأ بشارهم معكم لأفكاريها الأفكار الأساسية والعاحية",
  "يمزوروا برابتين الحقوط ديالهم أنهم تدروا في المريض",
];
const DARIJA = [
  "السلام أصدقاء، أخيراً درت الفيديو الأول، story الأولى.",
  "الـ objective ديال هاد la chain هو باش نبارتاجي معاكم les meilleures pratiques de l'AI.",
  "كنعرف بزاف ديال الناس اللي كيخدموا الـ AI و اللي بلزو ما ما كيقدروش يمزوروا لفالو غادي تديرهم برابر لشنو كي يتعيهم الـ AI",
  "وهاتش اللي غادي نحرر أن نبارتشي معاكم حدا من الحاجات اللي هادين",
  "نحاولو عنا ندسكتوها ولا نبارتاجوها فهاد لاشين. نحاولو نخدمو على دي ببروجي كونكري بلوس و نبارتاجي معاكم دي اوتي",
  "orientés à la productivité, etc. Donc voilà, à bientôt dans la première vidéo.",
  "سلام يا أصدقاء، أخيراً دارت الفيديو الأول، story الأولى، l'objectif ديال هاد la chaîne هو باش نبارتاجي معكم les meilleures pratiques de l'AI.",
  "كنعرف بزاف ديال الناس لكي ختموا l'AI ولي بلزوموا ما كيقدروش",
  "يمزروا la valeur ajoutée dieron par rapport لشنو كي يتاحهم l'AI",
  "غادي نحرر أن نبارتاجي معاكم حدا من الحاجات ليهادي.",
  // Darija words that look like MSA markers: حيث = because, ولدي = my son, إلى = if, يمكن = maybe
  "ما مشيتش حيث كانت الشتا",
  "ولدي كيقرا فالمدرسة",
  "إلى بغيتي نشرح ليك كلشي",
  "يمكن نديروها غدا",
];

test("readsAsMsa flags the MSA and garbled segments of the real runs and keeps the Darija ones", () => {
  for (const t of MSA_OR_GARBLED) assert.equal(readsAsMsa(t), true, t);
  for (const t of DARIJA) assert.equal(readsAsMsa(t), false, t);
});

test("readsAsMsa: 10+ Arabic words with no Darija word and no French word read as MSA", () => {
  assert.equal(readsAsMsa("الفكرة الرئيسية في العمل اليومي تعتمد على تنظيم الوقت بطريقة واضحة ومفيدة"), true);
  assert.equal(readsAsMsa("الفكرة الرئيسية في العمل اليومي تعتمد على تنظيم الوقت بطريقة واضحة ومفيدة ديالنا"), false);
});

test("readsAsFrenchOnly: a forced-Arabic segment translated whole into French, not code-switched Darija", () => {
  assert.equal(readsAsFrenchOnly(" L'objectif de la chaîne est de partager avec vous les meilleures pratiques de de l'AI."), true);
  assert.equal(readsAsFrenchOnly("الـ objective ديال هاد la chain هو باش نبارتاجي معاكم les meilleures pratiques de l'AI."), false);
  assert.equal(readsAsFrenchOnly("C'est bon, c'est bon."), false); // under 6 words: too short to call
});

test("driftedSegments: indexes of the segments that read as MSA", () => {
  const a = pass("groq-darija-w2-a.json");
  assert.deepEqual(driftedSegments(a.segments), [1]);
  assert.deepEqual(driftedSegments(pass("groq-darija-w0.json").segments), []);
});

test("replaceDrift: the MSA segment takes the auto pass's French words for its span, the Darija stays", () => {
  const a = pass("groq-darija-w2-a.json");
  const auto = pass("groq-darija-w2-auto.json");
  const out = replaceDrift(a, auto, driftedSegments(a.segments));
  assert.equal(out.replaced, 1);
  const t = text(out.words);
  // Darija pass A up to "des outils", then what was said in French; no MSA rendering of it
  assert.match(t, /^نحاولو عنا ندسكتوها ولا نبارتاجوها فهاد لاشين\. .* و نبارتاجي معاكم دي اوتي orientés à la productivité, etc\. Donc voilà, à bientôt dans la première vidéo\.$/);
  assert.doesNotMatch(t, /ذلك|وشكرا|oui|On va essayer/);
  // words keep the timings of the pass they come from, in order
  for (let i = 1; i < out.words.length; i++) assert.ok((out.words[i] as Word).start >= (out.words[i - 1] as Word).start);
  const orientes = out.words.find((w) => w.w === "orientés") as Word;
  assert.deepEqual(orientes, auto.words.find((w) => w.w === "orientés"));
  // the replaced segment is rebuilt from the auto words
  assert.equal(out.segments.length, 2);
  assert.equal(out.segments[1]?.text, " orientés à la productivité, etc. Donc voilà, à bientôt dans la première vidéo.");
  assert.equal(out.segments[1]?.start, orientes.start);
});

test("replaceDrift: a retry of pass A replaces the MSA segment of a drifted pass A when the retry reads as Darija", () => {
  const drifted = pass("groq-darija-w0-drift.json");
  assert.deepEqual(driftedSegments(drifted.segments), [0]);
  const out = replaceDrift(drifted, pass("groq-darija-w0.json"), [0]);
  assert.equal(out.replaced, 1);
  const t = text(out.words);
  assert.match(t, /^السلام أصدقاء، أخيراً درت الفيديو الأول، story الأولى\. الـ objective ديال هاد الـ chain هو باش نبارتجي معاكم .* AI\. كنعرف بزاف ديال الناس اللي كيخدموا الـ AI/);
  assert.doesNotMatch(t, /الآية|هذا الشأن|نشارك معكم/);
  assert.deepEqual(driftedSegments(out.segments), []);
});

test("replaceDrift: an MSA segment that ends what pass A kept takes the retry's words up to the end of the retry segment it overlaps", () => {
  // run 1 of the eval: pass A kept words only up to "معاكم" (29.92 s), its last segment drifted, and the retry's
  // "حدا من الحاجات اللي هادين" (w hadi we7da men l7ajat li ..., 29.9-31.2 s) was lost after the replacement
  const full = pass("groq-darija-w0-drift.json");
  const words = full.words.filter((w) => w.start < 29.9);
  const segments = [...full.segments.slice(0, 2), { start: 27.5, end: 29.92, text: " وهاتش اللي غادي نحرر أن نبارتشي معاكم" }];
  const out = replaceDrift({ words, segments }, pass("groq-darija-w0.json"), [2]);
  assert.equal(out.replaced, 1);
  assert.match(text(out.words), /وهاتش اللي غادي نحرر أن نبارتاجي معاكم، حدا من الحاجات اللي هادين$/);
});

test("replaceDrift does not pull in a separate segment after the span (the auto pass's \"oui\" over the silent tail)", () => {
  const a = pass("groq-darija-w2-a.json");
  const out = replaceDrift(a, pass("groq-darija-w2-auto.json"), [1]);
  assert.doesNotMatch(text(out.words), /oui/);
});

test("replaceDrift keeps a drifted segment when the replacement reads as MSA too", () => {
  const a = { words: [{ w: "هذا", start: 0, end: 0.5 }, { w: "ذلك", start: 0.5, end: 1 }], segments: [{ start: 0, end: 1, text: " هذا ذلك" }] };
  const b = { words: [{ w: "هذه", start: 0, end: 0.5 }, { w: "ذلك", start: 0.5, end: 1 }], segments: [{ start: 0, end: 1, text: " هذه ذلك" }] };
  assert.equal(replaceDrift(a, b, [0]).replaced, 0);
  assert.deepEqual(replaceDrift(a, b, [0]).words, a.words);
});

test("replaceDrift keeps a drifted segment when the auto pass has no words for its span", () => {
  const a = { words: [{ w: "هذا", start: 0, end: 0.5 }, { w: "ذلك", start: 0.5, end: 1 }], segments: [{ start: 0, end: 1, text: " هذا ذلك" }] };
  const out = replaceDrift(a, { words: [{ w: "later", start: 5, end: 6 }], segments: [{ start: 5, end: 6, text: " later" }] }, [0]);
  assert.equal(out.replaced, 0);
  assert.deepEqual(out.words, a.words);
  assert.deepEqual(out.segments, a.segments);
});
