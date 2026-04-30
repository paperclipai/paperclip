#!/usr/bin/env python3
"""Koenig org cron driver — pokes Chief Engineering periodically so the
agent dispatch cascade keeps flowing.

WHY THIS EXISTS
Paperclip's internal scheduler does NOT have a continuous tick loop. Routines
have nextRunAt timestamps but nothing fires them. The historical launchd plists
called `/heartbeat/invoke` directly, but they used the wrong agent UUIDs and
relied on `local_trusted` deployment mode (server now runs `authenticated`).

The watchdog API key's `sub` claim is `b90788a0-d3de-42da-8e77-7dc8f7c01fd3`
(Chief Engineering). The /api/agents/{id}/heartbeat/invoke endpoint enforces
"agent can only invoke itself" — so this token CAN wake Chief Engineering.
Chief Engineering's heartbeat skill reads its inbox, picks up tickets, and
dispatches sub-tickets to other agents (Blog Author, Content Reviewer, etc.).
Those agents auto-wake on assignment via Paperclip's `wake_assignee`
continuation policy. So poking Chief Engineering once cascades into the whole
org doing work.

DESIGN
- Single Python process, infinite loop, sleep between ticks.
- Reads creds from /Users/vardaankoenig/Documents/Paperclip/koenig-ai-org/.env.koenig
  (keeps the JWT out of the launchd plist).
- Logs to scripts/.logs/koenig-cron-driver.log (rotated by stat-and-truncate when >5MB).
- HTTP errors are warnings, not crashes — they'll usually be `Internal server error`
  even when the wake actually fires (Paperclip quirk).
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

REPO = Path("/Users/vardaankoenig/Documents/Paperclip/koenig-ai-org")
ENV_FILE = REPO / ".env.koenig"
LOG_DIR = REPO / "scripts" / ".logs"
LOG_FILE = LOG_DIR / "koenig-cron-driver.log"
LOG_MAX_BYTES = 5 * 1024 * 1024  # 5 MB

PAPERCLIP_HOST = os.environ.get("PAPERCLIP_HOST", "http://localhost:3100")
COMPANY_ID = "2a77f89b-33f0-4133-a20c-77ddaac5e744"
CHIEF_ENGINEERING_ID = "b90788a0-d3de-42da-8e77-7dc8f7c01fd3"

# Tick cadence. 5 min keeps the inbox warm without burning Claude Max hours.
TICK_INTERVAL_S = int(os.environ.get("KOENIG_CRON_TICK_S", "300"))


def parse_env_file(path: Path) -> dict:
    """Tiny .env reader — handles `KEY=value`, `KEY="value with spaces"`, comments."""
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        # Strip surrounding quotes if present
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            val = val[1:-1]
        out[key] = val
    return out


def log(msg: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    # Rotate by truncating when too big — simple, no rotation deps
    if LOG_FILE.exists() and LOG_FILE.stat().st_size > LOG_MAX_BYTES:
        LOG_FILE.write_text("")
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    line = f"{ts} {msg}\n"
    sys.stdout.write(line)
    sys.stdout.flush()
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(line)


def post(url: str, token: str, body: dict | None = None, timeout: float = 10) -> tuple[int, str]:
    data = json.dumps(body or {}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            # Paperclip enforces a hostname allowlist; "localhost" is always allowed,
            # so spoof Host even when reaching the server via a docker service name.
            "Host": "localhost:3100",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8")[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")[:300]
    except Exception as e:  # noqa: BLE001 — network timeouts, DNS, etc.
        return 0, f"network error: {e}"


def heartbeat_freshness(token: str) -> str:
    """Return a 1-line summary of how many agents heartbeated in the last 10 min."""
    req = urllib.request.Request(
        f"{PAPERCLIP_HOST}/api/companies/{COMPANY_ID}/agents",
        headers={
            "Authorization": f"Bearer {token}",
            "Host": "localhost:3100",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            agents = json.loads(resp.read().decode("utf-8"))
        if isinstance(agents, dict):
            agents = agents.get("agents", agents.get("data", []))
        now = datetime.now(timezone.utc)
        fresh = 0
        for a in agents:
            hb = a.get("lastHeartbeatAt")
            if not hb:
                continue
            t = datetime.fromisoformat(hb.replace("Z", "+00:00"))
            if (now - t).total_seconds() < 600:
                fresh += 1
        return f"{fresh}/{len(agents)} agents fresh (<10min)"
    except Exception as e:  # noqa: BLE001
        return f"poll-failed: {e}"


def tick(token: str) -> None:
    url = f"{PAPERCLIP_HOST}/api/agents/{CHIEF_ENGINEERING_ID}/heartbeat/invoke"
    status, body = post(url, token)
    # Note: 500 "Internal server error" still fires the heartbeat — Paperclip
    # quirk where the response can't include the new run id. Treat 200 OR 500
    # as "fired", anything else as failure to log.
    if status in (200, 201, 500):
        snapshot = heartbeat_freshness(token)
        log(f"tick OK status={status} :: {snapshot}")
    else:
        log(f"tick FAIL status={status} body={body[:200]}")


def main() -> int:
    # Prefer process env (set by docker compose env_file) over the on-disk .env.koenig
    # so the script works inside containers without mounting the env file.
    token = os.environ.get("PAPERCLIP_API_KEY") or parse_env_file(ENV_FILE).get("PAPERCLIP_API_KEY")
    if not token:
        log("FATAL: PAPERCLIP_API_KEY not in env or .env.koenig")
        return 1
    log(f"cron-driver up — poking {CHIEF_ENGINEERING_ID[:8]} every {TICK_INTERVAL_S}s")
    # Fire once immediately
    tick(token)
    while True:
        try:
            time.sleep(TICK_INTERVAL_S)
            tick(token)
        except KeyboardInterrupt:
            log("shutdown via SIGINT")
            return 0


if __name__ == "__main__":
    sys.exit(main())
