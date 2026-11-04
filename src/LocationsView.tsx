import { useCallback, useEffect, useState, type DragEvent } from "react";
import { formatDuration, formatWhen, readableError } from "./ProjectsView";
import { elapsed, useTicker } from "./usePlan";
import { Button, ConfirmDialog, CopyButton, Disclosure, EmptyState, Icon, LoadingPage, NoProject, Notice, PageHeader, PathField, Pill, cx, type LucideIcon, type Tone } from "./ui";

type Props = { project: ProjectDetail | null; comfy?: ComfyStatus; onNavigate(view: "Projects" | "Plan" | "Produce"): void };

function sectionRange(numbers: number[]): string {
  if (!numbers.length) return "";
  const sorted = [...numbers].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) continue;
    parts.push(start === sorted[i - 1] ? String(start) : `${start}–${sorted[i - 1]}`);
    start = sorted[i];
  }
  return `${sorted.length === 1 ? "Section" : "Sections"} ${parts.join(", ")}`;
}

/** Loads the locations overview and keeps it current: main-process events, plus a folder re-scan whenever the window regains focus
 *  (the user usually adds files in Explorer). */
function useLocations(projectId: string) {
  const [overview, setOverview] = useState<LocationsOverview>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setOverview(await window.martini.locations.overview(projectId)); setError(""); }
    catch (reason) { setError(readableError(reason)); }
  }, [projectId]);
  useEffect(() => {
    void refresh();
    const onChange = (changed: string) => { if (changed === projectId) void refresh(); };
    const offs = [window.martini.locations.onChanged(onChange), window.martini.plan.onChanged(onChange), window.martini.projects.onChanged(onChange)];
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { offs.forEach((off) => off()); window.removeEventListener("focus", onFocus); };
  }, [projectId, refresh]);
  return { overview, setOverview, error, setError, refresh };
}

export function LocationsView({ project, comfy, onNavigate }: Props) {
  if (!project) return <NoProject text="Open a project and create its director plan. Any extra location images the director needs are listed here." onProjects={() => onNavigate("Projects")} />;
  return <LocationsContent key={project.id} project={project} comfy={comfy} onNavigate={onNavigate} />;
}

type PendingReplace = { location: RequestedLocationStatus; file: File | null };

