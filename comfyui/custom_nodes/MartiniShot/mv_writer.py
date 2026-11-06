"""LLM instructions and prompt assembly for the Music Video Director.

Pure logic. Each clip gets: a scene-type-specific system prompt, a user message
with the clip's labels, music, context, and output headers, and a deterministic
Ref2VA prompt built from the LLM's creative text.
"""

from __future__ import annotations

import re
from typing import Any

try:
    from .action_validation import (check_action_flow, parse_requirements, repair_message,
                                    validate_requirements)
    from .clip_instructions import TYPE_TEXT
    from .dance_writer import format_timestamp, split_lookahead, strip_reasoning
    from .h3_prompt import _clean, _sentence
    from .ref2va_prompt import build_ref2va_prompt
except ImportError:  # imported as top-level modules by the tests
    from action_validation import (check_action_flow, parse_requirements, repair_message,
                                   validate_requirements)
    from clip_instructions import TYPE_TEXT
    from dance_writer import format_timestamp, split_lookahead, strip_reasoning
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
- {movement_rule}
- The CLIP CARD is authoritative: TYPE, START, ACTIVITY, END, REQUIRED EVENT, and CHOSEN CAMERA are requirements; lines marked optional are used only when compatible; AVOID is prohibited. (Older messages use CONSTRAINT PRIORITY: MUST and ENTERING/EXITING STATE are requirements, MAY ADD IF COMPATIBLE is optional, MUST NOT is prohibited.)
- Continuing or repeating the same activity across clips is valid. Do not invent new events, obstacles, props, or places just to make a clip different, and never let optional style or hooks replace the required action.

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


# Dance clips are choreography: a sequence of specific, named moves. The other scene types keep one coherent action,
# so a story beat plays as one believable moment instead of a string of unrelated stunts.
MOVEMENT_RULES = {
    "Dance": (
        "Build the clip from a sequence of specific, named moves that flow into each other. For each move say which "
        "side and limb, the direction, level, and timing, and include arms, hands, feet, hips, torso, head, and gaze. "
        "Every move must suit the shot intention, the space, and the footwear; no unrelated stunts. Body mechanics are realistic."
    ),
}
DEFAULT_MOVEMENT_RULE = (
    "Develop one principal action with natural secondary motion. Repeated rhythmic gestures are allowed; do not invent "
    "unrelated stunts merely to keep moving. Body mechanics are realistic."
)


def system_prompt(scene_type: str) -> str:
    return ROLES[scene_type] + "\n\n" + _SHARED_RULES.replace(
        "{movement_rule}", MOVEMENT_RULES.get(scene_type, DEFAULT_MOVEMENT_RULE))


def word_range(scene_type: str, seconds: float) -> tuple[int, int]:
    """(minimum, maximum) action words for a clip. Dance needs room for specific moves in every phrase (the old Dance
    Song Prompt writer asked for 180-380 words); other scene types only have a ceiling."""
    if scene_type == "Dance":
        return max(100, min(260, round(seconds * 20))), max(180, min(380, round(seconds * 40)))
    return 0, max(60, min(220, round(seconds * 14)))


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
    # the clip's loudness is on the CLIP CARD's MUSIC line, so it is not repeated here
    lines = [f"This is generated clip {clip['index']} of {len(clips)} of the video (production shot {section['number']} "
             f"of {len(sections)})."]
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
        block += ("CONTINUE mid-flow from that state: do not re-describe it, restart the action, or reset to a neutral "
                  "stance. Carrying on with the same activity is correct; keep any directed stillness or held pose "
                  "rather than inventing new motion. Timestamps restart at 00:00.000 at the start of this clip.")
        lines.append(block)
    return "\n\n".join(lines)


CARD_HEADER = "CLIP CARD (the requirements for this clip; nothing later in this message overrides them)"
# Card line prefixes that the Produce page's revisions rewrite in place (see mv_nodes._current_message).
CARD_ACTIVITY, CARD_CAMERA, CARD_LOCATION = "ACTIVITY: ", "CHOSEN CAMERA: ", "LOCATION: "


def format_card(card: list[tuple[str, str]]) -> str:
    """One block of 'LABEL: value' lines; empty values are left out."""
    return "\n".join([CARD_HEADER] + [f"{label}: {' '.join(str(value).split())}" for label, value in card if _clean(value)])


def phrase_example(analysis: dict[str, Any]) -> str:
    """A real later-phrase boundary for the timestamp format example, so a copied example is still a true boundary."""
    phrases = analysis.get("phrases") or []
    return format_timestamp(phrases[1]["start"]) if len(phrases) > 1 else format_timestamp(0.0)


