"""LLM instructions and prompt assembly for the Music Video Director.

Pure logic. Each clip gets: a scene-type-specific system prompt, a user message
with the clip's labels, music, context, and output headers, and a deterministic
Ref2VA prompt built from the LLM's creative text.
"""

from __future__ import annotations

import re
from typing import Any

try:
    from .dance_writer import format_timestamp, strip_reasoning
    from .h3_prompt import _clean, _sentence
    from .ref2va_prompt import build_ref2va_prompt
except ImportError:  # imported as top-level modules by the tests
    from dance_writer import format_timestamp, strip_reasoning
    from h3_prompt import _clean, _sentence
    from ref2va_prompt import build_ref2va_prompt

FPS = 24
LLM_CAMERA = "LLM picks (experimental)"
AUTO = "(auto)"
INHERIT = "(inherit)"

_SHARED_RULES = """Labels:
- Reference labels such as <Subject 1> are listed in the message. Use them exactly, including the angle brackets, and never invent other labels such as <Picture 1>.

Rules:
- Describe concrete, observable action: body parts, direction, level, weight, and timing.
- Present tense. Natural English paragraphs. No lists, no markdown, no headings inside the text.
- Never describe faces, skin, hair color, or the colors, design, or materials of outfits, props, or places that come from reference images. You MAY describe how clothing, hair, and objects MOVE.
- You MAY describe how the scene's own light falls on the performer: its color, direction, reflections, and shadows on skin, hair, and clothing.
- Do not describe the music. Do not write dialogue or lyrics.
- Develop one principal action with natural secondary motion. Repeated rhythmic gestures are allowed; do not invent unrelated stunts merely to keep moving. Body mechanics are realistic.

Follow the output format exactly."""

ROLES = {
    "Dance": (
        "You are an expert dance choreographer writing the action for one clip of an AI-generated music video. "
        "Name moves, then show what the body does. Do not describe camera movement unless the message asks for a CAMERA line."
    ),
    "Performance": (
        "You are a music video director writing a vocal performance clip for an AI video generator. The performer "
        "sings to the camera: describe posture, gestures that follow the phrasing, emotional expression (not facial "
        "features), small steps and sways, and how they play to the lens. Keep it grounded and believable."
    ),
    "Freeform": (
        "You are a cinematic action writer for one clip of an AI-generated music video. Write exactly the action the "
        "user describes, as a believable continuous moment: what the subject does, how they interact with the place "
        "and any props, and natural secondary motion. Do not turn it into a dance unless the user asks."
    ),
    "B-roll": (
        "You are a cinematographer writing atmospheric B-roll for an AI-generated music video. There is no main "
        "performer: describe the place, light, weather, traffic, crowds, reflections, and other motion in the scene. "
        "People may appear only as background, never as the focus."
    ),
}


def system_prompt(scene_type: str) -> str:
    return ROLES[scene_type] + "\n\n" + _SHARED_RULES


def labels_text(refs: list[dict[str, Any]], subject_description: str, pronoun: str) -> str:
    lines = []
    for ref in refs:
        label = f"<Subject {ref['subject']}>"
        if ref["role"] == "person":
            lines.append(f"{label} is the main performer, {subject_description} (pronouns: {pronoun}).")
        elif ref["role"] == "outfit":
            lines.append(f"{label} is the outfit the performer wears.")
        elif ref["role"] == "location":
            lines.append(f"{label} is the location.")
        else:
            lines.append(f"{label} is {ref['name']}" + (f" ({ref['notes']})." if ref.get("notes") else "."))
    return "Reference labels:\n" + "\n".join(f"- {line}" for line in lines) if lines else "There are no reference labels."


