# Martini Shot on RunPod

For local Martini Shot projects that need a remote ComfyUI worker. [`setup.sh`](setup.sh) runs every Martini Shot workflow stage when Remote ComfyUI worker is selected; the project itself remains local-authoritative. It installs:

- ComfyUI, pinned to the commit the workflows were tested on.
- The **MartiniShot** node pack from this repo (`comfyui/custom_nodes/MartiniShot`).
- The **Memory Cleanup** node pack ([LAOGOU-666/Comfyui-Memory_Cleanup](https://github.com/LAOGOU-666/Comfyui-Memory_Cleanup)).
- The **RES4LYF** node pack ([ClownsharkBatwing/RES4LYF](https://github.com/ClownsharkBatwing/RES4LYF)), pinned to the dev PC's commit, for the extra samplers and schedulers (`beta57`, `res_2s`, …) in Martini Shot's Settings.
- The models, from their public Hugging Face repos.

Then it starts ComfyUI on port 8188.

Everything goes on the pod's network volume (`/workspace`). The first start downloads about 70 GB with the default models. Later starts reuse what's on the volume and only refresh the MartiniShot nodes from git.

## Connect Martini Shot to your pod

In Martini Shot Settings enable **Remote clip rendering**, enter
`https://<pod-id>-8188.proxy.runpod.net` and the same `MARTINI_SHOT_TOKEN`
configured on the pod. The app hash-syncs the local project into
`output/martini_shot/<slug>` before each remote workflow and brings changed
artifacts back afterwards. You can switch destinations between any stages or
clips; projects never move to the pod.

## 1. Create a network volume

RunPod → **Storage → New Network Volume**.

- **Size:** 120 GB for the default models. Add the sizes in the tables below for extra models.
- **Data center:** pick one that has the GPU you want. The pod has to be in the same data center.

## 2. Create a template

RunPod → **Templates → New Template**.

| Field | Value |
|---|---|
| Container image | `runpod/pytorch:1.6.0-cu1300-torch291-ubuntu2404` (CUDA 13.0 compiler; the script installs PyTorch 2.10.0/cu130 in its own environment) |
| Container disk | 30 GB |
| Volume mount path | `/workspace` |
| Expose HTTP ports | `8188` (add `8888` too to keep Jupyter) |
| Expose TCP ports | `22` (SSH, optional) |

**Container start command** (change the URL for a fork):

```bash
bash -c 'R=https://github.com/bbillmaier/MusicVideoBuilder.git; D=/workspace/martini-shot-src; [ -n "$GITHUB_TOKEN" ] && A="https://x-access-token:$GITHUB_TOKEN@${R#https://}" || A=$R; [ -d $D/.git ] || git clone --depth 1 "$A" $D; export MARTINISHOT_REPO=$R; exec bash $D/cloud/runpod/setup.sh'
```

The start command only clones the repo the first time. `setup.sh` then pulls the latest version of the nodes on every start. For an existing volume, refresh the source before launching an updated setup script; see the CUDA 13 migration below.

### Migrating an existing CUDA 12.8 pod

Stop running workflows first. Publish these setup changes to the branch used by the pod, then change the template/container image to `runpod/pytorch:1.6.0-cu1300-torch291-ubuntu2404` and reuse the existing network volume. The CUDA 13.0 compiler is needed to rebuild SageAttention; changing only the pip index leaves the old image's CUDA 12.8 compiler in place.

Refresh `/workspace/martini-shot-src` to your intended published revision **before** executing its `cloud/runpod/setup.sh` (the start command above otherwise executes the copy already on disk). For the default public repo/branch, with ComfyUI stopped:

```bash
git -C /workspace/martini-shot-src fetch origin main
git -C /workspace/martini-shot-src checkout --detach FETCH_HEAD
export MARTINISHOT_REPO=https://github.com/bbillmaier/MusicVideoBuilder.git
bash /workspace/martini-shot-src/cloud/runpod/setup.sh
```

Setup migrates the existing environment to Torch 2.10.0, torchvision 0.25.0 and torchaudio 2.10.0 with CUDA 13.0, removes the previous SageAttention installation, and builds the pinned SageAttention 2.2.0 source for the new stack. Models are retained. Allow time for this one-time rebuild. The selected host must support CUDA 13; setup runs a real GPU smoke test and stops if it fails.

Verify the startup log reports `PyTorch 2.10.0+cu130`, `CUDA 13.0`, a passed GPU smoke test, and SageAttention 2.2.0. ComfyUI should no longer report that CUDA operations are disabled because it needs cu130.

**Environment variables:** at least `MARTINISHOT_REF=main`. Add `GITHUB_TOKEN` if the repo is private: a fine-grained token with read-only *Contents* access to this repo. Store it as a RunPod secret (`{{ RUNPOD_SECRET_github_token }}`), not as plain text.
Set `MARTINI_SHOT_TOKEN` to a long random value and store it as a RunPod secret too. It protects only Martini Shot's project-file API; ComfyUI's normal `/prompt` and `/view` endpoints remain unauthenticated.

## 3. Start a pod

- **GPU:** 48 GB of VRAM or more (L40S, RTX 6000 Ada, A6000, A100, H100).
- **RAM:** 96 GB or more. The 27 GB text encoder stays loaded, and 64 GB of RAM has run out during renders.
- **Storage:** attach the network volume.

Follow progress in the pod's logs, or in `/workspace/logs/setup.log`. When it finishes, it prints the URL:

```
https://<pod-id>-8188.proxy.runpod.net
```

## Environment variables

Each model slot takes one choice, a comma list, or `none`.

### Models

**`RENDER_MODEL`** (default `singularity-prism-pika`):

| Choice | File on disk | Size | Source |
|---|---|---|---|
| `singularity-prism-pika` ✅ app default | `singularityV2X10eros_prismPIKA.safetensors` | 20.2 GB | OliviaRossi `10Eros_Max_SingularityV2_PRISM2_PikaFlex_0.85_int8HQ` (renamed to what the app loads) |
| `prism-int8` | `Minimax-h3_Singularity_x_10Eros-Max_PRISM_int8.safetensors` | 20.3 GB | OliviaRossi |
| `singularity-v2-int8` | `Minimax-h3_Singularity_ref2va_v2_pruned_int8.safetensors` | 21.0 GB | WarmBloodAban |
| `ref2va-int8` | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 21.0 GB | Comfy-Org (official) |
| `ref2va-fp8` | `minimax_h3_ref2va_pruned_fp8_scaled.safetensors` | 21.0 GB | Comfy-Org (official) |
| `ref2va-w6a8` | `minimax_h3_ref2va_pruned_w6a8.safetensors` | 16.0 GB | Comfy-Org (official) |
| `ref2va-bf16` | `minimax_h3_ref2va_pruned_bf16.safetensors` | 40.2 GB | Comfy-Org (official) |

**`TEXT_ENCODER`** (default `int8`), from Comfy-Org:

| Choice | File | Size |
|---|---|---|
| `int8` ✅ | `qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | 27.1 GB |
| `nvfp4` | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (Blackwell GPUs) | 15.7 GB |
| `bf16` | `qwen3vl_32b_minimax_h3_bf16.safetensors` | 51.5 GB |

**`VIDEO_VAE`** (default `fp16`), from Comfy-Org:

| Choice | File | Size |
|---|---|---|
| `fp16` ✅ | `minimax_h3_video_vae_fp16.safetensors` | 5.2 GB |
| `int8` | `minimax_h3_video_vae_int8_convrot.safetensors` | 2.8 GB |

**`AUDIO_VAE`** (default `fp32`), from Comfy-Org:

| Choice | File | Size |
|---|---|---|
| `fp32` ✅ | `minimax_h3_audio_vae_fp32.safetensors` | 0.6 GB |

**`DIRECTOR_LLMS`** (default `qwen3vl-8b-fp8,qwen3vl-8b-w4a8`), from Comfy-Org/Qwen3-VL. These are the vision LLMs for planning and prompt writing; pick one or more. A retake ("Try another take") reuses the LLM its prompt package was written with, so install every LLM your projects' packages were written with, on any machine:

| Choice | Size |
|---|---|
| `qwen3vl-8b-fp8` ✅ | 10.6 GB |
| `qwen3vl-8b-w4a8` ✅ | 6.3 GB |
| `qwen3vl-8b-int8` | 9.4 GB |
| `qwen3vl-8b-bf16` | 17.5 GB |
| `qwen3vl-8b-nvfp4` | 6.3 GB |
| `qwen3vl-4b-fp8` | 5.2 GB |
| `qwen3vl-4b-bf16` | 8.9 GB |

**Other model settings:**

| Variable | Default | What it does |
|---|---|---|
| `LIVE_PREVIEW` | `1` | `taeh3.safetensors` (Kijai), the tiny VAE for live previews |
| `WHISPER_MODEL` | `none` | Pre-downloads a Whisper size (`small`, …). Otherwise it's fetched on first use |
| `EXTRA_MODELS` | | Extra downloads: `folder\|url[\|filename];folder\|url` |
| `HF_TOKEN` | | Only for gated or private Hugging Face files |

✅ marks the files `workflows/05-render-next-clip.json` loads today. Other render model, text encoder and VAE choices download fine, but the app can't select them yet (that comes with the remote-mode work). The script warns when the files the app loads are missing. Any installed director LLM can already be picked in Martini Shot's Settings.

The script checks every download against its known size, so a partial file is resumed instead of being used.

### Post-processing

The app's **Post-processing** page (between Produce and Results) runs, per clip and only when asked: ReActor face restoration (CodeFormer) or face replacement with the chosen character reference, then optional SeedVR2 restoration/upscaling. Original renders are never changed. With `POST_PROCESSING=1` (default) setup installs:

- **ReActor** from `REACTOR_REPO` at `REACTOR_REF` (Codeberg `Gourieff/comfyui-reactor-node`, v0.7.0-a2, the dev PC's commit). Its `install.py` is **not** run, because it can install a CUDA 12 onnxruntime. Its `requirements.txt` is installed under the torch constraints.
- **SeedVR2** from `SEEDVR2_REPO` at `SEEDVR2_REF` (`numz/ComfyUI-SeedVR2_VideoUpscaler`, v2.5.24).
- **onnxruntime-gpu** `ONNXRUNTIME_GPU_VERSION` (default `1.31.0`). PyPI builds from 1.27 on target CUDA 13, matching this stack; 1.26 and older target CUDA 12 and would silently run ReActor on the CPU here. The CPU-only `onnxruntime` wheel is removed if present (it shadows the GPU one). The version is added to the pip constraints. Setup then opens a real session on the face detector and warns if it does not run on `CUDAExecutionProvider`; the app also shows this per job.

**`POST_PROCESSING_VRAM_MODE`** is the worker's default memory mode:

| Value | Hardware target | SeedVR2 starting preset |
|---|---|---|
| `high_vram` (default when unset or blank) | 48 GB VRAM, 96 GB RAM recommended | `seedvr2_ema_7b_fp16`, temporal batch 9, no VAE tiling, model kept on the GPU, decoded frames bounded at 48 GB |
| `low_vram` | 16 GB VRAM / 64 GB RAM | `seedvr2_ema_3b_fp8_e4m3fn`, temporal batch 5, VAE tiling (512 px tiles), model offloaded to RAM between phases, decoded frames bounded at 24 GB |

- The value is trimmed and case-insensitive. Anything else stops setup with an error naming the variable; the node refuses Worker-default jobs with the same message if the process was started some other way.
- A clip's explicit **Low VRAM** or **High VRAM** setting overrides the worker default. **Worker default** reads it from the worker (`GET /martini/postprocess/info`) when the clip is queued. The job records the requested and resolved mode, and the resolved mode is part of the cache key. If the variable changes between queueing and running, the node refuses the job instead of using the other preset.
- The mode is independent of where the job runs: either mode can run locally or on a pod with suitable hardware. Presets are starting points to measure; they are not GPU detection or a promise that a clip fits.

**`POST_PROCESSING_MODELS`**: `mode` (default, the worker default's SeedVR2 model), `all` (both modes, so clips can override either way), `low_vram`, `high_vram`, `face` (face models only), `none`. The app refuses a job whose models the worker lacks and says which ones.

| Model | Folder | Size | Used by |
|---|---|---|---|
| `inswapper_128.onnx` | `insightface` | 554 MB | Replace |
| `buffalo_l.zip` → `buffalo_l/` | `insightface/models` | 289 MB | face detection (ReActor, face report) |
| `codeformer-v0.1.0.pth` | `facerestore_models` | 377 MB | Restore; Replace with restoration |
| `detection_Resnet50_Final.pth`, `parsing_parsenet.pth` | `facedetection` | 195 MB | CodeFormer face alignment and parsing |
| `hand_yolov8s.pt` | `ultralytics/bbox` | 23 MB | face report: hands over faces |
| `ema_vae_fp16.safetensors` | `SEEDVR2` | 0.5 GB | SeedVR2, both modes |
| `seedvr2_ema_3b_fp8_e4m3fn.safetensors` | `SEEDVR2` | 3.4 GB | Low VRAM |
| `seedvr2_ema_7b_fp16.safetensors` | `SEEDVR2` | 16.5 GB | High VRAM |

Downloads resume from `.part` files and are checked against the published size **and sha256** (the SeedVR2 hashes match SeedVR2's own registry). A file that passed is marked `<file>.sha256-ok` with its size and modified time, so later starts do not re-hash 16 GB. A file with the right size but wrong hash is downloaded again.

**Licenses.** Node-code licenses and pretrained-model licenses are separate; check both before commercial use.

| Component | Code license | Model / weights license |
|---|---|---|
| ReActor (Codeberg checkout) | AGPL-3.0 (the repo's `LICENSE`; the GitHub mirror reports GPL-3.0) | — |
| `inswapper_128.onnx`, `buffalo_l` (InsightFace) | InsightFace code MIT | **Non-commercial research use only** (InsightFace model policy). Redistributed through the `Gourieff/ReActor` HF dataset, whose MIT card does not change that |
| CodeFormer (`codeformer-v0.1.0.pth`, `parsing_parsenet.pth`) | S-Lab License 1.0 (non-commercial) | S-Lab License 1.0 (non-commercial) |
| RetinaFace `detection_Resnet50_Final.pth` (facexlib) | MIT | MIT (biubug6/Pytorch_Retinaface) |
| SeedVR2 ComfyUI nodes | Apache-2.0 | SeedVR2 weights Apache-2.0 (ByteDance-Seed; `numz/SeedVR2_comfyUI` repackaging Apache-2.0) |
| `hand_yolov8s.pt` (Bingsu/adetailer) | Ultralytics library AGPL-3.0 | Apache-2.0 model card; trained with Ultralytics YOLOv8 |
| onnxruntime-gpu | MIT | — |

### Setup and startup

| Variable | Default | What it does |
|---|---|---|
| `MARTINISHOT_REPO` | set by the start command | git URL of this repo |
| `MARTINISHOT_REF` | `main` | branch or tag to install the nodes from |
| `GITHUB_TOKEN` | | read token for a private repo; removed from the stored git URL after cloning |
| `COMFYUI_REF` | the tested commit | `master` for the latest ComfyUI |
| `RES4LYF_REF` | the dev PC's commit | RES4LYF branch, tag or commit; `none` skips it (then pick a built-in scheduler such as `beta` in Settings) |
| `COMFYUI_ARGS` | | extra ComfyUI flags, e.g. `--reserve-vram 2` |
| `TORCH_INDEX_URL` | PyTorch cu130 | wheel index used to install or migrate the requested stack |
| `TORCH_VERSION` / `TORCHVISION_VERSION` / `TORCHAUDIO_VERSION` | `2.10.0` / `0.25.0` / `2.10.0` | Exact versions, constrained during subsequent dependency installs |
| `TORCH_CUDA_VERSION` | `13.0` | Required Torch CUDA runtime and SageAttention compiler version; change together with the index and container image |
| `SAGE_ATTENTION` | `1` | builds SageAttention 2 for the pod's GPU (about 10 min, in the background while the models download; cached in `/workspace/wheels`, progress in `/workspace/logs/sageattention.log`), falls back to SageAttention 1, and starts ComfyUI with `--use-sage-attention` only if it works. `0` turns it off |
| `JUPYTER_PASSWORD` | `MartiniPass` | Jupyter's password. The default is shared and public, and Jupyter gives a root terminal, so set your own (as a RunPod secret) for anything beyond a quick test |
| `SAGE_REF` | `eb615cf6cf4d221338033340ee2de1c37fbdba4a` (v2.2.0) | SageAttention source revision to build |
| `SKIP_MODELS` | `0` | `1` skips all model downloads |
| `SKIP_START` | `0` | `1` sets everything up without starting ComfyUI |
| `RUNPOD_SERVICES` | `1` | also runs the image's `/start.sh` (SSH, Jupyter) |
| `POST_PROCESSING` | `1` | `0` skips ReActor, SeedVR2, onnxruntime-gpu and their models |
| `POST_PROCESSING_VRAM_MODE` | unset = `high_vram` | `low_vram` or `high_vram`; anything else stops setup (see Post-processing) |
| `POST_PROCESSING_MODELS` | `mode` | `all`, `low_vram`, `high_vram`, `face`, `none` |
| `REACTOR_REPO` / `REACTOR_REF` | Codeberg / `2add113…` | ReActor source and pinned commit |
| `SEEDVR2_REPO` / `SEEDVR2_REF` | numz / `4490bd1…` (v2.5.24) | SeedVR2 source and pinned commit |
| `ONNXRUNTIME_GPU_VERSION` | `1.31.0` | must be a CUDA 13 build (1.27 or newer) for the default stack |

## Troubleshooting

**`CUBLAS_STATUS_INVALID_VALUE` / `CUBLAS_STATUS_NOT_INITIALIZED` on the first render.** The image's CUDA libraries (`/usr/local/cuda/lib64` on `LD_LIBRARY_PATH`) were overriding the cuBLAS that PyTorch installs with pip. `setup.sh` now removes the image's CUDA directories from `LD_LIBRARY_PATH`, and its GPU smoke test runs matrix multiplies, so this stops setup instead of the first render. To test by hand: `LD_LIBRARY_PATH= /workspace/venv/bin/python -c "import torch; a=torch.ones(256,256,device='cuda'); print((a@a).sum())"`.

**HTTP ERROR 403 when opening ComfyUI in the browser.** ComfyUI's origin check rejects any request with `Sec-Fetch-Site: cross-site` (`server.py`, `create_origin_only_middleware`). Clicking **Connect** on runpod.io opens `proxy.runpod.net`, a different site, so the page is refused. ComfyUI doesn't log anything when this happens.
- Paste the proxy URL into a new tab yourself. Typed addresses and bookmarks aren't cross-site.
- Or start ComfyUI with `COMFYUI_ARGS=--enable-cors-header`. That replaces the origin check with permissive CORS. The pod has no login anyway, but any web page that knew the URL could then queue jobs on it.

Martini Shot's requests come from Electron's main process, not a browser page, so the app is never blocked by this check.

## Notes

- **Security:** ComfyUI has no login. Anyone with the `proxy.runpod.net` URL can queue jobs and read outputs. Don't share it, and stop the pod when you're done.
- **License:** the MiniMax H3 weights and the community finetunes have their own licenses. Check them on each model page before using them.
- **Updating the nodes:** run `tools/sync-martinishot.ps1` on the dev PC, publish your normal node update, then restart the pod. A restart is sufficient; no image rebuild or model re-download is needed.