def build_clip_message(
    *, scene_type: str, labels: str, card: list[tuple[str, str]], style_seed: dict[str, Any] | None,
    style_name: str, analysis: dict[str, Any], beat_timeline: bool,
    context: str, lookahead: str, lyrics_block: str, lip_sync: bool, ask_signature: bool, signature: str,
    ask_camera: bool, previous_camera: str, ask_soundscape: bool, image_notes: list[str], music_description: str,
    energy_contrast: str = "", ask_requirements: bool = False,
) -> str:
    """The clip writer's message: a compact CLIP CARD (built by clip_instructions.build_card) followed by the music,
    lyrics, continuity, and output format. Dance keeps its full choreography requirements and word minimum."""
    parts = [f"Write the {'choreography' if scene_type == 'Dance' else 'action'} for one clip of a music video."]
    parts.append(labels)
    if scene_type == "Dance" and style_seed:
        parts.append(
            f"Dance style: {style_name}. Feel: {style_seed['feel']}. Optional move vocabulary (use only what fits the ACTIVITY): "
            f"{', '.join(style_seed['signature_moves'])}. Dynamics: {style_seed['dynamics']}."
        )
    parts.append(format_card(card))
    if scene_type == "Dance":
        parts.append("ACTIVITY is what the choreography expresses. Choreograph a sequence of specific named moves around "
                     "it; it guides the moves and is not one move to repeat. When START says a movement phrase is already "
                     "in progress, continue that phrase instead of restarting it. Style vocabulary and optional details "
                     "must not replace ACTIVITY or add conflicting actions.")
    elif scene_type == "B-roll":
        parts.append("ACTIVITY is what the camera shows of the place. Optional details must not add a performer, a plot "
                     "event, or a different setting.")
    else:
        parts.append("ACTIVITY is the principal action. Carry it from START toward END. Continuing or repeating the same "
                     "activity across clips is correct (a run can stay a run); do not invent doors, corners, obstacles, "
                     "events, or new places to make this clip different. Optional details must not replace ACTIVITY or "
                     "add another action.")
    if energy_contrast:
        parts.append("Keep the intentional musical contrast on the MUSIC line even when the loudness timeline differs; "
                     "express musical accents within the chosen action.")
    else:
        parts.append("Use musical accents to shape the chosen action. High loudness does not require large travel "
                     "or acrobatics; quiet phrases do not require abandoning the ACTIVITY.")
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
        per_phrase = ("Write one paragraph per phrase. Each paragraph names new, specific moves that continue the same "
                      "idea and flow from the previous phrase; do not just repeat the previous phrase's move."
                      if scene_type == "Dance" else
                      "Write one short paragraph per phrase developing the same principal action, not a new action for every phrase.")
        parts.append(
            f"Use this loudness timeline for phrasing, respecting any intentional contrast. {per_phrase} The first "
            "paragraph has no timestamp. Every later paragraph MUST begin with its own phrase start time from this list, "
            f'written exactly like "At {phrase_example(analysis)}, " for the second phrase.\n' + timeline
        )
    elif scene_type == "Dance":
        parts.append("Write two or three paragraphs of specific choreography, a sequence of named moves across the clip.")
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
        headers.append("REQUIREMENTS: needs=<up to four location-evidence phrases from the LOCATION line that this action physically depends on, copied word for word, or none> | start_position=<where the performer is at the first moment, a few words, or unknown> | end_position=<where at the last moment, or unknown> | start_posture=<e.g. running, standing, kneeling, or unknown> | end_posture=<at the last moment, or unknown>")
    if clip_needs_ending(context):
        headers.append(
            "ENDING_STATE: <one sentence: what is in progress at the clip's last moment, facing direction, and position>"
        )
    if ask_signature:
        headers.append("SIGNATURE_COMBO: <one or two sentences naming the chorus hook combo you used>")
    least, most = word_range(scene_type, analysis["duration"])
    if scene_type == "Dance":
        rule = (f"Write between {least} and {most} words of choreography for this {analysis['duration']:.2f}-second clip. "
                "Spend them on specific moves in every phrase, not on mood or the look of the place, and describe "
                "only moves that have time to happen.")
    else:
        rule = (f"Aim for at most {most} words of action for this {analysis['duration']:.2f}-second clip. "
                "There is no minimum: use fewer words for a simple action. Keep one principal action with secondary "
                "gestures and describe only transitions that have time to happen. A sustained action may simply "
                "continue for the whole clip.")
    if scene_type != "B-roll" and "<Subject 1>" in labels:
        rule = "The first sentence must name <Subject 1>. " + rule
    parts.append(rule + "\n\nOutput format (exactly these headers, in this order, nothing before or after):\n" + "\n".join(headers))
    return "\n\n".join(parts)


def clip_needs_ending(context: str) -> bool:
    return "final clip of the video" not in context


