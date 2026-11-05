import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { remoteOutputPath, remotePackageRoot, safeRemotePath } from "./remote-render-staging";

test("remote staging paths reject traversal, drives, absolute paths, and encoded traversal", () => {
  for (const bad of ["../x", "/x", "C:/x", "x/%2e%2e/y", "x\\..\\y", "x//y", "x/./y"]) assert.throws(() => safeRemotePath(bad));
  assert.equal(safeRemotePath("project-a/packages/take/clip.mp4"), "project-a/packages/take/clip.mp4");
});

test("SaveVideo recovery is constrained to the mirrored package", () => {
  const root = path.join(process.cwd(), "output", "martini_shot", "project-a");
  const pkg = path.join(root, "packages", "take-01");
  assert.equal(remotePackageRoot("project-a", pkg, root), "project-a/packages/take-01");
  const result = remoteOutputPath("project-a", root, pkg, "martini_shot/project-a/packages/take-01", "clip.mp4");
  assert.equal(result.remote, "project-a/packages/take-01/clip.mp4");
  assert.throws(() => remoteOutputPath("project-a", root, pkg, "martini_shot/project-a/elsewhere", "clip.mp4"));
});
