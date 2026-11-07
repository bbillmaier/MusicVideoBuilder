/// <reference types="vite/client" />
import type {
  AssetChangeResult as SharedAssetChangeResult, AssetRole as SharedAssetRole, ProjectAsset as SharedProjectAsset,
  ProjectDetail as SharedProjectDetail, ProjectsOverview as SharedProjectsOverview, ProjectState as SharedProjectState,
  ProjectSummary as SharedProjectSummary, CreativeDirection as SharedCreativeDirection, DirectionRecord as SharedDirectionRecord,
  PlanOverview as SharedPlanOverview, PlanData as SharedPlanData, PlanRun as SharedPlanRun, PlanSection as SharedPlanSection,
  StoryPhase as SharedStoryPhase, LocationMode as SharedLocationMode, PlanCacheResult as SharedPlanCacheResult,
  LocationsOverview as SharedLocationsOverview, LocationPlaceResult as SharedLocationPlaceResult, RequestedLocationStatus as SharedRequestedLocationStatus,
  SuppliedLocationStatus as SharedSuppliedLocationStatus, TextOnlyLocationStatus as SharedTextOnlyLocationStatus, LocationCheckRun as SharedLocationCheckRun,
  ProduceOverview as SharedProduceOverview, ProduceClip as SharedProduceClip, ClipDetail as SharedClipDetail, DecisionRow as SharedDecisionRow,
  RenderAttempt as SharedRenderAttempt, RenderQueueState as SharedRenderQueueState, PromptPackage as SharedPromptPackage, PackageRun as SharedPackageRun, LivePreviewSession as SharedLivePreviewSession,
  TimelineSection as SharedTimelineSection, ProduceEvent as SharedProduceEvent,
  ResultsOverview as SharedResultsOverview, FinalVideo as SharedFinalVideo, DirectorReport as SharedDirectorReport, ReportSection as SharedReportSection,
  RerenderRequest as SharedRerenderRequest, RerenderResult as SharedRerenderResult, FinalState as SharedFinalState,
  ClipRevisionRequest as SharedClipRevisionRequest, LivePreviewFrame as SharedLivePreviewFrame, SectionActionImpact as SharedSectionActionImpact,
  SongTimeline as SharedSongTimeline, SongTimelineSection as SharedSongTimelineSection, SongTimelineShot as SharedSongTimelineShot, TimelineScene as SharedTimelineScene,
  PostProcessOverview as SharedPostProcessOverview, PostClip as SharedPostClip, PostSettings as SharedPostSettings, PostAttempt as SharedPostAttempt,
  PostWorkerInfo as SharedPostWorkerInfo, PostSettingsRequest as SharedPostSettingsRequest, PostSelectRequest as SharedPostSelectRequest,
  TimelineDraft as SharedTimelineDraft, TimelineSaveImpact as SharedTimelineSaveImpact, TimelineTransition as SharedTimelineTransition,
} from "../electron/contracts";

