"""Pure helpers for Martini Shot per-clip post-processing (face treatment and SeedVR2 upscaling).

Nothing here imports ComfyUI, torch, or av, so the rules can be unit-tested with a plain Python interpreter
(see test_postprocess.py). The ComfyUI nodes live in postprocess_nodes.py.
"""
from __future__ import annotations

import json
import math
import os
import re
from fractions import Fraction
from pathlib import Path, PurePosixPath
from typing import Any

POSTPROCESS_API_VERSION = 1
# Bumped whenever the processing graph or the save/validation rules change in a way that changes output pixels.
NODE_CONTRACT_VERSION = "pp-nodes-1"
VRAM_MODE_ENV = "POST_PROCESSING_VRAM_MODE"
VRAM_MODES = ("low_vram", "high_vram")
DEFAULT_VRAM_MODE = "high_vram"
FACE_MODES = ("preserve", "restore", "replace")


class PostProcessConfigError(ValueError):
    """A worker or job configuration that must stop processing with a readable message."""


def worker_vram_mode(environ: dict[str, str] | None = None) -> dict[str, Any]:
    """The worker default from POST_PROCESSING_VRAM_MODE.

    Unset (or blank) means high_vram. Anything other than low_vram/high_vram is a configuration error: it is reported,
    never silently replaced, because a wrong preset can exhaust memory on the pod.
    """
    env = os.environ if environ is None else environ
    raw = env.get(VRAM_MODE_ENV)
    if raw is None or not raw.strip():
        return {"value": DEFAULT_VRAM_MODE, "source": "default", "raw": raw, "error": None}
    value = raw.strip().lower()
    if value not in VRAM_MODES:
        return {"value": None, "source": "env", "raw": raw,
                "error": f"{VRAM_MODE_ENV}={raw!r} is not valid. Use low_vram or high_vram (or leave it unset for high_vram)."}
    return {"value": value, "source": "env", "raw": raw, "error": None}


def resolve_job_mode(requested: str, environ: dict[str, str] | None = None) -> dict[str, Any]:
    """The mode a job runs with: an explicit low_vram/high_vram job setting overrides the worker default."""
    if requested in VRAM_MODES:
        return {"mode": requested, "source": "job"}
    if requested != "worker_default":
        raise PostProcessConfigError(f"Unknown post-processing VRAM mode {requested!r}; expected worker_default, low_vram or high_vram.")
    worker = worker_vram_mode(environ)
    if worker["error"]:
        raise PostProcessConfigError(worker["error"])
    return {"mode": worker["value"], "source": "worker_" + worker["source"]}


def check_job_mode(job: dict[str, Any], environ: dict[str, str] | None = None) -> dict[str, Any]:
    """The app resolves the mode before it builds the graph (it needs the preset values). Refuse to run when the worker
    would now resolve it differently, e.g. POST_PROCESSING_VRAM_MODE changed after the app last asked."""
    requested = str(job.get("requested_vram_mode") or "")
    resolved = resolve_job_mode(requested, environ)
    if job.get("resolved_vram_mode") != resolved["mode"]:
        raise PostProcessConfigError(
            f"This job was prepared for {job.get('resolved_vram_mode')}, but the worker now resolves {requested} to {resolved['mode']} "
            f"({VRAM_MODE_ENV} changed?). Refresh Post-processing in Martini Shot and process the clip again.")
    return resolved


# ----- Memory bound -------------------------------------------------------------------------------------------

def output_size(width: int, height: int, shortest_edge: int) -> tuple[int, int]:
    """SeedVR2's `resolution` is the target shortest edge with the aspect ratio kept; dimensions end up even."""
    if width <= 0 or height <= 0:
        raise ValueError("Source has no frame size.")
    scale = shortest_edge / min(width, height)
    return max(2, 2 * round(width * scale / 2)), max(2, 2 * round(height * scale / 2))


