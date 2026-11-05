import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button, ConfirmDialog, Icon, IconButton, LoadingPage, Notice, PageHeader, PanelHead, PathField, Pill, cx, type LucideIcon, type Tone } from "./ui";

export const STATUS_LABELS: Record<ProjectState, string> = {
  new: "Needs assets", assets_ready: "Ready to plan", planned: "Planned", needs_location_images: "Needs location images",
  ready_to_produce: "Ready to produce", prompt_package_ready: "Prompts ready", rendering: "Rendering", stitch_ready: "Ready to stitch",
  complete: "Complete", failed: "Needs attention",
};
/** Project states are stored snapshots, so none of them spins: "Rendering" here does not mean ComfyUI is busy right now. */
const STATUS_STYLE: Record<ProjectState, { tone: Tone; icon: LucideIcon }> = {
  new: { tone: "warn", icon: Icon.warning }, assets_ready: { tone: "ok", icon: Icon.success }, planned: { tone: "info", icon: Icon.phases },
  needs_location_images: { tone: "warn", icon: Icon.warning }, ready_to_produce: { tone: "ok", icon: Icon.success },
  prompt_package_ready: { tone: "info", icon: Icon.file }, rendering: { tone: "working", icon: Icon.render }, stitch_ready: { tone: "info", icon: Icon.film },
  complete: { tone: "ok", icon: Icon.success }, failed: { tone: "error", icon: Icon.error },
};

const PRE_PLANNING: ProjectState[] = ["new", "assets_ready"];