function LocationsContent({ project, comfy, onNavigate }: { project: ProjectDetail; comfy?: ComfyStatus; onNavigate: Props["onNavigate"] }) {
  const { overview, setOverview, error, setError } = useLocations(project.id);
  const [notice, setNotice] = useState("");
  const [starting, setStarting] = useState(false);
  const [pending, setPending] = useState<PendingReplace | null>(null);
  const check = overview?.latestCheck ?? null;
  const checking = check?.status === "queued" || check?.status === "running";
  const now = useTicker(checking);

  // A file dropped outside a drop target must not make Electron navigate away from the app.
  useEffect(() => {
    const stop = (event: globalThis.DragEvent) => event.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => { window.removeEventListener("dragover", stop); window.removeEventListener("drop", stop); };
  }, []);

  const act = async (work: () => Promise<void>) => {
    setNotice("");
    try { await work(); setError(""); } catch (reason) { setError(readableError(reason)); }
  };
  const startCheck = () => act(async () => {
    setStarting(true);
    try { setOverview(await window.martini.locations.check(project.id)); } finally { setStarting(false); }
  });
  const placed = (result: LocationPlaceResult) => {
    setOverview(result.overview);
    if (result.placed) {
      setNotice(`Saved as ${result.placed}${result.replacedFiles.length ? ` (the previous ${result.replacedFiles.join(", ")} was moved to locations\\replaced)` : ""}. Click Check for images to confirm it loads.`);
    }
  };
  const choose = (location: RequestedLocationStatus, replace: boolean) => act(async () => placed(await window.martini.locations.chooseImage(project.id, location.slug, replace)));
  const drop = (location: RequestedLocationStatus, file: File, replace: boolean) => act(async () => placed(await window.martini.locations.dropImage(project.id, location.slug, file, replace)));
  const onDropFile = (location: RequestedLocationStatus, file: File) => {
    if (location.candidates.length) setPending({ location, file });
    else void drop(location, file, false);
  };
  const confirmReplace = () => {
    if (!pending) return;
    const { location, file } = pending;
    setPending(null);
    if (file) void drop(location, file, true); else void choose(location, true);
  };

  if (!overview) return error ? <div className="page"><Notice tone="error" title="Locations could not be loaded" live>{error}</Notice></div> : <LoadingPage text="Reading location references…" />;

  const { plan, counts, requested, supplied, textOnly } = overview;
  const comfyDown = Boolean(comfy && !comfy.connected);
  const blockers = overview.blockers.filter((blocker) => !(checking && blocker.startsWith("Already checking")));
  const canCheck = !starting && !checking && !blockers.length && !comfyDown && Boolean(plan);
  const failedCheck = check && !checking && (check.status === "failed" || check.status === "interrupted") ? check : null;
  const broll = textOnly.filter((item) => item.kind === "broll");
  const performerText = textOnly.filter((item) => item.kind === "performer");
  // One obvious next action: checking while images are outstanding, continuing once everything is image-backed.
  const checkIsPrimary = !overview.ready;

  return <div className="page locations-page">
    <PageHeader title="Location references" icon={Icon.locations}
      crumb={<>{project.name}<span className="sep">/</span><span className="num">{formatDuration(plan?.durationSeconds ?? project.songDurationSeconds)}</span>
        {plan?.bpm ? <Pill tone="muted" icon={null}>{Math.round(plan.bpm)} BPM</Pill> : null}</>}
      actions={plan ? <>
        {requested.length > 0 && <Button variant={checkIsPrimary ? "primary" : "secondary"} icon={Icon.refresh} busy={checking || starting} disabled={!canCheck} onClick={() => void startCheck()}>
          {checking || starting ? "Checking…" : "Check for images"}</Button>}
        <Button variant={checkIsPrimary && requested.length > 0 ? "secondary" : "primary"} icon={Icon.produce} iconEnd={overview.ready ? Icon.next : undefined} disabled={!overview.ready}
          onClick={() => onNavigate("Produce")}>{overview.ready ? "Continue to Produce" : "Start production"}</Button>
      </> : undefined}
      note={plan ? (overview.ready
        ? "All performer locations are ready. Produce builds the production plan and writes the prompt package."
        : "Available when all requested performer locations are image-backed.") : undefined} />

    {plan && <div className="location-status-row">
      <Pill size="lg" tone={overview.ready ? "ok" : "info"} icon={Icon.locations}>{counts.imageBacked} of {counts.performerTotal} performer location{counts.performerTotal === 1 ? "" : "s"} image-backed</Pill>
      <Pill tone="ok">{counts.imageBacked} ready</Pill>
      <Pill tone={counts.stillNeeded ? "warn" : "muted"} icon={Icon.imageAdd}>{counts.stillNeeded} requested image{counts.stillNeeded === 1 ? "" : "s"} still needed</Pill>
      <Pill tone={counts.failures ? "error" : "muted"} icon={Icon.imageMissing}>{counts.failures} image failure{counts.failures === 1 ? "" : "s"}</Pill>
    </div>}

    {error && <Notice tone="error" live onDismiss={() => setError("")}>{error}</Notice>}
    {notice && <Notice tone="ok" live onDismiss={() => setNotice("")}>{notice}</Notice>}
    {comfyDown && requested.length > 0 && <Notice tone="error">ComfyUI is not reachable at {comfy!.endpoint}. Start ComfyUI and wait for it to finish loading, then click Check for images. You can still add images to the folder now; nothing is lost.</Notice>}
    {!checking && blockers.map((blocker) => <Notice key={blocker} tone="error">{blocker}</Notice>)}
    {overview.folderError && <Notice tone="error">{overview.folderError}</Notice>}
    {checking && check && <CheckProgress check={check} now={now} />}
    {failedCheck && <Notice tone="error" live title={<>{failedCheck.status === "interrupted" ? "The image check was interrupted." : "The image check failed."} <span className="muted">The story and the previous location results are unchanged.</span></>}>
      <p className="error-text">{failedCheck.error}</p>
      {failedCheck.report && <Disclosure summary="Resolver report" icon={Icon.log}><pre className="log">{failedCheck.report}</pre></Disclosure>}
    </Notice>}
    {plan?.stale && <Notice tone="warn" title="The director plan is out of date">Its inputs changed on Direction or Projects. These requests belong to the plan shown on the Plan page. Create a new plan there if you want the director to use your current inputs.</Notice>}

    {!plan ? <EmptyState icon={Icon.plan} title="No director plan yet" actions={<Button variant="primary" icon={Icon.plan} onClick={() => onNavigate("Plan")}>Go to the plan</Button>}>
      <p className="muted">The director decides which performer locations the story needs. Create a plan first; any images it asks for appear here with their exact file names.</p>
    </EmptyState> : <>
      <SuppliedSection supplied={supplied} onProjects={() => onNavigate("Projects")} />
      <RequestedSection overview={overview} disabled={checking}
        onCopy={(location) => window.martini.locations.copyFileName(project.id, location.slug)}
        onCopyError={(reason) => setError(readableError(reason))}
        onOpenFolder={() => void act(() => window.martini.locations.openFolder(project.id))}
        onChoose={(location) => location.candidates.length ? setPending({ location, file: null }) : void choose(location, false)}
        onDropFile={onDropFile} />
      {(broll.length > 0 || performerText.length > 0) && <TextOnlySection broll={broll} performer={performerText} />}
      {check && check.status === "complete" && <LastCheck check={check} />}
      <p className="footnote"><Icon.info size={18} aria-hidden /><span>Only locations actually selected for performer scenes are requested. Text-only locations may still be used for B-roll.
        Checking for images never changes the story; to get a different story, use <Button variant="link" onClick={() => onNavigate("Plan")}>Reroll plan</Button> on the Plan page.</span></p>
    </>}

    {pending && <ConfirmDialog title={`Replace the image for ${pending.location.name}?`} icon={Icon.replace} confirmVariant="primary"
      confirmLabel={pending.file ? "Replace image" : "Choose replacement…"} confirmIcon={Icon.replace} cancelLabel="Keep current image"
      onCancel={() => setPending(null)} onConfirm={confirmReplace}>
      <p><code>{pending.location.candidates.map((item) => item.fileName).join(", ")}</code> will be moved to <code>locations\replaced</code> (not deleted), and the new image is saved as <code>{pending.location.fileName}</code>.</p>
      <p className="muted small">Run Check for images afterwards. The story does not change.</p>
    </ConfirmDialog>}
  </div>;
}

