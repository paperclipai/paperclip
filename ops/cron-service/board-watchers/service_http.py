"""Paperclip transport for one host service identity.

The token path and API origin come from a root-owned systemd unit.  Redirects
are rejected so an upstream response cannot forward Authorization elsewhere.
"""

import json
import os
import urllib.request
from urllib.parse import urlsplit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def request(method, path, body=None):
    if method not in {"GET", "POST", "PATCH"} or not path.startswith("/api/"):
        raise ValueError("invalid Paperclip request")
    origin = os.environ["PAPERCLIP_API_URL"].rstrip("/")
    parsed = urlsplit(origin)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path:
        raise ValueError("PAPERCLIP_API_URL must be an origin")
    with open(os.environ["PAPERCLIP_TOKEN_FILE"], encoding="utf-8") as source:
        token = source.read().strip()
    if not token:
        raise ValueError("empty service credential")
    payload = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    call = urllib.request.Request(
        origin + path,
        data=payload,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect).open(call, timeout=30) as response:
        raw = response.read(1_048_577)
    if len(raw) > 1_048_576:
        raise ValueError("Paperclip response too large")
    return json.loads(raw) if raw else {}
