import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AssetChangeResult, AssetRole, ClipDetail, ClipRevisionRequest, CreativeDirection, SectionActionImpact, LocationPlaceResult, LocationsOverview, PlanOverview, ProduceOverview, ProjectDetail,
  ProjectsOverview, RerenderRequest, RerenderResult, ResultsOverview, LivePreviewSession, LivePreviewFrame,
} from "./contracts";
import type { MachineSettings } from "./db";

contextBridge.exposeInMainWorld("martini", {
  databaseStatus: () => ipcRenderer.invoke("martini:database-status"),
  serviceStatus: () => ipcRenderer.invoke("martini:service-status"),
  getSettings: () => ipcRenderer.invoke("martini:settings-get"),
  saveSettings: (value: MachineSettings) => ipcRenderer.invoke("martini:settings-save", value),
  workflowTemplates: () => ipcRenderer.invoke("martini:workflow-templates"),
  recentJobs: (limit?: number) => ipcRenderer.invoke("martini:recent-jobs", limit),
  runWorkflow: (name: string, values: Record<string, unknown>, projectId?: string) =>
    ipcRenderer.invoke("martini:workflow-run", name, values, projectId),
  appInfo: () => ipcRenderer.invoke("martini:app-info"),

  projects: {
    overview: (): Promise<ProjectsOverview> => ipcRenderer.invoke("martini:projects-overview"),
    get: (projectId: string): Promise<ProjectDetail> => ipcRenderer.invoke("martini:project-get", projectId),
    create: (name: string): Promise<ProjectDetail> => ipcRenderer.invoke("martini:project-create", name),
    open: (projectId: string): Promise<ProjectDetail> => ipcRenderer.invoke("martini:project-open", projectId),
    openFolder: (projectId: string): Promise<void> => ipcRenderer.invoke("martini:project-open-folder", projectId),
    retryComfySave: (projectId: string): Promise<ProjectDetail> => ipcRenderer.invoke("martini:project-retry-comfy", projectId),
    onChanged: (listener: (projectId: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string) => listener(projectId);
      ipcRenderer.on("martini:project-changed", handler);
      return () => ipcRenderer.removeListener("martini:project-changed", handler);
    },
  },
  assets: {
    add: (projectId: string, role: AssetRole): Promise<AssetChangeResult> => ipcRenderer.invoke("martini:assets-add", projectId, role),
    replace: (projectId: string, assetId: string): Promise<AssetChangeResult> => ipcRenderer.invoke("martini:assets-replace", projectId, assetId),
    remove: (projectId: string, assetId: string): Promise<ProjectDetail> => ipcRenderer.invoke("martini:assets-remove", projectId, assetId),
    recordSongDuration: (projectId: string, assetId: string, seconds: number): Promise<void> =>
      ipcRenderer.invoke("martini:assets-song-duration", projectId, assetId, seconds),
  },
  plan: {
    /** Direction, saved plan, freshness, latest run, and blockers for one project. */
    overview: (projectId: string): Promise<PlanOverview> => ipcRenderer.invoke("martini:plan-overview", projectId),
    saveDirection: (projectId: string, direction: CreativeDirection): Promise<PlanOverview> => ipcRenderer.invoke("martini:direction-save", projectId, direction),
    /** Starts Create director plan in the background; follow it with onChanged. */
    create: (projectId: string): Promise<PlanOverview> => ipcRenderer.invoke("martini:plan-create", projectId),
    /** Starts a deliberate reroll (reset_plan_cache). `confirmed` must be true. */
    reroll: (projectId: string, confirmed: true): Promise<PlanOverview> => ipcRenderer.invoke("martini:plan-reroll", projectId, confirmed),
    /** Which clips changing a section's action would rewrite and re-render. */
    sectionImpact: (projectId: string, section: number): Promise<SectionActionImpact> => ipcRenderer.invoke("martini:section-action-impact", projectId, section),
    /** Sets a section's action in the plan and, when a prompt package exists, retakes and re-renders its clips. */
    editSectionAction: (projectId: string, section: number, action: string, confirmed: boolean): Promise<ProduceOverview> =>
      ipcRenderer.invoke("martini:section-action-edit", projectId, section, action, confirmed),
    onChanged: (listener: (projectId: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string) => listener(projectId);
      ipcRenderer.on("martini:plan-changed", handler);
      return () => ipcRenderer.removeListener("martini:plan-changed", handler);
    },
  },
  locations: {
    /** Supplied, requested, and text-only locations for the current plan, with live folder state and the last check. */
    overview: (projectId: string): Promise<LocationsOverview> => ipcRenderer.invoke("martini:locations-overview", projectId),
    /** Starts Check for images (Resolve Locations only; never the planner) in the background; follow it with onChanged. */
    check: (projectId: string): Promise<LocationsOverview> => ipcRenderer.invoke("martini:locations-check", projectId),
    /** Opens <project>\locations in Explorer, creating it if needed. */
    openFolder: (projectId: string): Promise<void> => ipcRenderer.invoke("martini:locations-open-folder", projectId),
    /** Copies a requested location's exact file name to the clipboard and returns it. */
    copyFileName: (projectId: string, slug: string): Promise<string> => ipcRenderer.invoke("martini:locations-copy-filename", projectId, slug),
    /** Lets the user pick an image that is copied to the request's exact file name. `replace` moves an existing image aside. */
    chooseImage: (projectId: string, slug: string, replace: boolean): Promise<LocationPlaceResult> =>
      ipcRenderer.invoke("martini:locations-choose-image", projectId, slug, replace),
    /** Same as chooseImage for a file dropped from Explorer. Only a real dropped File has a path; anything else is refused. */
    dropImage: (projectId: string, slug: string, file: File, replace: boolean): Promise<LocationPlaceResult> => {
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) return Promise.reject(new Error("Drop an image file from Windows Explorer."));
      return ipcRenderer.invoke("martini:locations-drop-image", projectId, slug, filePath, replace);
    },
    onChanged: (listener: (projectId: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string) => listener(projectId);
      ipcRenderer.on("martini:locations-changed", handler);
      return () => ipcRenderer.removeListener("martini:locations-changed", handler);
    },
  },
  produce: {
    /** Prompt package, clips, queue, timing, and evidence for one project. */
    overview: (projectId: string): Promise<ProduceOverview> => ipcRenderer.invoke("martini:produce-overview", projectId),
    /** Starts Write prompt package (04-write-prompt-package.json) in the background; follow it with onChanged. */
    writePackage: (projectId: string): Promise<ProduceOverview> => ipcRenderer.invoke("martini:produce-write-package", projectId),
    /** Queues `count` next-missing clips (a count at or above the remaining clips renders all of them), one ComfyUI render at a time. */
    queue: (projectId: string, count: number): Promise<ProduceOverview> => ipcRenderer.invoke("martini:produce-queue", projectId, count),
    /** Explicit Resume / Queue remaining: every clip without a video. */
    queueRemaining: (projectId: string): Promise<ProduceOverview> => ipcRenderer.invoke("martini:produce-queue-remaining", projectId),
    /** Renders one selected missing clip in Fixed index mode. A missing predecessor blocks a Continue clip. */
    renderClip: (projectId: string, clipIndex: number): Promise<ProduceOverview> => ipcRenderer.invoke("martini:produce-render-clip", projectId, clipIndex),
    /** Lets the clip already in ComfyUI finish and starts nothing after it. */
    stopAfterCurrent: (projectId: string): Promise<ProduceOverview> => ipcRenderer.invoke("martini:produce-stop-after-current", projectId),
    /** Re-renders one failed clip only (Load Render Clip in Fixed index mode). */
    retryClip: (projectId: string, clipIndex: number): Promise<ProduceOverview> => ipcRenderer.invoke("martini:produce-retry-clip", projectId, clipIndex),
    /** Director decisions, attempts, and the clip's prompt text (diagnostics only). */
    clipDetail: (projectId: string, clipIndex: number): Promise<ClipDetail> => ipcRenderer.invoke("martini:produce-clip-detail", projectId, clipIndex),
    /** Retries, hand-edits, or changes the shot settings of one clip without re-planning the video. */
    reviseClipPrompt: (projectId: string, clipIndex: number, request: ClipRevisionRequest): Promise<ProduceOverview> =>
      ipcRenderer.invoke("martini:produce-revise-clip-prompt", projectId, clipIndex, request),
    /** Moves a rendered clip's video (and those that reuse its frames) to superseded and renders it again with a new seed. */
    rerenderClip: (projectId: string, clipIndex: number, confirmed: true): Promise<ProduceOverview> =>
      ipcRenderer.invoke("martini:produce-rerender-clip", projectId, clipIndex, confirmed),
    openFolder: (projectId: string): Promise<void> => ipcRenderer.invoke("martini:produce-open-folder", projectId),
    copyOutputPath: (projectId: string, clipIndex: number): Promise<string> => ipcRenderer.invoke("martini:produce-copy-output", projectId, clipIndex),
    previewSession: (): Promise<LivePreviewSession> => ipcRenderer.invoke("martini:produce-preview-session"),
    /** Live sampler previews for the clip rendering now, relayed by main from ComfyUI's WebSocket. */
    onPreviewFrame: (listener: (frame: LivePreviewFrame) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, frame: LivePreviewFrame) => listener(frame);
      ipcRenderer.on("martini:preview-frame", handler);
      return () => ipcRenderer.removeListener("martini:preview-frame", handler);
    },
    onPreviewSession: (listener: (session: LivePreviewSession) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, session: LivePreviewSession) => listener(session);
      ipcRenderer.on("martini:preview-session", handler);
      return () => ipcRenderer.removeListener("martini:preview-session", handler);
    },
    onChanged: (listener: (projectId: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string) => listener(projectId);
      ipcRenderer.on("martini:produce-changed", handler);
      return () => ipcRenderer.removeListener("martini:produce-changed", handler);
    },
  },
  results: {
    /** Final-video state, blockers, recorded videos, outcome, and the director report for one project. */
    overview: (projectId: string): Promise<ResultsOverview> => ipcRenderer.invoke("martini:results-overview", projectId),
    /** Starts Stitch final video (06-stitch-video.json) in the background; refused unless every clip is rendered. */
    stitch: (projectId: string): Promise<ResultsOverview> => ipcRenderer.invoke("martini:results-stitch", projectId),
    openVideo: (projectId: string, finalId: string): Promise<void> => ipcRenderer.invoke("martini:results-open-video", projectId, finalId),
    revealVideo: (projectId: string, finalId: string): Promise<void> => ipcRenderer.invoke("martini:results-reveal-video", projectId, finalId),
    openFolder: (projectId: string, finalId: string): Promise<void> => ipcRenderer.invoke("martini:results-open-folder", projectId, finalId),
    copyPath: (projectId: string, finalId: string): Promise<string> => ipcRenderer.invoke("martini:results-copy-path", projectId, finalId),
    /** `finalId` null = the live report of the current package. */
    copyReport: (projectId: string, finalId: string | null): Promise<void> => ipcRenderer.invoke("martini:results-copy-report", projectId, finalId),
    exportReport: (projectId: string, finalId: string | null): Promise<string> => ipcRenderer.invoke("martini:results-export-report", projectId, finalId),
    /** Re-render unchanged plan: keeps the story, plan, locations, and prompts; requeues all or chosen clips on Produce. */
    rerender: (projectId: string, request: RerenderRequest): Promise<RerenderResult> => ipcRenderer.invoke("martini:results-rerender", projectId, request),
    onChanged: (listener: (projectId: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, projectId: string) => listener(projectId);
      ipcRenderer.on("martini:results-changed", handler);
      return () => ipcRenderer.removeListener("martini:results-changed", handler);
    },
  },
  directorLlmOptions: (): Promise<{ options: string[]; selected: string | null; error: string | null }> => ipcRenderer.invoke("martini:director-llm-options"),
  openComfyUi: (): Promise<void> => ipcRenderer.invoke("martini:open-comfyui"),
});
