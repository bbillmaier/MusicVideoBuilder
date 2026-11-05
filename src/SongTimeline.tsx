import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { readableError } from "./ProjectsView";
import { usePeaks } from "./useSongPeaks";
import { Button, ConfirmDialog, Icon, IconButton, Notice, PanelHead, Pill, cx, type LucideIcon } from "./ui";
import { TIMELINE_ROLES, TIMELINE_SCENES, TIMELINE_TRANSITIONS } from "../electron/contracts";
import {
  automaticShots, deleteSection, deleteShot, isSectionStart, mergeSections, mergeShots, moveSectionBoundary, moveShotCut, setSectionRole,
  setShotScene, setShotTransition, shortShots, snapTime, splitSection, splitShot,
} from "../electron/timeline-edit";

const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16];
/** Peak resolution for the waveform: enough for the deepest zoom without decoding per zoom level. */
const PEAK_BARS = 6000;
const MAX_CANVAS_PX = 16000;

const SCENE_CLASS: Record<TimelineScene, string> = { Dance: "dance", Performance: "performance", Freeform: "freeform", "B-roll": "broll" };
const JOIN_ICON: Record<string, LucideIcon> = { "Hard cut": Icon.hardCut, "New angle": Icon.newAngle, Continue: Icon.continueShot };
const PHASE_CLASS: Record<string, string> = { Arrival: "arrival", Friction: "friction", Escalation: "escalation", Break: "break", Release: "release" };

/** Selected row item, by 0-based index into the shown sections or shots. */
type Selection = { kind: "section" | "shot"; index: number } | null;
type History = { past: TimelineDraft[]; present: TimelineDraft; future: TimelineDraft[] };
type Drag = { kind: "section" | "shot"; index: number; base: TimelineDraft };

type ViewSection = SongTimelineSection;
type ViewShot = SongTimelineShot;

/** Loads the song timeline and keeps it current through plan, produce and project change events. */
function useSongTimeline(projectId: string) {
  const [timeline, setTimeline] = useState<SongTimeline>();
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setTimeline(await window.martini.plan.timeline(projectId)); setError(""); }
    catch (reason) { setError(readableError(reason)); }
  }, [projectId]);
  useEffect(() => {
    void refresh();
    const onChange = (changed: string) => { if (changed === projectId) void refresh(); };
    const offs = [window.martini.plan.onChanged(onChange), window.martini.produce.onChanged(onChange), window.martini.projects.onChanged(onChange)];
    return () => offs.forEach((off) => off());
  }, [projectId, refresh]);
  return { timeline, setTimeline, error, setError, refresh };
}

/** m:ss.s, for the transport and the details line. */
function clock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** A ruler step that leaves at least ~70 px between labels. */
function rulerStep(pxPerSecond: number): number {
  return [1, 2, 5, 10, 15, 30, 60, 120].find((step) => step * pxPerSecond >= 70) ?? 240;
}

/** Index of the last start at or before `time` (items sorted by start). */
function at<T extends { start: number }>(items: T[], time: number): number {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle].start <= time + 1e-6) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}

function draftOf(timeline: SongTimeline): TimelineDraft {
  return {
    sections: timeline.sections.map(({ start, end, role, label, energy, loudness, origin }) => ({ start, end, role, label, energy, loudness, origin })),
    shots: timeline.shots.map((shot) => ({ start: shot.start, scene: shot.override.scene, transition: shot.override.transition })),
  };
}

/** What the rows show for an edited draft: plan scene, action and phase follow each section's story (origin). */
function viewOf(timeline: SongTimeline, draft: TimelineDraft): { sections: ViewSection[]; shots: ViewShot[] } {
  const sections = draft.sections.map((section, index): ViewSection => {
    const planned = section.origin === null ? undefined : timeline.planSections.find((item) => item.number === section.origin);
    const shown = section.origin === null ? undefined : timeline.sections.find((item) => item.origin === section.origin);
    return {
      number: index + 1, start: section.start, end: section.end, label: section.label, role: section.role, energy: section.energy,
      loudness: section.loudness, origin: section.origin, scene: planned?.scene ?? null, action: planned?.action ?? null, phase: shown?.phase ?? null,
    };
  });
  const shots = draft.shots.map((shot, index): ViewShot => {
    const end = index + 1 < draft.shots.length ? draft.shots[index + 1].start : timeline.duration;
    const section = Math.max(0, sections.findIndex((item) => shot.start >= item.start - 1e-3 && shot.start < item.end - 1e-3));
    return {
      number: index + 1, start: shot.start, end, section: section + 1, scene: shot.scene ?? sections[section]?.scene ?? null,
      transition: index === 0 ? "Hard cut" : shot.transition, clips: [], override: { scene: shot.scene, transition: shot.transition },
    };
  });
  return { sections, shots };
}

