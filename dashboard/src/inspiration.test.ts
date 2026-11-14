import assert from "node:assert/strict";
import test from "node:test";
import {
  addLink,
  classifyLink,
  listLinks,
  platformOf,
  removeLink,
  routeInspirationFile,
} from "./inspiration.ts";

test("classifyLink", () => {
  assert.equal(classifyLink("https://www.youtube.com/shorts/abc"), "shorts");
  assert.equal(classifyLink("https://www.instagram.com/reel/DaiCxAkOpNb/"), "shorts");
  assert.equal(classifyLink("https://www.instagram.com/reels/DaiCxAkOpNb/"), "shorts");
  assert.equal(classifyLink("https://vm.tiktok.com/x"), "shorts");
  assert.equal(classifyLink("https://youtu.be/xyz"), "long");
  assert.equal(classifyLink("https://example.com/v"), "long");
});

test("platformOf", () => {
  assert.equal(platformOf("https://www.youtube.com/watch?v=123"), "youtube");
  assert.equal(platformOf("https://youtu.be/123"), "youtube");
  assert.equal(platformOf("https://www.instagram.com/p/123"), "instagram");
  assert.equal(platformOf("https://www.tiktok.com/@user/video/123"), "tiktok");
  assert.equal(platformOf("https://x.com/user/status/123"), "x");
  assert.equal(platformOf("https://twitter.com/user/status/123"), "x");
  assert.equal(platformOf("https://facebook.com/watch?v=123"), "facebook");
  assert.equal(platformOf("https://fb.watch/123"), "facebook");
  assert.equal(platformOf("https://example.com"), "other");
});

test("links round-trip with notes and keep comments", () => {
  const t = addLink("# header\nhttps://a.test/1\n", "https://b.test/2", "great hook");
  assert.equal(t, "# header\nhttps://a.test/1\nhttps://b.test/2  # great hook\n");
  assert.equal(addLink(t, "https://b.test/2"), t);
  assert.deepEqual(
    listLinks(t).map((l) => [l.url, l.note]),
    [
      ["https://a.test/1", undefined],
      ["https://b.test/2", "great hook"],
    ],
  );
  assert.equal(removeLink(t, "https://a.test/1"), "# header\nhttps://b.test/2  # great hook\n");
});

test("routeInspirationFile", () => {
  assert.equal(routeInspirationFile("shorts", "clip.MOV"), "shorts/media/clip.MOV");
  assert.equal(routeInspirationFile("long", "pacing.md"), "long/pacing.md");
  assert.throws(() => routeInspirationFile("long", "links.txt"), /links\.txt is managed by the link list/);
  assert.throws(() => routeInspirationFile("long", "x.exe"), /can't be added here \(\.exe\)/);
});
