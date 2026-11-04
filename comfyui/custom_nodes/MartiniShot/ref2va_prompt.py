"""Deterministic MiniMax H3 Ref2VA (omni reference) prompt formatting and validation.

Produces the six official Ref2VA sections: subject_definitions, summary,
retention_analysis, detailed_description, overall_soundscape, non_diegetic_music.
"""

from __future__ import annotations

import re
from typing import Any

try:
    from .h3_prompt import (
        _clean,
        _lower_first,
        _sentence,
        format_camera_motion,
        format_cut_time,
        format_dialogue,
    )
except ImportError:  # imported as a top-level module by the tests
    from h3_prompt import (
        _clean,
        _lower_first,
        _sentence,
        format_camera_motion,
        format_cut_time,
        format_dialogue,
    )


SUBJECT_KINDS = (
    "Person / Character",
    "Outfit / Wardrobe",
    "Environment / Location",
    "Object / Prop",
    "Visual Style",
)
RETENTION_MARKERS = (
    "fully_preserved",
    "partially_preserved",
    "attribute_transfer",
    "weak_reference",
)
AUDIO_CONTENT_TYPES = ("Music", "Voice / Speech", "Sound Effects / Ambience")
AUDIO_USAGES = ("fully_copy", "partially_copy", "reference", "weak_reference")
PRONOUNS = {
    "she / her": ("she", "her", "her"),
    "he / him": ("he", "him", "his"),
    "they / them": ("they", "them", "their"),
    "it / its": ("it", "it", "its"),
}

_KIND_DEFAULTS = {
    # kind: (fallback description, default preserve list, default retention note)
    "Person / Character": (
        "the person",
        "facial identity, hairstyle, hair color, body proportions, and overall appearance",
        "{Their} facial features, hairstyle, body shape, and identity remain consistent throughout the video.",
    ),
    "Outfit / Wardrobe": (
        "the outfit",
        "design, colors, materials, and accessories",
        "The outfit remains visually consistent while moving naturally with the motion.",
    ),
    "Environment / Location": (
        "the environment",
        "spatial layout, architecture, lighting, and key features",
        "The environment's layout, lighting, and key features remain consistent throughout the video.",
    ),
    "Object / Prop": (
        "the object",
        "shape, size, colors, materials, and surface details",
        "The object keeps its shape, size, materials, and surface details throughout the video.",
    ),
    "Visual Style": (
        "the visual style",
        "color palette, lighting, texture, and rendering style",
        "The video's color palette, lighting, and rendering follow the referenced style.",
    ),
}

_LABEL_PATTERN = re.compile(r"<(Subject|Picture|Audio|Video) (\d+)>")


def subject_label(number: int) -> str:
    return f"<Subject {int(number)}>"


def audio_label(number: int) -> str:
    return f"<Audio {int(number)}>"


def _capitalize(value: str) -> str:
    return value[0].upper() + value[1:] if value else value


def _noun_phrase(value: str) -> str:
    """Lowercase a leading article so "The woman" reads "<Subject 1> is the woman"."""
    head, _, rest = value.partition(" ")
    return f"{head.lower()} {rest}" if rest and head in {"The", "A", "An"} else value


def _paragraphs(value: Any) -> list[str]:
    """Split on blank lines and normalize whitespace inside each paragraph."""
    blocks = re.split(r"\n\s*\n", str(value or ""))
    return [_sentence(block) for block in blocks if _clean(block)]


def _pronoun_forms(pronoun: str) -> dict[str, str]:
    they, them, their = PRONOUNS.get(pronoun, PRONOUNS["they / them"])
    return {
        "they": they,
        "them": them,
        "their": their,
        "They": _capitalize(they),
        "Their": _capitalize(their),
    }


