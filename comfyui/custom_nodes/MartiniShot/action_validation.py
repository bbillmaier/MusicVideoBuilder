"""Small deterministic consistency checks for opt-in action validation.

Every check returns (conflicts, unknowns). A conflict is a clear contradiction worth one bounded repair; an unknown is
something the checks could not confirm. Unknowns are reported as unverified and never as valid or as conflicts.
Repetition is never a conflict: a run that stays a run across clips, or a repeated dance phrase, is a valid choice.
"""

from __future__ import annotations

import re
from typing import Any

# Words the model copies from the REQUIREMENTS template instead of naming real evidence.
_PLACEHOLDER_NEEDS = {"supported", "contradicted", "unknown", "evidence", "evidence terms", "exact evidence terms",
                      "location", "the location", "performer", "the performer", "outfit", "the outfit", "n/a", "tbd"}
_LABEL = re.compile(r"^<?\s*(subject|picture|audio)\s*\d+\s*>?$", re.IGNORECASE)
_TEMPLATE = re.compile(r"[<>]|comma-separated|short label|or unknown|or none|evidence term", re.IGNORECASE)
_STOPWORDS = {"the", "a", "an", "of", "in", "on", "at", "to", "her", "his", "their", "its", "with", "and", "she", "he",
              "they", "is", "still", "near", "by", "from", "into", "toward", "towards", "frame", "shot", "position",
              "subject", "performer"}

# Posture families. Different families across a Continue or New angle join cannot both be true at the same moment.
_POSTURES = (
    ("lying", ("lying", "lies", "lie ", "supine", "prone", "sprawled", "flat on")),
    ("sitting", ("sitting", "sits", "seated", "sat ")),
    ("kneeling", ("kneeling", "kneels", "on one knee", "on her knees", "on his knees", "on their knees")),
    ("crouching", ("crouch", "squat", "low lunge", "hunched low")),
    ("airborne", ("mid-air", "midair", "airborne", "mid-jump", "mid jump", "leaping", "in the air")),
    ("moving", ("running", "sprinting", "jogging", "racing", "dashing", "walking", "striding", "mid-stride", "mid stride")),
    ("standing", ("standing", "stands", "upright", "planted", "standing still")),
)


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _tokens(text: str) -> set[str]:
    return {word[:5] for word in re.findall(r"[a-z0-9]+", text.lower()) if word not in _STOPWORDS and len(word) > 1}


def is_placeholder(value: str) -> bool:
    """True for template echoes such as 'Supported', '<Subject 1>', or 'comma-separated ...'."""
    text = " ".join(str(value or "").split()).strip(" .\"'")
    return (not text or text.lower() in _PLACEHOLDER_NEEDS or bool(_LABEL.match(text)) or bool(_TEMPLATE.search(text)))


def _known(value: str) -> bool:
    return bool(value) and value.lower() != "unknown" and not is_placeholder(value)


def parse_requirements(text: str) -> dict[str, Any]:
    fields: dict[str, Any] = {"needs": [], "placeholders": []}
    for item in str(text or "").split("|"):
        key, separator, value = item.partition("=")
        if not separator:
            continue
        key = key.strip().lower()
        value = " ".join(value.split())[:120]
        if key == "needs":
            if value.lower().strip(" .") in {"", "none"}:
                continue  # a genuine "none" is a valid receipt
            for part in [part.strip()[:120] for part in value.split(",") if part.strip()][:4]:
                (fields["placeholders"] if is_placeholder(part) else fields["needs"]).append(part)
        elif key in {"start_position", "end_position", "start_posture", "end_posture"}:
            if value and value.lower() != "unknown" and is_placeholder(value):
                fields["placeholders"].append(f"{key}={value}")
                value = "unknown"
            fields[key] = value
    return fields


def receipt_is_concrete(requirements: dict[str, Any]) -> bool:
    """A receipt that names something checkable: a real evidence dependency or at least one known state."""
    return not requirements.get("placeholders") and (
        bool(requirements.get("needs"))
        or any(_known(requirements.get(key, "")) for key in ("start_position", "end_position", "start_posture", "end_posture")))


def posture_family(text: str) -> str:
    lowered = f" {str(text or '').lower()} "
    return next((family for family, words in _POSTURES if any(word in lowered for word in words)), "")


def equivalent(left: str, right: str) -> bool:
    """Same state in different words: identical after normalizing, or sharing a meaningful word."""
    if _normalize(left) == _normalize(right):
        return True
    a, b = _tokens(left), _tokens(right)
    return bool(a and b and (a <= b or b <= a or a & b))


def _evidence_match(need: str, items: list[str]) -> bool:
    return any(_normalize(need) == _normalize(item) or (_tokens(need) and _tokens(need) <= _tokens(item)) for item in items)


