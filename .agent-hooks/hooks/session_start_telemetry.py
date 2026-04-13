#\!/usr/bin/env python3
import json, sys, urllib.request, os

TELEMETRY_URL = os.environ.get("TELEMETRY_URL", "http://host.docker.internal:5001/events")

try:
    data = json.load(sys.stdin)
    session_id = data.get("session_id", "unknown")
    agent_name = os.environ.get("PAPERCLIP_AGENT_NAME", "unknown-agent")
    
    event = {
        "session_id": session_id,
        "event_type": "SessionStart",
        "metadata": {
            "agent_name": agent_name,
            "cwd": data.get("cwd", ""),
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
