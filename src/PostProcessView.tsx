import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { formatTime, formatWhen, readableError } from "./ProjectsView";
import { Button, Disclosure, Icon, IconButton, LoadingPage, NoProject, Notice, PanelHead, Pill, Slider, Switch, cx, type Tone } from "./ui";

type Nav = "Projects" | "Produce" | "Results" | "Settings";
type Props = { project: ProjectDetail | null; comfy?: ComfyStatus; onNavigate(view: Nav): void };

const FACE_MODES: Array<{ value: PostSettings["faceMode"]; label: string; text: string }> = [
  { value: "preserve", label: "Preserve", text: "No face processing. Keeps singing mouth shapes and expression exactly as rendered." },
  { value: "restore", label: "Restore", text: "CodeFormer only (ReActor's restore node). For a soft face whose identity and shape are already right." },
  { value: "replace", label: "Replace", text: "ReActor swaps in the character reference, optionally with its built-in CodeFormer. For damaged or inconsistent faces." },
];
const VRAM_LABEL: Record<PostSettings["vramMode"], string> = { worker_default: "Worker default", low_vram: "Low VRAM", high_vram: "High VRAM" };
const STATE_TONE: Record<PostClip["state"], Tone> = {
  not_requested: "muted", needs_processing: "warn", queued: "queued", running: "working", done: "ok", needs_review: "warn", failed: "error",
  canceled: "muted", stale: "warn", bypassed: "info", not_rendered: "muted",
};
const EDGES = [720, 1080, 1440, 2160] as const;
const DLSS5_STYLES = ["Default", "Natural", "Cinematic"] as const;
const DLSS5_SCALES = [1, 1.5, 2, 3, 4] as const;
const DLSS5_FPS = [0, 30, 48, 60, 72, 96, 120] as const;
const BATCHES = [5, 9, 13, 17, 21, 25, 33];

function outSize(source: { width: number; height: number } | null, edge: number): string {
  if (!source) return `${edge}p shortest edge`;
  const scale = edge / Math.min(source.width, source.height);
  const even = (value: number) => Math.max(2, 2 * Math.round(value / 2));
  return `${even(source.width * scale)}×${even(source.height * scale)}`;
}
function outScaled(source: { width: number; height: number } | null, scale: number): string {
  return source ? `${Math.round(source.width * scale)}×${Math.round(source.height * scale)}` : `${scale}× the clip size`;
}
const ranges = (list: number[][]) => list.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");

function usePost(projectId: string, connected: boolean | undefined) {
  const [overview, setOverview] = useState<PostProcessOverview>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setOverview(await window.martini.post.overview(projectId)); setError(""); }
    catch (reason) { setError(readableError(reason)); }
  }, [projectId]);
  useEffect(() => {
    void refresh();
    const onChange = (changed: string) => { if (changed === projectId) void refresh(); };
    const offs = [window.martini.post.onChanged(onChange), window.martini.produce.onChanged(onChange), window.martini.projects.onChanged(onChange)];
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { offs.forEach((off) => off()); window.removeEventListener("focus", onFocus); };
  }, [projectId, refresh]);
  useEffect(() => { void refresh(); }, [connected, refresh]);
  return { overview, setOverview, error, setError, refresh };
}

export function PostProcessView({ project, comfy, onNavigate }: Props) {
  if (!project) return <NoProject text="Open a project and render its clips. Face treatment and upscaling for each clip happen here, before the final stitch." onProjects={() => onNavigate("Projects")} />;
  return <PostContent key={project.id} project={project} comfy={comfy} onNavigate={onNavigate} />;
}