_HEADERS = ("STYLE_INTRO", "ACTION_SUMMARY", "ACTION", "CHOREOGRAPHY", "CAMERA", "SOUNDSCAPE", "ENDING_STATE",
            "ENDING_POSITION", "SIGNATURE_COMBO", "REQUIREMENTS")
_SECTION = re.compile(r"^\s*\**\s*(" + "|".join(_HEADERS) + r")\s*\**\s*:\s*", re.IGNORECASE | re.MULTILINE)


# Instruction text the model sometimes echoes after its answer (seen as a trailing "REVISION REQUEST:" in saved
# ending states). Everything from the echo on is discarded so it never becomes continuity state.
_ECHO = re.compile(r"^[ \t>*_#]*(REVISION REQUEST|PRODUCER CHANGES|PRODUCER DIRECTION|DRAFT|LENGTH \(overrides[^)]*\)"
                   r"|Output format|The draft below has)\s*[:(]", re.IGNORECASE | re.MULTILINE)
_TEMPLATE_TEXT = re.compile(r"<[^<>]*(?:one sentence|the paragraphs|short|phrase|label)[^<>]*>|what is in progress at the "
                            r"clip's last moment", re.IGNORECASE)
_TERMINAL = ('.', '!', '?', '"', "'", '”', '’', ')', '…')


def parse_clip_response(text: str, scene_type: str) -> tuple[dict[str, str], list[str]]:
    """Parsed fields plus warnings. parsed["issues"] lists structural problems (echoed instructions, a template
    placeholder as the ending state, a truncated action) that the package writer may repair once."""
    warnings: list[str] = []
    issues: list[str] = []
    text = strip_reasoning(text)
    echo = _ECHO.search(text)
    if echo and echo.start() > 0:
        issues.append(f"the response repeated instruction text ('{echo.group(1)}'); the text from there on was discarded")
        text = text[:echo.start()].rstrip()
    matches = list(_SECTION.finditer(text))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections.setdefault(match.group(1).upper(), text[match.end():end].strip())
    action = sections.get("ACTION") or sections.get("CHOREOGRAPHY") or ""
    if not action:
        warnings.append("WARNING: LLM response had no ACTION header; using the whole response.")
        issues.append("the response had no ACTION header")
        action = _SECTION.sub("", text).strip()
    action = re.sub(r"\*\*|__|^#+\s*", "", action, flags=re.MULTILINE).strip()
    if action and not action.endswith(_TERMINAL):
        issues.append("the ACTION ends mid-sentence (the response may be truncated)")
    if _TEMPLATE_TEXT.search(action):
        issues.append("the ACTION contains output-template placeholder text")
    ending = _clean(sections.get("ENDING_STATE") or sections.get("ENDING_POSITION"))
    if ending and _TEMPLATE_TEXT.search(ending):
        issues.append(f"the ENDING_STATE is template text ('{ending[:60]}'); it is not used as continuity state")
        ending = ""
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
        "ending": ending,
        "signature": _clean(sections.get("SIGNATURE_COMBO")),
        "requirements": _clean(sections.get("REQUIREMENTS")),
        "issues": issues,
    }, warnings + [f"WARNING: {issue}." for issue in issues]


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


# ----- checks shared by the package writer and Produce-page revisions (pure; the LLM call is injected) -----

def evaluate_clip(parsed: dict[str, Any], *, clip_seconds: float, transition: str, end_mode: str | None,
                   intention: str, evidence: dict[str, list[str]] | None, previous: dict[str, Any] | None,
                   check_receipt: bool, scene: str = "Freeform") -> dict[str, Any]:
    """Structural, continuity-flow, and (opt-in) receipt checks for one parsed clip response.

    Returns {conflicts, unknowns, requirements, receipt}. Conflicts are clear problems worth one repair; unknowns are
    reported as unverified. Repetition is never checked, so a sustained run or repeated phrase is never a conflict."""
    action, next_plan = split_lookahead(parsed["action"], clip_seconds)
    conflicts = list(parsed.get("issues", ()))
    if end_mode is not None:
        conflicts += check_action_flow(action, next_plan, end_mode=end_mode, intention=intention, transition=transition,
                                       scene=scene)
    unknowns: list[str] = []
    requirements: dict[str, Any] = {}
    if check_receipt and parsed.get("requirements"):
        requirements = parse_requirements(parsed["requirements"])
        found, unknowns = validate_requirements(requirements, evidence, previous, transition)
        conflicts += found
        if transition in ("Continue", "New angle") and previous and not any(
                requirements.get(key, "unknown").lower() != "unknown" for key in ("start_position", "start_posture")):
            unknowns.append(f"the receipt does not state the starting position or posture at the {transition} join")
    return {"conflicts": conflicts, "unknowns": unknowns, "requirements": requirements,
            "receipt": bool(parsed.get("requirements"))}


