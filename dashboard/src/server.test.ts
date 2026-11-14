import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { startDashboard } from "./server.ts";
import { rawRequest, startTestDashboard } from "./testkit.ts";

test("launch link sets the session cookie; API accepts the cookie, not a query token", async () => {
  const d = await startTestDashboard();
  const r = await fetch(`${d.base}/?t=${d.token}`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const cookie = r.headers.get("set-cookie")!;
  assert.match(cookie, /mostudio_session=.+; HttpOnly; SameSite=Strict; Path=\//);
  assert.equal((await fetch(`${d.base}/api/health`, { headers: { cookie: cookie.split(";")[0]! } })).status, 200);
  assert.equal((await fetch(`${d.base}/api/health`)).status, 401);
  assert.equal((await fetch(`${d.base}/api/health?t=${d.token}`)).status, 401);
  await d.close();
});

test("foreign Host or Origin is refused even with the token", async () => {
  const d = await startTestDashboard();
  const port = new URL(d.base).port;
  assert.equal(await rawRequest(port, "GET", "/api/health", { host: `evil.test:${port}`, "x-mostudio-token": d.token }), 403);
  assert.equal((await d.api("/api/health", { method: "POST", headers: { origin: "https://evil.test" } })).status, 403);
  await d.close();
});

test("binds 127.0.0.1 and falls back when 4317 is busy", async () => {
  let blocker: http.Server | undefined;
  try {
    blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker!.once("error", reject);
      blocker!.listen(4317, "127.0.0.1", () => resolve());
    });
  } catch {
    // Port 4317 already busy on the system
    blocker = undefined;
  }
  try {
    const d = await startDashboard({});
    assert.equal(new URL(d.url).hostname, "127.0.0.1");
    assert.notEqual(d.port, 4317);
    assert.ok(d.port >= 4318);
    await d.close();
  } finally {
    if (blocker) {
      await new Promise<void>((resolve) => blocker!.close(() => resolve()));
    }
  }
});

test("close() returns while a client holds a streaming response", async () => {
  const d = await startTestDashboard({
    testRoutes: (router) => {
      router.add("GET", "/api/test/stream", (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("streaming chunk\n");
      });
    },
  });

  const res = await d.api("/api/test/stream");
  assert.equal(res.status, 200);
  const reader = res.body?.getReader();
  const chunk = await reader?.read();
  assert.ok(chunk && !chunk.done);

  const start = Date.now();
  await d.close();
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, `close() took ${elapsed} ms, expected < 1000 ms`);
});

test("errors never leak a key", async () => {
  const d = await startTestDashboard({
    processEnv: { GROQ_API_KEY: "gsk_secret_123456" },
    testRoutes: (router) => {
      router.add("GET", "/api/test/error", () => {
        throw new Error("provider groq failed with secret key gsk_secret_123456 in trace");
      });
    },
  });

  const res = await d.api("/api/test/error");
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("[redacted]"));
  assert.ok(!body.error.includes("gsk_secret_123456"));
  await d.close();
});

test("invalid launch token returns 401 expired link HTML", async () => {
  const d = await startTestDashboard();
  const r = await fetch(`${d.base}/?t=bad_token`, { redirect: "manual" });
  assert.equal(r.status, 401);
  const text = await r.text();
  assert.ok(text.includes("This link has expired. Close this tab and start mostudio again."));
  await d.close();
});

test("health endpoint returns ok, version, and root", async () => {
  const d = await startTestDashboard();
  const res = await d.api("/api/health");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; version: string; root: string | null };
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, "string");
  assert.equal(body.root, d.ws);
  await d.close();
});
