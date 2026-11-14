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

  return {
    title: "Something went wrong",
    advice: "Open the details below and share them if you ask for help.",
    details: message,
  };
}
