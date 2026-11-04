"""Deterministic MiniMax H3 prompt formatting and validation."""

from __future__ import annotations

import re
from typing import Any, Iterable


TASK_TYPES = ("T2VA", "R2VA", "I2VA", "FL2VA", "L2VA")
REFERENCE_ROLES = (
    "Subject / Character",
    "Outfit / Wardrobe",
    "Environment / Location",
    "Object / Prop",
    "Visual Style",
    "Opening Frame",
    "Ending Frame",
    "General Reference",
)
CAMERA_MOTIONS = (
    "None",
    "Zoom In",
    "Zoom Out",
    "Push In",
    "Pull Out",
    "Pan Left",
    "Pan Right",
    "Truck Left",
    "Truck Right",
    "Tilt Up",
    "Tilt Down",
    "Pedestal Up",
    "Pedestal Down",
    "Arc Shot",
    "Tracking Shot",
    "Static Shot",
    "Shake Slightly",
    "Shake Strongly",
    "POV",
    "Roll Clockwise",
    "Roll Counterclockwise",
)
AMPLITUDES = ("Default", "Small", "Large")
CAMERA_SPEEDS = ("Default", "Slow", "Fast")
TRANSITIONS = (
    "the camera cuts to",
    "the shot cuts to",
    "the shot transitions to",
    "the shot changes to",
    "the shot switches to",
    "cross-dissolve to",
    "fade to",
    "wipe to",
)

_MOTION_PHRASES = {
    "Zoom In": "The camera zooms in",
    "Zoom Out": "The camera zooms out",
    "Push In": "The camera pushes in",
    "Pull Out": "The camera pulls out",
    "Pan Left": "The camera pans left",
    "Pan Right": "The camera pans right",
    "Truck Left": "The camera trucks left",
    "Truck Right": "The camera trucks right",
    "Tilt Up": "The camera tilts up",
    "Tilt Down": "The camera tilts down",
    "Pedestal Up": "The camera moves upward on a pedestal",
    "Pedestal Down": "The camera moves downward on a pedestal",
    "Arc Shot": "The camera moves in an arc around the subject",
    "Tracking Shot": "The camera follows the subject in a tracking shot",
    "Static Shot": "The camera holds a static shot",
    "Shake Slightly": "The camera shakes slightly",
    "Shake Strongly": "The camera shakes strongly",
    "POV": "The camera presents the subject's point of view",
    "Roll Clockwise": "The camera rolls clockwise",
    "Roll Counterclockwise": "The camera rolls counterclockwise",
}


def _clean(value: Any) -> str:
    return " ".join(str(value or "").strip().split())


def _sentence(value: Any) -> str:
    text = _clean(value)
    if text and text[-1] not in ".!?\"'":
        text += "."
    return text


def _lower_first(value: str) -> str:
    if not value:
        return value
    return value[0].lower() + value[1:]


def format_seconds(seconds: float) -> str:
    return f"{float(seconds):.2f}"


