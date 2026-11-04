"""Cached, image-derived location evidence for the Auto Director."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Callable


SCHEMA_VERSION = "location-evidence-v2"
SYSTEM_PROMPT = """You inspect one music-video location reference image. Report only what the image supports.
Do not infer off-camera space, exact measurements, load-bearing strength, safe access, or hidden paths. A cropped
floor is unknown, not proof that the room has no floor space. An interaction may be a creative possibility only when
there is visible image evidence. Return exactly one JSON object with these arrays of short strings:
visible, style, composition, supported, contradicted, unknown.
style is visible lighting, palette, textures, era, and atmosphere; do not infer hidden geometry from it.
supported means visible scene features that can support an interaction or framing. contradicted means only a clear
visible conflict in this composition. unknown must include important off-camera or unobservable facts. No markdown."""


def image_key(image: Any) -> str:
    import numpy as np

    pixels = (image[0, :, :, :3].float().cpu().numpy().clip(0, 1) * 255).round().astype(np.uint8)
    digest = hashlib.sha256()
    digest.update(str(tuple(pixels.shape)).encode("ascii"))
    digest.update(pixels.tobytes())
    return digest.hexdigest()


def cache_key(image: Any, llm: dict[str, Any]) -> str:
    identity = {key: llm.get(key, "") for key in ("name", "file", "clip_type")}
    payload = json.dumps({"image": image_key(image), "model": identity, "schema": SCHEMA_VERSION},
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def cache_directory() -> Path:
    import folder_paths

    return Path(folder_paths.get_user_directory()) / "default" / "MartiniShot" / "location_evidence"


def parse_evidence(text: str) -> dict[str, list[str]] | None:
    try:
        value = json.loads(text[text.find("{"):text.rfind("}") + 1])
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    evidence = {}
    for key in ("visible", "style", "composition", "supported", "contradicted", "unknown"):
        items = value.get(key, [])
        if not isinstance(items, list):
            return None
        cleaned = [" ".join(item.split())[:240] for item in items if isinstance(item, str) and item.strip()]
        evidence[key] = cleaned[:8]
    return evidence if any(evidence.values()) else None


def load_cached(path: Path) -> dict[str, list[str]] | None:
    try:
        return parse_evidence(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return None


def save_cached(path: Path, evidence: dict[str, list[str]]) -> bool:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(evidence, separators=(",", ":")), encoding="utf-8")
        return True
    except OSError:
        return False


def evidence_text(evidence: dict[str, list[str]] | None, limit: int = 900) -> str:
    if not evidence:
        return ""
    labels = (("visible", "Visible"), ("style", "Style"), ("composition", "Composition"), ("supported", "Supported"),
              ("contradicted", "Contradicted"), ("unknown", "Unknown"))
    text = "; ".join(f"{label}: {', '.join(evidence[key])}" for key, label in labels if evidence.get(key))
    return text[:limit].rstrip(" ,;")


def parse_evidence_text(text: str) -> dict[str, list[str]] | None:
    marker = "Image-derived location evidence:"
    if marker not in text:
        return None
    value = text.split(marker, 1)[1].split(".", 1)[0]
    evidence = {key: [] for key in ("visible", "style", "composition", "supported", "contradicted", "unknown")}
    for part in value.split(";"):
        label, separator, items = part.partition(":")
        key = label.strip().lower()
        if separator and key in evidence:
            evidence[key] = [item.strip() for item in items.split(",") if item.strip()]
    return evidence if any(evidence.values()) else None


def analyze_locations(refs: list[dict[str, Any]], llm: dict[str, Any] | None,
                      run: Callable[..., str], image_kwargs: Callable[..., dict[str, Any]], seed: int,
                      root: Path | None = None) -> list[str]:
    """Attach evidence to unique real location images and return report lines."""
    if not any(ref.get("kind") == "Location" and ref.get("image") is not None for ref in refs):
        return []
    if llm is None:
        return ["  WARNING: location understanding needs the llm input connected; using supplied location text."]
    if not llm.get("vision"):
        return [f"  WARNING: {llm.get('name', 'The selected LLM')} has no vision; using supplied location text."]
    root = root or cache_directory()
    seen: dict[str, dict[str, list[str]] | None] = {}
    lines = []
    for ref in refs:
        if ref.get("kind") != "Location" or ref.get("image") is None:
            continue
        key = cache_key(ref["image"], llm)
        if key not in seen:
            path = root / f"{key}.json"
            evidence = load_cached(path)
            hit = evidence is not None
            if evidence is None:
                response = run(llm, "Inspect the attached image as this location reference.", image_kwargs(llm, ref["image"]),
                               0.0, 300, seed + len(seen), SYSTEM_PROMPT)
                evidence = parse_evidence(response)
                if evidence is not None:
                    save_cached(path, evidence)
            seen[key] = evidence
            lines.append(f"  {ref['name']}: {'cache hit' if hit else 'analyzed' if evidence else 'no usable analysis'}")
            if evidence:
                for field, label in (("visible", "Visible"), ("style", "Style"), ("composition", "Composition"),
                                     ("supported", "Supported"), ("contradicted", "Contradicted"), ("unknown", "Unknown")):
                    if evidence.get(field):
                        lines.append(f"    {label}: {', '.join(evidence[field])}")
        ref["location_evidence"] = seen[key]
    return lines