function CheckProgress({ check, now }: { check: LocationCheckRun; now: number }) {
  const phase = check.activity?.phase ?? (check.status === "queued" ? "waiting" : "running");
  const text: Record<NonNullable<LocationCheckRun["activity"]>["phase"], string> = {
    waiting: "Waiting for another ComfyUI job from Martini Shot to finish.",
    saving_project: "Making sure the project is saved in ComfyUI.",
    queued: `Queued in ComfyUI${check.activity?.queuePosition ? ` (position ${check.activity.queuePosition})` : ""}.`,
    running: "ComfyUI is checking the location folder against the saved story (no planning, no LLM).",
    cleanup: "Check finished. Asking ComfyUI to free memory.",
  };
  return <Notice tone="working" live title={<>Checking for images <span className="muted num">· {elapsed(check.startedAt, now)} elapsed</span></>}><p>{text[phase]}</p></Notice>;
}

function GroupHead({ icon: Glyph, tone, title, text }: { icon: LucideIcon; tone: "ok" | "pink" | "muted" | "warn"; title: string; text: string }) {
  return <header className="group-head">
    <h2><span className={cx("group-icon", tone)} aria-hidden><Glyph size={16} /></span>{title}</h2>
    <p className="muted">{text}</p>
  </header>;
}

function SuppliedSection({ supplied, onProjects }: { supplied: SuppliedLocationStatus[]; onProjects(): void }) {
  const allReady = supplied.every((item) => item.available);
  return <section className="panel location-group">
    <GroupHead icon={allReady ? Icon.check : Icon.warning} tone={allReady ? "ok" : "warn"} title={`Supplied locations — ${allReady ? "ready" : "needs attention"}`}
      text={supplied.length ? "You provided these image-backed locations. Each card shows the sections assigned to it in the current story plan." : "You supplied no location photos. That is fine: the director requests any it needs below."} />
    {supplied.length > 0 && <div className="supplied-grid">
      {supplied.map((item) => <article key={item.assetId} className="supplied-card">
        {item.available ? <img src={item.previewUrl} alt="" /> : <div className="thumb-placeholder warn"><Icon.imageMissing size={22} aria-hidden />Image failed to load</div>}
        <div className="supplied-body">
          <h3>{item.name}</h3>
          <p className="meta-line"><Icon.film size={14} aria-hidden />{item.sections.length ? `Used in ${sectionRange(item.sections)}` : "Not assigned to a section in this story plan."}</p>
          {item.available ? <Pill tone="ok" icon={Icon.image}>Supplied · image-backed</Pill> : <Pill tone="error" icon={Icon.imageMissing}>Image failed to load</Pill>}
          {!item.available && <p className="small warn-text">{item.reason}</p>}
          <Button variant="secondary" size="sm" icon={Icon.projects} onClick={onProjects}>{item.available ? "Manage on Projects" : "Replace on Projects"}</Button>
        </div>
      </article>)}
    </div>}
  </section>;
}

