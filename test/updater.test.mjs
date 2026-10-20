import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { newer, parseFeed } = createRequire(import.meta.url)("../src/updater.js");

test("only a higher version counts as an update", () => {
  assert.equal(newer("0.2.1", "0.2.0"), true);
  assert.equal(newer("v0.10.0", "0.9.9"), true);
  assert.equal(newer("1.0.0", "0.99.0"), true);
  assert.equal(newer("0.2.0", "0.2.0"), false);
  assert.equal(newer("0.1.9", "0.2.0"), false);
});

test("test versions come in order, before the release they lead up to", () => {
  assert.equal(newer("0.4.0-beta.1", "0.3.1"), true);
  assert.equal(newer("0.4.0-beta.2", "0.4.0-beta.1"), true);
  assert.equal(newer("0.4.0-beta.10", "0.4.0-beta.9"), true);
  assert.equal(newer("0.4.0", "0.4.0-beta.11"), true);
  assert.equal(newer("0.4.0-beta.3", "0.4.0"), false);
  assert.equal(newer("0.4.0-rc.1", "0.4.0-beta.5"), true);
  assert.equal(newer("0.4.0-beta.1", "0.4.0-beta.1"), false);
});

test("the release's update file gives the version and each download's checksum", () => {
  const feed = parseFeed(`version: 0.2.1
files:
  - url: The-Retro-Shelf-0.2.1-mac-x64.zip
    sha512: AAA==
    size: 217725536
  - url: The-Retro-Shelf-0.2.1-mac-arm64.zip
    sha512: BBB==
    size: 197565489
path: The-Retro-Shelf-0.2.1-mac-x64.zip
sha512: AAA==
releaseDate: '2026-10-20T00:51:38.639Z'
`);
  assert.equal(feed.version, "0.2.1");
  assert.deepEqual(feed.files.find(f => f.url.endsWith("-arm64.zip")), { url: "The-Retro-Shelf-0.2.1-mac-arm64.zip", sha512: "BBB==", size: 197565489 });
  assert.equal(feed.files.length, 2);
});
