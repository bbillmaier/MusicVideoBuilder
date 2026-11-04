import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDuration, formatTime, formatWhen, readableError } from "./ProjectsView";
import { elapsed, useTicker } from "./usePlan";
import { Button, CopyButton, Disclosure, Icon, LoadingPage, NoProject, Notice, PageHeader, PanelHead, Pill, ProgressBar, ToneMark, cx, type LucideIcon, type Tone } from "./ui";

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

/** Peak bars for the song, decoded locally in the renderer from the project's read-only asset URL. */
function usePeaks(url: string | null, bars = 220): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    if (!url) { setPeaks(null); return; }
    let cancelled = false;
    (async () => {
      const buffer = await (await fetch(url)).arrayBuffer();
      const context = new AudioContext();
      try {
        const channel = (await context.decodeAudioData(buffer)).getChannelData(0);
        const step = Math.max(1, Math.floor(channel.length / bars));
        const values: number[] = [];
        for (let bar = 0; bar < bars; bar++) {
          let peak = 0;
          for (let i = bar * step; i < Math.min(channel.length, (bar + 1) * step); i += 32) peak = Math.max(peak, Math.abs(channel[i]));
          values.push(peak);
        }
        const max = Math.max(...values, 0.0001);
        if (!cancelled) setPeaks(values.map((value) => value / max));
      } finally { void context.close(); }
    })().catch(() => { if (!cancelled) setPeaks(null); });
    return () => { cancelled = true; };
  }, [url, bars]);
  return peaks;
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
    let socket: WebSocket | null = null;
    const connect = (session: LivePreviewSession) => {
      socket?.close();
      socket = null;
      setPreview(null);
      if (!session || session.projectId !== project.id) return;
      const url = new URL(session.endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/ws";
      url.search = `clientId=${encodeURIComponent(session.clientId)}`;
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        try {
          const packet = JSON.parse(String(event.data)) as { type?: string; data?: { image?: string; mime?: string; step?: number; total?: number; frames?: number } };
          const data = packet.data;
          if (packet.type !== "martini_preview" || !data?.image || !data.mime) return;
          setPreview({ clipIndex: session.clipIndex, url: `data:${data.mime};base64,${data.image}`,
            step: Number(data.step) || 0, total: Number(data.total) || 0, frames: Number(data.frames) || 1 });
        } catch { /* A non-preview ComfyUI event is irrelevant here. */ }
      };
    };
    void window.martini.produce.previewSession().then(connect).catch(() => undefined);
    const unsubscribe = window.martini.produce.onPreviewSession(connect);
    return () => { unsubscribe(); socket?.close(); };
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
  const revisePrompt = async (mode: "Try another take" | "Apply manual direction", creativeText: string) => {
    if (!shown) return;
    setPending(true);
    try {
      const result = await window.martini.produce.reviseClipPrompt(project.id, shown.index, mode, creativeText);
      setOverview(result);
      setDetail(await window.martini.produce.clipDetail(project.id, shown.index));
      setError("");
    } catch (reason) { setError(readableError(reason)); }
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
          onCopy={() => window.martini.produce.copyOutputPath(project.id, shown.index)} onCopyError={(reason) => setError(readableError(reason))} />}
        <Decisions clip={shown} detail={detail} planEvidence={overview.planEvidence} />
        {shown && <PromptWorkshop clip={shown} detail={detail} disabled={pending || active || !!otherBusy || comfyDown}
          onRevise={revisePrompt} />}
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

function CurrentClip({ clip, projectId, active, now, pending, canRetry, canRender, preview, onRender, onRetry, onCopy, onCopyError }: {
  clip: ProduceClip; projectId: string; active: boolean; now: number; pending: boolean; canRetry: boolean; canRender: boolean; preview: LivePreview | null; onRender(): void; onRetry(): void; onCopy(): Promise<unknown>; onCopyError(reason: unknown): void;
}) {
  const attempt = clip.lastAttempt;
  const phaseText = attempt?.phase === "queued" ? "Queued in ComfyUI…" : attempt?.phase === "cleanup" ? "Cleaning up ComfyUI…" : attempt?.phase === "running" ? "Rendering…" : attempt?.phase === "waiting" ? "Sending to ComfyUI…" : STATUS_TEXT[clip.status];
  return <section className="panel current-clip">
    <PanelHead icon={Icon.film} title={active ? "Current clip (rendering)" : `Clip ${clip.index}`}
      aside={active && attempt ? <ClipState status={clip.status}>{`${phaseText}${attempt.submittedAt ? ` ${elapsed(attempt.submittedAt, now)}` : ""}`}</ClipState> : <ClipState status={clip.status} />} />
    <div className="clip-body">
      <div className="clip-preview">{clip.status === "rendered" && clip.outputPath
        ? <video src={`martini-asset://clip/${encodeURIComponent(projectId)}/${clip.index}?v=${encodeURIComponent(clip.lastAttempt?.finishedAt ?? clip.outputPath)}`} controls preload="metadata" />
        : preview ? <><img src={preview.url} alt={`Live sampler preview for clip ${clip.index}`} /><span className="preview-caption">Sampling {preview.step}/{preview.total}{preview.frames > 1 ? ` · ${preview.frames}-frame preview` : ""}</span></>
          : <span className="muted small preview-empty"><Icon.film size={22} aria-hidden />{clip.status === "rendering" ? "Rendering… live previews are off or waiting for the first sampling step." : "Not rendered yet."}</span>}</div>
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

function PromptWorkshop({ clip, detail, disabled, onRevise }: {
  clip: ProduceClip; detail?: ClipDetail; disabled: boolean;
  onRevise(mode: "Try another take" | "Apply manual direction", creativeText: string): void;
}) {
  const current = detail?.index === clip.index ? detail : undefined;
  const [text, setText] = useState("");
  useEffect(() => setText(current?.creativeText ?? ""), [current?.index, current?.creativeRevision, current?.creativeText]);
  if (!current) return <section className="panel prompt-workshop"><PanelHead icon={Icon.retry} title="Prompt workshop" /><p className="muted">Loading the clip’s editable director direction…</p></section>;
  if (current.creativeText === null) return <section className="panel prompt-workshop"><PanelHead icon={Icon.retry} title="Prompt workshop" /><p className="muted">This older prompt package has no editable clip source. Write a fresh prompt package to enable one-clip revisions.</p></section>;
  const changed = text.trim() !== current.creativeText.trim();
  return <section className="panel prompt-workshop">
    <PanelHead icon={Icon.retry} title="Prompt workshop" aside={<span className="muted small">Revision {current.creativeRevision ?? 0}</span>} />
    <p className="muted small">Edit the director’s creative direction for this clip. Martini Shot keeps references, timing, audio, continuity, and MiniMax formatting intact.</p>
    <textarea className="input prompt-editor" value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} aria-label={`Creative direction for clip ${clip.index}`} />
    <div className="prompt-workshop-actions">
      <Button variant="secondary" size="sm" icon={Icon.retry} disabled={disabled} onClick={() => onRevise("Try another take", text)}>Try another take</Button>
      <Button variant="primary" size="sm" icon={Icon.save} disabled={disabled || !changed || !text.trim()} onClick={() => onRevise("Apply manual direction", text)}>Save edited direction</Button>
    </div>
    <p className="muted small">Saving marks this clip{clip.continuity ? " and any later clips that inherit its motion" : ""} for re-render. Existing videos are kept in the package’s <code>superseded</code> folder.</p>
    {current.prompt && <Disclosure summary="Final MiniMax prompt (read-only)"><pre className="log">{current.prompt}</pre></Disclosure>}
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
