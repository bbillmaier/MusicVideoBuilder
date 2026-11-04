import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  comfyOutputReference, copyAsset, friendlyName, isInside, missingRequirements, projectSlug, statusAfterAssetChange, storedFileName,
  validateProjectName,
} from "./project-rules";

test("project slug matches MartiniShot project_store.project_slug", () => {
  assert.equal(projectSlug("Static Heart"), "static-heart");
  assert.equal(projectSlug("  --Glass   Trails!!  "), "glass-trails");
  assert.equal(projectSlug("Café Nuit"), "caf-nuit");
  assert.equal(projectSlug("x".repeat(100)).length, 80);
  assert.throws(() => projectSlug("!!!"), /at least one letter or number/);
});

test("project names are validated with readable errors", () => {
  assert.deepEqual(validateProjectName("  Static   Heart "), { name: "Static Heart", slug: "static-heart" });
  assert.throws(() => validateProjectName(""), /Enter a project name/);
  assert.throws(() => validateProjectName(42), /must be text/);
  assert.throws(() => validateProjectName("a".repeat(81)), /at most 80/);
  assert.throws(() => validateProjectName("bad\u0007name"), /control characters/);
  assert.throws(() => validateProjectName("★★★"), /at least one letter or number/);
});

test("starter requirements and status", () => {
  const counts = { song: 0, performer: 0, outfit: 2, location: 0 };
  assert.deepEqual(missingRequirements(counts), ["Add the song", "Add at least one performer image"]);
  assert.equal(statusAfterAssetChange(counts), "new");
  assert.equal(statusAfterAssetChange({ ...counts, song: 1, performer: 1 }), "assets_ready");
});

test("file naming and path containment", () => {
  assert.equal(friendlyName("performer_main-v2.JPG"), "performer main v2");
  assert.equal(storedFileName("outfit", "1234abcd-ffff", "C:\\Pics\\Outfit 01 (final).PNG"), "outfit-1234abcd-outfit-01-final.png");
  assert.equal(isInside("C:\\a\\b", "C:\\a\\b\\c.png"), true);
  assert.equal(isInside("C:\\a\\b", "C:\\a\\bc\\c.png"), false);
  assert.equal(isInside("C:\\a\\b", "C:\\a\\b"), false);
  const out = path.resolve("/comfy/output");
  assert.equal(comfyOutputReference(out, path.join(out, "martini_shot", "x", "assets", "originals", "song.wav")), "martini_shot/x/assets/originals/song.wav [output]");
  assert.throws(() => comfyOutputReference(out, path.resolve("/elsewhere/a.png")), /not inside the ComfyUI output folder/);
});

test("copyAsset copies, hashes, rejects bad input, and leaves the original alone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "martini-copy-"));
  try {
    const source = path.join(dir, "performer.png");
    await writeFile(source, "fake image bytes");
    const result = await copyAsset("performer", source, path.join(dir, "project", "assets", "originals"), "performer-1-performer.png");
    assert.equal(await readFile(result.storedPath, "utf-8"), "fake image bytes");
    assert.equal(await readFile(source, "utf-8"), "fake image bytes");
    assert.equal(result.fileSize, 16);
    assert.match(result.checksum, /^[0-9a-f]{64}$/);
    await assert.rejects(copyAsset("performer", source, path.join(dir, "project", "assets", "originals"), "performer-1-performer.png"), /EEXIST|exists/i);
    await assert.rejects(copyAsset("song", source, dir, "x.png"), /Songs must be/);
    await assert.rejects(copyAsset("outfit", path.join(dir, "missing.png"), dir, "y.png"), /no longer exists/);
    const empty = path.join(dir, "empty.jpg");
    await writeFile(empty, "");
    await assert.rejects(copyAsset("outfit", empty, dir, "z.jpg"), /is empty/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
