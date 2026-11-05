"""Small, canonical context packets for the staged Martini Shot director.

The prompt model is intentionally small.  These helpers turn the broad plan into
short, repeated constraint cards instead of asking each clip call to rediscover
the story hierarchy from prose.
"""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = 1


def _clean(value: Any, limit: int = 360) -> str:
    return " ".join(str(value or "").split())[:limit]


def _event_allocation(analysis: dict[str, Any], story: dict[int, dict[str, Any]], event: str) -> list[dict[str, Any]]:
    """Pick one planned section deterministically; the prompt writer picks its final usable shot."""
    event = _clean(event)
    if not event:
        return []
    candidates = []
    for number, section in enumerate(analysis.get("sections", ()), start=1):
        beat = story.get(number, {})
        if beat.get("scene") == "B-roll":
            continue
        # A declared turn is most likely to make a one-off event read as story rather than decoration.
        candidates.append((1 if beat.get("turn") else 0, float(section.get("energy", 0)), -number, number))
    if not candidates:
        candidates = [(float(section.get("energy", 0)), -number, number)
                      for number, section in enumerate(analysis.get("sections", ()), start=1)]
        number = max(candidates)[-1] if candidates else 1
    else:
        number = max(candidates)[-1]
    return [{"id": "required-event-1", "event": event, "section": int(number)}]


def build_director_context(project: str, analysis: dict[str, Any], story: dict[int, dict[str, Any]],
                           contract: dict[str, str], settings: dict[str, Any]) -> dict[str, Any]:
    """Persisted, inspectable context that is stable between planning and prompt writing."""
    states = {}
    for number, beat in story.items():
        section = analysis.get("sections", [])[int(number) - 1] if 0 < int(number) <= len(analysis.get("sections", ())) else {}
        states[str(number)] = {
            "scene": _clean(beat.get("scene")), "location": _clean(beat.get("location") or beat.get("new_location")),
            "start": round(float(section.get("start", 0)), 3), "end": round(float(section.get("end", 0)), 3),
            "role": _clean(section.get("role")), "energy": round(float(section.get("energy", 0)), 3),
            "incoming_state": _clean(beat.get("starts")), "must_change": _clean(beat.get("turn") or beat.get("beat")),
            "outgoing_state": _clean(beat.get("ends")), "avoid": _clean(beat.get("avoid")),
            "anchor": _clean(beat.get("anchor")),
        }
    return {
        "schema_version": SCHEMA_VERSION, "project": project,
        "song": {"duration": round(float(analysis.get("duration", 0)), 3), "bpm": round(float(analysis.get("bpm", 0)), 3)},
        "creative_contract": {key: _clean(contract.get(key)) for key in ("look", "motif", "event")},
        "required_events": _event_allocation(analysis, story, contract.get("event", "")),
        "section_states": states,
        "settings": {key: settings[key] for key in ("seed", "story_wheel", "min_locations") if key in settings},
    }


def attach_context_to_shots(shots: list[dict[str, Any]], context: dict[str, Any]) -> None:
    """Attach one compact card to every shot without making the prompt model infer priority."""
    by_section: dict[int, list[dict[str, Any]]] = {}
    for shot in shots:
        by_section.setdefault(int(shot.get("_section", 0)), []).append(shot)
        shot["_required_events"] = []
    for event in context.get("required_events", ()):
        choices = [s for s in by_section.get(int(event.get("section", 0)), ()) if s.get("scene_type") != "B-roll"]
        choices = choices or by_section.get(int(event.get("section", 0)), ())
        if choices:
            # The final shot gives the event room to be revealed and makes it a clear section outcome.
            choices[-1]["_required_events"].append(event)

    contract = context.get("creative_contract", {})
    states = context.get("section_states", {})
    for shot in shots:
        state = states.get(str(shot.get("_section", "")), {})
        must = [_clean(shot.get("scene_description")), _clean(state.get("must_change"))]
        must += [_clean(event.get("event")) for event in shot.get("_required_events", ())]
        must = [item for item in dict.fromkeys(must) if item]
        may = [item for item in (_clean(contract.get("look")), _clean(contract.get("motif")), _clean(state.get("anchor"))) if item]
        forbidden = [_clean(state.get("avoid"))] if _clean(state.get("avoid")) else []
        lines = ["CONSTRAINT PRIORITY (follow MUST before MAY):"]
        if must:
            lines.append("MUST: " + " | ".join(must))
        if state.get("incoming_state"):
            lines.append("ENTERING STATE: " + _clean(state["incoming_state"]))
        if state.get("outgoing_state"):
            lines.append("EXITING STATE: " + _clean(state["outgoing_state"]))
        if may:
            lines.append("MAY ADD IF COMPATIBLE: " + " | ".join(may))
        if forbidden:
            lines.append("MUST NOT: " + " | ".join(forbidden))
        shot["_director_context_card"] = "\n".join(lines)