function PostContent({ project, comfy, onNavigate }: { project: ProjectDetail; comfy?: ComfyStatus; onNavigate(view: Nav): void }) {
  const { overview, setOverview, error, setError } = usePost(project.id, comfy?.connected);
  const [current, setCurrent] = useState<number | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [pending, setPending] = useState(false);
  const act = async (work: () => Promise<PostProcessOverview>) => {
    setPending(true);
    try { setOverview(await work()); setError(""); } catch (reason) { setError(readableError(reason)); } finally { setPending(false); }
  };
  useEffect(() => {
    if (overview && (current === null || !overview.clips.some((clip) => clip.index === current))) setCurrent(overview.clips.find((clip) => clip.rendered)?.index ?? overview.clips[0]?.index ?? null);
  }, [overview, current]);

  if (!overview) return error ? <div className="page"><Notice tone="error" title="Post-processing could not be loaded" live>{error}</Notice></div> : <LoadingPage text="Reading the rendered clips…" />;
  const clip = overview.clips.find((item) => item.index === current) ?? null;
  const worker = overview.worker;
  const busyQueue = overview.queue.active;
  const pendingCount = overview.clips.filter((item) => item.rendered && ["needs_processing", "failed", "canceled", "stale"].includes(item.state)).length;
  const toggle = (index: number) => setChecked((set) => { const next = new Set(set); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  const ortCpu = worker?.ortSessionProviders && worker.ortSessionProviders[0] !== "CUDAExecutionProvider";

  return <div className="page post-page">
    <header className="page-head">
      <div className="page-title">
        <span className="page-icon" aria-hidden><Icon.postprocess size={22} /></span>
        <div className="page-title-text">
          <h1>Post-processing</h1>
          <p className="crumb">Optional face treatment and SeedVR2 upscaling per clip. Original renders are never changed; the final stitch uses what you choose here.</p>
        </div>
        <div className="page-status">
          <Pill tone="info" icon={overview.destination === "remote" ? Icon.external : Icon.local} title={worker?.endpoint}>{overview.destination === "remote" ? "Remote worker" : "This PC"}</Pill>
          {worker?.vramDefault && <Pill tone={worker.vramDefault.error ? "error" : "muted"} title="POST_PROCESSING_VRAM_MODE on the worker; unset means High VRAM.">
            Worker default: {worker.vramDefault.error ? "invalid" : VRAM_LABEL[worker.vramDefault.value ?? "high_vram"]}{worker.vramDefault.source === "default" ? " (unset)" : ""}
          </Pill>}
        </div>
      </div>
      <div className="row-actions">
        <Button variant="primary" icon={Icon.render} disabled={pending || busyQueue || !pendingCount || overview.blockers.length > 0} onClick={() => void act(() => window.martini.post.process(project.id, "pending"))}>
          Process pending{pendingCount ? ` (${pendingCount})` : ""}
        </Button>
        {busyQueue && <Button variant="outline-pink" icon={Icon.stop} busy={overview.queue.cancelling} disabled={pending} onClick={() => void act(() => window.martini.post.cancel(project.id))}>Cancel</Button>}
        <Button variant="secondary" icon={Icon.results} onClick={() => onNavigate("Results")}>Go to Results</Button>
      </div>
    </header>

    {error && <Notice tone="error" live onDismiss={() => setError("")}><p className="selectable">{error}</p></Notice>}
    {overview.blockers.map((line) => <Notice key={line} tone="warn"><p className="selectable">{line}</p></Notice>)}
    {worker?.vramDefault?.error && <Notice tone="error" title="The worker's memory mode is misconfigured"><p className="selectable">{worker.vramDefault.error}</p><p className="muted small">Clips set to Low VRAM or High VRAM still run; Worker default does not.</p></Notice>}
    {ortCpu && <Notice tone="warn" title="ONNX Runtime is not using the GPU on this worker"><p className="selectable">Face swapping and detection run on {worker!.ortSessionProviders!.join(", ")} (onnxruntime {worker!.onnxruntime}, built for CUDA {worker!.ortCudaBuild ?? "?"}). They work, but slowly. Install an onnxruntime-gpu build that matches the worker's CUDA {worker!.cuda}.</p></Notice>}
    {busyQueue && <Notice tone="working" live>Processing clip {overview.queue.current ?? "…"}{overview.queue.pending.length ? `; then ${overview.queue.pending.join(", ")}` : ""}. One clip at a time, after other models are unloaded.</Notice>}
    <CombineSummary overview={overview} />

    {!overview.package ? null : <div className="post-grid">
      <section className="panel post-list" aria-label="Clips">
        <PanelHead icon={Icon.film} title="Clips" count={overview.clips.length} aside={<label className="post-check-all"><input type="checkbox" checked={checked.size > 0 && checked.size === overview.clips.filter((item) => item.rendered).length}
          onChange={(event) => setChecked(event.target.checked ? new Set(overview.clips.filter((item) => item.rendered).map((item) => item.index)) : new Set())} /> All</label>} />
        <ol className="post-clips">
          {overview.clips.map((item) => <li key={item.index} className={cx("post-clip", item.index === current && "is-current", !item.rendered && "is-off")}>
            <input type="checkbox" aria-label={`Select clip ${item.index}`} disabled={!item.rendered} checked={checked.has(item.index)} onChange={() => toggle(item.index)} />
            <button type="button" className="post-clip-main" onClick={() => setCurrent(item.index)} aria-current={item.index === current || undefined}>
              {item.sourceUrl ? <video src={`${item.sourceUrl}#t=0.3`} preload="metadata" muted playsInline /> : <span className="post-thumb-empty"><Icon.film size={18} aria-hidden /></span>}
              <span className="post-clip-text">
                <b>Clip {item.index}</b>
                <span className="muted small">{[item.scene || "—", item.section ? `section ${item.section}` : null, `${item.duration.toFixed(1)}s`, item.sourceSize ? `${item.sourceSize.width}×${item.sourceSize.height}` : null].filter(Boolean).join(" · ")}</span>
                <span className="small">{item.settings.faceMode === "preserve" && !item.settings.upscale && !item.settings.dlss5 ? "No processing" : `${FACE_MODES.find((mode) => mode.value === item.settings.faceMode)!.label}${item.settings.dlss5 ? " + DLSS 5" : ""}${item.settings.upscale ? ` + ${item.settings.outputShortEdge}p` : ""} · ${VRAM_LABEL[item.settings.vramMode]}`}</span>
              </span>
              <Pill tone={STATE_TONE[item.state]}>{item.stateText}</Pill>
            </button>
          </li>)}
        </ol>
      </section>
      {clip && <ClipPanel key={clip.index} clip={clip} overview={overview} checked={[...checked]} pending={pending} busyQueue={busyQueue}
        onSave={(clips, settings) => void act(() => window.martini.post.saveSettings(project.id, { clips, settings }))}
        onProcess={(clips) => void act(() => window.martini.post.process(project.id, clips))}
        onSelect={(choice, attemptId) => void act(() => window.martini.post.select(project.id, { clip: clip.index, choice, attemptId }))}
        onSettingsPage={() => onNavigate("Settings")} />}
    </div>}
  </div>;
}

function CombineSummary({ overview }: { overview: PostProcessOverview }) {
  const { combine } = overview;
  if (!combine.unresolved.length) {
    return <div className="info-box"><Icon.success size={16} aria-hidden /><span>Final stitch: {combine.processedCount} processed clip{combine.processedCount === 1 ? "" : "s"}, {combine.bypassCount} explicit original{combine.bypassCount === 1 ? "" : "s"}; every other clip uses its original render. Clips of different sizes are normalized to the largest one.</span></div>;
  }
  return <Notice tone="warn" title={`The final stitch waits for ${combine.unresolved.length} clip${combine.unresolved.length === 1 ? "" : "s"}`}>
    <p className="muted small">Enabled processing never falls back to the raw render on its own. Process these clips, or choose "Use original" for each.</p>
    <ul className="fixed-list">{combine.unresolved.slice(0, 8).map((line) => <li key={line}>{line}</li>)}{combine.unresolved.length > 8 && <li>…and {combine.unresolved.length - 8} more</li>}</ul>
  </Notice>;
}

function ClipPanel({ clip, overview, checked, pending, busyQueue, onSave, onProcess, onSelect, onSettingsPage }: {
  clip: PostClip; overview: PostProcessOverview; checked: number[]; pending: boolean; busyQueue: boolean;
  onSave(clips: number[], settings: PostSettings): void; onProcess(clips: number[]): void; onSelect(choice: "original" | "processed" | "clear", attemptId?: string | null): void;
  onSettingsPage(): void;
}) {
  const [draft, setDraft] = useState<PostSettings>(clip.settings);
  useEffect(() => setDraft(clip.settings), [clip.settings]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(clip.settings);
  const succeeded = clip.attempts.filter((attempt) => attempt.status === "succeeded" && attempt.output?.exists);
  const [shown, setShown] = useState<string | null>(null);
  const compared = succeeded.find((attempt) => attempt.id === shown) ?? succeeded.find((attempt) => attempt.current) ?? succeeded[0] ?? null;
  const resolution = clip.resolution;
  const workerDefault = overview.worker?.vramDefault?.value ?? null;
  const resolvedMode = draft.vramMode === "worker_default" ? workerDefault : draft.vramMode;
  const preset = overview.presets.find((item) => item.mode === resolvedMode) ?? null;
  const set = <K extends keyof PostSettings>(key: K, value: PostSettings[K]) => setDraft((value0) => ({ ...value0, [key]: value }));
  const setAdv = <K extends keyof PostSettings["advanced"]>(key: K, value: PostSettings["advanced"][K]) => setDraft((value0) => ({ ...value0, advanced: { ...value0.advanced, [key]: value } }));
  const missing = resolvedMode && overview.worker ? [...(draft.faceMode !== "preserve" ? overview.worker.missingModels.face : []), ...(draft.upscale ? overview.worker.missingModels[resolvedMode] : [])] : [];
  const others = checked.filter((index) => index !== clip.index);
  const reference = overview.references.find((item) => item.id === draft.referenceAssetId) ?? overview.references.find((item) => item.role === "performer") ?? null;
  const restoring = draft.faceMode === "restore" || (draft.faceMode === "replace" && draft.restoreAfterSwap);

  return <section className="panel post-detail" aria-label={`Clip ${clip.index}`}>
    <PanelHead icon={Icon.film} title={`Clip ${clip.index}`} aside={<><Pill tone={STATE_TONE[clip.state]}>{clip.stateText}</Pill><span className="num">{formatTime(clip.start)}–{formatTime(clip.end)}</span></>} />

    {clip.sourceUrl ? <Compare source={clip.sourceUrl} result={compared?.output?.url ?? null} label={compared ? `${compared.summary}${compared.current ? "" : " (stale)"}` : null} />
      : <p className="muted">This clip has no rendered video yet. Render it on Produce.</p>}
    {succeeded.length > 1 && <label className="field"><span>Compare with</span>
      <select className="select" value={compared?.id ?? ""} onChange={(event) => setShown(event.target.value)}>
        {succeeded.map((attempt) => <option key={attempt.id} value={attempt.id}>{formatWhen(attempt.finishedAt ?? attempt.startedAt)} — {attempt.summary}{attempt.current ? "" : " (stale)"}</option>)}
      </select>
    </label>}

    <div className={cx("post-resolution", resolution.kind)}>
      <Icon.info size={16} aria-hidden />
      <span><b>Final stitch:</b> {resolution.kind === "processed" ? "uses the processed version." : resolution.kind === "bypass" ? "uses the original render (bypass)." : resolution.kind === "original" ? "uses the original render." : "waiting —"} {resolution.reason}</span>
      <div className="row-actions">
        {compared && compared.current && <Button size="sm" variant={resolution.kind === "processed" && clip.selection?.attemptId === compared.id ? "outline-blue" : "secondary"} disabled={pending} onClick={() => onSelect("processed", compared.id)}>Use this processed version</Button>}
        <Button size="sm" variant={resolution.kind === "bypass" ? "outline-blue" : "secondary"} disabled={pending || !clip.rendered} onClick={() => onSelect("original")}>Use original</Button>
        {clip.selection && <Button size="sm" variant="quiet" disabled={pending} onClick={() => onSelect("clear")}>Automatic</Button>}
      </div>
    </div>

    <div className="post-settings">
      <div className="post-suggest small">
        <Icon.info size={14} aria-hidden /><span>{clip.suggestion.reason}</span>
        {(clip.suggestion.faceMode !== draft.faceMode || clip.suggestion.upscale !== draft.upscale) && <Button size="sm" variant="link" onClick={() => setDraft((value) => ({ ...value, faceMode: clip.suggestion.faceMode, upscale: clip.suggestion.upscale }))}>Use suggestion</Button>}
      </div>

      <fieldset className="post-modes"><legend>Face treatment</legend>
        {FACE_MODES.map((mode) => <label key={mode.value} className={cx("post-mode", draft.faceMode === mode.value && "is-on")}>
          <input type="radio" name={`face-${clip.index}`} checked={draft.faceMode === mode.value} onChange={() => set("faceMode", mode.value)} />
          <b>{mode.label}</b><span className="muted small">{mode.text}</span>
        </label>)}
      </fieldset>

      {draft.faceMode === "replace" && <>
        <label className="field"><span>Character reference</span>
          <span className="post-ref">
            {reference && <img src={reference.url} alt="" />}
            <select className="select" value={draft.referenceAssetId ?? ""} onChange={(event) => set("referenceAssetId", event.target.value || null)}>
              <option value="">First performer image{overview.references.find((item) => item.role === "performer") ? ` (${overview.references.find((item) => item.role === "performer")!.name})` : " — none in project"}</option>
              {overview.references.map((item) => <option key={item.id} value={item.id}>{item.role === "performer" ? "Performer" : "Outfit"}: {item.name}</option>)}
            </select>
          </span>
        </label>
        <label className="control toggle-row"><Icon.performer size={20} className="control-icon" aria-hidden />
          <div className="control-text"><b>Restore the swapped face with CodeFormer</b><p>Runs inside ReActor on the swapped faces only, so there is no second CodeFormer pass.</p></div>
          <Switch checked={draft.restoreAfterSwap} onChange={(value) => set("restoreAfterSwap", value)} />
        </label>
        <p className="muted small">ReActor picks a face on each frame by the order below; it does not track one person through the clip. The face report flags frames with several faces, hands over the face, and frames that were not swapped.</p>
      </>}

      {restoring && <div className="field-row">
        <label className="field-stack"><span>CodeFormer fidelity <em className="num">{draft.codeformerFidelity.toFixed(2)}</em></span>
          <Slider min={0} max={1} step={0.05} value={draft.codeformerFidelity} onChange={(event) => set("codeformerFidelity", Number(event.target.value))} />
          <small className="muted">Higher keeps more of the input face (mouth shapes, expression); lower lets CodeFormer redraw more. It is not an identity-lock strength.</small>
        </label>
        <label className="field-stack"><span>Restore visibility <em className="num">{draft.restoreVisibility.toFixed(2)}</em></span>
          <Slider min={0.1} max={1} step={0.05} value={draft.restoreVisibility} onChange={(event) => set("restoreVisibility", Number(event.target.value))} />
          <small className="muted">Blend of the restored face over the input. Lower helps a sharp face sit in a soft, blurred shot.</small>
        </label>
      </div>}

      {/* DLSS 5 drives VE_CLI.exe, which only exists on a Windows ComfyUI: offered only when post-processing runs on this PC. */}
      {overview.destination === "remote" && draft.dlss5 && <Notice tone="warn" title="DLSS 5 is on for this clip, but it only runs on this PC">
        <p className="small">The workflow destination is the remote worker, which can't run DLSS 5. Turn it off for this clip, or switch to this PC in <Button size="sm" variant="link" onClick={onSettingsPage}>Settings</Button>.</p>
        <Button size="sm" variant="secondary" onClick={() => set("dlss5", false)}>Turn DLSS 5 off</Button>
      </Notice>}
      {overview.destination === "local" && <>
      <label className="control toggle-row"><Icon.postprocess size={20} className="control-icon" aria-hidden />
        <div className="control-text"><b>DLSS 5 neural rendering</b><p>Runs after face treatment and before SeedVR2, through the Custom DLSS5 node on this PC (Windows only). Optional RTX upscale and frame interpolation.</p></div>
        <Switch checked={draft.dlss5} onChange={(value) => set("dlss5", value)} />
      </label>
      {draft.dlss5 && <>
        <div className="field-row">
          <label className="field-stack"><span>Style</span>
            <select className="select" value={draft.dlss5Style} onChange={(event) => set("dlss5Style", event.target.value as PostSettings["dlss5Style"])}>
              {DLSS5_STYLES.map((style) => <option key={style} value={style}>{style}</option>)}
            </select>
          </label>
          <label className="field-stack"><span>Strength <em className="num">{draft.dlss5Strength.toFixed(1)}</em></span>
            <Slider min={0} max={2} step={0.1} value={draft.dlss5Strength} onChange={(event) => set("dlss5Strength", Number(event.target.value))} />
            <small className="muted">How strongly DLSS 5 re-renders materials and lighting. 1.0 is the node's default.</small>
          </label>
        </div>
        <div className="field-row">
          <label className="field-stack"><span>RTX upscale</span>
            <select className="select" value={draft.dlss5Scale} onChange={(event) => set("dlss5Scale", Number(event.target.value) as PostSettings["dlss5Scale"])}>
              {DLSS5_SCALES.map((scale) => <option key={scale} value={scale}>{scale === 1 ? "Off (native size)" : `${scale}× — ${outScaled(clip.sourceSize, scale)}`}</option>)}
            </select>
            {draft.dlss5Scale > 1 && draft.upscale && <small className="muted">SeedVR2 still sets the final size ({draft.outputShortEdge}p), from the larger DLSS frames.</small>}
          </label>
          <label className="field-stack"><span>Interpolate to</span>
            <select className="select" value={draft.dlss5TargetFps} onChange={(event) => set("dlss5TargetFps", Number(event.target.value) as PostSettings["dlss5TargetFps"])}>
              {DLSS5_FPS.map((fps) => <option key={fps} value={fps}>{fps === 0 ? "Off" : `${fps} fps`}</option>)}
            </select>
            {draft.dlss5TargetFps > 0 && <small className="muted">DLSS Frame Generation (RTX 40/50). Use the same rate on every interpolated clip: the final stitch converts the whole video to it, and clips left at the render rate repeat frames to match.</small>}
          </label>
        </div>
        {overview.worker?.reachable && overview.worker.dlss5Problem && <Notice tone="warn" title="DLSS 5 isn't available on this worker"><p className="small">{overview.worker.dlss5Problem}</p></Notice>}
      </>}
      </>}

      <label className="control toggle-row"><Icon.zoomIn size={20} className="control-icon" aria-hidden />
        <div className="control-text"><b>SeedVR2 restoration and upscaling</b><p>Runs after face treatment{overview.destination === "local" ? " and DLSS 5" : ""}. Frame count, frame rate, and aspect ratio are kept and checked.</p></div>
        <Switch checked={draft.upscale} onChange={(value) => set("upscale", value)} />
      </label>
      {draft.upscale && <label className="field"><span>Output size</span>
        <select className="select" value={draft.outputShortEdge} onChange={(event) => set("outputShortEdge", Number(event.target.value) as PostSettings["outputShortEdge"])}>
          {EDGES.map((edge) => <option key={edge} value={edge}>{edge}p — {outSize(clip.sourceSize, edge)}{edge === 2160 ? " (test separately; large memory)" : ""}</option>)}
        </select>
      </label>}

      <label className="field"><span>Memory mode</span>
        <select className="select" value={draft.vramMode} onChange={(event) => set("vramMode", event.target.value as PostSettings["vramMode"])}>
          <option value="worker_default">Worker default{workerDefault ? ` (${VRAM_LABEL[workerDefault]})` : " (worker not reached)"}</option>
          <option value="low_vram">Low VRAM — 16 GB VRAM / 64 GB RAM</option>
          <option value="high_vram">High VRAM — 48 GB VRAM / 96 GB RAM</option>
        </select>
      </label>
      <p className="muted small">
        {preset ? <>Starts with {preset.ditModel.replace(".safetensors", "")}, temporal batch {preset.batchSize}, VAE tiling {preset.vaeTiling ? "on" : "off"}, model offload {preset.ditOffload}, decoded frames bounded at {preset.frameRamBudgetGb} GB. </> : null}
        Presets are starting points to measure, not guarantees. Where this runs is the Workflow destination in <Button size="sm" variant="link" onClick={onSettingsPage}>Settings</Button> ({overview.destination === "remote" ? "remote worker" : "this PC"}).
      </p>
      {missing.length > 0 && <Notice tone="warn" title="The worker is missing models for this request"><p className="selectable small">{missing.join(", ")}</p><p className="muted small">On RunPod set POST_PROCESSING_MODELS=all (or this mode) and restart the pod. Processing is refused until they are installed.</p></Notice>}

      <Disclosure summary="Advanced" icon={Icon.direction}>
        <div className="field-row">
          <label className="field-stack"><span>SeedVR2 model</span>
            <select className="select" value={draft.advanced.ditModel ?? ""} onChange={(event) => setAdv("ditModel", event.target.value || null)}>
              <option value="">Preset{preset ? ` (${preset.ditModel.replace(".safetensors", "")})` : ""}</option>
              {["seedvr2_ema_3b_fp8_e4m3fn.safetensors", "seedvr2_ema_3b_fp16.safetensors", "seedvr2_ema_7b_fp16.safetensors", "seedvr2_ema_7b_fp8_e4m3fn_mixed_block35_fp16.safetensors", "seedvr2_ema_7b_sharp_fp16.safetensors"].map((name) => <option key={name} value={name}>{name.replace(".safetensors", "")}</option>)}
            </select>
          </label>
          <label className="field-stack"><span>Temporal batch (4n+1)</span>
            <select className="select" value={draft.advanced.batchSize ?? ""} onChange={(event) => setAdv("batchSize", event.target.value ? Number(event.target.value) : null)}>
              <option value="">Preset{preset ? ` (${preset.batchSize})` : ""}</option>{BATCHES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="field-stack"><span>Temporal overlap</span>
            <select className="select" value={draft.advanced.temporalOverlap ?? ""} onChange={(event) => setAdv("temporalOverlap", event.target.value === "" ? null : Number(event.target.value))}>
              <option value="">Preset</option>{[0, 1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="field-stack"><span>VAE tiling</span>
            <select className="select" value={draft.advanced.vaeTiling === null ? "" : String(draft.advanced.vaeTiling)} onChange={(event) => setAdv("vaeTiling", event.target.value === "" ? null : event.target.value === "true")}>
              <option value="">Preset{preset ? ` (${preset.vaeTiling ? "on" : "off"})` : ""}</option><option value="true">On</option><option value="false">Off</option>
            </select>
          </label>
          <label className="field-stack"><span>Model offload</span>
            <select className="select" value={draft.advanced.offload} onChange={(event) => setAdv("offload", event.target.value as PostSettings["advanced"]["offload"])}>
              <option value="preset">Preset{preset ? ` (${preset.ditOffload})` : ""}</option><option value="none">Keep on GPU</option><option value="cpu">Offload to RAM</option>
            </select>
          </label>
          <label className="field-stack"><span>BlockSwap blocks</span>
            <input className="input num" type="number" min={0} max={36} placeholder="Preset (0)" value={draft.advanced.blocksToSwap ?? ""} onChange={(event) => setAdv("blocksToSwap", event.target.value === "" ? null : Math.max(0, Math.min(36, Number(event.target.value))))} />
          </label>
          <label className="field-stack"><span>Attention</span>
            <select className="select" value={draft.advanced.attention} onChange={(event) => setAdv("attention", event.target.value as PostSettings["advanced"]["attention"])}>
              <option value="sdpa">sdpa (default)</option><option value="sageattn_2">SageAttention 2</option><option value="flash_attn_2">Flash Attention 2</option>
            </select>
          </label>
          <label className="field-stack"><span>Color correction</span>
            <select className="select" value={draft.advanced.colorCorrection} onChange={(event) => setAdv("colorCorrection", event.target.value as PostSettings["advanced"]["colorCorrection"])}>
              {["lab", "wavelet", "wavelet_adaptive", "hsv", "adain", "none"].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="field-stack"><span>Seed</span>
            <input className="input num" type="number" min={0} value={draft.advanced.seed} onChange={(event) => setAdv("seed", Math.max(0, Math.round(Number(event.target.value) || 0)))} />
          </label>
          <label className="field-stack"><span>Target face order</span>
            <select className="select" value={draft.advanced.targetFacesOrder} onChange={(event) => setAdv("targetFacesOrder", event.target.value as PostSettings["advanced"]["targetFacesOrder"])}>
              {["large-small", "small-large", "left-right", "right-left", "top-bottom", "bottom-top"].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="field-stack"><span>Target face index</span>
            <input className="input mono" value={draft.advanced.targetFacesIndex} onChange={(event) => setAdv("targetFacesIndex", event.target.value)} />
          </label>
        </div>
        <label className="control toggle-row"><Icon.sections size={20} className="control-icon" aria-hidden />
          <div className="control-text"><b>Uniform final batch</b><p>Pads the last SeedVR2 batch to full size to avoid end-of-clip artifacts; the padding is removed and the frame count is checked.</p></div>
          <Switch checked={draft.advanced.uniformBatch} onChange={(value) => setAdv("uniformBatch", value)} />
        </label>
      </Disclosure>

      <div className="row-actions post-actions">
        <Button variant="primary" icon={Icon.save} disabled={pending || !dirty} onClick={() => onSave([clip.index], draft)}>Save for clip {clip.index}</Button>
        {others.length > 0 && <Button variant="secondary" icon={Icon.copy} disabled={pending} onClick={() => onSave([clip.index, ...others], draft)}>Apply to {others.length + 1} selected clips</Button>}
        <Button variant="outline-pink" icon={clip.attempts.length ? Icon.retry : Icon.render} disabled={pending || busyQueue || dirty || !clip.rendered || (clip.settings.faceMode === "preserve" && !clip.settings.upscale && !clip.settings.dlss5) || overview.blockers.length > 0}
          title={dirty ? "Save the settings first." : undefined} onClick={() => onProcess([clip.index])}>{clip.attempts.length ? "Process again" : "Process clip"}</Button>
        {others.length > 0 && <Button variant="secondary" icon={Icon.render} disabled={pending || busyQueue || dirty || overview.blockers.length > 0} onClick={() => onProcess([clip.index, ...others])}>Process {others.length + 1} selected</Button>}
      </div>
    </div>

    <Attempts attempts={clip.attempts} />
  </section>;
}

/** Original and result side by side, driven by one set of controls so both stay on the same frame. Click a picture to
 *  zoom both into the same spot (face inspection). Normal-speed playback; the original's audio plays. */
function Compare({ source, result, label }: { source: string; result: string | null; label: string | null }) {
  const left = useRef<HTMLVideoElement>(null);
  const right = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const videos = useMemo(() => () => [left.current, right.current].filter((video): video is HTMLVideoElement => Boolean(video)), []);
  useEffect(() => {
    const master = left.current;
    if (!master) return;
    const tick = () => {
      setTime(master.currentTime);
      const other = right.current;
      if (other && Math.abs(other.currentTime - master.currentTime) > 0.06) other.currentTime = master.currentTime;
    };
    const meta = () => setDuration(master.duration || 0);
    const ended = () => setPlaying(false);
    master.addEventListener("timeupdate", tick); master.addEventListener("loadedmetadata", meta); master.addEventListener("ended", ended);
    return () => { master.removeEventListener("timeupdate", tick); master.removeEventListener("loadedmetadata", meta); master.removeEventListener("ended", ended); };
  }, [source, result]);
  const toggle = () => {
    if (playing) { videos().forEach((video) => video.pause()); setPlaying(false); }
    else { if (right.current && left.current) right.current.currentTime = left.current.currentTime; videos().forEach((video) => void video.play().catch(() => undefined)); setPlaying(true); }
  };
  const seek = (value: number) => { videos().forEach((video) => { video.currentTime = value; }); setTime(value); };
  const step = (frames: number) => { videos().forEach((video) => video.pause()); setPlaying(false); seek(Math.max(0, Math.min(duration, time + frames / 24))); };
  const onPick = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    setZoom((current) => current ? null : { x: ((event.clientX - box.left) / box.width) * 100, y: ((event.clientY - box.top) / box.height) * 100 });
  };
  const style = zoom ? { transform: "scale(2.5)", transformOrigin: `${zoom.x}% ${zoom.y}%` } : undefined;
  return <div className="post-compare">
    <div className="post-videos">
      <figure><div className="post-frame" onClick={onPick} title="Click to zoom both pictures into this spot"><video ref={left} src={source} playsInline preload="auto" style={style} /></div><figcaption>Original render</figcaption></figure>
      <figure>{result ? <div className="post-frame" onClick={onPick} title="Click to zoom both pictures into this spot"><video ref={right} src={result} muted playsInline preload="auto" style={style} /></div>
        : <div className="post-frame post-frame-empty"><span className="muted small">No processed version yet</span></div>}<figcaption>{label ?? "Processed"}</figcaption></figure>
    </div>
    <div className="post-transport">
      <IconButton icon={Icon.toStart} label="Back one frame" size="sm" onClick={() => step(-1)} />
      <IconButton icon={playing ? Icon.pause : Icon.render} label={playing ? "Pause both" : "Play both"} onClick={toggle} />
      <IconButton icon={Icon.next} label="Forward one frame" size="sm" onClick={() => step(1)} />
      <Slider min={0} max={duration || 1} step={0.01} value={time} aria-label="Position" onChange={(event) => seek(Number(event.target.value))} />
      <span className="num small">{time.toFixed(2)}s</span>
      <IconButton icon={zoom ? Icon.zoomOut : Icon.zoomIn} label={zoom ? "Zoom out" : "Click a picture to zoom into a face"} size="sm" tip="end" onClick={() => setZoom(null)} disabled={!zoom} />
    </div>
  </div>;
}

function Attempts({ attempts }: { attempts: PostAttempt[] }) {
  if (!attempts.length) return null;
  return <Disclosure summary={`Attempts (${attempts.length})`} icon={Icon.log} defaultOpen={attempts.some((attempt) => attempt.status === "failed" || attempt.reviewRequired)}>
    <ol className="post-attempts">
      {attempts.map((attempt) => <li key={attempt.id}>
        <div className="post-attempt-head">
          <Pill tone={attempt.status === "succeeded" ? (attempt.reviewRequired ? "warn" : "ok") : attempt.status === "failed" ? "error" : attempt.status === "running" ? "working" : "muted"}>
            {attempt.status === "succeeded" && attempt.reviewRequired ? "needs review" : attempt.status}
          </Pill>
          {!attempt.current && <Pill tone="muted" title="Made from a different source, reference, or settings than the clip asks for now.">stale</Pill>}
          <span className="small">{attempt.summary}</span>
          <span className="muted small">{formatWhen(attempt.startedAt)}{attempt.runtimeSeconds !== null ? ` · ${attempt.runtimeSeconds}s` : ""} · {attempt.destination === "remote" ? "remote" : "this PC"}{attempt.resolvedMode ? ` · ${VRAM_LABEL[attempt.resolvedMode]}${attempt.requestedMode === "worker_default" ? " (worker default)" : ""}` : ""}</span>
        </div>
        {attempt.error && <p className={cx("small selectable", attempt.status === "failed" ? "error-text" : "muted")}>{attempt.error}</p>}
        {attempt.output && <p className="muted small">{attempt.output.fileName}: {attempt.output.width}×{attempt.output.height}, {attempt.output.frames} frames at {attempt.output.fps} fps{attempt.output.exists ? "" : " — file missing"}</p>}
        {attempt.faceReport && <div className="post-face-report small">
          <span>Faces found on {attempt.faceReport.framesWithFace} of {attempt.faceReport.frames} frames; changed on {attempt.faceReport.framesChanged}.{attempt.faceReport.handDetector ? "" : " (No hand detector installed.)"}</span>
          {attempt.faceReport.dropoutFrames.length > 0 && <span className="warn-text">Unchanged frames with a face: {ranges(attempt.faceReport.dropoutFrames)}</span>}
          {attempt.faceReport.multiFaceFrames.length > 0 && <span className="warn-text">Several faces: frames {ranges(attempt.faceReport.multiFaceFrames)}</span>}
          {attempt.faceReport.handOverlapFrames.length > 0 && <span className="warn-text">Hand over face: frames {ranges(attempt.faceReport.handOverlapFrames)}</span>}
          {attempt.faceReport.warnings.map((warning) => <span key={warning}>{warning}</span>)}
          <span className="muted">Check mouth shapes, teeth, blinks and expression at normal speed: the report cannot judge them.</span>
        </div>}
        {attempt.environment && <p className="muted small mono">ReActor {attempt.environment.reactor ?? "—"} · SeedVR2 {attempt.environment.seedvr2 ?? "—"} · onnxruntime {attempt.environment.onnxruntime ?? "—"} ({attempt.environment.ortProviders?.[0] ?? "?"}) · torch {attempt.environment.torch ?? "—"} · {attempt.environment.device ?? ""}</p>}
      </li>)}
    </ol>
  </Disclosure>;
}
