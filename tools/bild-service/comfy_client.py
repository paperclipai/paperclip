"""HTTP-Anbindung an einen ComfyUI-Knoten. Kennt kein Paperclip.

Das Parsen der Antworten liegt in eigenen, netzfreien Funktionen, damit es
ohne laufenden Server testbar bleibt.
"""
import json
import uuid
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


def parse_upload_response(data):
    name = (data or {}).get("name")
    if not name:
        raise ComfyError("ComfyUI lieferte keinen Dateinamen beim Upload: %s"
                         % json.dumps(data)[:300])
    sub = (data or {}).get("subfolder") or ""
    # LoadImage erwartet den Unterordner im Namen, nicht als eigenes Feld.
    return "%s/%s" % (sub, name) if sub else name


def upload_image(filename, content):
    """Quellbild in den input-Ordner des Knotens legen.

    Rueckgabe ist der Name, den der Knoten VERGEBEN hat -- nicht der
    uebergebene: bei Namensgleichheit haengt ComfyUI eine Nummer an, und
    LoadImage findet die Datei sonst nicht.
    """
    boundary = "----bild" + uuid.uuid4().hex
    pre = ("--%s\r\n"
           'Content-Disposition: form-data; name="image"; filename="%s"\r\n'
           "Content-Type: application/octet-stream\r\n\r\n" % (boundary, filename)).encode()
    mid = ("\r\n--%s\r\n"
           'Content-Disposition: form-data; name="type"\r\n\r\ninput' % boundary).encode()
    post = ("\r\n--%s--\r\n" % boundary).encode()
    body = pre + content + mid + post
    req = urllib.request.Request(
        COMFY_BASE + "/upload/image", data=body,
        headers={"Content-Type": "multipart/form-data; boundary=%s" % boundary},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            try:
                return parse_upload_response(json.loads(raw))
            except ValueError:
                raise ComfyError("ComfyUI antwortet ungültiges JSON auf /upload/image: %s"
                                 % raw.decode(errors="replace")[:200])
    except urllib.error.HTTPError as e:
        raise ComfyError("ComfyUI HTTP %s beim Upload von %s" % (e.code, filename))
    except (urllib.error.URLError, OSError) as e:
        raise ComfyError("ComfyUI nicht erreichbar (/upload/image): %s" % e)
