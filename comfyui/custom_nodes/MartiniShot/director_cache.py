"""Small persistent cache for deterministic Auto Director planning calls."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Callable


SCHEMA_VERSION = "director-plan-cache-v1"


def cache_directory() -> Path:
    import folder_paths

    return Path(folder_paths.get_user_directory()) / "default" / "MartiniShot" / "director_plan_cache"


def clear_cache() -> str:
    root = cache_directory()
    try:
        if root.exists():
            shutil.rmtree(root)
        return "cleared"
    except OSError as error:
        return f"could not clear ({error})"


def _key(stage: str, llm: dict[str, Any], message: str, system: str, temperature: float, tokens: int, seed: int) -> str:
    identity = {name: llm.get(name, "") for name in ("name", "file", "clip_type")}
    payload = json.dumps({"schema": SCHEMA_VERSION, "stage": stage, "model": identity, "message": message,
                          "system": system, "temperature": temperature, "tokens": tokens, "seed": seed},
                         sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def cached_llm(stage: str, llm: dict[str, Any], message: str, kwargs: dict[str, Any], temperature: float, tokens: int,
               seed: int, system: str, run: Callable[..., str], root: Path | None = None) -> tuple[str, bool]:
    """Return a cached raw response when the complete local planning request is unchanged."""
    root = root or cache_directory()
    path = root / stage / f"{_key(stage, llm, message, system, temperature, tokens, seed)}.json"
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("response"), str):
            return value["response"], True
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        pass
    response = run(llm, message, kwargs, temperature, tokens, seed, system)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"response": response}, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        pass
    return response, False
