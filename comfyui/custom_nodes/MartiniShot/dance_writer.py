"""LLM-assisted dance choreography for MiniMax H3 Ref2VA prompts.

Pure logic only: music analysis, LLM instructions, and response parsing. The LLM
writes the creative text (style intro, summary phrase, choreography); the
deterministic Ref2VA formatter writes every label, definition, and section.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import numpy as np

try:
    from .h3_prompt import _clean, format_cut_time
    from .music_energy import energy_label, energy_reference, relative_energy, rms_level
except ImportError:  # imported as a top-level module by the tests
    from h3_prompt import _clean, format_cut_time
    from music_energy import energy_label, energy_reference, relative_energy, rms_level


FPS = 24
MIN_FRAMES = 124  # H3 lengths are 17k + 5 frames; 124 (~5.2 s) to 362 (~15.1 s) is the trained range
MAX_FRAMES = 362
STYLES_PATH = Path(__file__).with_name("dance_styles.json")
CUSTOM_STYLE = "Custom (style_notes only)"
ENERGY_ARCS = ("Follow the music", "Build to a peak", "Steady groove", "Explosive throughout")

SYSTEM_PROMPT = """You are an expert dance choreographer writing the action description for an AI video generator.

You write ONLY the choreography text. Another system handles reference images, identity, outfit definitions, camera framing, and audio, so stay inside your job.

Labels:
- <Subject 1> is the dancer. <Subject 2> is the outfit the dancer wears. <Subject 3>, when provided, is the location.
- Use these labels exactly, including the angle brackets. Never invent other labels such as <Picture 1> or <Subject 4>.

Rules:
- Describe concrete, observable movement: body parts, direction, level, weight shifts, and rhythm. Name moves, then show what the body does.
- Present tense. Natural English paragraphs. No lists, no markdown, no headings inside the choreography.
- Never describe the dancer's face, skin, hair color, or the outfit's colors, design, or materials. Those come from the reference images.
- You MAY describe how clothing, footwear, and hair MOVE (for example a skirt flaring on turns), and choose moves that suit what the dancer is wearing.
- Do not describe camera movement, shot framing, lighting, or music. Do not write dialogue.
- The routine develops continuously and never loops the same motion.
- Body mechanics are realistic and balanced.

