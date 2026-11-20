#!/usr/bin/env node
import { main } from "../src/main.ts";

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    controller.abort();
  });
}

process.exitCode = await main(process.argv.slice(2), {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  signal: controller.signal,
});
