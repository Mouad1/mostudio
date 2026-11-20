import type { Knob } from "./types.ts";

export const KNOBS: Record<string, Record<string, Knob>> = {
  ingest: {
    source: {
      label: "Source",
      help: "Video or audio file",
      input: "file",
    },
  },
  transcribe: {
    language: {
      label: "Language",
      help: "Language code, e.g. en or fr. Leave empty to detect.",
      input: "text",
    },
    dialect: {
      label: "Dialect",
      help: "Better results for Darija mixed with French/English (don't set a language with it)",
      choices: [{ value: "darija", label: "Moroccan Darija" }],
    },
    prompt: {
      label: "Prompt",
      help: "Names and words to spell right",
      input: "textarea",
    },
    prefer: {
      label: "Preferred provider",
      help: "Preferred provider",
      input: "provider",
      advanced: true,
    },
  },
  cut: {
    pace: {
      label: "Pace",
      help: "Cut pacing",
      choices: [
        { value: "natural", label: "Natural" },
        { value: "tight", label: "Tight (fast-paced)" },
      ],
    },
    retakes: {
      label: "Retakes",
      help: "Remove earlier takes of a repeated sentence",
      input: "toggle",
    },
    maxGap: {
      label: "Max gap",
      help: "Max silence gap (s)",
      input: "number",
      advanced: true,
    },
    pre: {
      label: "Pre-speech padding",
      help: "Pre-speech padding (s)",
      input: "number",
      advanced: true,
    },
    post: {
      label: "Post-speech padding",
      help: "Post-speech padding (s)",
      input: "number",
      advanced: true,
    },
    minKeep: {
      label: "Min keep duration",
      help: "Min keep duration (s)",
      input: "number",
      advanced: true,
    },
    maxRetakeSec: {
      label: "Max retake window",
      help: "Max retake window (s)",
      input: "number",
      advanced: true,
    },
  },
  localize: {
    lang: {
      label: "Language",
      help: "Subtitle language",
      choices: [
        { value: "source", label: "As spoken" },
        { value: "arabizi", label: "Darija in Latin letters (Arabizi)" },
        { value: "fr", label: "French" },
        { value: "en", label: "English" },
      ],
    },
    prefer: {
      label: "Preferred provider",
      help: "Preferred provider",
      input: "provider",
      advanced: true,
    },
  },
  captions: {
    style: {
      label: "Style",
      help: "Caption style",
      choices: [
        { value: "long", label: "One line (long videos)" },
        { value: "short", label: "Big words (shorts)" },
      ],
    },
    font: {
      label: "Font",
      help: "Font family",
      input: "text",
      advanced: true,
    },
    width: {
      label: "Width",
      help: "Video width",
      input: "number",
      advanced: true,
    },
    height: {
      label: "Height",
      help: "Video height",
      input: "number",
      advanced: true,
    },
  },
  chapters: {
    language: {
      label: "Language",
      help: "Title language",
      input: "text",
    },
    prefer: {
      label: "Preferred provider",
      help: "Preferred provider",
      input: "provider",
      advanced: true,
    },
  },
  mix: {
    music: {
      label: "Music",
      help: "Background music (upload it into the project)",
      input: "file",
    },
    musicDb: {
      label: "Music volume",
      help: "Music volume (dB)",
      input: "number",
      advanced: true,
    },
    targetLufs: {
      label: "Target loudness",
      help: "Loudness target (LUFS)",
      input: "number",
      advanced: true,
    },
  },
  assemble: {
    preset: {
      label: "Preset",
      help: "Video preset",
      choices: [
        { value: "source", label: "Same as the video" },
        { value: "youtube", label: "YouTube 16:9" },
        { value: "shorts", label: "Vertical 9:16" },
        { value: "reels", label: "Vertical 9:16" },
        { value: "tiktok", label: "Vertical 9:16" },
      ],
    },
    burnCaptions: {
      label: "Burn captions",
      help: "Show captions on the video",
      input: "toggle",
    },
    captionsRenderer: {
      label: "Captions renderer",
      help: "Captions renderer",
      choices: [
        { value: "ass", label: "Simple captions" },
        { value: "hyperframes", label: "Animated captions (needs internet the first time)" },
      ],
    },
  },
  qa: {},
};
