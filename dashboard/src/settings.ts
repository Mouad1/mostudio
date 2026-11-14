import { join } from "node:path";
import {
  loadLayeredEnv,
  maskSecret,
  updateEnvFile,
  type ProviderEntry,
} from "../../core/src/index.ts";
import type { SettingField } from "./types.ts";

export type SchemaField = Omit<SettingField, "source" | "masked">;

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function fieldLabel(name: string, providerId?: string): string {
  if (name === "GROQ_API_KEY") return "Groq key";
  if (name === "GEMINI_API_KEY") return "Google Gemini key";
  if (name === "CLOUDFLARE_API_TOKEN") return "Cloudflare key";
  if (name === "CLOUDFLARE_ACCOUNT_ID") return "Cloudflare account ID";
  if (name === "OPENROUTER_API_KEY") return "Openrouter key";
  if (name === "MISTRAL_API_KEY") return "Mistral key";
  if (name === "WHISPER_MODELS_DIR") return "Whisper models directory";
  const base = providerId ?? name.replace(/_API_KEY$|_KEY$|_API_TOKEN$|_TOKEN$/, "").toLowerCase();
  return `${capitalize(base)} key`;
}

export function settingsSchema(entries: ProviderEntry[]): SchemaField[] {
  const filtered = entries.filter((e) =>
    e.capabilities.some((c) => c === "stt" || c === "llm"),
  );

  type FieldAcc = {
    name: string;
    kind: "secret" | "text" | "path";
    providers: Set<string>;
    label: string;
    help: string;
    getKeyUrl?: string;
    recommended?: boolean;
  };

  const fieldsMap = new Map<string, FieldAcc>();

  for (const entry of filtered) {
    if (entry.keyEnv) {
      let acc = fieldsMap.get(entry.keyEnv);
      if (!acc) {
        acc = {
          name: entry.keyEnv,
          kind: "secret",
          providers: new Set<string>(),
          label: fieldLabel(entry.keyEnv, entry.id),
          help: "Optional backup provider.",
        };
        fieldsMap.set(entry.keyEnv, acc);
      }
      acc.providers.add(entry.id);
    }

    if (entry.env) {
      for (const envVal of Object.values(entry.env)) {
        let acc = fieldsMap.get(envVal);
        if (!acc) {
          acc = {
            name: envVal,
            kind: "text",
            providers: new Set<string>(),
            label: fieldLabel(envVal, entry.id),
            help: "",
          };
          fieldsMap.set(envVal, acc);
        }
        acc.providers.add(entry.id);
      }
    }

    if (entry.id === "whisper-cpp") {
      let acc = fieldsMap.get("WHISPER_MODELS_DIR");
      if (!acc) {
        acc = {
          name: "WHISPER_MODELS_DIR",
          kind: "path",
          providers: new Set<string>(),
          label: "Whisper models directory",
          help: "Directory containing ggml-*.bin models for local Whisper.",
        };
        fieldsMap.set("WHISPER_MODELS_DIR", acc);
      }
      acc.providers.add(entry.id);
    }
  }

  // Customize specific known fields
  const groq = fieldsMap.get("GROQ_API_KEY");
  if (groq) {
    groq.label = "Groq key";
    groq.getKeyUrl = "https://console.groq.com/keys";
    groq.recommended = true;
    groq.help = "Free. Used for transcription and AI steps.";
  }

  const gemini = fieldsMap.get("GEMINI_API_KEY");
  if (gemini) {
    gemini.label = "Google Gemini key";
    gemini.getKeyUrl = "https://aistudio.google.com/apikey";
    gemini.recommended = true;
    gemini.help = "Free. Used for AI steps.";
  }

  const cfToken = fieldsMap.get("CLOUDFLARE_API_TOKEN");
  if (cfToken) {
    cfToken.label = "Cloudflare key";
    cfToken.help = "Optional backup provider.";
  }

  const cfAccount = fieldsMap.get("CLOUDFLARE_ACCOUNT_ID");
  if (cfAccount) {
    cfAccount.kind = "text";
    cfAccount.label = "Cloudflare account ID";
    cfAccount.help = "Required for Cloudflare AI.";
  }

  const openrouter = fieldsMap.get("OPENROUTER_API_KEY");
  if (openrouter) {
    openrouter.label = "Openrouter key";
    openrouter.help = "Optional backup provider.";
  }

  const mistral = fieldsMap.get("MISTRAL_API_KEY");
  if (mistral) {
    mistral.label = "Mistral key";
    mistral.help = "Optional backup provider.";
  }

  const whisper = fieldsMap.get("WHISPER_MODELS_DIR");
  if (whisper) {
    whisper.kind = "path";
    whisper.label = "Whisper models directory";
    whisper.help = "Directory containing ggml-*.bin models for local Whisper.";
  }

  const result: SchemaField[] = [];
  for (const acc of fieldsMap.values()) {
    const item: SchemaField = {
      name: acc.name,
      kind: acc.kind,
      providers: Array.from(acc.providers).sort(),
      label: acc.label,
      help: acc.help,
    };
    if (acc.getKeyUrl) item.getKeyUrl = acc.getKeyUrl;
    if (acc.recommended !== undefined) item.recommended = acc.recommended;
    result.push(item);
  }

  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

export function readSettings(o: {
  home: string;
  root?: string;
  processEnv: Record<string, string>;
  entries: ProviderEntry[];
}): SettingField[] {
  const { env, sources } = loadLayeredEnv({
    home: o.home,
    root: o.root,
    processEnv: o.processEnv,
  });

  const schema = settingsSchema(o.entries);

  return schema.map((field) => {
    const val = env[field.name];
    const source = (sources[field.name] ?? "unset") as
      | "app"
      | "workspace"
      | "process"
      | "unset";

    let masked = "";
    if (field.kind === "secret") {
      masked = val ? maskSecret(val) : "";
    } else {
      masked = val ?? "";
    }

    return {
      ...field,
      source,
      masked,
    };
  });
}

export async function writeSettings(
  home: string,
  values: Record<string, string>,
  entries: ProviderEntry[],
): Promise<void> {
  const schemaNames = new Set(settingsSchema(entries).map((f) => f.name));

  for (const key of Object.keys(values)) {
    if (!schemaNames.has(key)) {
      throw new Error(`unknown setting: ${key}`);
    }
  }

  await updateEnvFile(join(home, ".env"), values);
}
