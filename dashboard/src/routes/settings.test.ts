import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadEnvFile, readAppSettings } from "../../../core/src/index.ts";
import { startTestDashboard } from "../testkit.ts";
import type { ProbeResult, SettingField } from "../types.ts";

test("GET /api/settings returns keysFile, fields, animatedCaptions", async () => {
  const d = await startTestDashboard();
  try {
    writeFileSync(join(d.home, ".env"), "GROQ_API_KEY=gsk_test12345678\n");
    const res = await d.api("/api/settings");
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      keysFile: string;
      fields: SettingField[];
      animatedCaptions: boolean;
    };

    assert.equal(body.keysFile, join(d.home, ".env"));
    assert.equal(body.animatedCaptions, false);
    assert.ok(Array.isArray(body.fields));

    const groq = body.fields.find((f) => f.name === "GROQ_API_KEY")!;
    assert.equal(groq.source, "app");
    assert.equal(groq.masked, "gsk…5678");

    const gemini = body.fields.find((f) => f.name === "GEMINI_API_KEY")!;
    assert.equal(gemini.source, "unset");
    assert.equal(gemini.masked, "");
  } finally {
    await d.close();
  }
});

test("PUT /api/settings updates values and animatedCaptions", async () => {
  const d = await startTestDashboard();
  try {
    const res = await d.api("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        values: { GROQ_API_KEY: "gsk_newval123456" },
        animatedCaptions: true,
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      keysFile: string;
      fields: SettingField[];
      animatedCaptions: boolean;
    };

    assert.equal(body.animatedCaptions, true);
    assert.equal(loadEnvFile(join(d.home, ".env")).GROQ_API_KEY, "gsk_newval123456");

    const appSettings = await readAppSettings(d.home);
    assert.equal(appSettings.animatedCaptions, true);

    const groq = body.fields.find((f) => f.name === "GROQ_API_KEY")!;
    assert.equal(groq.source, "app");
    assert.equal(groq.masked, "gsk…3456");
  } finally {
    await d.close();
  }
});

test("PUT /api/settings rejects unknown setting with 400", async () => {
  const d = await startTestDashboard();
  try {
    const res1 = await d.api("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        values: { NODE_OPTIONS: "--inspect" },
      }),
    });
    assert.equal(res1.status, 400);
    const b1 = (await res1.json()) as { error: string };
    assert.match(b1.error, /unknown setting: NODE_OPTIONS/);

    const res2 = await d.api("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        values: { WHISPER_CLI: "/bin/sh" },
      }),
    });
    assert.equal(res2.status, 400);
    const b2 = (await res2.json()) as { error: string };
    assert.match(b2.error, /unknown setting: WHISPER_CLI/);
  } finally {
    await d.close();
  }
});

test("POST /api/settings/reveal only for keys mostudio stores", async () => {
  const d = await startTestDashboard({
    processEnv: { GEMINI_API_KEY: "AIzaProcessSecretKey" },
  });
  try {
    writeFileSync(join(d.home, ".env"), "GROQ_API_KEY=gsk_secret_reveal_123\n");

    // Reveal app key -> 200 with raw value
    const r1 = await d.api("/api/settings/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GROQ_API_KEY" }),
    });
    assert.equal(r1.status, 200);
    const b1 = (await r1.json()) as { value: string };
    assert.equal(b1.value, "gsk_secret_reveal_123");

    // Reveal process key -> 403
    const r2 = await d.api("/api/settings/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "GEMINI_API_KEY" }),
    });
    assert.equal(r2.status, 403);
    const b2 = (await r2.json()) as { error: string };
    assert.equal(b2.error, "This key is managed outside mostudio");

    // Reveal unset key -> 403
    const r3 = await d.api("/api/settings/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "OPENROUTER_API_KEY" }),
    });
    assert.equal(r3.status, 403);
  } finally {
    await d.close();
  }
});

test("POST /api/settings/test ignores path overrides", async () => {
  let calledUrl = "";
  let calledHeaders: HeadersInit | undefined;
  const mockFetch: typeof fetch = async (url, init) => {
    calledUrl = String(url);
    calledHeaders = init?.headers;
    return new Response("{}", { status: 200 });
  };

  const d = await startTestDashboard();
  d.ctx.fetch = mockFetch;
  try {
    // Secret override should work
    const r1 = await d.api("/api/settings/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "groq",
        values: {
          GROQ_API_KEY: "gsk_overridden_key_1234",
          WHISPER_CLI: "/bin/sh",
          NODE_OPTIONS: "--inspect",
        },
      }),
    });
    assert.equal(r1.status, 200);
    const b1 = (await r1.json()) as ProbeResult;
    assert.equal(b1.ok, true);
    assert.equal(new Headers(calledHeaders).get("authorization"), "Bearer gsk_overridden_key_1234");

    // Path overrides on whisper-cpp are ignored
    const r2 = await d.api("/api/settings/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "whisper-cpp",
        values: {
          WHISPER_CLI: "/bin/sh",
          WHISPER_MODELS_DIR: "/fake/models",
        },
      }),
    });
    assert.equal(r2.status, 200);
    const b2 = (await r2.json()) as ProbeResult;
    // Since WHISPER_MODELS_DIR in body.values was ignored, WHISPER_MODELS_DIR is unset in test env -> "Add your Whisper models directory first"
    assert.equal(b2.ok, false);
    assert.equal(b2.message, "Add your Whisper models directory first");
  } finally {
    await d.close();
  }
});
