"""ComfyUI nodes for Martini Shot per-clip post-processing and the selected-clip final stitch.

Graph (built by the app from workflows/07-postprocess-clip.json):
  MartiniShotPostProcessLoad  -> [ReActorRestoreFace | ReActorFaceSwapOpt] -> MartiniShotFaceReport -> [ReActorUnload]
                              -> [MartiniShotDLSS5] -> [SeedVR2VideoUpscaler] -> MartiniShotSavePostProcessed
The original render is only ever read. Output goes to <package>/postprocess/..., one new file per attempt.
"""
from __future__ import annotations

import gc
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

from .postprocess_core import (
    NODE_CONTRACT_VERSION, POSTPROCESS_API_VERSION, PostProcessConfigError, check_job_mode, check_memory_budget, check_output_target,
    INTERPOLATION_FRAME_TOLERANCE, encode_command, fps_fraction, fps_text, interpolated_frames, normalization_plan, normalize_command, parse_selection, resolve_inside,
    summarize_face_frames, timing_problems, worker_vram_mode,
)
from .ref2va_nodes import CATEGORY

PP_CATEGORY = CATEGORY + "/Post-processing"
CHANGE_THRESHOLD = 1.5 / 255.0  # mean absolute change inside the face box that counts as "processed"

# Models each memory preset loads (the app's presets, src: electron/postprocess-rules.ts). Reported by /martini/postprocess/info.
MODE_MODELS = {
    "low_vram": ["SEEDVR2/seedvr2_ema_3b_fp8_e4m3fn.safetensors", "SEEDVR2/ema_vae_fp16.safetensors"],
    "high_vram": ["SEEDVR2/seedvr2_ema_7b_fp16.safetensors", "SEEDVR2/ema_vae_fp16.safetensors"],
}
FACE_MODELS = ["insightface/inswapper_128.onnx", "insightface/models/buffalo_l/det_10g.onnx", "facerestore_models/codeformer-v0.1.0.pth",
               "facedetection/detection_Resnet50_Final.pth", "facedetection/parsing_parsenet.pth"]
OPTIONAL_MODELS = ["ultralytics/bbox/hand_yolov8s.pt"]


def _output_dir() -> str:
    import folder_paths
    return folder_paths.get_output_directory()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _probe(path: Path) -> dict[str, Any]:
    """Exact facts of an MP4: frames are counted by decoding when the container does not state them."""
    import av
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        frames = int(stream.frames or 0)
        rate = stream.average_rate or stream.guessed_rate
        info = {"name": path.name, "width": stream.codec_context.width, "height": stream.codec_context.height,
                "codec": stream.codec_context.name, "pix_fmt": stream.codec_context.pix_fmt,
                "fps": fps_text(Fraction(rate)) if rate else None, "audio": bool(container.streams.audio)}
    if frames <= 0:
        with av.open(str(path)) as container:
            frames = sum(1 for _ in container.decode(video=0))
    info["frames"] = frames
    if not info["fps"]:
        raise PostProcessConfigError(f"{path.name} has no frame rate.")
    info["duration"] = float(Fraction(frames) / fps_fraction(info["fps"]))
    return info


def _unload_models() -> None:
    """Unload generation models (MiniMax, the director LLM, …) before enhancement; one GPU, one stage at a time."""
    try:
        import comfy.model_management as mm
        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception:
        pass
    gc.collect()


def _job(job_json: str) -> dict[str, Any]:
    try:
        job = json.loads(job_json)
    except json.JSONDecodeError as error:
        raise PostProcessConfigError(f"job_json is not valid JSON: {error}") from error
    if not isinstance(job, dict):
        raise PostProcessConfigError("job_json must be an object.")
    return job


