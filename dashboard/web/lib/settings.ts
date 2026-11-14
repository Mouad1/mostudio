import type { SettingField } from "../../src/types.ts";

export type ProviderGroup = {
  id: string;
  title: string;
  recommended: boolean;
  fields: SettingField[];
};

const PROVIDER_TITLES: Record<string, string> = {
  gemini: "Google Gemini",
  groq: "Groq",
  cloudflare: "Cloudflare",
  openrouter: "Openrouter",
  mistral: "Mistral",
  "whisper-cpp": "Whisper.cpp",
};

function formatTitle(id: string): string {
  if (PROVIDER_TITLES[id]) {
    return PROVIDER_TITLES[id];
  }
  if (!id) return "";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function groupFields(fields: SettingField[]): {
  recommended: ProviderGroup[];
  more: ProviderGroup[];
  paths: SettingField[];
} {
  const groupMap = new Map<string, ProviderGroup>();
  const paths: SettingField[] = [];

  for (const f of fields) {
    if (f.kind === "path") {
      paths.push(f);
      continue;
    }

    const providers = f.providers && f.providers.length > 0 ? f.providers : [f.name.toLowerCase()];
    for (const pid of providers) {
      let group = groupMap.get(pid);
      if (!group) {
        group = {
          id: pid,
          title: formatTitle(pid),
          recommended: false,
          fields: [],
        };
        groupMap.set(pid, group);
      }
      group.fields.push(f);
      if (f.recommended) {
        group.recommended = true;
      }
    }
  }

  const recommended: ProviderGroup[] = [];
  const more: ProviderGroup[] = [];

  for (const group of groupMap.values()) {
    if (group.recommended) {
      recommended.push(group);
    } else {
      more.push(group);
    }
  }

  recommended.sort((a, b) => a.id.localeCompare(b.id));
  more.sort((a, b) => a.id.localeCompare(b.id));

  return { recommended, more, paths };
}

export function dirtyValues(
  original: SettingField[],
  edits: Record<string, string>
): Record<string, string> {
  const fieldMap = new Map(original.map((f) => [f.name, f]));
  const dirty: Record<string, string> = {};

  for (const [key, value] of Object.entries(edits)) {
    if (value === undefined || value === null) continue;
    const field = fieldMap.get(key);
    if (!field) {
      if (value !== "") {
        dirty[key] = value;
      }
      continue;
    }

    if (field.kind === "secret") {
      if (value !== "" && value !== field.masked) {
        dirty[key] = value;
      }
    } else {
      const current = field.masked ?? "";
      if (value !== current) {
        dirty[key] = value;
      }
    }
  }

  return dirty;
}

export function sourceText(f: SettingField): string {
  switch (f.source) {
    case "app":
      return "Saved in mostudio";
    case "workspace":
      return "Set in this workspace's .env.local (overrides mostudio)";
    case "process":
      return "Provided by your system (e.g. Bitwarden); can't be changed here";
    case "unset":
    default:
      return "Not set";
  }
}