declare global {
  type DatabaseStatus = {
    configured: boolean;
    connected: boolean;
    message: string;
    storagePath?: string;
  };

  type ComfyStatus = { connected: boolean; endpoint: string; message: string };
  type MachineSettings = {
    comfyUrl: string; videoModel: string; vae: string; directorLlm: string; contextLength: string;
    lora: string; loraStrength: number; steps: number; cfg: number; seedMode: "random" | "fixed";
    resolution: string; fps: number; outputFormat: string; dynamicLength: boolean; higherQuality: boolean;
    keepIntermediateOutputs: boolean; livePreviews: boolean; vramCleanup: boolean; ramCleanup: boolean; comfyOutputDir: string;
    renderSampler: string; renderScheduler: string; renderShiftVideo: number; renderShiftAudio: number;
    executionDestination: "local" | "remote"; remoteComfyUrl: string; remoteFileApiToken: string;
  };

  type AssetRole = SharedAssetRole;
  type ProjectState = SharedProjectState;
  type ProjectAsset = SharedProjectAsset;
  type ProjectSummary = SharedProjectSummary;
  type ProjectDetail = SharedProjectDetail;
  type ProjectsOverview = SharedProjectsOverview;
  type AssetChangeResult = SharedAssetChangeResult;
  type CreativeDirection = SharedCreativeDirection;
  type DirectionRecord = SharedDirectionRecord;
  type PlanOverview = SharedPlanOverview;
  type PlanData = SharedPlanData;
  type PlanRun = SharedPlanRun;
  type PlanSection = SharedPlanSection;
  type StoryPhase = SharedStoryPhase;
  type LocationMode = SharedLocationMode;
  type PlanCacheResult = SharedPlanCacheResult;
  type LocationsOverview = SharedLocationsOverview;
  type LocationPlaceResult = SharedLocationPlaceResult;
  type RequestedLocationStatus = SharedRequestedLocationStatus;
  type SuppliedLocationStatus = SharedSuppliedLocationStatus;
  type TextOnlyLocationStatus = SharedTextOnlyLocationStatus;
  type LocationCheckRun = SharedLocationCheckRun;
  type ProduceOverview = SharedProduceOverview;
  type ProduceClip = SharedProduceClip;
  type ClipDetail = SharedClipDetail;
  type DecisionRow = SharedDecisionRow;
  type RenderAttempt = SharedRenderAttempt;
  type RenderQueueState = SharedRenderQueueState;
  type LivePreviewSession = SharedLivePreviewSession;
  type PromptPackage = SharedPromptPackage;
  type PackageRun = SharedPackageRun;
  type TimelineSection = SharedTimelineSection;
  type SongTimeline = SharedSongTimeline;
  type SongTimelineSection = SharedSongTimelineSection;
  type SongTimelineShot = SharedSongTimelineShot;
  type TimelineScene = SharedTimelineScene;
  type TimelineDraft = SharedTimelineDraft;
  type TimelineSaveImpact = SharedTimelineSaveImpact;
  type TimelineTransition = SharedTimelineTransition;
  type ProduceEvent = SharedProduceEvent;
  type ResultsOverview = SharedResultsOverview;
  type FinalVideo = SharedFinalVideo;
  type DirectorReport = SharedDirectorReport;
  type ReportSection = SharedReportSection;
  type RerenderRequest = SharedRerenderRequest;
  type RerenderResult = SharedRerenderResult;
  type FinalState = SharedFinalState;
  type PostProcessOverview = SharedPostProcessOverview;
  type PostClip = SharedPostClip;
  type PostSettings = SharedPostSettings;
  type PostAttempt = SharedPostAttempt;
  type PostWorkerInfo = SharedPostWorkerInfo;

  interface Window {
    martini: {
      databaseStatus(): Promise<DatabaseStatus>;
      serviceStatus(): Promise<{ database: DatabaseStatus; comfy: ComfyStatus }>;
      getSettings(): Promise<MachineSettings>;
      saveSettings(value: MachineSettings): Promise<MachineSettings>;
      workflowTemplates(): Promise<Array<{ name: string; stage: string; description: string }>>;
      recentJobs(limit?: number): Promise<unknown[]>;
      runWorkflow(name: string, values: Record<string, unknown>, projectId?: string): Promise<unknown>;
      appInfo(): Promise<{ version: string; development: boolean }>;
      projects: {
        overview(): Promise<ProjectsOverview>;
        get(projectId: string): Promise<ProjectDetail>;
        create(name: string): Promise<ProjectDetail>;
        open(projectId: string): Promise<ProjectDetail>;
        openFolder(projectId: string): Promise<void>;
        retryComfySave(projectId: string): Promise<ProjectDetail>;
        delete(projectId: string): Promise<ProjectsOverview>;
        onChanged(listener: (projectId: string) => void): () => void;
      };
      assets: {
        add(projectId: string, role: AssetRole): Promise<AssetChangeResult>;
        replace(projectId: string, assetId: string): Promise<AssetChangeResult>;
        remove(projectId: string, assetId: string): Promise<ProjectDetail>;
        recordSongDuration(projectId: string, assetId: string, seconds: number): Promise<void>;
      };
      plan: {
        overview(projectId: string): Promise<PlanOverview>;
        saveDirection(projectId: string, direction: CreativeDirection): Promise<PlanOverview>;
        create(projectId: string): Promise<PlanOverview>;
        reroll(projectId: string, confirmed: true): Promise<PlanOverview>;
        timeline(projectId: string): Promise<SongTimeline>;
        analyzeSong(projectId: string): Promise<SongTimeline>;
        timelineImpact(projectId: string, draft: TimelineDraft): Promise<TimelineSaveImpact>;
        saveTimeline(projectId: string, draft: TimelineDraft, confirmed: boolean): Promise<SongTimeline>;
        discardUnsavedTimeline(projectId: string): Promise<SongTimeline>;
        sectionImpact(projectId: string, section: number): Promise<SharedSectionActionImpact>;
        editSectionAction(projectId: string, section: number, action: string, confirmed: boolean): Promise<ProduceOverview>;
        onChanged(listener: (projectId: string) => void): () => void;
      };
      locations: {
        overview(projectId: string): Promise<LocationsOverview>;
        check(projectId: string): Promise<LocationsOverview>;
        openFolder(projectId: string): Promise<void>;
        copyFileName(projectId: string, slug: string): Promise<string>;
        chooseImage(projectId: string, slug: string, replace: boolean): Promise<LocationPlaceResult>;
        dropImage(projectId: string, slug: string, file: File, replace: boolean): Promise<LocationPlaceResult>;
        onChanged(listener: (projectId: string) => void): () => void;
      };
      produce: {
        overview(projectId: string): Promise<ProduceOverview>;
        writePackage(projectId: string): Promise<ProduceOverview>;
        queue(projectId: string, count: number): Promise<ProduceOverview>;
        queueRemaining(projectId: string): Promise<ProduceOverview>;
        renderClip(projectId: string, clipIndex: number): Promise<ProduceOverview>;
        stopAfterCurrent(projectId: string): Promise<ProduceOverview>;
        retryClip(projectId: string, clipIndex: number): Promise<ProduceOverview>;
        clipDetail(projectId: string, clipIndex: number): Promise<ClipDetail>;
        reviseClipPrompt(projectId: string, clipIndex: number, request: SharedClipRevisionRequest): Promise<ProduceOverview>;
        rerenderClip(projectId: string, clipIndex: number, confirmed: true): Promise<ProduceOverview>;
        openFolder(projectId: string): Promise<void>;
        copyOutputPath(projectId: string, clipIndex: number): Promise<string>;
        previewSession(): Promise<LivePreviewSession>;
        onPreviewSession(listener: (session: LivePreviewSession) => void): () => void;
        onPreviewFrame(listener: (frame: SharedLivePreviewFrame) => void): () => void;
        onChanged(listener: (projectId: string) => void): () => void;
      };
      results: {
        overview(projectId: string): Promise<ResultsOverview>;
        stitch(projectId: string): Promise<ResultsOverview>;
        stitchTests(projectId: string): Promise<ResultsOverview>;
        openTest(projectId: string, testId: string, n: number): Promise<void>;
        revealTest(projectId: string, testId: string, n: number): Promise<void>;
        openVideo(projectId: string, finalId: string): Promise<void>;
        revealVideo(projectId: string, finalId: string): Promise<void>;
        openFolder(projectId: string, finalId: string): Promise<void>;
        copyPath(projectId: string, finalId: string): Promise<string>;
        copyReport(projectId: string, finalId: string | null): Promise<void>;
        exportReport(projectId: string, finalId: string | null): Promise<string>;
        rerender(projectId: string, request: RerenderRequest): Promise<RerenderResult>;
        onChanged(listener: (projectId: string) => void): () => void;
      };
      post: {
        overview(projectId: string): Promise<PostProcessOverview>;
        saveSettings(projectId: string, request: SharedPostSettingsRequest): Promise<PostProcessOverview>;
        select(projectId: string, request: SharedPostSelectRequest): Promise<PostProcessOverview>;
        process(projectId: string, clips: number[] | "pending"): Promise<PostProcessOverview>;
        cancel(projectId: string): Promise<PostProcessOverview>;
        workerInfo(): Promise<PostWorkerInfo>;
        onChanged(listener: (projectId: string) => void): () => void;
      };
      directorLlmOptions(): Promise<{ options: string[]; selected: string | null; error: string | null }>;
      renderSamplerOptions(): Promise<{ samplers: string[]; schedulers: string[]; error: string | null }>;
      openComfyUi(): Promise<void>;
    };
  }
}

export {};
