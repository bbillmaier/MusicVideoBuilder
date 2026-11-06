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
TORCH_INDEX_URL="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu130}"
TORCH_VERSION="${TORCH_VERSION:-2.10.0}"
TORCHVISION_VERSION="${TORCHVISION_VERSION:-0.25.0}"
TORCHAUDIO_VERSION="${TORCHAUDIO_VERSION:-2.10.0}"
TORCH_CUDA_VERSION="${TORCH_CUDA_VERSION:-13.0}"

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

# SageAttention: faster attention for the video model (the local dev PC runs ComfyUI with it).
SAGE_ATTENTION="${SAGE_ATTENTION:-1}"             # 1 = install it and start ComfyUI with --use-sage-attention
SAGE_REPO="${SAGE_REPO:-https://github.com/thu-ml/SageAttention.git}"
SAGE_REF="${SAGE_REF:-eb615cf6cf4d221338033340ee2de1c37fbdba4a}" # v2.2.0
WHEEL_DIR="${WHEEL_DIR:-$WORKSPACE/wheels}"       # built wheels are kept here, per torch version and GPU

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
  # The image's start script skips JupyterLab without a password. MartiniPass is a shared default: anyone with this
  # pod's Jupyter URL can log in with it, so set JUPYTER_PASSWORD (ideally as a RunPod secret) to use your own.
  # Started before any check that can stop setup, so SSH/Jupyter stay reachable for debugging.
  export JUPYTER_PASSWORD="${JUPYTER_PASSWORD:-MartiniPass}"
  log "Starting the image's RunPod services (SSH/Jupyter) in the background"
  nohup /start.sh >"$LOG_DIR/runpod-start.log" 2>&1 &
fi

if [[ "$SAGE_ATTENTION" == 1 ]]; then
  nvcc_check="$(command -v nvcc || ls /usr/local/cuda/bin/nvcc 2>/dev/null || true)"
  [[ -n "$nvcc_check" ]] && "$nvcc_check" --version | grep -q "release ${TORCH_CUDA_VERSION}," \
    || warn "SageAttention 2 needs a CUDA $TORCH_CUDA_VERSION development image (default: runpod/pytorch:1.6.0-cu1300-torch291-ubuntu2404); falling back to SageAttention 1"
fi

# PyTorch brings its own CUDA libraries via pip. The image's toolkit libraries (/usr/local/cuda/lib64 on LD_LIBRARY_PATH)
# must not shadow them: mixing the image's cuBLAS with pip's makes every matrix multiply fail
# (CUBLAS_STATUS_INVALID_VALUE / NOT_INITIALIZED). The driver paths (/usr/local/nvidia) stay. nvcc does not need these.
LD_LIBRARY_PATH="$(tr ':' '\n' <<<"${LD_LIBRARY_PATH:-}" | grep -v -e '^$' -e '^/usr/local/cuda' | paste -sd: - || true)"
export LD_LIBRARY_PATH

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
# Apply the requested stack to existing volumes too, not just empty environments.
torch_matches() {
  "$PY" - "$TORCH_VERSION" "$TORCHVISION_VERSION" "$TORCHAUDIO_VERSION" "$TORCH_CUDA_VERSION" <<'PYCODE'
import sys
import torch, torchvision, torchaudio
actual = [m.__version__.split('+')[0] for m in (torch, torchvision, torchaudio)]
sys.exit(0 if actual == sys.argv[1:4] and torch.version.cuda == sys.argv[4] else 1)
PYCODE
}
if ! torch_matches >/dev/null 2>&1; then
  log "Installing PyTorch $TORCH_VERSION / CUDA $TORCH_CUDA_VERSION from $TORCH_INDEX_URL"
  "$PY" -m pip install --quiet --upgrade "torch==$TORCH_VERSION" "torchvision==$TORCHVISION_VERSION" \
    "torchaudio==$TORCHAUDIO_VERSION" --index-url "$TORCH_INDEX_URL"
  torch_matches || die "Installed PyTorch stack does not match the requested versions"
  # Compiled extensions from the previous Torch/CUDA stack must be rebuilt.
  "$PY" -m pip uninstall -y sageattention
