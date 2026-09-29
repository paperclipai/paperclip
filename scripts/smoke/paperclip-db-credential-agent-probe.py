#!/usr/bin/env python3
"""Run inside the disposable agent UID. Print no credential or token values."""

import json
import os
import urllib.request


def main() -> None:
    forbidden = [
        key for key in os.environ
        if key in {
            "DATABASE_URL", "DATABASE_MIGRATION_URL",
            "PAPERCLIP_DATABASE_URL_FILE", "PAPERCLIP_AGENT_JWT_SECRET",
        } or (key.startswith("PG") and key not in {"PGDATA", "PG_MAJOR", "PG_VERSION"})
    ]
    if forbidden:
        raise RuntimeError("agent inherited database or signing keys: " + ",".join(forbidden))

    hidden_by_sandbox = os.environ.get("EXPECTED_CREDENTIAL_VISIBILITY") == "hidden"
    if not hidden_by_sandbox and os.geteuid() == int(os.environ["EXPECTED_SERVICE_UID"]):
        raise RuntimeError("agent still has the service UID")
    credential_path = os.environ["KNOWN_CREDENTIAL_PATH"]
    if hidden_by_sandbox and os.path.exists(credential_path):
        raise RuntimeError("workspace sandbox exposed the service credential path")
    if not hidden_by_sandbox and not os.path.isfile(credential_path):
        raise RuntimeError("credential fixture is not visible at the known path")
    try:
        with open(credential_path, "rb") as credential:
            credential.read(1)
    except (FileNotFoundError, PermissionError):
        pass
    else:
        raise RuntimeError("agent can read the service database credential")

    request = urllib.request.Request(
        os.environ["PAPERCLIP_API_URL"] + "/api/agents/me",
        headers={
            "Authorization": "Bearer " + os.environ["PAPERCLIP_API_KEY"],
            "X-Paperclip-Run-Id": os.environ["PAPERCLIP_RUN_ID"],
        },
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status != 200:
            raise RuntimeError("agent API request failed")
        body = json.load(response)
    if body.get("id") != os.environ["EXPECTED_AGENT_ID"]:
        raise RuntimeError("JWT resolved a different agent")
    print("Launched agent: credential read denied; DB/signing env keys 0; JWT API HTTP 200")


if __name__ == "__main__":
    main()