class MartiniShotPostProcessLoad:
    """Decodes one rendered clip (read-only) into a single bounded frame batch, after unloading other models."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "source_video": ("STRING", {"default": "", "tooltip": "The raw render: an absolute path or one relative to ComfyUI's output folder."}),
            "reference_image": ("STRING", {"default": "", "tooltip": "Identity reference for Replace; empty otherwise."}),
            "job_json": ("STRING", {"default": "{}", "multiline": True}),
            "frame_ram_budget_gb": ("FLOAT", {"default": 24.0, "min": 0.0, "max": 1024.0, "step": 1.0}),
            "unload_models": ("BOOLEAN", {"default": True}),
        }}

    RETURN_TYPES = ("IMAGE", "IMAGE", "STRING")
    RETURN_NAMES = ("frames", "reference", "source_info")
    FUNCTION = "load"
    CATEGORY = PP_CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def load(self, source_video, reference_image, job_json, frame_ram_budget_gb, unload_models):
        import av
        import numpy as np
        import torch

        job = _job(job_json)
        mode = check_job_mode(job)
        source = resolve_inside(_output_dir(), source_video)
        if not source.is_file():
            raise FileNotFoundError(f"The rendered clip {source} is not on this worker.")
        source_hash = _sha256(source)
        if job.get("source_sha256") and job["source_sha256"] != source_hash:
            raise PostProcessConfigError(f"{source.name} on this worker does not match the clip Martini Shot hashed (sha256 differs). Nothing was processed.")
        info = _probe(source)
        face_stage = job.get("face_mode") in ("restore", "replace")
        upscale = int(job["upscale"]["resolution"]) if job.get("upscale") else None
        dlss5 = job.get("dlss5") or None
        ratio = float(fps_fraction(dlss5["target_fps"]) / fps_fraction(info["fps"])) if dlss5 and dlss5.get("target_fps") else 1.0
        estimate = check_memory_budget(info["frames"], info["width"], info["height"], face_stage, upscale, frame_ram_budget_gb,
                                       bool(dlss5), float(dlss5.get("scale", 1.0)) if dlss5 else 1.0, ratio)
        if unload_models:
            _unload_models()

        frames = torch.empty((info["frames"], info["height"], info["width"], 3), dtype=torch.float32)
        count = 0
        with av.open(str(source)) as container:
            for frame in container.decode(video=0):
                if count >= info["frames"]:
                    raise PostProcessConfigError(f"{source.name} decoded more frames than it states ({info['frames']}).")
                frames[count] = torch.from_numpy(frame.to_ndarray(format="rgb24")).float().div_(255.0)
                count += 1
        if count != info["frames"]:
            raise PostProcessConfigError(f"{source.name} decoded {count} frames, not {info['frames']}.")

        reference = torch.zeros((1, 64, 64, 3), dtype=torch.float32)
        reference_hash = None
        if reference_image.strip():
            from PIL import Image
            ref_path = resolve_inside(_output_dir(), reference_image)
            if not ref_path.is_file():
                raise FileNotFoundError(f"The reference image {ref_path} is not on this worker.")
            reference_hash = _sha256(ref_path)
            if job.get("reference_sha256") and job["reference_sha256"] != reference_hash:
                raise PostProcessConfigError(f"{ref_path.name} on this worker does not match the reference Martini Shot hashed. Nothing was processed.")
            pixels = np.asarray(Image.open(ref_path).convert("RGB"), dtype=np.float32) / 255.0
            reference = torch.from_numpy(pixels)[None]
        elif job.get("face_mode") == "replace":
            raise PostProcessConfigError("Replace needs a character reference image.")

        source_info = {**info, "path": str(source), "sha256": source_hash, "reference_sha256": reference_hash,
                       "resolved_vram_mode": mode["mode"], "mode_source": mode["source"], "ram_estimate": estimate}
        return (frames, reference, json.dumps(source_info))


class MartiniShotFaceReport:
    """Measures what face processing did, frame by frame, and passes the processed frames through unchanged.

    Faces come from ReActor's own detector (reactor_core, buffalo_l det_10g) when ReActor is loaded; hands from an
    Ultralytics hand_yolov8s box model when installed. Neither is a tracker."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"original": ("IMAGE",), "processed": ("IMAGE",), "job_json": ("STRING", {"default": "{}", "multiline": True})}}

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("processed", "face_report")
    FUNCTION = "report"
    CATEGORY = PP_CATEGORY

    @staticmethod
    def _face_detector():
        try:
            import folder_paths
            import onnxruntime
            from reactor_core.analyzer import ReActorFaceAnalysis  # provided by the ReActor node pack
            providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in onnxruntime.get_available_providers()]
            analyser = ReActorFaceAnalysis(name="buffalo_l", root=os.path.join(folder_paths.models_dir, "insightface"), providers=providers)
            analyser.prepare(ctx_id=0, det_size=(640, 640))
            return analyser
        except Exception as error:  # reported as "detector unavailable"
            print(f"[Martini Shot] face report: face detector unavailable ({error})", file=sys.stderr)
            return None

    @staticmethod
    def _hand_detector():
        try:
            import folder_paths
            from ultralytics import YOLO
            path = os.path.join(folder_paths.models_dir, "ultralytics", "bbox", "hand_yolov8s.pt")
            return YOLO(path) if os.path.isfile(path) else None
        except Exception as error:
            print(f"[Martini Shot] face report: hand detector unavailable ({error})", file=sys.stderr)
            return None

    def report(self, original, processed, job_json):
        import numpy as np
        import torch

        job = _job(job_json)
        if original.shape != processed.shape:
            raise PostProcessConfigError(f"Face processing changed the frame batch from {tuple(original.shape)} to {tuple(processed.shape)}.")
        faces_model = self._face_detector()
        hands_model = self._hand_detector()
        frames: list[dict[str, Any]] = []
        try:
            for index in range(original.shape[0]):
                before = original[index]
                after = processed[index].to(before.device)
                boxes: list[list[float]] = []
                count = -1
                if faces_model is not None:
                    bgr = (before.cpu().numpy()[:, :, ::-1] * 255).astype(np.uint8)
                    detected = faces_model.get(bgr) or []
                    if not detected:  # ReActor retries at half detection size before giving up; measure the same way
                        faces_model.prepare(ctx_id=0, det_size=(320, 320))
                        detected = faces_model.get(bgr) or []
                        faces_model.prepare(ctx_id=0, det_size=(640, 640))
                    boxes = [list(map(float, face.bbox)) for face in detected]
                    count = len(boxes)
                if boxes:
                    x1, y1, x2, y2 = max(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
                    h, w = before.shape[0], before.shape[1]
                    xa, ya, xb, yb = max(0, int(x1)), max(0, int(y1)), min(w, int(x2) + 1), min(h, int(y2) + 1)
                    region = (after[ya:yb, xa:xb] - before[ya:yb, xa:xb]).abs().mean().item() if xb > xa and yb > ya else 0.0
                    face_height = y2 - y1
                else:
                    region = (after - before).abs().mean().item()
                    face_height = None
                hand = None
                if hands_model is not None and boxes:
                    rgb = (before.cpu().numpy() * 255).astype(np.uint8)
                    result = hands_model.predict(rgb[:, :, ::-1], verbose=False, conf=0.35)[0]
                    hand_boxes = result.boxes.xyxy.cpu().numpy().tolist() if result.boxes is not None else []
                    hand = any(not (hb[2] < fb[0] or hb[0] > fb[2] or hb[3] < fb[1] or hb[1] > fb[3]) for hb in hand_boxes for fb in boxes)
                frames.append({"faces": count, "changed": region > CHANGE_THRESHOLD, "hand_overlap": hand, "face_height": face_height, "change": round(region, 5)})
        finally:
            del faces_model, hands_model
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        summary = summarize_face_frames(frames, str(job.get("face_mode")))
        summary["hand_detector"] = any(frame["hand_overlap"] is not None for frame in frames)
        summary["per_frame_change"] = [frame["change"] for frame in frames]
        return (processed, json.dumps(summary))


class MartiniShotSavePostProcessed:
    """Encodes the processed frames to a new MP4 in a postprocess folder, then proves timing and shape were kept."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",), "source_info": ("STRING", {"forceInput": True}),
            "output_path": ("STRING", {"default": ""}), "job_json": ("STRING", {"default": "{}", "multiline": True}),
            "crf": ("INT", {"default": 16, "min": 0, "max": 40}),
        }, "optional": {"face_report": ("STRING", {"forceInput": True})}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("output_path", "metadata")
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = PP_CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def save(self, images, source_info, output_path, job_json, crf, face_report=None):
        import imageio_ffmpeg
        import numpy as np
        import torch

        started = time.time()
        job = _job(job_json)
        source = json.loads(source_info)
        target = resolve_inside(_output_dir(), output_path)
        check_output_target(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.stem + ".partial.mp4")
        frames, height, width = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
        # DLSS 5 interpolation is the one stage allowed to change the frame rate (same duration, more frames)
        target_fps = (job.get("dlss5") or {}).get("target_fps") or None
        if target_fps:
            expected = interpolated_frames(int(source["frames"]), source["fps"], target_fps)
            if abs(frames - expected) > INTERPOLATION_FRAME_TOLERANCE:
                raise PostProcessConfigError(f"DLSS 5 interpolation returned {frames} frames; {source['frames']} frames at {source['fps']} fps make {expected} at {target_fps} fps. Refusing to save a re-timed clip.")
        elif frames != int(source["frames"]):
            raise PostProcessConfigError(f"Processing returned {frames} frames for a {source['frames']}-frame clip; refusing to save a re-timed clip.")
        pad_w, pad_h = width % 2, height % 2  # yuv420p needs even dimensions; pad one edge pixel rather than rescale
        output_fps = fps_fraction(target_fps) if target_fps else fps_fraction(source["fps"])
        command = encode_command(imageio_ffmpeg.get_ffmpeg_exe(), width + pad_w, height + pad_h, output_fps, Path(source["path"]), partial, crf)
        channels = int(images.shape[3]) if images.dim() == 4 else 0
        if images.dim() != 4 or channels not in (3, 4):
            raise PostProcessConfigError(f"Processing returned frames of shape {tuple(images.shape)}; expected [frames, height, width, 3].")
        log = partial.with_name(target.stem + ".ffmpeg.log")
        written = 0
        with open(log, "wb") as stderr:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=stderr)
            try:
                for index in range(frames):  # one frame at a time: never a second full-clip uint8 copy
                    frame = images[index][..., :3]  # an RGBA batch keeps its color; alpha is dropped
                    pixels = np.ascontiguousarray(frame.float().clamp(0, 1).mul(255).round().to(dtype=torch.uint8).cpu().numpy())
                    if pad_w or pad_h:
                        pixels = np.pad(pixels, ((0, pad_h), (0, pad_w), (0, 0)), mode="edge")
                    process.stdin.write(pixels.tobytes())
                    written += 1
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass  # ffmpeg exited early; its exit code and log say why
            code = process.wait()
        error = log.read_text(encoding="utf-8", errors="replace")
        log.unlink(missing_ok=True)
        if code != 0 or written != frames:
            partial.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg failed while encoding the processed clip (exit {code}, {written} of {frames} frames written, "
                               f"frames {tuple(images.shape)} {images.dtype} on {images.device}):\n" + (error[-2000:] or "ffmpeg printed nothing."))
        try:
            output = _probe(partial)
            problems = timing_problems(source, output, target_fps=target_fps)
            if problems:
                raise PostProcessConfigError("The processed clip does not keep the source timing: " + "; ".join(problems) + ". It was not saved.")
            os.replace(partial, target)
        except BaseException:
            try:
                process.kill()
            except Exception:
                pass
            partial.unlink(missing_ok=True)
            raise
        output = {**_probe(target), "padded": bool(pad_w or pad_h)}
        metadata = {
            "contract": NODE_CONTRACT_VERSION, "attempt_id": job.get("attempt_id"), "cache_key": job.get("cache_key"),
            "source": source, "output": {**output, "path": str(target), "sha256": _sha256(target), "size": target.stat().st_size},
            "face_report": json.loads(face_report) if face_report else None, "job": job,
            "environment": environment_info(), "save_seconds": round(time.time() - started, 2),
        }
        if metadata["face_report"]:
            metadata["face_report"].pop("per_frame_change", None)
        sidecar = target.with_suffix(".json")
        sidecar.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        text = json.dumps(metadata)
        return {"ui": {"text": [f"Saved {target.name}: {output['width']}x{output['height']}, {output['frames']} frames at {output['fps']} fps"]},
                "result": (str(target), text)}


class MartiniShotFinalizeSelectedVideo:
    """Final stitch from the app's per-clip selection (original render or a processed artifact per clip).

    Uniform clips are joined without re-encoding, as Martini Shot Finalize Video does. Mixed sizes are all re-encoded to
    the largest size first; frame counts are checked, frame rates must match, and the song is laid underneath unchanged."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"render_package": ("MARTINI_RENDER_PACKAGE",), "clip_selection": ("STRING", {"default": "[]", "multiline": True}),
                             "output_name": ("STRING", {"default": "final"}), "overwrite": ("BOOLEAN", {"default": False})}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("video_path", "report")
    FUNCTION = "stitch"
    OUTPUT_NODE = True
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def stitch(self, render_package, clip_selection, output_name, overwrite):
        import imageio_ffmpeg
        import soundfile
        from .video_nodes import load_manifest, load_song, resolve_folder

        folder = resolve_folder(render_package["folder"])
        manifest = load_manifest(folder)
        segments = manifest["segments"]
        chosen = parse_selection(clip_selection, [int(segment["index"]) for segment in segments])
        root = folder.resolve()
        clips: list[Path] = []
        for segment in segments:
            path = (folder / chosen[int(segment["index"])]).resolve()
            try:
                path.relative_to(root)
            except ValueError as error:
                raise PostProcessConfigError(f"Clip {segment['index']}: {path} is outside the package folder.") from error
            if not path.is_file():
                raise FileNotFoundError(f"Clip {segment['index']}: {path} is missing.")
            clips.append(path)
        probes = [_probe(path) for path in clips]
        new_frames = [segment.get("new_frames") for segment in segments]
        plan = normalization_plan(probes, base_fps=manifest.get("fps"),
                                  new_frames=new_frames if all(isinstance(n, int) and n > 0 for n in new_frames) else None)
        fitted = plan.get("frames")  # a retimed stitch: each clip's exact frame count at the interpolated rate
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        work = folder / ".stitch_normalized"
        inputs = clips
        if plan["reencode"]:
            work.mkdir(exist_ok=True)
            inputs = []
            for number, (path, probe) in enumerate(zip(clips, probes), start=1):
                target = work / f"{number:03d}.mp4"
                want = fitted[number - 1] if fitted else probe["frames"]
                command = normalize_command(ffmpeg, path, target, plan["width"], plan["height"], fps=plan.get("fps"), frames=want if fitted else None)
                result = subprocess.run(command, capture_output=True, text=True)
                if result.returncode != 0:
                    raise RuntimeError(f"ffmpeg could not normalize {path.name}:\n{result.stderr[-2000:]}")
                if _probe(target)["frames"] != want:
                    raise PostProcessConfigError(f"Normalizing {path.name} gave {_probe(target)['frames']} frames instead of {want}; nothing was stitched.")
                inputs.append(target)

        stem = output_name.strip() or "final"
        target = folder / f"{stem}.mp4"
        counter = 2
        while target.exists() and not overwrite:
            target = folder / f"{stem}_{counter}.mp4"
            counter += 1
        audio = load_song(folder, manifest, None)
        list_file = folder / ".stitch_list.txt"
        song_file = folder / ".stitch_song.wav"
        list_file.write_text("".join("file '" + p.resolve().as_posix().replace("'", "'\\''") + "'\n" for p in inputs), encoding="utf-8")
        soundfile.write(str(song_file), audio["waveform"][0].float().cpu().numpy().T, int(audio["sample_rate"]))
        command = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(list_file), "-i", str(song_file),
                   "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-shortest", "-movflags", "+faststart", str(target)]
        try:
            result = subprocess.run(command, capture_output=True, text=True)
        finally:
            list_file.unlink(missing_ok=True)
            song_file.unlink(missing_ok=True)
            if work.exists():
                for leftover in work.glob("*.mp4"):
                    leftover.unlink(missing_ok=True)
                try:
                    work.rmdir()
                except OSError:
                    pass
        if result.returncode != 0:
            raise RuntimeError("ffmpeg failed:\n" + result.stderr[-2000:])
        final = _probe(target)
        expected = sum(fitted) if fitted else sum(probe["frames"] for probe in probes)
        if final["frames"] != expected:
            raise PostProcessConfigError(f"The stitched video has {final['frames']} frames; the selected clips have {expected}. {target} is kept for inspection.")
        processed = [int(segment["index"]) for segment in segments if "postprocess/" in chosen[int(segment["index"])].lower()]
        report = "\n".join([
            f"Stitched {len(clips)} segments into {target}",
            f"{final['width']}x{final['height']} {final['codec']} at {float(fps_fraction(final['fps'])):.2f} fps, original song audio",
            f"Frames: {final['frames']} (sum of the selected clips).",
            f"Post-processed clips used: {', '.join(map(str, processed)) if processed else 'none'}.",
        ] + ([f"Normalized every clip to {plan['width']}x{plan['height']} (H.264 CRF 16) because the selected clips differ in size, codec, or frame rate."] if plan["reencode"] else [])
          + ([f"Frame rate: {plan['fps']} fps from DLSS 5 interpolation; each clip fitted to its exact place in the song. "
              + (f"Clips at the render rate repeat frames to match: {', '.join(plan['repeated'][:20])}." if plan["repeated"] else "Every clip was interpolated.")]
             if fitted else []))
        return {"ui": {"text": [report]}, "result": (str(target), report)}


