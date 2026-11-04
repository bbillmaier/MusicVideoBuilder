"""ComfyUI nodes that render and join the segments planned by the Dance Song Prompt Writer."""

from __future__ import annotations

import json
import subprocess
from collections import deque
from pathlib import Path
from typing import Any

from .ref2va_nodes import CATEGORY

MANIFEST_NAME = "segments.json"
LOADER_MODES = ["Next missing", "Fixed index"]


def resolve_folder(folder: str) -> Path:
    import folder_paths

    path = Path(folder.strip().strip('"'))
    if not path.is_absolute():
        path = Path(folder_paths.get_output_directory()) / path
    if not (path / MANIFEST_NAME).is_file():
        raise FileNotFoundError(f"No {MANIFEST_NAME} in {path}. Run the Dance Song Prompt workflow first.")
    return path


def load_manifest(folder: Path) -> dict[str, Any]:
    return json.loads((folder / MANIFEST_NAME).read_text(encoding="utf-8"))


def _is_playable(path: Path) -> bool:
    """False for empty or half-written files (e.g. left behind when a save crashed)."""
    if path.stat().st_size < 1024:
        return False
    try:
        import av

        with av.open(str(path)) as container:
            return bool(container.streams.video) and (container.streams.video[0].frames or 1) > 0
    except Exception:
        return False


def find_video(folder: Path, video_name: str) -> Path | None:
    """SaveVideo appends a counter (segment_02_00001_.mp4); take the newest playable take."""
    candidates = list(folder.glob(f"{video_name}.mp4")) + list(folder.glob(f"{video_name}_*.mp4"))
    playable = [path for path in candidates if _is_playable(path)]
    return max(playable, key=lambda path: path.stat().st_mtime) if playable else None


def read_tail_frames(path: Path, count: int):
    import av
    import numpy as np
    import torch

    tail: deque = deque(maxlen=count)
    with av.open(str(path)) as container:
        for frame in container.decode(video=0):
            tail.append(frame.to_ndarray(format="rgb24"))
    if len(tail) < count:
        raise ValueError(f"{path.name} has only {len(tail)} frames; the overlap needs {count}.")
    return torch.from_numpy(np.stack(tail)).float() / 255.0


def load_song(folder: Path, manifest: dict[str, Any], audio: dict[str, Any] | None) -> dict[str, Any]:
    """The song saved next to the prompts, unless a LOAD SONG override is connected."""
    if audio is not None:
        return audio
    import soundfile
    import torch

    song = folder / (manifest.get("song_file") or "song.flac")
    if not song.is_file():
        raise FileNotFoundError(
            f"No {song.name} in {folder.name} (prompt folders made before this feature don't have one). "
            "Enable the LOAD SONG override (Ctrl+B) and pick the song."
        )
    data, sample_rate = soundfile.read(str(song), dtype="float32", always_2d=True)
    return {"waveform": torch.from_numpy(data.T.copy())[None], "sample_rate": sample_rate}


def load_image(path: Path):
    import numpy as np
    import torch
    from PIL import Image

    pixels = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0
    return torch.from_numpy(pixels)[None]


def slice_audio(audio: dict[str, Any], start: float, duration: float) -> dict[str, Any]:
    """Cut [start, start + duration) seconds, padding with silence before 0 or past the end."""
    import torch

    waveform, sample_rate = audio["waveform"], int(audio["sample_rate"])
    first = int(round(start * sample_rate))
    length = int(round(duration * sample_rate))
    piece = waveform[..., max(0, first):max(0, first + length)]
    pad_before = max(0, -first)
    pad_after = length - pad_before - piece.shape[-1]
    if pad_before or pad_after > 0:
        piece = torch.nn.functional.pad(piece, (pad_before, max(0, pad_after)))
    return {"waveform": piece.contiguous(), "sample_rate": sample_rate}