def clip_context(
    clip: dict[str, Any], clips: list[dict[str, Any]], section: dict[str, Any], sections: list[dict[str, Any]],
    history: list[dict[str, str]],
) -> str:
    """Where the clip sits, how it joins the previous one, and what came before."""
    lines = [
        f"This is clip {clip['index']} of {len(clips)} of the video (shot {section['number']} of {len(sections)}). "
        f"Its music has {clip['energy']} RMS loudness relative to the whole song. This measures loudness, not emotion or required movement speed."
    ]
    if clip["index"] == len(clips):
        lines.append("This is the final clip of the video: bring it to a clear, satisfying ending.")
    previous = history[-1] if history else None
    transition = clip["transition"]

    if clip["index"] == 1 or transition == "Hard cut":
        if clip["index"] > 1:
            lines.append("This clip begins right after a hard cut to a new scene. Do not continue the previous clip's motion.")
            earlier = [h["summary"] for h in history if h.get("summary")][-4:]
            if earlier:
                lines.append("Earlier in the video (preserve story progress; do not repeat completed beats):\n"
                             + "\n".join(f"- {e}" for e in earlier))
        return "\n\n".join(lines)

    if transition == "New angle":
        lines.append(
            "This clip begins with a cut to a NEW CAMERA ANGLE on the same moment: continue the action from the previous "
            "clip without repeating it, as if seen from a different camera."
        )
    elif clip["overlap"]:
        handoff = format_timestamp(clip["overlap"] / FPS)
        lines.append(
            f"This clip continues the previous one with no cut: from 00:00.000 to {handoff} it re-creates the last "
            f"moments of the previous clip exactly. Continue the motion already in progress until {handoff}, then carry on."
        )
    else:
        lines.append("This clip continues the previous one in the same shot, with no cut.")
    if previous:
        block = "The previous clip's action was:\n\"\"\"\n" + previous["action"] + "\n\"\"\"\n"
        if previous.get("ending"):
            block += f"At its last moment: {previous['ending']}\n"
        if previous.get("next_plan"):
            block += f"It was about to continue like this; start this clip from it:\n\"\"\"\n{previous['next_plan']}\n\"\"\"\n"
        block += ("CONTINUE mid-flow: do not repeat it, keep the same character and style, and never pause or reset "
                  "to a neutral stance. Timestamps restart at 00:00.000 at the start of this clip.")
        lines.append(block)
    return "\n\n".join(lines)