def validate_requirements(requirements: dict[str, Any], evidence: dict[str, list[str]] | None,
                          previous: dict[str, Any] | None, transition: str) -> tuple[list[str], list[str]]:
    """Return (hard conflicts, unverified items); unknowns are never conflicts and never validated."""
    conflicts, unknowns = [], []
    evidence = evidence or {}
    for placeholder in requirements.get("placeholders", ()):
        unknowns.append(f"receipt '{placeholder}' is template text, not a concrete dependency")
    for need in requirements.get("needs", []):
        if _evidence_match(need, evidence.get("contradicted", [])):
            conflicts.append(f"need '{need}' contradicts the visible location evidence")
        elif _evidence_match(need, evidence.get("unknown", [])):
            unknowns.append(f"need '{need}' depends on unknown location information")
        elif not any(_evidence_match(need, evidence.get(key, [])) for key in ("supported", "visible", "composition")):
            unknowns.append(f"need '{need}' is not in the recorded location evidence")
    if transition in ("Continue", "New angle") and previous:
        prior = previous.get("requirements") or {}
        before, after = prior.get("end_posture", ""), requirements.get("start_posture", "")
        if _known(before) and _known(after):
            a, b = posture_family(before), posture_family(after)
            if a and b and a != b:
                conflicts.append(f"{transition} changes posture from '{before}' to '{after}' at the join")
            elif not (a and b) and not equivalent(before, after):
                unknowns.append(f"could not confirm posture '{before}' -> '{after}' across the {transition} join")
        before, after = prior.get("end_position", ""), requirements.get("start_position", "")
        if _known(before) and _known(after) and not equivalent(before, after):
            if transition == "Continue":  # the overlap re-creates the previous frames, so the place must match
                conflicts.append(f"Continue changes position from '{before}' to '{after}' without a cut")
            else:  # framing words are camera-relative; a new angle can describe the same spot differently
                unknowns.append(f"could not confirm position '{before}' -> '{after}' across the new angle")
    return conflicts, unknowns


_STILL_INTENT = re.compile(r"\b(still|stillness|holds?|held|freezes?|frozen|pauses?|stops?|halts?|rests?|collapses?|"
                           r"sits?|kneels?|lies|lying|motionless|frozen|statue)\b", re.IGNORECASE)
_STOP = re.compile(r"(?<!without )(?<!never )(?<!not )\b(halts?|stops? (?:running|dancing|moving|abruptly|short|dead)|"
                   r"comes? to (?:a )?(?:stop|halt|standstill|rest)|skids? to a (?:stop|halt)|stands? still|"
                   r"freezes? in place|ends? (?:the|her|his|their) (?:run|dance|routine))\b", re.IGNORECASE)
_RESET = re.compile(r"\b(back (?:at|to) the (?:start|beginning|entrance|starting (?:point|line|position))|"
                    r"returns? to (?:the|her|his|their) (?:start|starting|original) (?:point|position|spot|mark)|"
                    r"starts? (?:over|again from the (?:top|beginning))|restarts? (?:the|her|his|their)|"
                    r"resets? to (?:a )?neutral|from a neutral stance)\b", re.IGNORECASE)


def _paragraphs(text: str) -> list[str]:
    return [p for p in re.split(r"\n\s*\n", text or "") if p.strip()]


def check_action_flow(action: str, next_plan: str, *, end_mode: str, intention: str, transition: str,
                      scene: str = "Freeform") -> list[str]:
    """Explicit resets and stops that contradict the clip's continuity plan.

    end_mode "continue" means the planned activity carries on past this clip (no stop or arrival is planned). A stop is
    then a conflict for a Freeform action unless the shot intention itself asks for stillness. Dance (a freeze is a move)
    and Performance (a singer may stand still) are not stop-checked. Repeated movement is never checked."""
    conflicts = []
    if end_mode == "continue" and scene == "Freeform" and not _STILL_INTENT.search(intention or ""):
        tail = " ".join(_paragraphs(action)[-1:] + _paragraphs(next_plan)[:1])
        found = _STOP.search(tail)
        if found:
            conflicts.append(f"the action stops (\"{found.group(0)}\") although the planned activity continues past "
                             "this clip; keep it going through the cut")
    if transition in ("Continue", "New angle"):
        found = _RESET.search(" ".join(_paragraphs(action)[:1]))
        if found:
            conflicts.append(f"the clip resets (\"{found.group(0)}\") instead of continuing from the previous clip's ending")
    return conflicts


def repair_message(message: str, response: str, conflicts: list[str]) -> str:
    return (message + "\n\nThe draft below has these specific consistency conflicts:\n- " + "\n- ".join(conflicts)
            + "\nRewrite the complete response once. Preserve the shot's creative purpose and the full length and detail of "
              "the action, but remove only these conflicts. Keep the exact requested headers, and write nothing after the "
              "last header's value.\n\nDRAFT:\n" + response)
