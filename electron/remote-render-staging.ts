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
  async list(folder: string): Promise<Array<{ name: string; type: "file" | "dir"; size: number }>> {
    const body = await (await this.request(`/martini/fs/list${this.query(folder)}`)).json() as { entries?: Array<{ name: string; type: "file" | "dir"; size: number }> };
    return Array.isArray(body.entries) ? body.entries : [];
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
  /** Uploads the complete local-authoritative project, never following a symlink.
   * This intentionally supports every Martini Shot workflow, not just rendering. */
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
    for (const local of seen) {
      try {
        if (!under(root, local)) throw new Error("Local staging path escaped project root.");
        const relative = safeRemotePath(path.relative(root, local).split(path.sep).join("/")); const remote = safeRemotePath(`${slug}/${relative}`);
        const localStat = await fs.stat(local); const localHash = await sha256(local); const existing = await this.hash(remote);
        if (existing?.sha256 === localHash && existing.size === localStat.size) { evidence.skipped++; continue; }
        const parent = path.posix.dirname(remote); if (parent !== ".") await this.mkdir(parent);
        await this.upload(local, remote, Boolean(existing)); evidence.uploaded++; evidence.bytesUploaded += localStat.size;
      } catch (error) { evidence.failedFile = path.relative(root, local); throw error; }
    }
    return evidence;
  }
  /** Downloads only changed remote artifacts, atomically, into the local authority. */
  async synchronizeProject(localProjectRoot: string, slug: string): Promise<{ downloaded: number; bytesDownloaded: number }> {
    const root = path.resolve(localProjectRoot); const remoteRoot = safeRemotePath(slug); let downloaded = 0; let bytesDownloaded = 0;
    const visit = async (remoteFolder: string): Promise<void> => {
      for (const entry of await this.list(remoteFolder)) {
        const remote = safeRemotePath(`${remoteFolder}/${entry.name}`); const local = path.resolve(root, ...remote.slice(`${slug}/`.length).split("/"));
        if (!under(root, local)) throw new Error("Remote project entry escaped local project root.");
        if (entry.type === "dir") { await visit(remote); continue; }
        if (entry.type !== "file") continue;
        const localStat = await fs.stat(local).catch(() => null); const remoteHash = await this.hash(remote);
        const same = localStat?.isFile() && localStat.size === remoteHash?.size && await sha256(local) === remoteHash?.sha256;
        if (same) continue;
        // This is a deliberate recovery of an artifact generated by the selected remote backend.
        await this.download(remote, local, Boolean(localStat)); downloaded++; bytesDownloaded += entry.size;
      }
    };
    await visit(remoteRoot); return { downloaded, bytesDownloaded };
  }
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