def estimate_peak_bytes(frames: int, width: int, height: int, face_stage: bool, upscale_edge: int | None) -> dict[str, int]:
    """A deliberately pessimistic estimate of decoded-frame host memory for one clip (model weights excluded).

    float32 source batch, plus (face stage) ReActor's uint8 PIL/BGR copies and its float output, plus (upscale) SeedVR2's
    float output and one more output-sized buffer for color correction / offloaded intermediates."""
    pixels = frames * width * height * 3
    source = pixels * 4
    face = pixels * (4 + 3 + 3) if face_stage else 0
    upscaled = 0
    if upscale_edge:
        out_w, out_h = output_size(width, height, upscale_edge)
        upscaled = frames * out_w * out_h * 3 * 4 * 2
    return {"source": source, "face": face, "upscale": upscaled, "total": source + face + upscaled}


def check_memory_budget(frames: int, width: int, height: int, face_stage: bool, upscale_edge: int | None, budget_gb: float) -> dict[str, int]:
    estimate = estimate_peak_bytes(frames, width, height, face_stage, upscale_edge)
    budget = int(budget_gb * 1024 ** 3)
    if budget > 0 and estimate["total"] > budget:
        raise PostProcessConfigError(
            f"Decoded frames for this clip would need about {estimate['total'] / 1024 ** 3:.1f} GB of RAM "
            f"({frames} frames at {width}x{height}{f', upscaled to a {upscale_edge}px shortest edge' if upscale_edge else ''}), "
            f"over the {budget_gb:g} GB post-processing frame budget. Use a smaller output size, or High VRAM mode on a worker with more RAM. "
            "Nothing was processed.")
    return estimate


# ----- Media facts and timing ---------------------------------------------------------------------------------

def fps_fraction(value: Any) -> Fraction:
    if isinstance(value, Fraction):
        return value
    if isinstance(value, str) and "/" in value:
        num, den = value.split("/", 1)
        return Fraction(int(num), int(den))
    return Fraction(value).limit_denominator(100000)


def fps_text(value: Fraction) -> str:
    return f"{value.numerator}/{value.denominator}"


def timing_problems(source: dict[str, Any], output: dict[str, Any], tolerance: float = 0.01) -> list[str]:
    """Why an output does not preserve the source's timing and shape. Empty when it does."""
    problems: list[str] = []
    if int(output["frames"]) != int(source["frames"]):
        problems.append(f"frame count changed: {source['frames']} → {output['frames']}")
    if fps_fraction(output["fps"]) != fps_fraction(source["fps"]):
        problems.append(f"frame rate changed: {source['fps']} → {output['fps']}")
    source_aspect = source["width"] / source["height"]
    output_aspect = output["width"] / output["height"]
    if abs(output_aspect - source_aspect) / source_aspect > tolerance:
        problems.append(f"aspect ratio changed: {source['width']}x{source['height']} → {output['width']}x{output['height']}")
    return problems


# ----- Paths --------------------------------------------------------------------------------------------------

def resolve_inside(output_dir: str | Path, value: str) -> Path:
    """An absolute path, or one relative to ComfyUI's output folder, that must stay inside output/martini_shot."""
    root = (Path(output_dir).resolve() / "martini_shot")
    text = value.strip().strip('"')
    if not text or "\x00" in text:
        raise PostProcessConfigError("Empty or invalid file path.")
    candidate = Path(text)
    if not candidate.is_absolute():
        parts = PurePosixPath(text.replace("\\", "/")).parts
        if any(part in ("..", "") for part in parts):
            raise PostProcessConfigError(f"Unsafe relative path {value!r}.")
        candidate = Path(output_dir) / Path(*parts)
    resolved = candidate.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise PostProcessConfigError(f"{value} is not inside ComfyUI's output/martini_shot folder.") from error
    return resolved