fi
# Prevent later node requirements from silently replacing the selected stack.
printf 'torch==%s\ntorchvision==%s\ntorchaudio==%s\n' \
  "$TORCH_VERSION" "$TORCHVISION_VERSION" "$TORCHAUDIO_VERSION" >"$VENV_DIR/torch-constraints.txt"
export PIP_CONSTRAINT="$VENV_DIR/torch-constraints.txt"
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

# Check the real GPU runtime before spending time building extensions or downloading models.
torch_matches || die "A dependency changed the requested PyTorch stack"
"$PY" - <<'PYCODE'
import torch
print(f"Runtime: PyTorch {torch.__version__}, CUDA {torch.version.cuda}")
assert torch.cuda.is_available(), "CUDA is unavailable; use a host driver compatible with the selected CUDA runtime"
x = torch.ones(16, device='cuda')
assert (x + x).sum().item() == 32
# Matrix multiplies go through cuBLAS, which an elementwise op never touches.
a = torch.ones(256, 256, device='cuda')
assert torch.nn.functional.linear(a, a).sum().item() == 256 ** 3, "cuBLAS fp32 matmul gave a wrong result"
assert (a.half() @ a.half()).float().sum().item() == 256 ** 3, "cuBLAS fp16 matmul gave a wrong result"
torch.cuda.synchronize()
print(f"GPU smoke test passed: {torch.cuda.get_device_name(0)}")
PYCODE

# ---------------------------------------------------------------- 3b. SageAttention (in the background)
# SageAttention 2 is built from source for this GPU the first time (about 10 minutes) and the wheel is cached in
# $WHEEL_DIR. Without a CUDA compiler, or if the build fails, SageAttention 1 (Triton kernels, no compiler) is used instead.
# It runs in the background while the models download (it needs CPU, they need the network); setup waits for it before
# starting ComfyUI, which only gets --use-sage-attention when a real attention call on the GPU works.
SAGE_FLAG=""
SAGE_PID=""
SAGE_LOG="$LOG_DIR/sageattention.log"
sage_works() {
  "$PY" - >/dev/null 2>&1 <<'PYCODE'
import torch
from sageattention import sageattn
q = torch.randn(1, 8, 256, 64, device="cuda", dtype=torch.float16)
sageattn(q, q, q, tensor_layout="HND")
torch.cuda.synchronize()
PYCODE
}
sage_version() { "$PY" -c 'import importlib.metadata as m; print(m.version("sageattention"))' 2>/dev/null || echo "?"; }