type RequestedProps = {
  overview: LocationsOverview; disabled: boolean;
  onCopy(location: RequestedLocationStatus): Promise<unknown>; onCopyError(reason: unknown): void; onOpenFolder(): void;
  onChoose(location: RequestedLocationStatus): void; onDropFile(location: RequestedLocationStatus, file: File): void;
};

function RequestedSection({ overview, disabled, onCopy, onCopyError, onOpenFolder, onChoose, onDropFile }: RequestedProps) {
  const { requested } = overview;
  return <section className="panel location-group requested">
    <GroupHead icon={Icon.locations} tone={requested.length ? "pink" : "muted"} title={`Director-requested images — ${requested.length ? "required before production" : "none needed"}`}
      text={requested.length
        ? "The director placed performer scenes at these places and needs one image of each to write final prompts. Create or find the image yourself; Martini Shot does not generate it."
        : "The current plan needs no extra location images."} />
    {requested.length > 0 && <div className="how-to">
      <div className="how-to-steps">
        <b>How to add an image</b>
        <ol>
          <li>Save one image per location in the drop folder with the exact file name shown (PNG, JPG, WEBP, or BMP), or drop it on the card.</li>
          <li>Click <b>Check for images</b>. Only that location's state changes; the story stays the same.</li>
        </ol>
      </div>
      <PathField label="Drop folder" value={overview.folder} onOpen={onOpenFolder} openLabel="Open drop folder in Explorer" />
    </div>}
    {overview.unrecognizedFiles.length > 0 && <Notice tone="warn" title="Files in the folder that match no requested name:">
      <p><code className="selectable">{overview.unrecognizedFiles.join(", ")}</code>. Rename the right one to the exact file name below; other files are ignored.</p>
    </Notice>}
    {requested.map((location) => <RequestCard key={location.slug || location.name} location={location} disabled={disabled}
      onCopy={() => onCopy(location)} onCopyError={onCopyError} onChoose={() => onChoose(location)} onDropFile={(file) => onDropFile(location, file)} />)}
  </section>;
}

/** Status of a requested image, in the app's location terminology. */
function requestState(location: RequestedLocationStatus): { tone: Tone; icon: LucideIcon } {
  if (location.passedToMiniMax) return { tone: "ok", icon: Icon.image };
  if (location.changedSinceCheck || location.mode === "not_checked") return { tone: "info", icon: Icon.refresh };
  if (location.mode === "failed") return { tone: "error", icon: Icon.imageMissing };
  return { tone: "warn", icon: Icon.imageAdd };
}

