"""HTTP-Anbindung an einen ComfyUI-Knoten. Kennt kein Paperclip.

Das Parsen der Antworten liegt in eigenen, netzfreien Funktionen, damit es
ohne laufenden Server testbar bleibt.
"""
import json
import urllib.parse
import urllib.request
import urllib.error

from config import COMFY_BASE, COMFY_HTTP_TIMEOUT


class ComfyError(RuntimeError):
    """Knoten nicht erreichbar oder antwortet fehlerhaft."""


def parse_prompt_response(data):
    pid = (data or {}).get("prompt_id")
    if not pid:
        raise ComfyError("ComfyUI lieferte keine prompt_id: %s" % json.dumps(data)[:300])
    return pid


def _error_text(status):
    parts = []
    for msg in status.get("messages") or []:
        if not isinstance(msg, (list, tuple)) or len(msg) < 2:
            continue
        kind, info = msg[0], msg[1]
        if kind != "execution_error" or not isinstance(info, dict):
            continue
        parts.append("%s: %s" % (info.get("node_type", "?"),
                                 info.get("exception_message", "?")))
    return "; ".join(parts) if parts else "Ausführungsfehler ohne Detailmeldung."


def parse_history(prompt_id, hist):
    entry = (hist or {}).get(prompt_id)
    if not entry:
        return "running", None
    status = entry.get("status") or {}
    if status.get("status_str") == "error":
        return "error", _error_text(status)
    if not status.get("completed"):
        return "running", None
    images = []
    for out in (entry.get("outputs") or {}).values():
        images.extend(out.get("images") or [])
    if not images:
        return "error", "Lauf abgeschlossen, aber ohne Bild im Ergebnis."
    return "done", images


def view_path(image):
    query = urllib.parse.urlencode({
        "filename": image.get("filename", ""),
        "subfolder": image.get("subfolder", ""),
        "type": image.get("type", "output"),
    })
    return "/view?" + query


def _get(path, timeout=None):
    url = COMFY_BASE + path
    try:
        with urllib.request.urlopen(url, timeout=timeout or COMFY_HTTP_TIMEOUT) as resp:
            return resp.read()
    except (urllib.error.URLError, OSError) as e:
        raise ComfyError("ComfyUI nicht erreichbar (%s): %s" % (path, e))


def health():
    try:
        _get("/system_stats", timeout=5)
        return True
    except ComfyError:
        return False


def submit(workflow):
    body = json.dumps({"prompt": workflow}).encode()
    req = urllib.request.Request(COMFY_BASE + "/prompt", data=body,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=COMFY_HTTP_TIMEOUT) as resp:
            raw = resp.read()
            try:
                return parse_prompt_response(json.loads(raw))
            except ValueError as e:
                raise ComfyError("ComfyUI antwortet ungültiges JSON auf /prompt: %s" % raw.decode(errors="replace")[:200])
    except urllib.error.HTTPError as e:
        raise ComfyError("ComfyUI HTTP %s: %s" % (e.code, e.read().decode(errors="replace")[:400]))
    except (urllib.error.URLError, OSError) as e:
        raise ComfyError("ComfyUI nicht erreichbar (/prompt): %s" % e)


def poll(prompt_id):
    raw = _get("/history/%s" % urllib.parse.quote(prompt_id))
    try:
        return parse_history(prompt_id, json.loads(raw))
    except ValueError as e:
        raise ComfyError("ComfyUI antwortet ungültiges JSON auf /history: %s" % raw.decode(errors="replace")[:200])


def fetch_image(image):
    return _get(view_path(image), timeout=60)
