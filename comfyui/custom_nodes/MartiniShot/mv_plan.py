"""Music-video planning: section timing, clip splitting on H3's frame grid, and the timeline picture.

Pure logic (numpy + PIL only). Times are handled in integer frames at 24 fps so
every cut lands on an exact frame and the clips add up to the song length.
"""

from __future__ import annotations

import math
import re
from typing import Any

import numpy as np

FPS = 24
MIN_FRAMES = 124  # smallest trained H3 length; lengths are 17k + 5
TRANSITIONS = ("Hard cut", "New angle", "Continue")
SCENE_TYPES = ("Dance", "Performance", "Freeform", "B-roll")

_TIMESTAMP = re.compile(r"^\s*(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d*)?)\s*$")


def parse_timestamp(text: str) -> float:
    """'1:02.5', '62.5', '0:00', '1:02:03' -> seconds."""
    match = _TIMESTAMP.match(str(text))
    if not match:
        raise ValueError(f"'{text}' is not a timestamp (use m:ss or m:ss.s)")
    first, second, seconds = match.groups()
    parts = [int(p) for p in (first, second) if p is not None]
    total = float(seconds)
    for multiplier, value in zip((60, 3600), reversed(parts)):
        total += multiplier * value
    return total


def format_time(seconds: float) -> str:
    minutes, rest = divmod(max(0.0, seconds), 60)
    return f"{int(minutes)}:{rest:06.3f}"


def valid_at_least(frames: float) -> int:
    steps = max(0, math.ceil((frames - 5) / 17))
    return max(MIN_FRAMES, steps * 17 + 5)


def valid_at_most(frames: float) -> int:
    steps = math.floor((frames - 5) / 17)
    return max(MIN_FRAMES, steps * 17 + 5)


def detect_beats(waveform: np.ndarray, sample_rate: int) -> tuple[np.ndarray, str]:
    """Beat times for the whole song; empty with a reason if librosa fails."""
    mono = np.asarray(waveform, dtype=np.float32)
    if mono.ndim > 1:
        mono = mono.mean(axis=0)
    try:
        import librosa

        y = librosa.resample(mono, orig_sr=sample_rate, target_sr=22050) if sample_rate != 22050 else mono
        _, beats = librosa.beat.beat_track(y=y, sr=22050, units="time")
        return np.asarray(beats, dtype=np.float64), ""
    except Exception as error:
        return np.array([]), f"{type(error).__name__}: {error}"


def snap_starts(requested: list[float], beats: np.ndarray, snap_to_beat: bool) -> list[float]:
    """Snap every section start but the first to the nearest beat (if wanted)."""
    snapped = []
    for index, start in enumerate(requested):
        if index == 0 or not snap_to_beat or len(beats) == 0:
            snapped.append(start)
        else:
            snapped.append(float(beats[np.argmin(np.abs(beats - start))]))
    return snapped


def _split_section(
    frames: int, clip_count: int, first_overlap: int, overlap: int, tail: int,
    tail_on_last: bool, max_frames: int,
) -> list[dict[str, int]] | None:
    """Try to cover `frames` new frames with clip_count clips. None if a clip would be too long."""
    base = frames / clip_count
    clips, used = [], 0
    for k in range(clip_count):
        clip_overlap = first_overlap if k == 0 else overlap
        clip_tail = tail if (k < clip_count - 1 or tail_on_last) else 0
        if k < clip_count - 1:
            # error diffusion: round each clip toward the running target so the last one stays near `base`
            target = round(base * (k + 1)) - used
            fixed = clip_overlap + clip_tail
            options = [g for g in (valid_at_most(target + fixed), valid_at_least(target + fixed)) if g <= max_frames]
            if not options:
                return None
            generated = min(options, key=lambda g: abs(g - fixed - target))
            new = generated - fixed
            extra = 0
        else:
            new = frames - used
            generated = valid_at_least(new + clip_overlap + clip_tail)
            extra = generated - clip_overlap - clip_tail - new
        if new <= 0 or generated > max_frames:
            return None
        clips.append({"overlap": clip_overlap, "new": new, "frames": generated, "trim_end": clip_tail + extra})
        used += new
    return clips