def build_clip_message(
    *, scene_type: str, labels: str, scene_description: str, llm_notes: str, style_seed: dict[str, Any] | None,
    style_name: str, location_text: str, has_location_label: bool, analysis: dict[str, Any], beat_timeline: bool,
    context: str, lookahead: str, lyrics_block: str, lip_sync: bool, ask_signature: bool, signature: str,
    ask_camera: bool, previous_camera: str, ask_soundscape: bool, image_notes: list[str], music_description: str,
    camera_sentence: str = "", energy_contrast: str = "",
    ask_requirements: bool = False,
) -> str:
    parts = [f"Write the {'choreography' if scene_type == 'Dance' else 'action'} for one clip of a music video."]
    parts.append(labels)
    if scene_type == "Dance" and style_seed:
        parts.append(
            f"Dance style: {style_name}. Feel: {style_seed['feel']}. Optional move vocabulary (use only what fits the shot intention): "
            f"{', '.join(style_seed['signature_moves'])}. Dynamics: {style_seed['dynamics']}."
        )
    if _clean(scene_description):
        parts.append(f"Shot intention (primary action): {_clean(scene_description)}. "
                     "Preserve its purpose and essential interaction, allowing expressive variation. "
                     "Continue from the supplied state rather than restarting this action on each clip. "
                     "Style vocabulary and visual hooks must not replace it or introduce conflicting actions.")
    if _clean(llm_notes):
        parts.append(f"Director's notes: {_clean(llm_notes)}")
    if camera_sentence:
        parts.append(f"Chosen camera (keep this framing and movement): {camera_sentence} "
                     "Stage the action so its important body movements and interactions remain readable in this view.")
    if energy_contrast:
        parts.append(f"Intentional musical contrast: {_clean(energy_contrast)}. Preserve this choice even when "
                     "the loudness timeline differs; express musical accents within the chosen action.")
    else:
        parts.append("Use musical accents to shape the chosen action. High loudness does not require large travel "
                     "or acrobatics; quiet phrases do not require abandoning the shot intention.")
    if location_text and not has_location_label:
        parts.append(f"Location (do not label it): {location_text}")
    elif location_text:
        parts.append(f"Location details: {location_text}")
    if image_notes:
        parts.append(
            "Attached images: " + " ".join(image_notes) + " Use them ONLY to choose actions that suit the clothing, "
            "footwear, hair, and objects, and to describe how they move. Do not describe their appearance."
        )
    if music_description:
        parts.append(f"About the song (for mood): {music_description}")
    if lyrics_block:
        parts.append(lyrics_block)
    if lip_sync:
        parts.append(
            "The performer sings along to the lyrics. During sung lines keep the face toward the camera and favor body, "
            "arm, and step movements over turning away. Do not write the lyrics yourself."
        )

    music = f"The clip is {analysis['duration']:.2f} seconds long"
    music += f"; the music is about {analysis['bpm']:.0f} BPM." if analysis.get("bpm") else "."
    parts.append(music)
    if beat_timeline and len(analysis["phrases"]) > 1:
        timeline = "\n".join(
            f"- {format_timestamp(p['start'])} to {format_timestamp(p['end'])}: {p['energy']} song-relative loudness"
            + (f", local change {p['trend']}" if p.get("trend") else "")
            for p in analysis["phrases"]
        )
        parts.append(
            "Use this loudness timeline for phrasing, respecting any intentional contrast. Write one short paragraph "
            "per phrase developing the same principal action, not a new action for every phrase. The first "
            "paragraph has no timestamp. Every later paragraph MUST begin with its start time in exactly this form: "
            '"At 00:03.200, ".\n' + timeline
        )
    else:
        parts.append("Write one or two concise paragraphs developing the principal action over the clip.")
    if ask_signature:
        parts.append(
            "This clip is the first chorus. Create a memorable signature hook combo for the chorus lines; it will be "
            "adapted on later choruses. It must fit the current shot intention and posture."
        )
    elif signature:
        parts.append(f"Recurring chorus motif: {signature}. Adapt its recognizable gesture or rhythm to this shot's "
                     "intention, posture and location; do not import incompatible travel or support changes.")
    parts.append(context)
    if lookahead:
        parts.append(lookahead)

    headers = [
        "STYLE_INTRO: <one or two sentences beginning \"The target video is\" that describe the overall style, mood, "
        "and energy of this clip>",
        ("ACTION_SUMMARY: <a short phrase describing what is shown, e.g. \"slow drifting views of the neon-lit street at "
         "night\">" if scene_type == "B-roll" else
         "ACTION_SUMMARY: <a short verb phrase for the summary, e.g. \"performs an energetic, stylish hip-hop dance\">"),
        "ACTION:\n<the paragraphs>",
    ]
    if ask_camera:
        headers.append(
            "CAMERA: <one sentence: shot size, angle, and camera movement for this clip"
            + (f"; it MUST differ from the previous clip's camera ({previous_camera})" if previous_camera else "")
            + ">"
        )
    if ask_soundscape:
        headers.append("SOUNDSCAPE: <one sentence of sounds happening in the scene, not the music, e.g. engine hum and wind>")
    if ask_requirements:
        headers.append("REQUIREMENTS: needs=<comma-separated exact Supported, Contradicted, or Unknown evidence terms this action relies on, or none> | start_position=<short label or unknown> | end_position=<short label or unknown> | start_posture=<short label or unknown> | end_posture=<short label or unknown>")
    if clip_needs_ending(context):
        headers.append(
            "ENDING_STATE: <one sentence: what is in progress at the clip's last moment, facing direction, and position>"
        )
    if ask_signature:
        headers.append("SIGNATURE_COMBO: <one or two sentences naming the chorus hook combo you used>")
    word_budget = max(60, min(220, round(analysis['duration'] * 14)))
    rule = (f"Aim for at most {word_budget} words of action for this {analysis['duration']:.2f}-second clip. "
            "There is no minimum: use fewer words for a simple action. Keep one principal action with secondary "
            "gestures and describe only transitions that have time to happen.")
    if scene_type != "B-roll" and "<Subject 1>" in labels:
        rule = "The first sentence must name <Subject 1>. " + rule
    parts.append(rule + "\n\nOutput format (exactly these headers, in this order, nothing before or after):\n" + "\n".join(headers))
    return "\n\n".join(parts)