Follow the output format exactly."""


def load_styles(path: Path = STYLES_PATH) -> dict[str, dict[str, Any]]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def style_names(path: Path = STYLES_PATH) -> list[str]:
    return list(load_styles(path)) + [CUSTOM_STYLE]


def format_timestamp(seconds: float) -> str:
    return format_cut_time(seconds)


def _phrase_bounds_from_beats(beats: np.ndarray, duration: float) -> list[float]:
    if len(beats) < 2:
        return []
    beat_period = float(np.median(np.diff(beats)))
    # aim for phrases of roughly 2-4.5 s, in whole bars of four beats
    beats_per_phrase = 8
    if beat_period * beats_per_phrase > 4.5:
        beats_per_phrase = 4
    elif beat_period * beats_per_phrase < 2.0:
        beats_per_phrase = 16
    bounds = [0.0] + [float(b) for b in beats[beats_per_phrase::beats_per_phrase] if 0.5 < b < duration - 0.5]
    return bounds + [duration]


def _fixed_bounds(duration: float, step: float = 3.0) -> list[float]:
    bounds = list(np.arange(0.0, duration, step))
    return [float(b) for b in bounds] + [duration]


def analyze_music(waveform: np.ndarray, sample_rate: int, max_seconds: float,
                  loudness_reference: tuple[float, float] | None = None) -> dict[str, Any]:
    """waveform: [channels, samples] or [samples]. Returns duration, bpm, and energy phrases."""
    mono = np.asarray(waveform, dtype=np.float32)
    if mono.ndim > 1:
        mono = mono.mean(axis=0)
    reference = loudness_reference if loudness_reference is not None else energy_reference(mono, sample_rate)
    source_duration = len(mono) / float(sample_rate)
    limit = int(max_seconds * sample_rate) if max_seconds > 0 else len(mono)
    mono = mono[:limit]
    duration = len(mono) / float(sample_rate)

    bpm = None
    beats = np.array([])
    beat_error = ""
    try:
        import librosa

        y = librosa.resample(mono, orig_sr=sample_rate, target_sr=22050) if sample_rate != 22050 else mono
        tempo, beats = librosa.beat.beat_track(y=y, sr=22050, units="time")
        bpm = float(np.atleast_1d(tempo)[0]) or None
    except Exception as error:  # librosa missing or analysis failed: fall back to fixed phrases
        beats = np.array([])
        beat_error = f"{type(error).__name__}: {error}"

    bounds = _phrase_bounds_from_beats(np.asarray(beats), duration) or _fixed_bounds(duration)
    if len(bounds) > 2 and bounds[-1] - bounds[-2] < 1.0:
        del bounds[-2]  # fold a tiny trailing phrase into the previous one

    levels = []
    for start, end in zip(bounds[:-1], bounds[1:]):
        levels.append(rms_level(mono[int(start * sample_rate):int(end * sample_rate)]))

    phrases = []
    for index, (start, end) in enumerate(zip(bounds[:-1], bounds[1:])):
        value = relative_energy(levels[index], reference)
        change_db = (20 * np.log10(max(levels[index], 1e-6) / max(levels[index - 1], 1e-6))
                     if index else 0.0)
        trend = "rising" if change_db > 2 else "falling" if change_db < -2 else "steady"
        phrases.append({"start": round(start, 3), "end": round(end, 3), "energy": energy_label(value),
                        "energy_value": value, "trend": trend})

    return {
        "duration": round(duration, 3),
        "source_duration": round(source_duration, 3),
        "trimmed": source_duration > duration + 0.01,
        "bpm": round(bpm, 1) if bpm else None,
        "phrases": phrases,
        "beat_error": beat_error,
    }


def snap_frames(seconds: float, round_down: bool = False) -> int:
    """Nearest valid H3 frame count (17k + 5) for a duration, clamped to the trained range."""
    steps = (seconds * FPS - 5) / 17
    frames = int(np.floor(steps) if round_down else np.round(steps)) * 17 + 5
    return int(min(MAX_FRAMES, max(MIN_FRAMES, frames)))


def snap_overlap(frames: int) -> int:
    """Guide clips must be 17k + 5 frames (5, 22, 39, ...); 0 means hard cuts."""
    if frames <= 0:
        return 0
    return max(5, int(round((frames - 5) / 17)) * 17 + 5)


def _frames_at_least(frames: float) -> int:
    """Smallest valid H3 frame count that is >= frames."""
    steps = max(0, int(np.ceil((frames - 5) / 17)))
    return max(MIN_FRAMES, steps * 17 + 5)


def plan_segments(
    total_seconds: float, segment_seconds: float, overlap_frames: int = 0
) -> tuple[list[dict[str, Any]], list[str]]:
    """Plan clips that tile the song exactly.

    Without overlap every clip is snap(segment_seconds). With overlap (video
    continuation), segment 1 is snap(segment_seconds) and every later clip
    re-creates the previous clip's last `overlap` frames first, so it is
    generated `overlap` frames longer and only its new frames advance the song.
    Per segment: start/end are the song time of its NEW frames; generation_start is
    where its generated audio begins (start minus the overlap).
    """
    notes: list[str] = []
    overlap = snap_overlap(overlap_frames)
    if overlap != overlap_frames:
        notes.append(f"NOTE: Overlap snapped from {overlap_frames} to {overlap} frames (guide clips are 17k + 5).")
    first = snap_frames(segment_seconds)
    later = snap_frames(segment_seconds + overlap / FPS) if overlap else first
    if overlap and later - overlap < 17:
        raise ValueError("Segments are too short for that much overlap.")
    if abs(first / FPS - segment_seconds) > 0.01:
        notes.append(f"NOTE: Segment 1 length snapped from {segment_seconds:.2f} s to {first / FPS:.3f} s ({first} frames).")
    if overlap:
        notes.append(
            f"NOTE: Continuation: later segments generate {later} frames, the first {overlap} re-create the "
            f"previous segment's ending, so each adds {later - overlap} new frames ({(later - overlap) / FPS:.3f} s)."
        )

    segments: list[dict[str, Any]] = []
    start = 0.0
    while total_seconds - start > 0.01:
        segment_overlap = overlap if segments else 0
        frames = later if segments else first
        remaining = total_seconds - start
        if remaining * FPS < frames - segment_overlap - 1e-6:  # tail: shorter last clip
            if segments and remaining < 1.0:
                notes.append(f"NOTE: The final {remaining:.2f} s of the song is too short for a clip and was skipped.")
                break
            frames = min(frames, _frames_at_least(segment_overlap + remaining * FPS))
            padded = (frames - segment_overlap) / FPS - remaining
            if padded > 0.05:
                notes.append(
                    f"NOTE: The last clip runs {padded:.2f} s past the end of the song (H3 lengths come in "
                    "17-frame steps); that part of its audio is silence."
                )
        new_frames = frames - segment_overlap
        segments.append({
            "index": len(segments) + 1,
            "start": start,
            "end": start + new_frames / FPS,
            "duration": new_frames / FPS,
            "frames": frames,
            "overlap": segment_overlap,
            "new_frames": new_frames,
            "generation_start": start - segment_overlap / FPS,
        })
        start += new_frames / FPS
    return segments, notes


def label_segment_energy(waveform: np.ndarray, sample_rate: int, segments: list[dict[str, Any]],
                         loudness_reference: tuple[float, float] | None = None) -> None:
    """Tag each segment with its loudness relative to the rest of the song (low / medium / high)."""
    mono = np.asarray(waveform, dtype=np.float32)
    if mono.ndim > 1:
        mono = mono.mean(axis=0)
    reference = loudness_reference if loudness_reference is not None else energy_reference(mono, sample_rate)
    for segment in segments:
        piece = mono[int(segment["start"] * sample_rate):int(segment["end"] * sample_rate)]
        segment["energy_value"] = relative_energy(rms_level(piece), reference)
        segment["energy"] = energy_label(segment["energy_value"])


def build_manifest(
    segments: list[dict[str, Any]], song_seconds: float, overlap: int, width: int, reference_images: list[str],
    song_file: str = "",
) -> dict[str, Any]:
    """segments.json: everything the video and stitch workflows need to render and join each segment."""
    rows = []
    for segment in segments:
        number = f"{segment['index']:0{width}d}"
        rows.append({
            "index": segment["index"],
            "prompt_file": f"segment_{number}.txt",
            "video_name": f"segment_{number}",
            "song_start": round(segment["start"], 6),
            "song_end": round(segment["end"], 6),
            "generation_start": round(segment["generation_start"], 6),
            "generation_frames": segment["frames"],
            "overlap_frames": segment["overlap"],
            "new_frames": segment["new_frames"],
        })
    return {
        "version": 1,
        "fps": FPS,
        "song_duration": round(song_seconds, 6),
        "song_file": song_file,
        "overlap_frames": overlap,
        "reference_images": reference_images,
        "segments": rows,
    }


def build_continuation(
    segment: dict[str, Any],
    segments: list[dict[str, Any]],
    history: list[dict[str, str]],
    signature: dict[str, Any] | None = None,
) -> str:
    """Song position plus the previous choreography, so each segment continues the last one.

    signature: {"segment": n, "combo": text} from the first chorus, reused on later choruses.
    """
    total = len(segments)
    index = segment["index"]
    lines = [
        f"This is segment {index} of {total} of one continuous routine to the full song. "
        f"This segment is {segment['energy']} energy compared with the rest of the song."
    ]
    if index == total:
        lines.append("This is the final segment: bring the routine to a clear ending pose.")
    if segment.get("chorus"):
        if signature:
            lines.append(
                f"This segment is a chorus. Repeat the chorus signature combo from segment {signature['segment']} "
                f"on the chorus lines, adapted to flow from the previous ending: {signature['combo']}"
            )
        else:
            lines.append(
                "This segment is the first chorus. Create a memorable signature hook combo for the chorus lines; "
                "it will be repeated on every later chorus."
            )
    if segment.get("overlap"):
        handoff = format_timestamp(segment["overlap"] / FPS)
        lines.append(
            f"This clip is generated as a video continuation: from 00:00.000 to {handoff} it re-creates the last "
            f"moments of the previous segment exactly. Begin by continuing the move already in progress until "
            f"{handoff}, then carry on with this segment's moves."
        )
    if history:
        earlier = [entry["ending"] for entry in history[:-1] if entry["ending"]]
        if earlier:
            lines.append("Where earlier segments left off:\n" + "\n".join(f"- {ending}" for ending in earlier[-4:]))
        previous = history[-1]
        lines.append(
            "The previous segment's choreography was:\n\"\"\"\n" + previous["choreography"] + "\n\"\"\"\n"
            + (f"At its last moment: {previous['ending']}\n" if previous["ending"] else "")
            + (f"The routine was about to continue like this; start this clip from it:\n\"\"\"\n{previous['next_plan']}\n\"\"\"\n"
               if previous.get("next_plan") else "")
            + "CONTINUE the routine mid-flow: do not repeat its moves, keep the same style and character, and "
            "never pause or reset to a neutral stance. Timestamps restart at 00:00.000 at the start of this clip."
        )
    return "\n\n".join(lines)


def lookahead_instruction(clip_seconds: float, next_energy: str) -> str:
    """Asks for one paragraph past the clip end; code cuts it, so the clip never winds down."""
    stamp = format_timestamp(clip_seconds)
    return (
        f"The routine keeps going after this clip: the video simply cuts mid-phrase at {stamp}. Write ONE extra "
        f"final paragraph for the next few seconds after the cut ({next_energy} song-relative loudness), beginning exactly with "
        f"\"At {stamp}, \". Maintain the intended activity right up to {stamp}, including deliberate stillness "
        "when directed. Do not add an ending or unrelated stunt just because this clip stops."
    )


_WIND_DOWN = re.compile(
    r"\b(prepar\w*|ready (?:for|to)|poised|waiting|awaits?|braces?|anticipat\w*|"
    r"holds? (?:the|her|his|their) (?:position|pose|stance)|comes? to (?:a )?(?:rest|stop|standstill)|settles?)\b",
    re.IGNORECASE,
)


def split_lookahead(choreography: str, clip_seconds: float) -> tuple[str, str]:
    """Cut the text at the first timestamp at or past the clip end. Returns (kept, cut)."""
    for match in _TIMESTAMP.finditer(choreography):
        seconds = int(match.group(1)) * 60 + int(match.group(2)) + int(match.group(3)) / 1000
        if seconds >= clip_seconds - 0.01:
            return choreography[:match.start()].rstrip(), choreography[match.start():].strip()
    return choreography, ""


def wind_down_warning(choreography: str) -> str:
    paragraphs = [p for p in re.split(r"\n\s*\n", choreography) if p.strip()]
    found = _WIND_DOWN.search(paragraphs[-1]) if paragraphs else None
    return (
        f"WARNING: The clip may end in a waiting pose (\"{found.group(0)}\" in the last paragraph); consider re-rolling."
        if found else ""
    )


def format_music_analysis(analysis: dict[str, Any]) -> str:
    lines = [f"Duration: {analysis['duration']:.2f} s"]
    if analysis["trimmed"]:
        lines[0] += f" (trimmed from {analysis['source_duration']:.2f} s)"
    lines.append(f"Tempo: {analysis['bpm']:.0f} BPM" if analysis["bpm"] else "Tempo: not detected")
    if analysis.get("beat_error"):
        lines.append(f"Beat detection failed ({analysis['beat_error']}); using fixed 3 s phrases.")
    for phrase in analysis["phrases"]:
        lines.append(
            f"{format_timestamp(phrase['start'])} - {format_timestamp(phrase['end'])}: {phrase['energy']} energy"
        )
    return "\n".join(lines)


def build_user_message(
    style: str,
    style_notes: str,
    subject_description: str,
    pronoun: str,
    location_description: str,
    has_location_image: bool,
    energy_arc: str,
    analysis: dict[str, Any],
    use_timeline: bool,
    image_notes: list[str],
    styles: dict[str, dict[str, Any]] | None = None,
    continuation: str = "",
    song_context: str = "",
    ask_signature: bool = False,
    lip_sync: bool = False,
    choose_location: bool = False,
    lookahead: str = "",
) -> str:
    styles = load_styles() if styles is None else styles
    parts = ["Write the choreography for a single continuous dance shot."]

    seed = styles.get(style)
    if seed:
        parts.append(
            f"Dance style: {style}. Feel: {seed['feel']}. "
            f"Signature moves to draw from (use several, not all): {', '.join(seed['signature_moves'])}. "
            f"Dynamics: {seed['dynamics']}."
        )
    if _clean(style_notes):
        parts.append(f"Creative direction from the user (highest priority): {_clean(style_notes)}")

    parts.append(f"The dancer <Subject 1> is {_clean(subject_description) or 'the dancer'} (pronouns: {pronoun}).")
    if has_location_image:
        parts.append("The location is <Subject 3>." + (f" Details: {_clean(location_description)}" if _clean(location_description) else ""))
    elif choose_location:
        parts.append(
            "Choose ONE specific, filmable location that suits the music, the dance style, and the outfit"
            + (f" (user guidance: {_clean(location_description)})" if _clean(location_description) else "")
            + ". Report it under the LOCATION header. Mention interaction with it in the choreography only if natural."
        )
    elif _clean(location_description):
        parts.append(f"Location (describe interaction with it only if natural, do not label it): {_clean(location_description)}")

    if image_notes:
        parts.append(
            "Attached images: " + " ".join(image_notes) + " Use them ONLY to choose moves that suit the clothing, "
            "footwear, and hair, and to describe how they move. Do not describe their appearance."
        )

    duration = analysis["duration"]
    music = f"The music is {duration:.2f} seconds long"
    music += f" at about {analysis['bpm']:.0f} BPM." if analysis["bpm"] else "."
    parts.append(music + f" Energy arc: {energy_arc}.")

    if use_timeline and len(analysis["phrases"]) > 1:
        timeline = "\n".join(
            f"- {format_timestamp(p['start'])} to {format_timestamp(p['end'])}: {p['energy']} energy"
            for p in analysis["phrases"]
        )
        parts.append(
            "Follow this musical timeline. Write one short paragraph per phrase, matching each phrase's energy. "
            "The first paragraph has no timestamp. Every later paragraph MUST begin with its start time in exactly "
            'this form: "At 00:03.200, ".\n' + timeline
        )
    else:
        parts.append("Write two or three paragraphs that develop the routine over the whole clip.")

    if song_context:
        parts.append(song_context)
    if lip_sync:
        parts.append(
            "The dancer sings along to the lyrics. During sung lines keep the face toward the camera and favor "
            "body, arm, and footwork moves over head spins or turning away. Do not write the lyrics yourself."
        )
    if continuation:
        parts.append(continuation)
    if lookahead:
        parts.append(lookahead)

    headers = [
        "STYLE_INTRO: <one or two sentences beginning \"The target video is\" that describe the overall "
        "dance style, attitude, and energy>",
        "ACTION_SUMMARY: <a short verb phrase for the summary, e.g. \"performs an energetic, stylish hip-hop dance\">",
        "CHOREOGRAPHY:\n<the paragraphs>",
    ]
    if continuation:
        headers.append(
            "ENDING_STATE: <one sentence: which move is in progress at the clip's last moment, facing direction, "
            "level, and which foot carries the weight>"
        )
    if choose_location:
        # first, so the choreography is written for the setting the model commits to
        headers.insert(0, (
            "LOCATION: <a short noun phrase for the setting, starting with \"a\" or \"an\", "
            "e.g. \"a neon-lit rooftop at night\">"
        ))
    if ask_signature:
        headers.append(
            "SIGNATURE_COMBO: <one or two sentences naming the chorus hook combo you used, so later choruses "
            "can repeat it>"
        )
    counts = {3: "three", 4: "four", 5: "five", 6: "six"}
    parts.append(
        "The first paragraph must begin with \"<Subject 1>, wearing <Subject 2>,\". "
        "Keep the choreography between 180 and 380 words.\n\n"
        f"Output format (exactly these {counts[len(headers)]} headers, nothing before or after):\n"
        + "\n".join(headers)
    )
    return "\n\n".join(parts)


_SECTION = re.compile(
    r"^\s*\**\s*(STYLE_INTRO|ACTION_SUMMARY|CHOREOGRAPHY|ENDING_STATE|ENDING_POSITION|SIGNATURE_COMBO|LOCATION)\s*\**\s*:\s*",
    re.IGNORECASE | re.MULTILINE,
)
_TIMESTAMP = re.compile(r"\bAt (\d{2}):(\d{2})\.(\d{3})")


def strip_reasoning(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    if "</think>" in text:
        text = text.split("</think>", 1)[1]
    return text.replace("```", "").strip()


def parse_llm_response(text: str, style: str) -> tuple[dict[str, str], list[str]]:
    warnings: list[str] = []
    text = strip_reasoning(text)
    matches = list(_SECTION.finditer(text))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections.setdefault(match.group(1).upper(), text[match.end():end].strip())

    choreography = sections.get("CHOREOGRAPHY", "")
    if not choreography:
        warnings.append("WARNING: LLM response had no CHOREOGRAPHY header; using the whole response.")
        choreography = _SECTION.sub("", text).strip()
    choreography = re.sub(r"\*\*|__|^#+\s*", "", choreography, flags=re.MULTILINE).strip()

    style_name = style if style != CUSTOM_STYLE else "dance"
    intro = _clean(sections.get("STYLE_INTRO"))
    if not intro:
        warnings.append("WARNING: LLM gave no STYLE_INTRO; using a generic one.")
        intro = f"The target video is a {style_name} performance with confident, expressive movement."

    summary = _clean(sections.get("ACTION_SUMMARY")).strip("\"'").rstrip(".")
    summary = re.sub(r"^(<Subject 1>\s*)?(wears <Subject 2> and\s*)?", "", summary).strip()
    if not summary:
        warnings.append("WARNING: LLM gave no ACTION_SUMMARY; using a generic one.")
        summary = f"performs an expressive {style_name} dance"
    summary = summary[0].lower() + summary[1:]

    if "<Subject 1>" not in choreography:
        warnings.append("WARNING: Choreography never named <Subject 1>; an opening sentence was added.")
        choreography = f"<Subject 1>, wearing <Subject 2>, dances. {choreography}"
    return {
        "style_intro": intro,
        "action_summary": summary,
        "action_details": choreography,
        "ending": _clean(sections.get("ENDING_STATE") or sections.get("ENDING_POSITION")),
        "signature": _clean(sections.get("SIGNATURE_COMBO")),
        "location": _clean(sections.get("LOCATION")).strip("\"'").rstrip("."),
    }, warnings


def check_timestamps(choreography: str, duration: float) -> list[str]:
    warnings = []
    previous = 0.0
    for match in _TIMESTAMP.finditer(choreography):
        seconds = int(match.group(1)) * 60 + int(match.group(2)) + int(match.group(3)) / 1000
        if seconds <= previous:
            warnings.append(f"WARNING: Timestamp {match.group(0)[3:]} is not after the previous one.")
        if seconds >= duration:
            warnings.append(f"WARNING: Timestamp {match.group(0)[3:]} is past the {duration:.2f} s clip.")
        previous = max(previous, seconds)
    return warnings