const sameDraft = (a: TimelineDraft, b: TimelineDraft) => JSON.stringify(a) === JSON.stringify(b);

export function SongTimeline({ projectId, planRunning }: { projectId: string; planRunning: boolean }) {
  const { timeline, setTimeline, error, setError } = useSongTimeline(projectId);
  const [starting, setStarting] = useState(false);

  const analyze = async () => {
    setStarting(true);
    try { setTimeline(await window.martini.plan.analyzeSong(projectId)); setError(""); }
    catch (reason) { setError(readableError(reason)); }
    finally { setStarting(false); }
  };

  if (!timeline) {
    return error ? <Notice tone="error" title="The song timeline could not be loaded" live>{error}</Notice> : null;
  }
  if (timeline.analysisSource === "none" || !timeline.sections.length) {
    const { analysis } = timeline;
    return <section className="panel song-timeline" aria-label="Song timeline">
      <PanelHead icon={Icon.timeline} title="Song timeline" />
      {error && <Notice tone="error" live onDismiss={() => setError("")}>{error}</Notice>}
      {timeline.notes.map((note) => <Notice key={note} tone="warn">{note}</Notice>)}
      {analysis.running || planRunning
        ? <Notice tone="working" live title={analysis.running ? "Analyzing the song…" : "The director plan is analyzing the song…"}>
          <p>Beats, bars and sections are found without the LLM. This usually takes under a minute.</p></Notice>
        : <div className="st-empty">
          <p>Analyze the song to see its sections and beat grid, and where your Direction timing settings would cut shots. You can then edit sections and shots before the director plans the story. This doesn't use the LLM.</p>
          {analysis.error && <Notice tone="error" title="The song analysis failed">{analysis.error}</Notice>}
          {analysis.blocker && <p className="muted small">{analysis.blocker}</p>}
          <div className="row-actions">
            <Button variant="secondary" icon={Icon.timeline} busy={starting} disabled={!analysis.canStart} onClick={() => void analyze()}>Analyze song</Button>
          </div>
        </div>}
    </section>;
  }
  return <TimelineEditor key={`${timeline.songUrl}|${timeline.duration}`} projectId={projectId} timeline={timeline} onSaved={setTimeline} />;
}

