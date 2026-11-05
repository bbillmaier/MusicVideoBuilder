# Martini Shot on RunPod

For local Martini Shot projects that need a remote ComfyUI worker. [`setup.sh`](setup.sh) runs every Martini Shot workflow stage when Remote ComfyUI worker is selected; the project itself remains local-authoritative. It installs:

- ComfyUI, pinned to the commit the workflows were tested on.
- The **MartiniShot** node pack from this repo (`comfyui/custom_nodes/MartiniShot`).
- The **Memory Cleanup** node pack ([LAOGOU-666/Comfyui-Memory_Cleanup](https://github.com/LAOGOU-666/Comfyui-Memory_Cleanup)).
- The models, from their public Hugging Face repos.

Then it starts ComfyUI on port 8188.

Everything goes on the pod's network volume (`/workspace`). The first start downloads about 64 GB with the default models. Later starts reuse what's on the volume and only refresh the MartiniShot nodes from git.

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
| Container image | `runpod/pytorch:1.6.0-cu1281-torch291-ubuntu2404` (any RunPod PyTorch image with CUDA 12.8+ works; the script installs its own torch) |
| Container disk | 30 GB |
| Volume mount path | `/workspace` |
| Expose HTTP ports | `8188` (add `8888` too to keep Jupyter) |
| Expose TCP ports | `22` (SSH, optional) |

**Container start command** (change the URL for a fork):

```bash
bash -c 'R=https://github.com/bbillmaier/MusicVideoBuilder.git; D=/workspace/martini-shot-src; [ -n "$GITHUB_TOKEN" ] && A="https://x-access-token:$GITHUB_TOKEN@${R#https://}" || A=$R; [ -d $D/.git ] || git clone --depth 1 "$A" $D; export MARTINISHOT_REPO=$R; exec bash $D/cloud/runpod/setup.sh'
```

The start command only clones the repo the first time. `setup.sh` then pulls the latest version of the nodes on every start. Changes to `setup.sh` itself are picked up from the second start onward.

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

**`DIRECTOR_LLMS`** (default `qwen3vl-8b-fp8`), from Comfy-Org/Qwen3-VL. These are the vision LLMs for planning and prompt writing; pick one or more:

| Choice | Size |
|---|---|
| `qwen3vl-8b-fp8` ✅ | 10.6 GB |
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

### Setup and startup

| Variable | Default | What it does |
|---|---|---|
| `MARTINISHOT_REPO` | set by the start command | git URL of this repo |
| `MARTINISHOT_REF` | `main` | branch or tag to install the nodes from |
| `GITHUB_TOKEN` | | read token for a private repo; removed from the stored git URL after cloning |
| `COMFYUI_REF` | the tested commit | `master` for the latest ComfyUI |
| `COMFYUI_ARGS` | | extra ComfyUI flags, e.g. `--reserve-vram 2` |
| `TORCH_INDEX_URL` | PyTorch cu128 | wheel index used when the venv has no torch |
| `SAGE_ATTENTION` | `1` | builds SageAttention 2 for the pod's GPU on the first start (about 10 min, cached in `/workspace/wheels`), falls back to SageAttention 1, and starts ComfyUI with `--use-sage-attention` only if it works. `0` turns it off |
| `SAGE_REF` | `main` | SageAttention branch, tag, or commit to build |
| `SKIP_MODELS` | `0` | `1` skips all model downloads |
| `SKIP_START` | `0` | `1` sets everything up without starting ComfyUI |
| `RUNPOD_SERVICES` | `1` | also runs the image's `/start.sh` (SSH, Jupyter) |

## Troubleshooting

**HTTP ERROR 403 when opening ComfyUI in the browser.** ComfyUI's origin check rejects any request with `Sec-Fetch-Site: cross-site` (`server.py`, `create_origin_only_middleware`). Clicking **Connect** on runpod.io opens `proxy.runpod.net`, a different site, so the page is refused. ComfyUI doesn't log anything when this happens.
- Paste the proxy URL into a new tab yourself. Typed addresses and bookmarks aren't cross-site.
- Or start ComfyUI with `COMFYUI_ARGS=--enable-cors-header`. That replaces the origin check with permissive CORS. The pod has no login anyway, but any web page that knew the URL could then queue jobs on it.

Martini Shot's requests come from Electron's main process, not a browser page, so the app is never blocked by this check.

## Notes

- **Security:** ComfyUI has no login. Anyone with the `proxy.runpod.net` URL can queue jobs and read outputs. Don't share it, and stop the pod when you're done.
- **License:** the MiniMax H3 weights and the community finetunes have their own licenses. Check them on each model page before using them.
- **Updating the nodes:** run `tools/sync-martinishot.ps1` on the dev PC, publish your normal node update, then restart the pod. A restart is sufficient; no image rebuild or model re-download is needed.
