#!/usr/bin/env node
import { main } from "../src/main.ts";

process.exitCode = await main(process.argv.slice(2), {
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
});