function TimelineEditor({ projectId, timeline, onSaved }: { projectId: string; timeline: SongTimeline; onSaved(timeline: SongTimeline): void }) {
  const { duration, beats } = timeline;
  const peaks = usePeaks(timeline.songUrl, PEAK_BARS);
  const audio = useRef<HTMLAudioElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const clockText = useRef<HTMLSpanElement>(null);
  const scrubbing = useRef(false);
  const [viewWidth, setViewWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [activeShot, setActiveShot] = useState(-1);
  const [audioError, setAudioError] = useState(false);

  // Editing: a draft with undo/redo; nothing is written until Save timeline.
  const [history, setHistory] = useState<History | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dragDraft, setDragDraft] = useState<TimelineDraft | null>(null);
  const dragDraftRef = useRef<TimelineDraft | null>(null);
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<TimelineSaveImpact | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = history !== null;
  const original = useMemo(() => draftOf(timeline), [timeline]);
  const draft = dragDraft ?? history?.present ?? null;
  const dirty = Boolean(history && !sameDraft(history.present, original));
  const view = useMemo(() => (draft ? viewOf(timeline, draft) : { sections: timeline.sections, shots: timeline.shots }), [draft, timeline]);
  const { sections, shots } = view;

  // Leave edit mode when editing stops being allowed (a plan run started, the apply began, a package appeared).
  useEffect(() => { if (!timeline.edit.allowed && history && !saving) { setHistory(null); setDragDraft(null); } }, [timeline.edit.allowed, history, saving]);

  const commit = useCallback((next: TimelineDraft) => {
    setHistory((current) => (current && !sameDraft(current.present, next) ? { past: [...current.past.slice(-99), current.present], present: next, future: [] } : current));
    setMessage("");
  }, []);
  const tryEdit = (change: (current: TimelineDraft) => TimelineDraft, select?: Selection) => {
    if (!history) return;
    try { commit(change(history.present)); if (select !== undefined) setSelection(select); }
    catch (reason) { setMessage(readableError(reason)); }
  };
  const undo = () => setHistory((current) => (current?.past.length ? { past: current.past.slice(0, -1), present: current.past[current.past.length - 1], future: [current.present, ...current.future] } : current));
  const redo = () => setHistory((current) => (current?.future.length ? { past: [...current.past, current.present], present: current.future[0], future: current.future.slice(1) } : current));
  const startEditing = (from?: TimelineDraft) => { setHistory({ past: [], present: original, future: [] }); if (from) commit(from); setSelection(null); setMessage(""); };
  const stopEditing = () => { setHistory(null); setDragDraft(null); setSelection(null); setMessage(""); setConfirm(null); };

  const save = async (confirmed: boolean) => {
    if (!history) return;
    setSaving(true);
    setMessage("");
    try {
      if (!confirmed) {
        const impact = await window.martini.plan.timelineImpact(projectId, history.present);
        if (impact.usesLlm) { setConfirm(impact); return; }
      }
      setConfirm(null);
      onSaved(await window.martini.plan.saveTimeline(projectId, history.present, true));
      stopEditing();
    } catch (reason) { setMessage(readableError(reason)); }
    finally { setSaving(false); }
  };

  const width = Math.max(1, viewWidth * zoom);
  const pxPerSecond = duration ? width / duration : 0;
  const pct = (value: number) => `${(value / duration) * 100}%`;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewWidth(element.clientWidth));
    observer.observe(element);
    setViewWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  // waveform and beat grid; redrawn only when the size or data changes, never per playback frame
  useEffect(() => {
    const element = canvas.current;
    if (!element || !viewWidth) return;
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_PX / width);
    const height = element.clientHeight || 64;
    element.width = Math.round(width * ratio);
    element.height = Math.round(height * ratio);
    const context = element.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const styles = getComputedStyle(element);
    const beatColor = styles.getPropertyValue("--st-beat").trim() || "rgba(255,255,255,0.06)";
    const barColor = styles.getPropertyValue("--st-bar").trim() || "rgba(255,255,255,0.16)";
    const waveColor = styles.getPropertyValue("--st-wave").trim() || "#8a8ea0";
    const beatPx = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) * pxPerSecond : 0;
    beats.forEach((beat, index) => {
      const bar = index % 4 === 0;
      if (!bar && beatPx < 6) return;
      context.fillStyle = bar ? barColor : beatColor;
      context.fillRect(Math.round(beat * pxPerSecond), 0, 1, height);
    });
    if (peaks) {
      context.fillStyle = waveColor;
      const middle = height / 2;
      const columns = Math.ceil(width / 2);
      for (let column = 0; column < columns; column++) {
        const from = Math.floor((column * 2 / width) * peaks.length);
        const to = Math.max(from + 1, Math.floor(((column + 1) * 2 / width) * peaks.length));
        let peak = 0;
        for (let i = from; i < to && i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
        const half = Math.max(1, peak * (middle - 2));
        context.fillRect(column * 2, middle - half, 1.4, half * 2);
      }
    }
  }, [peaks, beats, width, viewWidth, pxPerSecond]);

  const moveHead = useCallback((time: number) => {
    if (playhead.current) playhead.current.style.transform = `translateX(${time * pxPerSecond}px)`;
    if (clockText.current) clockText.current.textContent = clock(time);
    const index = at(shots, time);
    setActiveShot((previous) => (previous === index ? previous : index));
  }, [pxPerSecond, shots]);

  // keep the playhead in view while playing when zoomed in
  const follow = useCallback((time: number) => {
    const element = scroller.current;
    if (!element || zoom === 1) return;
    const x = time * pxPerSecond;
    if (x < element.scrollLeft || x > element.scrollLeft + element.clientWidth - 40) element.scrollLeft = Math.max(0, x - element.clientWidth * 0.15);
  }, [pxPerSecond, zoom]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const time = audio.current?.currentTime ?? 0;
      moveHead(time);
      if (!scrubbing.current && !drag) follow(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, moveHead, follow, drag]);

  useEffect(() => { moveHead(audio.current?.currentTime ?? 0); }, [moveHead]);

  const seek = useCallback((time: number) => {
    const clamped = Math.min(Math.max(0, time), duration);
    if (audio.current) audio.current.currentTime = clamped;
    moveHead(clamped);
  }, [duration, moveHead]);

  const toggle = () => {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setAudioError(true)); else element.pause();
  };
  const playheadTime = () => audio.current?.currentTime ?? 0;

  const timeAt = useCallback((clientX: number) => {
    const rect = content.current?.getBoundingClientRect();
    return rect && pxPerSecond ? Math.min(Math.max(0, (clientX - rect.left) / pxPerSecond), duration) : 0;
  }, [pxPerSecond, duration]);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    scrubbing.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    seek(timeAt(event.clientX));
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => { if (scrubbing.current) seek(timeAt(event.clientX)); };
  const onPointerUp = () => { scrubbing.current = false; };

  // Clicking a section or shot. In edit mode: Ctrl+click splits it there, and Shift+click merges it into the selected one.
  const pickItem = (event: ReactPointerEvent, kind: "section" | "shot", index: number, start: number) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    if (editing && (event.ctrlKey || event.metaKey)) {
      const time = snapTime(timeAt(event.clientX), beats, event.altKey ? "none" : kind === "section" ? "bar" : "beat");
      tryEdit((current) => (kind === "section" ? splitSection(current, time) : splitShot(current, time, duration)), null);
      return;
    }
    if (editing && event.shiftKey && selection?.kind === kind && selection.index !== index) {
      const keep = selection.index;
      const keepFirst = keep < index;
      tryEdit((current) => (kind === "section" ? mergeSections(current, keep, index) : mergeShots(current, keep, index)),
        { kind, index: keepFirst ? keep : index });
      return;
    }
    setSelection({ kind, index });
    seek(start);
  };

  // Dragging a section edge or a shot cut (edit mode). Snaps to bars (sections) or beats (shots); Alt places freely.
  const startDrag = (event: ReactPointerEvent, kind: "section" | "shot", index: number) => {
    event.stopPropagation();
    event.preventDefault();
    if (!history || event.button !== 0) return;
    setDrag({ kind, index, base: history.present });
    setSelection(null);
  };
  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const time = snapTime(timeAt(event.clientX), beats, event.altKey ? "none" : drag.kind === "section" ? "bar" : "beat");
      try {
        const next = drag.kind === "section" ? moveSectionBoundary(drag.base, drag.index, time) : moveShotCut(drag.base, drag.index, time, duration);
        dragDraftRef.current = next;
        setDragDraft(next);
      } catch (reason) { setMessage(readableError(reason)); }
    };
    const up = () => {
      const next = dragDraftRef.current;
      dragDraftRef.current = null;
      if (next) commit(next);
      setDragDraft(null);
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [drag, beats, duration, timeAt, commit]);

  const setZoomAround = (next: number, anchorClientX?: number) => {
    const element = scroller.current;
    const clamped = Math.min(ZOOMS[ZOOMS.length - 1], Math.max(1, next));
    if (!element || clamped === zoom) return;
    const rect = element.getBoundingClientRect();
    const anchorX = anchorClientX === undefined ? element.clientWidth / 2 : anchorClientX - rect.left;
    const time = (element.scrollLeft + anchorX) / pxPerSecond;
    setZoom(clamped);
    requestAnimationFrame(() => { element.scrollLeft = Math.max(0, time * viewWidth * clamped / duration - anchorX); });
  };
  const stepZoom = (direction: 1 | -1) => {
    const index = ZOOMS.findIndex((value) => value >= zoom);
    setZoomAround(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (index < 0 ? ZOOMS.length - 1 : index) + direction))]);
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey) return;
    setZoomAround(zoom * (event.deltaY < 0 ? 1.25 : 0.8), event.clientX);
  };
  // React's onWheel is passive, so ctrl+wheel would also zoom the whole window; stop that natively
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const block = (event: globalThis.WheelEvent) => { if (event.ctrlKey) event.preventDefault(); };
    element.addEventListener("wheel", block, { passive: false });
    return () => element.removeEventListener("wheel", block);
  }, []);

  const deleteSelected = () => {
    if (!selection) return;
    if (selection.kind === "section") tryEdit((current) => deleteSection(current, selection.index), null);
    else tryEdit((current) => deleteShot(current, selection.index), null);
  };
  const splitSelectedAtPlayhead = () => {
    if (!selection) return;
    const time = snapTime(playheadTime(), beats, "none");
    tryEdit((current) => (selection.kind === "section" ? splitSection(current, time) : splitShot(current, time, duration)), null);
  };

  const cuts = useMemo(() => shots.map((shot) => shot.start), [shots]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const now = playheadTime();
    const mod = event.ctrlKey || event.metaKey;
    if (event.key === " ") { event.preventDefault(); toggle(); }
    else if (editing && mod && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (editing && mod && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
    else if (editing && (event.key === "Delete" || event.key === "Backspace")) { event.preventDefault(); deleteSelected(); }
    else if (event.key === "Escape") { setSelection(null); }
    else if (event.key === "ArrowRight") { event.preventDefault(); const next = cuts.find((cut) => cut > now + 0.05); if (next !== undefined) { seek(next); follow(next); } }
    else if (event.key === "ArrowLeft") { event.preventDefault(); const previous = [...cuts].reverse().find((cut) => cut < now - 0.3) ?? 0; seek(previous); follow(previous); }
    else if (event.key === "Home") { event.preventDefault(); seek(0); if (scroller.current) scroller.current.scrollLeft = 0; }
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); stepZoom(1); }
    else if (event.key === "-") { event.preventDefault(); stepZoom(-1); }
  };

  const step = rulerStep(pxPerSecond || 1);
  const ticks: number[] = [];
  for (let time = 0; time <= duration; time += step) ticks.push(time);
  const source = editing ? { text: dirty ? "Editing — unsaved changes" : "Editing", tone: "accent" as const, icon: Icon.edit }
    : timeline.shotSource === "package" ? { text: "Clips from the current prompt package", tone: "ok" as const, icon: Icon.film }
      : timeline.shotSource === "timeline" ? { text: "Your saved timeline", tone: "ok" as const, icon: Icon.timeline }
        : { text: "Automatic cuts", tone: "info" as const, icon: Icon.timeline };
  const scenes = new Set(shots.map((shot) => shot.scene ?? "unknown"));
  const short = draft ? shortShots(draft, duration, timeline.cutSettings.minShotSeconds) : [];
  const newStories = draft ? draft.sections.map((section, index) => (section.origin === null ? index + 1 : 0)).filter(Boolean) : [];
  const planExists = timeline.planSections.length > 0;

  return <section className={cx("panel song-timeline", editing && "is-editing")} aria-label="Song timeline">
    <PanelHead icon={Icon.timeline} title="Song timeline" count={`${sections.length} sections · ${shots.length} shots`}
      aside={<>
        <Pill tone={source.tone} icon={source.icon} title={timeline.notes.join(" ")}>{source.text}</Pill>
        {!editing && timeline.edit.allowed && <Button variant="secondary" size="sm" icon={Icon.edit} onClick={() => startEditing()}>Edit timeline</Button>}
      </>} />

    {timeline.edit.applying && <Notice tone="working" live title="Applying your timeline to the plan…">
      <p>Story beats move with their sections{planExists ? ", and the LLM writes new ones for changed sections" : ""}. The plan updates when it finishes.</p></Notice>}
    {timeline.unsaved && !editing && !timeline.edit.applying && <Notice tone={timeline.edit.error ? "error" : "warn"} live
      title={timeline.edit.error ? "The timeline was not saved" : "You have timeline edits that were not saved"}
      actions={<>
        <Button variant="primary" size="sm" icon={Icon.edit} disabled={!timeline.edit.allowed} onClick={() => startEditing(timeline.unsaved!.draft)}>Restore edits</Button>
        <Button variant="secondary" size="sm" onClick={() => void window.martini.plan.discardUnsavedTimeline(projectId).then(onSaved).catch((reason) => setMessage(readableError(reason)))}>Discard them</Button>
      </>}>
      {timeline.edit.error ? <p>{timeline.edit.error}</p> : <p>A save didn't finish. Restore the edits to keep working on them, then save again.</p>}
    </Notice>}
    {timeline.edit.error && !timeline.unsaved && !editing && <Notice tone="error" live>{timeline.edit.error}</Notice>}

    <div className="st-transport">
      <IconButton className="play-btn" icon={playing ? Icon.pause : Icon.render} label={playing ? "Pause (Space)" : "Play (Space)"} onClick={toggle} disabled={!timeline.songUrl} />
      <IconButton icon={Icon.toStart} size="sm" label="Back to start (Home)" onClick={() => { seek(0); if (scroller.current) scroller.current.scrollLeft = 0; }} />
      <span className="st-clock num"><span ref={clockText}>0:00.0</span><span className="muted"> / {clock(duration)}</span></span>
      {timeline.bpm ? <span className="muted small num">{Math.round(timeline.bpm)} BPM</span> : null}
      {editing && <span className="st-history">
        <IconButton icon={Icon.retry} size="sm" label="Undo (Ctrl+Z)" disabled={!history?.past.length} onClick={undo} />
        <IconButton icon={Icon.redo} size="sm" label="Redo (Ctrl+Y)" disabled={!history?.future.length} onClick={redo} />
      </span>}
      <span className="st-zoom">
        <IconButton icon={Icon.zoomOut} size="sm" label="Zoom out (−)" disabled={zoom <= 1} onClick={() => stepZoom(-1)} />
        <span className="muted small num" aria-live="polite">{zoom === 1 ? "Fit" : `${Number(zoom.toFixed(1))}×`}</span>
        <IconButton icon={Icon.zoomIn} size="sm" label="Zoom in (+)" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => stepZoom(1)} />
      </span>
    </div>
    {!timeline.songUrl && <Notice tone="warn">The project's copy of the song is missing, so it can't play. Replace it on Projects.</Notice>}
    {audioError && <Notice tone="warn" onDismiss={() => setAudioError(false)}>The song could not be played.</Notice>}

    <div className="st-frame">
      <div className="st-labels" aria-hidden>
        <span className="st-label st-label-ruler" /><span className="st-label">Sections</span><span className="st-label st-label-wave"><Icon.song size={16} /></span><span className="st-label">Shots</span>
      </div>
      <div className="st-scroll" ref={scroller} tabIndex={0} role="group"
        aria-label={`Song timeline. Space plays or pauses, arrow keys jump between cuts, plus and minus zoom.${editing ? " Ctrl+click splits, click then Shift+click merges, Delete removes, Ctrl+Z undoes." : ""}`}
        onKeyDown={onKeyDown} onWheel={onWheel}>
        <div className={cx("st-content", drag && "is-dragging")} ref={content} style={{ width: `${width}px` }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <div className="st-row st-ruler">
            {ticks.map((time) => <span key={time} className="st-tick num" style={{ left: `${time * pxPerSecond}px` }}>{`${Math.floor(time / 60)}:${String(Math.round(time % 60)).padStart(2, "0")}`}</span>)}
          </div>
          <div className="st-row st-sections">
            {sections.map((section, index) => {
              const px = (section.end - section.start) * pxPerSecond;
              const selected = selection?.kind === "section" && selection.index === index;
              const fresh = editing && planExists && section.origin === null;
              return <button key={`${index}-${section.start}`} type="button" tabIndex={-1}
                className={cx("st-section", PHASE_CLASS[section.phase ?? ""], selected && "selected", fresh && "fresh")}
                style={{ left: pct(section.start), width: pct(section.end - section.start) }}
                title={`Section ${section.number} · ${section.role}${section.label ? ` (${section.label})` : ""}${fresh ? "\nNew story on save" : section.action ? `\n${section.action}` : ""}`}
                onPointerDown={(event) => pickItem(event, "section", index, section.start)}>
                <b className="num">{section.number}</b>{px > 70 && <span>{section.role}</span>}{fresh && px > 40 && <Icon.edit size={11} aria-hidden />}
              </button>;
            })}
            {editing && sections.slice(1).map((section, offset) => <span key={`edge-${offset}`} className="st-handle section"
              style={{ left: pct(section.start) }} title="Drag to move the section edge (snaps to bars; hold Alt to place freely)"
              onPointerDown={(event) => startDrag(event, "section", offset + 1)} />)}
          </div>
          <div className="st-row st-wave"><canvas ref={canvas} aria-hidden />{!peaks && <span className="st-wave-note muted small">Reading the song…</span>}</div>
          <div className="st-row st-shots">
            {shots.map((shot, index) => {
              const px = (shot.end - shot.start) * pxPerSecond;
              const selected = selection?.kind === "shot" && selection.index === index;
              const Join = shot.transition && index > 0 ? JOIN_ICON[shot.transition] : undefined;
              const tooShort = editing && short.includes(index + 1);
              return <button key={`${index}-${shot.start}`} type="button" tabIndex={-1}
                className={cx("st-shot", shot.scene ? SCENE_CLASS[shot.scene] : "unknown", selected && "selected", activeShot === index && "playing",
                  tooShort && "short", (shot.override.scene || shot.override.transition) && "chosen")}
                style={{ left: pct(shot.start), width: pct(shot.end - shot.start) }}
                title={`Shot ${shot.number} · ${clock(shot.start)}–${clock(shot.end)} · ${shot.scene ?? "Director decides"}${shot.transition ? ` · ${shot.transition}` : ""}${tooShort ? "\nShorter than your minimum shot length" : ""}`}
                onPointerDown={(event) => pickItem(event, "shot", index, shot.start)}>
                {Join && px > 18 && <Join size={12} className="st-join" aria-hidden />}
                {px > 64 && <span className="st-shot-text">{shot.scene ?? "—"}</span>}
                {shot.clips.slice(1).map((clip) => <i key={clip.index} className="st-clip-split" style={{ left: `${((clip.start - shot.start) / (shot.end - shot.start)) * 100}%` }} />)}
              </button>;
            })}
            {editing && draft && shots.map((shot, index) => {
              if (index === 0) return null;
              // a cut on a section edge moves that edge (both sections and both shots change length)
              const edge = isSectionStart(draft, shot.start) ? draft.sections.findIndex((item) => Math.abs(item.start - shot.start) < 1e-3) : -1;
              return <span key={`cut-${index}`} className={cx("st-handle", edge > 0 ? "section" : "shot")} style={{ left: pct(shot.start) }}
                title={edge > 0 ? "Drag to move this cut and its section edge (snaps to bars; hold Alt to place freely)" : "Drag to move the cut (snaps to beats; hold Alt to place freely)"}
                onPointerDown={(event) => (edge > 0 ? startDrag(event, "section", edge) : startDrag(event, "shot", index))} />;
            })}
          </div>
          <div className="st-playhead" ref={playhead} aria-hidden />
        </div>
      </div>
    </div>

    {message && <Notice tone="warn" live onDismiss={() => setMessage("")}>{message}</Notice>}
    {editing && draft
      ? <Inspector draft={draft} view={view} selection={selection} planExists={planExists}
        onRole={(index, role) => tryEdit((current) => setSectionRole(current, index, role))}
        onScene={(index, scene) => tryEdit((current) => setShotScene(current, index, scene))}
        onTransition={(index, transition) => tryEdit((current) => setShotTransition(current, index, transition))}
        onSplit={splitSelectedAtPlayhead} onDelete={deleteSelected} />
      : <Details timeline={timeline} view={view} selection={selection} />}

    <div className="st-legend muted small">
      {TIMELINE_SCENES.filter((scene) => scenes.has(scene)).map((scene) => <span key={scene}><i className={cx("st-swatch", SCENE_CLASS[scene])} />{scene}</span>)}
      {scenes.has("unknown") && <span><i className="st-swatch unknown" />Director decides</span>}
      {shots.some((shot, index) => index > 0 && shot.transition) && <span><Icon.hardCut size={12} aria-hidden />Hard cut <Icon.newAngle size={12} aria-hidden />New angle <Icon.continueShot size={12} aria-hidden />Continue</span>}
      <span className="st-hint">{editing
        ? "Drag edges and cuts · Ctrl+click splits · Click, then Shift+click merges into the first · Delete removes · Alt places freely"
        : "Click to jump · Space plays · ←/→ jumps between cuts · Ctrl+wheel zooms"}</span>
    </div>

    {editing && <div className="st-draftbar">
      <div className="st-draft-state">
        {short.length > 0 && <span className="warn-text small"><Icon.warning size={13} aria-hidden /> Shot{short.length === 1 ? "" : "s"} {short.join(", ")} {short.length === 1 ? "is" : "are"} shorter than your {timeline.cutSettings.minShotSeconds} s minimum. Allowed; the renderer makes at least about 5 s and trims it.</span>}
        {planExists && newStories.length > 0 && <span className="muted small"><Icon.edit size={13} aria-hidden /> Section{newStories.length === 1 ? "" : "s"} {newStories.join(", ")} will get a new story from the LLM on save.</span>}
        {!dirty && <span className="muted small">No changes yet.</span>}
      </div>
      <div className="row-actions">
        <Button variant="quiet" size="sm" icon={Icon.reroll} onClick={() => tryEdit((current) => automaticShots(current, beats, timeline.cutSettings), null)}
          title="Replace every shot with automatic cuts from your Direction timing settings; scene and transition choices go back to Auto">Automatic cuts</Button>
        <Button variant="secondary" size="sm" onClick={stopEditing} disabled={saving}>{dirty ? "Discard" : "Done"}</Button>
        <Button variant="primary" size="sm" icon={Icon.save} busy={saving} disabled={!dirty} onClick={() => void save(false)}>Save timeline</Button>
      </div>
    </div>}
    {!editing && !timeline.edit.allowed && timeline.edit.reason && timeline.shotSource === "package" && <p className="muted small st-notes"><Icon.info size={14} aria-hidden />{timeline.edit.reason}</p>}
    {timeline.notes.length > 0 && !editing && <p className="muted small st-notes"><Icon.info size={14} aria-hidden />{timeline.notes.join(" ")}</p>}

    {confirm && <ConfirmDialog title="Rewrite the story of changed sections?" icon={Icon.edit} tone="warn" confirmVariant="primary" confirmIcon={Icon.save}
      confirmLabel="Save and rewrite" cancelLabel="Keep editing" onCancel={() => setConfirm(null)} onConfirm={() => void save(true)}>
      <p>Section{confirm.rewrite.length === 1 ? "" : "s"} {confirm.rewrite.join(", ")} {confirm.rewrite.length === 1 ? "was" : "were"} split, merged, added or deleted, so the director LLM writes a new story beat for {confirm.rewrite.length === 1 ? "it" : "them"}.</p>
      <p>Every other section keeps its story, including your edited actions. Section timing and shot cuts are exactly what you set; the LLM never changes them.</p>
      <p className="muted small">This runs in ComfyUI and usually takes a minute or two. If it fails, nothing is saved.</p>
    </ConfirmDialog>}

    {timeline.songUrl && <audio ref={audio} src={timeline.songUrl} preload="auto" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
      onEnded={() => setPlaying(false)} onSeeked={(event) => moveHead(event.currentTarget.currentTime)} onError={() => setAudioError(true)} />}
  </section>;
}

