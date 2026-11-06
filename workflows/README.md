# Martini Shot API workflow templates

These JSON files are submitted by Electron main to local ComfyUI through `POST /prompt`; they are not user-editable workspace files.

Each template has `name`, `stage`, `description`, and an API-format `prompt` graph. `{{replacement}}` values are supplied by Electron. A whole placeholder preserves its original type; embedded placeholders become strings. Missing replacement values fail before ComfyUI receives a request.

Before submitting, Electron checks `/object_info` for every node type in the graph. If a node pack is not loaded (for example MartiniShot installed after ComfyUI started), the job fails with a restart message and nothing is sent to ComfyUI.

`00-connectivity-test.json` is a small built-in test that writes a local text file. It verifies submit, history polling, job persistence, and `/free` cleanup without requiring an AI model.

## 01-create-project.json

Turns the files the app copied into `<ComfyUI output>\martini_shot\<project-slug>\assets\originals\` into a MartiniShot project that **Martini Shot Open Project** can read. Martini Shot Project writes `project.json`, `assets\song.flac`, and `assets\reference_NN.png`. The app never writes those files itself.

Graph: `LoadAudio` → `MartiniShotProject` ← chain of (`LoadImage` → `MiniMaxH3AutoReference`), plus `PreviewAny` on the project report so the run has an output node and the report comes back in `/history`.

Values:

| Placeholder | Supplied by Electron |
|---|---|
| `{{song_file}}` | `martini_shot/<slug>/assets/originals/<song file> [output]` |
| `{{project_name}}` | project slug (same rule as `project_store.project_slug`) |
| `{{refs_node}}` | ID of the last reference node in the chain |

The `repeat.reference` fragment is expanded once per image, in order: performers (`Subject`), then outfits (`Outfit`), then locations (`Location`). Per item it takes `{{index}}` (also used in node IDs), `{{image_file}}`, `{{kind}}`, `{{name}}` (the asset's display name), and `{{previous_refs_node}}`. The first reference has no `previous_refs` input. The ` [output]` suffix is ComfyUI's annotated-path form, so the loaders read from the output folder instead of `input`.

The app runs this workflow automatically after asset changes, once the project has a song and at least one performer image. It records the job in `comfy_jobs` and sends `/free` afterwards, as every workflow does. A save counts as successful only if `project.json` then exists in the project folder.

## 02-plan-story.json

Plans the story for a project that `01-create-project.json` has saved. Used by **Create director plan** and **Reroll plan**.

Graph: `MartiniShotOpenProject` → `MartiniShotPlanStory` ← `MiniMaxH3PromptLLMLoader`, with `PreviewAny` on the plan report (`report`) and on `needs_location_images`. Plan Story writes `story_plan.json` in the project folder.

| Placeholder | Supplied by Electron |
|---|---|
| `{{project_name}}` | project slug |
| `{{director_llm}}` | a Prompt LLM Loader option read from the running ComfyUI's `/object_info`: the Settings choice if installed, else `Qwen3-VL 8B (vision) \| qwen3vl_8b_fp8_scaled.safetensors` (the model the Director workflows use), else the first vision model |
| `{{creative_brief}}`, `{{story_brief}}` | the project's Direction text, whitespace-normalized. Both get the same text: `creative_brief` becomes the Look / Recurring motif / Required one-off event contract, and `story_brief` keeps arc wording the contract drops |
| `{{story_wheel}}`, `{{min_locations}}`, `{{request_location_images}}` | Direction controls |
| `{{seed}}` | the project's plan seed (random per project, fixed until a reroll) |
| `{{reset_plan_cache}}` | `false` for Create director plan, `true` for Reroll plan |

Cache behavior comes from the nodes. Plan Story caches each LLM call on disk (`user/default/MiniMaxPrompBuilder/director_plan_cache`). With unchanged inputs and seed, every call is a `HIT` and the story is identical. `reset_plan_cache` clears that whole cache (for all projects) and picks a new random seed. The app reads the `Director cache:` lines of the report to say whether a plan was reused, partly reused, new, or rerolled. It stores the new seed from `story_plan.json`, so the next unchanged Create director plan reuses the rerolled plan. A plan counts as successful only if the report came back and `story_plan.json` was written by this run.

Plan Story also writes `director_context.json`. This compact, versioned context packet holds the creative contract, one deterministic allocation for a required one-off event, and every section's entering state, required change, exit state, anchor, and anti-reset rule. It is an audit artifact, not an extra LLM call.

The surreal motif weight is not a Plan Story input. It is saved with the Direction and used later by Write Prompt Package (`recurring_style_motif_weight`).

## 02a-analyze-song.json

Analyzes the song of a project that `01-create-project.json` has saved: beats, bars and song sections, with no LLM. Used by **Analyze song** on Plan, so the song timeline can show sections and the cut preview before a director plan exists.

Graph: `MartiniShotOpenProject` → `MartiniShotAnalyzeSong`, with `PreviewAny` on its report (`report`). The node writes `song_analysis.json` (`version`, `song`, `song_sha256`, `analysis`) in the project folder. A saved file whose `song_sha256` still matches `assets/song.flac` is reused instead of analyzed again.

| Placeholder | Supplied by Electron |
|---|---|
| `{{project_name}}` | project slug |

Plan Story reads the same file: when `song_analysis.json` matches the current song, it plans from that analysis (report line `song analysis: reused song_analysis.json` under `Director cache:`), so the plan's sections are the ones the timeline showed. Projects without the file analyze the song inside Plan Story as before.

## 02b-apply-timeline.json and 02c-apply-timeline-timing.json

Apply the user's saved song timeline to the current story plan. Used by **Save timeline** on Plan when a director plan exists. 02b loads the director LLM and is used when sections were split, merged, created or deleted; 02c has no LLM and is used when only timing, roles or shots changed.

Graph: `MartiniShotOpenProject` → `MartiniShotApplyTimeline` (← `MiniMaxH3PromptLLMLoader` in 02b), with `PreviewAny` on its report (`report`). The node rebuilds the plan's song analysis from `timeline.json`, moves each story beat to the section given in `section_sources`, asks the LLM only for the sections listed as `null` (it may not invent new performer locations), and rewrites `story_plan.json` (with `timeline_shots`) and `director_context.json`. If it fails, the app restores the previous `timeline.json`.

| Placeholder | Supplied by Electron |
|---|---|
| `{{project_name}}` | project slug |
| `{{section_sources}}` | JSON list, one entry per timeline section: the plan section number whose story it keeps, or `null` to rewrite |
| `{{seed}}` | the project's plan seed |
| `{{director_llm}}` | 02b only; the same choice as Plan Story |

`timeline.json` (written by the app; `version`, `song_sha256`, `duration`, `bpm`, `beats`, `sections`, `shots`) owns all timing once it exists. Plan Story plans on its sections, Build Production Plan uses its cuts exactly (the shot's scene type and transition override the rules where set), and Write Prompt Package turns off beat snapping so clips cut where the user put them. A file made for a different song is ignored. Projects without the file work as before.

## 03-resolve-locations.json

Re-checks requested performer-location images against the saved story. Used by **Check for images** on the Locations page. It never plans: there is no Plan Story node and no LLM loader in the graph.

Graph: `MartiniShotOpenProject` → `MartiniShotLoadStoryPlan` → `MartiniShotResolveLocations`, with `PreviewAny` on the resolver's `location_requests` report (`report`) and on `ready_to_produce`. Resolve Locations writes `resolved_plan.json`. It does not touch `story_plan.json`.

| Placeholder | Supplied by Electron |
|---|---|
| `{{project_name}}` | project slug |

How the resolver matches files (in `project_store.find_requested_location`): it looks in `<project>\locations\` for a file whose stem has the same slug as the location name and whose extension is `.png`, `.jpg`, `.jpeg`, `.webp`, or `.bmp`. Results:

- No match: `text-only — no image found`.
- More than one match: `image failed to load — more than one matching image`.
- A file PIL cannot read: `image failed to load — <file>`.
- Exactly one readable file: `image-backed — loaded <file>`.

Only an image-backed location gets an image ref. Build Production Plan refuses to run while `missing_locations` is non-empty, so a dead `<Picture>` reference is never written.

Checks made by Electron:

- **Before the run:** `story_plan.json` must match the plan the app shows (story signature and requested names). Otherwise the check is refused.
- **After the run:**
  - `story_plan.json` must be byte-identical (SHA-256 before and after).
  - `resolved_plan.json` must have been written by this run, and its `requested_locations` must equal the plan's.
  - Each location's state comes from the report line and is cross-checked against `missing_locations`.

The app stores the results in `location_requests`, the run in `director_runs` (stage `resolve_locations`), and the raw report plus outputs in `project_reports` (category `location_check`). A failed run (ComfyUI down, node pack missing) changes no location state.

When the user adds an image through the app (Choose image or drag and drop), Electron validates it and saves it as exactly `<slug>.png` in the project's `locations\` folder. PNGs are copied byte for byte; JPG, WEBP, and BMP are converted to PNG. An existing matching image is replaced only through an explicit Replace, which moves it to `locations\replaced\` (the resolver does not look in subfolders).

## 04-write-prompt-package.json

Turns the saved, resolved story into a MiniMax render package. Used by **Write prompt package** on Produce. It never plans: there is no Plan Story node in the graph, and `story_plan.json` must be byte-identical before and after the run.

Graph: `MartiniShotOpenProject` → `MartiniShotLoadStoryPlan` → `MartiniShotResolveLocations` → `MartiniShotBuildProductionPlan` → `MartiniShotWritePromptPackage` ← `MiniMaxH3PromptLLMLoader`, with `PreviewAny` on the resolver report and `ready_to_produce`, the production-plan report, the package report, and the package folder.

| Placeholder | Supplied by Electron |
|---|---|
| `{{project_name}}` | project slug |
| `{{seed}}` | the plan's seed from `story_plan.json` (Build Production Plan and Write Prompt Package both use it, so the production plan is deterministic for a given story) |
| `{{director_llm}}` | the same Prompt LLM Loader option the planner uses |
| `{{render_name}}` | `render-01`. The Director writes `martini_shot/<slug>/render-01`; when that folder already has files it writes `render-01_2`, `_3`, … and `render_package.json` points at the new folder |
| `{{motif_weight}}` | Direction's surreal motif weight (`recurring_style_motif_weight`) |

Fixed values are the node defaults, which match the user's Auto Director workflow (`K-Pop`, 8 s target shots, `continue_bias` 0.5, `max_clip_frames` 260, `continuation_overlap` 22, …). `subject_description` is `the performer` and `pronoun` is `she / her` (node defaults; no per-project setting exists yet). `validate_actions` is on, so every clip's prompt gets an action-validation note in the report.

Before the per-clip prompt calls, the production plan projects this context into a short card for every shot: `MUST`, entering/exiting state, `MAY ADD IF COMPATIBLE`, and `MUST NOT`. A required event is assigned to one deterministic usable shot, rather than left to the optional section-hook pass. The package folder retains a final `director_context.json`, including the polished shot cards, camera/style decisions, and event allocation used for that package.

Build Production Plan raises "Cannot build production plan until requested performer location images are present" when the resolver still lists missing images, so a dead `<Picture>` reference can never be written. The app also refuses to start unless Locations shows every requested image as confirmed for the current plan, and unless the plan is fresh.

Checks after the run: `ready_to_produce` is `True`; `story_plan.json` is unchanged; `render_package.json` was written by this run and names the folder ComfyUI reported, inside the project folder; `segments.json` in that folder is valid and has as many clips as the package report's table; every `segment_NN.txt` exists. The app stores the run in `director_runs` (stage `prompt_package`), one row per clip in `render_clips`, and the three reports in `project_reports` (`prompt_package`).

Clip details on Produce (section, location, outfit, action, mode) come from Build Production Plan's report (one line per shot), matched to `segments.json` clips by song time and confirmed by scene type. A clip that cannot be matched shows "unknown" rather than a guess. Candidate selection is not part of this production path (Build Production Plan passes no candidates), and Produce says so.

## 05-render-next-clip.json

Renders exactly one clip per ComfyUI execution. Used once per queued clip by the Produce queue.

Graph: `MartiniShotLoadRenderClip` → one 1 MP MiniMax H3 render pass: `UNETLoader` (`singularityV2X10eros_prismPIKA.safetensors`) → `MiniMaxH3SigmaShift` (`{{renderShiftVideo}}` / `{{renderShiftAudio}}`, default 12 / 3); `CLIPLoader` (`qwen3vl_32b_minimax_h3_int8_convrot.safetensors`, type `minimax`); video/audio `VAELoader`s; `ResolutionSelector` (4:3, 1 MP, multiple 32) → `MiniMaxH3ReferenceToVideo` → `MiniMaxH3AddGuide` → `SamplerCustomAdvanced` (`{{renderSampler}}` / `{{renderScheduler}}`, default euler / simple, from Settings → Rendering; `{{render_steps}}` from the project's Direction, default 8) → `VAEDecode` → `MiniMaxH3TrimOverlap` → `CreateVideo` (24 fps, with the clip's audio) → `SaveVideo` (mp4) with the loader's `filename_prefix`. `PreviewAny` returns the loader report. The Electron client calls ComfyUI's `/free` endpoint after each clip.

Differences from the Step 2 UI workflow, all with no effect on the rendered frames:
- The two `cleanup` subgraphs are flattened into their `VRAMCleanup` → `RAMCleanup` nodes (API prompts have no subgraphs).
- `ModelPreviewOverrideKJ` (a live-preview widget for the browser) is left out; the guiders use the sigma-shifted model directly.
- The bypassed `LoadAudio` / `LoadImage` overrides and the `ShowText` display nodes are left out.

| Placeholder | Supplied by Electron |
|---|---|
| `{{render_package}}` | the contents of the project's `render_package.json`, exactly as Write Prompt Package saved it. There is no "load render package" node, so the dict is passed as a literal input wrapped in ComfyUI's `{"__value__": …}`; ComfyUI's validator unwraps it and Load Render Clip reads its `folder` |
| `{{loader_mode}}` | `Next missing` for queued clips; `Fixed index` for Retry clip |
| `{{clip_index}}` | the clip Martini Shot expects to render (used by `Fixed index`) |
| `{{noise_seed}}` | a new random seed per attempt, stored with the attempt |

After each run the app reads the loader report ("Clip N of T") and SaveVideo's file from `/history`, and confirms the file exists inside the package folder. It stores the attempt (`render_attempts`: prompt ID, seed, timestamps, loader report, output, error, and cleanup evidence) and the clip state (`render_clips`). Then the client's POST `/free` (`unload_models` + `free_memory`) runs. Its result is recorded as *accepted* (HTTP 200) and then *completed* (ComfyUI's queue idle and `/system_stats` responsive afterwards; free VRAM before/after is kept as evidence, not as proof). The next clip is considered only after that.

### Queue rules (Electron main)

- One production activity at a time for the whole app (`production-lock.ts`), claimed before any `await`, so double clicks or racing IPC calls cannot start a second loop. All ComfyUI work also goes through the app's single ComfyUI line.
- Queue N: renders up to N next-missing clips, one ComfyUI prompt at a time. N at or above the remaining count renders all remaining clips.
- Stop after current clip: persisted on the queue row; the clip already in ComfyUI finishes normally and nothing else starts. ComfyUI's interrupt is never used.
- A failed clip stops the queue and keeps its diagnostics. Retry clip re-renders that clip only (`Fixed index`).
- Cleanup that cannot be confirmed also stops the queue, even when the clip rendered.
- On app start, running queues and attempts are marked *interrupted*; nothing resumes on its own. Before any new render, interrupted attempts are checked against ComfyUI's queue and history. If ComfyUI is still rendering one, the app refuses to start (Next missing would otherwise render that clip twice). If it finished, its file is recovered, and a `/free` cycle runs before anything new is submitted.

## 06-stitch-video.json

Joins every rendered clip of the current prompt package, in order, with the original song into one local MP4. Used by **Stitch final video** (and **Retry stitch**) on Results.

Graph: `MartiniShotOpenProject` → `MartiniShotProjectStatus` (with `PreviewAny` on `status_json`, as evidence that the running ComfyUI sees the project and its `render_package.json`), and `MartiniShotFinalizeVideo` with `PreviewAny` on `video_path` and `report`. Finalize Video calls MiniMaxPrompBuilder's `MiniMaxH3StitchSongSegments`, which runs ComfyUI's bundled ffmpeg itself: the concat demuxer copies the video streams without re-encoding, and the song saved in the package folder (`song.flac`) becomes AAC audio. No other stitch or encode node is needed.

| Placeholder | Supplied by Electron |
|---|---|
| `{{project_name}}` | project slug |
| `{{render_package}}` | the contents of the project's `render_package.json`, passed as `{"__value__": …}` exactly like `05-render-next-clip.json` |

Fixed values: `output_name` `final` and `overwrite` `false`. The node never overwrites: an existing `final.mp4` makes it write `final_2.mp4`, `final_3.mp4`, and so on, so earlier videos are kept.

Checks before submitting (nothing is sent to ComfyUI otherwise): every clip of the package is rendered and its file is in the package folder; no clip is failed, interrupted, queued, or rendering; no render queue, prompt package, or other stitch is running; `render_package.json` names this package's folder; `segments.json` has as many clips as Martini Shot recorded. This matters because Finalize Video, when clips are missing, quietly makes a partial "TEST STITCH" of the first unbroken run of clips. Martini Shot never asks for that, and treats such a result as a failure if it ever appears.

Checks after the run: the video path came back, is a new `.mp4` in the package folder (it did not exist before the run), exists on disk, and the report says it stitched as many segments as the package has. The app stores the attempt in `final_results`: prompt ID, timestamps, path, size, duration (read from the MP4 header), encoding line, the clip summary and the exact clip files used, the `/free` cleanup evidence, and a snapshot of the director report. It also writes that report as `<video>-director-report.md` next to the video. The `/free` step is the usual one: *accepted* means HTTP 200, *completed* means ComfyUI was idle and responsive afterwards. Neither proves how much memory was physically released.

If Martini Shot closes during a stitch, the attempt is marked interrupted. The next Stitch final video first asks ComfyUI about it. If ComfyUI is still running it, the app refuses. If it finished, its video is recorded (after the same checks) and a `/free` cycle runs, instead of stitching a duplicate.

## prompts/ (director LLM instructions)

Instruction texts for the director LLM, owned by the app and sent with each workflow so they can change without
restarting or redeploying ComfyUI. Each file is one placeholder, `{{prompt_<id>}}`, listed in `electron/prompt-library.ts`;
the app reads the files fresh for every run and fills them into any template (like Settings values).

| File | Placeholder | Node input | Used by |
|---|---|---|---|
| `story-system.txt` | `{{prompt_story_system}}` | `story_system` | 02 (Plan Story), 02b (section rewrite) |
| `timeline-shot-rules.txt` | `{{prompt_timeline_shot_rules}}` | `timeline_shot_rules` | 02, 02b, only when `timeline.json` exists |
| `section-rewrite-rules.txt` | `{{prompt_section_rewrite_rules}}` | `section_rewrite_rules` | 02b |

The node inputs are optional; empty means the node's built-in default (`STORY_SYSTEM`, `TIMELINE_SHOT_RULES`,
`SECTION_REWRITE_RULES`), so the canvas copies and older workflows still work. `prompt-library.test.ts` fails when a file
and its default drift apart: change both together. Only instruction prose lives here. The output-format lines the nodes
parse (`SECTION n | scene: …`) stay in node code. The prompt text is part of the director cache key, so an edit always
gets a fresh LLM answer.

## Validating templates against the installed ComfyUI

With ComfyUI running, `npm run validate:workflows` reads `/object_info` and checks every template: node classes loaded, input names, combo values (model files, modes), and link output indexes. It never queues a prompt.
