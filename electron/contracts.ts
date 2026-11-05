// Types shared by Electron main, preload, and the React renderer (type-only imports in the renderer).

export type AssetRole = "song" | "performer" | "outfit" | "location";

/** Persisted project lifecycle. Ticket 02 only produces `new` and `assets_ready`. */
export type ProjectState =
  | "new" | "assets_ready" | "planned" | "needs_location_images" | "ready_to_produce"
  | "prompt_package_ready" | "rendering" | "stitch_ready" | "complete" | "failed";

/** Whether the ComfyUI-side project.json reflects the current asset list. */
export type ComfySyncStatus = "not_saved" | "waiting_for_assets" | "saving" | "saved" | "failed";

export type ProjectAsset = {
  id: string;
  role: AssetRole;
  displayName: string;
  fileName: string;
  originalPath: string;
  storedPath: string;
  checksum: string | null;
  fileSize: number | null;
  durationSeconds: number | null;
  sortOrder: number;
  /** False when the copied file has gone missing from the project folder. */
  available: boolean;
  /** Loads the copied file (never the original) through the app's read-only asset protocol. */
  previewUrl: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  slug: string;
  projectPath: string;
  status: ProjectState;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  folderExists: boolean;
  songDurationSeconds: number | null;
  counts: Record<AssetRole, number>;
  thumbnailUrl: string | null;
};

export type ProjectDetail = ProjectSummary & {
  assets: ProjectAsset[];
  missing: string[];
  comfySync: { status: ComfySyncStatus; savedAt: string | null; error: string | null; jobId: string | null };
};

export type AssetIssue = { file: string; reason: string };

export type AssetChangeResult = { project: ProjectDetail; added: number; issues: AssetIssue[]; cancelled: boolean };

export type ProjectsOverview = { active: ProjectDetail | null; recent: ProjectSummary[]; projectsRoot: string; rootError: string | null };

// ----- Ticket 03: creative direction and director plan -------------------------------------------------------

/** The only per-project creative input. Everything else the director decides. */
export type CreativeDirection = {
  /** Optional freeform "vibe check". Sent to Martini Shot Plan Story as both its creative and story brief. */
  creativeBrief: string;
  storyWheel: boolean;
  /** 0 = no minimum; the director decides. Plan Story accepts 0–12. */
  minLocations: number;
  requestLocationImages: boolean;
  /** 0–1. Used when clip prompts are written (Write Prompt Package), not by the story planner. */
  motifWeight: number;
  danceStyle: string;
  targetShotSeconds: number;
  minShotSeconds: number;
  maxShotSeconds: number;
  cutRateVsEnergy: number;
  brollAmount: number;
  performanceVsDance: number;
  freeformAmount: number;
  locationVariety: number;
  chorusConsistency: boolean;
  outfitChangeRate: number;
  continueBias: number;
  hardCutsChangeLocation: boolean;
  lipSync: boolean;
  /** Render dimensions are calculated locally from these project-level values. */
  aspectRatio: string;
  renderMegapixels: number;
};

export type DirectionRecord = CreativeDirection & {
  /** Seed for Plan Story. Fixed per project so unchanged inputs hit the director cache; a reroll replaces it. */
  planSeed: number;
  updatedAt: string | null;
};

export type PlanFreshness = {
  /** none: no plan yet; fresh: the plan matches the current inputs; stale: an input changed since it was made. */
  state: "none" | "fresh" | "stale";
  reasons: string[];
};

/** Evidence from the Plan Story report's "Director cache" lines. */
export type PlanCacheResult = "reused" | "partly_reused" | "new" | "rerolled" | "no_llm" | "unknown";

export const STORY_PHASES = ["Arrival", "Friction", "Escalation", "Break", "Release"] as const;
export type StoryPhase = typeof STORY_PHASES[number];

/** image_backed: a supplied location photo; requested: the director asked for a performer-location image;
 *  text_only_broll: a text-only B-roll place; text_only: a text-only performer place (image requests switched off);
 *  rules: the planner named no place, so the deterministic rules choose one later. */
export type LocationMode = "image_backed" | "requested" | "text_only_broll" | "text_only" | "rules";

export type PlanSection = {
  number: number;
  start: number;
  end: number;
  /** Song-structure guess from the analyzer (verse, chorus…) and its repeat label (A, B…). */
  role: string;
  label: string;
  /** Scene type from the planner: Dance, Performance, Freeform, B-roll, or "" when the rules decide. */
  scene: string;
  location: string;
  locationMode: LocationMode;
  beat: string;
  contrast: string;
  /** The planner's own phase word, e.g. "establishment". */
  phase: string;
  starts: string;
  turn: string;
  ends: string;
  /** Story Wheel stage. `declared` when the planner's phase word names it; `position` when placed by song position. */
  wheelPhase: StoryPhase | null;
  wheelPlacement: "declared" | "position" | null;
};