function Inspector({ draft, view, selection, planExists, onRole, onScene, onTransition, onSplit, onDelete }: {
  draft: TimelineDraft; view: { sections: ViewSection[]; shots: ViewShot[] }; selection: Selection; planExists: boolean;
  onRole(index: number, role: string): void; onScene(index: number, scene: TimelineScene | null): void;
  onTransition(index: number, transition: TimelineTransition | null): void; onSplit(): void; onDelete(): void;
}) {
  if (!selection) return <p className="st-details muted small">Select a section or shot to change it. Ctrl+click splits one where you click; click one, then Shift+click another to merge it into the first.</p>;
  if (selection.kind === "section") {
    const section = view.sections[selection.index];
    const raw = draft.sections[selection.index];
    if (!section || !raw) return null;
    const roles: readonly string[] = TIMELINE_ROLES.includes(raw.role as typeof TIMELINE_ROLES[number]) ? TIMELINE_ROLES : [raw.role, ...TIMELINE_ROLES];
    return <div className="st-details st-inspector">
      <b>Section {section.number}</b>
      <span className="num">{clock(section.start)}–{clock(section.end)} · {(section.end - section.start).toFixed(1)} s</span>
      <label className="st-field"><span className="muted">Role</span>
        <select className="select" value={raw.role} onChange={(event) => onRole(selection.index, event.target.value)}>
          {roles.map((role) => <option key={role} value={role}>{role}</option>)}
        </select></label>
      {planExists && (raw.origin === null ? <Pill tone="accent" icon={Icon.edit}>New story on save</Pill> : <Pill tone="muted" icon={null}>Story kept</Pill>)}
      <Button variant="quiet" size="sm" icon={Icon.hardCut} onClick={onSplit}>Split at playhead</Button>
      <Button variant="quiet" size="sm" icon={Icon.remove} onClick={onDelete} disabled={draft.sections.length < 2}>Delete section</Button>
      {section.action && raw.origin !== null && <p className="st-action">{section.action}</p>}
    </div>;
  }
  const shot = view.shots[selection.index];
  const raw = draft.shots[selection.index];
  if (!shot || !raw) return null;
  return <div className="st-details st-inspector">
    <b>Shot {shot.number}</b>
    <span className="num">{clock(shot.start)}–{clock(shot.end)} · {(shot.end - shot.start).toFixed(1)} s</span>
    <span className="muted">Section {shot.section}</span>
    <label className="st-field"><span className="muted">Scene</span>
      <select className="select" value={raw.scene ?? ""} onChange={(event) => onScene(selection.index, (event.target.value || null) as TimelineScene | null)}>
        <option value="">Auto{shot.scene && !raw.scene ? ` (${shot.scene})` : ""}</option>
        {TIMELINE_SCENES.map((scene) => <option key={scene} value={scene}>{scene}</option>)}
      </select></label>
    <label className="st-field"><span className="muted">Joins previous by</span>
      <select className="select" value={selection.index === 0 ? "Hard cut" : raw.transition ?? ""} disabled={selection.index === 0}
        onChange={(event) => onTransition(selection.index, (event.target.value || null) as TimelineTransition | null)}>
        {selection.index > 0 && <option value="">Auto</option>}
        {TIMELINE_TRANSITIONS.map((transition) => <option key={transition} value={transition}>{transition}</option>)}
      </select></label>
    <Button variant="quiet" size="sm" icon={Icon.hardCut} onClick={onSplit}>Split at playhead</Button>
    <Button variant="quiet" size="sm" icon={Icon.remove} onClick={onDelete}>Delete shot</Button>
  </div>;
}

