import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDuration, formatTime, formatWhen, readableError } from "./ProjectsView";
import { elapsed, useTicker } from "./usePlan";
import { Button, ConfirmDialog, CopyButton, Disclosure, Icon, LoadingPage, NoProject, Notice, PageHeader, PanelHead, Pill, ProgressBar, Switch, ToneMark, cx, type LucideIcon, type Tone } from "./ui";
import { SectionActionEditor } from "./SectionActionEditor";
import { usePeaks } from "./useSongPeaks";
import { CLIP_CAMERAS, type ClipChanges, type ClipMode, type ClipRefRole, type ClipRevisionRequest, type ClipShotSettings } from "../electron/contracts";

type Props = { project: ProjectDetail | null; comfy?: ComfyStatus; onNavigate(view: "Projects" | "Plan" | "Locations" | "Results"): void };
type LivePreview = { clipIndex: number; url: string; step: number; total: number; frames: number };

const PHASE_CLASS: Record<string, string> = { Arrival: "arrival", Friction: "friction", Escalation: "escalation", Break: "break", Release: "release" };
const STATUS_TEXT: Record<ProduceClip["status"], string> = {
  pending: "Not rendered", queued: "Queued", rendering: "Rendering…", rendered: "Rendered", failed: "Failed", interrupted: "Interrupted",
};
const STATUS_STYLE: Record<ProduceClip["status"], { tone: Tone; icon?: LucideIcon }> = {
  pending: { tone: "muted", icon: Icon.pending }, queued: { tone: "queued" }, rendering: { tone: "working" }, rendered: { tone: "ok" },
  failed: { tone: "error" }, interrupted: { tone: "error", icon: Icon.warning },
};
const PACKAGE_PHASE: Record<string, string> = {
  waiting: "Waiting for ComfyUI…", saving_project: "Saving the project through ComfyUI…", queued: "Queued in ComfyUI…",
  running: "Building the production plan and writing prompts with the local LLM…", cleanup: "Cleaning up ComfyUI memory…",
};

function clock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function since(iso: string | null, now: number): number | null {
  return iso ? (now - new Date(iso).getTime()) / 1000 : null;
}

function timeOf(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

function ClipState({ status, children }: { status: ProduceClip["status"]; children?: string }) {
  const style = STATUS_STYLE[status];
  return <Pill tone={style.tone} icon={style.icon}>{children ?? STATUS_TEXT[status]}</Pill>;
}

function ModeChip({ mode }: { mode: string | null | undefined }) {
  return mode ? <span className={cx("mode-chip", mode.toLowerCase())}>{mode}</span> : <>—</>;
}

function useProduce(projectId: string) {
  const [overview, setOverview] = useState<ProduceOverview>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setOverview(await window.martini.produce.overview(projectId)); setError(""); }
    catch (reason) { setError(readableError(reason)); }
  }, [projectId]);
  useEffect(() => {
    void refresh();
    const onChange = (changed: string) => { if (changed === projectId) void refresh(); };
    const offs = [window.martini.produce.onChanged(onChange), window.martini.plan.onChanged(onChange), window.martini.locations.onChanged(onChange), window.martini.projects.onChanged(onChange)];
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { offs.forEach((off) => off()); window.removeEventListener("focus", onFocus); };
  }, [projectId, refresh]);
  return { overview, setOverview, error, setError, refresh };
}

export function ProduceView({ project, comfy, onNavigate }: Props) {
  if (!project) return <NoProject text="Open a project, plan it, and confirm its locations. Production happens here, one clip at a time." onProjects={() => onNavigate("Projects")} />;
  return <ProduceContent key={project.id} project={project} comfy={comfy} onNavigate={onNavigate} />;
}