def validation_notes(result: dict[str, Any], check_receipt: bool) -> list[str]:
    """Report lines in the forms production-rules.ts reads: validated, unverified, skipped."""
    if not check_receipt:
        return []
    if not result["receipt"]:
        return ["NOTE: action validation skipped; the LLM returned no REQUIREMENTS receipt."]
    if result["unknowns"]:
        return ["NOTE: action validation unverified: " + "; ".join(result["unknowns"]) + "."]
    summary = ", ".join(f"{key}={', '.join(value) if isinstance(value, list) else value}"
                        for key, value in result["requirements"].items() if value and key != "placeholders")
    return [f"NOTE: action validation validated: {summary or 'needs=none'}."]


def check_and_repair(run, llm, message: str, response: str, scene: str, image_kwargs: dict[str, Any], temperature: float,
                      max_tokens: int, repair_seed: int, check: Any, validate: bool) -> tuple[str, dict, list[str], dict]:
    """Parse, check, and make at most one repair call. Returns (response, parsed, warnings, result).

    Without validate (validate_actions off) problems are only reported. With it, a repair is kept when it has fewer
    conflicts than the draft; whatever remains is reported as unresolved, never as valid."""
    parsed, warnings = parse_clip_response(response, scene)
    result = check(parsed)
    flow = [c for c in result["conflicts"] if c not in parsed.get("issues", ())]
    if result["conflicts"] and validate:
        repaired = run(llm, repair_message(message, response, result["conflicts"]), image_kwargs, temperature,
                   max_tokens, repair_seed, system_prompt(scene))
        repaired_parsed, repaired_warnings = parse_clip_response(repaired, scene)
        repaired_result = check(repaired_parsed)
        if len(repaired_result["conflicts"]) < len(result["conflicts"]):
            fixed = [c for c in result["conflicts"] if c not in repaired_result["conflicts"]]
            warnings = [w for w in repaired_warnings] + ["NOTE: repaired action validation: " + c for c in fixed]
            response, parsed, result = repaired, repaired_parsed, repaired_result
        warnings += ["WARNING: action validation could not repair: " + c for c in result["conflicts"]]
    elif flow:
        warnings += ["WARNING: continuity: " + c for c in flow]
    warnings += validation_notes(result, validate) if not result["conflicts"] else []
    if validate:
        parsed["requirements"] = result["requirements"]
    return response, parsed, warnings, result


def current_card(card: str, record: dict[str, Any], notes: dict[str, Any], intention: str) -> tuple[str, str]:
    """The CLIP CARD with the clip's changed settings written into its lines. Returns (card, replaced intention)."""
    old_intention, lines = "", []
    for line in card.split("\n"):
        if line.startswith(CARD_ACTIVITY) and intention:
            old_intention = line[len(CARD_ACTIVITY):].rstrip(".")
            line = CARD_ACTIVITY + intention
        elif line.startswith(CARD_CAMERA) and "camera" in notes:
            if record.get("ask_camera") or not record.get("camera_sentence"):
                continue  # the LLM picks the camera; the CAMERA header asks for it
            line = CARD_CAMERA + record["camera_sentence"]
        elif line.startswith(CARD_LOCATION) and ("location" in notes or "ref_location" in notes):
            label = re.match(r"<Subject \d+>", line[len(CARD_LOCATION):])
            text = _clean(record.get("location_text"))
            # a swapped location image makes the recorded image evidence stale, so it is dropped
            evidence = "" if "ref_location" in notes else (line.split(". Evidence — ", 1)[1:] or [""])[0]
            line = CARD_LOCATION + " — ".join(p for p in (label.group(0) if label else "", text) if p) \
                + (f". Evidence — {evidence}" if evidence else "")
        elif line.startswith("TYPE: ") and "scene" in notes:
            line = "TYPE: " + TYPE_TEXT.get(record["scene"], record["scene"])
        elif line.startswith("END: ") and record.get("ending_override"):
            line = "END: The clip MUST end in this state: " + _clean(record["ending_override"])
        lines.append(line)
    return "\n".join(lines), old_intention


def before_output_format(message: str, extra: list[str]) -> str:
    """Insert revision text before the final length-and-output-format paragraph, so the response format stays the
    last thing the model reads (appending after it made the model echo 'REVISION REQUEST:' into its answer)."""
    extra = [part for part in extra if part]
    head, separator, tail = message.rpartition("\n\n")
    if separator and "Output format (exactly these headers" in tail:
        return "\n\n".join([head] + extra + [tail])
    return "\n\n".join([message] + extra)
