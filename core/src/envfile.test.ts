import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadEnvFile } from "./config.ts";
import { formatEnvValue, maskSecret, updateEnvFile } from "./envfile.ts";

let tmp: string;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mostudio-envfile-"));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("updateEnvFile replaces in place and keeps every other line byte-for-byte", async () => {
  const f = join(tmp, "replace.env");
  const initial =
    `# Section 1: config\nAPP_NAME="My App" # default\nPORT=3000\n\n# Section 2: Secrets\nexport API_KEY=old-key # inline note\nDEBUG=true\n`;
  await writeFile(f, initial);

  await updateEnvFile(f, { API_KEY: "new-key-123" });

  const result = await readFile(f, "utf8");
  const expected =
    `# Section 1: config\nAPP_NAME="My App" # default\nPORT=3000\n\n# Section 2: Secrets\nAPI_KEY=new-key-123\nDEBUG=true\n`;
  assert.equal(result, expected);

  // Subsequent duplicates are removed, first owning line rewritten in place
  const fDup = join(tmp, "duplicates.env");
  await writeFile(fDup, "FOO=first\nBAR=keep\nFOO=second # dup\nBAZ=keep2\nFOO=third\n");
  await updateEnvFile(fDup, { FOO: "updated" });
  const resultDup = await readFile(fDup, "utf8");
  assert.equal(resultDup, "FOO=updated\nBAR=keep\nBAZ=keep2\n");
});

test("appends new keys at the end with one trailing newline", async () => {
  const f = join(tmp, "append.env");
  await writeFile(f, "EXISTING=1\n");

  await updateEnvFile(f, { KEY_B: "val-b", KEY_A: "val-a" });

  const result = await readFile(f, "utf8");
  assert.equal(result, "EXISTING=1\nKEY_B=val-b\nKEY_A=val-a\n");
  assert.ok(result.endsWith("\n") && !result.endsWith("\n\n"));

  // Appending when original file had no trailing newline
  const fNoNewline = join(tmp, "no-newline.env");
  await writeFile(fNoNewline, "NO_NL=yes");
  await updateEnvFile(fNoNewline, { APPENDED: "here" });
  const resultNoNewline = await readFile(fNoNewline, "utf8");
  assert.equal(resultNoNewline, "NO_NL=yes\nAPPENDED=here\n");
});

test("null and empty string remove the key line", async () => {
  const f = join(tmp, "remove.env");
  await writeFile(
    f,
    "# header\nKEEP_A=1\nREMOVE_NULL=2\nKEEP_B=3\nREMOVE_EMPTY=4\nDUP_REMOVE=5\nDUP_REMOVE=6\n",
  );

  await updateEnvFile(f, {
    REMOVE_NULL: null,
    REMOVE_EMPTY: "",
    DUP_REMOVE: null,
    NON_EXISTENT: null,
  });

  const result = await readFile(f, "utf8");
  assert.equal(result, "# header\nKEEP_A=1\nKEEP_B=3\n");

  // Removing all keys leaves empty file without trailing newline
  const fAll = join(tmp, "remove-all.env");
  await writeFile(fAll, "ONLY=1\n");
  await updateEnvFile(fAll, { ONLY: null });
  const resultAll = await readFile(fAll, "utf8");
  assert.equal(resultAll, "");
});

test("values with spaces, # or quotes round-trip through loadEnvFile", async () => {
  const f = join(tmp, "roundtrip.env");
  const values: Record<string, string> = {
    SPACES: "hello world with spaces",
    HASH: "token#with#hashes",
    HASH_SPACE: "value # with hash comment syntax",
    SINGLE_QUOTE: "user's key",
    DOUBLE_QUOTE: 'quoted "string" value',
    SPECIAL_CHARS: "https://example.com/api:8080/v1/@scope+tag,name-1",
  };

  await updateEnvFile(f, values);
  assert.deepEqual(loadEnvFile(f), values);

  // Update in place to other values with quotes and spaces
  await updateEnvFile(f, {
    SINGLE_QUOTE: "updated without quote",
    DOUBLE_QUOTE: "it's now with single quote # and hash",
  });
  assert.equal(loadEnvFile(f).SINGLE_QUOTE, "updated without quote");
  assert.equal(loadEnvFile(f).DOUBLE_QUOTE, "it's now with single quote # and hash");
});

test("creates a missing file with mode 0600", async () => {
  const f = join(tmp, "new-file.env");
  await updateEnvFile(f, { SECRET_KEY: "secret123" });

  const result = await readFile(f, "utf8");
  assert.equal(result, "SECRET_KEY=secret123\n");

  const st = await stat(f);
  assert.equal(st.mode & 0o777, 0o600);
});

test("rejects invalid key names and newlines in values", async () => {
  const f = join(tmp, "invalid.env");
  await writeFile(f, "INITIAL=1\n");

  // Invalid key names
  await assert.rejects(updateEnvFile(f, { "": "val" }), /invalid env name: /);
  await assert.rejects(updateEnvFile(f, { "1INVALID": "val" }), /invalid env name: 1INVALID/);
  await assert.rejects(updateEnvFile(f, { "BAD-KEY": "val" }), /invalid env name: BAD-KEY/);
  await assert.rejects(updateEnvFile(f, { "BAD KEY": "val" }), /invalid env name: BAD KEY/);
  await assert.rejects(updateEnvFile(f, { "BAD.KEY": "val" }), /invalid env name: BAD\.KEY/);

  // Newlines in values
  await assert.rejects(updateEnvFile(f, { FOO: "line1\nline2" }), /newline in value of FOO/);
  await assert.rejects(updateEnvFile(f, { BAR: "line1\rline2" }), /newline in value of BAR/);
  await assert.rejects(updateEnvFile(f, { BAZ: "line1\r\nline2" }), /newline in value of BAZ/);

  // formatEnvValue checks
  assert.throws(() => formatEnvValue("single' and double\""), /cannot store value with both quote kinds/);
  assert.throws(() => formatEnvValue("newline\nval"), /newline in value/);
  assert.throws(() => formatEnvValue("cr\rval"), /newline in value/);
});

test("maskSecret tests: empty string returns empty; <= 8 chars returns '••••'; > 8 chars returns first 3 + '…' + last 4", () => {
  // Empty string
  assert.equal(maskSecret(""), "");

  // <= 8 chars
  assert.equal(maskSecret("a"), "••••");
  assert.equal(maskSecret("1234"), "••••");
  assert.equal(maskSecret("12345678"), "••••");

  // > 8 chars: first 3 + "…" + last 4
  assert.equal(maskSecret("123456789"), "123…6789");
  assert.equal(maskSecret("abcdefghij"), "abc…ghij");
  assert.equal(maskSecret("sk-proj-1234567890abcdef"), "sk-…cdef");
  assert.equal(maskSecret("gsk_yolo_secret_api_key_4242"), "gsk…4242");
});
