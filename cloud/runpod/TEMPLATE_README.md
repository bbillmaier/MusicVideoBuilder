# Martini Shot: turn your song into a music video

**Martini Shot** is a desktop app that turns your music, performer reference images, and creative direction into an AI-generated music video. Its AI director plans a story around your song, writes the shot prompts, and helps take the project through rendered clips to a finished video with your music.

## How you use Martini Shot

1. **Bring your music and look.** Add a song and performer image, plus outfit or location references to guide the visuals.
2. **Set the direction.** Describe the mood, story, or visual style you have in mind, or let the director take the lead.
3. **Shape the video.** Generate a story plan, adjust the song timeline, and supply any additional location images the plan requests.
4. **Create and refine.** Generate the clips, inspect the results, and re-render shots you want to change.
5. **Finish your video.** Assemble the clips with your song, play the result, and open the finished video file from the app.

Your projects and final videos stay on your computer. This RunPod template supplies the cloud GPU worker that runs the AI work, so you can use remote computing power from the desktop app. Files needed for that work are uploaded to the worker, and generated results are downloaded back to your project.

## Technical setup: the remote worker

This template installs the ComfyUI worker used by the Martini Shot desktop app; install and run the desktop app separately on your PC. The selected worker can run planning, prompt writing, rendering, and stitching through a hash-checked mirror of your local project.

On first start the pod installs:
- ComfyUI
- the Martini Shot nodes
- the MiniMax H3 video models (about 70 GB)

Everything is stored on your network volume, so later starts take a few minutes instead of an hour.


## Before you deploy

- **Container image:** `runpod/pytorch:1.6.0-cu1300-torch291-ubuntu2404`. Setup installs Torch 2.10.0/cu130 and builds SageAttention 2.2.0 with the CUDA 13.0 compiler. The host driver must support CUDA 13.
- **Existing CUDA 12.8 volumes:** update the container image and refresh the setup script before launching it. Setup upgrades the Python environment and rebuilds SageAttention while keeping downloaded models. See the full README's CUDA 13 migration instructions.
- **Network volume:** attach one of **120 GB or more**. Without it, the 70 GB of models download again on every start.
- **GPU:** 48 GB of VRAM or more (L40S, RTX 6000 Ada, A6000, A100, H100).
- **RAM:** 96 GB or more is recommended.

## First start

1. Deploy the pod with your network volume attached.
2. Open **Logs → Container**. The first start takes about 30–60 minutes: 10–20 to install, then the model downloads.
3. When the log shows `Starting ComfyUI on 0.0.0.0:8188`, click **Connect → ComfyUI (8188)**.

The ComfyUI address looks like `https://<pod-id>-8188.proxy.runpod.net`.

## Connect Martini Shot

In Martini Shot Settings choose **Remote ComfyUI worker** under **Workflow destination**, use that address as the endpoint,
and enter `MARTINI_SHOT_TOKEN`. Set it to a long random RunPod secret before deploying.
Martini Shot hash-syncs the local project before remote work and downloads changed
artifacts back into that local project when it finishes. Switch the workflow destination
in Settings at any time; project paths and local folder actions do not change.

## Ports

| Port | Use |
|---|---|
| 8188 | ComfyUI |
| 8888 | Jupyter (file browser and terminal). Password: `MartiniPass`, unless you set `JUPYTER_PASSWORD` |
| 22 | SSH |

The default Jupyter password is the same for everyone, and Jupyter gives full control of the pod. Set `JUPYTER_PASSWORD` under **Environment Variables** to use your own.

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
| `SAGE_ATTENTION` | `1` | Faster video rendering. It builds while the models download, so it adds little to the first start; `0` turns it off |
| `JUPYTER_PASSWORD` | `MartiniPass` | Password for Jupyter on port 8888 |
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
- **Updates:** after node updates, restart the pod; no image rebuild or model re-download is needed.
- **Local authority:** the database and all project folders stay local. You may switch the workflow destination between any stages or clips.
- **Logs:** if something fails, the full log is in `/workspace/logs/setup.log`. ComfyUI's own log is in `/workspace/logs/comfyui.log`.
- **Licenses:** the models come from public Hugging Face repos (Comfy-Org, Kijai and community finetunes), each under its own license. Check them before using the output commercially.

**Source and full docs:** https://github.com/bbillmaier/MusicVideoBuilder/tree/main/cloud/runpod
