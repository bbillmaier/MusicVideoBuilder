import { randomUUID } from "node:crypto";
import { createComfyJob, db, getMachineSettings, type ComfyJob, updateComfyJob } from "./db";
import { RemoteRenderStaging } from "./remote-render-staging";
import { applyTemplateValues, loadWorkflowTemplate, type WorkflowTemplate } from "./workflow-template";

export type ComfyStatus = { connected: boolean; endpoint: string; message: string; system?: unknown };
/** `messages` is ComfyUI's history status message list (execution_start, execution_cached, …) for evidence checks. */
export type WorkflowRun = { job: ComfyJob; outputs: unknown; messages: unknown[]; cleanup: CleanupEvidence };
export type WorkflowProgress = { phase: "queued" | "running" | "cleanup"; queuePosition?: number; step?: StepProgress };
/** What ComfyUI's WebSocket says it is doing: the executing node and, for nodes that report it, step x of y. */
export type StepProgress = { node: string; label: string; value: number | null; max: number | null };
/** One live sampler preview from Martini Shot's preview node (base64 image data). */
export type PreviewFrame = { image: string; mime: string; step: number; total: number; frames: number };

/** Plain-language names for the nodes a Martini Shot workflow spends its time in. */
function nodeLabel(classType: string, title?: string): string {
  if (/LoadRenderClip/.test(classType)) return "Loading the clip and references";
  if (/Revise|PromptPackage|Director/.test(classType)) return "Writing prompts with the LLM";
  if (/Cleanup|Clean|RAMClean|VRAM/i.test(classType)) return "Freeing memory";
  if (/Loader|Load(?!.*Clip)/.test(classType)) return "Loading models";
  if (/TextEncode|Encode(?!.*VAE)/i.test(classType)) return "Encoding the prompt";
  if (/Sampler|KSampler/.test(classType)) return "Sampling";
  if (/VAEDecode|Decode/.test(classType)) return "Decoding frames";
  if (/Upscale/i.test(classType)) return "Upscaling";
  if (/SaveVideo|CreateVideo|VHS_VideoCombine/.test(classType)) return "Saving the video";
  return title || classType.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Listens on ComfyUI's /ws for one client ID. ComfyUI sends `executing` and `progress` events only to the client that
 *  submitted the prompt, so this works the same for the local install and a remote worker. Best effort: if the socket
 *  cannot connect (old runtime, a proxy without WebSocket support), the caller keeps its /queue polling. */
function watchSteps(endpoint: string, clientId: string, prompt: Record<string, unknown>, onStep: (step: StepProgress) => void,
  onPreview?: (frame: PreviewFrame) => void): () => void {
  const Socket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!Socket) return () => undefined;
  const url = new URL(endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = `clientId=${encodeURIComponent(clientId)}`;
  let socket: WebSocket;
  try { socket = new Socket(url); } catch { return () => undefined; }
  const label = (node: string) => {
    const entry = prompt[node] as { class_type?: string; _meta?: { title?: string } } | undefined;
    return entry?.class_type ? nodeLabel(entry.class_type, entry._meta?.title) : `Node ${node}`;
  };
  let node = "";
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return; // binary frames are ComfyUI's own image previews
    try {
      const packet = JSON.parse(event.data) as { type?: string; data?: { node?: unknown; value?: unknown; max?: unknown; image?: unknown; mime?: unknown; step?: unknown; total?: unknown; frames?: unknown } };
      const data = packet.data ?? {};
      if (packet.type === "martini_preview") {
        // Martini Shot's live-preview node: a sampler preview image with its step
        if (typeof data.image === "string" && typeof data.mime === "string" && /^image\/(jpeg|webp|png)$/.test(data.mime)) {
          onPreview?.({ image: data.image, mime: data.mime, step: Number(data.step) || 0, total: Number(data.total) || 0, frames: Number(data.frames) || 1 });
        }
      } else if (packet.type === "executing" && typeof data.node === "string") {
        node = data.node;
        onStep({ node, label: label(node), value: null, max: null });
      } else if (packet.type === "progress" && Number.isFinite(Number(data.value)) && Number(data.max) > 0) {
        if (typeof data.node === "string") node = data.node;
        onStep({ node, label: label(node), value: Number(data.value), max: Number(data.max) });
      }
    } catch { /* not a JSON status event */ }
  };
  socket.onerror = () => undefined;
  return () => { try { socket.close(); } catch { /* already closed */ } };
}
/** What Martini Shot actually observed about a POST /free cleanup. It never proves memory was physically released. */
export type CleanupEvidence = {
  status: "accepted" | "completed" | "failed" | "skipped";
  /** ComfyUI answered POST /free with HTTP 200. */
  acceptedAt: string | null;
  /** ComfyUI's queue was idle afterwards and /system_stats answered, so its worker has had its cleanup cycle. */
  completedAt: string | null;
  /** Free VRAM ComfyUI reported before and after, in bytes, when it reports it. Evidence only. */
  vramFreeBefore: number | null;
  vramFreeAfter: number | null;
  error: string | null;
};
export type WorkflowOptions = {
  /** Lets the caller know the comfy_jobs row ID up front, so it can link the job before it finishes. */
  jobId?: string;
  onProgress?(progress: WorkflowProgress): void;
  /** Called with the ComfyUI prompt ID as soon as ComfyUI accepts the workflow. */
  onSubmitted?(promptId: string): void;
  /** Called when /free is accepted and again when its cycle completes (or fails). */
  onCleanup?(evidence: CleanupEvidence): void;
  /** Long renders: keep waiting for as long as ComfyUI still lists the prompt as queued or running, instead of a fixed deadline. */
  waitWhileQueued?: boolean;
  /** ComfyUI WebSocket client that receives live preview events for this one workflow. */
  clientId?: string;
  /** Live sampler previews from Martini Shot's preview node, relayed from this run's WebSocket. */
  onPreview?(frame: PreviewFrame): void;
  /** Explicit worker selection. Omitted always means the configured local ComfyUI. */
  endpoint?: string;
};