export type RequestedLocation = { name: string; fileName: string; expectedPath: string; sections: number[] };

export type PlanData = {
  project: string;
  durationSeconds: number;
  bpm: number | null;
  sections: PlanSection[];
  /** True when the plan was made with Story Wheel on and the planner returned phases. */
  storyWheel: boolean;
  /** Planner-extracted contract; only the fields the planner actually returned. */
  creativeDirection: { look: string; motif: string; event: string } | null;
  seed: number;
  minLocations: number;
  requestLocationImages: boolean;
  /** Distinct places used by non-B-roll sections. */
  performerLocations: string[];
  requestedLocations: RequestedLocation[];
  /** Location names from the project's supplied (image-backed) location photos. */
  suppliedLocations: string[];
  /** Planner warnings from the report (quota not met, missing beats…). */
  warnings: string[];
  /** True when the planner wrote no story beats (no brief, Story Wheel off, no quota): the rules decide everything. */
  rulesOnly: boolean;
};

export type PlanRunStatus = "queued" | "running" | "complete" | "failed" | "interrupted";

export type PlanRun = {
  id: string;
  kind: "create" | "reroll";
  status: PlanRunStatus;
  /** Live phase while active; null otherwise. */
  activity: { phase: "waiting" | "saving_project" | "queued" | "running" | "cleanup"; since: string; queuePosition?: number } | null;
  cacheResult: PlanCacheResult | null;
  /** Report lines behind cacheResult, e.g. "Story Wheel: HIT". */
  cacheDetails: string[];
  /** Whether the story differs from the plan it replaced (null when there was no earlier plan). */
  storyChanged: boolean | null;
  seedRequested: number | null;
  seedUsed: number | null;
  directorLlm: string | null;
  report: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type PlanOverview = {
  projectId: string;
  projectName: string;
  direction: DirectionRecord;
  freshness: PlanFreshness;
  /** The current saved plan and the run that produced it. */
  plan: PlanData | null;
  planRun: PlanRun | null;
  /** The most recent attempt, which may be newer than `planRun` (e.g. a failed or running attempt). */
  latestRun: PlanRun | null;
  /** Plain-language reasons Create director plan cannot start. */
  blockers: string[];
};

// ----- Ticket 04: location requests and resolution -----------------------------------------------------------

/** Persisted state of one location for the active plan.
 *  image_backed: a readable image will be passed to MiniMax; missing: "text-only — no image found";
 *  failed: "image failed to load" (unreadable, or more than one matching file); not_checked: Check for images has not run
 *  for this plan yet; text_only: a described place with no image (B-roll, or performer places when requests were off). */
export type LocationStateMode = "image_backed" | "missing" | "failed" | "not_checked" | "text_only";

export type LocationSource = "supplied" | "requested" | "text_only";

/** A file in the project's locations folder that the resolver would consider for a request. */
export type LocationFileCandidate = {
  fileName: string;
  sizeBytes: number;
  modifiedAt: string;
  /** False for a matching name with an extension the resolver ignores (e.g. .gif, .heic). */
  supported: boolean;
  /** Local content check, e.g. "not an image file". Null when the bytes look like a supported image. */
  issue: string | null;
};

export type SuppliedLocationStatus = {
  assetId: string;
  name: string;
  /** Sections whose performer scenes the plan placed here (it may be empty: the production rules can still pick it). */
  sections: number[];
  previewUrl: string;
  available: boolean;
  mode: "image_backed" | "failed";
  reason: string;
};

export type RequestedLocationStatus = {
  name: string;
  slug: string;
  /** Exact file name to create, e.g. glass-storefront-corridor.png. */
  fileName: string;
  expectedPath: string;
  /** Non-B-roll sections that use this place (why it is requested). */
  sections: number[];
  /** B-roll sections that also use it (they do not need the image). */
  brollSections: number[];
  /** The plan's own wording for the first performer section here. */
  storyNote: string;
  mode: LocationStateMode;
  /** Short status in the app's terminology, e.g. "text-only — no image found". */
  modeLabel: string;
  /** Short, actionable next step or explanation. */
  reason: string;
  /** True only when the last Check for images confirmed a readable image and the file has not changed since. */
  passedToMiniMax: boolean;
  /** Files in the folder whose name matches this request (any extension). */
  candidates: LocationFileCandidate[];
  /** The folder contents for this request differ from what the last check saw. */
  changedSinceCheck: boolean;
  checkedAt: string | null;
  updatedAt: string | null;
  /** Thumbnail of the single matching image, when there is one. */
  previewUrl: string | null;
};

export type TextOnlyLocationStatus = {
  name: string;
  sections: number[];
  /** broll: allowed text-only place; performer: performer scenes without an image (image requests were off). */
  kind: "broll" | "performer";
  reason: string;
};

export type LocationCheckRun = {
  id: string;
  status: PlanRunStatus;
  activity: { phase: "waiting" | "saving_project" | "queued" | "running" | "cleanup"; since: string; queuePosition?: number } | null;
  /** The resolver's short per-location lines, e.g. "motel corridor: text-only — no image found". */
  summary: string[];
  /** Raw Resolve Locations report text. */
  report: string | null;
  readyToProduce: boolean | null;
  /** story_plan.json was byte-identical before and after the check. */
  storyUnchanged: boolean | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type LocationsOverview = {
  projectId: string;
  projectName: string;
  /** <project>\locations — the only folder Martini Shot places requested images in. */
  folder: string;
  folderError: string | null;
  /** The plan the locations belong to. Null when no director plan exists yet. */
  plan: { runId: string; durationSeconds: number; bpm: number | null; sectionCount: number; stale: boolean } | null;
  supplied: SuppliedLocationStatus[];
  requested: RequestedLocationStatus[];
  textOnly: TextOnlyLocationStatus[];
  /** Image-type files in the folder that match no requested name (usually a wrong file name). */
  unrecognizedFiles: string[];
  counts: { imageBacked: number; performerTotal: number; stillNeeded: number; failures: number };
  /** Every requested performer location is image-backed (confirmed by the resolver, unchanged since). */
  ready: boolean;
  latestCheck: LocationCheckRun | null;
  /** Reasons Check for images cannot start right now. */
  blockers: string[];
};

export type LocationPlaceResult = { overview: LocationsOverview; placed: string | null; cancelled: boolean; replacedFiles: string[] };

// ----- Ticket 05: production plan, prompt package, and one-clip render queue -------------------------------

/** A clip's scene type as the production plan chose it. */
export type ClipMode = "Performance" | "Freeform" | "B-roll" | "Dance" | "";

export type ClipStatus = "pending" | "queued" | "rendering" | "rendered" | "failed" | "interrupted";

/** One evidence row in the Director decisions panel. `tone` reflects real data only: info = neutral fact, none = not available. */
export type DecisionRow = { label: string; value: string; tone: "ok" | "warn" | "fail" | "info" | "pending" | "none"; at: string | null };

export type CleanupState = "not_requested" | "pending" | "accepted" | "completed" | "failed" | "skipped";

export type RenderAttempt = {
  id: string;
  attempt: number;
  /** "Next missing" for queued runs, "Fixed index" for Retry clip. */
  loaderMode: string;
  status: "queued" | "running" | "cleanup" | "complete" | "failed" | "interrupted";
  phase: "waiting" | "queued" | "running" | "cleanup" | null;
  promptId: string | null;
  noiseSeed: number;
  cleanup: CleanupState;
  cleanupDetail: string | null;
  outputPath: string | null;
  loaderReport: string | null;
  error: string | null;
  startedAt: string;
  submittedAt: string | null;
  renderedAt: string | null;
  finishedAt: string | null;
};

/** A short-lived, local ComfyUI WebSocket session for one in-progress clip. */
export type LivePreviewSession = { projectId: string; clipIndex: number; endpoint: string; clientId: string } | null;

export type ProduceClip = {
  index: number;
  /** Song section from the production plan (null when the report could not be matched). */
  section: number | null;
  /** Director shot number in the prompt package. */
  shot: number | null;
  start: number;
  end: number;
  mode: ClipMode;
  location: string;
  outfit: string;
  action: string;
  transition: string;
  /** Plain-language continuity decision, e.g. "Continues from clip 13 (last 22 frames)". */
  continuity: string;
  status: ClipStatus;
  attempts: number;
  outputPath: string | null;
  promptPath: string;
  error: string | null;
  /** False when the production report could not be matched to this clip; section/location/outfit/action are then unknown. */
  metadataMatched: boolean;
  lastAttempt: RenderAttempt | null;
};

export type PackageRunStatus = "queued" | "running" | "complete" | "failed" | "interrupted";

export type PackageRun = {
  id: string;
  status: PackageRunStatus;
  activity: { phase: "waiting" | "saving_project" | "queued" | "running" | "cleanup"; since: string; queuePosition?: number } | null;
  planRunId: string | null;
  motifWeight: number | null;
  directorLlm: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

/** The written prompt package that clips render from. */
export type PromptPackage = {
  runId: string;
  folder: string;
  packageFile: string;
  clipCount: number;
  shotCount: number;
  /** What the run did, in order: plan reused, locations confirmed, production plan built, prompts written. */
  steps: DecisionRow[];
  warnings: string[];
  polish: string[];
  reports: { resolve: string; production: string; package: string };
  writtenAt: string;
};

export type RenderQueueState = {
  id: string;
  kind: "count" | "remaining" | "retry" | "specific";
  requested: number;
  target: number;
  completed: number;
  retryClip: number | null;
  status: "running" | "stopping" | "stopped" | "complete" | "failed" | "interrupted";
  stopRequestedAt: string | null;
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type TimelineSection = { number: number; start: number; end: number; label: string; phase: StoryPhase | null };

export type ProduceEvent = { id: string; category: string; body: string; at: string };

export type ProduceOverview = {
  projectId: string;
  projectName: string;
  durationSeconds: number | null;
  songUrl: string | null;
  gpu: string | null;
  /** Reasons Write prompt package cannot start now (missing plan, stale plan, missing images…). */
  packageBlockers: string[];
  /** Why the current package no longer matches the director plan (blocks further rendering until a new package is written). */
  packageStale: string[];
  /** Differences that do not block rendering but that a new package would pick up (e.g. the surreal motif weight changed). */
  packageNotes: string[];
  canWritePackage: boolean;
  latestPackageRun: PackageRun | null;
  package: PromptPackage | null;
  clips: ProduceClip[];
  counts: { total: number; rendered: number; failed: number; remaining: number };
  queue: RenderQueueState | null;
  /** Clip indexes the active queue will still render, in order (current first). */
  upcoming: number[];
  currentClip: number | null;
  /** True while this app is rendering or writing a package for any project. */
  busy: { kind: "package" | "render" | "stitch"; projectId: string } | null;
  timing: { elapsedSince: string | null; averageSeconds: number | null; samples: number; estimateSeconds: number | null };
  sections: TimelineSection[];
  /** Plan-level evidence shared by every clip (plan cache, location check). */
  planEvidence: DecisionRow[];
  events: ProduceEvent[];
  renderBlockers: string[];
};

export type ClipDetail = {
  index: number;
  decisions: DecisionRow[];
  prompt: string | null;
  /** The editable creative action the local director wrote, before deterministic MiniMax formatting. */
  creativeText: string | null;
  creativeRevision: number | null;
  attempts: RenderAttempt[];
  warnings: string[];
  /** The clip's editable shot settings; null for packages written before Prompt Workshop sources. */
  shot: ClipShotSettings | null;
  /** Clips that continue this one without a hard cut (reference swaps are carried into them). */
  followers: number[];
  /** The clip this one continues from without a hard cut, or null after a hard cut. */
  continuesFrom: number | null;
  /** Clips whose videos must render again when this clip changes (it plus the clips that reuse its frames). */
  rerenderWith: number[];
};

export type ClipRefRole = "person" | "outfit" | "location";
export const CLIP_CAMERAS = ["Static full-body", "Static medium", "Slow push-in", "Slow arc", "Handheld follow", "LLM picks (experimental)", "Custom"] as const;
export type ClipCamera = typeof CLIP_CAMERAS[number];

/** A reference image already in the prompt package that a clip may switch to. */
export type ClipRefOption = { role: ClipRefRole; file: string; name: string; locationText?: string };

export type ClipShotSettings = {
  scene: ClipMode;
  /** "Continue" when the clip keeps the previous clip's camera. */
  camera: ClipCamera | "Continue";
  cameraText: string;
  soundscape: string;
  /** Dance clips use the package's fixed dance soundscape unless it is overridden. */
  soundscapeEditable: boolean;
  lipSync: boolean;
  /** False when no sung lyrics fall inside the clip (or the package predates lip-sync editing). */
  lipSyncAvailable: boolean;
  ending: string;
  endingOverridden: boolean;
  locationText: string;
  /** The clip's current reference file per swappable role. */
  refs: Partial<Record<ClipRefRole, string>>;
  options: ClipRefOption[];
};

/** Changes sent with a clip revision. Fields left out stay as they are. */
export type ClipChanges = {
  scene?: ClipMode;
  camera?: { name: ClipCamera; text?: string };
  soundscape?: string;
  lipSync?: boolean;
  ending?: string;
  locationText?: string;
  refs?: Partial<Record<ClipRefRole, string>>;
};

export type ClipRevisionMode = "Try another take" | "Apply manual direction" | "Apply shot settings";

export type ClipRevisionRequest = {
  mode: ClipRevisionMode;
  /** Apply manual direction: the replacement action. Try another take: an optional note on what to change. */
  creativeText: string;
  changes?: ClipChanges;
  /** Must be true when a reference swap is carried into following clips; the renderer asks the user first. */
  confirmDownstream?: boolean;
};

// ----- Ticket 06: final stitch, results, and the autonomous-director report --------------------------------

/** ready: every clip is rendered and nothing blocks a stitch; stitching: Finalize Video is in progress; complete: the current
 *  package has a final video made from its current clips; blocked: something specific prevents a stitch; failed: the last
 *  stitch of this package failed and can be retried. */
export type FinalState = "ready" | "stitching" | "complete" | "blocked" | "failed";

export type StitchStatus = "queued" | "running" | "complete" | "failed" | "interrupted";

export type ClipSummary = {
  total: number;
  rendered: number;
  failed: number[];
  missing: number[];
  /** Clips with more than one render attempt. */
  retried: number[];
  attempts: number;
};

export type FinalVideo = {
  id: string;
  status: StitchStatus;
  activity: { phase: "waiting" | "queued" | "running" | "cleanup"; since: string; queuePosition?: number } | null;
  packageRunId: string;
  planRunId: string | null;
  /** Made from the project's current prompt package. */
  packageCurrent: boolean;
  /** A clip of this package was re-rendered after this video was stitched. */
  clipsChangedSince: boolean;
  videoPath: string | null;
  fileName: string | null;
  outputFolder: string | null;
  fileExists: boolean;
  fileSizeBytes: number | null;
  /** Read from the MP4's own header; null when it could not be read. */
  durationSeconds: number | null;
  /** From Finalize Video's report, e.g. "1024x768 h264 at 24.00 fps, original song audio". */
  videoInfo: string | null;
  /** martini-asset://final/<id> — streams only this recorded file. */
  videoUrl: string | null;
  stitchReport: string | null;
  promptId: string | null;
  cleanup: CleanupState;
  cleanupDetail: string | null;
  clipSummary: ClipSummary | null;
  reportPath: string | null;
  error: string | null;
  startedAt: string;
  submittedAt: string | null;
  completedAt: string | null;
};

export type ReportItem = { label: string; value: string; tone: DecisionRow["tone"] };
export type ReportSection = { id: string; title: string; summary: string; items: ReportItem[] };
export type DirectorReport = {
  generatedAt: string;
  /** "snapshot": saved when this video was stitched; "live": built now from the current stored artifacts. */
  kind: "snapshot" | "live";
  sections: ReportSection[];
  /** Raw ComfyUI/node text, for the collapsible technical log. */
  technical: Array<{ label: string; body: string }>;
  markdown: string;
};

export type ResultsOutcome = {
  clipsRendered: number;
  clipsTotal: number;
  performerLocations: number;
  outfits: number;
  requiredEvent: { event: string; sections: string } | null;
};

export type ResultsOverview = {
  projectId: string;
  projectName: string;
  state: FinalState;
  /** Exact reasons a stitch cannot be submitted (clip by clip where relevant). */
  blockers: string[];
  /** Non-blocking facts, e.g. "This package was written from an earlier director plan." */
  notes: string[];
  canStitch: boolean;
  /** Why Stitch is disabled even though nothing in the project blocks it (e.g. ComfyUI unreachable). */
  stitchUnavailable: string | null;
  comfy: { connected: boolean; endpoint: string; message: string };
  package: { runId: string; folder: string; clipCount: number; writtenAt: string; stale: boolean } | null;
  counts: { total: number; rendered: number; failed: number; missing: number };
  /** The video shown in the player: the newest finished video of this project whose file still exists. */
  final: FinalVideo | null;
  /** The newest stitch attempt for the current package (may be active, failed, or the same as `final`). */
  latestAttempt: FinalVideo | null;
  /** Every recorded stitch for this project, newest first. */
  history: FinalVideo[];
  outcome: ResultsOutcome | null;
  report: DirectorReport;
  /** Up to five rendered clips of the shown video's package, with their start time in the song. */
  filmstrip: Array<{ index: number; start: number; url: string }>;
  /** Things the user should know about: unresolved locations, failed clips, cleanup that could not be confirmed. */
  attention: string[];
  rerender: { available: boolean; reason: string | null; clipCount: number };
  reroll: { available: boolean; reason: string | null };
};

export type RerenderRequest = { scope: "all" } | { scope: "clips"; clips: string };
export type RerenderResult = { produce: ProduceOverview; clips: number[]; addedForContinuity: number[]; archivedTo: string; queueError: string | null };
