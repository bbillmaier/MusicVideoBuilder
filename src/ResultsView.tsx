import { useCallback, useEffect, useRef, useState } from "react";
import { formatDuration, formatTime, formatWhen, readableError } from "./ProjectsView";
import { elapsed, useTicker } from "./usePlan";
import { Button, ConfirmDialog, CopyButton, Dialog, Disclosure, Icon, IconButton, LoadingPage, NoProject, Notice, PanelHead, Pill, ToneMark, cx, type LucideIcon } from "./ui";

type Nav = "Projects" | "Plan" | "Produce";
type Props = { project: ProjectDetail | null; comfy?: ComfyStatus; onNavigate(view: Nav): void };

const STATE_WORD: Record<FinalState, string> = {
  complete: "completed", stitching: "stitching locally", ready: "ready to stitch", blocked: "blocked", failed: "stitch failed",
};
const PHASE_TEXT: Record<string, string> = {
  waiting: "Waiting for other Martini Shot work in ComfyUI to finish…",
  queued: "Queued in ComfyUI…",
  running: "Finalize Video is joining the clips with the original song in ComfyUI…",
  cleanup: "Stitched. Sending /free to ComfyUI and waiting for its cleanup cycle…",
};
const PHASE_CLASS: Record<string, string> = { Arrival: "arrival", Friction: "friction", Escalation: "escalation", Break: "break", Release: "release" };
const SECTION_ICON: Record<string, LucideIcon> = {
  inputs: Icon.projects, plan: Icon.plan, wheel: Icon.storyWheel, creative: Icon.direction, locations: Icon.locations,
  production: Icon.file, render: Icon.produce, stitch: Icon.film,
};

function bytes(value: number | null): string {
  if (value === null) return "not available";
  if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function useResults(projectId: string, comfyConnected: boolean | undefined) {
  const [overview, setOverview] = useState<ResultsOverview>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setOverview(await window.martini.results.overview(projectId)); setError(""); }
    catch (reason) { setError(readableError(reason)); }
  }, [projectId]);
  useEffect(() => {
    void refresh();
    const onChange = (changed: string) => { if (changed === projectId) void refresh(); };
    const offs = [window.martini.results.onChanged(onChange), window.martini.produce.onChanged(onChange), window.martini.plan.onChanged(onChange),
      window.martini.locations.onChanged(onChange), window.martini.projects.onChanged(onChange)];
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { offs.forEach((off) => off()); window.removeEventListener("focus", onFocus); };
  }, [projectId, refresh]);
  // The header's ComfyUI check runs every 20 s; follow it so a stopped or restarted ComfyUI shows here too.
  useEffect(() => { void refresh(); }, [comfyConnected, refresh]);
  return { overview, setOverview, error, setError };
}

export function ResultsView({ project, comfy, onNavigate }: Props) {
  if (!project) return <NoProject text="Open a project and render its clips. The finished video and the director's report appear here." onProjects={() => onNavigate("Projects")} />;
  return <ResultsContent key={project.id} project={project} comfy={comfy} onNavigate={onNavigate} />;
}