def format_subject_definition(subject: dict[str, Any]) -> str:
    override = _clean(subject.get("definition_override"))
    if override:
        return _sentence(override)

    label = subject_label(subject["number"])
    picture = f"<Picture {int(subject['picture_number'])}>"
    kind = subject["kind"]
    fallback, default_preserve, _ = _KIND_DEFAULTS[kind]
    description = _noun_phrase(_clean(subject.get("description")) or fallback)
    preserve = _clean(subject.get("preserve")) or default_preserve
    forms = _pronoun_forms(subject.get("pronoun", "they / them"))

    if kind == "Visual Style":
        return f"{label} is {description} shown in {picture}. Follow its {preserve}."
    result = f"{label} is {description} shown in {picture}."
    if kind == "Person / Character":
        return result + f" Preserve {forms['their']} {preserve}."
    if kind == "Outfit / Wardrobe" and int(subject.get("wearer") or 0):
        wearer = subject_label(subject["wearer"])
        return result + f" Transfer the complete outfit onto {wearer}, preserving its {preserve}."
    return result + f" Preserve its {preserve}."


def format_audio_definition(audio: dict[str, Any]) -> str:
    label = audio_label(audio["number"])
    content = audio["content_type"]
    usage = audio["usage"]
    description = _clean(audio.get("description")) or {
        "Music": "the reference music track",
        "Voice / Speech": "the reference voice recording",
        "Sound Effects / Ambience": "the reference sound recording",
    }[content]

    if usage == "fully_copy":
        role = {
            "Music": "background music",
            "Voice / Speech": "spoken audio",
            "Sound Effects / Ambience": "sound bed",
        }[content]
        detail = f"It is reused unchanged as the {role} of the target video."
    elif usage == "partially_copy":
        detail = "Portions of it are reused in the target video's audio."
    elif usage == "reference":
        detail = {
            "Music": "Its tempo, rhythm, and energy guide the target video's audio and motion without copying the signal.",
            "Voice / Speech": "Its voice timbre and delivery guide the target speaker without copying the signal.",
            "Sound Effects / Ambience": "Its sonic character guides the target video's sound design without copying the signal.",
        }[content]
    else:
        detail = "Only its broad style and atmosphere guide the target video's audio."
    return f"{label} is {_noun_phrase(description)}. {detail}"


def _default_audio_retention(audio: dict[str, Any]) -> str:
    label = audio_label(audio["number"])
    usage = audio["usage"]
    content = audio["content_type"]
    if usage == "fully_copy":
        note = f"{label} is reused unchanged in the target video's audio"
        if content == "Music":
            note = f"{label} is reused unchanged as the background music"
        if audio.get("sync_motion_to_beat"):
            note += ", and on-screen motion is timed to its beat"
        return note + "."
    if usage == "partially_copy":
        return f"portions of {label} are reused while the rest of the audio is newly generated."
    if usage == "reference":
        if content == "Voice / Speech":
            return f"the target speaker follows {label}'s voice timbre and delivery without copying the original signal."
        if content == "Music":
            return f"the target video's music and movement follow {label}'s tempo, rhythm, and energy without copying the original signal."
        return f"the target video's sound design follows {label}'s sonic character without copying the original signal."
    return f"only {label}'s broad style and atmosphere are retained."


def format_ref2va_shot(shot: dict[str, Any], index: int) -> str:
    paragraphs = _paragraphs(shot.get("description"))
    if index > 1:
        opening = f"At {format_cut_time(shot['cut_time'])}, {shot['transition']}"
        if paragraphs:
            paragraphs[0] = f"{opening} {_lower_first(paragraphs[0])}"
        else:
            paragraphs = [_sentence(opening)]

    closing: list[str] = []
    camera = format_camera_motion(
        shot.get("camera_motion", "None"),
        shot.get("camera_amplitude", "Default"),
        shot.get("camera_speed", "Default"),
        shot.get("camera_action_or_target", ""),
    )
    if camera:
        closing.append(camera)
    for dialogue in shot.get("dialogues", ()):
        closing.append(format_dialogue(dialogue))
    if _clean(shot.get("diegetic_audio")):
        closing.append(_sentence(shot["diegetic_audio"]))
    if closing:
        paragraphs.append(" ".join(closing))
    return f"[Shot {index}] " + "\n\n".join(paragraphs)


