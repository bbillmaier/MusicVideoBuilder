"""Restricted project-file HTTP API for the Martini Shot desktop app.

The helpers in this file deliberately do not import ComfyUI so their path and
Range handling can be tested with a normal Python interpreter.
"""
from __future__ import annotations

import hashlib
import hmac
import mimetypes
import os
import re
from pathlib import Path

try:
    import folder_paths
    from aiohttp import web
    from server import PromptServer
except ImportError:  # Unit tests and tools can import the node pack without ComfyUI.
    folder_paths = None
    web = None
    PromptServer = None

API_VERSION = 1
_DRIVE = re.compile(r"^[a-zA-Z]:")


class PathError(ValueError):
    pass


def project_root(output_dir: str | Path) -> Path:
    return Path(output_dir).resolve() / "martini_shot"


def safe_path(root: str | Path, value: object, *, allow_empty: bool = True) -> Path:
    """Return a resolved child of root, rejecting wire-path tricks and symlinks."""
    if not isinstance(value, str):
        raise PathError("path must be a string")
    # Percent has no valid place in the app-generated wire paths. Rejecting it
    # also makes this guard safe when called before/after a URL decoder.
    if "\x00" in value or "%" in value or "\\" in value or _DRIVE.match(value) or value.startswith("/"):
        raise PathError("path must be a relative forward-slash path")
    if value == "" and allow_empty:
        return Path(root).resolve()
    parts = value.split("/")
    if not value or any(not part or part in (".", "..") for part in parts):
        raise PathError("path contains an invalid segment")
    root_path = Path(root).resolve()
    candidate = (root_path / Path(*parts)).resolve()
    try:
        candidate.relative_to(root_path)
    except ValueError as error:
        raise PathError("path resolves outside martini_shot") from error
    return candidate


def parse_range(value: str | None, size: int) -> tuple[int, int] | None:
    """Parse one HTTP byte range. Raises ValueError for malformed/unsatisfiable ranges."""
    if not value:
        return None
    if not value.startswith("bytes=") or "," in value:
        raise ValueError("invalid Range")
    start_text, sep, end_text = value[6:].partition("-")
    if not sep or size < 0 or (not start_text and not end_text):
        raise ValueError("invalid Range")
    try:
        if not start_text:
            length = int(end_text)
            if length <= 0: raise ValueError
            start, end = max(0, size - length), size - 1
        else:
            start = int(start_text)
            end = int(end_text) if end_text else size - 1
            if start < 0 or end < start: raise ValueError
            end = min(end, size - 1)
        if start >= size: raise ValueError
    except ValueError as error:
        raise ValueError("invalid Range") from error
    return start, end


def _error(message: str, status: int = 400, code: str = "bad_path"):
    return web.json_response({"error": message, "code": code}, status=status)


def _root() -> Path:
    return project_root(folder_paths.get_output_directory())


def _token_ok(request) -> bool:
    token = os.environ.get("MARTINI_SHOT_TOKEN")
    return not token or hmac.compare_digest(request.headers.get("X-Martini-Token", ""), token)


def _checked(request, value: object, *, allow_empty=True) -> Path:
    if not _token_ok(request):
        raise PermissionError("wrong or missing Martini Shot file API token")
    return safe_path(_root(), value, allow_empty=allow_empty)


def _info(request):
    if not _token_ok(request): return _error("wrong or missing Martini Shot file API token", 403, "bad_token")
    return web.json_response({"api": API_VERSION, "root": "martini_shot", "pack_version": "unknown", "token_required": bool(os.environ.get("MARTINI_SHOT_TOKEN"))})


async def _stat(request):
    try: target = _checked(request, request.query.get("path", ""))
    except PermissionError as e: return _error(str(e), 403, "bad_token")
    except PathError as e: return _error(str(e))
    if not target.exists(): return web.json_response({"exists": False})
    info = target.stat()
    return web.json_response({"exists": True, "type": "dir" if target.is_dir() else "file", "size": info.st_size, "mtime_ms": int(info.st_mtime * 1000)})


async def _list(request):
    try: target = _checked(request, request.query.get("path", ""))
    except PermissionError as e: return _error(str(e), 403, "bad_token")
    except PathError as e: return _error(str(e))
    if not target.exists(): return _error("path does not exist", 404, "missing")
    if not target.is_dir(): return _error("path is not a folder")
    entries = []
    for item in target.iterdir():
        # Do not expose a symlink that resolves outside our root.
        try: safe_path(_root(), item.relative_to(_root()).as_posix())
        except PathError: continue
        stat = item.stat()
        entries.append({"name": item.name, "type": "dir" if item.is_dir() else "file", "size": stat.st_size, "mtime_ms": int(stat.st_mtime * 1000)})
    return web.json_response({"entries": entries})