def clip_needs_ending(context: str) -> bool:
    return "final clip of the video" not in context


_HEADERS = ("STYLE_INTRO", "ACTION_SUMMARY", "ACTION", "CHOREOGRAPHY", "CAMERA", "SOUNDSCAPE", "ENDING_STATE",
            "ENDING_POSITION", "SIGNATURE_COMBO", "REQUIREMENTS")
_SECTION = re.compile(r"^\s*\**\s*(" + "|".join(_HEADERS) + r")\s*\**\s*:\s*", re.IGNORECASE | re.MULTILINE)


def parse_clip_response(text: str, scene_type: str) -> tuple[dict[str, str], list[str]]:
    warnings: list[str] = []
    text = strip_reasoning(text)
    matches = list(_SECTION.finditer(text))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections.setdefault(match.group(1).upper(), text[match.end():end].strip())
    action = sections.get("ACTION") or sections.get("CHOREOGRAPHY") or ""
    if not action:
        warnings.append("WARNING: LLM response had no ACTION header; using the whole response.")
        action = _SECTION.sub("", text).strip()
    action = re.sub(r"\*\*|__|^#+\s*", "", action, flags=re.MULTILINE).strip()
    intro = _clean(sections.get("STYLE_INTRO"))
    if not intro:
        warnings.append("WARNING: LLM gave no STYLE_INTRO; using a generic one.")
        intro = "The target video is a stylish, cinematic music video clip."
    summary = _clean(sections.get("ACTION_SUMMARY")).strip("\"'").rstrip(".")
    summary = re.sub(r"^(<Subject \d+>\s*)?(wears <Subject \d+> and\s*)?", "", summary).strip()
    if not summary:
        warnings.append("WARNING: LLM gave no ACTION_SUMMARY; using a generic one.")
        summary = {"Dance": "performs an expressive dance", "Performance": "performs the song to the camera",
                   "Freeform": "moves through the scene", "B-roll": "atmospheric views of the location"}[scene_type]
    summary = summary[0].lower() + summary[1:]
    return {
        "style_intro": intro,
        "summary": summary,
        "action": action,
        "camera": _clean(sections.get("CAMERA")),
        "soundscape": _clean(sections.get("SOUNDSCAPE")),
        "ending": _clean(sections.get("ENDING_STATE") or sections.get("ENDING_POSITION")),
        "signature": _clean(sections.get("SIGNATURE_COMBO")),
        "requirements": _clean(sections.get("REQUIREMENTS")),
    }, warnings


def setting_sentence(location_text: str, location_label: str) -> str:
    location = _clean(location_text)
    if location_label:
        if not location:
            return f"The scene takes place in {location_label}."
        if location[0].islower():
            return _sentence(f"The scene takes place in {location_label}, {location}")
        return f"The scene takes place in {location_label}. " + _sentence(location)
    if not location:
        return ""
    return _sentence(f"The setting is {location}") if location[0].islower() else _sentence(location)


