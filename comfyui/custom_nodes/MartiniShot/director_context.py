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


_EVENT_STOP = {"the", "and", "with", "one", "scene", "moment", "shot", "time", "during", "where", "that", "this", "event",
               "single", "final", "big", "required"}


def _event_stems(text: str) -> set[str]:
    import re

    def stem(word: str) -> str:
        for suffix in ("ing", "es", "ed", "er", "s", "e"):
            if len(word) > len(suffix) + 2 and word.endswith(suffix):
                return word[:-len(suffix)][:6]
        return word[:6]
    return {stem(w) for w in re.findall(r"[a-z]+", str(text or "").lower()) if len(w) > 2 and w not in _EVENT_STOP}


def event_mentioned(event: str, text: str) -> bool:
    """Whether clip prompt text names the event (most of its content words). Prompt coverage only: it says nothing
    about whether the rendered video shows it."""
    wanted = _event_stems(event)
    return bool(wanted) and len(wanted & _event_stems(text)) * 2 >= len(wanted) + (1 if len(wanted) > 2 else 0)


def required_event_report(context: dict[str, Any], production_shots: list[dict[str, Any]],
                          segments: list[dict[str, Any]], prompt_text) -> list[dict[str, Any]]:
    """Allocation, prompt coverage, and (always) unverified visual fulfillment for each required event.

    production_shots: [{number, required_events}] (1-based shot numbers, as in segments.json's 'section').
    prompt_text(segment) -> the clip's current prompt text."""
    report = []
    for event in context.get("required_events", ()):
        shots = [s["number"] for s in production_shots
                 if any(e.get("id") == event.get("id") for e in s.get("required_events", ()))]
        clips = [int(seg["index"]) for seg in segments if int(seg.get("section", 0)) in shots]
        mentions = [int(seg["index"]) for seg in segments if int(seg["index"]) in clips
                    and event_mentioned(event.get("event", ""), prompt_text(seg))]
        report.append({"event": event.get("event", ""), "section": event.get("section"), "shots": shots, "clips": clips,
                       "prompt_mentions": mentions, "visual": "unverified"})
    return report


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
            "turn": _clean(beat.get("turn")),
            "outgoing_state": _clean(beat.get("ends")), "avoid": _clean(beat.get("avoid")),
            "anchor": _clean(beat.get("anchor")),
            "scene_source": _clean(beat.get("scene_source")) or ("planner" if beat.get("scene") else "rules"),
        }
    issues = [f"Section {number}: {_clean(beat['scene_issue'])}" for number, beat in sorted(story.items(), key=lambda i: int(i[0]))
              if beat.get("scene_issue")]
    if _clean(contract.get("event_note")):
        issues.append(_clean(contract.get("event_note")))
    return {
        "schema_version": SCHEMA_VERSION, "project": project,
        "song": {"duration": round(float(analysis.get("duration", 0)), 3), "bpm": round(float(analysis.get("bpm", 0)), 3)},
        "creative_contract": {key: _clean(contract.get(key)) for key in ("look", "motif", "event", "concept", "motif_role", "event_note")},
        "required_events": _event_allocation(analysis, story, contract.get("event", "")),
        "planning_issues": issues,
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
        # Structured, not pre-rendered: the package writer decides per generated clip whether the section's entering
        # state or destination applies (clip_instructions.continuity_plan), so intermediate clips never get both.
        shot["_director_context"] = {
            "entering": _clean(state.get("incoming_state")), "exiting": _clean(state.get("outgoing_state")),
            "turn": _clean(state.get("turn")), "anchor": _clean(state.get("anchor")), "avoid": _clean(state.get("avoid")),
            "look": _clean(contract.get("look")), "motif": _clean(contract.get("motif")),
            "motif_role": _clean(contract.get("motif_role")),
        }
        lines = [f"ACTIVITY: {_clean(shot.get('scene_description')) or '(scene default)'}"]
        lines += [f"{label}: {value}" for label, value in (
            ("SECTION STARTS FROM (first story shot only)", shot["_director_context"]["entering"]),
            ("SECTION TURN", shot["_director_context"]["turn"]),
            ("SECTION DESTINATION (last clip of the section only)", shot["_director_context"]["exiting"]),
            ("REQUIRED EVENT", " | ".join(_clean(e.get("event")) for e in shot.get("_required_events", ()))),
            ("AVOID", shot["_director_context"]["avoid"])) if value]
        shot["_director_context_card"] = "\n".join(lines)  # audit copy; the clip prompt gets a per-clip card