/** A workflow that ComfyUI accepted but that failed (or whose cleanup failed). Keeps whatever ComfyUI reported for diagnostics.
 *  `completed` is true when the workflow itself succeeded and only the cleanup failed. */
export class ComfyWorkflowError extends Error {
  constructor(message: string, readonly promptId: string | null, readonly outputs: unknown, readonly messages: unknown[],
    readonly cleanup: CleanupEvidence | null, readonly completed: boolean) {
    super(message);
    this.name = "ComfyWorkflowError";
  }
}

// One ComfyUI job at a time across the whole app: project saves, planning, and (later) renders share this queue.
let comfyWork: Promise<unknown> = Promise.resolve();
export function serializeComfyWork<T>(work: () => Promise<T>): Promise<T> {
  const next = comfyWork.then(work, work);
  comfyWork = next.catch(() => undefined);
  return next;
}

export function comfyEndpoint(value: string, location: "local" | "remote" = "local"): string {
  const url = new URL(value);
  if (location === "local" && !new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname)) throw new Error("This PC mode only connects to a local ComfyUI endpoint.");
  return url.toString().replace(/\/$/, "");
}
/** Browser WebSocket address for a validated HTTP(S) ComfyUI endpoint. */
export function comfyWebSocketEndpoint(value: string): string { const url = new URL(value); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; return url.toString().replace(/\/$/, ""); }
/** Backwards compatible name for callers that mean This PC. */
export const localEndpoint = (value: string) => comfyEndpoint(value, "local");