def format_cut_time(seconds: float) -> str:
    total_ms = round(float(seconds) * 1000)
    minutes, remainder = divmod(total_ms, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f"{minutes:02d}:{whole_seconds:02d}.{milliseconds:03d}"


def format_camera_motion(
    motion: str, amplitude: str, speed: str, action_or_target: str
) -> str:
    if motion == "None":
        return ""
    phrase = _MOTION_PHRASES[motion]
    if motion not in {"Static Shot", "Shake Slightly", "Shake Strongly", "POV"}:
        if amplitude != "Default":
            phrase += f" with {amplitude.lower()} amplitude"
        if speed != "Default":
            phrase += f" at {speed.lower()} speed"
    detail = _clean(action_or_target)
    if detail:
        phrase += " " + _lower_first(detail)
    return _sentence(phrase)


def format_dialogue(entry: dict[str, Any]) -> str:
    identity = _clean(entry["speaker_identity"])
    if identity:
        identity = identity[0].upper() + identity[1:]
    speaker_id = _clean(entry["speaker_id"]).upper()
    vocal_type = entry["vocal_type"]
    language = _clean(entry["language"])
    # Dialogue content is deliberately not stripped or normalized.
    content = str(entry["content"])
    delivery = _clean(entry["delivery"])

    subject = f"{identity} ({speaker_id})"
    if vocal_type == "Voiceover":
        result = (
            f"{subject} says in an off-screen voiceover: "
            f"<d>[{language}] {content}</d> while the corresponding on-screen "
            "character's lips remain completely closed."
        )
    elif vocal_type == "Singing":
        verb = delivery or "sings"
        result = f"{subject} {verb}: <d>[{language}] {content}</d>"
    else:
        verb = delivery or "says"
        result = f"{subject} {verb}: <d>[{language}] {content}</d>"

    if entry.get("continues_across_cut"):
        result += " The audio continues seamlessly across the cut."
    if entry.get("cutoff_at_end"):
        result = result.replace("</d>", "<cutoff></d>", 1)
    return _sentence(result)


def format_reference(reference: dict[str, Any]) -> str:
    number = int(reference["picture_number"])
    tag = f"<Picture {number}>"
    name = _clean(reference["reference_name"])
    role = reference["role"]
    notes = _clean(reference.get("usage_notes"))
    named_tag = f"{tag} ({name})" if name else tag

    if role == "Subject / Character":
        phrase = f"The subject shown in {named_tag} remains visually consistent"
    elif role == "Outfit / Wardrobe":
        phrase = (
            f"The subject wears the outfit shown in {named_tag}, keeping its clothing "
            "design, materials, colors, fit, accessories, and layering consistent"
        )
    elif role == "Environment / Location":
        phrase = f"The environment and spatial layout follow {named_tag}"
    elif role == "Object / Prop":
        phrase = f"The referenced object follows {named_tag}"
    elif role == "Visual Style":
        phrase = f"The visual treatment follows the style shown in {named_tag}"
    elif role == "Opening Frame":
        phrase = f"The shot begins from the state and composition shown in {named_tag}"
    elif role == "Ending Frame":
        phrase = f"The shot progresses toward the state and composition shown in {named_tag}"
    else:
        phrase = f"The shot references {named_tag}"
    if notes:
        phrase += ", preserving " + _lower_first(notes)
    return _sentence(phrase)


def format_shot(shot: dict[str, Any], index: int) -> str:
    parts: list[str] = []
    scene = _clean(shot["composition_and_scene"])
    style = _clean(shot["visual_style"])

    if index == 1:
        opening = ", ".join(part for part in (style, scene) if part)
        if opening:
            parts.append(_sentence(opening))
    else:
        transition = shot["transition"]
        opening = f"At {format_cut_time(shot['cut_time'])}, {transition}"
        if scene:
            opening += " " + _lower_first(scene)
        parts.append(_sentence(opening))
        if style:
            parts.append(_sentence(style))

    for field in ("subject_details", "action_and_reaction"):
        if shot.get(field):
            parts.append(_sentence(shot[field]))

    for reference in shot.get("references", []):
        parts.append(format_reference(reference))

    camera = format_camera_motion(
        shot["camera_motion"],
        shot["camera_amplitude"],
        shot["camera_speed"],
        shot["camera_action_or_target"],
    )
    if camera:
        parts.append(camera)

    for dialogue in shot.get("dialogues", []):
        parts.append(format_dialogue(dialogue))

    if shot.get("visible_text"):
        parts.append(_sentence(shot["visible_text"]))
    if shot.get("diegetic_audio"):
        parts.append(_sentence(shot["diegetic_audio"]))
    if shot.get("keyframe_path_or_landing"):
        parts.append(_sentence(shot["keyframe_path_or_landing"]))

    return f"[Shot {index}] " + " ".join(part for part in parts if part)


def alignment_instruction(task_type: str, duration: float, final_shot: int) -> str:
    end = format_seconds(duration)
    if task_type in {"T2VA", "R2VA"}:
        return ""
    if task_type == "I2VA":
        return (
            "For the target video, at 0.00 seconds into the target video, "
            "<Picture 1> (from [Shot 1]) is fully referenced."
        )
    if task_type == "FL2VA":
        return (
            "How the reference pictures align with the target video — "
            "Picture 1 (from Shot 1) aligns with the 0.00-second mark of the "
            f"target video; Picture 2 (from Shot {final_shot}) aligns with the "
            f"{end}-second mark of the target video."
        )
    return (
        "How the reference pictures align with the target video — "
        f"<Picture 1> (from [Shot {final_shot}]) aligns with the "
        f"{end}-second mark of the target video."
    )


def validate_prompt_inputs(
    task_type: str,
    duration: float,
    shots: list[dict[str, Any]],
    complete_silence: bool,
    sound_parts: Iterable[str],
    no_music: bool,
    music_parts: Iterable[str],
) -> list[str]:
    warnings: list[str] = []
    if not shots:
        warnings.append("ERROR: At least one shot is required.")
        return warnings
    if duration <= 0:
        warnings.append("ERROR: Duration must be greater than zero.")
    if shots[0]["cut_time"] != 0:
        warnings.append("WARNING: Shot 1 cut time is ignored; Shot 1 never has a timestamp.")

    previous = 0.0
    for index, shot in enumerate(shots[1:], start=2):
        cut_time = float(shot["cut_time"])
        if cut_time <= previous:
            warnings.append(f"ERROR: Shot {index} cut time must be strictly increasing.")
        if cut_time >= duration:
            warnings.append(f"ERROR: Shot {index} cut time must fall within the video duration.")
        previous = cut_time

    if complete_silence and any(_clean(value) for value in sound_parts):
        warnings.append("WARNING: Soundscape inputs are ignored because complete silence is enabled.")
    if not complete_silence and not any(_clean(value) for value in sound_parts):
        warnings.append(
            "ERROR: Add at least one soundscape detail or enable complete silence."
        )
    if no_music and any(_clean(value) for value in music_parts):
        warnings.append("WARNING: Music inputs are ignored because no music is enabled.")
    if not no_music and not any(_clean(value) for value in music_parts):
        warnings.append(
            "ERROR: Add at least one non-diegetic music detail or enable no music."
        )
    if task_type == "FL2VA" and not any(
        _clean(shot.get("keyframe_path_or_landing")) for shot in shots
    ):
        warnings.append("WARNING: FL2VA should describe a path that lands on Picture 2.")
    if task_type == "L2VA" and not _clean(shots[-1].get("keyframe_path_or_landing")):
        warnings.append("WARNING: L2VA's final shot should describe convergence on Picture 1.")

    references = [
        reference
        for shot in shots
        for reference in shot.get("references", ())
    ]
    if task_type == "R2VA" and not references:
        warnings.append("ERROR: R2VA requires at least one reference image.")
    by_number: dict[int, tuple[str, str]] = {}
    for reference in references:
        number = int(reference["picture_number"])
        identity = (_clean(reference["reference_name"]), reference["role"])
        if number in by_number and by_number[number] != identity:
            warnings.append(
                f"ERROR: <Picture {number}> is assigned conflicting names or roles."
            )
        by_number[number] = identity

    speaker_id_pattern = re.compile(r"^S\d+(?:,S\d+)*$", re.IGNORECASE)
    for shot_index, shot in enumerate(shots, start=1):
        for dialogue in shot.get("dialogues", []):
            if not speaker_id_pattern.fullmatch(_clean(dialogue["speaker_id"])):
                warnings.append(
                    f"ERROR: Shot {shot_index} speaker ID must look like S1 or S1,S2."
                )
            if not _clean(dialogue["language"]):
                warnings.append(f"ERROR: Shot {shot_index} dialogue language is required.")
    return warnings


def build_prompt(
    task_type: str,
    duration: float,
    shots: list[dict[str, Any]],
    complete_silence: bool,
    ambient_sound: str,
    physical_action_sounds: str,
    human_nonverbal_sounds: str,
    no_music: bool,
    music_instrumentation: str,
    music_tempo_and_rhythm: str,
    music_dynamic_changes: str,
) -> tuple[str, list[str]]:
    sound_parts = (ambient_sound, physical_action_sounds, human_nonverbal_sounds)
    music_parts = (music_instrumentation, music_tempo_and_rhythm, music_dynamic_changes)
    warnings = validate_prompt_inputs(
        task_type, duration, shots, complete_silence, sound_parts, no_music, music_parts
    )

    instruction = alignment_instruction(task_type, duration, len(shots))
    description = " ".join(format_shot(shot, index) for index, shot in enumerate(shots, 1))
    soundscape = "N/A" if complete_silence else " ".join(
        _sentence(value) for value in sound_parts if _clean(value)
    )
    music = "N/A" if no_music else " ".join(
        _sentence(value) for value in music_parts if _clean(value)
    )

    sections = []
    if instruction:
        sections.append(instruction)
    sections.append(f"integrated_multimodal_description: {description}")
    sections.append(f"overall_soundscape: {soundscape}")
    sections.append(f"non_diegetic_music: {music}")
    return "\n\n".join(sections), warnings


def build_reference_manifest(shots: list[dict[str, Any]]) -> str:
    references: dict[int, dict[str, Any]] = {}
    used_in: dict[int, set[int]] = {}
    for shot_index, shot in enumerate(shots, start=1):
        for reference in shot.get("references", ()):
            number = int(reference["picture_number"])
            references.setdefault(number, reference)
            used_in.setdefault(number, set()).add(shot_index)
    if not references:
        return "No reusable reference images are attached to shots."

    lines = []
    for number in sorted(references):
        reference = references[number]
        shots_text = ", ".join(f"Shot {index}" for index in sorted(used_in[number]))
        socket = f"ref_image_{number - 1}"
        name = _clean(reference["reference_name"]) or "Unnamed reference"
        lines.append(
            f"<Picture {number}> — {name} — {reference['role']} — {socket} — {shots_text}"
        )
    return "\n".join(lines)