def plan_video(
    sections: list[dict[str, Any]], song_seconds: float, beats: np.ndarray, *,
    max_frames: int = 260, overlap: int = 22, tail_trim_seconds: float = 0.0, snap_to_beat: bool = True,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """Plan every clip of the video.

    sections: [{"start": seconds (requested), "transition": ...}, ...] in any order.
    Returns (sections with snapped frame bounds, clips, notes). Each clip:
      index, section, clip_in_section, transition (how it joins the previous clip),
      start/end (song seconds of its kept frames), frames (to generate), overlap
      (re-created frames trimmed from the start), trim_end, new_frames,
      generation_start (song seconds where the generated clip begins).
    """
    notes: list[str] = []
    max_frames = valid_at_most(max_frames)
    if overlap and overlap % 17 != 5:
        snapped_overlap = max(5, round((overlap - 5) / 17) * 17 + 5)
        notes.append(f"NOTE: Overlap snapped from {overlap} to {snapped_overlap} frames (guide clips are 17k + 5).")
        overlap = snapped_overlap
    tail = max(0, round(tail_trim_seconds * FPS))
    if overlap + tail > max_frames - 17:
        raise ValueError("Overlap plus tail trim leaves no room for new frames in a clip.")

    total = int(round(song_seconds * FPS))
    order = sorted(range(len(sections)), key=lambda i: sections[i]["start"])
    ordered = [dict(sections[i], original_index=i) for i in order]
    if not ordered:
        raise ValueError("Connect at least one Music Video Shot.")
    if ordered[0]["start"] > 0.001:
        notes.append(f"NOTE: The first shot started at {format_time(ordered[0]['start'])}; it now starts at 0:00.")
        ordered[0]["start"] = 0.0
    snapped = snap_starts([s["start"] for s in ordered], beats, snap_to_beat)

    kept = []
    for section, start in zip(ordered, snapped):
        frame = int(round(start * FPS))
        if frame >= total:
            notes.append(f"WARNING: The shot at {format_time(section['start'])} starts after the song ends; it was dropped.")
            continue
        if kept and frame <= kept[-1]["start_frame"]:
            raise ValueError(
                f"Shots at {format_time(kept[-1]['start'])} and {format_time(section['start'])} land on the same "
                "time after snapping; move one or turn off snap_to_beat."
            )
        if abs(start - section["start"]) > 0.02:
            notes.append(f"NOTE: Shot {len(kept) + 1} start snapped from {format_time(section['start'])} to {format_time(start)} (beat).")
        kept.append(dict(section, start_frame=frame, snapped_start=frame / FPS))
    for index, section in enumerate(kept):
        section["number"] = index + 1
        section["end_frame"] = kept[index + 1]["start_frame"] if index + 1 < len(kept) else total
        if index == 0 and section["transition"] != "Hard cut":
            section["transition"] = "Hard cut"  # nothing to continue from
        length = (section["end_frame"] - section["start_frame"]) / FPS
        if length < 2.0:
            notes.append(f"NOTE: Shot {index + 1} lasts only {length:.2f} s; its clip is generated at 5.17 s and trimmed.")

    clips: list[dict[str, Any]] = []
    for index, section in enumerate(kept):
        frames = section["end_frame"] - section["start_frame"]
        first_overlap = overlap if section["transition"] in {"Continue", "New angle"} else 0
        next_continues = index + 1 < len(kept) and kept[index + 1]["transition"] in {"Continue", "New angle"} and overlap > 0
        pieces = None
        for count in range(1, 1000):
            pieces = _split_section(frames, count, first_overlap, overlap, tail if overlap else 0,
                                    next_continues, max_frames)
            if pieces:
                break
        if not pieces:
            raise ValueError(f"Could not split shot {index + 1} into valid clips.")
        position = section["start_frame"]
        for k, piece in enumerate(pieces):
            clips.append({
                "index": len(clips) + 1,
                "section": section["number"],
                "clip_in_section": k + 1,
                "clips_in_section": len(pieces),
                "transition": section["transition"] if k == 0 else "Continue",
                "start": position / FPS,
                "end": (position + piece["new"]) / FPS,
                "frames": piece["frames"],
                "overlap": piece["overlap"],
                "trim_end": piece["trim_end"],
                "new_frames": piece["new"],
                "generation_start": (position - piece["overlap"]) / FPS,
            })
            position += piece["new"]
        section["clips"] = len(pieces)

    covered = sum(clip["new_frames"] for clip in clips)
    if covered != total:  # should be impossible; keep the guarantee visible
        notes.append(f"WARNING: Clips cover {covered} frames but the song is {total} frames.")
    wasted = sum(clip["frames"] - clip["new_frames"] - clip["overlap"] for clip in clips)
    if wasted:
        notes.append(f"NOTE: {wasted} generated frames ({wasted / FPS:.1f} s) are trimmed to land cuts exactly.")
    return kept, clips, notes


SCENE_COLORS = {
    "Dance": (63, 120, 158), "Performance": (122, 79, 158), "Freeform": (63, 142, 90), "B-roll": (161, 102, 58),
}
JOIN_COLORS = {"Hard cut": (220, 60, 60), "New angle": (240, 160, 40), "Continue": (90, 200, 120)}


def draw_timeline(
    sections: list[dict[str, Any]], clips: list[dict[str, Any]], song_seconds: float,
    beats: np.ndarray, waveform: np.ndarray | None, sample_rate: int, width: int = 1800,
):
    """Timeline picture: energy curve, beats, shots (colored by scene type), clip joins."""
    from PIL import Image, ImageDraw, ImageFont

    height, left, right = 460, 60, 30
    image = Image.new("RGB", (width, height), (24, 26, 30))
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.load_default(size=15)
        small = ImageFont.load_default(size=12)
    except TypeError:  # older Pillow
        font = small = ImageFont.load_default()
    span = max(song_seconds, 0.001)
    x_of = lambda t: left + (width - left - right) * min(max(t, 0.0), span) / span

    # energy curve
    if waveform is not None and len(waveform):
        mono = waveform.mean(axis=0) if waveform.ndim > 1 else waveform
        bins = width - left - right
        step = max(1, len(mono) // bins)
        bins = min(bins, len(mono) // step)
        rms = np.sqrt(np.mean(np.asarray(mono[: step * bins], dtype=np.float32).reshape(bins, step) ** 2, axis=1))
        if rms.max() > 0:
            rms = rms / rms.max()
        points = [(left + i, 120 - 80 * float(v)) for i, v in enumerate(rms)]
        draw.line(points, fill=(150, 150, 160), width=1)
    draw.text((8, 40), "energy", font=small, fill=(150, 150, 160))

    # beats
    for beat in beats:
        x = x_of(float(beat))
        draw.line([(x, 130), (x, 138)], fill=(90, 90, 100))
    draw.text((8, 126), "beats", font=small, fill=(120, 120, 130))

    # shots
    for section in sections:
        x0, x1 = x_of(section["start_frame"] / FPS), x_of(section["end_frame"] / FPS)
        color = SCENE_COLORS.get(section.get("scene_type"), (90, 90, 90))
        draw.rectangle([x0, 150, x1, 250], fill=color, outline=(20, 20, 20))
        draw.line([(x0, 144), (x0, 256)], fill=JOIN_COLORS.get(section["transition"], (200, 200, 200)), width=4)
        label = f"{section['number']}. {section.get('scene_type', '')}"
        detail = section.get("label", "")
        draw.text((x0 + 5, 156), label, font=font, fill=(255, 255, 255))
        draw.text((x0 + 5, 178), detail[: max(0, int((x1 - x0) / 7))], font=small, fill=(235, 235, 235))
        draw.text((x0 + 5, 228), f"{section['transition']}  {format_time(section['start_frame'] / FPS)}",
                  font=small, fill=(255, 255, 255))
    draw.text((8, 192), "shots", font=small, fill=(200, 200, 200))

    # clips
    for clip in clips:
        x0, x1 = x_of(clip["start"]), x_of(clip["end"])
        draw.rectangle([x0, 270, x1, 320], outline=(200, 200, 200), fill=(45, 48, 55))
        draw.line([(x0, 262), (x0, 328)], fill=JOIN_COLORS[clip["transition"]], width=3)
        text = f"{clip['index']}"
        if x1 - x0 > 60:
            text += f"  {clip['frames']}f"
        draw.text((x0 + 4, 276), text, font=small, fill=(230, 230, 230))
        if clip["trim_end"] and x1 - x0 > 60:
            draw.text((x0 + 4, 298), f"trim {clip['trim_end']}", font=small, fill=(170, 170, 170))
    if clips:
        draw.text((8, 288), "clips", font=small, fill=(200, 200, 200))
    else:
        draw.text((left, 288), "Clips are planned by the Music Video Director (see its timeline).", font=small,
                  fill=(140, 140, 150))

    # time axis
    step = 10 if span <= 240 else 30
    for t in np.arange(0, span + 0.001, step):
        x = x_of(float(t))
        draw.line([(x, 336), (x, 344)], fill=(160, 160, 160))
        draw.text((x - 14, 348), format_time(float(t))[:-4], font=small, fill=(160, 160, 160))

    # legend
    y = 390
    x = left
    for name, color in SCENE_COLORS.items():
        draw.rectangle([x, y, x + 16, y + 16], fill=color)
        draw.text((x + 22, y), name, font=small, fill=(220, 220, 220))
        x += 130
    x += 40
    for name, color in JOIN_COLORS.items():
        draw.line([(x, y), (x, y + 16)], fill=color, width=3)
        draw.text((x + 8, y), name, font=small, fill=(220, 220, 220))
        x += 120
    summary = f"{len(sections)} shots" + (f", {len(clips)} clips" if clips else "") + f", {format_time(song_seconds)}"
    draw.text((left, 420), summary, font=font, fill=(220, 220, 220))
    return image