function ResultsContent({ project, comfy, onNavigate }: { project: ProjectDetail; comfy?: ComfyStatus; onNavigate(view: Nav): void }) {
  const { overview, setOverview, error, setError } = useResults(project.id, comfy?.connected);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<"rerender" | "reroll" | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  const stitching = overview?.state === "stitching";
  const now = useTicker(Boolean(stitching));

  const act = async (work: () => Promise<unknown>, done?: (value: unknown) => void) => {
    setNotice(""); setPending(true);
    try { const value = await work(); done?.(value); setError(""); }
    catch (reason) { setError(readableError(reason)); }
    finally { setPending(false); }
  };

  if (!overview) return error ? <div className="page"><Notice tone="error" title="Results could not be loaded" live>{error}</Notice></div> : <LoadingPage text="Reading the results…" />;

  const { final, latestAttempt: latest, outcome } = overview;
  const finalId = final?.id ?? null;
  const shownIsCurrent = Boolean(final && latest && final.id === latest.id && overview.state === "complete");
  const exportReport = () => void act(() => window.martini.results.exportReport(project.id, overview.state === "complete" ? finalId : null), (file) => setNotice(`Report saved to ${String(file)}`));

  return <div className="page results-page">
    <header className="page-head results-head">
      <div className="page-title">
        <span className="page-icon" aria-hidden><Icon.results size={22} /></span>
        <div className="page-title-text">
          <h1>{overview.projectName} <span className={cx("state-word", overview.state)}>— {STATE_WORD[overview.state]}</span></h1>
          <p className="crumb">
            {final?.completedAt ? <>Completed: {formatWhen(final.completedAt)}</> : overview.package ? <span className="num">{overview.counts.rendered} of {overview.counts.total} clips rendered</span> : "No prompt package yet"}
          </p>
        </div>
        <div className="page-status">
          {overview.state === "stitching" && <Pill size="lg" tone="working">Stitching</Pill>}
          {final && <Pill size="lg" tone="info" icon={Icon.local} title="Every step ran in the local ComfyUI. Nothing was uploaded.">Rendered locally</Pill>}
        </div>
      </div>
      <div className="row-actions">
        <Button variant={final ? "primary" : "secondary"} icon={Icon.render} disabled={!final || pending} onClick={() => finalId && void act(() => window.martini.results.openVideo(project.id, finalId))}>Open video</Button>
        <Button variant="secondary" icon={Icon.openFolder} disabled={!final || pending} onClick={() => finalId && void act(() => window.martini.results.openFolder(project.id, finalId))}>Open output folder</Button>
        <Button variant="secondary" icon={Icon.file} disabled={pending} onClick={exportReport}>Export report</Button>
      </div>
    </header>

    {error && <Notice tone="error" live onDismiss={() => setError("")}>{error}</Notice>}
    {notice && <Notice tone="ok" live onDismiss={() => setNotice("")}><p className="selectable">{notice}</p></Notice>}

    {outcome && outcome.clipsTotal > 0 && <div className="outcome-banner">
      <span><Icon.film size={22} aria-hidden /><b className="num">{outcome.clipsRendered}</b> {outcome.clipsRendered === outcome.clipsTotal ? "clips rendered" : `of ${outcome.clipsTotal} clips rendered`}</span>
      <span><Icon.locations size={22} aria-hidden /><b className="num">{outcome.performerLocations}</b> performer location{outcome.performerLocations === 1 ? "" : "s"} used</span>
      <span><Icon.outfit size={22} aria-hidden /><b className="num">{outcome.outfits}</b> outfit{outcome.outfits === 1 ? "" : "s"} used</span>
      {outcome.requiredEvent && <span><Icon.event size={22} aria-hidden /><b>1</b> required event ({outcome.requiredEvent.event}) placed in section {outcome.requiredEvent.sections}</span>}
    </div>}

    <div className="results-grid">
      <div className="results-main">
        <StatePanel overview={overview} now={now} pending={pending} onStitch={() => void act(() => window.martini.results.stitch(project.id), (value) => setOverview(value as ResultsOverview))}
          onProduce={() => onNavigate("Produce")} />
        {overview.notes.map((note) => <Notice key={note} tone="warn">{note}</Notice>)}

        {final ? <section className="panel player-panel">
          {!shownIsCurrent && <p className="muted small player-label"><Icon.info size={14} aria-hidden /> Showing the most recent finished video: {final.fileName}{final.packageCurrent ? "" : " (from an earlier prompt package)"}.</p>}
          <Player key={final.id} final={final} player={player} onOpen={() => void act(() => window.martini.results.openVideo(project.id, final.id))}
            onFolder={() => void act(() => window.martini.results.openFolder(project.id, final.id))} />
          {overview.filmstrip.length > 0 && <div className="filmstrip" role="group" aria-label="Representative clips">
            {overview.filmstrip.map((clip) => <button key={clip.index} type="button" aria-label={`Clip ${clip.index} — play from ${formatTime(clip.start)}`} title={`Clip ${clip.index} — jump to ${formatTime(clip.start)}`}
              onClick={() => { if (player.current) { player.current.currentTime = clip.start; void player.current.play().catch(() => undefined); } }}>
              <video src={`${clip.url}#t=0.4`} preload="metadata" muted playsInline />
              <span className="num">Clip {clip.index} · {formatTime(clip.start)}</span>
            </button>)}
          </div>}
          <FileFacts final={final} onCopy={() => window.martini.results.copyPath(project.id, final.id)} onCopyError={(reason) => setError(readableError(reason))}
            onReveal={() => void act(() => window.martini.results.revealVideo(project.id, final.id))} />
        </section> : overview.state !== "blocked" && overview.state !== "ready" ? null : <section className="panel player-empty">
          <Icon.film size={28} aria-hidden />
          <p className="muted">No final video yet. {overview.state === "ready" ? "Stitch final video joins the rendered clips with the song." : "It can be stitched once every clip is rendered."}</p>
        </section>}

        <Attention items={overview.attention} />

        {overview.package && <TestVideos overview={overview} projectId={project.id} pending={pending} act={act}
          onStitch={() => void act(() => window.martini.results.stitchTests(project.id), (value) => setOverview(value as ResultsOverview))} />}

        <section className="panel run-again">
          <h2 className="run-again-title"><Icon.refresh size={22} aria-hidden />Run again</h2>
          <div className="run-again-grid">
            <Button variant="outline-blue" icon={Icon.render} disabled={!overview.rerender.available || pending} onClick={() => setDialog("rerender")}>Re-render unchanged plan</Button>
            <p>Renders clips again from the same story, director plan, location choices, and prompts. {overview.rerender.reason && <span className="muted">({overview.rerender.reason})</span>}</p>
            <Button variant="outline-pink" icon={Icon.reroll} disabled={!overview.reroll.available || pending} onClick={() => setDialog("reroll")}>Reroll director plan</Button>
            <p className="warn-line"><Icon.warning size={15} aria-hidden /><span>Creates a new story, section breakdown, and location plan. This changes the video's narrative and scenes. {overview.reroll.reason && <span className="muted">({overview.reroll.reason})</span>}</span></p>
          </div>
        </section>

        {overview.history.length > 0 && <History overview={overview} projectId={project.id} act={act} />}
      </div>

      <Report report={overview.report} pending={pending}
        onCopy={() => window.martini.results.copyReport(project.id, overview.state === "complete" ? finalId : null)} onCopyError={(reason) => setError(readableError(reason))}
        onExport={exportReport} />
    </div>

    {dialog === "rerender" && <RerenderDialog total={overview.rerender.clipCount} onCancel={() => setDialog(null)} onConfirm={(request) => {
      setDialog(null);
      void act(() => window.martini.results.rerender(project.id, request), (value) => {
        const result = value as RerenderResult;
        if (result.queueError) setError(`The clips were reset for re-rendering, but the queue did not start: ${result.queueError} Queue them on Produce.`);
        onNavigate("Produce");
      });
    }} />}
    {dialog === "reroll" && <ConfirmDialog title="Reroll the director plan?" icon={Icon.reroll} confirmLabel="Reroll plan" confirmIcon={Icon.reroll} cancelLabel="Keep current plan"
      onCancel={() => setDialog(null)} onConfirm={() => { setDialog(null); void act(() => window.martini.plan.reroll(project.id, true), () => onNavigate("Plan")); }}>
      <p>This writes a new story. Sections, places, and requested location images can all change. The current prompt package and rendered clips will no longer match the plan, so a new prompt package and new renders are needed before the next video.</p>
      <p className="muted small">Finished final videos and their reports are kept. The director's planning cache is cleared to do this (it is shared by all projects).</p>
    </ConfirmDialog>}
  </div>;
}

