# Martini Shot ComfyUI

A ready-to-use ComfyUI server for **Martini Shot**, the music video director app. Use it when your own PC can't run the models.

On first start the pod installs:
- ComfyUI
- the Martini Shot nodes
- the MiniMax H3 video models (about 64 GB)

Everything is stored on your network volume, so later starts take a few minutes instead of an hour.


## Before you deploy

- **Network volume:** attach one of **120 GB or more**. Without it, the 64 GB of models download again on every start.
- **GPU:** 48 GB of VRAM or more (L40S, RTX 6000 Ada, A6000, A100, H100).
- **RAM:** 96 GB or more is recommended.

## First start

1. Deploy the pod with your network volume attached.
2. Open **Logs → Container**. The first start takes about 30–60 minutes: 10–20 to install, then the model downloads.
3. When the log shows `Starting ComfyUI on 0.0.0.0:8188`, click **Connect → ComfyUI (8188)**.

The ComfyUI address looks like `https://<pod-id>-8188.proxy.runpod.net`.

## Connect Martini Shot

In Martini Shot Settings choose **Remote server**, use that address as the endpoint,
and enter the value of `MARTINI_SHOT_TOKEN`. Set `MARTINI_SHOT_TOKEN` to a long
random RunPod secret before deploying. It protects project files only; ComfyUI's
own prompt endpoints still have no login.

## Ports

| Port | Use |
|---|---|
| 8188 | ComfyUI |
| 8888 | Jupyter (file browser and terminal) |
| 22 | SSH |

## Choosing models

Set these under **Edit Template → Environment Variables** when you deploy. Leaving them out gives the defaults, which are what Martini Shot uses.

| Variable | Default | Options |
|---|---|---|
| `RENDER_MODEL` | `singularity-prism-pika` | `prism-int8`, `singularity-v2-int8`, `ref2va-int8`, `ref2va-fp8`, `ref2va-w6a8`, `ref2va-bf16`, `none` |
| `TEXT_ENCODER` | `int8` | `nvfp4` (Blackwell GPUs), `bf16`, `none` |
| `VIDEO_VAE` | `fp16` | `int8`, `none` |
| `DIRECTOR_LLMS` | `qwen3vl-8b-fp8` | `qwen3vl-8b-int8`, `qwen3vl-8b-bf16`, `qwen3vl-8b-nvfp4`, `qwen3vl-4b-fp8`, `qwen3vl-4b-bf16`, `none` |
| `LIVE_PREVIEW` | `1` | `0` skips the preview model |
| `WHISPER_MODEL` | `none` | `small`, `medium`, … to pre-download |
| `EXTRA_MODELS` | | `folder\|url;folder\|url` for any other files |

Comma lists download several at once, e.g. `DIRECTOR_LLMS=qwen3vl-8b-fp8,qwen3vl-4b-fp8`. For now the app renders only with the default render model, text encoder and video VAE. Any director LLM works.

**Other settings:**

| Variable | Default | What it does |
|---|---|---|
| `MARTINISHOT_REF` | `main` | Branch or tag of the Martini Shot nodes |
| `COMFYUI_REF` | the tested version | `master` for the newest ComfyUI |
| `COMFYUI_ARGS` | | Extra ComfyUI flags |
| `SKIP_MODELS` | `0` | `1` installs without downloading models (a quick, cheap test) |
| `HF_TOKEN` | | Only for gated Hugging Face models |
| `MARTINI_SHOT_TOKEN` | | Recommended secret for Martini Shot's project-file API |

## Troubleshooting

**HTTP ERROR 403 when opening ComfyUI.** ComfyUI blocks pages that the browser says came from another site, and clicking **Connect** in RunPod counts as one. To fix it:
1. Copy the `https://<pod-id>-8188.proxy.runpod.net` address, paste it into a new tab and press Enter.
2. If that still gives a 403, redeploy with the environment variable `COMFYUI_ARGS=--enable-cors-header`. This turns off ComfyUI's cross-site check, which matters little on a pod that has no login anyway.

The Martini Shot app is never blocked by this check.

## Good to know

- **Billing:** you pay for the GPU every minute the pod runs, even when it's idle. **Terminate** the pod when you're done; your files stay on the network volume.
- **No login:** ComfyUI has no password. Anyone with your pod's URL can use it, so don't share it.
- **Updates:** every restart pulls the latest Martini Shot nodes.
- **Logs:** if something fails, the full log is in `/workspace/logs/setup.log`. ComfyUI's own log is in `/workspace/logs/comfyui.log`.
- **Licenses:** the models come from public Hugging Face repos (Comfy-Org, Kijai and community finetunes), each under its own license. Check them before using the output commercially.

**Source and full docs:** https://github.com/bbillmaier/MusicVideoBuilder/tree/main/cloud/runpod
