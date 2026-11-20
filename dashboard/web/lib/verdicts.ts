import type { StepView } from "../../src/types.ts";

type Verdict = StepView["verdicts"][number];

export type GateNote = { level: "warn" | "fail"; text: string };

function num(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

/** The gate target in words, e.g. "≥ 0.7", "between -15 and -13". */
function target(t: Verdict["threshold"]): string {
  if (t.op === "between" && Array.isArray(t.value)) return `between ${num(t.value[0])} and ${num(t.value[1])}`;
  const op = { "<": "<", "<=": "≤", ">": ">", ">=": "≥", "==": "=" }[t.op as string] ?? t.op;
  return `${op} ${num(t.value)}`;
}

/** Plain sentences for the gates we know, keyed by "step.metric" (or just "metric" for any step). */
const SENTENCES: Record<string, (actual: string, aim: string) => string> = {
  "transcribe.meanConfidence": (a, t) => `Transcription confidence ${a} (aim ${t}): check the captions closely.`,
  "transcribe.pctTimestamped": (a, t) => `Only ${a}% of the words got a time (needs ${t}).`,
  "transcribe.wordCount": () => "No words were heard in the audio.",
  "cut.midWordCuts": (a) => `${a} cut(s) land in the middle of a word.`,
  "cut.droppedWords": (a) => `${a} spoken word(s) were cut out.`,
  "cut.removedPct": (a, t) => `${a}% of the video was cut (aim ${t}%): watch it to check nothing important went.`,
  "cut.longestRetakeSec": (a, t) => `A removed retake lasts ${a}s (aim ${t}s): check the right take was kept.`,
  arabicScriptPct: (a) => `${a}% of the words are still in Arabic letters.`,
  "localize.fallbackUnits": (a) => `${a} subtitle line(s) couldn't be translated (no AI provider answered), so they stay as spoken.`,
  "captions.maxReadingSpeed": (a, t) => `Some captions go by fast (${a} characters a second, aim ${t}): they may be hard to read.`,
  "captions.maxCharsPerLine": (a, t) => `A caption line has ${a} characters (aim ${t}).`,
  "captions.cueCount": () => "No captions were made.",
  "chapters.chapterCount": (a) => `Only ${a} chapter(s): YouTube shows chapters from 3.`,
  "chapters.fallback": () => "No AI provider answered, so chapters were placed at pauses with simple titles.",
  "chapters.minChapterSec": (a, t) => `Two chapters are ${a}s apart (needs ${t}s).`,
  "chapters.firstAtZero": () => "The first chapter doesn't start at 0:00.",
  integratedLufs: (a, t) => `Loudness ${a} LUFS (aim ${t}).`,
  "mix.truePeakDb": (a, t) => `Sound peaks at ${a} dB (aim ${t}): it may clip.`,
  "mix.driftSec": (a, t) => `Sound drifts ${a}s from the picture (aim ${t}s).`,
  "assemble.avOffsetMs": (a, t) => `Sound and picture are ${a} ms apart (aim ${t} ms).`,
  "assemble.durationDeltaSec": (a, t) => `The video's length is off by ${a}s (aim ${t}s).`,
  "assemble.endDriftMs": (a, t) => `Sound drifts ${a} ms by the end (aim ${t} ms).`,
  "assemble.socialDurationOk": () => "The video is longer than this platform allows.",
  hasAudio: () => "The video has no sound.",
  "qa.blackStartSec": (a, t) => `The video starts with ${a}s of black (aim ${t}s).`,
  "qa.silentStartSec": (a, t) => `The video starts with ${a}s of silence (aim ${t}s).`,
};

/** One plain sentence for a gate verdict; unknown metrics read "metric actual vs target …". */
export function explainVerdict(step: string, v: Verdict): string {
  const actual = v.actual === undefined ? "missing" : num(v.actual);
  const aim = target(v.threshold);
  const say = SENTENCES[`${step}.${v.metric}`] ?? SENTENCES[v.metric];
  return say ? say(actual, aim) : `${v.metric} ${actual} vs target ${aim}`;
}

/** What a creator can do about a missed check, keyed like SENTENCES. Checks without one get no hint. */
const HINTS: Record<string, string> = {
  "mix.driftSec": "A few hundredths of a second is hard to notice. Play the video and check the lips match the voice.",
  integratedLufs: "Listen to the Sound preview: if the voice is clear and not too loud, it's fine.",
  "mix.truePeakDb": "Listen to the loud parts for crackling. If you hear none, it's fine.",
  "transcribe.meanConfidence": "Read the captions closely at the review and fix the words that are wrong.",
  "transcribe.pctTimestamped": "Some captions may come at the wrong moment: check them at the review.",
  "transcribe.wordCount": "Check the video has someone talking and its sound isn't muted.",
  "cut.midWordCuts": "Watch around the cuts. If words sound clipped, set Pace to Natural and retry.",
  "cut.droppedWords": "Watch around the cuts. If words are missing, set Pace to Natural and retry.",
  "cut.removedPct": "Watch it to check nothing important went. Pace Natural cuts less.",
  "captions.maxReadingSpeed": "Fast captions still show. Read them in the preview: if you can follow them, it's fine.",
  "assemble.avOffsetMs": "Play the video and check the lips match the voice.",
  "assemble.endDriftMs": "Play the end of the video and check the lips still match the voice.",
  "assemble.durationDeltaSec": "Play the end of the video to check nothing is missing.",
  "qa.blackStartSec": "Play the start of the video. A short black start is often fine.",
  "qa.silentStartSec": "Play the start of the video. A quiet first moment is often fine.",
  hasAudio: "Check that the original video has sound.",
};

/**
 * A step that ran and made its result but missed a must-pass check (mirrors core isGateFailure):
 * the only kind of failure the user can accept. Crashes have no checks; validation errors no inputs.
 */
export function canAccept(result: StepView | undefined): boolean {
  return (
    result !== undefined &&
    result.status === "fail" &&
    result.inputsHash !== "" &&
    (result.verdicts ?? []).some((v) => !v.ok && v.threshold?.level !== "warn")
  );
}

/** The must-pass checks a result missed: a plain sentence with actual vs aim, and what to do when we know. */
export function missedChecks(result: StepView | undefined): { text: string; hint?: string }[] {
  return (result?.verdicts ?? [])
    .filter((v) => !v.ok && v.threshold?.level !== "warn")
    .map((v) => {
      const hint = HINTS[`${result!.step}.${v.metric}`] ?? HINTS[v.metric];
      return { text: explainVerdict(result!.step, v), ...(hint ? { hint } : {}) };
    });
}

/** Every check with its measured value, for the Details panel ("✗ driftSec = 0.03 (target ≤ 0.02)"). */
export function checkDetails(result: StepView | undefined): string[] {
  return (result?.verdicts ?? []).map(
    (v) => `${v.ok ? "✓" : "✗"} ${v.metric} = ${v.actual === undefined ? "missing" : num(v.actual)} (target ${target(v.threshold)})`
  );
}

/** The gates a step result did not meet, worst first, in plain words. */
export function gateNotes(result: StepView | undefined): GateNote[] {
  if (!result?.verdicts) return [];
  return result.verdicts
    .filter((v) => !v.ok)
    .map((v) => ({ level: v.threshold.level, text: explainVerdict(result.step, v) }))
    .sort((a, b) => (a.level === b.level ? 0 : a.level === "fail" ? -1 : 1));
}
