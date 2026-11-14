import assert from "node:assert/strict";
import test from "node:test";
import { HttpError } from "./http.ts";
import { JobManager } from "./jobs.ts";

test("one job per project; ids increase", async () => {
  const jm = new JobManager();
  let release!: () => void;
  jm.start("p", async (emit) => {
    emit({ type: "log", message: "a" });
    await new Promise<void>((r) => (release = r));
  });
  assert.throws(() => jm.start("p", async () => {}), (err) => {
    return err instanceof HttpError && err.status === 409 && /already running/.test(err.message);
  });
  release();
  await jm.idle("p");
  assert.deepEqual(jm.events("p").map((e) => e.id), [1]);
  assert.equal(jm.isRunning("p"), false);

  // second job on same project continues incrementing ids
  jm.start("p", async (emit) => {
    emit({ type: "log", message: "b" });
  });
  await jm.idle("p");
  assert.deepEqual(jm.events("p").map((e) => e.id), [1, 2]);
});

test("cancel aborts the job signal and ends cancelled", async () => {
  const jm = new JobManager();
  jm.start("p", (_e, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("x")))));
  assert.equal(jm.cancel("p"), true);
  await jm.idle("p");
  assert.equal(jm.isRunning("p"), false);
  assert.equal((jm.events("p").at(-1) as { status?: string }).status, "cancelled");
  // cancelling non-running project returns false
  assert.equal(jm.cancel("p"), false);
});

test("work failure emits run-end failed with error message", async () => {
  const jm = new JobManager();
  jm.start("p", async () => {
    throw new Error("something went wrong");
  });
  await jm.idle("p");
  const last = jm.events("p").at(-1) as { type: string; status?: string; error?: string };
  assert.equal(last.type, "run-end");
  assert.equal(last.status, "failed");
  assert.equal(last.error, "something went wrong");
});

test("ring buffer respects keepEvents", async () => {
  const jm = new JobManager({ keepEvents: 3 });
  jm.start("p", async (emit) => {
    emit({ type: "log", message: "1" });
    emit({ type: "log", message: "2" });
    emit({ type: "log", message: "3" });
    emit({ type: "log", message: "4" });
  });
  await jm.idle("p");
  const events = jm.events("p");
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.id), [2, 3, 4]);
});

test("events filters by afterId", async () => {
  const jm = new JobManager();
  jm.start("p", async (emit) => {
    emit({ type: "log", message: "1" });
    emit({ type: "log", message: "2" });
    emit({ type: "log", message: "3" });
  });
  await jm.idle("p");
  assert.deepEqual(jm.events("p", 2).map((e) => e.id), [3]);
  assert.deepEqual(jm.events("p", 3).map((e) => e.id), []);
  assert.deepEqual(jm.events("unknown").map((e) => e.id), []);
});

test("subscribe receives live events and unsubscribe stops delivery", async () => {
  const jm = new JobManager();
  const received: number[] = [];
  const unsubscribe = jm.subscribe("p", (e) => {
    received.push(e.id);
  });
  assert.equal(jm.subscriberCount("p"), 1);

  let release!: () => void;
  jm.start("p", async (emit) => {
    emit({ type: "log", message: "1" });
    await new Promise<void>((r) => (release = r));
    emit({ type: "log", message: "2" });
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(received, [1]);

  unsubscribe();
  assert.equal(jm.subscriberCount("p"), 0);
  release();
  await jm.idle("p");
  assert.deepEqual(received, [1]);
});

test("abortAll cancels all running jobs and waits for idle", async () => {
  const jm = new JobManager();
  jm.start("p1", (_e, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))));
  jm.start("p2", (_e, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))));
  assert.equal(jm.isRunning("p1"), true);
  assert.equal(jm.isRunning("p2"), true);

  await jm.abortAll();

  assert.equal(jm.isRunning("p1"), false);
  assert.equal(jm.isRunning("p2"), false);
  assert.equal((jm.events("p1").at(-1) as { status?: string }).status, "cancelled");
  assert.equal((jm.events("p2").at(-1) as { status?: string }).status, "cancelled");
});
