"""Local project files for the staged Martini Shot workflow."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import soundfile
import torch
from PIL import Image


PROJECT_VERSION = 1
_SAFE_NAME = re.compile(r"[^a-z0-9]+")
_IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")


def project_slug(name: str) -> str:
    value = _SAFE_NAME.sub("-", str(name or "").strip().lower()).strip("-")
    if not value:
        raise ValueError("Project name needs at least one letter or number.")
    return value[:80]


def projects_root() -> Path:
    import folder_paths

    return Path(folder_paths.get_output_directory()) / "martini_shot"


def project_folder(name: str) -> Path:
    return projects_root() / project_slug(name)


def _write_image(image: torch.Tensor, path: Path) -> None:
    value = image[0] if image.ndim == 4 else image
    array = value.detach().cpu().numpy()
    array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(array).save(path)


def _read_image(path: Path) -> torch.Tensor:
    with Image.open(path) as image:
        array = np.asarray(image.convert("RGB")).copy()
    return torch.from_numpy(array).float().div(255.0).unsqueeze(0)


def _save_manifest(folder: Path, value: dict[str, Any]) -> None:
    (folder / "project.json").write_text(json.dumps(value, indent=2, default=_json_value), encoding="utf-8")


def _read_manifest(folder: Path) -> dict[str, Any]:
    path = folder / "project.json"
    if not path.is_file():
        raise ValueError(f"Martini Shot project '{folder.name}' does not exist.")
    value = json.loads(path.read_text(encoding="utf-8"))
    if value.get("version") != PROJECT_VERSION:
        raise ValueError(f"Unsupported Martini Shot project format in {path}.")
    return value


def write_project(name: str, audio: dict[str, Any], refs: list[dict[str, Any]], replace_assets: bool) -> dict[str, Any]:
    folder = project_folder(name)
    assets = folder / "assets"
    if (folder / "project.json").is_file() and not replace_assets:
        return load_project(name)
    assets.mkdir(parents=True, exist_ok=True)
    waveform = audio["waveform"][0].detach().cpu().numpy()
    sample_rate = int(audio["sample_rate"])
    song_file = assets / "song.flac"
    soundfile.write(str(song_file), waveform.T.clip(-1, 1), sample_rate, format="FLAC", subtype="PCM_24")
    stored_refs = []
    for number, ref in enumerate(refs, start=1):
        file_name = f"reference_{number:02d}.png"
        _write_image(ref["image"], assets / file_name)
        stored_refs.append({
            "file": file_name,
            "kind": ref["kind"],
            "name": ref["name"],
            "weight": float(ref.get("weight", 1.0)),
            "tags": sorted(ref.get("tags", ())),
            "actions": list(ref.get("actions", ())),
            "description": ref.get("description", ""),
            "triggers": list(ref.get("triggers", ())),
            "broll_only": bool(ref.get("broll_only", False)),
        })
    manifest = {"version": PROJECT_VERSION, "name": project_slug(name), "song": song_file.name,
                "sample_rate": sample_rate, "references": stored_refs}
    _save_manifest(folder, manifest)
    return load_project(name)


def load_project(name: str) -> dict[str, Any]:
    folder = project_folder(name)
    manifest = _read_manifest(folder)
    song, sample_rate = soundfile.read(str(folder / "assets" / manifest["song"]), always_2d=True)
    audio = {"waveform": torch.from_numpy(song.T.copy()).float().unsqueeze(0), "sample_rate": int(sample_rate)}
    refs = []
    for stored in manifest["references"]:
        ref = dict(stored)
        ref["tags"] = set(ref.get("tags", ()))
        ref["image"] = _read_image(folder / "assets" / ref.pop("file"))
        refs.append(ref)
    return {"name": manifest["name"], "folder": str(folder), "audio": audio, "refs": refs, "manifest": manifest}


def write_state(project: dict[str, Any], name: str, value: dict[str, Any]) -> Path:
    path = Path(project["folder"]) / name
    path.write_text(json.dumps(value, indent=2, default=_json_value), encoding="utf-8")
    return path


def read_state(project: dict[str, Any], name: str) -> dict[str, Any]:
    path = Path(project["folder"]) / name
    if not path.is_file():
        raise ValueError(f"Martini Shot {name} has not been created for project '{project['name']}'.")
    value = json.loads(path.read_text(encoding="utf-8"))
    analysis = value.get("analysis") if isinstance(value, dict) else None
    if isinstance(analysis, dict) and isinstance(analysis.get("beats"), list):
        analysis["beats"] = np.asarray(analysis["beats"], dtype=np.float64)
    return value


def requested_location_path(project: dict[str, Any], name: str) -> Path:
    slug = project_slug(name)
    return Path(project["folder"]) / "locations" / f"{slug}.png"


def find_requested_location(project: dict[str, Any], name: str) -> tuple[torch.Tensor | None, str]:
    expected = requested_location_path(project, name)
    expected.parent.mkdir(parents=True, exist_ok=True)
    matches = [path for path in expected.parent.iterdir()
               if path.is_file() and path.suffix.lower() in _IMAGE_EXTENSIONS and project_slug(path.stem) == project_slug(name)]
    if not matches:
        return None, f"text-only — no image found; add {expected}"
    if len(matches) != 1:
        return None, "image failed to load — more than one matching image"
    try:
        return _read_image(matches[0]), f"image-backed — loaded {matches[0].name}"
    except (OSError, ValueError):
        return None, f"image failed to load — {matches[0].name}"


def _json_value(value: Any):
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, set):
        return sorted(value)
    raise TypeError(f"Cannot save {type(value).__name__} in a Martini Shot project file.")