function ProduceContent({ project, comfy, onNavigate }: { project: ProjectDetail; comfy?: ComfyStatus; onNavigate: Props["onNavigate"] }) {
  const { overview, setOverview, error, setError } = useProduce(project.id);
  const [count, setCount] = useState("1");
  const [pending, setPending] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const [detail, setDetail] = useState<ClipDetail>();
  const [preview, setPreview] = useState<LivePreview | null>(null);
  const queue = overview?.queue ?? null;
  const active = queue?.status === "running" || queue?.status === "stopping";
  const packageRun = overview?.latestPackageRun ?? null;
  const writing = packageRun?.status === "queued" || packageRun?.status === "running";
  const now = useTicker(active || writing);
  const peaks = usePeaks(overview?.package ? overview.songUrl : null);

  useEffect(() => {
    // Main owns the render's ComfyUI WebSocket (ComfyUI keeps one socket per client ID) and relays previews here,
    // so they arrive the same way from the local install and a remote worker. A new or ended session clears the image.
    const offSession = window.martini.produce.onPreviewSession(() => setPreview(null));
    const offFrame = window.martini.produce.onPreviewFrame((frame) => {
      if (frame.projectId !== project.id) return;
      setPreview({ clipIndex: frame.clipIndex, url: `data:${frame.mime};base64,${frame.image}`, step: frame.step, total: frame.total, frames: frame.frames });
    });
    return () => { offSession(); offFrame(); };
  }, [project.id]);

  // The clip shown in the detail panels: the user's pick, else the one rendering, else the last failed, else the next one.
  const shown = useMemo(() => {
    if (!overview?.clips.length) return null;
    const pick = focus !== null ? overview.clips.find((clip) => clip.index === focus) : undefined;
    return pick ?? overview.clips.find((clip) => clip.index === overview.currentClip)
      ?? overview.clips.find((clip) => clip.status === "failed" || clip.status === "interrupted")
      ?? overview.clips.find((clip) => clip.status !== "rendered") ?? overview.clips[overview.clips.length - 1];
  }, [overview, focus]);
  const shownKey = shown ? `${shown.index}:${shown.status}:${shown.attempts}:${shown.lastAttempt?.cleanup ?? ""}:${shown.lastAttempt?.phase ?? ""}` : "";
  useEffect(() => {
    if (!shown) { setDetail(undefined); return; }
    let cancelled = false;
    window.martini.produce.clipDetail(project.id, shown.index).then((value) => { if (!cancelled) setDetail(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [project.id, shownKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (work: () => Promise<ProduceOverview | void>) => {
    setPending(true);
    try { const result = await work(); if (result) setOverview(result); setError(""); }
    catch (reason) { setError(readableError(reason)); }
    finally { setPending(false); }
  };
  const [askRerender, setAskRerender] = useState(false);
  const revisePrompt = async (request: ClipRevisionRequest): Promise<boolean> => {
    if (!shown) return false;
    setPending(true);
    try {
      const result = await window.martini.produce.reviseClipPrompt(project.id, shown.index, request);
      setOverview(result);
      setDetail(await window.martini.produce.clipDetail(project.id, shown.index));
      setError("");
      return true;
    } catch (reason) { setError(readableError(reason)); return false; }
    finally { setPending(false); }
  };

  if (!overview) return error ? <div className="page"><Notice tone="error" title="Production state could not be loaded" live>{error}</Notice></div> : <LoadingPage text="Reading the production state…" />;

  const { counts, package: pkg } = overview;
  const comfyDown = Boolean(comfy && !comfy.connected);
  const otherBusy = overview.busy && overview.busy.projectId !== project.id;
  const parsedCount = Number(count);
  const countValid = Number.isInteger(parsedCount) && parsedCount >= 1;
  const willRender = countValid ? Math.min(parsedCount, counts.remaining) : 0;
  const canQueue = Boolean(pkg) && !active && !pending && !comfyDown && !overview.renderBlockers.length;
  const failedClip = overview.clips.find((clip) => clip.status === "failed" || clip.status === "interrupted") ?? null;
  const progress = counts.total ? Math.round((counts.rendered / counts.total) * 100) : 0;
  const headline = overview.currentClip ?? overview.upcoming[0] ?? (counts.remaining ? overview.clips.find((clip) => clip.status !== "rendered")?.index : null) ?? null;
  const elapsedSeconds = queue ? (active ? since(queue.createdAt, now) : queue.finishedAt ? (new Date(queue.finishedAt).getTime() - new Date(queue.createdAt).getTime()) / 1000 : null) : null;
  const stopping = queue?.status === "stopping";
  const status: { tone: Tone; icon?: LucideIcon; text: string } = writing ? { tone: "working", text: "Writing prompt package" }
    : active ? (stopping ? { tone: "queued", icon: Icon.stop, text: "Stopping after current clip" } : { tone: "working", text: "Rendering locally" })
    : !pkg ? { tone: "warn", icon: Icon.file, text: "Prompt package needed" }
    : queue?.status === "failed" ? { tone: "error", text: failedClip ? `Stopped — clip ${failedClip.index} failed` : "Rendering stopped" }
    : queue?.status === "interrupted" ? { tone: "warn", text: "Queue interrupted" }
    : counts.remaining ? { tone: "info", icon: Icon.render, text: "Ready to render" } : { tone: "ok", text: "All clips rendered" };
  const allRendered = Boolean(pkg) && counts.total > 0 && !counts.remaining && !active && !writing;

  return <div className="page produce-page">
    <PageHeader title={`Producing ${project.name}`} icon={Icon.produce}
      crumb={<><span className="num">{formatDuration(overview.durationSeconds)}</span><span className="sep">/</span>{pkg ? `${counts.total} clips` : "no prompt package yet"}</>}
      status={<>
        <Pill size="lg" tone={status.tone} icon={status.icon}>{status.text}</Pill>
        {overview.gpu && <Pill size="lg" tone="muted" icon={Icon.gpu} title="Reported by the running ComfyUI">{overview.gpu}</Pill>}
      </>}
      actions={allRendered ? <Button variant="primary" icon={Icon.results} iconEnd={Icon.next} onClick={() => onNavigate("Results")}>Continue to results</Button> : undefined} />

    {error && <Notice tone="error" live onDismiss={() => setError("")}>{error}</Notice>}
    {comfyDown && <Notice tone="error">ComfyUI is not reachable at {comfy!.endpoint}. Start ComfyUI and wait for it to finish loading. Nothing is lost: rendered clips and the queue state are saved.</Notice>}
    {otherBusy && <Notice tone="warn">Another project is {overview.busy!.kind === "render" ? "rendering" : overview.busy!.kind === "stitch" ? "stitching its final video" : "writing a prompt package"}. ComfyUI runs one job at a time.</Notice>}

    <PackagePanel overview={overview} now={now} writing={writing} pending={pending} comfyDown={comfyDown}
      onWrite={() => act(() => window.martini.produce.writePackage(project.id))}
      onOpenFolder={() => act(() => window.martini.produce.openFolder(project.id))} onNavigate={onNavigate} />

    {pkg && <>
      <section className="panel produce-progress" aria-label="Render progress">
        <div className="clip-counter">
          <Icon.film size={26} aria-hidden />
          <div><span className="eyebrow">{active ? "Now" : "Next"}</span>
            <b className="num">{headline ? `Clip ${headline} of ${counts.total}` : `${counts.total} of ${counts.total} rendered`}</b></div>
        </div>
        <div className="overall">
          <div className="overall-head"><span>Overall progress</span><b className="num">{progress}%</b></div>
          <ProgressBar value={progress} label="Clips rendered" />
          <small className="muted num">{counts.rendered} rendered · {counts.remaining} remaining{counts.failed ? ` · ${counts.failed} failed` : ""}{active && queue ? ` · queue ${queue.completed}/${queue.target}` : ""}</small>
        </div>
        <div className="time-box"><Icon.elapsed size={20} aria-hidden /><div><span>Elapsed</span><b className="num">{clock(elapsedSeconds)}</b></div></div>
        <div className="time-box" title={overview.timing.samples < 2 ? "Shown after at least two clips have finished in this package." : `Based on ${overview.timing.samples} finished clips (average ${clock(overview.timing.averageSeconds)} each, including cleanup).`}>
          <Icon.remaining size={20} aria-hidden /><div><span>Est. remaining</span><b className="num">{overview.timing.estimateSeconds !== null ? `≈ ${clock(overview.timing.estimateSeconds)}` : "—"}</b></div>
        </div>
        <div className="queue-control">
          {active ? <Button variant="outline-pink" size="lg" icon={Icon.stop} busy={stopping} disabled={pending} onClick={() => void act(() => window.martini.produce.stopAfterCurrent(project.id))}>
            {stopping ? "Stopping after this clip…" : "Stop after current clip"}</Button>
            : <>
              <label className="count-field"><span>Clips to render</span>
                <input className="input num" type="number" min={1} step={1} value={count} disabled={!canQueue} onChange={(event) => setCount(event.target.value)} /></label>
              <Button variant={failedClip ? "secondary" : "primary"} size="lg" icon={Icon.render} disabled={!canQueue || !countValid} onClick={() => void act(() => window.martini.produce.queue(project.id, parsedCount))}>
                Render {willRender >= counts.remaining && counts.remaining > 1 ? `all ${counts.remaining}` : willRender || ""} clip{willRender === 1 ? "" : "s"}</Button>
            </>}
        </div>
      </section>

      <QueueBanner overview={overview} failedClip={failedClip} active={active} canQueue={canQueue} pending={pending}
        onRemaining={() => act(() => window.martini.produce.queueRemaining(project.id))}
        onRetry={(index) => act(() => window.martini.produce.retryClip(project.id, index))} />
      {!active && overview.renderBlockers.filter((item) => !item.startsWith("Every clip")).map((item) => <Notice key={item} tone="warn">{item}</Notice>)}
      {allRendered && <Notice tone="ok">Every clip is rendered. Stitch the final video on Results.</Notice>}

      <Timeline overview={overview} peaks={peaks} focus={shown?.index ?? null} onFocus={setFocus} />

      <div className="produce-grid">
        {shown && <CurrentClip clip={shown} projectId={project.id} active={overview.currentClip === shown.index} now={now} pending={pending} canRetry={!active && !comfyDown && !otherBusy}
          preview={preview?.clipIndex === shown.index ? preview : null}
          canRender={shown.status === "pending" && canQueue}
          onRender={() => act(() => window.martini.produce.renderClip(project.id, shown.index))}
          onRetry={() => act(() => window.martini.produce.retryClip(project.id, shown.index))}
          onRerender={() => setAskRerender(true)}
          onCopy={() => window.martini.produce.copyOutputPath(project.id, shown.index)} onCopyError={(reason) => setError(readableError(reason))} />}
        {shown && askRerender && (() => {
          const others = (detail?.index === shown.index ? detail.rerenderWith : [shown.index]).filter((index) => index !== shown.index);
          return <ConfirmDialog title={`Re-render clip ${shown.index}?`} icon={Icon.render} confirmLabel="Re-render" confirmIcon={Icon.render} confirmVariant="primary"
            onCancel={() => setAskRerender(false)} onConfirm={() => { setAskRerender(false); void act(() => window.martini.produce.rerenderClip(project.id, shown.index, true)); }}>
            <p>Clip {shown.index} renders again with the same prompt and a new seed, so the result will differ.</p>
            {others.length > 0 && <p className="warn-text"><Icon.warning size={14} aria-hidden /> Clip{others.length === 1 ? "" : "s"} {others.join(", ")} reuse{others.length === 1 ? "s" : ""} its last frames, so {others.length === 1 ? "it renders" : "they render"} again too.</p>}
            <p className="muted small">The current video{others.length ? "s move" : " moves"} to the package’s <code>superseded</code> folder; nothing is deleted.</p>
          </ConfirmDialog>;
        })()}
        <Decisions clip={shown} detail={detail} planEvidence={overview.planEvidence} />
        {shown && <PromptWorkshop clip={shown} detail={detail} disabled={pending || active || !!otherBusy || comfyDown} projectId={project.id}
          onRevise={revisePrompt} onError={setError}
          onSectionSaved={(result) => { setOverview(result); setError(""); void window.martini.produce.clipDetail(project.id, shown.index).then(setDetail).catch(() => undefined); }} />}
      </div>

      <QueueTable overview={overview} active={active} onFocus={setFocus} />
    </>}

    <TechnicalLog overview={overview} detail={detail} />
  </div>;
}

function PackagePanel({ overview, now, writing, pending, comfyDown, onWrite, onOpenFolder, onNavigate }: {
  overview: ProduceOverview; now: number; writing: boolean; pending: boolean; comfyDown: boolean; onWrite(): void; onOpenFolder(): void; onNavigate: Props["onNavigate"];
}) {
  const pkg = overview.package;
  const run = overview.latestPackageRun;
  const failed = run && (run.status === "failed" || run.status === "interrupted") && run.id !== pkg?.runId ? run : null;
  const canWrite = overview.canWritePackage && !writing && !pending && !comfyDown;
  if (pkg && !overview.packageStale.length && !failed && !writing) {
    return <section className="panel package-summary">
      <span className="package-title"><Icon.file size={16} aria-hidden />Prompt package</span>
      <div className="package-steps">{pkg.steps.map((step) => <span key={step.label} className={cx("step-chip", step.tone)} title={step.value}><ToneMark tone={step.tone} />{step.label}</span>)}</div>
      <span className="muted small num">{pkg.clipCount} clips · {pkg.shotCount} shots · written {formatWhen(pkg.writtenAt)}{pkg.warnings.length ? ` · ${pkg.warnings.length} director warning${pkg.warnings.length === 1 ? "" : "s"}` : ""}</span>
      <Button variant="quiet" size="sm" icon={Icon.openFolder} onClick={onOpenFolder}>Open package folder</Button>
      {overview.packageNotes.map((note) => <p key={note} className="muted small package-note">{note}{" "}
        <Button variant="link" size="sm" disabled={!canWrite} onClick={onWrite}>Write new prompt package</Button></p>)}
    </section>;
  }
  return <section className="panel package-panel">
    <div className="package-text">
      <h2 className="panel-title"><Icon.file size={18} className="panel-title-icon" aria-hidden />{pkg ? "Prompt package is out of date" : "Prompt package"}</h2>
      <p className="muted">The director turns the saved story into a fixed production plan (timing, outfits, transitions, clips) and writes one MiniMax prompt per clip with the local LLM. The story itself is reused unchanged — nothing is rerolled.</p>
      {overview.packageStale.map((reason) => <p key={reason} className="warn-text"><Icon.warning size={14} aria-hidden /> {reason} Clips already rendered stay in the old package folder.</p>)}
      {writing && run && <p className="info-text working-line" role="status"><Icon.working size={15} className="spin" aria-hidden />{PACKAGE_PHASE[run.activity?.phase ?? "waiting"]}{run.activity?.queuePosition ? ` (position ${run.activity.queuePosition})` : ""} <span className="muted num">· {elapsed(run.startedAt, now)}</span></p>}
      {failed && <Notice tone="error" title={<>{failed.status === "interrupted" ? "Writing the prompt package was interrupted." : "The prompt package could not be written."} <span className="muted">The story plan is unchanged.</span></>}>
        <p className="error-text">{failed.error}</p>
      </Notice>}
      {!writing && overview.packageBlockers.map((blocker) => <p key={blocker} className="warn-text"><Icon.warning size={14} aria-hidden /> {blocker}</p>)}
    </div>
    <div className="package-actions">
      <Button variant="primary" size="lg" icon={Icon.file} busy={writing} disabled={!canWrite} onClick={onWrite}>{writing ? "Writing…" : pkg ? "Write new prompt package" : "Write prompt package"}</Button>
      {overview.packageBlockers.some((item) => item.includes("Locations")) && <Button variant="link" iconEnd={Icon.next} onClick={() => onNavigate("Locations")}>Go to Locations</Button>}
      {overview.packageBlockers.some((item) => item.includes("Plan page")) && <Button variant="link" iconEnd={Icon.next} onClick={() => onNavigate("Plan")}>Go to Plan</Button>}
    </div>
  </section>;
}

function QueueBanner({ overview, failedClip, active, canQueue, pending, onRemaining, onRetry }: {
  overview: ProduceOverview; failedClip: ProduceClip | null; active: boolean; canQueue: boolean; pending: boolean; onRemaining(): void; onRetry(index: number): void;
}) {
  const queue = overview.queue;
  if (!queue || active) return null;
  const remaining = overview.counts.remaining;
  if (queue.status === "interrupted") {
    return <Notice tone="warn" live title="The last queue was interrupted when Martini Shot closed."
      actions={remaining > 0 ? <Button variant="primary" size="sm" icon={Icon.render} disabled={!canQueue || pending} onClick={onRemaining}>Queue remaining {remaining} clip{remaining === 1 ? "" : "s"}</Button> : undefined}>
      <p>{queue.completed} of {queue.target} queued clips finished. It does not resume on its own.</p>
    </Notice>;
  }
  if (queue.status === "failed") {
    return <Notice tone="error" live title="Rendering stopped."
      actions={<>
        {failedClip && <Button variant="primary" size="sm" icon={Icon.retry} disabled={pending || !!overview.renderBlockers.filter((item) => !item.startsWith("Every clip")).length} onClick={() => onRetry(failedClip.index)}>Retry clip {failedClip.index}</Button>}
        {remaining > 0 && !failedClip && <Button variant="secondary" size="sm" icon={Icon.render} disabled={!canQueue || pending} onClick={onRemaining}>Queue remaining {remaining}</Button>}
      </>}>
      <p className="selectable">{queue.message}</p>
    </Notice>;
  }
  if (queue.status === "stopped") return <Notice tone="info">{queue.message}</Notice>;
  return null;
}

function ClipGlyph({ status }: { status: ProduceClip["status"] }) {
  if (status === "rendered") return <Icon.check size={13} aria-hidden />;
  if (status === "rendering") return <Icon.render size={12} aria-hidden />;
  if (status === "failed" || status === "interrupted") return <Icon.warning size={12} aria-hidden />;
  if (status === "queued") return <Icon.queued size={12} aria-hidden />;
  return null;
}

function Timeline({ overview, peaks, focus, onFocus }: { overview: ProduceOverview; peaks: number[] | null; focus: number | null; onFocus(index: number): void }) {
  const duration = overview.durationSeconds || overview.clips[overview.clips.length - 1]?.end || 0;
  const phases: { phase: string; first: number; last: number; start: number; end: number }[] = [];
  for (const section of overview.sections) {
    const last = phases[phases.length - 1];
    if (section.phase && last?.phase === section.phase) { last.last = section.number; last.end = section.end; }
    else if (section.phase) phases.push({ phase: section.phase, first: section.number, last: section.number, start: section.start, end: section.end });
  }
  const pct = (value: number) => (duration ? `${(value / duration) * 100}%` : "0%");
  return <section className="panel produce-timeline" aria-label="Song timeline">
    <div className="tl-grid">
      <span className="tl-label" aria-hidden />
      <div className="tl-track">
        {phases.length > 0 && <div className="tl-row tl-phases">{phases.map((phase) => <span key={`${phase.phase}-${phase.first}`} className={cx("tl-phase", PHASE_CLASS[phase.phase])}
          style={{ left: pct(phase.start), width: pct(phase.end - phase.start) }}>{phase.phase} ({phase.first === phase.last ? phase.first : `${phase.first} – ${phase.last}`})</span>)}</div>}
      </div>
      <span className="tl-label"><Icon.song size={18} aria-hidden /></span>
      <div className="tl-track">
        <div className="tl-wave" aria-hidden>{peaks ? peaks.map((peak, index) => <i key={index} style={{ height: `${Math.max(6, peak * 100)}%` }} />) : <span className="muted small">Waveform unavailable</span>}</div>
        <div className="tl-times num"><span>0:00</span><span>{formatDuration(duration)}</span></div>
      </div>
      {overview.sections.length > 0 && <><span className="tl-label">Sections</span>
        <div className="tl-track"><div className="tl-row tl-sections">{overview.sections.map((section) => <span key={section.number} className={cx("tl-section", PHASE_CLASS[section.phase ?? ""])}
          style={{ left: pct(section.start), width: pct(section.end - section.start) }} title={`Section ${section.number}${section.label ? ` (${section.label})` : ""}`}>{section.number}</span>)}</div></div></>}
      <span className="tl-label">Clips</span>
      <div className="tl-track"><div className="tl-row tl-clips">{overview.clips.map((clip) => {
        const label = `Clip ${clip.index}: ${STATUS_TEXT[clip.status]}${clip.section ? ` · section ${clip.section}` : ""}${clip.location ? ` · ${clip.location}` : ""}`;
        return <button key={clip.index} type="button" className={cx("tl-clip", clip.status, focus === clip.index && "focus")}
          style={{ left: pct(clip.start), width: `calc(${pct(clip.end - clip.start)} - 3px)` }} onClick={() => onFocus(clip.index)}
          aria-label={label} aria-pressed={focus === clip.index} title={label}><ClipGlyph status={clip.status} /></button>;
      })}</div></div>
    </div>
    <div className="tl-legend muted small">
      <span><i className="rendered" /><Icon.check size={12} aria-hidden /> rendered</span><span><i className="rendering" /><Icon.render size={12} aria-hidden /> rendering</span>
      <span><i className="queued" /><Icon.queued size={12} aria-hidden /> queued</span><span><i className="failed" /><Icon.warning size={12} aria-hidden /> failed</span><span><i /> not rendered</span>
      <span className="tl-hint">Select a clip to see its details.</span>
    </div>
  </section>;
}

function CurrentClip({ clip, projectId, active, now, pending, canRetry, canRender, preview, onRender, onRetry, onRerender, onCopy, onCopyError }: {
  clip: ProduceClip; projectId: string; active: boolean; now: number; pending: boolean; canRetry: boolean; canRender: boolean; preview: LivePreview | null;
  onRender(): void; onRetry(): void; onRerender(): void; onCopy(): Promise<unknown>; onCopyError(reason: unknown): void;
}) {
  const attempt = clip.lastAttempt;
  // ComfyUI's own WebSocket tells us which node is running and its step count, locally and on a remote worker.
  const live = attempt?.phase === "running" ? attempt.step : null;
  const stepText = live ? `${live.label}${live.max ? ` ${live.value}/${live.max}` : "…"}` : null;
  const phaseText = attempt?.phase === "queued" ? "Queued in ComfyUI…" : attempt?.phase === "cleanup" ? "Cleaning up ComfyUI…" : attempt?.phase === "running" ? stepText ?? "Rendering…" : attempt?.phase === "waiting" ? "Sending to ComfyUI…" : STATUS_TEXT[clip.status];
  return <section className="panel current-clip">
    <PanelHead icon={Icon.film} title={active ? "Current clip (rendering)" : `Clip ${clip.index}`}
      aside={active && attempt ? <ClipState status={clip.status}>{`${phaseText}${attempt.submittedAt ? ` ${elapsed(attempt.submittedAt, now)}` : ""}`}</ClipState> : <ClipState status={clip.status} />} />
    <div className="clip-body">
      <div className="clip-preview">{clip.status === "rendered" && clip.outputPath
        ? <video src={`martini-asset://clip/${encodeURIComponent(projectId)}/${clip.index}?v=${encodeURIComponent(clip.lastAttempt?.finishedAt ?? clip.outputPath)}`} controls preload="metadata" />
        : preview ? <><img src={preview.url} alt={`Live sampler preview for clip ${clip.index}`} /><span className="preview-caption">Sampling {preview.step}/{preview.total}{preview.frames > 1 ? ` · ${preview.frames}-frame preview` : ""}</span></>
          : <span className="muted small preview-empty"><Icon.film size={22} aria-hidden />{clip.status !== "rendering" ? "Not rendered yet."
            : live ? <span className="step-progress"><span>{live.label}{live.max ? <b className="num"> · step {live.value} of {live.max}</b> : "…"}</span>
              {live.max ? <ProgressBar value={Math.round(((live.value ?? 0) / live.max) * 100)} label={`${live.label} progress`} /> : null}</span>
            : "Rendering… waiting for ComfyUI to report progress."}</span>}</div>
      <div className="clip-meta">
        <h3 className="clip-title num">{clip.section ? `Section ${clip.section}` : "Section unknown"} <span className="sep">/</span> Clip {clip.index}</h3>
        <dl>
          <div><dt><Icon.locations size={14} aria-hidden />Location</dt><dd>{clip.location || (clip.metadataMatched ? "—" : "unknown")}</dd></div>
          <div><dt><Icon.produce size={14} aria-hidden />Mode</dt><dd><ModeChip mode={clip.mode} /></dd></div>
          <div><dt><Icon.film size={14} aria-hidden />Action</dt><dd>{clip.action || (clip.metadataMatched ? "Director's choice in the prompt" : "unknown")}</dd></div>
          <div><dt><Icon.next size={14} aria-hidden />Continuity</dt><dd>{clip.continuity}</dd></div>
          <div><dt><Icon.song size={14} aria-hidden />Song</dt><dd className="num">{formatTime(clip.start)} – {formatTime(clip.end)}{clip.attempts ? ` · ${clip.attempts} attempt${clip.attempts === 1 ? "" : "s"}` : ""}</dd></div>
          <div><dt><Icon.folder size={14} aria-hidden />Output</dt><dd>{clip.outputPath
            ? <div className="path-field"><code className="path" title={clip.outputPath}>{clip.outputPath}</code><CopyButton label="Copy output path" copy={onCopy} onError={onCopyError} size="sm" /></div>
            : <code className="path muted single-line" title={clip.promptPath.replace(/[^\\/]+$/, "")}>{clip.promptPath.replace(/[^\\/]+$/, "")}</code>}</dd></div>
        </dl>
        {clip.error && <p className="error-text">{clip.error}</p>}
        {clip.status === "pending" && <Button variant="primary" size="sm" icon={Icon.render} disabled={!canRender || pending} onClick={onRender}>Render clip {clip.index}</Button>}
        {(clip.status === "failed" || clip.status === "interrupted") && <Button variant="primary" size="sm" icon={Icon.retry} disabled={!canRetry || pending} onClick={onRetry}>Retry clip {clip.index}</Button>}
        {clip.status === "rendered" && <Button variant="secondary" size="sm" icon={Icon.render} disabled={!canRetry || pending} onClick={onRerender}>Re-render clip {clip.index}</Button>}
      </div>
    </div>
  </section>;
}

function Decisions({ clip, detail, planEvidence }: { clip: ProduceClip | null; detail?: ClipDetail; planEvidence: DecisionRow[] }) {
  const rows = detail && clip && detail.index === clip.index ? detail.decisions : planEvidence;
  return <section className="panel decisions">
    <PanelHead icon={Icon.plan} title={<>Director decisions{clip ? <span className="muted panel-subtitle"> (clip {clip.index})</span> : null}</>} />
    {rows.length ? <ul>{rows.map((row) => <li key={row.label} className={row.tone}>
      <ToneMark tone={row.tone} /><b>{row.label}</b><span className="value selectable">{row.value}</span><time className="num">{timeOf(row.at)}</time>
    </li>)}</ul> : <p className="muted">No decisions recorded yet.</p>}
  </section>;
}

type ShotDraft = {
  scene: ClipMode; camera: ClipShotSettings["camera"]; cameraText: string; refs: Partial<Record<ClipRefRole, string>>;
  locationText: string; lipSync: boolean; soundscape: string; ending: string;
};
const ROLE_LABEL: Record<ClipRefRole, string> = { person: "Performer", outfit: "Outfit", location: "Location" };
const ROLE_ICON: Record<ClipRefRole, LucideIcon> = { person: Icon.performer, outfit: Icon.outfit, location: Icon.locations };
const PERFORMER_SCENES: ClipMode[] = ["Dance", "Performance", "Freeform"];
const LLM_CAMERA = "LLM picks (experimental)";

function draftOf(shot: ClipShotSettings): ShotDraft {
  return {
    scene: shot.scene, camera: shot.camera, cameraText: shot.camera === "Custom" ? shot.cameraText : "", refs: { ...shot.refs },
    locationText: shot.locationText, lipSync: shot.lipSync, soundscape: shot.soundscape, ending: shot.ending,
  };
}

/** Only the settings the user actually changed. */
function shotChanges(shot: ClipShotSettings, draft: ShotDraft): ClipChanges {
  const changes: ClipChanges = {};
  if (draft.scene !== shot.scene) changes.scene = draft.scene;
  if (draft.camera !== "Continue" && (draft.camera !== shot.camera || (draft.camera === "Custom" && draft.cameraText.trim() !== shot.cameraText.trim()))) {
    changes.camera = draft.camera === "Custom" ? { name: "Custom", text: draft.cameraText } : { name: draft.camera };
  }
  const refs = Object.fromEntries(Object.entries(draft.refs).filter(([role, file]) => shot.refs[role as ClipRefRole] !== file));
  if (Object.keys(refs).length) changes.refs = refs;
  if (draft.locationText.trim() !== shot.locationText.trim()) changes.locationText = draft.locationText;
  if (draft.lipSync !== shot.lipSync) changes.lipSync = draft.lipSync;
  if (draft.soundscape.trim() !== shot.soundscape.trim()) changes.soundscape = draft.soundscape;
  if (draft.ending.trim() !== shot.ending.trim()) changes.ending = draft.ending;
  return changes;
}

function PromptWorkshop({ clip, detail, disabled, projectId, onRevise, onSectionSaved, onError }: {
  clip: ProduceClip; detail?: ClipDetail; disabled: boolean; projectId: string; onRevise(request: ClipRevisionRequest): Promise<boolean>;
  onSectionSaved(overview: ProduceOverview): void; onError(message: string): void;
}) {
  const current = detail?.index === clip.index ? detail : undefined;
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState<ShotDraft | null>(null);
  const [confirm, setConfirm] = useState<ClipRevisionRequest | null>(null);
  useEffect(() => {
    setText(current?.creativeText ?? "");
    setDraft(current?.shot ? draftOf(current.shot) : null);
  }, [current?.index, current?.creativeRevision, current?.creativeText]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setNote(""), [current?.index, current?.creativeRevision]);
  if (!current) return <section className="panel prompt-workshop"><PanelHead icon={Icon.retry} title="Prompt workshop" /><p className="muted">Loading the clip’s editable director direction…</p></section>;
  if (current.creativeText === null) return <section className="panel prompt-workshop"><PanelHead icon={Icon.retry} title="Prompt workshop" /><p className="muted">This older prompt package has no editable clip source. Write a fresh prompt package to enable one-clip revisions.</p></section>;

  const shot = current.shot;
  const changes = shot && draft ? shotChanges(shot, draft) : {};
  const changedSettings = Object.keys(changes).length > 0;
  const needsTake = changes.scene !== undefined || changes.camera?.name === LLM_CAMERA;
  const swaps = Boolean(changes.refs) || changes.locationText !== undefined;
  const customMissing = draft?.camera === "Custom" && !draft.cameraText.trim();
  const directionChanged = text.trim() !== current.creativeText.trim();
  const affected = [...new Set([...current.rerenderWith, ...(swaps ? current.followers : [])])].sort((a, b) => a - b);
  const later = affected.filter((index) => index !== clip.index);
  const set = (patch: Partial<ShotDraft>) => setDraft((value) => value && { ...value, ...patch });

  const submit = (request: ClipRevisionRequest) => {
    // A swap is carried into the clips that continue this shot; the user confirms that before anything changes.
    if (request.changes && (request.changes.refs || request.changes.locationText !== undefined) && (current.followers.length || current.continuesFrom !== null)) {
      setConfirm(request);
      return;
    }
    void onRevise(request);
  };
  const withChanges = (request: ClipRevisionRequest): ClipRevisionRequest => (changedSettings ? { ...request, changes } : request);
  const swapped = (Object.keys(changes.refs ?? {}) as ClipRefRole[]).map((role) => ROLE_LABEL[role].toLowerCase());
  if (changes.locationText !== undefined && !swapped.includes("location")) swapped.push("location details");

  return <section className="panel prompt-workshop">
    <PanelHead icon={Icon.retry} title="Prompt workshop" aside={<span className="muted small">Revision {current.creativeRevision ?? 0}</span>} />

    {current.sectionAction && <div className="section-row">
      <h3 className="workshop-heading">Section {current.sectionAction.section} action</h3>
      <p className="muted small">Shared by every clip in the section. Changing it rewrites their prompts with the local LLM and marks them for re-render.</p>
      <SectionActionEditor projectId={projectId} section={current.sectionAction.section} action={current.sectionAction.action}
        plannerAction={current.sectionAction.plannerAction} disabled={disabled} compact onSaved={onSectionSaved} onError={onError} />
    </div>}

    {shot && draft && <div className="shot-settings">
      <h3 className="workshop-heading">Shot settings</h3>
      <div className="shot-grid">
        <label className="field-stack"><span><Icon.produce size={14} aria-hidden /> Scene type</span>
          <select className="select" value={draft.scene} disabled={disabled || !PERFORMER_SCENES.includes(shot.scene)} onChange={(event) => set({ scene: event.target.value as ClipMode })}>
            {(PERFORMER_SCENES.includes(shot.scene) ? PERFORMER_SCENES : [shot.scene]).map((scene) => <option key={scene} value={scene}>{scene}</option>)}
          </select></label>
        <label className="field-stack"><span><Icon.film size={14} aria-hidden /> Camera</span>
          <select className="select" value={draft.camera} disabled={disabled} onChange={(event) => set({ camera: event.target.value as ShotDraft["camera"] })}>
            {shot.camera === "Continue" && <option value="Continue">Same as clip {clip.index - 1} (continues the shot)</option>}
            {CLIP_CAMERAS.map((name) => <option key={name} value={name}>{name === LLM_CAMERA ? "LLM picks" : name}</option>)}
          </select></label>
        {(Object.keys(shot.refs) as ClipRefRole[]).map((role) => {
          const Glyph = ROLE_ICON[role];
          const options = shot.options.filter((option) => option.role === role);
          return <label key={role} className="field-stack"><span><Glyph size={14} aria-hidden /> {ROLE_LABEL[role]}</span>
            <select className="select" value={draft.refs[role] ?? ""} disabled={disabled || options.length < 2} onChange={(event) => {
              const option = options.find((item) => item.file === event.target.value);
              set({ refs: { ...draft.refs, [role]: event.target.value }, ...(role === "location" && option?.locationText !== undefined ? { locationText: option.locationText } : {}) });
            }}>{options.map((option) => <option key={option.file} value={option.file}>{option.name}</option>)}</select></label>;
        })}
        <div className="field-stack"><span><Icon.song size={14} aria-hidden /> Lip sync</span>
          <span className="switch-row">{shot.lipSyncAvailable && !disabled && <Switch checked={draft.lipSync} label="Lip sync" onChange={(lipSync) => set({ lipSync })} />}
            <span className="muted small">{shot.lipSyncAvailable ? (draft.lipSync ? "Sings the lyrics in this clip" : "Not singing") : "No sung lyrics in this clip"}</span></span>
        </div>
      </div>
      {draft.camera === "Custom" && <label className="field-stack"><span>Custom camera</span>
        <input className="input" value={draft.cameraText} disabled={disabled} placeholder="e.g. A low-angle medium shot slowly tracks left with her." onChange={(event) => set({ cameraText: event.target.value })} /></label>}
      {draft.camera !== "Custom" && draft.camera === shot.camera && shot.cameraText && <p className="muted small camera-sentence">{shot.cameraText}</p>}
      {shot.camera === "Continue" && draft.camera !== "Continue" && <p className="warn-text small"><Icon.warning size={14} aria-hidden /> Clip {clip.index} continues clip {clip.index - 1} without a cut; a new camera here reads as a jump.</p>}
      {"location" in shot.refs && <label className="field-stack"><span>Location details</span>
        <input className="input" value={draft.locationText} disabled={disabled} onChange={(event) => set({ locationText: event.target.value })} /></label>}
      <label className="field-stack"><span>Soundscape</span>
        <input className="input" value={draft.soundscape} disabled={disabled} placeholder="Sounds in the scene, not the music" onChange={(event) => set({ soundscape: event.target.value })} /></label>
      <label className="field-stack"><span>Ending state{shot.endingOverridden ? " (set by you)" : ""}</span>
        <input className="input" value={draft.ending} disabled={disabled} placeholder="Where the performer is and what is in progress at the last frame" onChange={(event) => set({ ending: event.target.value })} /></label>
      <div className="prompt-workshop-actions">
        <Button variant="secondary" size="sm" icon={Icon.check} disabled={disabled || !changedSettings || needsTake || customMissing}
          title={needsTake ? "A scene-type change or an LLM-picked camera needs a new take." : undefined}
          onClick={() => submit({ mode: "Apply shot settings", creativeText: "", changes })}>Apply settings</Button>
        {changedSettings && <Button variant="quiet" size="sm" disabled={disabled} onClick={() => setDraft(draftOf(shot))}>Undo changes</Button>}
        {needsTake && <span className="muted small">{changes.scene !== undefined ? "A new scene type" : "An LLM-picked camera"} needs a new take below.</span>}
      </div>
    </div>}

    <div className="take-row">
      <h3 className="workshop-heading">New take</h3>
      <label className="field-stack"><span>What should change? <span className="muted">(optional)</span></span>
        <input className="input" value={note} disabled={disabled} maxLength={2000} placeholder="e.g. closer on her hands, less spinning, she stays seated"
          onChange={(event) => setNote(event.target.value)} /></label>
      <div className="prompt-workshop-actions">
        <Button variant="primary" size="sm" icon={Icon.reroll} disabled={disabled || customMissing} onClick={() => submit(withChanges({ mode: "Try another take", creativeText: note }))}>
          Try another take{changedSettings ? " with these settings" : ""}</Button>
      </div>
    </div>

    <div className="direction-row">
      <h3 className="workshop-heading">Creative direction</h3>
      <textarea className="input prompt-editor" value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} aria-label={`Creative direction for clip ${clip.index}`} />
      <div className="prompt-workshop-actions">
        <Button variant="secondary" size="sm" icon={Icon.save} disabled={disabled || !directionChanged || !text.trim() || customMissing || needsTake}
          title={needsTake ? "A scene-type change or an LLM-picked camera needs a new take." : undefined}
          onClick={() => submit(withChanges({ mode: "Apply manual direction", creativeText: text }))}>Save edited direction</Button>
      </div>
    </div>

    <p className="muted small">Martini Shot keeps timing, audio, and MiniMax formatting intact. Any change marks clip {clip.index}{later.length ? ` and clip${later.length === 1 ? "" : "s"} ${later.join(", ")}` : ""} for re-render; existing videos move to the package’s <code>superseded</code> folder.</p>
    {current.prompt && <Disclosure summary="Final MiniMax prompt (read-only)"><pre className="log">{current.prompt}</pre></Disclosure>}

    {confirm && <ConfirmDialog title={`Change the ${swapped.join(" and ")} for more than clip ${clip.index}?`} confirmLabel="Apply to these clips" confirmIcon={Icon.check} confirmVariant="primary"
      onCancel={() => setConfirm(null)} onConfirm={() => { const request = confirm; setConfirm(null); void onRevise({ ...request, confirmDownstream: true }); }}>
      {current.followers.length > 0 && <p>Clip{current.followers.length === 1 ? "" : "s"} <b className="num">{current.followers.join(", ")}</b> continue{current.followers.length === 1 ? "s" : ""} this shot without a hard cut, so {current.followers.length === 1 ? "it gets" : "they get"} the same {swapped.join(" and ")}. Their action text stays as it is.</p>}
      {current.continuesFrom !== null && <p className="warn-text"><Icon.warning size={14} aria-hidden /> Clip {clip.index} continues from clip {current.continuesFrom}, which keeps the old {swapped.join(" and ")}. The change will show at the start of this clip, mid-shot.</p>}
      <p className="muted small">Clip{affected.length === 1 ? "" : "s"} {affected.join(", ")} will need rendering again. Existing videos move to the package’s <code>superseded</code> folder; nothing is deleted.</p>
    </ConfirmDialog>}
  </section>;
}

function QueueTable({ overview, active, onFocus }: { overview: ProduceOverview; active: boolean; onFocus(index: number): void }) {
  const indexes = active ? overview.upcoming : overview.clips.filter((clip) => clip.status !== "rendered").map((clip) => clip.index);
  const rows = indexes.map((index) => overview.clips.find((clip) => clip.index === index)).filter((clip): clip is ProduceClip => Boolean(clip)).slice(0, 5);
  return <section className="panel queue-table">
    <PanelHead icon={Icon.phases} title={active ? "Render queue — next clips" : "Next clips to render"}
      aside={<span className="num">{overview.counts.total} total · {overview.counts.rendered} complete · {overview.counts.remaining} remaining</span>} />
    {rows.length ? <table className="data-table"><thead><tr><th>#</th><th>Section</th><th>Location</th><th>Mode</th><th>Action (summary)</th><th>Continuity</th><th>State</th></tr></thead>
      <tbody>{rows.map((clip) => <tr key={clip.index} className="clickable" onClick={() => onFocus(clip.index)}>
        <td className="num"><Button variant="link" onClick={() => onFocus(clip.index)} aria-label={`Show clip ${clip.index} details`}>{clip.index}</Button></td>
        <td className="num">{clip.section ?? "—"}</td>
        <td><span className="cell-icon"><Icon.locations size={14} aria-hidden />{clip.location || "—"}</span></td>
        <td><ModeChip mode={clip.mode} /></td>
        <td className="summary" title={clip.action || undefined}><span>{clip.action || "—"}</span></td><td>{clip.transition || "—"}</td><td><ClipState status={clip.status} /></td>
      </tr>)}</tbody></table> : <p className="muted">Nothing left to render.</p>}
  </section>;
}

function TechnicalLog({ overview, detail }: { overview: ProduceOverview; detail?: ClipDetail }) {
  const pkg = overview.package;
  return <section className="panel technical-log">
    <Disclosure icon={Icon.log} summary={<>Technical log <span className="muted small">ComfyUI attempts, cleanup, and node reports</span></>}>
      <h3 className="log-heading">Events</h3>
      {overview.events.length ? <ul className="events">{overview.events.map((event) => <li key={event.id}><time className="num">{formatWhen(event.at)}</time><code>{event.category}</code><span>{event.body}</span></li>)}</ul> : <p className="muted">No production events yet.</p>}
      {detail && <>
        <h3 className="log-heading">Clip {detail.index}: attempts</h3>
        {detail.attempts.length ? <ul className="events">{detail.attempts.map((attempt) => <li key={attempt.id}>
          <time className="num">{formatWhen(attempt.startedAt)}</time><code>#{attempt.attempt} {attempt.loaderMode}</code>
          <span>{attempt.status}{attempt.promptId ? ` · prompt ${attempt.promptId}` : ""} · seed {attempt.noiseSeed} · cleanup {attempt.cleanup}{attempt.error ? ` · ${attempt.error}` : ""}{attempt.loaderReport ? `\n${attempt.loaderReport}` : ""}</span>
        </li>)}</ul> : <p className="muted">Not rendered yet.</p>}
        {detail.warnings.length > 0 && <><h3 className="log-heading">Clip {detail.index}: prompt-writer notes</h3><pre className="log">{detail.warnings.join("\n")}</pre></>}
        {detail.prompt && <Disclosure summary={`Clip ${detail.index} prompt (diagnostic, read-only)`}><pre className="log">{detail.prompt}</pre></Disclosure>}
      </>}
      {pkg && <>
        {pkg.polish.length > 0 && <Disclosure summary="Style bible, section hooks, camera pass"><pre className="log">{pkg.polish.join("\n")}</pre></Disclosure>}
        <Disclosure summary="Resolve Locations report"><pre className="log">{pkg.reports.resolve}</pre></Disclosure>
        <Disclosure summary="Build Production Plan report"><pre className="log">{pkg.reports.production}</pre></Disclosure>
        <Disclosure summary="Write Prompt Package report"><pre className="log">{pkg.reports.package}</pre></Disclosure>
      </>}
    </Disclosure>
  </section>;
}