/** Electron prefixes main-process errors with "Error invoking remote method …: Error:"; users only need the message. */
export function readableError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A position in the song: like formatDuration, but the start of the song is 0:00 rather than "unknown". */
export function formatTime(seconds: number | null | undefined): string {
  return seconds === 0 ? "0:00" : formatDuration(seconds);
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today ${time}`;
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function ProjectStatus({ status, size }: { status: ProjectState; size?: "md" | "lg" }) {
  const style = STATUS_STYLE[status] ?? { tone: "muted" as Tone, icon: Icon.info };
  return <Pill tone={style.tone} icon={style.icon} size={size}>{STATUS_LABELS[status] ?? status}</Pill>;
}

type Props = {
  overview?: ProjectsOverview;
  loadError: string;
  onChanged(project?: ProjectDetail): void;
  onNavigate(view: "Direction" | "Plan"): void;
};

export function ProjectsView({ overview, loadError, onChanged, onNavigate }: Props) {
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string; issues?: AssetChangeResult["issues"] }>();
  const active = overview?.active ?? null;
  const showCreate = creating || !active;

  const run = async <T,>(work: () => Promise<T>, after?: (value: T) => void) => {
    setNotice(undefined);
    try { const value = await work(); after?.(value); }
    catch (error) { setNotice({ tone: "error", text: readableError(error) }); }
  };
  const assetResult = (result: AssetChangeResult) => {
    onChanged(result.project);
    if (result.issues.length) {
      setNotice({ tone: "error", text: result.added ? `Added ${result.added}; ${result.issues.length} file(s) were not added:` : "These files were not added:", issues: result.issues });
    }
  };

  if (!overview) {
    return loadError ? <div className="page"><Notice tone="error" title="Projects could not be loaded" live>{loadError}</Notice></div> : <LoadingPage text="Opening your local projects…" />;
  }

  return <div className="page projects-page">
    <PageHeader title={!showCreate && active ? active.name : "Projects"}
      status={active && !showCreate ? <span className="autosaved" title="Every change is saved to the local project database immediately."><Icon.success size={15} aria-hidden />Autosaved {formatWhen(active.updatedAt)}</span> : undefined}
      actions={active && !showCreate ? <Button variant="secondary" icon={Icon.add} onClick={() => setCreating(true)}>New project</Button> : undefined} />
    {loadError && <Notice tone="error" live>{loadError}</Notice>}
    {overview.rootError && <Notice tone="error">{overview.rootError}</Notice>}
    {notice && <Notice tone={notice.tone} live onDismiss={() => setNotice(undefined)}>
      <p>{notice.text}</p>
      {notice.issues?.length ? <ul className="issue-list">{notice.issues.map((issue) => <li key={issue.file}><code>{issue.file}</code><span>{issue.reason}</span></li>)}</ul> : null}
    </Notice>}
    {showCreate
      ? <CreateProject root={overview.projectsRoot} canCancel={Boolean(active)} onCancel={() => setCreating(false)}
          onCreate={(name) => run(() => window.martini.projects.create(name), (project) => { setCreating(false); onChanged(project); })} />
      : active && <div className="project-grid">
          <ProjectOverview project={active} run={run} onAssetResult={assetResult} onChanged={onChanged} onNavigate={onNavigate} />
          <NextSteps project={active} />
        </div>}
    <RecentProjects projects={overview.recent} activeId={active?.id} onNew={() => setCreating(true)} onDelete={setDeleting}
      onOpen={(id) => run(() => window.martini.projects.open(id), (project) => { setCreating(false); onChanged(project); })} />
    {deleting && <ConfirmDialog title={`Delete "${deleting.name}"?`} icon={Icon.remove} tone="danger" confirmLabel="Delete project" confirmIcon={Icon.remove}
      cancelLabel="Keep it" onCancel={() => setDeleting(null)}
      onConfirm={() => { const project = deleting; setDeleting(null); void run(() => window.martini.projects.delete(project.id), () => { setNotice({ tone: "info", text: `"${project.name}" was deleted. Its folder is in the Recycle Bin if you need the files back.` }); onChanged(); }); }}>
      <p>The project folder moves to the Recycle Bin: the song and image copies, the director plan, prompt packages, rendered clips, and the final video.</p>
      <p className="muted">The project is also removed from Martini Shot, including its plan history and render records. Restoring the folder from the Recycle Bin brings the files back, not the project list entry. Your original files are not touched.</p>
      {deleting.id === active?.id && <p className="muted">This is the open project. The most recently opened remaining project opens instead.</p>}
    </ConfirmDialog>}
  </div>;
}

function CreateProject({ root, canCancel, onCancel, onCreate }: { root: string; canCancel: boolean; onCancel(): void; onCreate(name: string): Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try { await onCreate(name); } finally { setBusy(false); }
  };
  return <form className="panel create-project" onSubmit={(event) => void submit(event)}>
    <PanelHead icon={Icon.add} title="Create a music video project" />
    <p className="muted">A project holds one song, the performer, outfits, and any locations you already have. Martini Shot copies your files into the project folder; the originals stay where they are.</p>
    <label className="field-stack"><span>Project name</span>
      <input className="input input-lg" autoFocus value={name} maxLength={80} placeholder="e.g. Static Heart" onChange={(event) => setName(event.target.value)} />
    </label>
    <p className="path-preview"><span className="muted">Folder</span><code className="path">{root}\{slug || "<project-name>"}\</code></p>
    <div className="row-actions">
      <Button variant="primary" type="submit" icon={Icon.add} busy={busy} disabled={!slug}>{busy ? "Creating…" : "Create project"}</Button>
      {canCancel && <Button variant="quiet" onClick={onCancel}>Cancel</Button>}
    </div>
  </form>;
}

type RunFn = <T>(work: () => Promise<T>, after?: (value: T) => void) => Promise<void>;

function ProjectOverview({ project, run, onAssetResult, onChanged, onNavigate }: { project: ProjectDetail; run: RunFn; onAssetResult(result: AssetChangeResult): void; onChanged(project?: ProjectDetail): void; onNavigate(view: "Direction" | "Plan"): void }) {
  const song = project.assets.find((asset) => asset.role === "song");
  const [removing, setRemoving] = useState<ProjectAsset | null>(null);
  const add = (role: AssetRole) => run(() => window.martini.assets.add(project.id, role), onAssetResult);
  const planExists = !PRE_PLANNING.includes(project.status);
  const actions: AssetActions = {
    replace: (asset) => run(() => window.martini.assets.replace(project.id, asset.id), onAssetResult),
    remove: (asset) => setRemoving(asset),
  };
  return <section className="panel overview">
    <header className="panel-head">
      <span className="eyebrow">Project overview</span>
      <span className="status-label">Status <ProjectStatus status={project.status} /></span>
    </header>
    {song ? <SongRow project={project} song={song} actions={actions} /> : <EmptySong onAdd={() => void add("song")} />}
    <div className="asset-groups">
      <AssetGroup title="Performer reference" noun="performer" icon={Icon.performer} role="performer" required project={project} actions={actions} onAdd={add}
        empty="Required. A clear photo of the performer's face and body." />
      <AssetGroup title="Outfit references" noun="outfits" icon={Icon.outfit} role="outfit" project={project} actions={actions} onAdd={add}
        empty="Optional. Clothing the performer can wear." />
      <AssetGroup title="Location references" noun="locations" icon={Icon.locations} role="location" project={project} actions={actions} onAdd={add}
        empty="Optional. Places you already have photos of. The director can ask for more later." />
    </div>
    <footer className="overview-foot">
      <div className="fact folder-fact"><span className="fact-label"><Icon.folder size={14} aria-hidden />Project folder</span>
        <PathField value={project.projectPath} openLabel="Open project folder" onOpen={() => void run(() => window.martini.projects.openFolder(project.id))} /></div>
      <div className="fact"><span className="fact-label"><Icon.song size={14} aria-hidden />Duration</span><b className="num fact-value">{formatDuration(project.songDurationSeconds)}</b></div>
      <ComfyProjectFile project={project} onRetry={() => void run(() => window.martini.projects.retryComfySave(project.id), (detail) => onChanged(detail))} />
      <NextAction project={project} onAdd={add} onNavigate={onNavigate} />
    </footer>
    {removing && <ConfirmDialog title={`Remove ${removing.fileName}?`} icon={Icon.remove} tone="danger" confirmLabel="Remove from project" confirmIcon={Icon.remove}
      cancelLabel="Keep it" onCancel={() => setRemoving(null)} onConfirm={() => { const asset = removing; setRemoving(null); void run(() => window.martini.assets.remove(project.id, asset.id), (detail) => onChanged(detail)); }}>
      <p>The project's copy is deleted. Your original file is not touched.</p>
      <p className="muted">{planExists
        ? "The director plan and any renders were made from the current assets and will need to be created again."
        : "Nothing has been planned yet, so nothing else needs to be redone."}</p>
    </ConfirmDialog>}
  </section>;
}

function ComfyProjectFile({ project, onRetry }: { project: ProjectDetail; onRetry(): void }) {
  const { status, savedAt, error } = project.comfySync;
  const view: Record<typeof status, { tone: Tone; text: string }> = {
    waiting_for_assets: { tone: "muted", text: "Saved once the song and a performer image are added" },
    not_saved: { tone: "warn", text: "Not saved for the current assets yet" },
    saving: { tone: "working", text: "Saving through ComfyUI…" },
    saved: { tone: "ok", text: `Saved by ComfyUI ${formatWhen(savedAt)}` },
    failed: { tone: "error", text: "Not saved" },
  };
  return <div className="fact comfy-fact">
    <span className="fact-label"><Icon.file size={14} aria-hidden />ComfyUI project file</span>
    <div className="row-actions">
      <Pill tone={view[status].tone} icon={status === "waiting_for_assets" ? Icon.pending : undefined}>{view[status].text}</Pill>
      {status === "failed" && <Button variant="link" size="sm" icon={Icon.retry} onClick={onRetry}>Try again</Button>}
      {status === "not_saved" && <Button variant="link" size="sm" icon={Icon.save} onClick={onRetry}>Save now</Button>}
    </div>
    {status === "failed" && error && <p className="error-text">{error}</p>}
  </div>;
}

function NextAction({ project, onAdd, onNavigate }: { project: ProjectDetail; onAdd(role: AssetRole): void; onNavigate(view: "Direction" | "Plan"): void }) {
  if (project.counts.song < 1) return <div className="next-action"><Button variant="primary" size="lg" icon={Icon.song} onClick={() => onAdd("song")}>Add the song</Button><small>Step 1 of 2 to get ready</small></div>;
  if (project.counts.performer < 1) return <div className="next-action"><Button variant="primary" size="lg" icon={Icon.performer} onClick={() => onAdd("performer")}>Add a performer image</Button><small>The last required asset</small></div>;
  if (project.status !== "new" && project.status !== "assets_ready") return <div className="next-action">
    <Button variant="primary" size="lg" icon={Icon.plan} iconEnd={Icon.next} onClick={() => onNavigate("Plan")}>View director plan</Button>
    <small>A plan exists. Locations are the next step.</small>
  </div>;
  return <div className="next-action">
    <Button variant="primary" size="lg" icon={Icon.plan} iconEnd={Icon.next} onClick={() => onNavigate("Direction")}>Set direction &amp; plan</Button>
    <small>Assets are ready. Add an optional creative brief, then create the director plan.</small>
  </div>;
}

function EmptySong({ onAdd }: { onAdd(): void }) {
  return <div className="song-row empty">
    <div className="song-icon" aria-hidden><Icon.song size={24} /></div>
    <div><b>No song yet</b><p className="muted small">Required. WAV, MP3, FLAC, OGG, M4A, AAC, or Opus.</p></div>
    <Button variant="secondary" icon={Icon.add} onClick={onAdd}>Add song</Button>
  </div>;
}

type AssetActions = { replace(asset: ProjectAsset): void; remove(asset: ProjectAsset): void };

function SongRow({ project, song, actions }: { project: ProjectDetail; song: ProjectAsset; actions: AssetActions }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [peaks, setPeaks] = useState<number[]>();
  const [waveError, setWaveError] = useState("");
  const [position, setPosition] = useState(0);
  const ext = song.fileName.split(".").pop()?.toUpperCase();

  useEffect(() => {
    if (!song.available) return;
    let cancelled = false;
    setPeaks(undefined); setWaveError("");
    (async () => {
      const buffer = await (await fetch(song.previewUrl)).arrayBuffer();
      const context = new AudioContext();
      try {
        const decoded = await context.decodeAudioData(buffer);
        if (cancelled) return;
        const channel = decoded.getChannelData(0);
        const bars = 160;
        const step = Math.max(1, Math.floor(channel.length / bars));
        const values: number[] = [];
        for (let bar = 0; bar < bars; bar++) {
          let peak = 0;
          for (let i = bar * step; i < Math.min(channel.length, (bar + 1) * step); i += 16) peak = Math.max(peak, Math.abs(channel[i]));
          values.push(peak);
        }
        const max = Math.max(...values, 0.0001);
        setPeaks(values.map((value) => value / max));
        if (!song.durationSeconds || Math.abs(song.durationSeconds - decoded.duration) > 0.05) {
          void window.martini.assets.recordSongDuration(project.id, song.id, decoded.duration).catch(() => undefined);
        }
      } finally { void context.close(); }
    })().catch(() => { if (!cancelled) setWaveError("Waveform preview unavailable for this file."); });
    return () => { cancelled = true; };
  }, [song.previewUrl, song.available]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play(); else element.pause();
  };
  const duration = song.durationSeconds || audio.current?.duration || 0;

  return <div className="song-row">
    <div className="song-icon" aria-hidden><Icon.song size={24} /></div>
    <div className="song-meta">
      <span className="eyebrow">Song</span>
      <b className="selectable" title={song.originalPath}>{song.fileName}</b>
      <p className="muted small">{[ext, formatBytes(song.fileSize)].filter(Boolean).join(" · ")}</p>
    </div>
    {song.available ? <>
      <IconButton className="play-btn" icon={playing ? Icon.pause : Icon.render} label={playing ? "Pause song" : "Play song"} onClick={toggle} />
      <div className="waveform" aria-hidden>
        {peaks ? peaks.map((peak, index) => <i key={index} className={duration && index / peaks.length < position / duration ? "played" : ""} style={{ height: `${Math.max(4, peak * 100)}%` }} />)
          : <span className="muted small">{waveError || "Reading song…"}</span>}
      </div>
      <b className="song-duration num">{formatDuration(song.durationSeconds)}</b>
      <audio ref={audio} src={song.previewUrl} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)} />
    </> : <p className="error-text song-missing"><Icon.warning size={14} aria-hidden /> The project's copy of this song is missing. Replace it to continue.</p>}
    <AssetMenu asset={song} actions={actions} />
  </div>;
}

function AssetGroup({ title, noun, icon: Glyph, role, required, project, actions, onAdd, empty }: {
  title: string; noun: string; icon: LucideIcon; role: AssetRole; required?: boolean; project: ProjectDetail; actions: AssetActions; onAdd(role: AssetRole): void; empty: string;
}) {
  const assets = project.assets.filter((asset) => asset.role === role);
  const missing = required && !assets.length;
  // With files present, "add" is a compact heading action so the thumbnails stay in one row; an empty group gets a full tile that explains itself.
  return <section className="asset-group">
    <h3><Glyph size={15} aria-hidden />{title} <span className="count">({assets.length})</span>{missing && <Pill tone="warn">Required</Pill>}
      {assets.length > 0 && <IconButton icon={Icon.add} size="sm" tip="end" label={`Add ${noun}`} className="group-add" onClick={() => onAdd(role)} />}</h3>
    <div className="tiles">
      {assets.map((asset) => <AssetTile key={asset.id} asset={asset} actions={actions} />)}
      {!assets.length && <button type="button" className={cx("tile", "add-tile", missing && "needed")} onClick={() => onAdd(role)}>
        <Icon.add size={22} aria-hidden />Add {noun}<small>{empty}</small>
      </button>}
    </div>
  </section>;
}

function AssetTile({ asset, actions }: { asset: ProjectAsset; actions: AssetActions }) {
  const [size, setSize] = useState<string>();
  const [broken, setBroken] = useState(false);
  return <figure className="tile">
    {asset.available && !broken
      ? <img src={asset.previewUrl} alt={asset.displayName} onLoad={(event) => setSize(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} onError={() => setBroken(true)} />
      : <div className="tile-missing"><Icon.imageMissing size={20} aria-hidden />{asset.available ? "Image failed to load" : "Project copy missing — replace it"}</div>}
    <figcaption>
      <div><b className="selectable" title={asset.originalPath}>{asset.fileName}</b><span className="num">{[size, formatBytes(asset.fileSize)].filter(Boolean).join(" · ")}</span></div>
      <AssetMenu asset={asset} actions={actions} />
    </figcaption>
  </figure>;
}

/** Per-asset menu: Replace, or Remove (which asks for confirmation). Escape closes it and returns focus to its button. */
function AssetMenu({ asset, actions }: { asset: ProjectAsset; actions: AssetActions }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>(".menu-item")?.focus();
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
    if (!open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(".menu-item") ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  const choose = (action: (asset: ProjectAsset) => void) => { setOpen(false); action(asset); };
  return <div className="asset-menu" ref={ref} onKeyDown={onKeyDown}>
    <IconButton ref={trigger} icon={Icon.more} size="sm" tip="end" label={`Options for ${asset.fileName}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} />
    {open && <div className="menu" role="menu" aria-label={`Options for ${asset.fileName}`}>
      <p className="menu-note">Original: <code className="path">{asset.originalPath}</code></p>
      <button type="button" role="menuitem" className="menu-item" onClick={() => choose(actions.replace)}><Icon.replace size={15} aria-hidden />Replace with another file…</button>
      <button type="button" role="menuitem" className="menu-item danger" onClick={() => choose(actions.remove)}><Icon.remove size={15} aria-hidden />Remove from project…</button>
    </div>}
  </div>;
}