def _shots_mentioning(label: str, shot_texts: list[str]) -> list[int]:
    return [index for index, text in enumerate(shot_texts, start=1) if label in text]


def auto_task_prefix(subjects: list[dict[str, Any]], audios: list[dict[str, Any]]) -> str:
    tags: list[str] = []
    if subjects or any(audio["usage"] in {"reference", "weak_reference"} for audio in audios):
        tags.append("reference generation")
    if any(audio["usage"] in {"fully_copy", "partially_copy"} for audio in audios):
        tags.append("audio reuse")
    if any(audio["usage"] in {"reference", "weak_reference"} for audio in audios):
        tags.append("audio reference")
    return "[" + " + ".join(tags or ["reference generation"]) + "]"


def auto_non_diegetic_music(audios: list[dict[str, Any]]) -> str:
    for audio in audios:
        if audio["content_type"] != "Music":
            continue
        label = audio_label(audio["number"])
        if audio["usage"] in {"fully_copy", "partially_copy"}:
            return f"{label} is reused as the background music."
        if audio["usage"] == "reference":
            return f"Background music follows {label}'s instrumentation, tempo, and rhythm."
    return "N/A"


def validate_ref2va_inputs(
    subjects: list[dict[str, Any]],
    audios: list[dict[str, Any]],
    shots: list[dict[str, Any]],
    summary: str,
) -> list[str]:
    warnings: list[str] = []
    if not subjects and not audios:
        warnings.append("ERROR: Ref2VA requires at least one subject or audio reference.")
    if not _clean(summary):
        warnings.append("ERROR: summary is required.")
    if not shots or not _clean(shots[0].get("description")):
        warnings.append("ERROR: Shot 1 needs a description.")

    subject_numbers = [int(subject["number"]) for subject in subjects]
    for number in sorted({n for n in subject_numbers if subject_numbers.count(n) > 1}):
        warnings.append(f"ERROR: <Subject {number}> is defined more than once.")
    if subject_numbers and sorted(set(subject_numbers)) != list(range(1, len(set(subject_numbers)) + 1)):
        warnings.append("WARNING: Subject numbers should run 1, 2, 3... without gaps.")
    audio_numbers = [int(audio["number"]) for audio in audios]
    for number in sorted({n for n in audio_numbers if audio_numbers.count(n) > 1}):
        warnings.append(f"ERROR: <Audio {number}> is connected more than once.")

    for subject in subjects:
        wearer = int(subject.get("wearer") or 0)
        if subject["kind"] != "Outfit / Wardrobe" or not wearer:
            continue
        if wearer == int(subject["number"]):
            warnings.append(f"ERROR: <Subject {subject['number']}> cannot be worn by itself.")
        elif wearer not in subject_numbers:
            warnings.append(
                f"ERROR: <Subject {subject['number']}> is worn by <Subject {wearer}>, which is not defined."
            )

    previous = 0.0
    for index, shot in enumerate(shots[1:], start=2):
        cut_time = float(shot["cut_time"])
        if cut_time <= previous:
            warnings.append(f"ERROR: Shot {index} cut time must be strictly increasing.")
        previous = cut_time

    body = " ".join(
        [summary] + [str(shot.get("description") or "") for shot in shots]
    )
    declared = {("Subject", n) for n in subject_numbers} | {("Audio", n) for n in audio_numbers}
    for kind, number in sorted({(k, int(n)) for k, n in _LABEL_PATTERN.findall(body)}):
        if kind == "Picture":
            warnings.append(
                f"WARNING: <Picture {number}> is used outside subject_definitions; refer to the "
                "<Subject N> defined from it unless the picture is a literal frame anchor."
            )
        elif (kind, number) not in declared:
            warnings.append(f"ERROR: <{kind} {number}> is used but never defined.")
    for number in subject_numbers:
        if subject_label(number) not in body:
            warnings.append(
                f"WARNING: <Subject {number}> is defined but never mentioned in summary or shots."
            )

    return warnings


