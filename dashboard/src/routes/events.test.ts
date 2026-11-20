import assert from "node:assert/strict";
import test from "node:test";
import { startTestDashboard } from "../testkit.ts";

test("SSE replays after Last-Event-ID then streams live", async () => {
  const d = await startTestDashboard();
  try {
    const id = "p1";
    let emitMore!: () => void;
    let release!: () => void;

    d.ctx.jobs.start(id, async (emit) => {
      emit({ type: "log", message: "first" });
      emit({ type: "log", message: "second" });
      emit({ type: "log", message: "third" });
      await new Promise<void>((r) => (emitMore = r));
      emit({ type: "log", message: "fourth" });
      await new Promise<void>((r) => (release = r));
    });

    // Wait until 3 events are emitted
    while (d.ctx.jobs.events(id).length < 3) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const abortController = new AbortController();
    const res = await d.api(`/api/projects/${id}/events`, {
      headers: { "Last-Event-ID": "1" },
      signal: abortController.signal,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.equal(res.headers.get("cache-control"), "no-store");

    const reader = res.body?.getReader();
    assert.ok(reader);

    const decoder = new TextDecoder();
    let accumulated = "";

    // Read replay (events 2 and 3)
    while (!accumulated.includes("id: 3\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
    }

    assert.ok(!accumulated.includes("id: 1\n"));
    assert.ok(accumulated.includes("id: 2\n"));
    assert.ok(accumulated.includes("id: 3\n"));
    assert.equal(d.ctx.jobs.subscriberCount(id), 1);

    // Emit 4th event
    emitMore();

    // Read 4th event
    while (!accumulated.includes("id: 4\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
    }
    assert.ok(accumulated.includes("id: 4\n"));

    // Release the job
    release();
    await d.ctx.jobs.idle(id);

    // Abort stream and verify subscriber is cleaned up
    abortController.abort();
    try {
      await reader.cancel();
    } catch {}

    // Wait for req.on("close") cleanup
    for (let i = 0; i < 50; i++) {
      if (d.ctx.jobs.subscriberCount(id) === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(d.ctx.jobs.subscriberCount(id), 0);
  } finally {
    await d.close();
  }
});

test("SSE replays using ?since= query parameter", async () => {
  const d = await startTestDashboard();
  try {
    const id = "p2";
    d.ctx.jobs.start(id, async (emit) => {
      emit({ type: "log", message: "e1" });
      emit({ type: "log", message: "e2" });
      emit({ type: "log", message: "e3" });
    });
    await d.ctx.jobs.idle(id);

    const abortController = new AbortController();
    const res = await d.api(`/api/projects/${id}/events?since=2`, {
      signal: abortController.signal,
    });
    assert.equal(res.status, 200);

    const reader = res.body?.getReader();
    assert.ok(reader);
    const decoder = new TextDecoder();
    let accumulated = "";

    while (!accumulated.includes("id: 3\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
    }

    assert.ok(!accumulated.includes("id: 1\n"));
    assert.ok(!accumulated.includes("id: 2\n"));
    assert.ok(accumulated.includes("id: 3\n"));

    abortController.abort();
    try {
      await reader.cancel();
    } catch {}
  } finally {
    await d.close();
  }
});

test("POST /api/projects/:id/cancel cancels running job", async () => {
  const d = await startTestDashboard();
  try {
    const id = "p-cancel";
    d.ctx.jobs.start(id, (_emit, signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    assert.equal(d.ctx.jobs.isRunning(id), true);

    const res = await d.api(`/api/projects/${id}/cancel`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { cancelled: boolean };
    assert.equal(body.cancelled, true);

    await d.ctx.jobs.idle(id);
    assert.equal(d.ctx.jobs.isRunning(id), false);
    assert.equal((d.ctx.jobs.events(id).at(-1) as { status?: string }).status, "cancelled");

    // cancelling again returns false
    const res2 = await d.api(`/api/projects/${id}/cancel`, { method: "POST" });
    assert.equal(res2.status, 200);
    const body2 = (await res2.json()) as { cancelled: boolean };
    assert.equal(body2.cancelled, false);
  } finally {
    await d.close();
  }
});

test("server close aborts running jobs", async () => {
  const d = await startTestDashboard();
  try {
    const id = "p-close";
    d.ctx.jobs.start(id, (_emit, signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("server closing")));
      });
    });

    assert.equal(d.ctx.jobs.isRunning(id), true);
    const start = Date.now();
    await d.close();
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 3000, `Expected close under 3000ms, took ${elapsed}ms`);
    assert.equal(d.ctx.jobs.isRunning(id), false);
    assert.equal((d.ctx.jobs.events(id).at(-1) as { status?: string }).status, "cancelled");
  } finally {
    try {
      await d.close();
    } catch {}
  }
});

test("GET /api/projects/:id reflects running status from jobs", async () => {
  const d = await startTestDashboard();
  try {
    const res = await d.api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "test-run" }),
    });
    assert.equal(res.status, 201);
    const proj = (await res.json()) as { id: string; running: boolean };
    assert.equal(proj.running, false);

    let release!: () => void;
    d.ctx.jobs.start(proj.id, async () => {
      await new Promise<void>((r) => (release = r));
    });

    const statusRes = await d.api(`/api/projects/${proj.id}`);
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as { running: boolean };
    assert.equal(status.running, true);

    const listRes = await d.api("/api/projects");
    assert.equal(listRes.status, 200);
    const listBody = (await listRes.json()) as { projects: { id: string; lastStatus: string }[] };
    const summary = listBody.projects.find((p) => p.id === proj.id);
    assert.equal(summary?.lastStatus, "running");

    release();
    await d.ctx.jobs.idle(proj.id);

    const statusRes2 = await d.api(`/api/projects/${proj.id}`);
    assert.equal(statusRes2.status, 200);
    const status2 = (await statusRes2.json()) as { running: boolean };
    assert.equal(status2.running, false);
  } finally {
    await d.close();
  }
});