function StatePanel({ overview, now, pending, onStitch, onProduce }: { overview: ResultsOverview; now: number; pending: boolean; onStitch(): void; onProduce(): void }) {
  const latest = overview.latestAttempt;
  if (overview.state === "complete") return null;
  if (overview.state === "stitching" && latest) {
    const phase = latest.activity?.phase ?? (latest.status === "queued" ? "waiting" : "running");
    return <Notice tone="working" live title={<>Stitching locally <span className="muted num">· {elapsed(latest.startedAt, now)} elapsed</span></>}>
      <p>{PHASE_TEXT[phase]}{latest.activity?.queuePosition ? ` (position ${latest.activity.queuePosition})` : ""}</p>
      <p className="muted small">One ComfyUI workflow joins {overview.counts.total} clips in order with the original song. The video track is copied, not re-encoded.</p>
    </Notice>;
  }
  if (overview.state === "ready" || overview.state === "failed") {
    const stitchButton = <Button variant="primary" size="lg" icon={overview.state === "failed" ? Icon.retry : Icon.film} disabled={!overview.canStitch || pending} onClick={onStitch}>
      {overview.state === "failed" ? "Retry stitch" : "Stitch final video"}</Button>;
    return overview.state === "failed" && latest
      ? <Notice tone="error" live title={`The last stitch ${latest.status === "interrupted" ? "was interrupted" : "failed"}`} actions={stitchButton}>
          <p className="error-text">{latest.error}</p>
          {latest.cleanupDetail && <p className="muted small">{latest.cleanupDetail}</p>}
          {overview.stitchUnavailable && <p className="error-text">{overview.stitchUnavailable}</p>}
        </Notice>
      : <Notice tone="ok" title="Ready to stitch" actions={stitchButton}>
          <p>All {overview.counts.total} clips are rendered. Stitch joins them in order with the original song into one local MP4.</p>
          {overview.stitchUnavailable && <p className="error-text">{overview.stitchUnavailable}</p>}
        </Notice>;
  }
  return <Notice tone="warn" title="Blocked — the final video cannot be stitched yet"
    actions={overview.package ? <Button variant="primary" icon={Icon.produce} iconEnd={Icon.next} onClick={onProduce}>Go to Produce</Button> : undefined}>
    <ul>{overview.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
    <p className="muted small">Nothing is sent to ComfyUI until every clip has a video.</p>
  </Notice>;
}

function Player({ final, player, onOpen, onFolder }: { final: FinalVideo; player: React.RefObject<HTMLVideoElement | null>; onOpen(): void; onFolder(): void }) {
  const [failed, setFailed] = useState(false);
  if (!final.videoUrl || failed) {
    return <div className="player-fallback">
      <Icon.imageMissing size={28} aria-hidden />
      <b>{final.videoUrl ? "This video can't be previewed inside Martini Shot." : "The video file is not available."}</b>
      <p className="muted selectable">{final.videoUrl ? "Its codec is not one the built-in player supports. It is unaffected; open it in your usual video player." : final.videoPath}</p>
      <div className="row-actions">{final.fileExists && <Button variant="primary" icon={Icon.external} onClick={onOpen}>Open file</Button>}<Button variant="secondary" icon={Icon.openFolder} onClick={onFolder}>Open folder</Button></div>
    </div>;
  }
  return <video ref={player} className="final-player" src={final.videoUrl} controls preload="metadata" onError={() => setFailed(true)} />;
}

function FileFacts({ final, onCopy, onCopyError, onReveal }: { final: FinalVideo; onCopy(): Promise<unknown>; onCopyError(reason: unknown): void; onReveal(): void }) {
  return <div className="file-facts">
    <dl>
      <div><dt>File</dt><dd className="selectable">{final.fileName}</dd></div>
      <div><dt>Duration</dt><dd className="num">{final.durationSeconds !== null ? formatDuration(final.durationSeconds) : "not available"}</dd></div>
      <div><dt>Size</dt><dd className="num">{bytes(final.fileSizeBytes)}</dd></div>
      {final.videoInfo && <div><dt>Video</dt><dd className="selectable">{final.videoInfo}</dd></div>}
    </dl>
    <div className="path-field">
      <code className="path" title={final.videoPath ?? ""}>{final.videoPath}</code>
      {final.fileExists && <CopyButton label="Copy video path" copy={onCopy} onError={onCopyError} size="sm" />}
      <IconButton icon={Icon.openFolder} label="Show in folder" size="sm" tip="end" disabled={!final.fileExists} onClick={onReveal} />
    </div>
  </div>;
}

function Attention({ items }: { items: string[] }) {
  if (!items.length) return <section className="attention clear"><Icon.success size={24} aria-hidden /><b>Attention needed</b><span className="divider" aria-hidden />No unresolved location references or failed clips.</section>;
  return <section className="attention open" role="status"><b><Icon.warning size={18} aria-hidden /> Attention needed</b><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></section>;
}

/** Stitch test videos: every run of 2+ rendered clips becomes test_<first>_<last>_<batch>.mp4, before every clip is done. */
function TestVideos({ overview, projectId, pending, act, onStitch }: { overview: ResultsOverview; projectId: string; pending: boolean; act(work: () => Promise<unknown>): Promise<void>; onStitch(): void }) {
  const { tests } = overview;
  const [playing, setPlaying] = useState<string | null>(null);
  const running = tests.batches.find((batch) => batch.packageCurrent && (batch.status === "queued" || batch.status === "running"));
  const runText = tests.runs.map(([first, last]) => `test_${first}_${last}_${tests.nextBatch}`).join(", ");
  return <section className="panel test-videos">
    <PanelHead icon={Icon.film} title="Test videos" count={tests.batches.length || undefined}
      aside={<Button variant="outline-blue" size="sm" icon={Icon.film} busy={Boolean(running)} disabled={!tests.available || pending} onClick={onStitch}>Stitch test videos</Button>} />
    <p className="muted small">
      {tests.available ? <>Makes <span className="selectable num">{runText}</span> from each run of 2 or more rendered clips, with the song cut to match. Clips use their post-processed version where one is chosen or current, otherwise the original render.</>
        : running ? `Stitching test batch ${running.batch}…` : tests.reason}
      {tests.singles.length > 0 && tests.available && <> Single clips skipped: {tests.singles.join(", ")}.</>}
    </p>
    {tests.batches.length > 0 && <ul className="test-batches">{tests.batches.map((batch) => <li key={batch.id}>
      <div className="test-batch-head">
        <ToneMark tone={batch.status === "complete" ? "ok" : batch.status === "failed" || batch.status === "interrupted" ? "fail" : batch.status === "queued" || batch.status === "running" ? "pending" : "none"} />
        <b>Batch {batch.batch}</b>
        <span className="muted small">{batch.status === "complete" ? `Stitched ${formatWhen(batch.completedAt)}` : `${batch.status} · ${formatWhen(batch.startedAt)}`}{batch.packageCurrent ? "" : " · earlier prompt package"}</span>
      </div>
      {batch.error && <p className="error-text small">{batch.error}</p>}
      {batch.videos.map((video, n) => {
        const key = `${batch.id}/${n}`;
        return <div key={key} className="test-video">
          <div className="test-video-row">
            <span className="selectable num">{video.fileName}</span>
            <span className="muted small num">clips {video.first}–{video.last}{video.durationSeconds !== null ? ` · ${formatDuration(video.durationSeconds)}` : ""}{video.fps && video.fps !== "24/1" ? ` · ${video.fps.replace("/1", "")} fps` : ""}{video.processed.length ? ` · post-processed: ${video.processed.join(", ")}` : ""}{video.exists ? "" : " · file no longer on disk"}</span>
            {video.exists && <div className="row-actions">
              <IconButton icon={Icon.render} label={playing === key ? "Hide player" : `Play ${video.fileName}`} size="sm" tip="end" onClick={() => setPlaying(playing === key ? null : key)} />
              <IconButton icon={Icon.external} label={`Open ${video.fileName}`} size="sm" tip="end" onClick={() => void act(() => window.martini.results.openTest(projectId, batch.id, n))} />
              <IconButton icon={Icon.openFolder} label="Show in folder" size="sm" tip="end" onClick={() => void act(() => window.martini.results.revealTest(projectId, batch.id, n))} />
            </div>}
          </div>
          {playing === key && video.url && <video className="test-player" src={video.url} controls autoPlay preload="metadata" />}
        </div>;
      })}
    </li>)}</ul>}
  </section>;
}

function History({ overview, projectId, act }: { overview: ResultsOverview; projectId: string; act(work: () => Promise<unknown>): Promise<void> }) {
  const mark = (status: string): { tone: "ok" | "fail" | "pending" | "none" } => ({ tone: status === "complete" ? "ok" : status === "failed" || status === "interrupted" ? "fail" : status === "running" || status === "queued" ? "pending" : "none" });
  return <section className="panel history">
    <PanelHead icon={Icon.film} title="Recorded videos" count={overview.history.length} />
    <ul>{overview.history.map((item) => <li key={item.id}>
      <ToneMark tone={mark(item.status).tone} />
      <div className="history-main">
        <b className="selectable">{item.fileName ?? (item.status === "complete" ? "final video" : "stitch attempt")}</b>
        <span className="muted small">{item.status === "complete" ? `Stitched ${formatWhen(item.completedAt)}` : `${item.status} · ${formatWhen(item.startedAt)}`}
          {item.clipSummary ? ` · ${item.clipSummary.rendered} clips` : ""}{item.packageCurrent ? "" : " · earlier prompt package"}
          {item.status === "complete" && !item.fileExists ? " · file no longer on disk" : ""}</span>
        {item.status !== "complete" && item.error && <span className="error-text small">{item.error}</span>}
      </div>
      {item.fileExists && <div className="row-actions">
        <IconButton icon={Icon.external} label={`Open ${item.fileName ?? "video"}`} size="sm" tip="end" onClick={() => void act(() => window.martini.results.openVideo(projectId, item.id))} />
        <IconButton icon={Icon.openFolder} label="Show in folder" size="sm" tip="end" onClick={() => void act(() => window.martini.results.revealVideo(projectId, item.id))} />
      </div>}
    </li>)}</ul>
  </section>;
}

function Report({ report, pending, onCopy, onCopyError, onExport }: { report: DirectorReport; pending: boolean; onCopy(): Promise<unknown>; onCopyError(reason: unknown): void; onExport(): void }) {
  return <aside className="panel report-panel">
    <div className="report-head">
      <div><h2 className="panel-title"><Icon.file size={20} className="panel-title-icon" aria-hidden />Autonomous director report</h2>
        <p className="muted small">{report.kind === "snapshot" ? `Saved when this video was stitched (${formatWhen(report.generatedAt)}).` : "Built from the current stored results."} Facts only; nothing here needs approval.</p></div>
      <div className="row-actions">
        <CopyButton label="Copy report" copy={onCopy} onError={onCopyError} />
        <IconButton icon={Icon.save} label="Export report" tip="end" disabled={pending} onClick={onExport} />
      </div>
    </div>
    {report.sections.map((section, index) => <details key={section.id} className="disclosure report-section" open={index > 0 && index < 5}>
      <summary>
        <Icon.expand size={16} className="chev" aria-hidden />
        {(() => { const Glyph = SECTION_ICON[section.id] ?? Icon.info; return <Glyph size={17} aria-hidden />; })()}
        <span className="disclosure-label"><b>{section.title}</b> <span className="muted">— {section.summary}</span></span>
      </summary>
      <div className="disclosure-body">
        {section.id === "wheel" && section.items.some((item) => PHASE_CLASS[item.label])
          ? <div className="wheel-chips">{section.items.map((item) => <div key={item.label} className={PHASE_CLASS[item.label] ?? ""}><b>{item.label}</b><span>{item.value.replace("Sections", "Sec")}</span></div>)}</div>
          : <ul className="report-items">{section.items.map((item, i) => <li key={`${item.label}-${i}`} className={item.tone}>
            <ToneMark tone={item.tone} /><span className="label">{item.label}</span><span className="value selectable">{item.value}</span>
          </li>)}</ul>}
      </div>
    </details>)}
    {report.technical.length > 0 && <Disclosure className="report-section technical" icon={Icon.log} summary={<><b>Technical log</b> <span className="muted">— raw ComfyUI and node output</span></>}>
      {report.technical.map((entry) => <div key={entry.label} className="technical-entry"><span className="muted small">{entry.label}</span><pre className="log">{entry.body}</pre></div>)}
    </Disclosure>}
  </aside>;
}

function RerenderDialog({ total, onCancel, onConfirm }: { total: number; onCancel(): void; onConfirm(request: RerenderRequest): void }) {
  const [scope, setScope] = useState<"all" | "clips">("all");
  const [clips, setClips] = useState("");
  return <Dialog title="Re-render with the unchanged plan" icon={Icon.render} onClose={onCancel} actions={<>
    <Button variant="secondary" onClick={onCancel}>Cancel</Button>
    <Button variant="primary" icon={Icon.render} disabled={scope === "clips" && !clips.trim()} onClick={() => onConfirm(scope === "all" ? { scope: "all" } : { scope: "clips", clips })}>Re-render</Button>
  </>}>
    <p>The story, director plan, location choices, and prompt package stay exactly as they are. The chosen clips render again on Produce, one at a time.</p>
    <fieldset className="radio-group">
      <legend className="sr-only">Which clips</legend>
      <label className="radio"><input type="radio" name="rerender-scope" checked={scope === "all"} onChange={() => setScope("all")} data-autofocus /> All {total} clips</label>
      <label className="radio"><input type="radio" name="rerender-scope" checked={scope === "clips"} onChange={() => setScope("clips")} /> Only these clips
        <input className="input clip-input" value={clips} placeholder="e.g. 3, 7-9" aria-label="Clip numbers to re-render" disabled={scope !== "clips"} onChange={(event) => setClips(event.target.value)} /></label>
    </fieldset>
    <p className="muted small">Their current videos are moved to a <code>superseded</code> folder inside the package (nothing is deleted). Clips that continue from a re-rendered clip are re-rendered too, so motion stays continuous. Finished final videos are kept; stitch again afterwards to include the new clips.</p>
  </Dialog>;
}