def check_output_target(path: Path) -> None:
    """Processed artifacts live only in a postprocess/ folder, never next to (or over) a raw render."""
    if "postprocess" not in [part.lower() for part in path.parts[:-1]]:
        raise PostProcessConfigError(f"Refusing to write {path}: processed clips must be saved inside a postprocess folder.")
    if path.suffix.lower() != ".mp4":
        raise PostProcessConfigError(f"Refusing to write {path}: processed clips are MP4 files.")
    if path.exists():
        raise PostProcessConfigError(f"Refusing to overwrite {path}; every attempt gets its own file.")


# ----- ffmpeg -------------------------------------------------------------------------------------------------

def encode_command(ffmpeg: str, width: int, height: int, fps: Fraction, source: Path, target: Path, crf: int = 16) -> list[str]:
    """Raw RGB frames on stdin → H.264 MP4 at exactly the source frame rate, with the source clip's audio copied when it
    has any (so mouth movement can be judged against the sound). No frame-rate conversion, no -shortest."""
    return [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}", "-framerate", fps_text(fps), "-i", "-",
        "-i", str(source),
        "-map", "0:v:0", "-map", "1:a:0?",
        "-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p",
        "-fps_mode", "passthrough", "-c:a", "copy", "-movflags", "+faststart", str(target),
    ]


def normalization_plan(probes: list[dict[str, Any]], tolerance: float = 0.01) -> dict[str, Any]:
    """How the final stitch can join these clips.

    Identical size/codec/pixel format → concat without re-encoding (the original Finalize Video behavior). Otherwise every
    clip is re-encoded to the largest clip's size so the concat stream is uniform. A different frame rate or aspect ratio
    is an error: re-timing or cropping would break music synchronization or framing."""
    if not probes:
        raise PostProcessConfigError("No clips to stitch.")
    first = probes[0]
    rates = {fps_fraction(probe["fps"]) for probe in probes}
    if len(rates) > 1:
        raise PostProcessConfigError("The selected clips have different frame rates (" + ", ".join(sorted(fps_text(r) for r in rates)) +
                                     "). Martini Shot will not re-time clips; re-process or bypass the odd ones.")
    aspect = first["width"] / first["height"]
    odd = [probe["name"] for probe in probes if abs(probe["width"] / probe["height"] - aspect) / aspect > tolerance]
    if odd:
        raise PostProcessConfigError(f"These clips have a different aspect ratio from {first['name']}: {', '.join(odd[:10])}.")
    uniform = all((p["width"], p["height"], p["codec"], p.get("pix_fmt")) == (first["width"], first["height"], first["codec"], first.get("pix_fmt")) for p in probes)
    if uniform:
        return {"reencode": False, "width": first["width"], "height": first["height"]}
    largest = max(probes, key=lambda probe: probe["width"] * probe["height"])
    width, height = 2 * math.ceil(largest["width"] / 2), 2 * math.ceil(largest["height"] / 2)
    return {"reencode": True, "width": width, "height": height}


def normalize_command(ffmpeg: str, source: Path, target: Path, width: int, height: int, crf: int = 16) -> list[str]:
    return [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(source), "-map", "0:v:0", "-an",
        "-vf", f"scale={width}:{height}:flags=lanczos,setsar=1", "-fps_mode", "passthrough",
        "-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p", str(target),
    ]


def parse_selection(text: str, segment_indexes: list[int]) -> dict[int, str]:
    """The app's clip selection: one package-relative MP4 per planned segment, in order, nothing missing or extra."""
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        raise PostProcessConfigError(f"clip_selection is not JSON: {error}") from error
    if not isinstance(value, list):
        raise PostProcessConfigError("clip_selection must be a list of {index, path} entries.")
    chosen: dict[int, str] = {}
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("index"), int) or not isinstance(item.get("path"), str):
            raise PostProcessConfigError("Every clip_selection entry needs an integer index and a path.")
        path = item["path"].replace("\\", "/")
        if path.startswith("/") or re.match(r"^[a-zA-Z]:", path) or any(part in ("", ".", "..") for part in path.split("/")):
            raise PostProcessConfigError(f"Clip {item['index']}: unsafe path {item['path']!r}; paths are relative to the package folder.")
        if not path.lower().endswith(".mp4"):
            raise PostProcessConfigError(f"Clip {item['index']}: {path} is not an MP4.")
        if item["index"] in chosen:
            raise PostProcessConfigError(f"Clip {item['index']} is listed twice.")
        chosen[item["index"]] = path
    missing = [index for index in segment_indexes if index not in chosen]
    extra = [index for index in chosen if index not in segment_indexes]
    if missing or extra:
        raise PostProcessConfigError(
            "clip_selection does not match segments.json" + (f"; missing clips {missing[:20]}" if missing else "") + (f"; unknown clips {extra[:20]}" if extra else "") + ".")
    return chosen


