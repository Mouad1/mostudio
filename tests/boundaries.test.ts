import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

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

/** Returns "<file>: <specifier>" (file relative to the repo root) for each illegal boundary-crossing import. */
export function findViolations(root: string): string[] {
  const stepsDir = join(root, "steps");
  const coreDir = join(root, "core");
  const coreIndex = join(coreDir, "src", "index.ts");
  const violations: string[] = [];
  for (const file of tsFiles(stepsDir)) {
    if (!relative(stepsDir, file).includes(sep)) continue; // steps/index.ts is the registry: it imports each step
    const own = relative(stepsDir, file).split(sep)[0];
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      const label = `${relative(root, file)}: ${spec}`;
      if (target === coreDir || target.startsWith(coreDir + sep)) {
        if (target !== coreIndex) violations.push(label);
      } else if (target.startsWith(stepsDir + sep)) {
        if (relative(stepsDir, target).split(sep)[0] !== own) violations.push(label);
      }
    }
  }
  return violations;
}

function fixture(files: Record<string, string>, check: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mostudio-boundaries-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("steps import core only through core/src/index.ts", () => {
  assert.deepEqual(findViolations(process.cwd()), []);
});

test("detects a deep import into core internals", () => {
  fixture(
    { "steps/a/src/i.ts": 'import "../../../core/src/foo.ts";\n', "core/src/index.ts": "export {};\n" },
    (root) => assert.deepEqual(findViolations(root), [`steps/a/src/i.ts: ../../../core/src/foo.ts`]),
  );
});

test("detects an import of another step", () => {
  fixture(
    { "steps/a/src/i.ts": 'import "../../other/src/x.ts";\n', "steps/other/src/x.ts": "export {};\n" },
    (root) => assert.deepEqual(findViolations(root), [`steps/a/src/i.ts: ../../other/src/x.ts`]),
  );
});

test("allows import of core/src/index.ts", () => {
  fixture(
    { "steps/a/src/i.ts": 'import { x } from "../../../core/src/index.ts";\n', "core/src/index.ts": "export const x = 1;\n" },
    (root) => assert.deepEqual(findViolations(root), []),
  );
});

test("allows import within the same step", () => {
  fixture(
    { "steps/a/src/i.ts": 'import "./j.ts";\nimport "../util/k.ts";\n', "steps/a/src/j.ts": "export {};\n", "steps/a/util/k.ts": "export {};\n" },
    (root) => assert.deepEqual(findViolations(root), []),
  );
});
