"""The Direction shot mix: four scene-type weights (Dance, Performance, Freeform, B-roll) and per-role force ticks.

Each song section gets one scene type. Its chance of each type is that type's weight divided by the total. Ticking types
for a role (e.g. chorus: Performance) restricts that role's sections to the ticked types, still weighted by their
sliders; a ticked type with weight 0 still counts (the ticked types then share equally if all are 0). With nothing
ticked and every weight 0, sections dance. Pure functions only, so the plan and the production rules share them.
"""
from __future__ import annotations

from typing import Any

SCENES = ("Dance", "Performance", "Freeform", "B-roll")
# The default force ticks: intros and outros are B-roll, which keeps the old rule that they lean to cutaways.
DEFAULT_FORCED_TEXT = "intro:B-roll;outro:B-roll"


def role_key(role: Any) -> str:
    """Section roles compared loosely: 'Pre chorus', 'prechorus', and 'pre-chorus' are one role."""
    text = "-".join(str(role or "").lower().replace("_", " ").split())
    return {"prechorus": "pre-chorus", "postchorus": "post-chorus"}.get(text, text)


def parse_forced(text: Any) -> dict[str, tuple[str, ...]]:
    """'intro:B-roll;chorus:Performance+Dance' -> {'intro': ('B-roll',), 'chorus': ('Performance', 'Dance')}.
    Unknown scene names are ignored; an empty text means nothing is forced."""
    lookup = {scene.lower(): scene for scene in SCENES}
    forced: dict[str, tuple[str, ...]] = {}
    for entry in str(text or "").split(";"):
        role, _, scenes = entry.partition(":")
        picked = tuple(dict.fromkeys(lookup[s.strip().lower()] for s in scenes.split("+") if s.strip().lower() in lookup))
        if role_key(role) and picked:
            forced[role_key(role)] = picked
    return forced


def format_forced(forced: dict[str, tuple[str, ...]]) -> str:
    return ";".join(f"{role}:{'+'.join(scenes)}" for role, scenes in forced.items() if scenes)


def mix_weights(dance: float | None, performance: float, freeform: float, broll: float) -> dict[str, float]:
    """The four weights. dance None or below 0 is a workflow from before the Dance slider: the old
    'Performance vs Dance' slider then gives Dance = 1 - Performance."""
    performance = max(0.0, float(performance))
    dance = 1.0 - min(performance, 1.0) if dance is None or float(dance) < 0 else float(dance)
    return {"Dance": max(0.0, dance), "Performance": performance, "Freeform": max(0.0, float(freeform)),
            "B-roll": max(0.0, float(broll))}


def section_pool(weights: dict[str, float], role: Any, forced: dict[str, tuple[str, ...]] | None) -> list[tuple[str, float]]:
    """(scene, probability) for one section's role, probabilities summing to 1, in SCENES order."""
    allowed = (forced or {}).get(role_key(role))
    pool = [scene for scene in SCENES if not allowed or scene in allowed]
    values = [max(0.0, float(weights.get(scene, 0.0))) for scene in pool]
    total = sum(values)
    if total <= 0:
        if not allowed:
            return [("Dance", 1.0)]
        return [(scene, 1.0 / len(pool)) for scene in pool]
    return [(scene, value / total) for scene, value in zip(pool, values) if value > 0]


def pick_scene(pool: list[tuple[str, float]], u: float) -> str:
    """The pool entry that the uniform value u (0 <= u < 1) lands in."""
    running = 0.0
    for scene, chance in pool:
        running += chance
        if u < running:
            return scene
    return pool[-1][0]


def allows(pool: list[tuple[str, float]], scene: str) -> bool:
    return any(name == scene for name, _ in pool)


def describe_mix(weights: dict[str, float], forced: dict[str, tuple[str, ...]] | None) -> str:
    """One line for reports: the unforced split, then each forced role."""
    def split(pool):
        return " / ".join(f"{scene} {round(chance * 100)}%" for scene, chance in pool)
    parts = [f"unforced sections: {split(section_pool(weights, '', None))}"]
    for role, scenes in (forced or {}).items():
        parts.append(f"{role}: {split(section_pool(weights, role, forced))} (forced {'+'.join(scenes)})")
    return "; ".join(parts)