async def _file(request):
    try: target = _checked(request, request.query.get("path"), allow_empty=False)
    except PermissionError as e: return _error(str(e), 403, "bad_token")
    except PathError as e: return _error(str(e))
    if not target.is_file(): return _error("file does not exist", 404, "missing")
    size = target.stat().st_size
    try: selected = parse_range(request.headers.get("Range"), size)
    except ValueError: return web.Response(status=416, headers={"Content-Range": f"bytes */{size}"})
    start, end = selected if selected else (0, size - 1)
    headers = {"Accept-Ranges": "bytes", "Content-Type": mimetypes.guess_type(target.name)[0] or "application/octet-stream", "Content-Length": str(max(0, end - start + 1))}
    if selected: headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    response = web.StreamResponse(status=206 if selected else 200, headers=headers)
    await response.prepare(request)
    with target.open("rb") as source:
        source.seek(start)
        remaining = end - start + 1
        while remaining:
            data = source.read(min(1024 * 1024, remaining))
            if not data: break
            remaining -= len(data)
            await response.write(data)
    await response.write_eof()
    return response


async def _put(request):
    try: target = _checked(request, request.query.get("path"), allow_empty=False)
    except PermissionError as e: return _error(str(e), 403, "bad_token")
    except PathError as e: return _error(str(e))
    overwrite = request.query.get("overwrite", "0") in ("1", "true")
    if target.exists() and not overwrite: return _error("target already exists", 409, "exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    try:
        with partial.open("wb") as dest:
            while True:
                chunk = await request.content.read(1024 * 1024)
                if not chunk: break
                dest.write(chunk)
        if target.exists() and not overwrite: return _error("target already exists", 409, "exists")
        os.replace(partial, target)
    finally:
        partial.unlink(missing_ok=True)
    return web.json_response({"path": request.query["path"], "size": target.stat().st_size})


async def _hash(request):
    try: target = _checked(request, request.query.get("path"), allow_empty=False)
    except PermissionError as e: return _error(str(e), 403, "bad_token")
    except PathError as e: return _error(str(e))
    if not target.is_file(): return _error("file does not exist", 404, "missing")
    digest = hashlib.sha256()
    with target.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""): digest.update(chunk)
    stat = target.stat()
    return web.json_response({"sha256": digest.hexdigest(), "size": stat.st_size, "mtime_ms": int(stat.st_mtime * 1000)})


async def _mkdir(request):
    try: target = _checked(request, (await request.json()).get("path"), allow_empty=True)
    except PermissionError as e: return _error(str(e), 403, "bad_token")
    except (PathError, ValueError, AttributeError) as e: return _error(str(e))
    target.mkdir(parents=True, exist_ok=True)
    return web.json_response({"path": target.relative_to(_root()).as_posix()})


async def _move(request):
    try:
        body = await request.json(); source = _checked(request, body.get("from"), allow_empty=False); target = _checked(request, body.get("to"), allow_empty=False)
    except PermissionError as e: return _error(str(e), 403, "bad_token")
    except (PathError, ValueError, AttributeError) as e: return _error(str(e))
    if not source.exists(): return _error("source does not exist", 404, "missing")
    if target.exists() and not body.get("overwrite", False): return _error("target already exists", 409, "exists")
    target.parent.mkdir(parents=True, exist_ok=True); os.replace(source, target)
    return web.json_response({"from": body["from"], "to": body["to"]})


async def _delete(request):
    try: target = _checked(request, (await request.json()).get("path"), allow_empty=False)
    except PermissionError as e: return _error(str(e), 403, "bad_token")
    except (PathError, ValueError, AttributeError) as e: return _error(str(e))
    if not target.exists(): return _error("file does not exist", 404, "missing")
    if not target.is_file(): return _error("refusing to delete a folder")
    target.unlink(); return web.json_response({"deleted": True})


def register_file_api() -> None:
    if PromptServer is None or web is None: return
    routes = PromptServer.instance.routes
    routes.get("/martini/fs/info")(_info)
    routes.get("/martini/fs/stat")(_stat)
    routes.get("/martini/fs/list")(_list)
    routes.get("/martini/fs/file")(_file)
    routes.put("/martini/fs/file")(_put)
    routes.get("/martini/fs/hash")(_hash)
    routes.post("/martini/fs/mkdir")(_mkdir)
    routes.post("/martini/fs/move")(_move)
    routes.post("/martini/fs/delete")(_delete)