# ----- Worker environment (also served at GET /martini/postprocess/info) --------------------------------------

_ENVIRONMENT: dict[str, Any] | None = None


def _pack_dir(name: str) -> Path | None:
    try:
        import folder_paths
        for base in folder_paths.get_folder_paths("custom_nodes"):
            candidate = Path(base) / name
            if candidate.is_dir():
                return candidate
    except Exception:
        pass
    return None


def _read_version(path: Path | None, pattern: str) -> str | None:
    try:
        match = re.search(pattern, path.read_text(encoding="utf-8")) if path and path.is_file() else None
        return match.group(1) if match else None
    except OSError:
        return None


def _ort_status() -> dict[str, Any]:
    status: dict[str, Any] = {"version": None, "cuda_build": None, "available": [], "session_providers": None, "error": None}
    try:
        import folder_paths
        import onnxruntime as ort
        status["version"] = ort.__version__
        status["available"] = ort.get_available_providers()
        try:
            from onnxruntime.capi import version_info
            status["cuda_build"] = getattr(version_info, "cuda_version", None)
        except Exception:
            pass
        model = Path(folder_paths.models_dir) / "insightface" / "models" / "buffalo_l" / "det_10g.onnx"
        if model.is_file() and "CUDAExecutionProvider" in status["available"]:
            # A session can list CUDA as available and still fall back to CPU when its CUDA libraries do not load.
            session = ort.InferenceSession(str(model), providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
            status["session_providers"] = session.get_providers()
            del session
    except Exception as error:
        status["error"] = str(error)
    return status


def _dlss5_status() -> dict[str, Any]:
    """Whether the Custom DLSS5 node is loaded and finds VE_CLI.exe (Windows only; absent on Linux workers)."""
    status: dict[str, Any] = {"node": _dlss5_node() is not None, "cli": None, "error": None}
    if status["node"]:
        try:
            module = sys.modules.get(_dlss5_node().__module__)
            status["cli"] = str(module.find_cli()) if module and hasattr(module, "find_cli") else None
        except Exception as error:
            status["error"] = str(error)
    return status


def environment_info(refresh: bool = False) -> dict[str, Any]:
    """Versions and model availability. The VRAM mode is read fresh every time; the rest is cached per ComfyUI process."""
    global _ENVIRONMENT
    if _ENVIRONMENT is None or refresh:
        import folder_paths
        models_dir = Path(folder_paths.models_dir)
        reactor = _pack_dir("comfyui-reactor-node") or _pack_dir("ComfyUI-ReActor")
        seedvr2 = _pack_dir("seedvr2_videoupscaler") or _pack_dir("ComfyUI-SeedVR2_VideoUpscaler")
        torch_info: dict[str, Any] = {}
        try:
            import torch
            torch_info = {"version": torch.__version__, "cuda": torch.version.cuda, "cudnn": torch.backends.cudnn.version(),
                          "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                          "vram_total": torch.cuda.get_device_properties(0).total_memory if torch.cuda.is_available() else None}
        except Exception as error:
            torch_info = {"error": str(error)}
        try:
            import psutil
            ram_total = psutil.virtual_memory().total
        except Exception:
            ram_total = None

        def present(relative: str) -> dict[str, Any]:
            path = models_dir / relative
            return {"present": path.is_file(), "size": path.stat().st_size if path.is_file() else None}

        _ENVIRONMENT = {
            "contract": NODE_CONTRACT_VERSION,
            "reactor": {"path": str(reactor) if reactor else None, "version": _read_version(reactor / "scripts" / "reactor_version.py" if reactor else None, r'version_flag\s*=\s*"([^"]+)"')},
            "seedvr2": {"path": str(seedvr2) if seedvr2 else None, "version": _read_version(seedvr2 / "pyproject.toml" if seedvr2 else None, r'(?m)^version\s*=\s*"([^"]+)"')},
            "dlss5": _dlss5_status(),
            "onnxruntime": _ort_status(), "torch": torch_info, "ram_total": ram_total,
            "models": {name: present(name) for name in sorted({*FACE_MODELS, *OPTIONAL_MODELS, *MODE_MODELS["low_vram"], *MODE_MODELS["high_vram"]})},
            "mode_models": MODE_MODELS, "face_models": FACE_MODELS,
        }
    return {**_ENVIRONMENT, "vram_mode": worker_vram_mode()}


def register_postprocess_api() -> None:
    try:
        from aiohttp import web
        from server import PromptServer
        from .file_api import _token_ok
    except ImportError:
        return

    async def info(request):
        if not _token_ok(request):
            return web.json_response({"error": "wrong or missing Martini Shot file API token", "code": "bad_token"}, status=403)
        import asyncio
        refresh = request.query.get("refresh") == "1"
        value = await asyncio.get_running_loop().run_in_executor(None, lambda: environment_info(refresh))
        return web.json_response({"api": POSTPROCESS_API_VERSION, **value})

    PromptServer.instance.routes.get("/martini/postprocess/info")(info)


DLSS5_NODE = "Custom_DLSS5_Enhance_Video"  # the user's ComfyUI-Custom-DLSS5 pack (Windows: drives VE_CLI.exe)
DLSS5_STYLES = ("Default", "Natural", "Cinematic")
DLSS5_WORK_DIR = "martini_shot/_dlss5_work"  # relative to the ComfyUI output folder; files are deleted after use


def _dlss5_node():
    try:
        import nodes as comfy_nodes
        return comfy_nodes.NODE_CLASS_MAPPINGS.get(DLSS5_NODE)
    except Exception:
        return None


class MartiniShotDLSS5:
    """DLSS 5 neural rendering over a clip's frames, through the Custom DLSS5 Enhance (Video) node.

    The frames go to a high-quality H.264 file at the clip's own frame rate, the Custom DLSS5 node renders it with
    VE_CLI.exe (optional RTX upscale by `scale`, optional DLSS Frame Generation to `target_fps`, no audio), and the
    result is decoded back. Runs after face work and before SeedVR2. ComfyUI's models are unloaded first so VE_CLI has
    the GPU. Without interpolation the frame count must come back unchanged; with it, the clip's duration must be kept
    (within a couple of frames, which the final stitch then fits exactly). The size must be the input size × scale.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",), "source_info": ("STRING", {"forceInput": True}),
            "style": (list(DLSS5_STYLES), {"default": "Default"}),
            "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.1}),
            "scale": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 4.0, "step": 0.5, "tooltip": "RTX upscale after the neural render (1 = native size)."}),
            "target_fps": ("INT", {"default": 0, "min": 0, "max": 120, "tooltip": "0 = off. DLSS Frame Generation to this frame rate (RTX 40/50)."}),
            "intermediate_crf": ("INT", {"default": 10, "min": 0, "max": 30, "tooltip": "H.264 quality of the file handed to DLSS 5 (lower = closer to lossless)."}),
            "job_json": ("STRING", {"default": "{}", "multiline": True}),
        }}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("frames",)
    FUNCTION = "enhance"
    CATEGORY = PP_CATEGORY

    def enhance(self, images, source_info, style, strength, intermediate_crf, job_json, scale=1.0, target_fps=0):
        from comfy_api.latest import InputImpl, Types

        node_class = _dlss5_node()
        if node_class is None:
            raise PostProcessConfigError(f"{DLSS5_NODE} is not loaded. Install ComfyUI-Custom-DLSS5 (and the comfyui-dlss5-enhancer-v15 runtime it uses) and restart ComfyUI.")
        if style not in DLSS5_STYLES:
            raise PostProcessConfigError(f"DLSS 5 style must be one of {', '.join(DLSS5_STYLES)}.")
        job = _job(job_json)
        source = json.loads(source_info)
        frames, height, width = int(images.shape[0]), int(images.shape[1]), int(images.shape[2])
        work = resolve_inside(_output_dir(), DLSS5_WORK_DIR)
        work.mkdir(parents=True, exist_ok=True)
        tag = re.sub(r"[^A-Za-z0-9_-]", "", str(job.get("attempt_id") or "clip"))[:40] or "clip"
        intermediate = work / f"{tag}_in.mp4"
        rendered = None
        try:
            # yuv420p needs even dimensions: pad one edge pixel, then crop it off again after rendering
            pad_h, pad_w = height % 2, width % 2
            frames_in = images[..., :3]
            if pad_h or pad_w:
                import torch.nn.functional as F
                frames_in = F.pad(frames_in.permute(0, 3, 1, 2), (0, pad_w, 0, pad_h), mode="replicate").permute(0, 2, 3, 1)
            video = InputImpl.VideoFromComponents(Types.VideoComponents(images=frames_in, audio=None, frame_rate=fps_fraction(source["fps"])))
            video.save_to(str(intermediate), crf=int(intermediate_crf))
            del frames_in, video
            _unload_models()  # VE_CLI is a separate process that needs the GPU memory ComfyUI is holding
            scale, target_fps = float(scale), int(target_fps)
            if target_fps and fps_fraction(target_fps) <= fps_fraction(source["fps"]):
                raise PostProcessConfigError(f"The DLSS 5 target frame rate ({target_fps}) must be above the clip's {source['fps']} fps.")
            output, rendered, _count = node_class().process_video(
                InputImpl.VideoFromFile(str(intermediate)), style, float(strength), scale, "HEVC", "MKV", "Max", target_fps, False, "Disabled",
                f"{tag}_dlss5", DLSS5_WORK_DIR, False)
            result = output.get_components().images
            del output
            got = int(result.shape[0])
            expected = interpolated_frames(frames, source["fps"], target_fps) if target_fps else frames
            if (target_fps and abs(got - expected) > INTERPOLATION_FRAME_TOLERANCE) or (not target_fps and got != frames):
                raise PostProcessConfigError(f"DLSS 5 returned {got} frames; expected {expected} for this {frames}-frame clip"
                                             f"{f' interpolated to {target_fps} fps' if target_fps else ''}. Refusing to continue with a re-timed clip.")
            out_h, out_w = int(result.shape[1]), int(result.shape[2])
            want_w, want_h = round((width + pad_w) * scale), round((height + pad_h) * scale)
            if abs(out_w - want_w) > 2 or abs(out_h - want_h) > 2:
                raise PostProcessConfigError(f"DLSS 5 returned {out_w}x{out_h} frames; {width + pad_w}x{height + pad_h} at {scale:g}x is {want_w}x{want_h}.")
            # crop the padding back off (it scaled with the frame)
            keep_w, keep_h = min(out_w, round(width * scale)), min(out_h, round(height * scale))
            return (result[:, :keep_h, :keep_w, :3].contiguous().float(),)
        finally:
            intermediate.unlink(missing_ok=True)
            if rendered:
                Path(rendered).unlink(missing_ok=True)
            gc.collect()


NODE_CLASS_MAPPINGS = {
    "MartiniShotPostProcessLoad": MartiniShotPostProcessLoad,
    "MartiniShotDLSS5": MartiniShotDLSS5,
    "MartiniShotFaceReport": MartiniShotFaceReport,
    "MartiniShotSavePostProcessed": MartiniShotSavePostProcessed,
    "MartiniShotFinalizeSelectedVideo": MartiniShotFinalizeSelectedVideo,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MartiniShotPostProcessLoad": "Martini Shot Post-process Load Clip",
    "MartiniShotDLSS5": "Martini Shot DLSS 5 (via Custom DLSS5)",
    "MartiniShotFaceReport": "Martini Shot Face Report",
    "MartiniShotSavePostProcessed": "Martini Shot Save Post-processed Clip",
    "MartiniShotFinalizeSelectedVideo": "Martini Shot Finalize Selected Clips",
}
