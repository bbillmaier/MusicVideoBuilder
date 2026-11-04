// Pure location-request rules. No Electron or SQLite imports so they can be unit-tested with plain Node.
// The matching rules mirror find_requested_location() in custom_nodes/MartiniShot/project_store.py.
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  LocationFileCandidate, LocationStateMode, PlanData, RequestedLocationStatus, TextOnlyLocationStatus,
} from "./contracts";
import { isInside, projectSlug } from "./project-rules";

/** The extensions Martini Shot Resolve Locations reads (`_IMAGE_EXTENSIONS` in project_store.py). */
export const LOCATION_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".bmp"];
/** Common image types the resolver ignores; a matching name with one of these gets a targeted explanation. */
export const UNSUPPORTED_IMAGE_EXTENSIONS = [".gif", ".tif", ".tiff", ".heic", ".heif", ".avif", ".jfif", ".svg", ".psd", ".raw", ".dng", ".ico"];
export const LOCATIONS_FOLDER = "locations";
/** Earlier images moved aside by an explicit Replace. The resolver only looks at files directly in locations\. */
export const REPLACED_FOLDER = "replaced";
export const MAX_LOCATION_IMAGE_BYTES = 200 * 1024 ** 2;

export const MODE_LABELS: Record<LocationStateMode, string> = {
  image_backed: "image-backed",
  missing: "text-only — no image found",
  failed: "image failed to load",
  not_checked: "waiting for image",
  text_only: "text-only",
};

/** The slug the resolver uses for a requested name, or null when the name has no letters or digits (the node would fail). */
export function locationSlug(name: string): string | null {
  try { return projectSlug(name); } catch { return null; }
}

/** A stable key for places whose name has no usable slug (text-only rows only). */
export function storageSlug(name: string): string {
  return locationSlug(name) ?? `place-${createHash("sha1").update(name).digest("hex").slice(0, 10)}`;
}

export function requestedFileName(slug: string): string {
  return `${slug}.png`;
}

export function locationsFolder(projectPath: string): string {
  return path.join(projectPath, LOCATIONS_FOLDER);
}

/** The deterministic target path for a request; refuses anything that would leave the project's locations folder. */
export function requestedTargetPath(projectPath: string, slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || slug.length > 80) throw new Error("That is not a requested location.");
  const folder = locationsFolder(projectPath);
  const target = path.join(folder, requestedFileName(slug));
  if (!isInside(folder, target) || path.dirname(target) !== folder) throw new Error("Refusing to write outside the project's locations folder.");
  return target;
}

export type FolderEntry = { name: string; isFile: boolean; size: number; mtimeMs: number; head?: Uint8Array | null };

