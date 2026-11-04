// Pure project/asset rules. No Electron or SQLite imports so they can be unit-tested with plain Node.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AssetRole, ProjectState } from "./contracts";

export const PRE_PLANNING_STATES: readonly ProjectState[] = ["new", "assets_ready"];

export const ASSET_ROLES: readonly AssetRole[] = ["song", "performer", "outfit", "location"];

/** Subfolder (inside `<project>/assets/`) holding the app's copies of user-chosen files.
 *  The MartiniShot node owns `assets/song.flac` and `assets/reference_NN.png`; this folder never collides with them. */
export const ORIGINALS_FOLDER = "originals";

const AUDIO_EXTENSIONS = [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus"];
// Matches the image types the MartiniShot nodes and ComfyUI's Load Image can read.
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp"];

export const ROLE_RULES: Record<AssetRole, { label: string; extensions: string[]; multiple: boolean; maxBytes: number; comfyKind: string | null }> = {
  song: { label: "Song", extensions: AUDIO_EXTENSIONS, multiple: false, maxBytes: 2 * 1024 ** 3, comfyKind: null },
  performer: { label: "Performer image", extensions: IMAGE_EXTENSIONS, multiple: true, maxBytes: 200 * 1024 ** 2, comfyKind: "Subject" },
  outfit: { label: "Outfit image", extensions: IMAGE_EXTENSIONS, multiple: true, maxBytes: 200 * 1024 ** 2, comfyKind: "Outfit" },
  location: { label: "Location image", extensions: IMAGE_EXTENSIONS, multiple: true, maxBytes: 200 * 1024 ** 2, comfyKind: "Location" },
};

export function isAssetRole(value: unknown): value is AssetRole {
  return typeof value === "string" && (ASSET_ROLES as readonly string[]).includes(value);
}

/** Mirrors `project_slug` in custom_nodes/MartiniShot/project_store.py exactly. */
export function projectSlug(name: string): string {
  const value = String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!value) throw new Error("Project name needs at least one letter or number.");
  return value.slice(0, 80);
}

export function validateProjectName(raw: unknown): { name: string; slug: string } {
  if (typeof raw !== "string") throw new Error("Project name must be text.");
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Enter a project name.");
  if (name.length > 80) throw new Error("Project names can be at most 80 characters.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("Project name contains unsupported control characters.");
  return { name, slug: projectSlug(name) };
}

export function missingRequirements(counts: Record<AssetRole, number>): string[] {
  const missing: string[] = [];
  if (counts.song < 1) missing.push("Add the song");
  if (counts.performer < 1) missing.push("Add at least one performer image");
  return missing;
}

/** Any asset change puts the project back at the asset stage: a later plan/render (from future tickets)
 *  was built from the old assets and must be regenerated. */
export function statusAfterAssetChange(counts: Record<AssetRole, number>): ProjectState {
  return missingRequirements(counts).length === 0 ? "assets_ready" : "new";
}

export function friendlyName(fileName: string): string {
  const base = path.parse(fileName).name.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  return (base || "Untitled").slice(0, 80);
}

export function checkExtension(role: AssetRole, filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (!ROLE_RULES[role].extensions.includes(ext)) {
    throw new Error(`${ROLE_RULES[role].label}s must be ${ROLE_RULES[role].extensions.join(", ")} files.`);
  }
  return ext;
}

/** Stable, collision-free name inside assets/originals. Keeps a readable part of the original file name. */
export function storedFileName(role: AssetRole, id: string, originalPath: string): string {
  const ext = path.extname(originalPath).toLowerCase();
  const readable = path.parse(originalPath).name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";
  return `${role}-${id.replace(/[^a-z0-9]/gi, "").slice(0, 8)}-${readable}${ext}`;
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** ComfyUI-annotated path (`relative/path.ext [output]`) that Load Image / Load Audio resolve inside its output folder. */
export function comfyOutputReference(outputRoot: string, filePath: string): string {
  if (!isInside(outputRoot, filePath)) throw new Error(`${filePath} is not inside the ComfyUI output folder ${outputRoot}.`);
  return `${path.relative(outputRoot, filePath).split(path.sep).join("/")} [output]`;
}

function readableFsError(error: unknown, file: string): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return `The file no longer exists: ${file}`;
  if (code === "EACCES" || code === "EPERM") return `Windows denied access to ${file}. Check that it is not locked or protected.`;
  if (code === "EBUSY") return `${file} is in use by another program. Close it and try again.`;
  if (code === "ENOSPC") return "The drive holding the ComfyUI output folder is full.";
  return error instanceof Error ? error.message : `Could not copy ${file}.`;
}

/** Copies a user file into the project without touching the original. Hashes while copying and writes via a temp name. */
export async function copyAsset(role: AssetRole, source: string, destinationFolder: string, destinationName: string): Promise<{ storedPath: string; checksum: string; fileSize: number }> {
  checkExtension(role, source);
  let stat;
  try { stat = await fs.stat(source); } catch (error) { throw new Error(readableFsError(error, source)); }
  if (!stat.isFile()) throw new Error(`${source} is not a regular file.`);
  if (stat.size === 0) throw new Error(`${path.basename(source)} is empty.`);
  if (stat.size > ROLE_RULES[role].maxBytes) throw new Error(`${path.basename(source)} is larger than the ${Math.round(ROLE_RULES[role].maxBytes / 1024 ** 2)} MB limit for a ${ROLE_RULES[role].label.toLowerCase()}.`);
  const storedPath = path.join(destinationFolder, destinationName);
  if (!isInside(destinationFolder, storedPath)) throw new Error("Refusing to write outside the project folder.");
  if (path.resolve(storedPath).toLowerCase() === path.resolve(source).toLowerCase()) throw new Error("That file is already this project's stored copy.");
  // rename() would silently overwrite; never replace an existing project file.
  if (await fs.stat(storedPath).then(() => true, () => false)) throw new Error(`${destinationName} already exists in the project folder.`);
  const partial = `${storedPath}.partial`;
  const hash = createHash("sha256");
  try {
    await fs.mkdir(destinationFolder, { recursive: true });
    await pipeline(
      createReadStream(source),
      new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }),
      createWriteStream(partial, { flags: "wx" }),
    );
    await fs.rename(partial, storedPath);
  } catch (error) {
    await fs.rm(partial, { force: true }).catch(() => undefined);
    throw new Error(readableFsError(error, source));
  }
  return { storedPath, checksum: hash.digest("hex"), fileSize: stat.size };
}