async function request(endpoint: string, route: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try { return await fetch(`${endpoint}${route}`, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

export async function comfyStatus(url?: string): Promise<ComfyStatus> {
  let endpoint = url || "http://127.0.0.1:8188";
  try {
    let configuredUrl = url;
    if (!configuredUrl) {
      try { configuredUrl = (await getMachineSettings()).comfyUrl; }
      catch { configuredUrl = process.env.COMFYUI_URL || "http://127.0.0.1:8188"; }
    }
    const settings = await getMachineSettings();
    const selectedRemote = !url && settings.executionDestination === "remote";
    endpoint = comfyEndpoint(selectedRemote ? settings.remoteComfyUrl : configuredUrl, selectedRemote ? "remote" : "local");
    const response = await request(endpoint, "/system_stats");
    if (!response.ok) throw new Error(`ComfyUI returned HTTP ${response.status}.`);
    if (selectedRemote) {
      const info = await request(endpoint, "/martini/fs/info", { headers: { "X-Martini-Token": settings.remoteFileApiToken } });
      if (!info.ok) throw new Error(info.status === 403 ? "Remote Martini Shot file API rejected the request: wrong or missing token." : "Remote ComfyUI does not expose the Martini Shot file API.");
      const body = await info.json() as { api?: unknown; token_required?: unknown };
      const api = body.api;
      if (typeof api !== "number" || api > 1) throw new Error("Remote ComfyUI has a newer incompatible Martini Shot file API.");
      if (body.token_required === true && !settings.remoteFileApiToken) throw new Error("Remote ComfyUI requires a Martini Shot file API token.");
    }
    return { connected: true, endpoint, message: selectedRemote ? "Remote ComfyUI worker is connected." : "ComfyUI is connected locally.", system: await response.json() };
  } catch (error) {
    return { connected: false, endpoint, message: error instanceof Error ? error.message : "ComfyUI is unavailable." };
  }
}

type NodeErrors = Record<string, { class_type?: string; errors?: Array<{ message?: string; details?: string }> }>;

async function submitPrompt(endpoint: string, prompt: Record<string, unknown>, clientId?: string): Promise<string> {
  const response = await request(endpoint, "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, client_id: clientId || randomUUID() }) });
  const body = await response.json() as { prompt_id?: string; error?: { message?: string }; node_errors?: NodeErrors };
  if (!response.ok || !body.prompt_id) {
    const details = Object.entries(body.node_errors || {}).flatMap(([id, node]) =>
      (node.errors || []).map((error) => `${node.class_type || id}: ${[error.message, error.details].filter(Boolean).join(" — ")}`));
    throw new Error([body.error?.message || `ComfyUI rejected the workflow (HTTP ${response.status}).`, ...details].join("\n"));
  }
  return body.prompt_id;
}

/** Confirms every node type in the prompt is loaded, so a missing node pack gets a readable message. */
async function checkNodeTypes(endpoint: string, prompt: Record<string, unknown>): Promise<void> {
  const classTypes = [...new Set(Object.values(prompt).map((node) => (node as { class_type?: string }).class_type).filter((value): value is string => Boolean(value)))];
  const missing: string[] = [];
  for (const classType of classTypes) {
    const response = await request(endpoint, `/object_info/${encodeURIComponent(classType)}`);
    if (!response.ok) throw new Error(`Could not read ComfyUI node information (HTTP ${response.status}).`);
    const info = await response.json() as Record<string, unknown>;
    if (!info[classType]) missing.push(classType);
  }
  if (missing.length) {
    const martini = missing.some((name) => name.startsWith("MartiniShot"));
    throw new Error(`ComfyUI is running but does not have these nodes loaded: ${missing.join(", ")}. ` +
      (martini ? "If the MartiniShot node pack was installed after ComfyUI started, restart ComfyUI so it loads custom_nodes\\MartiniShot." : "Install or enable the node pack that provides them, then restart ComfyUI."));
  }
}

type HistoryItem = { status?: { status_str?: string; messages?: unknown[] }; outputs?: unknown };

/** Prompt IDs ComfyUI currently lists as running or pending (any client). */
export async function comfyQueueIds(endpointOverride?: string): Promise<{ running: string[]; pending: string[] }> {
  const settings = await getMachineSettings();
  const endpoint = endpointOverride ? comfyEndpoint(endpointOverride, "remote") : comfyEndpoint(settings.comfyUrl, "local");
  const response = await request(endpoint, "/queue");
  if (!response.ok) throw new Error(`Could not read the ComfyUI queue (HTTP ${response.status}).`);
  const queue = await response.json() as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
  return { running: (queue.queue_running || []).map((item) => String(item[1])), pending: (queue.queue_pending || []).map((item) => String(item[1])) };
}

/** ComfyUI's record of one prompt, or null when it has no history for it. */
export async function comfyHistory(promptId: string, endpointOverride?: string): Promise<{ status: "success" | "error" | "unknown"; outputs: unknown; messages: unknown[] } | null> {
  const endpoint = endpointOverride ? comfyEndpoint(endpointOverride, "remote") : localEndpoint((await getMachineSettings()).comfyUrl);
  const response = await request(endpoint, `/history/${encodeURIComponent(promptId)}`);
  if (!response.ok) throw new Error(`Could not read ComfyUI history (HTTP ${response.status}).`);
  const item = (await response.json() as Record<string, HistoryItem>)[promptId];
  if (!item) return null;
  const status = item.status?.status_str === "success" ? "success" : item.status?.status_str === "error" ? "error" : "unknown";
  return { status, outputs: item.outputs || {}, messages: item.status?.messages || [] };
}

/** Turns ComfyUI's history error messages into one readable line (node type + exception), keeping the raw text otherwise. */
export function historyError(messages: unknown[] | undefined): string {
  for (const message of messages || []) {
    if (!Array.isArray(message)) continue;
    const [kind, data] = message as [string, Record<string, unknown> | undefined];
    if (kind === "execution_error") {
      const node = String(data?.node_type || data?.node_id || "a node");
      return `ComfyUI stopped at ${node}: ${String(data?.exception_message || "unknown error").trim()}`;
    }
    if (kind === "execution_interrupted") return "The run was cancelled in ComfyUI before it finished.";
  }
  return JSON.stringify(messages || "ComfyUI workflow failed.");
}

async function queuePosition(endpoint: string, promptId: string): Promise<WorkflowProgress | null> {
  try {
    const response = await request(endpoint, "/queue");
    if (!response.ok) return null;
    const queue = await response.json() as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    if ((queue.queue_running || []).some((item) => item[1] === promptId)) return { phase: "running" };
    const pending = (queue.queue_pending || []).map((item) => item[1]);
    const index = pending.indexOf(promptId);
    return index >= 0 ? { phase: "queued", queuePosition: index + 1 + (queue.queue_running?.length || 0) } : null;
  } catch { return null; }
}

async function waitForPrompt(endpoint: string, promptId: string, onProgress?: (progress: WorkflowProgress) => void,
  waitWhileQueued = false): Promise<{ outputs: unknown; messages: unknown[] }> {
  const deadline = Date.now() + 30 * 60 * 1000;
  let last = "";
  let unseen = 0;
  while (waitWhileQueued || Date.now() < deadline) {
    const response = await request(endpoint, `/history/${encodeURIComponent(promptId)}`);
    if (!response.ok) throw new Error(`Could not read ComfyUI history (HTTP ${response.status}).`);
    const history = await response.json() as Record<string, HistoryItem>;
    const item = history[promptId];
    if (item?.status?.status_str === "success") return { outputs: item.outputs || {}, messages: item.status.messages || [] };
    if (item?.status?.status_str === "error") {
      throw new ComfyWorkflowError(historyError(item.status.messages), promptId, item.outputs || {}, item.status.messages || [], null, false);
    }
    if (onProgress || waitWhileQueued) {
      const progress = await queuePosition(endpoint, promptId);
      const key = JSON.stringify(progress);
      if (progress && key !== last) { last = key; onProgress?.(progress); }
      // Neither queued, running, nor in history for ~30 s: ComfyUI was restarted or its queue was cleared.
      if (waitWhileQueued) {
        unseen = progress || item ? 0 : unseen + 1;
        if (unseen >= 40) throw new Error("ComfyUI no longer lists this job (it may have been restarted or its queue cleared).");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("Timed out waiting for ComfyUI workflow completion.");
}

/** The choices ComfyUI offers for one combo input of a loaded node (e.g. the Prompt LLM Loader's model list). */
export async function nodeInputOptions(classType: string, input: string): Promise<string[]> {
  const settings = await getMachineSettings();
  const endpoint = settings.executionDestination === "remote" ? comfyEndpoint(settings.remoteComfyUrl, "remote") : localEndpoint(settings.comfyUrl);
  const response = await request(endpoint, `/object_info/${encodeURIComponent(classType)}`);
  if (!response.ok) throw new Error(`Could not read ComfyUI node information (HTTP ${response.status}).`);
  const info = await response.json() as Record<string, { input?: { required?: Record<string, unknown[]> } }>;
  const spec = info[classType]?.input?.required?.[input];
  if (!info[classType]) throw new Error(`ComfyUI does not have the ${classType} node loaded.`);
  return Array.isArray(spec?.[0]) ? (spec[0] as unknown[]).map(String) : [];
}

function vramFree(stats: unknown): number | null {
  const devices = (stats as { devices?: Array<{ vram_free?: unknown }> } | null)?.devices;
  const value = Array.isArray(devices) ? devices[0]?.vram_free : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** POST /free with unload + free-memory flags, then waits for ComfyUI's worker to be idle and responsive again.
 *  ComfyUI applies the flags in its prompt-worker loop once nothing is running, so "completed" means that cycle has had its
 *  chance to run; it does not prove that physical VRAM/RAM was returned to the system. */
async function releaseMemory(endpoint: string, onCleanup?: (evidence: CleanupEvidence) => void): Promise<CleanupEvidence> {
  const evidence: CleanupEvidence = { status: "failed", acceptedAt: null, completedAt: null, vramFreeBefore: null, vramFreeAfter: null, error: null };
  try {
    try {
      const before = await request(endpoint, "/system_stats");
      if (before.ok) evidence.vramFreeBefore = vramFree(await before.json());
    } catch { /* Evidence only. */ }
    const response = await request(endpoint, "/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
    if (!response.ok) throw new Error(`ComfyUI rejected cleanup (HTTP ${response.status}).`);
    evidence.status = "accepted";
    evidence.acceptedAt = new Date().toISOString();
    onCleanup?.({ ...evidence });
    const deadline = Date.now() + 120_000;
    for (;;) {
      const queue = await request(endpoint, "/queue");
      if (!queue.ok) throw new Error(`Could not read the ComfyUI queue after cleanup (HTTP ${queue.status}).`);
      const body = await queue.json() as { queue_running?: unknown[] };
      if (!(body.queue_running || []).length) break;
      if (Date.now() > deadline) throw new Error("ComfyUI accepted cleanup but stayed busy with another job for over two minutes.");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const health = await request(endpoint, "/system_stats");
    if (!health.ok) throw new Error("ComfyUI did not return to a responsive state after cleanup.");
    evidence.vramFreeAfter = vramFree(await health.json());
    evidence.status = "completed";
    evidence.completedAt = new Date().toISOString();
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error instanceof Error ? error.message : String(error);
  }
  onCleanup?.({ ...evidence });
  return evidence;
}

function skippedCleanup(): CleanupEvidence {
  return { status: "skipped", acceptedAt: null, completedAt: null, vramFreeBefore: null, vramFreeAfter: null, error: "VRAM cleanup is disabled in Settings." };
}

export async function runWorkflowTemplate(isDevelopment: boolean, name: string, values: Record<string, unknown>, projectId?: string,
  build?: (template: WorkflowTemplate) => Record<string, unknown>, options: WorkflowOptions = {}): Promise<WorkflowRun> {
  const settings = await getMachineSettings();
  const remote = !options.endpoint && settings.executionDestination === "remote" && Boolean(projectId);
  const endpoint = options.endpoint ? comfyEndpoint(options.endpoint, "remote") : remote ? comfyEndpoint(settings.remoteComfyUrl, "remote") : comfyEndpoint(settings.comfyUrl, "local");
  let staging: RemoteRenderStaging | null = null;
  if (remote) {
    const stagedProjectId = projectId!;
    const row = db().prepare("SELECT slug, project_path FROM martini_projects WHERE id = ?").get(stagedProjectId) as { slug?: string; project_path?: string } | undefined;
    if (!row?.slug || !row.project_path) throw new Error("The local project record is unavailable for remote staging.");
    staging = new RemoteRenderStaging(endpoint, settings.remoteFileApiToken);
    await staging.checkConnection();
    const evidence = await staging.stageProject(row.project_path, row.slug);
    // Staging diagnostics stay local and never include the token.
    db().prepare("INSERT INTO project_reports (id, project_id, category, body, data, created_at) VALUES (?, ?, 'remote_staging', ?, ?, ?)")
      .run(randomUUID(), stagedProjectId, `${name}: ${evidence.uploaded} uploaded, ${evidence.skipped} unchanged.`, JSON.stringify(evidence), new Date().toISOString());
  }
  const template = await loadWorkflowTemplate(isDevelopment, name);
  const job: ComfyJob = { id: options.jobId || randomUUID(), promptId: null, stage: template.stage, status: "queued", report: null, error: null, cleanupStatus: "not_requested", submittedAt: new Date().toISOString(), completedAt: null };
  await createComfyJob({ ...job, projectId });
  let promptId: string | null = null;
  const onCleanup = (evidence: CleanupEvidence) => {
    void updateComfyJob(job.id, { cleanupStatus: evidence.status === "completed" ? "cleaned" : evidence.status });
    options.onCleanup?.(evidence);
  };
  let result: { outputs: unknown; messages: unknown[] };
  let stopWatching = () => undefined as void;
  try {
    const prompt = build ? build(template) : applyTemplateValues(template.prompt, { ...settings, ...values }) as Record<string, unknown>;
    await checkNodeTypes(endpoint, prompt);
    // One client ID per run: it receives this prompt's step events (and, for renders, the live previews).
    const clientId = options.clientId || randomUUID();
    // This is the only socket for the client ID: ComfyUI keeps one connection per ID, so a second one (e.g. the
    // renderer's) would replace it. Live previews are therefore relayed from here, not read by the renderer directly.
    if (options.onProgress || options.onPreview) {
      stopWatching = watchSteps(endpoint, clientId, prompt, (step) => options.onProgress?.({ phase: "running", step }), options.onPreview);
    }
    promptId = await submitPrompt(endpoint, prompt, clientId);
    await updateComfyJob(job.id, { promptId, status: "running" });
    options.onSubmitted?.(promptId);
    result = await waitForPrompt(endpoint, promptId, options.onProgress, options.waitWhileQueued);
    stopWatching();
    if (staging) {
      const stagedProjectId = projectId!;
      const row = db().prepare("SELECT slug, project_path FROM martini_projects WHERE id = ?").get(stagedProjectId) as { slug: string; project_path: string };
      const recovered = await staging.synchronizeProject(row.project_path, row.slug);
      db().prepare("INSERT INTO project_reports (id, project_id, category, body, data, created_at) VALUES (?, ?, 'remote_recovery', ?, ?, ?)")
        .run(randomUUID(), stagedProjectId, `${name}: downloaded ${recovered.downloaded} changed remote artifact(s).`, JSON.stringify({ endpoint, ...recovered }), new Date().toISOString());
    }
  } catch (error) {
    stopWatching();
    const message = error instanceof Error ? error.message : "ComfyUI workflow failed.";
    // Nothing reached ComfyUI if there is no prompt ID (bad values, missing nodes, rejected validation), so there is nothing to free.
    await updateComfyJob(job.id, { promptId: promptId || undefined, status: "failed", error: message, completedAt: new Date().toISOString(), cleanupStatus: promptId ? "pending" : "not_requested" });
    let cleanup: CleanupEvidence | null = null;
    if (promptId) {
      options.onProgress?.({ phase: "cleanup" });
      cleanup = settings.vramCleanup ? await releaseMemory(endpoint, onCleanup) : skippedCleanup();
      if (!settings.vramCleanup) onCleanup(cleanup);
    }
    const partial = error instanceof ComfyWorkflowError ? error : null;
    throw new ComfyWorkflowError(message, promptId, partial?.outputs ?? null, partial?.messages ?? [], cleanup, false);
  }
  const completedAt = new Date().toISOString();
  await updateComfyJob(job.id, { status: "complete", report: JSON.stringify(result.outputs), completedAt, cleanupStatus: "pending" });
  options.onProgress?.({ phase: "cleanup" });
  const cleanup = settings.vramCleanup ? await releaseMemory(endpoint, onCleanup) : skippedCleanup();
  if (!settings.vramCleanup) onCleanup(cleanup);
  if (cleanup.status !== "completed" && cleanup.status !== "skipped") {
    // The workflow itself finished; only the cleanup could not be confirmed. Callers decide whether to continue.
    throw new ComfyWorkflowError(`The workflow finished, but ComfyUI cleanup did not complete: ${cleanup.error}`, promptId, result.outputs, result.messages, cleanup, true);
  }
  return { job: { ...job, promptId, status: "complete", report: JSON.stringify(result.outputs), cleanupStatus: "cleaned", completedAt }, outputs: result.outputs, messages: result.messages, cleanup };
}

/** A standalone POST /free cycle (e.g. after recovering a render that finished while Martini Shot was closed). */
export async function freeComfyMemory(endpointOverride?: string): Promise<CleanupEvidence> {
  const settings = await getMachineSettings();
  if (!settings.vramCleanup) return skippedCleanup();
  return releaseMemory(endpointOverride ? comfyEndpoint(endpointOverride, "remote") : comfyEndpoint(settings.comfyUrl, "local"));
}