# ----- Face report --------------------------------------------------------------------------------------------

def summarize_face_frames(frames: list[dict[str, Any]], face_mode: str, small_face_px: int = 48) -> dict[str, Any]:
    """Turns per-frame observations into the report the app shows.

    Each frame dict: faces (int, -1 = detector unavailable), changed (bool), hand_overlap (bool|None), face_height (px|None).
    ReActor picks a face per frame by size/position order; it does not track identity, so frames with several faces are an
    identity-switch risk. A frame with a face that came out unchanged is a dropout: in Replace mode it means the original
    identity flashes between swapped frames."""
    total = len(frames)
    detector = all(frame["faces"] >= 0 for frame in frames) if frames else False

    def ranges(indexes: list[int]) -> list[list[int]]:
        out: list[list[int]] = []
        for index in indexes:
            if out and index == out[-1][1] + 1:
                out[-1][1] = index
            else:
                out.append([index, index])
        return out

    with_face = [i for i, f in enumerate(frames) if f["faces"] > 0]
    no_face = [i for i, f in enumerate(frames) if f["faces"] == 0]
    dropouts = [i for i, f in enumerate(frames) if (f["faces"] > 0 or not detector) and not f["changed"]]
    multi = [i for i, f in enumerate(frames) if f["faces"] > 1]
    hands = [i for i, f in enumerate(frames) if f.get("hand_overlap")]
    small = [i for i, f in enumerate(frames) if f.get("face_height") is not None and f["face_height"] < small_face_px]
    changed = [i for i, f in enumerate(frames) if f["changed"]]
    warnings: list[str] = []
    review = False
    if face_mode in ("replace", "restore") and detector and not with_face:
        warnings.append("No face was detected in any frame; face processing changed nothing.")
    if face_mode == "replace" and with_face and not changed:
        warnings.append("No frame was swapped although faces were detected. Check that the reference image shows one clear, frontal face.")
        review = True
    elif dropouts and changed:
        warnings.append(f"{len(dropouts)} of {total} frames came out unchanged although a face is there (detection dropouts). "
                        + ("The original identity would flash between swapped frames." if face_mode == "replace" else "Restoration flickers on and off."))
        review = review or face_mode == "replace"
    if multi:
        warnings.append(f"{len(multi)} frames show more than one face. ReActor chooses a face per frame by order, without tracking, "
                        "so the swapped identity can jump between people.")
        review = review or face_mode == "replace"
    if hands:
        warnings.append(f"{len(hands)} frames have a hand overlapping the face. ReActor pastes a whole face region and does not "
                        "segment occluders, so check those frames for a face drawn over fingers or a microphone.")
        review = review or face_mode == "replace"
    if small:
        warnings.append(f"{len(small)} frames have a face under {small_face_px}px tall; swaps and restoration are unreliable at that size.")
    if not detector:
        warnings.append("The face detector was unavailable, so only whole-frame changes were measured.")
    return {
        "face_mode": face_mode, "frames": total, "detector": detector,
        "frames_with_face": len(with_face), "frames_without_face": len(no_face), "frames_changed": len(changed),
        "dropout_frames": ranges(dropouts), "multi_face_frames": ranges(multi), "hand_overlap_frames": ranges(hands),
        "small_face_frames": ranges(small), "warnings": warnings, "review_required": review,
    }
