#\!/usr/bin/env python3
import json, sys, urllib.request, os, time

TELEMETRY_URL = os.environ.get("TELEMETRY_URL", "http://host.docker.internal:5001/events")

try:
    data = json.load(sys.stdin)
    event = {
        "session_id": data.get("session_id", "unknown"),
        "event_type": "PostToolUse",
        "tool_name": data.get("tool_name", ""),
        "tool_output": data.get("tool_response", {}),
        "duration_ms": data.get("duration_ms"),
        "error_message": data.get("error"),
        "metadata": {
            "agent_name": os.environ.get("PAPERCLIP_AGENT_NAME", "unknown-agent"),
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
