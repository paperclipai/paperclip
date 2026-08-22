import json, uuid, urllib.request, urllib.error
from config import (PAPERCLIP_BASE, AUTH_JSON, MAIL_WEBHOOK, MAIL_SECRET_ENV,
                    MAIL_FROM, MAIL_TO, read_secret)

class AuthError(Exception):
    pass


class PaperclipError(RuntimeError):
    """Nicht-Auth-Fehler beim Reden mit Paperclip (HTTP-Status, Netzwerk, JSON).

    Faengt alles ab, was _request() sonst als bare RuntimeError oder gar
    nicht typisiert durchreichen wuerde. Erbt von RuntimeError, damit
    bestehende breite except-Bloecke (except Exception / except RuntimeError)
    weiterhin greifen.
    """


class PaperclipUnreachable(PaperclipError):
    """Paperclip antwortet ueberhaupt nicht (Verbindung abgelehnt, DNS, Timeout).

    Eigener Typ, weil der Aufrufer diesen Fall daempfen muss: :3100 laeuft im
    Dev-Modus unter launchd und ist bei jedem Neustart fuer ein paar Minuten
    weg. Ein HTTP-Status (auch 500) ist ausdruecklich KEIN Fall hierfuer --
    da antwortet der Server ja, und ein solcher Fehler soll sofort auffallen.
    """


def _token():
    with open(AUTH_JSON) as f:
        return json.load(f)["credentials"][PAPERCLIP_BASE]["token"]

def _request(method, path, *, json_body=None, multipart=None, base=PAPERCLIP_BASE):
    url = base + path
    headers = {"Authorization": f"Bearer {_token()}"}
    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode()
        headers["Content-Type"] = "application/json"
    elif multipart is not None:
        boundary = "----bild" + uuid.uuid4().hex
        filename, content = multipart
        pre = (f"--{boundary}\r\n"
               f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
               f"Content-Type: image/png\r\n\r\n").encode()
        post = f"\r\n--{boundary}--\r\n".encode()
        data = pre + content + post
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            try:
                return json.loads(raw) if raw else {}
            except json.JSONDecodeError as e:
                raise PaperclipError(
                    "Paperclip %s %s: ungueltiges JSON in der Antwort (%s): %s"
                    % (method, path, e, raw.decode(errors="replace")[:300]))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise AuthError(f"Paperclip {e.code} — Board-Token abgelaufen.")
        raise PaperclipError(
            "Paperclip %s %s: HTTP %s: %s"
            % (method, path, e.code, e.read().decode(errors="replace")[:300]))
    except urllib.error.URLError as e:
        raise PaperclipUnreachable("Paperclip %s %s: nicht erreichbar: %s" % (method, path, e))
    except OSError as e:
        raise PaperclipUnreachable("Paperclip %s %s: OS-Fehler: %s" % (method, path, e))

def list_issues(company_id, status, label_id, limit=100):
    return _request("GET",
        f"/api/companies/{company_id}/issues?status={status}&labelId={label_id}&limit={limit}")

def get_issue(issue_id):
    return _request("GET", f"/api/issues/{issue_id}")

def list_attachments(issue_id):
    return _request("GET", "/api/issues/%s/attachments" % issue_id)


def fetch_attachment(attachment_id):
    """Rohe Bytes eines Anhangs.

    Geht bewusst NICHT durch _request(): das dortige json.loads() wuerde ein
    PNG als kaputtes JSON abweisen.
    """
    url = PAPERCLIP_BASE + "/api/attachments/%s/content" % attachment_id
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + _token()})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise AuthError("Paperclip %s — Board-Token abgelaufen." % e.code)
        raise PaperclipError("Paperclip GET Anhang %s: HTTP %s: %s"
                             % (attachment_id, e.code,
                                e.read().decode(errors="replace")[:300]))
    except urllib.error.URLError as e:
        raise PaperclipUnreachable("Paperclip GET Anhang %s: nicht erreichbar: %s"
                                   % (attachment_id, e))
    except OSError as e:
        raise PaperclipUnreachable("Paperclip GET Anhang %s: OS-Fehler: %s"
                                   % (attachment_id, e))

def patch_status(issue_id, status):
    return _request("PATCH", f"/api/issues/{issue_id}", json_body={"status": status})

def add_comment(issue_id, body):
    return _request("POST", f"/api/issues/{issue_id}/comments", json_body={"body": body})

def upload_attachment(company_id, issue_id, filename, png_bytes):
    return _request("POST",
        f"/api/companies/{company_id}/issues/{issue_id}/attachments",
        multipart=(filename, png_bytes))

def mail_alarm(subject, text):
    try:
        mail_secret = read_secret(MAIL_SECRET_ENV, "MAILHUB_SECRET")
        body = json.dumps({"from": MAIL_FROM, "to": MAIL_TO,
                           "subject": subject, "text": text}).encode()
        req = urllib.request.Request(MAIL_WEBHOOK, data=body,
            headers={"Content-Type": "application/json", "X-Mailhub-Secret": mail_secret},
            method="POST")
        urllib.request.urlopen(req, timeout=20)
    except Exception:
        pass
