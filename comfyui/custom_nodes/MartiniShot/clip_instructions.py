"""Effective instructions for one generated clip, resolved after production shots are split into renderable clips.

Three granularities stay distinct:
- section intent: the Story Wheel's entering state, turn, and destination for a whole song section;
- shot intent: the planned activity of one production shot (it may span several generated clips);
- clip handoff: how this generated clip starts from the previous one (Hard cut, New angle, Continue).

A section's entering state applies only where the section actually begins on screen (its first story shot, after a
hard cut). Its destination applies only to the last generated clip of its last story shot. Every other clip simply
continues the activity: a run stays a run, a held pose stays held, and a dance phrase carries across the join.

Pure logic: no ComfyUI imports, so the tests and the prompt comparison script use the same code as the package writer.
"""

from __future__ import annotations

import re
from typing import Any

try:
    from .h3_prompt import _clean
except ImportError:  # imported as a top-level module by the tests
    from h3_prompt import _clean

END_ARRIVE, END_CONTINUE, END_FINAL = "arrive", "continue", "final"
TYPE_TEXT = {"Dance": "Dance — choreography of specific named moves",
             "Performance": "Performance — the performer sings to the camera",
             "Freeform": "Freeform — one believable continuous action, not a dance",
             "B-roll": "B-roll — the place itself, no main performer"}
_OPAQUE_TOKEN = re.compile(r"^(?=.*\d)[0-9a-f]{4,}$", re.IGNORECASE)
_ROLE_NOTE = re.compile(r"This is the \w+ of the song\. Section-average loudness is [^.]*\.(?: [^.]*may vary\.)?\s*")
_EVIDENCE_NOTE = re.compile(r"\s*Image-derived location evidence:[^.]*\.?")


def opaque_name(name: str) -> bool:
    """True for upload-derived identifiers such as '8c12bbb7 fca4 45ba a010 1efbdfd21263' that describe nothing."""
    tokens = re.findall(r"[A-Za-z0-9]+", str(name or ""))
    return bool(tokens) and sum(bool(_OPAQUE_TOKEN.match(token)) for token in tokens) >= max(2, round(len(tokens) * 0.6))


def location_label(name: str, description: str, evidence: dict[str, list[str]] | None, label: str = "",
                   same_as_previous: bool = False) -> str:
    """A descriptive LOCATION line. An opaque reference name is kept only as an internal id after the description."""
    evidence = evidence or {}
    text = _clean(description)
    if not text or opaque_name(text):
        text = ", ".join((evidence.get("visible") or [])[:3]) or ("" if opaque_name(name) else _clean(name))
    parts = [part for part in (label, text) if part]
    line = " — ".join(parts) if parts else "the location"
    if name and opaque_name(name) and _clean(name) not in line:
        line += f" (reference id {_clean(name)[:24].strip()})"
    if same_as_previous:
        line += "; the same place as the previous clip"
    details = [f"{key}: {', '.join(evidence[key][:4])}" for key in ("supported", "contradicted", "unknown") if evidence.get(key)]
    if details:
        line += ". Evidence — " + "; ".join(details)
    return line


def remaining_notes(llm_notes: str) -> str:
    """Free-form notes minus what the card already states (role/loudness boilerplate and the location evidence)."""
    return _clean(_EVIDENCE_NOTE.sub(" ", _ROLE_NOTE.sub("", str(llm_notes or ""))))


def _section_fields(shot: dict[str, Any]) -> dict[str, str]:
    context = shot.get("_director_context") or {}
    wheel = shot.get("_story_wheel") or {}
    return {key: _clean(context.get(key) or wheel.get(source, ""))
            for key, source in (("entering", "starts"), ("exiting", "ends"), ("turn", "turn"),
                                ("anchor", "anchor"), ("avoid", "avoid"))}