class MiniMaxH3DanceSegmentLoader:
    """Loads one planned segment: prompt, references, song slices, and the previous segment's tail."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder": ("STRING", {
                    "default": "dance_prompts/song",
                    "tooltip": "The prompt folder (relative to ComfyUI's output folder, or absolute inside it).",
                }),
                "mode": (LOADER_MODES, {
                    "tooltip": "Next missing: render the first segment without a video, so queuing N runs renders "
                    "the song and re-queuing resumes. Fixed index: render segment_index (to redo one).",
                }),
                "segment_index": ("INT", {"default": 1, "min": 1, "max": 999}),
            },
            "optional": {
                "start_frame": ("IMAGE", {"tooltip": "Optional: anchors segment 1 to this image at frame 0."}),
                "audio": ("AUDIO", {"tooltip": "Optional override. By default the song.flac saved in the folder is used."}),
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE", "IMAGE", "IMAGE", "AUDIO", "AUDIO", "IMAGE", "INT", "INT", "STRING", "STRING")
    RETURN_NAMES = (
        "prompt", "subject_image", "outfit_image", "location_image", "song_audio", "segment_audio",
        "guide_frames", "length", "trim_frames", "filename_prefix", "report",
    )
    FUNCTION = "load"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # "Next missing" must look at the folder again on every run

    def load(self, folder: str, mode: str, segment_index: int, start_frame: Any = None, audio: dict[str, Any] | None = None):
        import folder_paths

        path = resolve_folder(folder)
        manifest = load_manifest(path)
        if manifest.get("version", 1) >= 2:
            raise ValueError(f"{path.name} was made by the Music Video Director; render it with the Music Video Segment Loader.")
        audio = load_song(path, manifest, audio)
        segments = manifest["segments"]
        total = len(segments)

        if mode == LOADER_MODES[0]:
            pending = [s for s in segments if find_video(path, s["video_name"]) is None]
            if not pending:
                raise RuntimeError(f"Nothing to do: all {total} segments in {path.name} have videos. Run the stitch workflow.")
            segment = pending[0]
        else:
            if segment_index > total:
                raise ValueError(f"segment_index {segment_index} is past the last segment ({total}).")
            segment = segments[segment_index - 1]
        index = segment["index"]

        prompt_path = path / segment["prompt_file"]
        if not prompt_path.is_file():
            raise FileNotFoundError(f"{prompt_path.name} is missing; the prompt run may have stopped early.")
        prompt = prompt_path.read_text(encoding="utf-8")

        images = {}
        for key, name in (("subject", "ref_image_0_subject.png"), ("outfit", "ref_image_1_outfit.png"),
                          ("location", "ref_image_2_location.png")):
            images[key] = load_image(path / name) if (path / name).is_file() else None

        notes = []
        guide_frames = None
        overlap = int(segment["overlap_frames"])
        if overlap:
            previous = segments[index - 2]
            previous_video = find_video(path, previous["video_name"])
            if previous_video is None:
                raise FileNotFoundError(
                    f"Segment {index} continues segment {previous['index']}, which has no video yet."
                )
            guide_frames = read_tail_frames(previous_video, overlap)
            notes.append(f"Continues from the last {overlap} frames of {previous_video.name}.")
        elif start_frame is not None and index == 1:
            guide_frames = start_frame[:1]
            notes.append("Segment 1 is anchored to the start frame.")

        fps = manifest["fps"]
        frames = int(segment["generation_frames"])
        song_audio = slice_audio(audio, segment["generation_start"], frames / fps)
        segment_audio = slice_audio(audio, segment["song_start"], segment["new_frames"] / fps)
        if abs(audio["waveform"].shape[-1] / int(audio["sample_rate"]) - manifest["song_duration"]) > 0.5:
            notes.append("WARNING: This song's length differs from the one the prompts were written for.")

        output_root = Path(folder_paths.get_output_directory()).resolve()
        try:
            relative = path.resolve().relative_to(output_root)
        except ValueError:
            raise ValueError(f"The folder must be inside ComfyUI's output folder ({output_root}) so SaveVideo can write there.")
        prefix = (relative / segment["video_name"]).as_posix()

        rendered = sum(find_video(path, s["video_name"]) is not None for s in segments)
        report = "\n".join([
            f"Segment {index} of {total} ({rendered} already rendered)",
            f"Song {segment['song_start']:.3f} - {segment['song_end']:.3f} s | generate {frames} frames"
            + (f" | trim first {overlap}" if overlap else ""),
            f"Saving to {prefix}",
        ] + notes)
        return (
            prompt, images["subject"], images["outfit"], images["location"], song_audio, segment_audio,
            guide_frames, frames, overlap, prefix, report,
        )


class MiniMaxH3TrimOverlap:
    """Drops the frames a continuation clip re-created from the previous segment."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "trim_frames": ("INT", {"default": 0, "min": 0, "max": 4096, "tooltip": "Frames dropped from the start."}),
            },
            "optional": {
                "trim_end": ("INT", {"default": 0, "min": 0, "max": 4096, "tooltip": "Frames dropped from the end."}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "trim"
    CATEGORY = CATEGORY

    def trim(self, images: Any, trim_frames: int, trim_end: int = 0):
        count = images.shape[0]
        if trim_frames + trim_end >= count:
            raise ValueError(f"Cannot trim {trim_frames} + {trim_end} frames from a {count}-frame clip.")
        return (images[trim_frames:count - trim_end],)


def _probe(path: Path) -> tuple[int, int, float, str]:
    import av

    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        return stream.codec_context.width, stream.codec_context.height, float(stream.average_rate or 0), stream.codec_context.name


class MiniMaxH3StitchSongSegments:
    """Joins every segment video in order (no re-encode) and lays the original song underneath."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder": ("STRING", {"default": "dance_prompts/song"}),
                "output_name": ("STRING", {"default": "final"}),
                "overwrite": ("BOOLEAN", {"default": False, "tooltip": "Off: an existing file gets a _2, _3... suffix."}),
            },
            "optional": {
                "audio": ("AUDIO", {"tooltip": "Optional override. By default the song.flac saved in the folder is used."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("video_path", "report")
    FUNCTION = "stitch"
    OUTPUT_NODE = True
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def stitch(self, folder: str, output_name: str, overwrite: bool, audio: dict[str, Any] | None = None):
        import imageio_ffmpeg
        import soundfile

        path = resolve_folder(folder)
        manifest = load_manifest(path)
        audio = load_song(path, manifest, audio)
        segments = manifest["segments"]
        videos = [(segment, find_video(path, segment["video_name"])) for segment in segments]
        missing = [segment["index"] for segment, video in videos if video is None]
        partial = ""
        if missing:
            # test stitch: the first unbroken run of rendered clips, with the song cut to match it
            first = next((i for i, (_, video) in enumerate(videos) if video is not None), None)
            if first is None:
                raise FileNotFoundError(f"None of the {len(segments)} clips has a video yet.")
            last = first
            while last + 1 < len(videos) and videos[last + 1][1] is not None:
                last += 1
            runs, i = [], last + 1
            while i < len(videos):
                if videos[i][1] is not None:
                    j = i
                    while j + 1 < len(videos) and videos[j + 1][1] is not None:
                        j += 1
                    runs.append(f"{videos[i][0]['index']}-{videos[j][0]['index']}")
                    i = j
                i += 1
            start_segment, end_segment = videos[first][0], videos[last][0]
            audio = slice_audio(audio, start_segment["song_start"], end_segment["song_end"] - start_segment["song_start"])
            partial = f"{start_segment['index']}-{end_segment['index']}_test"
            videos = videos[first:last + 1]
            partial_note = (f"TEST STITCH of clips {start_segment['index']}-{end_segment['index']}: "
                            f"{len(missing)} clip(s) missing ({', '.join(map(str, missing[:20]))})."
                            + (f" Other rendered stretches not included: {', '.join(runs)}." if runs else ""))

        probes = {video: _probe(video) for _, video in videos}
        reference = probes[videos[0][1]]
        mismatched = [video.name for video, probe in probes.items() if probe[:2] != reference[:2] or probe[3] != reference[3]]
        if mismatched:
            raise ValueError(
                f"These segments differ in resolution or codec from {videos[0][1].name} "
                f"({reference[0]}x{reference[1]} {reference[3]}): {', '.join(mismatched[:10])}. Re-render them."
            )

        stem = partial or output_name.strip() or "final"
        target = path / f"{stem}.mp4"
        counter = 2
        while target.exists() and not overwrite:
            target = path / f"{stem}_{counter}.mp4"
            counter += 1

        list_file = path / ".stitch_list.txt"
        song_file = path / ".stitch_song.wav"
        # concat demuxer quoting: a ' inside a quoted path is written as '\''
        quoted = [video.resolve().as_posix().replace("'", "'\\''") for _, video in videos]
        list_file.write_text("".join(f"file '{name}'\n" for name in quoted), encoding="utf-8")
        soundfile.write(str(song_file), audio["waveform"][0].float().cpu().numpy().T, int(audio["sample_rate"]))
        command = [
            imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error",
            "-f", "concat", "-safe", "0", "-i", str(list_file), "-i", str(song_file),
            "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "320k",
            "-shortest", "-movflags", "+faststart", str(target),
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True)
        finally:
            list_file.unlink(missing_ok=True)
            song_file.unlink(missing_ok=True)
        if result.returncode != 0:
            raise RuntimeError("ffmpeg failed:\n" + result.stderr[-2000:])

        report = "\n".join([
            f"Stitched {len(videos)} segments into {target}",
            f"{reference[0]}x{reference[1]} {reference[3]} at {reference[2]:.2f} fps, original song audio",
        ] + ([partial_note] if partial else []))
        return {"ui": {"text": [report]}, "result": (str(target), report)}


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3DanceSegmentLoader": MiniMaxH3DanceSegmentLoader,
    "MiniMaxH3TrimOverlap": MiniMaxH3TrimOverlap,
    "MiniMaxH3StitchSongSegments": MiniMaxH3StitchSongSegments,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3DanceSegmentLoader": "MiniMax H3 Dance Segment Loader",
    "MiniMaxH3TrimOverlap": "MiniMax H3 Trim Overlap Frames",
    "MiniMaxH3StitchSongSegments": "MiniMax H3 Stitch Song Segments",
}
