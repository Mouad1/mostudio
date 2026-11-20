export type Explained = {
  title: string;
  advice: string;
  action?: { label: string; href: string };
  details: string;
};

type Rule = {
  pattern: RegExp;
  title: string;
  advice: string | ((message: string) => string);
  action?: { label: string; href: string };
};

const RULES: Rule[] = [
  {
    // The dashboard API's own refusal when the tab has no session cookie (not a provider's 401).
    pattern: /^unauthorized$/,
    title: "This tab isn't connected to mostudio",
    advice: "Open the link printed in your terminal.",
  },
  {
    pattern: /can't use this file type/,
    title: "This file type can't be used",
    advice: (msg) => msg,
  },
  {
    // The upload route's refusal, and ffprobe's own words for a damaged file imported before that check existed.
    pattern: /can't read this file|moov atom not found|Invalid data found when processing input/,
    title: "This file can't be read",
    advice:
      "mostudio can't read this file (it may be damaged or not a real video/audio file). Try exporting it again.",
  },
  {
    pattern: /No provider available for "stt"/,
    title: "No transcription service available",
    advice: "Add a free Groq key so mostudio can turn speech into text.",
    action: { label: "Open settings", href: "#settings" },
  },
  {
    pattern: /No provider available for "llm"/,
    title: "No AI service available",
    advice: "Add a free Groq or Gemini key.",
    action: { label: "Open settings", href: "#settings" },
  },
  {
    pattern: /cancelled by user/,
    title: "Stopped",
    advice: "You stopped this run. Start again when you're ready.",
  },
  {
    pattern: /not found; install it or set/,
    title: "A video tool is missing",
    advice:
      "Reinstall mostudio: download the latest zip and replace the folder.",
  },
  {
    pattern: /needs libass/,
    title: "Captions can't be burned with this video engine",
    advice: "Turn on animated captions in Settings, or reinstall mostudio.",
    action: { label: "Open settings", href: "#settings" },
  },
  {
    pattern: /captions\.ass is .* but output is/,
    title: "Captions were made for another video size",
    advice: "Re-run the captions step, then continue.",
  },
  {
    pattern: /no words in transcript/,
    title: "No speech found",
    advice:
      "This clip seems silent or music-only. Try a clip where someone talks.",
  },
  {
    pattern: /This project already made/,
    title: "This project already made another kind of video",
    advice: "Start a new project for a different kind of video.",
  },
  {
    pattern: /Not enough free disk space/,
    title: "Your disk is full",
    advice: (msg) => msg,
  },
  {
    pattern: /refused|\b401\b|\b403\b/,
    title: "A key was refused",
    advice: "Copy the key again and test it in Settings.",
    action: { label: "Open settings", href: "#settings" },
  },
  {
    pattern: /missing input: /,
    title: "An earlier step hasn't run yet",
    advice: "Run the steps before this one first.",
  },
];

/** Case, spacing and end punctuation don't count when comparing what is shown with the details. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.!…\s]+$/, "").trim();
}

/** False when the details say nothing the title or advice don't already show. */
export function detailsAddInfo(e: Explained): boolean {
  const details = normalize(e.details);
  if (!details) return false;
  return details !== normalize(e.advice) && details !== normalize(e.title);
}

export function explainError(message: string): Explained {
  for (const rule of RULES) {
    if (rule.pattern.test(message)) {
      const advice =
        typeof rule.advice === "function" ? rule.advice(message) : rule.advice;
      return {
        title: rule.title,
        advice,
        action: rule.action,
        details: message,
      };
    }
  }

  // Unmapped: the message's own first line is the best cause we have, so show it up front.
  // Stack traces and the rest stay behind Details.
  const firstLine = message.split("\n")[0]!.trim();
  const MAX = 240;
  const shown = firstLine.length > MAX ? `${firstLine.slice(0, MAX - 1)}…` : firstLine;
  return {
    title: "That didn't work",
    advice: shown
      ? shown.charAt(0).toUpperCase() + shown.slice(1)
      : "Open the details below and share them if you ask for help.",
    details: message,
  };
}