function RequestCard({ location, disabled, onCopy, onCopyError, onChoose, onDropFile }: {
  location: RequestedLocationStatus; disabled: boolean; onCopy(): Promise<unknown>; onCopyError(reason: unknown): void; onChoose(): void; onDropFile(file: File): void;
}) {
  const [over, setOver] = useState(false);
  const usable = Boolean(location.slug);
  const state = requestState(location);
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file && usable && !disabled) onDropFile(file);
  };
  return <article className={cx("request-card", location.passedToMiniMax && "ready", state.tone === "error" && "failed")}>
    {location.previewUrl ? <img src={location.previewUrl} alt="" /> : <div className="thumb-placeholder"><Icon.imageAdd size={24} aria-hidden />No image yet</div>}
    <div className="request-body">
      <h3>{location.name}</h3>
      <p className="meta-line"><Icon.film size={14} aria-hidden />Used in {sectionRange(location.sections) || "performer scenes"}{location.brollSections.length ? ` · also B-roll in ${sectionRange(location.brollSections).toLowerCase()}` : ""}</p>
      {location.storyNote && <p className="story-note">“{location.storyNote}”</p>}
      {usable && <div className="file-line"><Icon.image size={15} aria-hidden /><code className="filename">{location.fileName}</code>
        <CopyButton shown="text" label="Copy filename" copy={onCopy} onError={onCopyError} /></div>}
      <div className="mode-line"><Pill tone={state.tone} icon={state.icon}>{location.modeLabel}</Pill>
        <span className={cx("minimax", location.passedToMiniMax && "yes")}>{location.passedToMiniMax ? "Passed to MiniMax as an image reference" : "Not passed to MiniMax yet"}</span></div>
      <p className="reason selectable">{location.reason}</p>
      {location.checkedAt && <p className="muted small">Last checked {formatWhen(location.checkedAt)}</p>}
    </div>
    {usable && <div className="drop-side">
      <div className={cx("dropzone", over && "over", disabled && "disabled")} onDragOver={(event) => { event.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)} onDrop={onDrop}>
        <Icon.imageAdd size={26} aria-hidden />
        <p>Drag and drop an image here<br /><small>saved as <b>{location.fileName}</b></small></p>
      </div>
      <Button variant="secondary" icon={location.candidates.length ? Icon.replace : Icon.openFolder} disabled={disabled} onClick={onChoose}>{location.candidates.length ? "Replace image…" : "Choose image…"}</Button>
    </div>}
  </article>;
}

function TextOnlySection({ broll, performer }: { broll: TextOnlyLocationStatus[]; performer: TextOnlyLocationStatus[] }) {
  return <section className="panel location-group">
    <GroupHead icon={Icon.file} tone="muted" title="Text-only locations" text="Described in text; no image is requested or passed to MiniMax for these." />
    <ul className="text-only-list">
      {broll.map((item) => <li key={`b-${item.name}`}><b>{item.name}</b><Pill tone="muted" icon={Icon.file}>Text-only B-roll</Pill><span className="muted small">{sectionRange(item.sections)} · {item.reason}</span></li>)}
      {performer.map((item) => <li key={`p-${item.name}`}><b>{item.name}</b><Pill tone="warn" icon={Icon.file}>Text-only performer place</Pill><span className="muted small">{sectionRange(item.sections)} · {item.reason}</span></li>)}
    </ul>
  </section>;
}

function LastCheck({ check }: { check: LocationCheckRun }) {
  return <section className="panel last-check">
    <Disclosure icon={Icon.log} summary={<>Last check {check.completedAt ? formatWhen(check.completedAt) : ""} <span className="muted">· {check.readyToProduce ? "all requested images ready" : "images still needed"}{check.storyUnchanged ? " · story unchanged" : ""}</span></>}>
      <ul className="check-lines">{check.summary.map((line) => <li key={line}><code className="selectable">{line}</code></li>)}</ul>
      {check.report && <pre className="log">{check.report}</pre>}
    </Disclosure>
  </section>;
}
