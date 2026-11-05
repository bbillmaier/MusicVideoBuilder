import "dotenv/config";
import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { closeDatabase, databaseStatus, getMachineSettings, recentComfyJobs, saveMachineSettings } from "./db";
import { comfyEndpoint, comfyStatus, runWorkflowTemplate, serializeComfyWork } from "./comfy-client";
import { projectStorage } from "./project-storage";
import { listWorkflowTemplates } from "./workflow-template";
import type { AssetRole } from "./contracts";
import { isAssetRole, ROLE_RULES } from "./project-rules";
import {
  addAssets, assetRole, configureProjectService, createProject, getProject, openProject, previewFile, projectFolder, projectsOverview,
  recordSongDuration, removeAsset, replaceAsset, retryComfySync,
} from "./project-service";
import { configurePlanService, directorLlmOptions, planOverview, saveDirection, startPlan } from "./plan-service";
import {
  configureLocationService, locationFolderFor, locationPreviewFile, locationsOverview, placeLocationImage, requestedFileNameFor, startLocationCheck,
} from "./location-service";
import { LOCATION_IMAGE_EXTENSIONS } from "./location-rules";
import {
  clipDetail, clipOutputPath, configureProductionService, currentPreviewSession, packageFolderFor, produceOverview, queueRemaining, queueRender, queueSpecificClip, rerenderClip, rerenderUnchanged, retryClip, reviseClipPrompt,
  startPromptPackage, stopAfterCurrent,
} from "./production-service";
import {
  configureResultsService, exportReport, finalOutputFolder, finalVideoFile, finalVideoPath, reportText, resultsOverview, startStitch,
} from "./results-service";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);

