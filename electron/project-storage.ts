/** Project files live below ComfyUI output/martini_shot.  Services use wire paths
 * (forward-slash relative paths) so the same code works for local and remote UI. */
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { getMachineSettings } from "./db";

export type StorageStat = { exists: boolean; type?: "file" | "dir"; size?: number; mtimeMs?: number };
export type StorageEntry = { name: string; type: "file" | "dir"; size: number; mtimeMs: number };
export type ProjectStorage = {
  readonly remote: boolean;
  stat(file: string): Promise<StorageStat>; exists(file: string): Promise<boolean>; list(folder: string): Promise<StorageEntry[]>;
  readText(file: string): Promise<string>; readBytes(file: string): Promise<Buffer>; readRange(file: string, start: number, length: number): Promise<Buffer>;
  hash(file: string): Promise<{ sha256: string; size: number; mtimeMs: number }>;
  writeBytes(file: string, data: Uint8Array, options?: { overwrite?: boolean }): Promise<void>;
  uploadFile(source: string, file: string, options?: { overwrite?: boolean }): Promise<void>;
  mkdir(folder: string): Promise<void>; move(from: string, to: string, options?: { overwrite?: boolean }): Promise<void>; remove(file: string): Promise<void>;
  downloadTo(file: string, destination: string): Promise<void>; mediaUrl(file: string): string;
  localPath?(file: string): string;
};

export function relativeProjectPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid Martini Shot project path.");
  return normalized;
}

export class LocalProjectStorage implements ProjectStorage {
  readonly remote = false;
  constructor(private readonly root: string) {}
  localPath(file: string): string { return path.join(this.root, ...relativeProjectPath(file).split("/")); }
  async stat(file: string): Promise<StorageStat> { try { const s = await fs.stat(this.localPath(file)); return { exists: true, type: s.isDirectory() ? "dir" : "file", size: s.size, mtimeMs: s.mtimeMs }; } catch { return { exists: false }; } }
  async exists(file: string): Promise<boolean> { return (await this.stat(file)).exists; }
  async list(folder: string): Promise<StorageEntry[]> { return (await fs.readdir(this.localPath(folder), { withFileTypes: true })).map(async (entry) => { const stat = await fs.stat(this.localPath(`${folder}/${entry.name}`)); return { name: entry.name, type: entry.isDirectory() ? "dir" as const : "file" as const, size: stat.size, mtimeMs: stat.mtimeMs }; }).reduce(async (all, value) => [...await all, await value], Promise.resolve([] as StorageEntry[])); }
  readText(file: string): Promise<string> { return fs.readFile(this.localPath(file), "utf8"); }
  readBytes(file: string): Promise<Buffer> { return fs.readFile(this.localPath(file)); }
  async readRange(file: string, start: number, length: number): Promise<Buffer> { const handle = await fs.open(this.localPath(file), "r"); try { const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, start); return buffer.subarray(0, bytesRead); } finally { await handle.close(); } }
  async hash(file: string) { const crypto = await import("node:crypto"); const data = await this.readBytes(file); const stat = await this.stat(file); return { sha256: crypto.createHash("sha256").update(data).digest("hex"), size: stat.size!, mtimeMs: stat.mtimeMs! }; }
  async writeBytes(file: string, data: Uint8Array, options: { overwrite?: boolean } = {}): Promise<void> { const target = this.localPath(file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data, { flag: options.overwrite ? "w" : "wx" }); }
  async uploadFile(source: string, file: string, options: { overwrite?: boolean } = {}): Promise<void> { await this.writeBytes(file, await fs.readFile(source), options); }
  mkdir(folder: string): Promise<void> { return fs.mkdir(this.localPath(folder), { recursive: true }).then(() => undefined); }
  remove(file: string): Promise<void> { return fs.rm(this.localPath(file), { force: true }); }
  async move(from: string, to: string, options: { overwrite?: boolean } = {}): Promise<void> { const dest = this.localPath(to); if (!options.overwrite && await this.exists(to)) throw new Error(`Project file already exists: ${to}`); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.rename(this.localPath(from), dest); }
  async downloadTo(file: string, destination: string): Promise<void> { await fs.copyFile(this.localPath(file), destination); }
  mediaUrl(file: string): string { return `martini-asset://file/${encodeURIComponent(relativeProjectPath(file))}`; }
}

