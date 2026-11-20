import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiFailure, createApi } from "./api.ts";
import type { RunEvent } from "../../src/types.ts";

test("api surfaces server error text with status", async () => {
  const f = (async () =>
    new Response(JSON.stringify({ error: "This project is already running." }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  await assert.rejects(
    createApi(f).send("POST", "/api/projects/p/run", {}),
    (e: ApiFailure) => e.status === 409 && /already running/.test(e.message)
  );
});

test("api.get returns parsed JSON", async () => {
  const f = (async (url: string) =>
    new Response(JSON.stringify({ ok: true, path: url }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const res = await createApi(f).get<{ ok: boolean; path: string }>("/api/health");
  assert.equal(res.ok, true);
  assert.equal(res.path, "/api/health");
});

test("api.get throws ApiFailure on HTTP error with json error message", async () => {
  const f = (async () =>
    new Response(JSON.stringify({ error: "project not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  await assert.rejects(
    createApi(f).get("/api/projects/nope"),
    (e: ApiFailure) => e.status === 404 && e.message === "project not found"
  );
});

test("api.get throws ApiFailure on HTTP error with fallback statusText", async () => {
  const f = (async () =>
    new Response("Internal Server Error", {
      status: 500,
      statusText: "Internal Error",
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;
  await assert.rejects(
    createApi(f).get("/api/crash"),
    (e: ApiFailure) => e.status === 500 && e.message === "Internal Error"
  );
});

test("api.send sends POST/PUT/DELETE with body and parses response", async () => {
  let recordedMethod: string | undefined;
  let recordedBody: string | undefined;
  let recordedContentType: string | null | undefined;
  const f = (async (url: string, init?: RequestInit) => {
    recordedMethod = init?.method;
    recordedBody = init?.body as string;
    recordedContentType = (init?.headers as Record<string, string>)?.[
      "Content-Type"
    ];
    return new Response(JSON.stringify({ id: "p1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const res = await createApi(f).send<{ id: string }>("POST", "/api/projects", {
    name: "demo",
  });
  assert.equal(res.id, "p1");
  assert.equal(recordedMethod, "POST");
  assert.equal(recordedContentType, "application/json");
  assert.deepEqual(JSON.parse(recordedBody!), { name: "demo" });
});

test("api.send handles 204 No Content gracefully", async () => {
  const f = (async () =>
    new Response(null, {
      status: 204,
    })) as typeof fetch;
  const res = await createApi(f).send<void>("DELETE", "/api/projects/p1");
  assert.equal(res, undefined);
});

test("api.text returns raw text", async () => {
  const f = (async () =>
    new Response("line 1\nline 2", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;
  const res = await createApi(f).text("/api/file.txt");
  assert.equal(res, "line 1\nline 2");
});

test("api.text throws ApiFailure on error", async () => {
  const f = (async () =>
    new Response(JSON.stringify({ error: "missing file" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  await assert.rejects(
    createApi(f).text("/api/missing.txt"),
    (e: ApiFailure) => e.status === 404 && e.message === "missing file"
  );
});

test("api.putText sends PUT text/plain body", async () => {
  let recordedMethod: string | undefined;
  let recordedBody: string | undefined;
  let recordedContentType: string | null | undefined;
  const f = (async (url: string, init?: RequestInit) => {
    recordedMethod = init?.method;
    recordedBody = init?.body as string;
    recordedContentType = (init?.headers as Record<string, string>)?.[
      "Content-Type"
    ];
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  await createApi(f).putText("/api/file.txt", "hello");
  assert.equal(recordedMethod, "PUT");
  assert.equal(recordedBody, "hello");
  assert.match(recordedContentType ?? "", /text\/plain/);
});

test("api.fileUrl returns relative project file path", () => {
  const api = createApi();
  assert.equal(
    api.fileUrl("2026-11-14-demo", "video.mp4"),
    "/api/projects/2026-11-14-demo/files/video.mp4"
  );
});

test("api.upload tracks progress and completes", async () => {
  class MockXHR {
    upload = { onprogress: null as any };
    status = 200;
    statusText = "OK";
    responseText = JSON.stringify({ uploaded: true });
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    url = "";
    method = "";
    aborted = false;

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    send(_data: any) {
      queueMicrotask(() => {
        if (this.aborted) return;
        if (this.upload.onprogress) {
          this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
          this.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 });
        }
        if (this.onload) this.onload();
      });
    }
    abort() {
      this.aborted = true;
      if (this.onabort) this.onabort();
    }
  }

  const originalXHR = (globalThis as any).XMLHttpRequest;
  (globalThis as any).XMLHttpRequest = MockXHR;
  try {
    const api = createApi();
    const progressUpdates: number[] = [];
    const blob = new Blob(["test"]);
    const upload = api.upload<{ uploaded: boolean }>("/api/upload", blob, (p) => {
      progressUpdates.push(p);
    });
    const result = await upload.done;
    assert.deepEqual(result, { uploaded: true });
    assert.deepEqual(progressUpdates, [0.5, 1]);
  } finally {
    (globalThis as any).XMLHttpRequest = originalXHR;
  }
});

test("api.upload abort cancels request", async () => {
  class MockXHR {
    upload = { onprogress: null as any };
    status = 0;
    statusText = "";
    responseText = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    aborted = false;

    open() {}
    send() {}
    abort() {
      this.aborted = true;
      if (this.onabort) this.onabort();
    }
  }

  const originalXHR = (globalThis as any).XMLHttpRequest;
  (globalThis as any).XMLHttpRequest = MockXHR;
  try {
    const api = createApi();
    const blob = new Blob(["test"]);
    const upload = api.upload<{ uploaded: boolean }>("/api/upload", blob, () => {});
    upload.abort();
    await assert.rejects(upload.done, (e: ApiFailure) => /aborted/i.test(e.message));
  } finally {
    (globalThis as any).XMLHttpRequest = originalXHR;
  }
});

test("api.events receives parsed events and closes cleanly", async () => {
  class MockEventSource {
    listeners: Record<string, ((e: any) => void)[]> = {};
    url: string;
    closed = false;

    constructor(url: string) {
      this.url = url;
    }
    addEventListener(type: string, fn: (e: any) => void) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type]!.push(fn);
    }
    emit(type: string, data: any) {
      const fns = this.listeners[type] || [];
      for (const fn of fns) fn({ data: JSON.stringify(data) });
      if ((this as any).onmessage && type === "message") {
        (this as any).onmessage({ data: JSON.stringify(data) });
      }
    }
    close() {
      this.closed = true;
    }
  }

  const originalES = (globalThis as any).EventSource;
  (globalThis as any).EventSource = MockEventSource;
  try {
    const api = createApi();
    const received: RunEvent[] = [];
    let esInstance: MockEventSource | undefined;
    const OriginalMock = (globalThis as any).EventSource;
    (globalThis as any).EventSource = function (url: string) {
      esInstance = new OriginalMock(url);
      return esInstance;
    };

    const stop = api.events("proj-1", (e) => {
      received.push(e);
    });

    assert.ok(esInstance);
    assert.equal(esInstance!.url, "/api/projects/proj-1/events");

    esInstance!.emit("run-start", { id: 1, at: "t1", type: "run-start", kind: "workflow", name: "short", mode: "auto" });
    esInstance!.emit("log", { id: 2, at: "t2", type: "log", message: "working" });

    assert.equal(received.length, 2);
    assert.equal(received[0]!.type, "run-start");
    assert.equal(received[1]!.type, "log");

    stop();
    assert.equal(esInstance!.closed, true);
  } finally {
    (globalThis as any).EventSource = originalES;
  }
});