def continuity_plan(shot: dict[str, Any], clip: dict[str, Any], *, total_clips: int,
                    previous_ending: str = "") -> dict[str, Any]:
    """START/END/progress for one generated clip.

    clip uses mv_plan.plan_video's fields: index, transition, clip_in_section and clips_in_section (generated clips
    of this production shot). The shot carries _section_part/_section_parts: its position among the shots that carry
    the section's story action (0 when it is not one of them, e.g. a B-roll insert)."""
    fields = _section_fields(shot)
    part, parts = int(shot.get("_section_part") or 0), int(shot.get("_section_parts") or 0)
    k, n = int(clip.get("clip_in_section") or 1), int(clip.get("clips_in_section") or 1)
    transition = clip.get("transition", "Hard cut")
    first_of_section = part == 1 and k == 1
    last_of_section = part > 0 and part == parts and k == n
    joined = clip.get("index", 1) > 1 and transition in ("Continue", "New angle")

    if clip.get("index", 1) == 1:
        start = fields["entering"] if first_of_section and fields["entering"] else "The opening moment of the video."
    elif transition == "Continue":
        # the previous clip's action and last moment are quoted once, in the continuity block below the card
        start = ("Already in progress with no cut: continue from the previous clip's last moment"
                 + (" (quoted below)." if previous_ending else "."))
    elif transition == "New angle":
        start = ("The same moment as the previous clip's last moment" + (" (quoted below)" if previous_ending else "")
                 + ", seen from a new camera angle.")
    elif first_of_section and fields["entering"]:
        start = fields["entering"]
    elif part > 1:
        start = ("A new shot after a hard cut within this section; time may have passed. Keep the section's story "
                 "progress; no on-screen transition is needed.")
    else:
        start = "A new scene after a hard cut; position, place, activity, or time may change."

    if clip.get("index", 1) == total_clips:
        end, mode = "The final clip of the video: bring it to a clear, satisfying ending.", END_FINAL
    elif last_of_section and fields["exiting"]:
        end, mode = f"Arrive at: {fields['exiting']}", END_ARRIVE
    elif fields["exiting"] and part > 0:
        end = ("Keep the ACTIVITY going through the cut (a held pose stays held); no stop or arrival in this clip. "
               f"The section reaches \"{fields['exiting']}\" later, not here.")
        mode = END_CONTINUE
    else:
        end, mode = "Keep the ACTIVITY going through the cut (a held pose stays held); no stop or ending is required.", END_CONTINUE

    progress = []
    if parts > 1 and part:
        progress.append(f"production shot {part} of {parts} that carry this section's action")
    if n > 1:
        progress.append(f"generated clip {k} of {n} of this shot")
    turn = ""
    if fields["turn"] and part and k == 1:
        turn = fields["turn"] + (" (happens once in this section; if an earlier shot already showed it, carry on from it)"
                                 if part > 1 else " (happens once in this section)")
    events = [_clean(event.get("event")) for event in shot.get("_required_events", ()) if _clean(event.get("event"))] \
        if k == n else []
    return {"start": start, "end": end, "end_mode": mode, "arrival": fields["exiting"] if mode == END_ARRIVE else "",
            "progress": "; ".join(progress), "turn": turn, "events": events, "joined": joined,
            "entering_applied": bool(fields["entering"]) and start == fields["entering"],
            "anchor": fields["anchor"], "avoid": fields["avoid"]}


def build_card(shot: dict[str, Any], plan: dict[str, Any], *, scene: str, duration: float, music_role: str,
               loudness: str, camera_sentence: str, location_line: str, has_person: bool) -> list[tuple[str, str]]:
    """The CLIP CARD lines for mv_writer.format_card, in a fixed order."""
    context = shot.get("_director_context") or {}
    activity = _clean(shot.get("scene_description")) or (
        "Expressive dance in the given style, built from specific named moves." if scene == "Dance" else "")
    type_text = TYPE_TEXT.get(scene, scene)
    music = (f"{music_role} of the song; " if music_role else "") + f"{loudness} loudness relative to the whole song " \
            "(not a required movement speed)"
    if _clean(shot.get("energy_contrast")):
        music += f". Intentional contrast: {_clean(shot['energy_contrast'])}"
    motifs = [m for m in (_clean(context.get("motif")), _clean(shot.get("_style_motif"))) if m]
    motif_role = _clean(context.get("motif_role"))
    preserve = []
    if scene != "B-roll" and has_person:
        preserve.append("the performer and outfit from the references")
    preserve.append("the location reference")
    if plan.get("joined"):
        preserve.append("posture, direction of travel, and momentum at the join")
    card = [
        ("TYPE", type_text),
        ("DURATION", f"{duration:.2f} seconds"),
        ("MUSIC", music),
        ("LOCATION", location_line),
        ("START", plan["start"]),
        ("ACTIVITY", activity),
        ("END", plan["end"]),
        ("REQUIRED EVENT (show it clearly in this clip)", " | ".join(plan["events"])),
        ("CHOSEN CAMERA", camera_sentence),
        ("SECTION TURN", plan["turn"]),
        ("PROGRESS", plan["progress"]),
        ("OPTIONAL DETAIL (only if compatible; never a new action, event, or setting)", _clean(shot.get("_hook"))),
        ("OPTIONAL RECURRING MOTIF" + (f" ({motif_role})" if motif_role else ""), " | ".join(dict.fromkeys(motifs))),
        ("OPTIONAL ANCHOR", plan.get("anchor", "")),
        ("VISUAL STYLE (fixed for the whole video; do not reinterpret it)",
         _clean(shot.get("style_bible")) or _clean(context.get("look"))),
        ("PRESERVE", ", ".join(preserve)),
        ("AVOID", plan.get("avoid", "")),
        ("NOTES", remaining_notes(shot.get("llm_notes", ""))),
    ]
    return card