function endpoint(value: string) { return new URL(value).toString().replace(/\/$/, ""); }
export class RemoteProjectStorage implements ProjectStorage {
  readonly remote = true;
  constructor(private readonly base: string, private readonly token = "") {}
  private async request(route: string, init: RequestInit = {}): Promise<Response> { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000); try { const headers = new Headers(init.headers); if (this.token) headers.set("X-Martini-Token", this.token); const response = await fetch(`${endpoint(this.base)}${route}`, { ...init, headers, signal: controller.signal, duplex: init.body ? "half" : undefined } as RequestInit); if (!response.ok) { let message = `File API returned HTTP ${response.status}.`; try { message = (await response.json() as { error?: string }).error || message; } catch { /* no JSON */ } throw new Error(response.status === 403 ? `ComfyUI file API rejected the request: wrong or missing token. ${message}` : message); } return response; } finally { clearTimeout(timer); } }
  private query(file: string) { return `?path=${encodeURIComponent(relativeProjectPath(file))}`; }
  async stat(file: string): Promise<StorageStat> { const response = await this.request(`/martini/fs/stat${this.query(file)}`); const value = await response.json() as { exists: boolean; type?: "file" | "dir"; size?: number; mtime_ms?: number }; return { exists: value.exists, type: value.type, size: value.size, mtimeMs: value.mtime_ms }; }
  async exists(file: string) { return (await this.stat(file)).exists; }
  async list(folder: string): Promise<StorageEntry[]> { const response = await this.request(`/martini/fs/list${this.query(folder)}`); const value = await response.json() as { entries: Array<{ name: string; type: "file" | "dir"; size: number; mtime_ms: number }> }; return value.entries.map((entry) => ({ ...entry, mtimeMs: entry.mtime_ms })); }
  async readBytes(file: string): Promise<Buffer> { return Buffer.from(await (await this.request(`/martini/fs/file${this.query(file)}`)).arrayBuffer()); }
  async readText(file: string) { return (await this.request(`/martini/fs/file${this.query(file)}`)).text(); }
  async readRange(file: string, start: number, length: number) { return Buffer.from(await (await this.request(`/martini/fs/file${this.query(file)}`, { headers: { Range: `bytes=${start}-${start + length - 1}` } })).arrayBuffer()); }
  async hash(file: string) { const value = await (await this.request(`/martini/fs/hash${this.query(file)}`)).json() as { sha256: string; size: number; mtime_ms: number }; return { sha256: value.sha256, size: value.size, mtimeMs: value.mtime_ms }; }
  async writeBytes(file: string, data: Uint8Array, options: { overwrite?: boolean } = {}) { await this.request(`/martini/fs/file${this.query(file)}&overwrite=${options.overwrite ? "1" : "0"}`, { method: "PUT", body: Buffer.from(data) }); }
  async uploadFile(source: string, file: string, options: { overwrite?: boolean } = {}) { await this.request(`/martini/fs/file${this.query(file)}&overwrite=${options.overwrite ? "1" : "0"}`, { method: "PUT", body: Readable.toWeb(createReadStream(source)) as BodyInit }); }
  async mkdir(folder: string) { await this.request("/martini/fs/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: folder ? relativeProjectPath(folder) : "" }) }); }
  async move(from: string, to: string, options: { overwrite?: boolean } = {}) { await this.request("/martini/fs/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: relativeProjectPath(from), to: relativeProjectPath(to), overwrite: Boolean(options.overwrite) }) }); }
  async remove(file: string) { await this.request("/martini/fs/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: relativeProjectPath(file) }) }); }
  async downloadTo(file: string, destination: string) { await fs.writeFile(destination, await this.readBytes(file)); }
  mediaUrl(file: string): string { return `martini-asset://file/${encodeURIComponent(relativeProjectPath(file))}`; }
  async proxy(file: string, range?: string): Promise<Response> { return this.request(`/martini/fs/file${this.query(file)}`, { headers: range ? { Range: range } : {} }); }
}

let cached: ProjectStorage | null = null; let key = "";
export async function projectStorage(): Promise<ProjectStorage> { const settings = await getMachineSettings(); const next = `${settings.comfyLocation}|${settings.comfyUrl}|${settings.fileApiToken}|${settings.comfyOutputDir}`; if (cached && key === next) return cached; key = next; cached = settings.comfyLocation === "remote" ? new RemoteProjectStorage(settings.comfyUrl, settings.fileApiToken) : new LocalProjectStorage(path.join(settings.comfyOutputDir, "martini_shot")); return cached; }
export function clearProjectStorageCache() { cached = null; key = ""; }
