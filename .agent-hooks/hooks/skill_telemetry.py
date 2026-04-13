#\!/usr/bin/env python3
"""
Emit skill telemetry events to the Paperclip telemetry backend.

Encodes skill events as PreToolUse/PostToolUse with tool_name="skill:<name>"
so they flow through the existing event schema. The /skill-metrics endpoint
filters and aggregates by tool_name prefix.

Usage in SKILL.md:
  SKILL_START_MS=$(date +%s%3N)
  SKILL_SESSION="skill-<name>-$(date +%s)-$$"
  python3 "${CLAUDE_CONFIG_DIR:-/paperclip/.agent-hooks}/hooks/skill_telemetry.py" \
    start <name> "$SKILL_SESSION" 2>/dev/null &

  # ... skill work ...

  SKILL_DURATION_MS=$(( $(date +%s%3N) - SKILL_START_MS ))
  python3 "${CLAUDE_CONFIG_DIR:-/paperclip/.agent-hooks}/hooks/skill_telemetry.py" \
    end <name> "$SKILL_SESSION" --success true --duration_ms "$SKILL_DURATION_MS" 2>/dev/null &
"""

import json
import os
import sys
import urllib.request
import uuid

TELEMETRY_URL = os.environ.get("TELEMETRY_URL", "http://host.docker.internal:5001/events")
AGENT_NAME = os.environ.get("PAPERCLIP_AGENT_NAME", "unknown")


def parse_args(argv):
    if len(argv) < 3:
        return None, None, None, {}
    action = argv[1]
    skill_name = argv[2]
    session_id = None
    kwargs = {}
    i = 3
    while i < len(argv):
        arg = argv[i]
        if arg.startswith("--") and i + 1 < len(argv):
            kwargs[arg[2:]] = argv[i + 1]
            i += 2
        elif session_id is None and not arg.startswith("--"):
            session_id = arg
            i += 1
        else:
            i += 1
    if session_id is None:
        session_id = f"skill-{uuid.uuid4().hex[:8]}"
    return action, skill_name, session_id, kwargs


def build_event(action, skill_name, session_id, kwargs):
    if action == "start":
        return {
            "session_id": session_id,
            "event_type": "PreToolUse",
            "tool_name": f"skill:{skill_name}",
            "tool_input": {"skill_name": skill_name, "agent": AGENT_NAME},
            "metadata": {
                "agent_name": AGENT_NAME,
                "event_subtype": "SkillStart",
                "skill_name": skill_name,
                "source": "skill-telemetry",
            },
        }
    if action == "end":
        success = kwargs.get("success", "true").lower() in ("true", "1", "yes")
        duration_ms = None
        if "duration_ms" in kwargs:
            try:
                duration_ms = float(kwargs["duration_ms"])
            except ValueError:
                pass
        tokens_used = 0
        if "tokens_used" in kwargs:
            try:
                tokens_used = int(kwargs["tokens_used"])
            except ValueError:
                pass
        return {
            "session_id": session_id,
            "event_type": "PostToolUse",
            "tool_name": f"skill:{skill_name}",
            "tool_output": {"success": success, "tokens_used": tokens_used},
            "duration_ms": duration_ms,
            "error_message": None if success else kwargs.get("error", "skill reported failure"),
            "metadata": {
                "agent_name": AGENT_NAME,
                "event_subtype": "SkillEnd",
                "skill_name": skill_name,
                "success": success,
                "tokens_used": tokens_used,
                "source": "skill-telemetry",
            },
        }
    return None


def emit(event):
    try:
        req = urllib.request.Request(
            TELEMETRY_URL,
            data=json.dumps(event).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        pass  # Fail silently


def main():
    action, skill_name, session_id, kwargs = parse_args(sys.argv)
    if action is None:
        sys.exit(0)
    event = build_event(action, skill_name, session_id, kwargs)
    if event is not None:
        emit(event)


if __name__ == "__main__":
    main()
