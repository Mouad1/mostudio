import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUrls, shelfCopy } from "./inspiration.ts";

test("extractUrls", () => {
  assert.deepEqual(
    extractUrls("look https://youtu.be/a and\nhttps://www.instagram.com/reel/X/ https://youtu.be/a"),
    ["https://youtu.be/a", "https://www.instagram.com/reel/X/"]
  );
  assert.deepEqual(extractUrls("no links"), []);
  assert.deepEqual(extractUrls(""), []);
  assert.deepEqual(
    extractUrls("check http://example.com/one and https://example.com/two and http://example.com/one"),
    ["http://example.com/one", "https://example.com/two"]
  );
});

test("shelfCopy", () => {
  assert.deepEqual(shelfCopy("shorts"), {
    title: "Short-form (vertical)",
    accepts: "Reels, Shorts, TikToks: links, clips, screenshots, notes",
  });
  assert.deepEqual(shelfCopy("long"), {
    title: "Long-form (landscape)",
    accepts: "YouTube videos, podcasts, interviews: links, clips, notes",
  });
});