def build_ref2va_prompt(
    subjects: list[dict[str, Any]],
    audios: list[dict[str, Any]],
    shots: list[dict[str, Any]],
    summary: str,
    style_intro: str,
    overall_soundscape: str = "",
    non_diegetic_music: str = "",
    task_prefix: str = "",
    include_audio_sections: bool = True,
) -> tuple[str, list[str]]:
    subjects = sorted(subjects, key=lambda subject: int(subject["number"]))
    audios = sorted(audios, key=lambda audio: int(audio["number"]))
    warnings = validate_ref2va_inputs(subjects, audios, shots, summary)
    if include_audio_sections and not _clean(overall_soundscape):
        warnings.append("WARNING: overall_soundscape is empty and is written as N/A (complete silence).")

    definitions = [format_subject_definition(subject) for subject in subjects]
    definitions += [format_audio_definition(audio) for audio in audios]

    summary_text = _sentence(summary)
    if not summary_text.startswith("["):
        prefix = _clean(task_prefix) or auto_task_prefix(subjects, audios)
        if not prefix.startswith("["):
            prefix = f"[{prefix}]"
        summary_text = f"{prefix} {summary_text}"

    shot_texts = [format_ref2va_shot(shot, index) for index, shot in enumerate(shots, start=1)]
    all_shots = list(range(1, len(shots) + 1))
    retention = []
    for subject in subjects:
        label = subject_label(subject["number"])
        appears = _shots_mentioning(label, shot_texts) or all_shots
        appears_text = ", ".join(f"[Shot {index}]" for index in appears)
        forms = _pronoun_forms(subject.get("pronoun", "they / them"))
        note = _clean(subject.get("retention_note")) or _KIND_DEFAULTS[subject["kind"]][2].format(**forms)
        retention.append(f"{label} (appears in {appears_text}): {subject['retention']} - {_sentence(note)}")
    for audio in audios:
        note = _clean(audio.get("retention_note")) or _default_audio_retention(audio)
        retention.append(f"{audio_label(audio['number'])}: {audio['usage']} - {_sentence(note)}")

    intro = _paragraphs(style_intro)
    synced = [
        audio_label(audio["number"])
        for audio in audios
        if audio.get("sync_motion_to_beat") and audio["content_type"] == "Music"
    ]
    if synced:
        sync = f"All movement is synchronized to the beat and musical accents of {' and '.join(synced)}."
        intro = [" ".join(intro + [sync])] if intro else [sync]

    sections = [
        "subject_definitions:\n" + "\n\n".join(definitions),
        "summary:\n" + summary_text,
        "retention_analysis:\n" + "\n\n".join(retention),
        "detailed_description:\n" + "\n\n".join(intro + shot_texts),
    ]
    if include_audio_sections:
        soundscape = _sentence(overall_soundscape) if _clean(overall_soundscape) else "N/A"
        music = _sentence(non_diegetic_music) if _clean(non_diegetic_music) else auto_non_diegetic_music(audios)
        sections.append("overall_soundscape:\n" + soundscape)
        sections.append("non_diegetic_music:\n" + music)
    return "\n\n".join(sections), warnings


def build_ref2va_manifest(subjects: list[dict[str, Any]], audios: list[dict[str, Any]]) -> str:
    lines = []
    for subject in sorted(subjects, key=lambda s: int(s["number"])):
        name = _clean(subject.get("description")) or _KIND_DEFAULTS[subject["kind"]][0]
        lines.append(
            f"{subject_label(subject['number'])} — {name} — {subject['kind']} — "
            f"<Picture {subject['picture_number']}> — {subject['target_socket']}"
        )
    for audio in sorted(audios, key=lambda a: int(a["number"])):
        lines.append(
            f"{audio_label(audio['number'])} — {audio['content_type']} — {audio['usage']} — "
            f"{audio['target_socket']}"
        )
    return "\n".join(lines) or "No references connected."