// Read-only access to a project's stored asset copies (thumbnails, song waveform). Only DB-registered files resolve.
protocol.registerSchemesAsPrivileged([{ scheme: "martini-asset", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: "#0d0e13",
    // The renderer draws its own title bar (a drag region, see .titlebar); Windows keeps the native min/max/close buttons via the overlay.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0a0b0f", symbolColor: "#c6c9d4", height: 40 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDevelopment) {
    window.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    window.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
}

function chooseFiles(owner: BrowserWindow | null, role: AssetRole, multiple: boolean, title: string): Promise<string[]> {
  const rule = ROLE_RULES[role];
  const options: Electron.OpenDialogOptions = {
    title,
    properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
    filters: [{ name: `${rule.label}s`, extensions: rule.extensions.map((ext) => ext.slice(1)) }],
  };
  const pending = owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
  return pending.then((result) => (result.canceled ? [] : result.filePaths));
}

function requireRole(value: unknown): AssetRole {
  if (!isAssetRole(value)) throw new Error("Unknown asset type.");
  return value;
}

app.whenReady().then(() => {
  configureProjectService({
    isDevelopment,
    onChange: (projectId) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("martini:project-changed", projectId)),
  });

  configurePlanService({
    isDevelopment,
    onChange: (projectId) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("martini:plan-changed", projectId)),
  });

  configureLocationService({
    isDevelopment,
    onChange: (projectId) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("martini:locations-changed", projectId)),
  });

  configureProductionService({
    isDevelopment,
    onChange: (projectId) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("martini:produce-changed", projectId)),
    onPreviewSession: (session) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("martini:preview-session", session)),
  });

  configureResultsService({
    isDevelopment,
    onChange: (projectId) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send("martini:results-changed", projectId)),
  });

  protocol.handle("martini-asset", async (request) => {
    const url = new URL(request.url);
    let file: string | null = null;
    if (url.hostname === "asset") file = previewFile(decodeURIComponent(url.pathname.slice(1)));
    else if (url.hostname === "location") {
      // martini-asset://location/<projectId>/<slug>: only the single matching image inside that project's locations folder.
      const [projectId, slug] = url.pathname.slice(1).split("/").map(decodeURIComponent);
      if (projectId && slug && /^[a-z0-9][a-z0-9-]*$/.test(slug)) file = await locationPreviewFile(projectId, slug);
    } else if (url.hostname === "clip") {
      // martini-asset://clip/<projectId>/<clipIndex>: only a rendered clip of that project's current prompt package.
      const [projectId, index] = url.pathname.slice(1).split("/").map(decodeURIComponent);
      try { if (projectId && /^\d{1,3}$/.test(index ?? "")) file = clipOutputPath(projectId, Number(index)); } catch { file = null; }
    } else if (url.hostname === "final") {
      // martini-asset://final/<finalId>: only the recorded final video file of that stitch, inside its project folder.
      const finalId = decodeURIComponent(url.pathname.slice(1));
      if (/^[0-9a-f-]{36}$/i.test(finalId)) file = finalVideoFile(finalId);
    }
    if (url.hostname === "file") file = decodeURIComponent(url.pathname.slice(1));
    if (!file) return new Response("Not found", { status: 404 });
    // DB-backed asset/location/clip/final handlers return vetted absolute local
    // paths. Only the legacy `file` route uses a Martini Shot-relative path.
    const storage = await projectStorage();
    const localFile = path.isAbsolute(file) ? file : storage.localPath!(file);
    const response = await net.fetch(pathToFileURL(localFile).toString(), { headers: request.headers });
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(response.body, { status: response.status, headers });
  });

  ipcMain.handle("martini:database-status", () => databaseStatus());
  ipcMain.handle("martini:service-status", async () => ({ database: await databaseStatus(), comfy: await comfyStatus() }));
  ipcMain.handle("martini:settings-get", () => getMachineSettings());
  ipcMain.handle("martini:settings-save", (_event, value) => saveMachineSettings(value));
  ipcMain.handle("martini:workflow-templates", () => listWorkflowTemplates(isDevelopment));
  ipcMain.handle("martini:recent-jobs", (_event, limit?: number) => recentComfyJobs(limit));
  ipcMain.handle("martini:produce-preview-session", () => currentPreviewSession());
  // Only the model-free connectivity test may be submitted directly; project stages go through their own validated services.
  ipcMain.handle("martini:workflow-run", (_event, name: unknown) => {
    if (name !== "00-connectivity-test.json") throw new Error("Only the connectivity test can be run directly.");
    return serializeComfyWork(() => runWorkflowTemplate(isDevelopment, name, {}));
  });
  ipcMain.handle("martini:app-info", () => ({ version: app.getVersion(), development: isDevelopment }));

  ipcMain.handle("martini:projects-overview", () => projectsOverview());
  ipcMain.handle("martini:project-get", (_event, projectId: unknown) => getProject(projectId));
  ipcMain.handle("martini:project-create", (_event, name: unknown) => createProject(name));
  ipcMain.handle("martini:project-open", (_event, projectId: unknown) => openProject(projectId));
  ipcMain.handle("martini:project-open-folder", async (_event, projectId: unknown) => {
    const error = await shell.openPath(projectFolder(projectId));
    if (error) throw new Error(error);
  });
  ipcMain.handle("martini:project-retry-comfy", (_event, projectId: unknown) => retryComfySync(projectId));
  ipcMain.handle("martini:assets-add", async (event, projectId: unknown, role: unknown) => {
    const assetType = requireRole(role);
    getProject(projectId);
    const multiple = ROLE_RULES[assetType].multiple;
    const files = await chooseFiles(BrowserWindow.fromWebContents(event.sender), assetType, multiple, `Add ${ROLE_RULES[assetType].label.toLowerCase()}${multiple ? "s" : ""}`);
    return addAssets(projectId, assetType, files);
  });
  ipcMain.handle("martini:assets-replace", async (event, projectId: unknown, assetId: unknown) => {
    const role = assetRole(projectId, assetId);
    const [file] = await chooseFiles(BrowserWindow.fromWebContents(event.sender), role, false, `Replace ${ROLE_RULES[role].label.toLowerCase()}`);
    return replaceAsset(projectId, assetId, file);
  });
  ipcMain.handle("martini:assets-remove", (_event, projectId: unknown, assetId: unknown) => removeAsset(projectId, assetId));
  ipcMain.handle("martini:assets-song-duration", (_event, projectId: unknown, assetId: unknown, seconds: unknown) => recordSongDuration(projectId, assetId, seconds));
  ipcMain.handle("martini:plan-overview", (_event, projectId: unknown) => planOverview(projectId));
  ipcMain.handle("martini:direction-save", (_event, projectId: unknown, direction: unknown) => saveDirection(projectId, direction));
  ipcMain.handle("martini:plan-create", (_event, projectId: unknown) => startPlan(projectId, false));
  ipcMain.handle("martini:plan-reroll", (_event, projectId: unknown, confirmed: unknown) => {
    // Rerolling changes the story, location requests, and future prompts; the renderer must have asked first.
    if (confirmed !== true) throw new Error("Reroll needs confirmation.");
    return startPlan(projectId, true);
  });
  ipcMain.handle("martini:director-llm-options", () => directorLlmOptions());
  ipcMain.handle("martini:locations-overview", (_event, projectId: unknown) => locationsOverview(projectId));
  ipcMain.handle("martini:locations-check", (_event, projectId: unknown) => startLocationCheck(projectId));
  ipcMain.handle("martini:locations-open-folder", async (_event, projectId: unknown) => {
    const error = await shell.openPath(await locationFolderFor(projectId));
    if (error) throw new Error(error);
  });
  ipcMain.handle("martini:locations-copy-filename", async (_event, projectId: unknown, slug: unknown) => {
    const fileName = await requestedFileNameFor(projectId, slug);
    clipboard.writeText(fileName);
    return fileName;
  });
  ipcMain.handle("martini:locations-choose-image", async (event, projectId: unknown, slug: unknown, replace: unknown) => {
    const fileName = await requestedFileNameFor(projectId, slug);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: `Choose the image for ${fileName}`, properties: ["openFile"],
      filters: [{ name: "Images", extensions: LOCATION_IMAGE_EXTENSIONS.map((ext) => ext.slice(1)) }],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return placeLocationImage(projectId, slug, result.canceled ? undefined : result.filePaths[0], replace === true);
  });
  // The path comes from preload's webUtils.getPathForFile for a real dropped file; main re-validates it before reading.
  ipcMain.handle("martini:locations-drop-image", (_event, projectId: unknown, slug: unknown, filePath: unknown, replace: unknown) => {
    if (typeof filePath !== "string" || !filePath) throw new Error("Drop an image file from Windows Explorer.");
    return placeLocationImage(projectId, slug, filePath, replace === true);
  });
  // Produce (Ticket 05): every handler re-validates the project, counts, and clip numbers in main.
  ipcMain.handle("martini:produce-overview", (_event, projectId: unknown) => produceOverview(projectId));
  ipcMain.handle("martini:produce-write-package", (_event, projectId: unknown) => startPromptPackage(projectId));
  ipcMain.handle("martini:produce-queue", (_event, projectId: unknown, count: unknown) => queueRender(projectId, count));
  ipcMain.handle("martini:produce-queue-remaining", (_event, projectId: unknown) => queueRemaining(projectId));
  ipcMain.handle("martini:produce-render-clip", (_event, projectId: unknown, clipIndex: unknown) => queueSpecificClip(projectId, clipIndex));
  ipcMain.handle("martini:produce-stop-after-current", (_event, projectId: unknown) => stopAfterCurrent(projectId));
  ipcMain.handle("martini:produce-retry-clip", (_event, projectId: unknown, clipIndex: unknown) => retryClip(projectId, clipIndex));
  ipcMain.handle("martini:produce-clip-detail", (_event, projectId: unknown, clipIndex: unknown) => clipDetail(projectId, clipIndex));
  ipcMain.handle("martini:produce-revise-clip-prompt", (_event, projectId: unknown, clipIndex: unknown, request: unknown) =>
    reviseClipPrompt(projectId, clipIndex, request));
  ipcMain.handle("martini:produce-rerender-clip", (_event, projectId: unknown, clipIndex: unknown, confirmed: unknown) => {
    // Re-rendering moves existing videos aside (and those of clips that reuse its frames); the renderer must have asked first.
    if (confirmed !== true) throw new Error("Re-render needs confirmation.");
    return rerenderClip(projectId, clipIndex);
  });
  ipcMain.handle("martini:produce-open-folder", async (_event, projectId: unknown) => {
    const error = await shell.openPath(packageFolderFor(projectId));
    if (error) throw new Error(error);
  });
  ipcMain.handle("martini:produce-copy-output", (_event, projectId: unknown, clipIndex: unknown) => {
    const output = clipOutputPath(projectId, clipIndex);
    clipboard.writeText(output);
    return output;
  });
  // Results (Ticket 06): main re-validates the project, the final-video record, and that every path is inside the project folder.
  ipcMain.handle("martini:results-overview", (_event, projectId: unknown) => resultsOverview(projectId));
  ipcMain.handle("martini:results-stitch", (_event, projectId: unknown) => startStitch(projectId));
  ipcMain.handle("martini:results-open-video", async (_event, projectId: unknown, finalId: unknown) => {
    const error = await shell.openPath(finalVideoPath(projectId, finalId));
    if (error) throw new Error(error);
  });
  ipcMain.handle("martini:results-reveal-video", (_event, projectId: unknown, finalId: unknown) => shell.showItemInFolder(finalVideoPath(projectId, finalId)));
  ipcMain.handle("martini:results-open-folder", async (_event, projectId: unknown, finalId: unknown) => {
    const error = await shell.openPath(finalOutputFolder(projectId, finalId));
    if (error) throw new Error(error);
  });
  ipcMain.handle("martini:results-copy-path", (_event, projectId: unknown, finalId: unknown) => {
    const file = finalVideoPath(projectId, finalId);
    clipboard.writeText(file);
    return file;
  });
  ipcMain.handle("martini:results-copy-report", async (_event, projectId: unknown, finalId: unknown) => {
    clipboard.writeText(await reportText(projectId, finalId));
  });
  ipcMain.handle("martini:results-export-report", async (_event, projectId: unknown, finalId: unknown) => {
    const file = await exportReport(projectId, finalId);
    shell.showItemInFolder(file);
    return file;
  });
  ipcMain.handle("martini:results-rerender", (_event, projectId: unknown, request: unknown) => rerenderUnchanged(projectId, request));
  ipcMain.handle("martini:open-comfyui", async () => {
    const settings = await getMachineSettings();
    await shell.openExternal(comfyEndpoint(settings.comfyUrl, "local"));
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => closeDatabase());
