import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readJson } from "./fs/atomic.ts";

export type Config = {
  billing: "free-only" | "allow-paid";
  projectsRoot: string;
  home: string;
};

export type Secret = {
  readonly name: string;
  reveal(): string;
  toString(): string;
  toJSON(): string;
};

type RawConfig = { billing?: unknown; projectsRoot?: unknown };

export async function loadConfig(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Config> {
  const raw = (await readJson<RawConfig>(join(repoRoot, "mostudio.config.json"))) ?? {};
  const billing = raw.billing ?? "free-only";
  if (billing !== "free-only" && billing !== "allow-paid") {
    throw new Error(`mostudio.config.json: billing must be "free-only" or "allow-paid"`);
  }
  const projectsRoot = raw.projectsRoot ?? "projects";
  if (typeof projectsRoot !== "string") {
    throw new Error("mostudio.config.json: projectsRoot must be a string");
  }
  return {
    billing,
    projectsRoot: resolve(repoRoot, projectsRoot),
    home: env.MOSTUDIO_HOME ?? join(homedir(), ".mostudio"),
  };
}

/** Parse a dotenv-style file. KEY=value, quotes, # comments; no expansion. {} if missing. */
export function loadEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const rest = (m[2] as string).trim();
    const q = rest[0];
    let value: string;
    const close = q === '"' || q === "'" ? rest.indexOf(q, 1) : -1;
    if (close > 0 && /^(\s*|\s+#.*)$/.test(rest.slice(close + 1))) {
      value = rest.slice(1, close);
    } else {
      value = rest.replace(/\s+#.*$/, "");
    }
    out[key] = value;
  }
  return out;
}

class SecretValue implements Secret {
  readonly name: string;
  #value: string;
  constructor(name: string, value: string) {
    this.name = name;
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return `[secret:${this.name}]`;
  }
  toJSON(): string {
    return this.toString();
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

export function getSecret(name: string, env: Record<string, string | undefined>): Secret | undefined {
  const value = env[name];
  return value ? new SecretValue(name, value) : undefined;
}