function Details({ timeline, view, selection }: { timeline: SongTimeline; view: { sections: ViewSection[]; shots: ViewShot[] }; selection: Selection }) {
  if (!selection) return <p className="st-details muted small">Select a section or shot to see its details.</p>;
  if (selection.kind === "section") {
    const section = view.sections[selection.index];
    if (!section) return null;
    const inside = view.shots.filter((shot) => shot.section === section.number);
    return <div className="st-details">
      <b>Section {section.number}</b>
      <span className="muted">{section.role}{section.label ? ` (${section.label})` : ""}</span>
      <span className="num">{clock(section.start)}–{clock(section.end)} · {(section.end - section.start).toFixed(1)} s</span>
      <span className="muted num">energy {section.energy.toFixed(2)}</span>
      <span>{inside.length} shot{inside.length === 1 ? "" : "s"}</span>
      {section.scene && <Pill tone="muted" icon={null}>{section.scene}</Pill>}
      {section.phase && <Pill tone="muted" icon={null}>{section.phase}</Pill>}
      {section.action && <p className="st-action">{section.action}</p>}
    </div>;
  }
  const shot = view.shots[selection.index];
  if (!shot) return null;
  const section = timeline.sections.find((item) => item.number === shot.section) ?? view.sections[shot.section - 1];
  const clips = shot.clips.map((clip) => clip.index);
  return <div className="st-details">
    <b>Shot {shot.number}</b>
    <span className="num">{clock(shot.start)}–{clock(shot.end)} · {(shot.end - shot.start).toFixed(1)} s</span>
    {section && <span className="muted">Section {section.number} ({section.role})</span>}
    <Pill tone="muted" icon={null}>{shot.scene ? `${shot.scene}${shot.override.scene ? "" : " (auto)"}` : "Scene: director decides"}</Pill>
    {shot.transition && <Pill tone="muted" icon={JOIN_ICON[shot.transition] ?? null}>{shot.transition}</Pill>}
    {clips.length > 0 && <span className="muted">{clips.length === 1 ? `Clip ${clips[0]}` : `Clips ${clips[0]}–${clips[clips.length - 1]}`}</span>}
  </div>;
}
