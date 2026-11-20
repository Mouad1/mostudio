import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import test from "node:test";
import { generateSineWav, startTestDashboard } from "../testkit.ts";

test("create, upload and status", async () => {
  const d = await startTestDashboard();
  try {
    const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "demo" }) })).json();
    assert.match(p.id, /^\d{4}-\d{2}-\d{2}-demo$/);
    const media = new Uint8Array(generateSineWav(1, 8000));
    const up = await (await d.api(`/api/projects/${p.id}/uploads?name=${encodeURIComponent("my clip.mov")}`, { method: "PUT", body: media })).json();
    assert.deepEqual(up, { path: "uploads/my clip.mov", sizeBytes: media.length });
    const s = await (await d.api(`/api/projects/${p.id}`)).json();
    assert.deepEqual([s.uploads, s.running, s.interrupted], [["uploads/my clip.mov"], false, []]);
  } finally {
    await d.close();
  }
});

test("an unreadable upload is refused in plain words and deleted", async () => {
  const d = await startTestDashboard();
  try {
    const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "broken" }) })).json();
    const res = await d.api(`/api/projects/${p.id}/uploads?name=broken.mp4`, { method: "PUT", body: "this is not a video" });
    assert.equal(res.status, 422);
    assert.equal(
      (await res.json()).error,
      "mostudio can't read this file (it may be damaged or not a real video/audio file). Try exporting it again.",
    );
    assert.deepEqual(readdirSync(join(d.ws, "projects", p.id, "uploads")), []);
    const s = await (await d.api(`/api/projects/${p.id}`)).json();
    assert.deepEqual(s.uploads, []);
  } finally {
    await d.close();
  }
});

test("an aborted upload leaves nothing behind", async () => {
  const d = await startTestDashboard();
  try {
    const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "abort-test" }) })).json();
    const url = new URL(d.base);

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: Number(url.port),
        path: `/api/projects/${p.id}/uploads?name=clip.mov`,
        method: "PUT",
        headers: {
          "content-length": "10000000",
          origin: d.base,
          "x-mostudio-token": d.token,
        },
      });

      req.on("error", () => {
        // Expected error on destroy
      });

      req.write(Buffer.alloc(64 * 1024));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });

    // Poll up to 2s to verify uploads/ has no entries
    const uploadsDir = join(d.ws, "projects", p.id, "uploads");
    const deadline = Date.now() + 2000;
    let entries: string[] = [];
    while (Date.now() < deadline) {
      try {
        entries = readdirSync(uploadsDir);
        if (entries.length === 0) break;
      } catch {
        entries = [];
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.deepEqual(entries, []);
  } finally {
    await d.close();
  }
});

test("not enough disk space is refused before writing", async () => {
  const d = await startTestDashboard();
  try {
    const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "space-test" }) })).json();
    const url = new URL(d.base);
    const { status, body } = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: `/api/projects/${p.id}/uploads?name=huge.mp4`,
          method: "PUT",
          headers: {
            "content-length": "1000000000000000",
            origin: d.base,
            "x-mostudio-token": d.token,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: data });
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    assert.equal(status, 507);
    assert.match(body.error, /Not enough free disk space/);
    const uploadsDir = join(d.ws, "projects", p.id, "uploads");
    try {
      const entries = readdirSync(uploadsDir);
      assert.deepEqual(entries, []);
    } catch (err: any) {
      assert.equal(err.code, "ENOENT");
    }
  } finally {
    await d.close();
  }
});

test("dead-pid marker shows as interrupted; live-pid marker does not", async () => {
  const d = await startTestDashboard();
  try {
    const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "marker-test" }) })).json();
    const markerPath = join(d.ws, "projects", p.id, "steps", "transcribe.running");

    writeFileSync(markerPath, JSON.stringify({ pid: 999999 }));
    let s = await (await d.api(`/api/projects/${p.id}`)).json();
    assert.deepEqual(s.interrupted, ["transcribe"]);

    writeFileSync(markerPath, JSON.stringify({ pid: process.pid }));
    s = await (await d.api(`/api/projects/${p.id}`)).json();
    assert.deepEqual(s.interrupted, []);
  } finally {
    await d.close();
  }
});

test("files: Range works, traversal refused", async () => {
  const d = await startTestDashboard();
  try {
    const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "files-test" }) })).json();
    const filePath = join(d.ws, "projects", p.id, "renders", "final.mp4");
    writeFileSync(filePath, "0123456789");

    const res = await d.api(`/api/projects/${p.id}/files/renders/final.mp4`, {
      headers: { range: "bytes=2-4" },
    });
    assert.equal(res.status, 206);
    const text = await res.text();
    assert.equal(text, "234");

    const traversalRes = await d.api(`/api/projects/${p.id}/files/..` + encodeURIComponent("/../mostudio.config.json"));
    assert.equal(traversalRes.status, 400);
  } finally {
    await d.close();
  }
});