install_sage() {
  if sage_works; then
    echo "  sageattention $(sage_version) is installed and works"
    return 0
  fi
  local cap torch_tag python_tag cache wheel nvcc_bin
  cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ' || true)"
  torch_tag="$("$PY" -c 'import torch; print(torch.__version__.replace("+", "-"))')"
  python_tag="$("$PY" -c 'import sys; print(f"cp{sys.version_info.major}{sys.version_info.minor}")')"
  cache="$WHEEL_DIR/sageattention-$torch_tag-$python_tag-sm${cap/./}"
  wheel="$(ls "$cache"/sageattention-*.whl 2>/dev/null | head -1 || true)"
  if [[ -n "$wheel" ]]; then
    echo "  using the cached build $wheel"
  else
    nvcc_bin="$(command -v nvcc || ls /usr/local/cuda/bin/nvcc 2>/dev/null || true)"
    if [[ -n "$nvcc_bin" && -n "$cap" ]] && ! "$nvcc_bin" --version | grep -q "release ${TORCH_CUDA_VERSION},"; then
      # Fall through to the SageAttention 1 fallback below.
      warn "SageAttention 2 needs a CUDA $TORCH_CUDA_VERSION compiler matching PyTorch; change the RunPod container image"
    elif [[ -n "$nvcc_bin" && -n "$cap" ]]; then
      log "Building SageAttention 2 for sm_${cap/./} with $("$nvcc_bin" --version | tail -1) (first start only, about 10 minutes)"
      mkdir -p "$cache"
      "$PY" -m pip install --quiet ninja packaging setuptools wheel
      if env PATH="$(dirname "$nvcc_bin"):$PATH" CUDA_HOME="$(dirname "$(dirname "$nvcc_bin")")" \
           TORCH_CUDA_ARCH_LIST="$cap" MAX_JOBS="${MAX_JOBS:-$(( $(nproc) > 16 ? 16 : $(nproc) ))}" \
           "$PY" -m pip wheel --no-build-isolation --no-deps -w "$cache" "git+$SAGE_REPO@$SAGE_REF" \
           >"$LOG_DIR/sageattention-build.log" 2>&1; then
        wheel="$(ls "$cache"/sageattention-*.whl 2>/dev/null | head -1 || true)"
        log "SageAttention 2 built"
      else
        warn "SageAttention 2 build failed; the full output is in $LOG_DIR/sageattention-build.log"
      fi
    elif [[ -z "$cap" ]]; then
      warn "nvidia-smi found no GPU; SageAttention 2 can't be built here"
    else
      warn "No CUDA compiler (nvcc) in this image; SageAttention 2 can't be built here"
    fi
  fi
  if [[ -n "$wheel" ]]; then
    "$PY" -m pip install --quiet --force-reinstall --no-deps "$wheel" || warn "Installing $wheel failed"
  fi
  if ! sage_works; then
    warn "Using SageAttention 1 instead (slower than 2, still faster than the default)"
    "$PY" -m pip install --quiet "sageattention==1.0.6" || warn "SageAttention 1 could not be installed"
  fi
}

if [[ "$SAGE_ATTENTION" == 1 ]]; then
  log "SageAttention: preparing it in the background while the models download (progress: $SAGE_LOG)"
  # A failure inside must fall through to the SageAttention 1 fallback, not end setup, so the subshell drops the ERR trap.
  ( trap - ERR; set +e; install_sage ) >"$SAGE_LOG" 2>&1 &
  SAGE_PID=$!
fi

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

# ---------------------------------------------------------------- 4b. wait for SageAttention
if [[ -n "$SAGE_PID" ]]; then
  if kill -0 "$SAGE_PID" 2>/dev/null; then log "Waiting for the SageAttention build to finish (models are done)"; fi
  wait "$SAGE_PID" || true
  log "SageAttention"
  cat "$SAGE_LOG"
  if sage_works; then
    SAGE_FLAG="--use-sage-attention"
    echo "  sageattention $(sage_version): ComfyUI will start with --use-sage-attention"
  else
    warn "SageAttention does not work on this pod; ComfyUI starts with its default attention"
  fi
fi

# ---------------------------------------------------------------- 5. start
log "Setup finished"
if [[ -n "${RUNPOD_POD_ID:-}" ]]; then
  echo "  Martini Shot ComfyUI URL: https://${RUNPOD_POD_ID}-${COMFYUI_PORT}.proxy.runpod.net"
fi
if [[ "$SKIP_START" == 1 ]]; then exit 0; fi

trap - ERR
log "Starting ComfyUI on 0.0.0.0:$COMFYUI_PORT${SAGE_FLAG:+ with SageAttention}"
cd "$COMFY_DIR"
while true; do
  # shellcheck disable=SC2086
  "$PY" main.py --listen 0.0.0.0 --port "$COMFYUI_PORT" $SAGE_FLAG $COMFYUI_ARGS 2>&1 | tee -a "$LOG_DIR/comfyui.log" || true
  warn "ComfyUI exited; restarting in 5 seconds"
  sleep 5
done
