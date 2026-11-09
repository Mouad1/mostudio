const SECRET_NAME_RE = /KEY|TOKEN|SECRET|PASSWORD/i;
const MIN_SECRET_LEN = 6;

export type Redactor = {
  /** Replace every known secret value in `text` with `[redacted]`. */
  redact(text: string): string;
  /** Register another secret value (e.g. a key revealed by a provider pick). */
  add(value: string): void;
};

/** Secrets are values of env vars named like KEY/TOKEN/SECRET/PASSWORD, plus `extra`; values under 6 chars are ignored. */
export function createRedactor(
  envs: Array<Record<string, string | undefined> | undefined>,
  extra: Iterable<string> = [],
): Redactor {
  const secrets = new Set<string>();
  const add = (value: string): void => {
    if (value.length >= MIN_SECRET_LEN) secrets.add(value);
  };
  for (const env of envs) {
    for (const [name, value] of Object.entries(env ?? {})) {
      if (value && SECRET_NAME_RE.test(name)) add(value);
    }
  }
  for (const value of extra) add(value);
  return {
    add,
    redact(text) {
      let out = text;
      // Longest first so a secret containing another is masked whole.
      for (const value of [...secrets].sort((a, b) => b.length - a.length)) {
        out = out.split(value).join("[redacted]");
      }
      return out;
    },
  };
}
