import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAppSettings, writeAppSettings } from "../../../core/src/index.ts";
import { startTestDashboard } from "../testkit.ts";
import type { SetupState } from "../types.ts";

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mostudio-setup-test-"));
}

test("fresh install needs setup and suggests ~/Movies/mostudio", async () => {
  const d = await startTestDashboard({ noWorkspace: true });
  try {
    const s = (await (await d.api("/api/setup")).json()) as SetupState;
    assert.equal(s.needsSetup, true);
    assert.equal(s.workspace, null);
    assert.match(s.suggestedWorkspace, /Movies\/mostudio$/);
    assert.ok(Array.isArray(s.checks));
    assert.equal(typeof s.hasAiKey, "boolean");
    assert.equal((await d.api("/api/projects")).status, 409);
  } finally {
    await d.close();
  }
});

test("choosing a folder scaffolds it, remembers it, unlocks the API", async () => {
  const d = await startTestDashboard({ noWorkspace: true });
  const targetDir = tmpDir();
  const target = join(targetDir, "Mes vidéos");
  try {
    const res = await d.api("/api/setup/workspace", post({ path: target }));
    assert.equal(res.status, 200);
    const r = (await res.json()) as { entries: unknown[]; state: SetupState };
    assert.equal(r.state.needsSetup, false);
    assert.equal(r.state.workspace, target);
    assert.ok(existsSync(join(target, "inspiration/shorts/links.txt")));
    assert.equal((await readAppSettings(d.home)).workspace, target);
    assert.equal((await d.api("/api/projects")).status, 200);
  } finally {
    await d.close();
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch {}
  }
});

test("path starting with ~ expands correctly", async () => {
  const d = await startTestDashboard({ noWorkspace: true });
  const subName = `mostudio-test-tilde-${Date.now()}`;
  const target = `~/${subName}`;
  const expandedTarget = join(homedir(), subName);
  try {
    const res = await d.api("/api/setup/workspace", post({ path: target }));
    assert.equal(res.status, 200);
    const r = (await res.json()) as { entries: unknown[]; state: SetupState };
    assert.equal(r.state.workspace, expandedTarget);
    assert.ok(existsSync(expandedTarget));
  } finally {
    await d.close();
    try {
      rmSync(expandedTarget, { recursive: true, force: true });
    } catch {}
  }
});

test("relative or orphan paths are refused with plain messages", async () => {
  const d = await startTestDashboard({ noWorkspace: true });
  try {
    // Missing or invalid body
    const r0 = await d.api("/api/setup/workspace", post({}));
    assert.equal(r0.status, 400);

    // Relative path
    const r1 = await d.api("/api/setup/workspace", post({ path: "relative/path" }));
    assert.equal(r1.status, 400);
    const e1 = (await r1.json()) as { error: string };
    assert.equal(e1.error, "Choose a full folder path, like /Users/you/Movies/mostudio");

    // Orphan path (parent folder does not exist)
    const orphan = join(tmpdir(), `nonexistent-parent-${Date.now()}`, "subfolder");
    const r2 = await d.api("/api/setup/workspace", post({ path: orphan }));
    assert.equal(r2.status, 400);
    const e2 = (await r2.json()) as { error: string };
    assert.equal(e2.error, "That folder's parent doesn't exist");
  } finally {
    await d.close();
  }
});

test("hasAiKey detection reflects keys and local whisper", async () => {
  // Groq key set
  const d1 = await startTestDashboard({
    noWorkspace: true,
    processEnv: { GROQ_API_KEY: "gsk_12345" },
  });
  try {
    const s1 = (await (await d1.api("/api/setup")).json()) as SetupState;
    assert.equal(s1.hasAiKey, true);
  } finally {
    await d1.close();
  }

  // Cloudflare key + account ID
  const d2 = await startTestDashboard({
    noWorkspace: true,
    processEnv: {
      CLOUDFLARE_API_TOKEN: "tok_12345",
      CLOUDFLARE_ACCOUNT_ID: "acc_12345",
    },
  });
  try {
    const s2 = (await (await d2.api("/api/setup")).json()) as SetupState;
    assert.equal(s2.hasAiKey, true);
  } finally {
    await d2.close();
  }
});

test("version comes from package.json", async () => {
  const d = await startTestDashboard({ noWorkspace: true });
  try {
    const s = (await (await d.api("/api/setup")).json()) as SetupState;
    assert.equal(typeof s.version, "string");
    assert.equal(s.version, "0.1.0");
  } finally {
    await d.close();
  }
});

test("startup restores workspace from app settings when not explicitly passed", async () => {
  const tempHome = tmpDir();
  const targetDir = tmpDir();
  try {
    await writeAppSettings(tempHome, { workspace: targetDir });
    const d = await startTestDashboard({ home: tempHome, noWorkspace: true });
    try {
      assert.equal(d.ctx.root, targetDir);
      const s = (await (await d.api("/api/setup")).json()) as SetupState;
      assert.equal(s.needsSetup, false);
      assert.equal(s.workspace, targetDir);
    } finally {
      await d.close();
    }
  } finally {
    try {
      rmSync(tempHome, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    } catch {}
  }
});