def compose_clip_prompt(
    *, scene_type: str, refs: list[dict[str, Any]], subject_description: str, pronoun: str, parsed: dict[str, str],
    action: str, location_text: str, camera_sentence: str, shot_size: str, audio: dict[str, Any],
    soundscape: str, include_audio_sections: bool, relight: bool = True, new_angle_bridge_seconds: float = 0.0,
) -> tuple[str, list[str]]:
    """Deterministic Ref2VA prompt for one clip from its references and the LLM's creative text."""
    try:
        from .ref2va_nodes import IMAGE_SOCKETS, make_subject
    except ImportError:
        from ref2va_nodes import IMAGE_SOCKETS, make_subject

    subjects, labels = [], {}
    for ref in refs:
        socket = IMAGE_SOCKETS[ref["picture"] - 1]
        if ref["role"] == "person":
            subjects.append(make_subject(ref["subject"], socket, "Person / Character", subject_description, pronoun))
        elif ref["role"] == "outfit":
            person = next((r["subject"] for r in refs if r["role"] == "person"), 0)
            subjects.append(make_subject(ref["subject"], socket, "Outfit / Wardrobe", "the outfit", pronoun, wearer=person))
        elif ref["role"] == "location":
            subjects.append(make_subject(ref["subject"], socket, "Environment / Location", "the environment", pronoun))
        else:
            subjects.append(make_subject(ref["subject"], socket, ref["kind"], ref["name"], pronoun, ref.get("preserve", "")))
        labels[ref["role"]] = f"<Subject {ref['subject']}>"

    location_label = labels.get("location", "")
    lighting = ""
    who = labels.get("person") or (f"the performer wearing {labels['outfit']}" if labels.get("outfit") else "")
    if relight and who and scene_type != "B-roll":
        # reference photos are often lit flat on a plain background; tie the performer to the scene's light instead
        try:
            from .ref2va_prompt import _pronoun_forms
        except ImportError:
            from ref2va_prompt import _pronoun_forms
        forms = _pronoun_forms(pronoun)
        place = location_label or "the setting"
        lighting = (
            f"{who[0].upper() + who[1:]} is lit by the scene itself: the light of {place} falls on {forms['their']} skin, "
            f"hair, and outfit with matching color, direction, softness, and shadows, so {forms['they']} looks fully "
            "part of the scene, not lit like the reference photo."
        )
    body = "\n\n".join(p for p in (setting_sentence(location_text, location_label), lighting, action, camera_sentence)
                       if _clean(p))
    shot = {"cut_time": 0.0, "transition": "the camera cuts to", "description": body, "camera_motion": "None", "dialogues": ()}
    shots = [shot]
    if new_angle_bridge_seconds > 0:
        bridge = (
            "For this brief motion bridge, continue the exact ongoing movement, pose, lighting, outfit, and location "
            "from the guided ending frames. Keep the previous camera framing steady."
        )
        shots = [
            {"cut_time": 0.0, "transition": "the camera cuts to", "description": bridge, "camera_motion": "None", "dialogues": ()},
            {"cut_time": new_angle_bridge_seconds, "transition": "the camera cuts to", "description": body,
             "camera_motion": "None", "dialogues": ()},
        ]

    person, outfit = labels.get("person"), labels.get("outfit")
    if scene_type == "B-roll":
        summary = f"The video shows {parsed['summary']}"
    elif not person:  # no face reference: a generated person, or the outfit seen without the face
        wearing = f" wearing {outfit}" if outfit else ""
        summary = f"The video shows a person{wearing} who {parsed['summary']}"
    elif outfit:
        summary = f"{person} wears {outfit} and {parsed['summary']}"
    else:
        summary = f"{person} {parsed['summary']}"
    if location_label and location_label not in summary:
        summary += f" in {location_label}"
    if new_angle_bridge_seconds > 0:
        summary += f" with a brief continuity bridge, then the camera cuts to a new {shot_size + ' ' if shot_size else ''}angle"
    else:
        summary += f" in a single continuous {shot_size + ' ' if shot_size else ''}shot"
    if audio["usage"] in {"fully_copy", "partially_copy"} and audio.get("sync_motion_to_beat") and scene_type in {"Dance", "Performance"}:
        summary += ", moving to the beat of <Audio 1>"

    return build_ref2va_prompt(
        subjects, [audio], shots, summary, parsed["style_intro"], soundscape,
        include_audio_sections=include_audio_sections,
    )


def continuity_sentence(seconds: float, has_person: bool) -> str:
    who = "<Subject 1>'s pose, position, and the framing" if has_person else "the scene and the framing"
    return (
        f"The video continues seamlessly from the preceding moment with no cut: for the first {seconds:.2f} seconds, "
        f"{who} exactly match the end of the previous clip, then the motion continues."
    )


