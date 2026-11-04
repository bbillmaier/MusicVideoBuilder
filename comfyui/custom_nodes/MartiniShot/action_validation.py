"""Small deterministic consistency checks for opt-in action validation."""

from __future__ import annotations

import re
from typing import Any


def parse_requirements(text: str) -> dict[str, Any]:
    fields: dict[str, Any] = {"needs": []}
    for item in text.split("|"):
        key, separator, value = item.partition("=")
        if not separator:
            continue
        key = key.strip().lower()
        value = " ".join(value.split())[:120]
        if key == "needs":
            fields[key] = [] if value.lower() in {"", "none", "unknown"} else [
                part.strip()[:120] for part in value.split(",") if part.strip()
            ][:4]
        elif key in {"start_position", "end_position", "start_posture", "end_posture"}:
            fields[key] = value
    return fields


def _same(left: str, right: str) -> bool:
    normalize = lambda text: re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return normalize(left) == normalize(right)


def validate_requirements(requirements: dict[str, Any], evidence: dict[str, list[str]] | None,
                          previous: dict[str, Any] | None, transition: str) -> tuple[list[str], list[str]]:
    """Return (hard conflicts, unknown dependencies), never treating unknowns as conflicts."""
    conflicts, unknowns = [], []
    evidence = evidence or {}
    for need in requirements.get("needs", []):
        if any(_same(need, item) for item in evidence.get("contradicted", ())):
            conflicts.append(f"need '{need}' contradicts the visible location evidence")
        elif any(_same(need, item) for item in evidence.get("unknown", ())):
            unknowns.append(f"need '{need}' depends on unknown location information")
    if transition == "Continue" and previous:
        prior = previous.get("requirements", {})
        for earlier, current, label in (("end_position", "start_position", "position"),
                                        ("end_posture", "start_posture", "posture")):
            before, after = prior.get(earlier, ""), requirements.get(current, "")
            if before and after and before.lower() != "unknown" and after.lower() != "unknown" and not _same(before, after):
                conflicts.append(f"Continue changes {label} from '{before}' to '{after}' without a cut")
    return conflicts, unknowns


def repair_message(message: str, response: str, conflicts: list[str]) -> str:
    return (message + "\n\nThe draft below has these specific consistency conflicts:\n- " + "\n- ".join(conflicts)
            + "\nRewrite the complete response once. Preserve the shot's creative purpose, but remove only these "
              "conflicts. Keep the exact requested headers, including REQUIREMENTS.\n\nDRAFT:\n" + response)
