import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const stepsDir = join(root, "steps");
const coreIndex = join(root, "core", "src", "index.ts");

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

function importSpecifiers(source: string): string[] {
  const re = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
  return [...source.matchAll(re)].map((m) => m[1] as string);
}

/** Returns "<file>: <specifier>" for each import that crosses a boundary illegally. */
export function findViolations(): string[] {
  const violations: string[] = [];
  for (const file of tsFiles(stepsDir)) {
    const own = relative(stepsDir, file).split(sep)[0];
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      const rel = relative(root, target);
      const label = `${relative(root, file)}: ${spec}`;
      if (rel === "core" || rel.startsWith(`core${sep}`)) {
        if (target !== coreIndex) violations.push(label);
      } else if (rel.startsWith(`steps${sep}`)) {
        if (relative(stepsDir, target).split(sep)[0] !== own) violations.push(label);
      }
    }
  }
  return violations;
}

test("steps import core only through core/src/index.ts", () => {
  assert.deepEqual(findViolations(), []);
});
