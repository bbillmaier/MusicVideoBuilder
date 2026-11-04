#!/usr/bin/env bash
# Martini Shot: cloud ComfyUI setup for RunPod (any Ubuntu + NVIDIA box works too).
#
# Installs ComfyUI, the MartiniShot and Memory Cleanup node packs, and the models the
# Martini Shot workflows need, then starts ComfyUI on port 8188. Everything lives
# under $WORKSPACE (a RunPod network volume), so later pod starts skip what is
# already there and only refresh the MartiniShot nodes.
#
# All settings are environment variables (set them in the RunPod template).
# See cloud/runpod/README.md for the full list and model choices.

set -Eeuo pipefail

# ---------------------------------------------------------------- settings
WORKSPACE="${WORKSPACE:-/workspace}"
COMFY_DIR="${COMFY_DIR:-$WORKSPACE/ComfyUI}"
VENV_DIR="${VENV_DIR:-$WORKSPACE/venv}"
SRC_DIR="${SRC_DIR:-$WORKSPACE/martini-shot-src}"
LOG_DIR="${LOG_DIR:-$WORKSPACE/logs}"

# ComfyUI version. The default is the commit the workflows were built and tested on.
COMFYUI_REPO="${COMFYUI_REPO:-https://github.com/comfyanonymous/ComfyUI.git}"
COMFYUI_REF="${COMFYUI_REF:-fd7639f477050e5c25b68fc38a9c2a6b6d988211}"
COMFYUI_PORT="${COMFYUI_PORT:-8188}"
COMFYUI_ARGS="${COMFYUI_ARGS:-}"
TORCH_INDEX_URL="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}"

# Where the MartiniShot nodes come from: this app's repo, folder comfyui/custom_nodes/MartiniShot.
MARTINISHOT_REPO="${MARTINISHOT_REPO:-}"          # e.g. https://github.com/<you>/martini-shot.git
MARTINISHOT_REF="${MARTINISHOT_REF:-main}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"                  # only needed for a private repo
MEMORY_CLEANUP_REPO="${MEMORY_CLEANUP_REPO:-https://github.com/LAOGOU-666/Comfyui-Memory_Cleanup.git}"

# Model choices (comma lists allowed; "none" downloads nothing for that slot).
RENDER_MODEL="${RENDER_MODEL:-singularity-prism-pika}"
TEXT_ENCODER="${TEXT_ENCODER:-int8}"
VIDEO_VAE="${VIDEO_VAE:-fp16}"
AUDIO_VAE="${AUDIO_VAE:-fp32}"
DIRECTOR_LLMS="${DIRECTOR_LLMS:-qwen3vl-8b-fp8}"
LIVE_PREVIEW="${LIVE_PREVIEW:-1}"
WHISPER_MODEL="${WHISPER_MODEL:-none}"            # pre-download, e.g. small; otherwise fetched on first use
EXTRA_MODELS="${EXTRA_MODELS:-}"                  # "folder|url[|filename];folder|url"
HF_TOKEN="${HF_TOKEN:-}"

SKIP_MODELS="${SKIP_MODELS:-0}"
SKIP_START="${SKIP_START:-0}"                     # 1 = provision only, do not start ComfyUI
RUNPOD_SERVICES="${RUNPOD_SERVICES:-1}"           # 1 = also run the image's /start.sh (SSH, Jupyter)

# The filenames workflows/05-render-next-clip.json loads today.
APP_UNET="singularityV2X10eros_prismPIKA.safetensors"
APP_TEXT_ENCODER="qwen3vl_32b_minimax_h3_int8_convrot.safetensors"
APP_VIDEO_VAE="minimax_h3_video_vae_fp16.safetensors"

# ---------------------------------------------------------------- helpers
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/setup.log") 2>&1

