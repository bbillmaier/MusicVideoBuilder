/** Hash-checked, deliberately narrow mirror for a remote 05 render worker.
 * Local project files remain authoritative; this class never reads or deletes a
 * remote project tree outside the one package output it is asked to recover. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export const FILE_API_VERSION = 1;
export type StagingEvidence = { fileCount: number; uploaded: number; skipped: number; bytesUploaded: number; endpoint: string; failedFile?: string };

export function safeRemotePath(value: string): string {
  const decoded = (() => { try { return decodeURIComponent(value); } catch { throw new Error("Remote path has invalid encoding."); } })().replace(/\\/g, "/");
  if (!decoded || decoded.startsWith("/") || /^[a-z]:/i.test(decoded) || decoded.includes("\0") || decoded.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Unsafe remote Martini Shot path.");
  }
  return decoded;
}

export function remotePackageRoot(slug: string, packageFolder: string, localProjectRoot: string): string {
  const relative = path.relative(localProjectRoot, packageFolder).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Package folder is outside this local project.");
  return safeRemotePath(`${slug}/${relative}`);
}

/** The render package as a remote worker's ComfyUI must receive it: the local render_package.json holds a local absolute
 *  folder, while the worker reads the staged mirror at output/martini_shot/<slug>/... Never write this back to disk. */
export function remoteRenderPackage(renderPackage: Record<string, unknown>, slug: string, localProjectRoot: string): Record<string, unknown> {
  if (typeof renderPackage.folder !== "string") throw new Error("render_package.json has no package folder.");
  return { ...renderPackage, folder: `martini_shot/${remotePackageRoot(slug, renderPackage.folder, localProjectRoot)}` };
}

type RemoteEntry ={ size: number; mtimeMs: number | null };
/** Files this app session has proved identical on a worker (by hash), keyed by endpoint and remote path. A file is
 *  trusted again only while both copies keep exactly the size and modified time seen then; a new pod, an edit on either
 *  side, or an app restart means a fresh check. */
const confirmed = new Map<string, { localSize: number; localMtimeMs: number; remoteSize: number; remoteMtimeMs: number | null }>();

function under(root: string, target: string): boolean { const rel = path.relative(root, target); return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel); }
async function sha256(file: string): Promise<string> { return new Promise((resolve, reject) => { const hash = createHash("sha256"); const input = createReadStream(file); input.on("data", (chunk) => hash.update(chunk)); input.once("error", reject); input.once("end", () => resolve(hash.digest("hex"))); }); }

