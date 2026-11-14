import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { startTestDashboard } from "../testkit.ts";

test("a reel link lands in shorts/links.txt", async () => {
  const d = await startTestDashboard();
  try {
    const res = await d.api("/api/inspiration/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.instagram.com/reel/DaiCxAkOpNb/",
        note: "great hook",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.kind, "shorts");
    assert.deepEqual(body.link, {
      url: "https://www.instagram.com/reel/DaiCxAkOpNb/",
      note: "great hook",
      platform: "instagram",
    });

    const fileContent = readFileSync(join(d.ws, "inspiration", "shorts", "links.txt"), "utf8");
    assert.ok(fileContent.includes("https://www.instagram.com/reel/DaiCxAkOpNb/  # great hook"));

    // POST non-http link fails
    const badRes = await d.api("/api/inspiration/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "ftp://example.com" }),
    });
    assert.equal(badRes.status, 400);

    // DELETE link
    const delRes = await d.api("/api/inspiration/links", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.instagram.com/reel/DaiCxAkOpNb/",
        kind: "shorts",
      }),
    });
    assert.equal(delRes.status, 200);
    const afterDel = readFileSync(join(d.ws, "inspiration", "shorts", "links.txt"), "utf8");
    assert.ok(!afterDel.includes("https://www.instagram.com/reel/DaiCxAkOpNb/"));
  } finally {
    await d.close();
  }
});

test("a clip lands in long/media and is listed", async () => {
  const d = await startTestDashboard();
  try {
    const putRes = await d.api("/api/inspiration/long/files?name=a.mp4", {
      method: "PUT",
      headers: { "content-length": "4" },
      body: "test",
    });
    assert.equal(putRes.status, 200);
    const putBody = await putRes.json();
    assert.equal(putBody.name, "a.mp4");
    assert.equal(putBody.path, "long/media/a.mp4");
    assert.equal(putBody.sizeBytes, 4);
    assert.equal(putBody.kind, "media");

    // GET lists it
    const getRes = await d.api("/api/inspiration");
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.ok(Array.isArray(getBody.shelves));
    const longShelf = getBody.shelves.find((s: any) => s.kind === "long");
    assert.ok(longShelf);
    const found = longShelf.files.find((f: any) => f.name === "a.mp4");
    assert.ok(found);
    assert.equal(found.path, "long/media/a.mp4");
    assert.equal(found.kind, "media");

    // Upload note file to kind root
    const noteRes = await d.api("/api/inspiration/long/files?name=pacing.md", {
      method: "PUT",
      headers: { "content-length": "7" },
      body: "# notes",
    });
    assert.equal(noteRes.status, 200);
    const noteBody = await noteRes.json();
    assert.equal(noteBody.name, "pacing.md");
    assert.equal(noteBody.path, "long/pacing.md");
    assert.equal(noteBody.kind, "note");

    // Upload links.txt fails with 409
    const linksRes = await d.api("/api/inspiration/long/files?name=links.txt", {
      method: "PUT",
      headers: { "content-length": "4" },
      body: "test",
    });
    assert.equal(linksRes.status, 409);

    // Upload unsupported extension fails with 415
    const badExtRes = await d.api("/api/inspiration/long/files?name=bad.exe", {
      method: "PUT",
      headers: { "content-length": "4" },
      body: "test",
    });
    assert.equal(badExtRes.status, 415);

    // DELETE file
    const delRes = await d.api("/api/inspiration/files", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "long/media/a.mp4" }),
    });
    assert.equal(delRes.status, 200);

    // GET after delete
    const getRes2 = await d.api("/api/inspiration");
    const longShelf2 = (await getRes2.json()).shelves.find((s: any) => s.kind === "long");
    assert.ok(!longShelf2.files.some((f: any) => f.name === "a.mp4"));
  } finally {
    await d.close();
  }
});