/** Recognizes the image formats the resolver can read from their first bytes. */
export function sniffImage(head: Uint8Array | null | undefined): "png" | "jpeg" | "webp" | "bmp" | null {
  if (!head || head.length < 4) return null;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head[0] === 0x42 && head[1] === 0x4d) return "bmp";
  if (head.length >= 12 && String.fromCharCode(...head.slice(0, 4)) === "RIFF" && String.fromCharCode(...head.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

function candidate(entry: FolderEntry, supported: boolean): LocationFileCandidate {
  let issue: string | null = null;
  if (!supported) issue = `${path.extname(entry.name).toLowerCase() || "no extension"} files are not read by the resolver`;
  else if (entry.size === 0) issue = "the file is empty";
  else if (entry.head !== undefined && !sniffImage(entry.head)) issue = "the contents are not a PNG, JPG, WEBP, or BMP image";
  return { fileName: entry.name, sizeBytes: entry.size, modifiedAt: new Date(entry.mtimeMs).toISOString(), supported, issue };
}

export type FolderScan = { bySlug: Map<string, LocationFileCandidate[]>; unrecognized: string[] };

/** Groups the locations folder's files by the requested slug they would match, exactly as the resolver does:
 *  slug(file stem) == slug(location name) and a supported extension. Unsupported matching names are kept as hints. */
export function scanLocationFolder(entries: FolderEntry[], slugs: string[]): FolderScan {
  const wanted = new Set(slugs);
  const bySlug = new Map<string, LocationFileCandidate[]>(slugs.map((slug) => [slug, []]));
  const unrecognized: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const supported = LOCATION_IMAGE_EXTENSIONS.includes(ext);
    if (!supported && !UNSUPPORTED_IMAGE_EXTENSIONS.includes(ext)) continue;
    const slug = locationSlug(path.parse(entry.name).name);
    if (slug && wanted.has(slug)) bySlug.get(slug)!.push(candidate(entry, supported));
    else unrecognized.push(entry.name);
  }
  for (const list of bySlug.values()) list.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return { bySlug, unrecognized: unrecognized.sort((a, b) => a.localeCompare(b)) };
}

/** A comparable snapshot of what the resolver would see for one request. */
export function candidateSignature(candidates: LocationFileCandidate[]): string {
  return JSON.stringify(candidates.filter((item) => item.supported).map((item) => [item.fileName.toLowerCase(), item.sizeBytes, item.modifiedAt]));
}

// ----- Resolve Locations report ----------------------------------------------------------------------------

export type ResolvedLine = { mode: "image_backed" | "missing" | "failed"; detail: string; loadedFile: string | null };

/** Reads the `location_requests` text MartiniShotResolveLocations returns: one `  <name>: <status>` line per request. */
export function parseResolveReport(report: string, names: string[]): Map<string, ResolvedLine> {
  const result = new Map<string, ResolvedLine>();
  const lines = report.split(/\r?\n/);
  for (const name of names) {
    const line = lines.find((item) => item.startsWith(`  ${name}: `));
    if (!line) continue;
    const detail = line.slice(name.length + 4).trim();
    const lower = detail.toLowerCase();
    let mode: ResolvedLine["mode"] = "failed";
    if (lower.startsWith("image-backed")) mode = "image_backed";
    else if (lower.startsWith("text-only")) mode = "missing";
    const loaded = mode === "image_backed" ? detail.match(/loaded\s+(.+)$/i) : null;
    result.set(name, { mode, detail, loadedFile: loaded ? loaded[1].trim() : null });
  }
  return result;
}

/** The concise report line shown on screen, e.g. "motel corridor: text-only — no image found" (no long path). */
export function shortReportLine(name: string, line: ResolvedLine | undefined): string {
  if (!line) return `${name}: not in the resolver report`;
  if (line.mode === "missing") return `${name}: ${MODE_LABELS.missing}`;
  return `${name}: ${line.detail}`;
}

// ----- Status derivation -----------------------------------------------------------------------------------

export type StoredRequestState = {
  mode: LocationStateMode;
  detail: string | null;
  checkedSignature: string | null;
  checkedAt: string | null;
  updatedAt: string | null;
};

/** Combines the last resolver result with the folder as it is now into the label, reason, and MiniMax eligibility. */
export function describeRequest(fileName: string, stored: StoredRequestState | null, candidates: LocationFileCandidate[]): Pick<RequestedLocationStatus, "mode" | "modeLabel" | "reason" | "passedToMiniMax" | "changedSinceCheck"> {
  const supported = candidates.filter((item) => item.supported);
  const unsupported = candidates.filter((item) => !item.supported);
  const checked = stored && stored.mode !== "not_checked" && stored.checkedSignature !== null;
  const changed = Boolean(checked && stored.checkedSignature !== candidateSignature(candidates));
  const mode: LocationStateMode = checked ? stored.mode : "not_checked";

  const localProblem = (): string | null => {
    if (supported.length > 1) return `More than one matching image (${supported.map((item) => item.fileName).join(", ")}). Keep exactly one.`;
    const bad = supported.find((item) => item.issue);
    if (bad) return `${bad.fileName}: ${bad.issue}. Re-save it as PNG or JPG and use Replace.`;
    if (!supported.length && unsupported.length) {
      return `${unsupported.map((item) => item.fileName).join(", ")} ${unsupported.length === 1 ? "is not a supported type" : "are not supported types"}. Save it as ${fileName} (PNG, JPG, WEBP, or BMP).`;
    }
    return null;
  };

  if (!checked || changed) {
    const problem = localProblem();
    const label = changed ? "changed since last check" : supported.length ? "image found — not checked" : MODE_LABELS.not_checked;
    let reason: string;
    if (problem) reason = problem;
    else if (supported.length) reason = `${supported[0].fileName} is in the folder. Click Check for images to confirm it loads.`;
    else if (changed) reason = `The image was removed. Add ${fileName}, then click Check for images.`;
    else reason = `Save one image as ${fileName} in the drop folder, then click Check for images.`;
    return { mode, modeLabel: label, reason, passedToMiniMax: false, changedSinceCheck: changed };
  }

  if (mode === "image_backed") {
    return { mode, modeLabel: MODE_LABELS.image_backed, reason: `${supported[0]?.fileName ?? fileName} will be passed to MiniMax as this location's image reference.`, passedToMiniMax: true, changedSinceCheck: false };
  }
  if (mode === "failed") {
    const detail = (stored.detail ?? "").replace(/^image failed to load\s*—\s*/i, "");
    const reason = /more than one/i.test(detail)
      ? `More than one matching image${supported.length ? ` (${supported.map((item) => item.fileName).join(", ")})` : ""}. Keep exactly one, then check again.`
      : `${detail || fileName} could not be read as an image. Re-save it as PNG or JPG, use Replace, then check again.`;
    return { mode, modeLabel: MODE_LABELS.failed, reason, passedToMiniMax: false, changedSinceCheck: false };
  }
  return { mode, modeLabel: MODE_LABELS.missing, reason: localProblem() ?? `No image named ${fileName} was found. Add it to the drop folder, then click Check for images.`, passedToMiniMax: false, changedSinceCheck: false };
}

// ----- Plan grouping ---------------------------------------------------------------------------------------

export type PlannedRequest = { name: string; slug: string | null; fileName: string; sections: number[]; brollSections: number[]; storyNote: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Requested performer locations, one per resolver file name, with the sections that actually use them. */
export function plannedRequests(plan: PlanData): PlannedRequest[] {
  const requests: PlannedRequest[] = [];
  for (const requested of plan.requestedLocations) {
    const slug = locationSlug(requested.name);
    const uses = plan.sections.filter((section) => same(section.location, requested.name));
    const performer = uses.filter((section) => section.scene !== "B-roll");
    const existing = slug ? requests.find((item) => item.slug === slug) : undefined;
    if (existing) {
      // Two names with the same file name share one image, as they do in the resolver.
      existing.sections = [...new Set([...existing.sections, ...performer.map((section) => section.number)])].sort((a, b) => a - b);
      continue;
    }
    requests.push({
      name: requested.name, slug, fileName: slug ? requestedFileName(slug) : "",
      sections: performer.map((section) => section.number),
      brollSections: uses.filter((section) => section.scene === "B-roll").map((section) => section.number),
      storyNote: performer.find((section) => section.beat)?.beat ?? "",
    });
  }
  return requests;
}

/** Sections placed at each supplied (image-backed) location. */
export function suppliedSections(plan: PlanData | null, name: string): number[] {
  if (!plan) return [];
  return plan.sections.filter((section) => section.locationMode === "image_backed" && same(section.location, name)).map((section) => section.number);
}

/** Text-only places in the plan that are not requests: B-roll places, and performer places planned with requests off. */
export function textOnlyLocations(plan: PlanData): TextOnlyLocationStatus[] {
  const result: TextOnlyLocationStatus[] = [];
  for (const section of plan.sections) {
    if (!section.location) continue;
    const kind = section.locationMode === "text_only_broll" ? "broll" : section.locationMode === "text_only" ? "performer" : null;
    if (!kind) continue;
    if (plan.requestedLocations.some((item) => same(item.name, section.location))) continue;
    const existing = result.find((item) => item.kind === kind && same(item.name, section.location));
    if (existing) { existing.sections.push(section.number); continue; }
    result.push({
      name: section.location, sections: [section.number], kind,
      reason: kind === "broll"
        ? "B-roll without the performer. Described in text; not used as a performer image reference."
        : "Performer scenes here have no image reference: image requests were off, or the place has no supplied photo. Turn requests on in Direction and create a new plan to get an image request.",
    });
  }
  return result;
}

/** Values for workflows/03-resolve-locations.json. */
export function resolveWorkflowValues(projectSlugValue: string): Record<string, unknown> {
  return { project_name: projectSlugValue };
}

export function storyFileHash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