export class RemoteRenderStaging {
  readonly endpoint: string;
  constructor(endpoint: string, private readonly token: string) { this.endpoint = new URL(endpoint).toString().replace(/\/$/, ""); }
  private headers(extra?: HeadersInit): Headers { const value = new Headers(extra); if (this.token) value.set("X-Martini-Token", this.token); return value; }
  private async request(route: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`${this.endpoint}${route}`, { ...init, headers: this.headers(init.headers), signal: controller.signal, duplex: init.body ? "half" : undefined } as RequestInit);
      if (!response.ok) {
        let detail = `HTTP ${response.status}`; try { detail = (await response.json() as { error?: string }).error || detail; } catch { /* no body */ }
        throw new Error(response.status === 403 ? "Remote Martini Shot file API rejected the request: wrong or missing token." : `Remote file API: ${detail}`);
      }
      return response;
    } finally { clearTimeout(timer); }
  }
  private query(file: string): string { return `?path=${encodeURIComponent(safeRemotePath(file))}`; }
  async checkConnection(): Promise<void> {
    const stats = await this.request("/system_stats"); await stats.body?.cancel();
    const info = await (await this.request("/martini/fs/info")).json() as { api?: unknown; token_required?: unknown };
    if (typeof info.api !== "number" || info.api > FILE_API_VERSION) throw new Error("Remote ComfyUI has a newer incompatible Martini Shot file API.");
    if (info.token_required === true && !this.token) throw new Error("Remote ComfyUI requires a Martini Shot file API token.");
  }
  async stat(file: string): Promise<{ exists: boolean; type?: string; size?: number }> { return (await (await this.request(`/martini/fs/stat${this.query(file)}`)).json()) as { exists: boolean; type?: string; size?: number }; }
  async hash(file: string): Promise<{ sha256: string; size: number } | null> { const stat = await this.stat(file); if (!stat.exists) return null; return (await (await this.request(`/martini/fs/hash${this.query(file)}`)).json()) as { sha256: string; size: number }; }
  async mkdir(folder: string): Promise<void> { await this.request("/martini/fs/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: safeRemotePath(folder) }) }); }
  async list(folder: string): Promise<Array<{ name: string; type: "file" | "dir"; size: number; mtime_ms?: number }>> {
    const body = await (await this.request(`/martini/fs/list${this.query(folder)}`)).json() as { entries?: Array<{ name: string; type: "file" | "dir"; size: number; mtime_ms?: number }> };
    return Array.isArray(body.entries) ? body.entries : [];
  }
  async move(from: string, to: string): Promise<void> {
    await this.request("/martini/fs/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: safeRemotePath(from), to: safeRemotePath(to) }) });
  }
  async upload(local: string, remote: string, overwrite: boolean): Promise<void> { await this.request(`/martini/fs/file${this.query(remote)}&overwrite=${overwrite ? "1" : "0"}`, { method: "PUT", body: Readable.toWeb(createReadStream(local)) as BodyInit }); }
  async download(remote: string, local: string, allowOverwrite = false): Promise<void> {
    if (!allowOverwrite) { try { await fs.access(local); throw new Error(`Refusing to overwrite local output ${local}.`); } catch (error) { if (!(error as NodeJS.ErrnoException).code || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    await fs.mkdir(path.dirname(local), { recursive: true }); const partial = `${local}.partial`;
    const response = await this.request(`/martini/fs/file${this.query(remote)}`);
    if (!response.body) throw new Error("Remote output response has no body.");
    await new Promise<void>((resolve, reject) => Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(createWriteStream(partial, { flags: "wx" })).once("error", reject).once("finish", resolve));
    await fs.rename(partial, local);
  }
  /** Every file under a remote folder, from one listing request per folder (sizes and times come with the listing). */
  private async remoteTree(root: string): Promise<Map<string, RemoteEntry>> {
    const tree = new Map<string, RemoteEntry>();
    const stat = await this.stat(root);
    if (!stat.exists || stat.type !== "dir") return tree;
    const visit = async (folder: string): Promise<void> => {
      for (const entry of await this.list(folder)) {
        const remote = safeRemotePath(`${folder}/${entry.name}`);
        if (entry.type === "dir") await visit(remote);
        else if (entry.type === "file") tree.set(remote, { size: entry.size, mtimeMs: typeof entry.mtime_ms === "number" ? entry.mtime_ms : null });
      }
    };
    await visit(root);
    return tree;
  }
  private confirmedKey(remote: string): string { return `${this.endpoint}|${remote}`; }
  /** True when this session already proved the two copies identical and neither side has changed since. */
  private isConfirmed(remote: string, local: { size: number; mtimeMs: number }, entry: RemoteEntry): boolean {
    const known = confirmed.get(this.confirmedKey(remote));
    return Boolean(known && entry.mtimeMs !== null && known.localSize === local.size && known.localMtimeMs === local.mtimeMs
      && known.remoteSize === entry.size && known.remoteMtimeMs === entry.mtimeMs);
  }
  private confirm(remote: string, local: { size: number; mtimeMs: number }, entry: RemoteEntry): void {
    confirmed.set(this.confirmedKey(remote), { localSize: local.size, localMtimeMs: local.mtimeMs, remoteSize: entry.size, remoteMtimeMs: entry.mtimeMs });
  }
  /** Uploads the complete local-authoritative project, never following a symlink.
   * This intentionally supports every Martini Shot workflow, not just rendering.
   * One listing per remote folder replaces a stat and hash request per file: a file is uploaded when the worker lacks it
   * or has a different size, skipped when this session already confirmed it unchanged, and hash-checked otherwise. */
  async stageProject(localProjectRoot: string, slug: string, packageFolder = localProjectRoot): Promise<StagingEvidence> {
    const root = path.resolve(localProjectRoot); const packageRoot = path.resolve(packageFolder);
    if (packageRoot !== root && !under(root, packageRoot)) throw new Error("Package folder is outside its local project.");
    const required = packageRoot === root ? [""] : ["project.json", "story_plan.json", "resolved_plan.json", "render_package.json", "assets", "locations"];
    const files: string[] = [];
    const walk = async (current: string): Promise<void> => {
      const listed = await fs.readdir(current, { withFileTypes: true });
      for (const entry of listed) {
        const absolute = path.join(current, entry.name); const real = await fs.lstat(absolute);
        if (real.isSymbolicLink()) continue; // never follow a project symlink
        if (real.isDirectory()) await walk(absolute); else if (real.isFile()) files.push(absolute);
      }
    };
    for (const item of required) { const target = path.join(root, item); const stat = await fs.lstat(target).catch(() => null); if (stat?.isSymbolicLink()) throw new Error(`Refusing symlinked required input: ${item || "project root"}`); if (stat?.isDirectory()) await walk(target); else if (stat?.isFile()) files.push(target); }
    if (packageRoot !== root) await walk(packageRoot);
    const seen = [...new Set(files)]; const evidence: StagingEvidence = { fileCount: seen.length, uploaded: 0, skipped: 0, bytesUploaded: 0, endpoint: this.endpoint };
    const tree = await this.remoteTree(safeRemotePath(slug));
    for (const local of seen) {
      try {
        if (!under(root, local)) throw new Error("Local staging path escaped project root.");
        const relative = safeRemotePath(path.relative(root, local).split(path.sep).join("/")); const remote = safeRemotePath(`${slug}/${relative}`);
        const localStat = await fs.stat(local); const entry = tree.get(remote);
        if (entry && entry.size === localStat.size) {
          if (this.isConfirmed(remote, localStat, entry)) { evidence.skipped++; continue; }
          const existing = await this.hash(remote);
          if (existing && existing.size === localStat.size && existing.sha256 === await sha256(local)) { this.confirm(remote, localStat, entry); evidence.skipped++; continue; }
        }
        if (!entry) { const parent = path.posix.dirname(remote); if (parent !== ".") await this.mkdir(parent); }
        await this.upload(local, remote, Boolean(entry)); evidence.uploaded++; evidence.bytesUploaded += localStat.size;
        // The worker's new modified time is unknown until the next listing, so the next run hash-checks it once.
        this.confirm(remote, localStat, { size: localStat.size, mtimeMs: null });
      } catch (error) { evidence.failedFile = path.relative(root, local); throw error; }
    }
    return evidence;
  }
  /** Downloads only changed remote artifacts, atomically, into the local authority. Files this session already confirmed
   * identical (same sizes and times on both sides) are skipped without hashing. */
  async synchronizeProject(localProjectRoot: string, slug: string): Promise<{ downloaded: number; bytesDownloaded: number }> {
    const root = path.resolve(localProjectRoot); const remoteRoot = safeRemotePath(slug); let downloaded = 0; let bytesDownloaded = 0;
    const visit = async (remoteFolder: string): Promise<void> => {
      for (const entry of await this.list(remoteFolder)) {
        const remote = safeRemotePath(`${remoteFolder}/${entry.name}`); const local = path.resolve(root, ...remote.slice(`${slug}/`.length).split("/"));
        if (!under(root, local)) throw new Error("Remote project entry escaped local project root.");
        if (entry.type === "dir") { await visit(remote); continue; }
        if (entry.type !== "file") continue;
        const info: RemoteEntry = { size: entry.size, mtimeMs: typeof entry.mtime_ms === "number" ? entry.mtime_ms : null };
        const localStat = await fs.stat(local).catch(() => null);
        if (localStat?.isFile() && localStat.size === entry.size) {
          if (this.isConfirmed(remote, localStat, info)) continue;
          const remoteHash = await this.hash(remote);
          if (remoteHash && remoteHash.size === localStat.size && remoteHash.sha256 === await sha256(local)) { this.confirm(remote, localStat, info); continue; }
        }
        // This is a deliberate recovery of an artifact generated by the selected remote backend.
        await this.download(remote, local, Boolean(localStat)); downloaded++; bytesDownloaded += entry.size;
        this.confirm(remote, await fs.stat(local), info);
      }
    };
    await visit(remoteRoot); return { downloaded, bytesDownloaded };
  }
}

/** A file path a remote node reported (e.g. /workspace/ComfyUI/output/martini_shot/<slug>/render-01/final.mp4) as the
 *  local file synchronizeProject copied it to. It must lie inside the mirrored package folder. */
export function remoteReportedPath(slug: string, localProjectRoot: string, packageFolder: string, reported: string): string {
  const posix = "/" + reported.trim().replace(/\\/g, "/"); // absolute, or relative to ComfyUI's output folder
  const at = posix.lastIndexOf(`/martini_shot/${slug}/`);
  if (at < 0) throw new Error(`The remote worker reported ${reported}, which is not in this project's staged folder.`);
  const relative = posix.slice(at + 1);
  const slash = relative.lastIndexOf("/");
  return remoteOutputPath(slug, localProjectRoot, packageFolder, relative.slice(0, slash), relative.slice(slash + 1)).local;
}

/** SaveVideo may only point inside this one mirrored package, never arbitrary output. */
export function remoteOutputPath(slug: string, localProjectRoot: string, packageFolder: string, subfolder: string, filename: string): { remote: string; local: string } {
  const root = remotePackageRoot(slug, packageFolder, localProjectRoot);
  // SaveVideo reports a path relative to ComfyUI output, while the file API is
  // rooted at output/martini_shot. Accept exactly that leading directory once.
  const outputRelative = safeRemotePath(subfolder).replace(/^martini_shot\//, "");
  const candidate = safeRemotePath(`${outputRelative}/${filename}`);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) throw new Error("Remote SaveVideo output is outside the staged package folder.");
  const relative = candidate.slice(`${slug}/`.length).split("/"); const local = path.resolve(localProjectRoot, ...relative);
  if (!under(path.resolve(packageFolder), local)) throw new Error("Remote output escaped local package folder.");
  return { remote: candidate, local };
}
