"""Fixed-origin GitHub reader; no executable or config under the agent home."""

import http.client
import json
import os
import re


_PATH = re.compile(r"\Arepos/HelloPrintERP/(?:helloprint-frontend|helloprint-backend)/[A-Za-z0-9_./?=&%+-]+\Z")


def get_json(path):
    if not _PATH.fullmatch(path) or ".." in path:
        raise ValueError("invalid GitHub API path")
    with open(os.environ["GITHUB_TOKEN_FILE"], encoding="utf-8") as source:
        token = source.read().strip()
    if not token:
        raise ValueError("empty GitHub credential")
    connection = http.client.HTTPSConnection("api.github.com", timeout=90)
    try:
        connection.request(
            "GET", "/" + path,
            headers={"Accept": "application/vnd.github+json", "User-Agent": "paperclip-host-watchers",
                     "Authorization": "Bearer " + token},
        )
        response = connection.getresponse()
        raw = response.read(2_097_153)
        if response.status != 200:
            raise RuntimeError("GitHub API HTTP %d" % response.status)
        if len(raw) > 2_097_152:
            raise ValueError("GitHub response too large")
        return json.loads(raw)
    finally:
        connection.close()