log()  { printf '\n[martini-shot %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\n[martini-shot %s] WARNING: %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die()  { printf '\n[martini-shot] ERROR: %s\n' "$*" >&2; exit 1; }
trap 'die "line $LINENO: $BASH_COMMAND"' ERR

as_list() { tr ',' '\n' <<<"$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' || true; }

auth_url() {  # add a GitHub token to an https URL when one is set
  local url="$1"
  if [[ -n "$GITHUB_TOKEN" && "$url" == https://github.com/* ]]; then
    printf 'https://x-access-token:%s@%s' "$GITHUB_TOKEN" "${url#https://}"
  else
    printf '%s' "$url"
  fi
}

# Model catalog: key -> "folder|filename on disk|url|size in bytes" (sizes verified 2026-11-04).
HF=https://huggingface.co
declare -A RENDER_MODELS=(
  # The app's render model, saved under the name the 05 workflow loads.
  [singularity-prism-pika]="diffusion_models|$APP_UNET|$HF/OliviaRossi/Minimax-h3_Singularity-x-10Eros-Max_PRISM/resolve/main/10Eros_Max_SingularityV2_PRISM2_PikaFlex_0.85_int8HQ.safetensors|20197393008"
  [prism-int8]="diffusion_models|Minimax-h3_Singularity_x_10Eros-Max_PRISM_int8.safetensors|$HF/OliviaRossi/Minimax-h3_Singularity-x-10Eros-Max_PRISM/resolve/main/Minimax-h3_Singularity_x_10Eros-Max_PRISM_int8.safetensors|20285875632"
  [singularity-v2-int8]="diffusion_models|Minimax-h3_Singularity_ref2va_v2_pruned_int8.safetensors|$HF/WarmBloodAban/Minimax-h3_Singularity/resolve/main/Minimax-h3_Singularity_ref2va_v2_pruned_int8.safetensors|20967647456"
  [ref2va-int8]="diffusion_models|minimax_h3_ref2va_pruned_int8_convrot.safetensors|$HF/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors|20970379616"
  [ref2va-fp8]="diffusion_models|minimax_h3_ref2va_pruned_fp8_scaled.safetensors|$HF/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors|20958205608"
  [ref2va-w6a8]="diffusion_models|minimax_h3_ref2va_pruned_w6a8.safetensors|$HF/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_w6a8.safetensors|15983746636"
  [ref2va-bf16]="diffusion_models|minimax_h3_ref2va_pruned_bf16.safetensors|$HF/Comfy-Org/MiniMax-H3/resolve/main/diffusion_models/minimax_h3_ref2va_pruned_bf16.safetensors|40225724176"
)
declare -A TEXT_ENCODERS=(
  [int8]="text_encoders|$APP_TEXT_ENCODER|$HF/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors|27141342152"
  [nvfp4]="text_encoders|qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors|$HF/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors|15687142551"
  [bf16]="text_encoders|qwen3vl_32b_minimax_h3_bf16.safetensors|$HF/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_bf16.safetensors|51506295256"
)
declare -A VIDEO_VAES=(
  [fp16]="vae|$APP_VIDEO_VAE|$HF/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_fp16.safetensors|5207808496"
  [int8]="vae|minimax_h3_video_vae_int8_convrot.safetensors|$HF/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors|2811065184"
)
declare -A AUDIO_VAES=(
  [fp32]="vae|minimax_h3_audio_vae_fp32.safetensors|$HF/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors|605254808"
)
declare -A LLMS=(
  [qwen3vl-8b-fp8]="text_encoders|qwen3vl_8b_fp8_scaled.safetensors|$HF/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_8b_fp8_scaled.safetensors|10588637512"
  [qwen3vl-8b-int8]="text_encoders|qwen3vl_8b_int8_convrot.safetensors|$HF/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors|9350798360"
  [qwen3vl-8b-bf16]="text_encoders|qwen3vl_8b_bf16.safetensors|$HF/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_8b_bf16.safetensors|17534334616"
  [qwen3vl-8b-nvfp4]="text_encoders|qwen3vl_8b_nvfp4.safetensors|$HF/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_8b_nvfp4.safetensors|6305221764"
  [qwen3vl-4b-fp8]="text_encoders|qwen3vl_4b_fp8_scaled.safetensors|$HF/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors|5242467968"
  [qwen3vl-4b-bf16]="text_encoders|qwen3vl_4b_bf16.safetensors|$HF/Comfy-Org/Qwen3-VL/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors|8875719384"
)
TAEH3="vae_approx|taeh3.safetensors|$HF/Kijai/MiniMax-H3-TAE/resolve/main/vae_approx/taeh3.safetensors|9791388"

download() {  # download <folder> <filename> <url> [expected size]
  local folder="$1" name="$2" url="$3" size="${4:-}"
  local dir="$COMFY_DIR/models/$folder" dest part
  dest="$dir/$name"; part="$dest.part"
  mkdir -p "$dir"
  if [[ -f "$dest" ]]; then
    if [[ -z "$size" || "$(stat -c %s "$dest")" == "$size" ]]; then
      echo "  ok      $folder/$name"; return 0
    fi
    warn "$folder/$name has the wrong size; downloading it again"
    mv -f "$dest" "$part"   # resume from what is there
  fi
  echo "  fetch   $folder/$name ${size:+($(numfmt --to=iec "$size"))}"
  local auth=()
  [[ -n "$HF_TOKEN" && "$url" == https://huggingface.co/* ]] && auth=(--header="Authorization: Bearer $HF_TOKEN")
  if command -v aria2c >/dev/null; then
    aria2c -q -c -x 16 -s 16 -k 16M --file-allocation=none --allow-overwrite=true --auto-file-renaming=false \
      "${auth[@]}" -d "$dir" -o "$name.part" "$url"
  else
    local cauth=(); [[ ${#auth[@]} -gt 0 ]] && cauth=(-H "${auth[0]#--header=}")
    curl -fL --retry 5 --retry-delay 5 -C - "${cauth[@]}" -o "$part" "$url"
  fi
  if [[ -n "$size" && "$(stat -c %s "$part")" != "$size" ]]; then
    die "$name: got $(stat -c %s "$part") bytes, expected $size. Re-run to resume."
  fi
  mv -f "$part" "$dest"
}

fetch_choice() {  # fetch_choice <slot label> <catalog name> <comma list>
  local label="$1" key
  local -n catalog="$2"
  while read -r key; do
    [[ -z "$key" || "$key" == none ]] && continue
    [[ -n "${catalog[$key]+x}" ]] || die "$label: unknown choice '$key'. Options: ${!catalog[*]} none"
    IFS='|' read -r folder name url size <<<"${catalog[$key]}"
    download "$folder" "$name" "$url" "$size" </dev/null
  done < <(as_list "$3")
}

# ---------------------------------------------------------------- 1. system packages
log "System packages"
if command -v apt-get >/dev/null && [[ "$(id -u)" == 0 ]]; then
  need=()
  for p in git aria2 ffmpeg python3-venv; do
    dpkg -s "$p" >/dev/null 2>&1 || need+=("$p")
  done
  if [[ ${#need[@]} -gt 0 ]]; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}" \
      || warn "apt-get install failed (${need[*]}); continuing with what is available"
  fi
fi
command -v git >/dev/null || die "git is required"
command -v python3 >/dev/null || die "python3 is required"

if [[ "$RUNPOD_SERVICES" == 1 && -x /start.sh ]]; then
  log "Starting the image's RunPod services (SSH/Jupyter) in the background"
  nohup /start.sh >"$LOG_DIR/runpod-start.log" 2>&1 &
fi

# ---------------------------------------------------------------- 2. ComfyUI
log "ComfyUI ($COMFYUI_REF)"
if [[ ! -d "$COMFY_DIR/.git" ]]; then
  git clone "$COMFYUI_REPO" "$COMFY_DIR"
fi
git -C "$COMFY_DIR" fetch --quiet origin
if git -C "$COMFY_DIR" rev-parse --verify --quiet "origin/$COMFYUI_REF" >/dev/null; then
  git -C "$COMFY_DIR" checkout --quiet --force "origin/$COMFYUI_REF"   # a branch name
else
  git -C "$COMFY_DIR" checkout --quiet --force "$COMFYUI_REF"          # a tag or commit
fi

if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  log "Creating Python environment at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi
PY="$VENV_DIR/bin/python"
"$PY" -m pip install --quiet --upgrade pip wheel
if ! "$PY" -c "import torch" 2>/dev/null; then
  log "Installing PyTorch from $TORCH_INDEX_URL"
  "$PY" -m pip install --quiet torch torchvision torchaudio --index-url "$TORCH_INDEX_URL"
fi
log "Installing ComfyUI requirements"
"$PY" -m pip install --quiet -r "$COMFY_DIR/requirements.txt"

# ---------------------------------------------------------------- 3. custom nodes
log "Custom nodes"
NODES="$COMFY_DIR/custom_nodes"

[[ -n "$MARTINISHOT_REPO" ]] || die "MARTINISHOT_REPO is not set (the Martini Shot app's git URL)"
if [[ ! -d "$SRC_DIR/.git" ]]; then
  git clone --quiet --depth 1 --branch "$MARTINISHOT_REF" "$(auth_url "$MARTINISHOT_REPO")" "$SRC_DIR"
else
  git -C "$SRC_DIR" remote set-url origin "$(auth_url "$MARTINISHOT_REPO")"
  git -C "$SRC_DIR" fetch --quiet --depth 1 origin "$MARTINISHOT_REF"
  git -C "$SRC_DIR" checkout --quiet --force FETCH_HEAD
fi
git -C "$SRC_DIR" remote set-url origin "$MARTINISHOT_REPO"   # do not leave the token on disk
[[ -f "$SRC_DIR/comfyui/custom_nodes/MartiniShot/__init__.py" ]] \
  || die "$MARTINISHOT_REPO has no comfyui/custom_nodes/MartiniShot"
rm -rf "$NODES/MartiniShot"
cp -r "$SRC_DIR/comfyui/custom_nodes/MartiniShot" "$NODES/MartiniShot"
echo "  MartiniShot @ $(git -C "$SRC_DIR" rev-parse --short HEAD)"

if [[ ! -d "$NODES/comfyui_memory_cleanup/.git" ]]; then
  git clone --quiet --depth 1 "$MEMORY_CLEANUP_REPO" "$NODES/comfyui_memory_cleanup"
fi
echo "  comfyui_memory_cleanup @ $(git -C "$NODES/comfyui_memory_cleanup" rev-parse --short HEAD)"

for req in "$NODES/MartiniShot/requirements.txt" "$NODES/comfyui_memory_cleanup/requirements.txt"; do
  if [[ -f "$req" ]]; then "$PY" -m pip install --quiet -r "$req"; fi
done

# ---------------------------------------------------------------- 4. models
if [[ "$SKIP_MODELS" != 1 ]]; then
  log "Models"
  fetch_choice RENDER_MODEL  RENDER_MODELS  "$RENDER_MODEL"
  fetch_choice TEXT_ENCODER  TEXT_ENCODERS  "$TEXT_ENCODER"
  fetch_choice VIDEO_VAE     VIDEO_VAES     "$VIDEO_VAE"
  fetch_choice AUDIO_VAE     AUDIO_VAES     "$AUDIO_VAE"
  fetch_choice DIRECTOR_LLMS LLMS           "$DIRECTOR_LLMS"
  if [[ "$LIVE_PREVIEW" == 1 ]]; then
    IFS='|' read -r folder name url size <<<"$TAEH3"; download "$folder" "$name" "$url" "$size"
  fi
  if [[ -n "$EXTRA_MODELS" ]]; then
    IFS=';' read -ra extras <<<"$EXTRA_MODELS"
    for item in "${extras[@]}"; do
      [[ -z "${item// }" ]] && continue
      IFS='|' read -r folder url name <<<"$item"
      [[ -n "$folder" && -n "$url" ]] || die "EXTRA_MODELS entry '$item' must be folder|url[|filename]"
      name="${name:-$(basename "${url%%\?*}")}"
      download "$folder" "$name" "$url"
    done
  fi
  if [[ -n "$WHISPER_MODEL" && "$WHISPER_MODEL" != none ]]; then
    echo "  whisper $WHISPER_MODEL"
    "$PY" -c "import whisper; whisper.load_model('$WHISPER_MODEL', device='cpu')" >/dev/null
  fi

  # The render workflow loads fixed filenames. Say so when a choice will not match it.
  for pair in "diffusion_models:$APP_UNET:RENDER_MODEL" "text_encoders:$APP_TEXT_ENCODER:TEXT_ENCODER" "vae:$APP_VIDEO_VAE:VIDEO_VAE"; do
    IFS=':' read -r folder name var <<<"$pair"
    [[ -f "$COMFY_DIR/models/$folder/$name" ]] \
      || warn "$var: Martini Shot's render workflow loads $folder/$name, which is not installed. Rendering will fail until the app can pick other models."
  done
fi

# ---------------------------------------------------------------- 5. start
log "Setup finished"
if [[ -n "${RUNPOD_POD_ID:-}" ]]; then
  echo "  Martini Shot ComfyUI URL: https://${RUNPOD_POD_ID}-${COMFYUI_PORT}.proxy.runpod.net"
fi
if [[ "$SKIP_START" == 1 ]]; then exit 0; fi

trap - ERR
log "Starting ComfyUI on 0.0.0.0:$COMFYUI_PORT"
cd "$COMFY_DIR"
while true; do
  # shellcheck disable=SC2086
  "$PY" main.py --listen 0.0.0.0 --port "$COMFYUI_PORT" $COMFYUI_ARGS 2>&1 | tee -a "$LOG_DIR/comfyui.log" || true
  warn "ComfyUI exited; restarting in 5 seconds"
  sleep 5
done