function NextSteps({ project }: { project: ProjectDetail }) {
  const assetsDone = project.missing.length === 0;
  const steps = [
    { title: "Add assets", text: "The song, a performer image, and any outfits or locations you have." },
    { title: "Set direction", text: "Optional: describe the mood, look, or a must-have scene." },
    { title: "Plan", text: "The director plans the story, sections, and locations automatically." },
    { title: "Add requested locations, if any", text: "If the plan needs more location photos, it names the exact files." },
    { title: "Produce", text: "Clips render one at a time in ComfyUI, then join into the final video." },
  ];
  return <aside className="panel next-steps">
    <h2 className="panel-title">What happens next</h2>
    <ol>{steps.map((step, index) => {
      const state = index === 0 ? (assetsDone ? "done" : "current") : index === 1 && assetsDone ? "current" : "";
      return <li key={step.title} className={state} aria-current={state === "current" ? "step" : undefined}>
        <span className="step-number">{state === "done" ? <Icon.check size={15} aria-label="Done" /> : index + 1}</span>
        <div><b>{step.title}</b><p>{index === 0 && !assetsDone ? project.missing.join(". ") + "." : step.text}</p></div>
      </li>;
    })}</ol>
  </aside>;
}

function RecentProjects({ projects, activeId, onOpen, onNew, onDelete }: { projects: ProjectSummary[]; activeId?: string; onOpen(id: string): void; onNew(): void; onDelete(project: ProjectSummary): void }) {
  return <section className="panel recent">
    <PanelHead title="Recent projects" count={projects.length} aside={<Button variant="quiet" size="sm" icon={Icon.add} onClick={onNew}>New project</Button>} />
    {!projects.length ? <p className="muted">No projects yet. Create one above to get started.</p> : <table className="data-table">
      <thead><tr><th>Project</th><th>Updated</th><th>Duration</th><th>Assets</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{projects.map((project) => <tr key={project.id} className={project.id === activeId ? "is-current" : ""}>
        <td><div className="recent-name">{project.thumbnailUrl ? <img src={project.thumbnailUrl} alt="" /> : <span className="thumb-empty" aria-hidden><Icon.film size={16} /></span>}
          <div><b>{project.name}</b><code className="path" title={project.projectPath}>{project.projectPath}</code></div></div></td>
        <td className="num">{formatWhen(project.updatedAt)}</td>
        <td className="num">{formatDuration(project.songDurationSeconds)}</td>
        <td className="muted small">{project.counts.song ? "Song" : "No song"} · {project.counts.performer} performer · {project.counts.outfit} outfit · {project.counts.location} location</td>
        <td>{project.folderExists ? <ProjectStatus status={project.status} /> : <Pill tone="error" icon={Icon.imageMissing}>Folder missing</Pill>}</td>
        <td className="cell-action"><div className="row-actions">{project.id === activeId ? <span className="muted small">Open now</span>
          : <Button variant="secondary" size="sm" icon={Icon.openFolder} disabled={!project.folderExists} onClick={() => onOpen(project.id)} aria-label={`Open ${project.name}`}>Open</Button>}
          <IconButton icon={Icon.remove} size="sm" tip="end" label={`Delete ${project.name}`} onClick={() => onDelete(project)} /></div></td>
      </tr>)}</tbody>
    </table>}
  </section>;
}
