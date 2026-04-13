#\!/usr/bin/env python3
import json, sys, urllib.request, os

TELEMETRY_URL = os.environ.get("TELEMETRY_URL", "http://host.docker.internal:5001/events")

try:
    data = json.load(sys.stdin)
    event = {
        "session_id": data.get("session_id", "unknown"),
        "event_type": "SessionEnd",
        "metadata": {
            "agent_name": os.environ.get("PAPERCLIP_AGENT_NAME", "unknown-agent"),
            "duration_ms": data.get("duration_ms"),
            "source": "paperclip-agent"
        }
    }
    req = urllib.request.Request(
        TELEMETRY_URL,
        data=json.dumps(event).encode(),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    urllib.request.urlopen(req, timeout=2)
except Exception:
    pass
