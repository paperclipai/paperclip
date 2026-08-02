import json, uuid, urllib.request, urllib.error
from config import (PAPERCLIP_BASE, AUTH_JSON, MAIL_WEBHOOK, MAIL_SECRET,
                    MAIL_FROM, MAIL_TO)

class AuthError(Exception):
    pass

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
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise AuthError(f"Paperclip {e.code} — Board-Token abgelaufen.")
        raise RuntimeError(f"Paperclip HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")

def list_issues(company_id, status, label_id, limit=100):
    return _request("GET",
        f"/api/companies/{company_id}/issues?status={status}&labelId={label_id}&limit={limit}")

def patch_status(issue_id, status):
    return _request("PATCH", f"/api/issues/{issue_id}", json_body={"status": status})

def add_comment(issue_id, body):
    return _request("POST", f"/api/issues/{issue_id}/comments", json_body={"body": body})

def upload_attachment(company_id, issue_id, filename, png_bytes):
    return _request("POST",
        f"/api/companies/{company_id}/issues/{issue_id}/attachments",
        multipart=(filename, png_bytes))

def mail_alarm(subject, text):
    body = json.dumps({"from": MAIL_FROM, "to": MAIL_TO,
                       "subject": subject, "text": text}).encode()
    req = urllib.request.Request(MAIL_WEBHOOK, data=body,
        headers={"Content-Type": "application/json", "X-Mailhub-Secret": MAIL_SECRET},
        method="POST")
    try:
        urllib.request.urlopen(req, timeout=20)
    except Exception:
        pass
