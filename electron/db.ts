import { app } from "electron";
import { mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DatabaseStatus = { configured: boolean; connected: boolean; message: string; storagePath?: string };
export type MachineSettings = {
  comfyUrl: string; videoModel: string; vae: string; directorLlm: string; contextLength: string;
  lora: string; loraStrength: number; steps: number; cfg: number; seedMode: "random" | "fixed";
  resolution: string; fps: number; outputFormat: string; dynamicLength: boolean; higherQuality: boolean;
  keepIntermediateOutputs: boolean;
  /** Optional rough sampler previews sent only to this local Martini Shot window. */
  livePreviews: boolean;
  /** Render-graph and post-workflow memory cleanup; disabling favors queue throughput over idle memory. */
  vramCleanup: boolean;
  ramCleanup: boolean;
  /** Clip render sampling (05-render-next-clip.json): KSamplerSelect sampler, BasicScheduler scheduler, and the
   *  MiniMaxH3SigmaShift video/audio shifts. Steps are per project (Direction). */
  renderSampler: string;
  renderScheduler: string;
  renderShiftVideo: number;
  renderShiftAudio: number;
  /** The running ComfyUI's output folder. Martini Shot projects live in <this>\martini_shot\<project-slug>. */
  comfyOutputDir: string;
  /** Retained only to safely migrate Ticket 08 settings; projects are always local. */
  comfyLocation?: "local" | "remote";
  fileApiToken?: string;
  remoteRenderingEnabled: boolean;
  /** Selected execution backend for all workflow stages. Project storage is always local. */
  executionDestination: "local" | "remote";
  remoteComfyUrl: string;
  remoteFileApiToken: string;
};
export type ComfyJob = {
  id: string; promptId: string | null; stage: string; status: string; report: string | null; error: string | null;
  cleanupStatus: string; submittedAt: string; completedAt: string | null;
};

const defaults = (): MachineSettings => ({
  comfyUrl: process.env.COMFYUI_URL || "http://127.0.0.1:8188", videoModel: "MiniMax H3 (Video)",
  vae: "MiniMax H3 VAE (recommended)", directorLlm: "Qwen3-VL 8B (vision) | qwen3vl_8b_fp8_scaled.safetensors", contextLength: "32768",
  lora: "", loraStrength: 1, steps: 30, cfg: 6, seedMode: "random", resolution: "1280 × 720 (720p)", fps: 24,
  outputFormat: "MP4 (H.264)", dynamicLength: true, higherQuality: false, keepIntermediateOutputs: false,
  livePreviews: false,
  vramCleanup: true,
  ramCleanup: true,
  renderSampler: "euler",
  renderScheduler: "simple",
  renderShiftVideo: 12,
  renderShiftAudio: 3,
  comfyOutputDir: process.env.COMFYUI_OUTPUT_DIR || String.raw`E:\LTX2-Install\ComfyUI_windows_portable\ComfyUI\output`,
  comfyLocation: "local",
  fileApiToken: "",
  remoteRenderingEnabled: false,
  executionDestination: "local",
  remoteComfyUrl: "",
  remoteFileApiToken: "",
});

let sqlite: DatabaseSync | undefined;
let migrated = false;

export function databasePath(): string {
  const root = process.env.MARTINI_SHOT_DATA_DIR || join(app.getPath("appData"), "Martini Shot");
  return join(root, "martini-shot.db");
}

function database(): DatabaseSync {
  if (sqlite) return sqlite;
  const filename = databasePath();
  mkdirSync(join(filename, ".."), { recursive: true });
  sqlite = new DatabaseSync(filename);
  sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  return sqlite;
}

const migrations = [{ id: "001_initial_schema", sql: `
  CREATE TABLE IF NOT EXISTS martini_projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'new', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS project_assets (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES martini_projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL, display_name TEXT NOT NULL, original_path TEXT NOT NULL, stored_path TEXT NOT NULL,
    checksum TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS director_runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES martini_projects(id) ON DELETE CASCADE,
    stage TEXT NOT NULL, seed INTEGER, settings TEXT NOT NULL DEFAULT '{}', report TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS location_requests (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES martini_projects(id) ON DELETE CASCADE,
    location_name TEXT NOT NULL, location_slug TEXT NOT NULL, section_numbers TEXT NOT NULL DEFAULT '[]',
    expected_path TEXT NOT NULL, mode TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, location_slug)
  );
  CREATE TABLE IF NOT EXISTS comfy_jobs (
    id TEXT PRIMARY KEY, project_id TEXT REFERENCES martini_projects(id) ON DELETE SET NULL, prompt_id TEXT,
    stage TEXT NOT NULL, status TEXT NOT NULL, report TEXT, error TEXT, cleanup_status TEXT NOT NULL DEFAULT 'not_requested',
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS render_clips (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES martini_projects(id) ON DELETE CASCADE,
    clip_index INTEGER NOT NULL, section_number INTEGER, output_path TEXT, transition TEXT, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, report TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id, clip_index)
  );
  CREATE TABLE IF NOT EXISTS project_reports (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES martini_projects(id) ON DELETE CASCADE,
    category TEXT NOT NULL, body TEXT NOT NULL, data TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
` }, { id: "002_projects_and_assets", sql: `
  ALTER TABLE martini_projects ADD COLUMN slug TEXT;
  ALTER TABLE martini_projects ADD COLUMN last_opened_at TEXT;
  ALTER TABLE martini_projects ADD COLUMN comfy_sync_status TEXT NOT NULL DEFAULT 'not_saved';
  ALTER TABLE martini_projects ADD COLUMN comfy_sync_error TEXT;
  ALTER TABLE martini_projects ADD COLUMN comfy_synced_at TEXT;
  ALTER TABLE martini_projects ADD COLUMN comfy_sync_job_id TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS martini_projects_slug ON martini_projects(slug);
  ALTER TABLE project_assets ADD COLUMN file_size INTEGER;
  ALTER TABLE project_assets ADD COLUMN duration_seconds REAL;
  ALTER TABLE project_assets ADD COLUMN updated_at TEXT;
  CREATE INDEX IF NOT EXISTS project_assets_order ON project_assets(project_id, role, sort_order);
` }, { id: "003_creative_direction_and_plan", sql: `
  CREATE TABLE IF NOT EXISTS project_direction (
    project_id TEXT PRIMARY KEY REFERENCES martini_projects(id) ON DELETE CASCADE,
    creative_brief TEXT NOT NULL DEFAULT '', story_wheel INTEGER NOT NULL DEFAULT 1, min_locations INTEGER NOT NULL DEFAULT 0,
    request_location_images INTEGER NOT NULL DEFAULT 1, motif_weight REAL NOT NULL DEFAULT 0, plan_seed INTEGER NOT NULL,
    updated_at TEXT
  );
  ALTER TABLE director_runs ADD COLUMN kind TEXT;
  ALTER TABLE director_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';
  ALTER TABLE director_runs ADD COLUMN comfy_job_id TEXT;
  ALTER TABLE director_runs ADD COLUMN cache_result TEXT;
  ALTER TABLE director_runs ADD COLUMN cache_details TEXT;
  ALTER TABLE director_runs ADD COLUMN story_changed INTEGER;
  ALTER TABLE director_runs ADD COLUMN result_seed INTEGER;
  ALTER TABLE director_runs ADD COLUMN plan_json TEXT;
  ALTER TABLE director_runs ADD COLUMN error TEXT;
  ALTER TABLE director_runs ADD COLUMN completed_at TEXT;
  CREATE INDEX IF NOT EXISTS director_runs_project ON director_runs(project_id, stage, created_at);
  ALTER TABLE martini_projects ADD COLUMN current_plan_run_id TEXT;
  ALTER TABLE project_reports ADD COLUMN run_id TEXT;
` }, { id: "004_location_requests", sql: `
  -- location_requests was created in 001 but never written; rebuild it with the columns Ticket 04 needs.
  DROP TABLE IF EXISTS location_requests;
  CREATE TABLE location_requests (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES martini_projects(id) ON DELETE CASCADE,
    plan_run_id TEXT NOT NULL, source TEXT NOT NULL, location_name TEXT NOT NULL, location_slug TEXT NOT NULL,
    section_numbers TEXT NOT NULL DEFAULT '[]', broll_sections TEXT NOT NULL DEFAULT '[]', file_name TEXT, expected_path TEXT NOT NULL,
    mode TEXT NOT NULL, reason TEXT, detail TEXT, checked_signature TEXT, check_run_id TEXT, checked_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_id, source, location_slug)
  );
  CREATE INDEX IF NOT EXISTS location_requests_plan ON location_requests(project_id, plan_run_id);
` }, { id: "005_production_and_render_queue", sql: `
  -- render_clips was created in 001 but never written; rebuild it per prompt package (director_runs stage 'prompt_package').
  DROP TABLE IF EXISTS render_clips;
  CREATE TABLE render_clips (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES martini_projects(id) ON DELETE CASCADE,
    package_run_id TEXT NOT NULL, clip_index INTEGER NOT NULL, shot_number INTEGER, section_number INTEGER,
    song_start REAL NOT NULL, song_end REAL NOT NULL, scene TEXT, location TEXT, outfit TEXT, action TEXT,
    transition TEXT, overlap_frames INTEGER NOT NULL DEFAULT 0, video_name TEXT NOT NULL, prompt_file TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'pending', output_path TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, last_attempt_id TEXT, error TEXT, rendered_at TEXT, updated_at TEXT NOT NULL,
    UNIQUE(package_run_id, clip_index)
  );
  CREATE INDEX render_clips_project ON render_clips(project_id, package_run_id, clip_index);
  CREATE TABLE render_queues (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES martini_projects(id) ON DELETE CASCADE,
    package_run_id TEXT NOT NULL, kind TEXT NOT NULL, requested INTEGER NOT NULL, target INTEGER NOT NULL,
    retry_clip INTEGER, completed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, stop_requested_at TEXT,
    message TEXT, created_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE INDEX render_queues_project ON render_queues(project_id, created_at);
  CREATE TABLE render_attempts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES martini_projects(id) ON DELETE CASCADE,
    package_run_id TEXT NOT NULL, queue_id TEXT, clip_index INTEGER NOT NULL, attempt INTEGER NOT NULL,
    loader_mode TEXT NOT NULL, noise_seed INTEGER NOT NULL, comfy_job_id TEXT, prompt_id TEXT, status TEXT NOT NULL,
    cleanup_status TEXT NOT NULL DEFAULT 'not_requested', cleanup TEXT, output_path TEXT, loader_report TEXT, error TEXT,
    started_at TEXT NOT NULL, submitted_at TEXT, rendered_at TEXT, finished_at TEXT
  );
  CREATE INDEX render_attempts_clip ON render_attempts(project_id, package_run_id, clip_index, started_at);
  ALTER TABLE martini_projects ADD COLUMN current_package_run_id TEXT;
` }, { id: "006_final_results", sql: `
  -- One row per Stitch final video attempt. Rows are never updated by later plans, packages, or re-renders, so earlier
  -- final videos and their reports stay available. Finalize Video never overwrites a file (final.mp4, final_2.mp4, …).
  CREATE TABLE final_results (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES martini_projects(id) ON DELETE CASCADE,
    package_run_id TEXT NOT NULL, plan_run_id TEXT, status TEXT NOT NULL, comfy_job_id TEXT, prompt_id TEXT,
    video_path TEXT, output_folder TEXT, file_size INTEGER, duration_seconds REAL, video_info TEXT, stitch_report TEXT,
    project_status TEXT, clip_summary TEXT, cleanup_status TEXT NOT NULL DEFAULT 'not_requested', cleanup TEXT,
    report_data TEXT, report_body TEXT, report_path TEXT, error TEXT,
    started_at TEXT NOT NULL, submitted_at TEXT, completed_at TEXT
  );
  CREATE INDEX final_results_project ON final_results(project_id, started_at);
` }, { id: "007_director_controls", sql: `
  ALTER TABLE project_direction ADD COLUMN production_settings TEXT NOT NULL DEFAULT '{}';
` }, { id: "008_remote_project_paths", sql: `
  -- Retired by Ticket 09. This no-op remains for databases that already recorded it.
` }, { id: "009_local_authority_remote_render_staging", sql: `
  ALTER TABLE render_attempts ADD COLUMN remote_endpoint TEXT;
  ALTER TABLE render_attempts ADD COLUMN staging_evidence TEXT;
` }];

/** Convert pre-ticket absolute paths below output/martini_shot into wire paths. */
function migrateRelativeProjectPaths(database: DatabaseSync): void {
  const row = database.prepare("SELECT value FROM app_settings WHERE key = 'machine_defaults'").get() as { value?: string } | undefined;
  let output = defaults().comfyOutputDir;
  try { output = (JSON.parse(row?.value || "{}") as Partial<MachineSettings>).comfyOutputDir || output; } catch { /* default */ }
  // Ticket 08 accidentally converted local-authoritative paths to wire paths. Only
  // repair rows that are still relative; never rewrite a valid absolute local path.
  const fields: Record<string, string[]> = {
    martini_projects: ["project_path"], project_assets: ["stored_path"], location_requests: ["expected_path"],
    render_clips: ["output_path"], render_attempts: ["output_path"], final_results: ["video_path", "output_folder", "report_path"],
  };
  for (const [table, columns] of Object.entries(fields)) for (const column of columns) {
    try {
      const rows = database.prepare(`SELECT rowid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all() as { rowid: number; value: unknown }[];
      const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
      for (const item of rows) {
        if (typeof item.value !== "string" || isAbsolute(item.value)) continue;
        const value = join(output, "martini_shot", item.value.replace(/[\\/]+/g, "\\"));
        update.run(value, item.rowid);
      }
    } catch { /* Older database schemas can lack these columns. */ }
  }
}

function migrate(): void {
  if (migrated) return;
  const db = database();
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const applied = new Set((db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]).map((row) => row.id));
  db.exec("BEGIN");
  try {
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
    }
    migrateRelativeProjectPaths(db);
    db.exec("COMMIT");
    migrated = true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** The migrated local database. Only Electron main modules call this; the renderer never sees SQL. */
export function db(): DatabaseSync {
  migrate();
  return database();
}

export async function databaseStatus(): Promise<DatabaseStatus> {
  try {
    migrate();
    return { configured: true, connected: true, message: "Local project database is ready.", storagePath: databasePath() };
  } catch (error) {
    return { configured: true, connected: false, message: error instanceof Error ? error.message : "Could not open the local project database.", storagePath: databasePath() };
  }
}

export async function getMachineSettings(): Promise<MachineSettings> {
  migrate();
  const row = database().prepare("SELECT value FROM app_settings WHERE key = 'machine_defaults'").get() as { value?: string } | undefined;
  let saved: Partial<MachineSettings> = {};
  try { saved = row?.value ? JSON.parse(row.value) as Partial<MachineSettings> : {}; } catch { /* A corrupt setting should not prevent the app opening. */ }
  return renderSampling({ ...defaults(), ...saved });
}

/** Keeps the render sampling settings usable: a blank name or an out-of-range shift falls back to the workflow default. */
function renderSampling(settings: MachineSettings): MachineSettings {
  const fallback = defaults();
  const name = (value: unknown, otherwise: string) => (typeof value === "string" && /^[A-Za-z0-9_.+-]{1,64}$/.test(value.trim()) ? value.trim() : otherwise);
  const shift = (value: unknown, otherwise: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value * 100) / 100 : otherwise);
  return {
    ...settings,
    renderSampler: name(settings.renderSampler, fallback.renderSampler), renderScheduler: name(settings.renderScheduler, fallback.renderScheduler),
    renderShiftVideo: shift(settings.renderShiftVideo, fallback.renderShiftVideo), renderShiftAudio: shift(settings.renderShiftAudio, fallback.renderShiftAudio),
  };
}

export async function saveMachineSettings(value: MachineSettings): Promise<MachineSettings> {
  migrate();
  const settings = renderSampling({ ...defaults(), ...value });
  database().prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('machine_defaults', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(JSON.stringify(settings), new Date().toISOString());
  return settings;
}

export async function createComfyJob(job: Omit<ComfyJob, "submittedAt" | "completedAt"> & { projectId?: string }): Promise<void> {
  migrate();
  database().prepare(`INSERT INTO comfy_jobs (id, project_id, prompt_id, stage, status, report, error, cleanup_status, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(job.id, job.projectId || null, job.promptId, job.stage, job.status, job.report, job.error, job.cleanupStatus, new Date().toISOString());
}

export async function updateComfyJob(id: string, update: Partial<Pick<ComfyJob, "promptId" | "status" | "report" | "error" | "cleanupStatus" | "completedAt">>): Promise<void> {
  migrate();
  const columnNames: Record<string, string> = { promptId: "prompt_id", cleanupStatus: "cleanup_status", completedAt: "completed_at" };
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined) continue;
    columns.push(`${columnNames[key] || key} = ?`);
    values.push(value);
  }
  if (!columns.length) return;
  values.push(id);
  database().prepare(`UPDATE comfy_jobs SET ${columns.join(", ")} WHERE id = ?`).run(...values as never[]);
}

export async function recentComfyJobs(limit = 20): Promise<ComfyJob[]> {
  migrate();
  return database().prepare(`SELECT id, prompt_id AS promptId, stage, status, report, error, cleanup_status AS cleanupStatus,
    submitted_at AS submittedAt, completed_at AS completedAt FROM comfy_jobs ORDER BY submitted_at DESC LIMIT ?`).all(limit) as ComfyJob[];
}

export async function closeDatabase(): Promise<void> {
  sqlite?.close();
  sqlite = undefined;
  migrated = false;
}