test("peaks of a wav", async () => {
  const d = await startTestDashboard();
  try {
    const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "peaks-test" }) })).json();
    const audioDir = join(d.ws, "projects", p.id, "audio");
    mkdirSync(audioDir, { recursive: true });
    const wavPath = join(audioDir, "mix.wav");
    writeFileSync(wavPath, generateSineWav(1, 48000, 440));

    const res = await d.api(`/api/projects/${p.id}/peaks?path=audio/mix.wav&buckets=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.peaks));
    assert.equal(body.peaks.length, 10);
    assert.equal(Math.max(...body.peaks), 1);
  } finally {
    await d.close();
  }
});

test("replacements get and put", async () => {
  const d = await startTestDashboard();
  try {
    const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "rep-test" }) })).json();
    const get1 = await (await d.api(`/api/projects/${p.id}/replacements`)).json();
    assert.equal(get1.text, "# wrong => right (one per line)\n");

    const putRes = await d.api(`/api/projects/${p.id}/replacements`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "foo => bar" }),
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.deepEqual(putBody, { ok: true });

    const get2 = await (await d.api(`/api/projects/${p.id}/replacements`)).json();
    assert.equal(get2.text, "foo => bar");
  } finally {
    await d.close();
  }
});

test("workflows and projects listing", async () => {
  const d = await startTestDashboard();
  try {
    const wfRes = await (await d.api("/api/workflows")).json();
    assert.ok(Array.isArray(wfRes.workflows));
    const names = wfRes.workflows.map((w: any) => w.name);
    assert.ok(names.includes("short"));
    assert.ok(names.includes("rough-cut"));

    const p1 = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "first" }) })).json();
    const p2 = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "second" }) })).json();

    const listRes = await (await d.api("/api/projects")).json();
    assert.ok(Array.isArray(listRes.projects));
    assert.ok(listRes.projects.length >= 2);
    assert.equal(listRes.projects[0].lastStatus, "new");
  } finally {
    await d.close();
  }
});

test("projects are listed newest first, also within the same day", async () => {
  const d = await startTestDashboard();
  try {
    const create = async (slug: string): Promise<string> => {
      const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug }) })).json();
      await new Promise((r) => setTimeout(r, 30));
      return p.id;
    };
    const zeta = await create("zeta");
    const alpha = await create("alpha");
    const mid = await create("mid");
    // made last, but dated an earlier day: the date in its name wins
    mkdirSync(join(d.ws, "projects", "2020-01-01-zzz"));
    const ids = (await (await d.api("/api/projects")).json()).projects.map((p: { id: string }) => p.id);
    assert.deepEqual(ids, [mid, alpha, zeta, "2020-01-01-zzz"]);
  } finally {
    await d.close();
  }
});

test("validation and error responses", async () => {
  const d = await startTestDashboard();
  try {
    // 1. Invalid project ID (400)
    const badId = await d.api("/api/projects/not-a-valid-id");
    assert.equal(badId.status, 400);

    // 2. Missing project (404)
    const missing = await d.api("/api/projects/2026-01-01-missing");
    assert.equal(missing.status, 404);

    // 3. Bad slug on create (400)
    const badSlug = await d.api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ slug: "BAD_SLUG!" }),
    });
    assert.equal(badSlug.status, 400);

    // 4. Same slug on the same day gets a unique id (-2, -3, ...), never a 409
    const p1 = await d.api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ slug: "dupe-test" }),
    });
    assert.equal(p1.status, 201);
    const pBody = await p1.json();
    assert.match(pBody.id, /^\d{4}-\d{2}-\d{2}-dupe-test$/);
    const p2 = await d.api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ slug: "dupe-test" }),
    });
    assert.equal(p2.status, 201);
    assert.equal((await p2.json()).id, `${pBody.id}-2`);
    const p3 = await d.api("/api/projects", {
      method: "POST",
      body: JSON.stringify({ slug: "dupe-test" }),
    });
    assert.equal(p3.status, 201);
    assert.equal((await p3.json()).id, `${pBody.id}-3`);

    // 5. Unsupported file type on upload (415)
    const badUpload = await d.api(`/api/projects/${pBody.id}/uploads?name=script.py`, {
      method: "PUT",
      body: "print(1)",
    });
    assert.equal(badUpload.status, 415);
    const badUploadBody = await badUpload.json();
    assert.match(badUploadBody.error, /mostudio can't use this file type/);

    // 6. Replacements validation: non-string text (400), text > 256 KiB (413)
    const badRep1 = await d.api(`/api/projects/${pBody.id}/replacements`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: 123 }),
    });
    assert.equal(badRep1.status, 400);

    const hugeText = "a".repeat(257 * 1024);
    const badRep2 = await d.api(`/api/projects/${pBody.id}/replacements`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: hugeText }),
    });
    assert.equal(badRep2.status, 413);

    // 7. Peaks validation
    const missingPath = await d.api(`/api/projects/${pBody.id}/peaks`);
    assert.equal(missingPath.status, 400);

    const nonWav = await d.api(`/api/projects/${pBody.id}/peaks?path=render.mp4`);
    assert.equal(nonWav.status, 400);

    const badBuckets = await d.api(`/api/projects/${pBody.id}/peaks?path=audio.wav&buckets=9999`);
    assert.equal(badBuckets.status, 400);

    const missingFile = await d.api(`/api/projects/${pBody.id}/peaks?path=audio.wav&buckets=10`);
    assert.equal(missingFile.status, 404);

    // 8. Files: 404 for missing file
    const missingServe = await d.api(`/api/projects/${pBody.id}/files/missing.txt`);
    assert.equal(missingServe.status, 404);
  } finally {
    await d.close();
  }
});

test("status carries the project's remembered step params (spoken language, subtitles)", async () => {
  const d = await startTestDashboard();
  try {
    const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "remembered" }) })).json();
    const stepsDir = join(d.ws, "projects", p.id, "steps");
    mkdirSync(stepsDir, { recursive: true });
    writeFileSync(join(stepsDir, "workflow.json"), JSON.stringify({ name: "short" }));
    writeFileSync(
      join(stepsDir, "workflow-params.json"),
      JSON.stringify({ short: { transcribe: { dialect: "darija" }, localize: { lang: "arabizi" } } }),
    );
    const s = await (await d.api(`/api/projects/${p.id}`)).json();
    assert.equal(s.params?.transcribe?.dialect, "darija");
    assert.equal(s.params?.localize?.lang, "arabizi");
  } finally {
    await d.close();
  }
});

test("status media says when the file has no picture", async () => {
  const d = await startTestDashboard();
  try {
    const p = await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug: "audio-only" }) })).json();
    const mediaDir = join(d.ws, "projects", p.id, "media");
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(
      join(mediaDir, "ingest.json"),
      JSON.stringify({ file: "media/source.m4a", durationSec: 91.8, width: 0, height: 0, hasVideo: false }),
    );
    const s = await (await d.api(`/api/projects/${p.id}`)).json();
    assert.equal(s.media.hasVideo, false);
  } finally {
    await d.close();
  }
});

test("an untouched project can be deleted; one with uploads, media or step results cannot", async () => {
  const d = await startTestDashboard();
  try {
    const create = async (slug: string) =>
      (await (await d.api("/api/projects", { method: "POST", body: JSON.stringify({ slug }) })).json()).id as string;

    // A refused first upload leaves the project untouched: it can go.
    const empty = await create("refused");
    const refused = await d.api(`/api/projects/${empty}/uploads?name=broken.mp4`, { method: "PUT", body: "not a video" });
    assert.equal(refused.status, 422);
    const del = await d.api(`/api/projects/${empty}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal((await d.api(`/api/projects/${empty}`)).status, 404);
    assert.ok(!readdirSync(join(d.ws, "projects")).includes(empty));

    // An upload keeps the project.
    const withUpload = await create("kept-upload");
    const media = new Uint8Array(generateSineWav(1, 8000));
    assert.equal((await d.api(`/api/projects/${withUpload}/uploads?name=clip.wav`, { method: "PUT", body: media })).status, 200);
    assert.equal((await d.api(`/api/projects/${withUpload}`, { method: "DELETE" })).status, 409);

    // Media or step results keep the project.
    const withMedia = await create("kept-media");
    writeFileSync(join(d.ws, "projects", withMedia, "media", "ingest.json"), "{}");
    assert.equal((await d.api(`/api/projects/${withMedia}`, { method: "DELETE" })).status, 409);
    const withSteps = await create("kept-steps");
    writeFileSync(join(d.ws, "projects", withSteps, "run.json"), JSON.stringify({ version: 1, steps: {} }));
    assert.equal((await d.api(`/api/projects/${withSteps}`, { method: "DELETE" })).status, 409);
    for (const id of [withUpload, withMedia, withSteps]) {
      assert.equal((await d.api(`/api/projects/${id}`)).status, 200);
    }

    // Bad or unknown ids are refused.
    assert.equal((await d.api("/api/projects/Not_An_Id", { method: "DELETE" })).status, 400);
    assert.equal((await d.api("/api/projects/2026-01-01-missing", { method: "DELETE" })).status, 404);
  } finally {
    await d.close();
  }
});
