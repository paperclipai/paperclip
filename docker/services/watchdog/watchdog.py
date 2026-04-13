"""
Paperclip Watchdog

Runs every CHECK_INTERVAL_SECONDS and:
  1. Syncs Claude credentials from host when stale (container auth fix)
  2. Syncs GitHub CLI credentials from host when stale (container auth fix)
  3. Checks if host Claude/GH tokens are actually expired; if so writes a
     trigger file to /watchdog-signals/ for the host-side cred-refresher to pick
     up — it spawns Claude Code with Playwright MCP to re-authenticate via browser
  4. Polls for pending Paperclip approvals; writes trigger for each new one so
     Claude Code can investigate the blocker and fix it systematically
  5. Checks Paperclip server health; restarts container if down
  6. Alerts via Telegram + email when something can't be auto-fixed
"""
import asyncio
import json
import logging
import os
import smtplib
import time
from email.mime.text import MIMEText
from pathlib import Path

import docker
import httpx

logging.basicConfig(
    format="%(asctime)s [watchdog] %(levelname)s: %(message)s",
    level=os.getenv("LOG_LEVEL", "INFO"),
)
logger = logging.getLogger("watchdog")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PAPERCLIP_API_URL = os.getenv("PAPERCLIP_API_URL", "http://server:3100")
PAPERCLIP_API_KEY = os.getenv("PAPERCLIP_API_KEY", "")
PAPERCLIP_COMPANY_ID = os.getenv("PAPERCLIP_COMPANY_ID", "")
TELEGRAM_BOT_URL = os.getenv("TELEGRAM_BOT_URL", "http://telegram-bot:8000")
ANGEL_CHAT_ID = int(os.getenv("ANGEL_CHAT_ID", "518395647"))
CHECK_INTERVAL = int(os.getenv("CHECK_INTERVAL_SECONDS", "120"))

GMAIL_USER = os.getenv("GMAIL_USER", "")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD", "")
ALERT_EMAIL_TO = os.getenv("ALERT_EMAIL_TO", "angel.hermon.mail@gmail.com")

# Host credentials (read-only bind mount of ~/.claude)
HOST_CREDS = Path("/host-claude/.credentials.json")
# Container credentials (inside the paperclip-data named volume)
CONTAINER_CREDS = Path("/paperclip-data/.claude/.credentials.json")

# Host GitHub CLI config (read-only bind mount of %APPDATA%/GitHub CLI)
HOST_GH_CREDS = Path("/host-gh-config/hosts.yml")
# Container GitHub CLI config (inside the gh-config named volume)
CONTAINER_GH_CREDS = Path("/gh-config/hosts.yml")

# Write-enabled bind mount — host-side refresher polls this for trigger files
SIGNALS_DIR = Path("/watchdog-signals")

SERVER_CONTAINER = os.getenv("SERVER_CONTAINER_NAME", "paperclip-server-1")
DASHBOARD_URL = os.getenv("DASHBOARD_URL", "http://dashboard:3200")

# Minimum seconds between repeat alerts for the same issue
ALERT_COOLDOWN = int(os.getenv("ALERT_COOLDOWN_SECONDS", "900"))  # 15 min

# Crash-loop detection
CRASH_WINDOW = 60        # seconds: sliding window for crash counting
CRASH_THRESHOLD = 3      # crashes within CRASH_WINDOW triggers rollback

# ---------------------------------------------------------------------------
# Alert state
# ---------------------------------------------------------------------------
_last_alert: dict[str, float] = {}

# Crash-loop detection state (module-level, shared between coroutines)
_server_exit_timestamps: list[float] = []
_rollback_triggered: bool = False

# Approval IDs already handed off to the host refresher this session
_triggered_approval_ids: set[str] = set()

# Separate cooldown for token_expired Telegram alerts (1 hour)
_last_token_expired_alert: float = 0.0


def _should_alert(key: str) -> bool:
    now = time.time()
    if now - _last_alert.get(key, 0) > ALERT_COOLDOWN:
        _last_alert[key] = now
        return True
    return False


def _clear_alert(key: str) -> None:
    _last_alert.pop(key, None)


# ---------------------------------------------------------------------------
# Notification helpers
# ---------------------------------------------------------------------------
async def send_telegram(msg: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{TELEGRAM_BOT_URL}/send",
                json={"chat_id": ANGEL_CHAT_ID, "text": msg},
            )
            if resp.status_code != 200:
                logger.error("Telegram send failed: %s", resp.text)
    except Exception as e:
        logger.error("Telegram send error: %s", e)


def send_email(subject: str, body: str) -> None:
    if not GMAIL_USER or not GMAIL_APP_PASSWORD:
        logger.debug("Email not configured, skipping email alert")
        return
    try:
        msg = MIMEText(body)
        msg["Subject"] = subject
        msg["From"] = GMAIL_USER
        msg["To"] = ALERT_EMAIL_TO
        with smtplib.SMTP_SSL("smtp.gmail.com", 465) as srv:
            srv.login(GMAIL_USER, GMAIL_APP_PASSWORD)
            srv.sendmail(GMAIL_USER, [ALERT_EMAIL_TO], msg.as_string())
        logger.info("Email alert sent: %s", subject)
    except Exception as e:
        logger.error("Email send error: %s", e)


async def alert(key: str, subject: str, body: str) -> None:
    if not _should_alert(key):
        return
    logger.warning("ALERT [%s]: %s", key, subject)
    _log_event("alert_sent", {"key": key, "subject": subject})
    await send_telegram(f"🚨 *Paperclip Alert*\n{subject}\n\n{body}")
    send_email(f"[Paperclip] {subject}", body)


async def notify(msg: str) -> None:
    """Non-alerting informational notification."""
    logger.info("NOTIFY: %s", msg)
    _log_event("telegram_sent", {"message": msg[:200]})
    await send_telegram(msg)


# ---------------------------------------------------------------------------
# Event logging
# ---------------------------------------------------------------------------
def _log_event(event_type: str, data: dict) -> None:
    """Append a structured event to the shared event log."""
    try:
        SIGNALS_DIR.mkdir(parents=True, exist_ok=True)
        entry = json.dumps({"ts": time.time(), "source": "watchdog", "type": event_type, "data": data})
        with open(SIGNALS_DIR / "events.jsonl", "a", encoding="utf-8") as f:
            f.write(entry + "\n")
    except Exception as e:
        logger.debug("Event log write failed: %s", e)


# ---------------------------------------------------------------------------
# Signals (triggers for host-side refresher)
# ---------------------------------------------------------------------------
def _write_trigger(name: str, data: dict) -> None:
    """Write a trigger file to the host-side signals directory."""
    SIGNALS_DIR.mkdir(parents=True, exist_ok=True)
    trigger = SIGNALS_DIR / f"{name}.json"
    if not trigger.exists():  # Don't overwrite while refresher is still processing
        trigger.write_text(json.dumps(data))
        logger.info("Trigger written: %s", name)


# ---------------------------------------------------------------------------
# Credentials sync
# ---------------------------------------------------------------------------
def _read_access_token(path: Path) -> str | None:
    try:
        data = json.loads(path.read_text())
        return data.get("claudeAiOauth", {}).get("accessToken")
    except Exception:
        return None


def _read_expires_at(path: Path) -> float:
    """Return claudeAiOauth.expiresAt in ms, or 0 on error."""
    try:
        data = json.loads(path.read_text())
        val = data.get("claudeAiOauth", {}).get("expiresAt")
        return float(val) if val is not None else 0.0
    except Exception:
        return 0.0


def sync_credentials() -> bool:
    """
    Keep host and container Claude credentials in sync, always using the
    newer set (higher expiresAt).  When Claude Code inside the container
    auto-refreshes its OAuth token it writes a newer expiresAt to the
    container volume; we must NOT overwrite that with the stale host copy.

    Returns True if a sync was performed.
    """
    if not HOST_CREDS.exists():
        logger.warning("Host credentials not found at %s", HOST_CREDS)
        return False

    host_token = _read_access_token(HOST_CREDS)
    container_token = _read_access_token(CONTAINER_CREDS)

    if host_token and host_token == container_token:
        _log_event("cred_up_to_date", {"target": "claude"})
        return False  # Already in sync

    host_expires = _read_expires_at(HOST_CREDS)
    container_expires = _read_expires_at(CONTAINER_CREDS)

    if container_expires > host_expires:
        # Container has a newer token (auto-refreshed by Claude Code).
        # Sync container → host so the bind-mount stays current too.
        HOST_CREDS.write_text(CONTAINER_CREDS.read_text())
        logger.info("Credentials synced: container → host (container token is newer)")
        _log_event("cred_synced", {"target": "claude", "direction": "container_to_host"})
    else:
        # Host has a newer or equal token (user ran `claude login`).
        # Sync host → container as before.
        CONTAINER_CREDS.parent.mkdir(parents=True, exist_ok=True)
        CONTAINER_CREDS.write_text(HOST_CREDS.read_text())
        logger.info("Credentials synced: host → container")
        _log_event("cred_synced", {"target": "claude", "direction": "host_to_container"})

    return True


def _is_claude_token_expired(path: Path) -> bool:
    """Return True if the claudeAiOauth.expiresAt timestamp is in the past."""
    try:
        data = json.loads(path.read_text())
        expires_at = data.get("claudeAiOauth", {}).get("expiresAt")
        if expires_at is None:
            return False
        return time.time() * 1000 >= expires_at  # expiresAt is in ms
    except Exception:
        return False


async def _is_gh_token_valid(token: str) -> bool:
    """Return True if the token is accepted by the GitHub API."""
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(
                "https://api.github.com/user",
                headers={
                    "Authorization": f"token {token}",
                    "Accept": "application/vnd.github.v3+json",
                },
            )
            return resp.status_code == 200
    except Exception:
        return False


def _read_gh_token(path: Path) -> str | None:
    """Extract oauth_token from a gh hosts.yml file without a YAML dependency."""
    try:
        for line in path.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith("oauth_token:"):
                return stripped.split(":", 1)[1].strip()
    except Exception:
        pass
    return None


def sync_gh_credentials() -> bool:
    """
    Copy host GitHub CLI hosts.yml to the gh-config volume when stale.
    Returns True if a sync was performed (actual copy happened).
    Returns False if already up-to-date or host file missing.
    """
    if not HOST_GH_CREDS.exists():
        logger.warning("Host GH credentials not found at %s", HOST_GH_CREDS)
        return False

    host_token = _read_gh_token(HOST_GH_CREDS)
    if not host_token:
        logger.warning("Could not extract oauth_token from host GH config")
        return False

    container_token = _read_gh_token(CONTAINER_GH_CREDS)

    if host_token == container_token:
        logger.debug("GH credentials up to date (tokens match)")
        _log_event("cred_up_to_date", {"target": "github"})
        return False  # Already in sync — do NOT send Telegram

    # Tokens differ (or container file missing) — copy host → container
    reason = "container file missing" if not CONTAINER_GH_CREDS.exists() else "token mismatch"
    logger.info("GH credentials stale (%s), syncing host → container", reason)
    CONTAINER_GH_CREDS.parent.mkdir(parents=True, exist_ok=True)
    CONTAINER_GH_CREDS.write_text(HOST_GH_CREDS.read_text())
    logger.info("GH credentials synced: host → container")
    _log_event("cred_synced", {"target": "github"})
    return True


# ---------------------------------------------------------------------------
# Pending approvals
# ---------------------------------------------------------------------------
async def fetch_pending_approvals() -> list[dict]:
    """Return all pending approvals for the company, or [] if unconfigured/error."""
    if not PAPERCLIP_API_KEY or not PAPERCLIP_COMPANY_ID:
        return []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{PAPERCLIP_API_URL}/api/companies/{PAPERCLIP_COMPANY_ID}/approvals",
                params={"status": "pending"},
                headers={"Authorization": f"Bearer {PAPERCLIP_API_KEY}"},
            )
            if resp.status_code == 200:
                return resp.json()
            logger.warning("Approvals fetch returned %d: %s", resp.status_code, resp.text[:200])
    except Exception as e:
        logger.error("Approvals fetch error: %s", e)
    return []


async def check_approvals() -> None:
    """
    Detect new pending approvals and write a trigger for each one so the
    host-side refresher can spawn Claude Code to investigate and resolve.
    """
    approvals = await fetch_pending_approvals()
    if not approvals:
        return

    new = [a for a in approvals if a["id"] not in _triggered_approval_ids]
    if not new:
        return

    logger.info("Found %d new pending approval(s)", len(new))

    for approval in new:
        _triggered_approval_ids.add(approval["id"])
        _log_event("approval_found", {"approval_id": approval["id"], "type": approval.get("type"), "agent_id": approval.get("requestedByAgentId")})
        trigger_name = f"approval-{approval['id'][:8]}"
        _write_trigger(trigger_name, {
            "approval_id": approval["id"],
            "type": approval.get("type"),
            "requested_by_agent_id": approval.get("requestedByAgentId"),
            "payload_summary": str(approval.get("payload", {}))[:500],
            "created_at": approval.get("createdAt"),
            "api_url": "http://localhost:3100",
            "company_id": PAPERCLIP_COMPANY_ID,
            "api_key": PAPERCLIP_API_KEY,
            "timestamp": time.time(),
        })

        short_id = approval["id"][:8]
        approval_type = approval.get("type", "unknown")
        agent_id = approval.get("requestedByAgentId", "unknown")
        await notify(
            f"🔔 *Pending approval detected*\n"
            f"ID: `{short_id}...`\n"
            f"Type: {approval_type}\n"
            f"Agent: {agent_id}\n"
            f"View: http://localhost:3100/ANGA/approvals/{approval['id']}\n\n"
            f"Claude Code is investigating…"
        )


# ---------------------------------------------------------------------------
# Crash-loop detection via Docker events
# ---------------------------------------------------------------------------
async def watch_container_events() -> None:
    """
    Stream Docker events for paperclip-server-1 die events.
    If CRASH_THRESHOLD exits with non-zero code occur within CRASH_WINDOW seconds,
    trigger automatic rollback via the dashboard /api/rollback endpoint.
    """
    global _rollback_triggered, _server_exit_timestamps

    logger.info(
        "Crash-loop detector started — threshold=%d crashes in %ds",
        CRASH_THRESHOLD, CRASH_WINDOW,
    )

    while True:
        try:
            dc = docker.DockerClient(base_url="unix:///var/run/docker.sock")
            # Stream events filtered to the server container
            for event in dc.events(decode=True, filters={"container": SERVER_CONTAINER, "event": "die"}):
                if _rollback_triggered:
                    logger.info("Rollback already triggered — ignoring die event")
                    continue

                # Extract exit code from event attributes
                exit_code_str = event.get("Actor", {}).get("Attributes", {}).get("exitCode", "0")
                try:
                    exit_code = int(exit_code_str)
                except ValueError:
                    exit_code = 1

                if exit_code == 0:
                    # Clean shutdown — not a crash
                    logger.debug("Server container exited cleanly (exit 0) — not a crash")
                    continue

                now = time.time()
                _server_exit_timestamps.append(now)

                # Trim timestamps outside the window
                _server_exit_timestamps = [
                    ts for ts in _server_exit_timestamps if now - ts <= CRASH_WINDOW
                ]

                count = len(_server_exit_timestamps)
                logger.warning(
                    "Server crash detected (exit %d) — %d crash(es) in last %ds",
                    exit_code, count, CRASH_WINDOW,
                )
                _log_event("server_crash", {"exit_code": exit_code, "crash_count": count, "window": CRASH_WINDOW})

                if count >= CRASH_THRESHOLD:
                    _rollback_triggered = True
                    logger.error(
                        "CRASH LOOP DETECTED (%d crashes in %ds) — triggering rollback",
                        count, CRASH_WINDOW,
                    )
                    _log_event("crash_loop_detected", {"count": count, "window": CRASH_WINDOW})

                    await send_telegram(
                        f"🔄 *Crash loop detected on paperclip-server*\n"
                        f"{count} crashes in {CRASH_WINDOW}s\n"
                        f"Triggering automatic rollback via dashboard…"
                    )

                    try:
                        async with httpx.AsyncClient(timeout=15) as client:
                            resp = await client.post(f"{DASHBOARD_URL}/api/rollback")
                            if resp.status_code in (200, 202):
                                logger.info("Rollback triggered via dashboard: %s", resp.text[:200])
                                _log_event("rollback_triggered", {"via": "dashboard", "status": resp.status_code})
                            else:
                                logger.error("Dashboard /api/rollback returned %d: %s", resp.status_code, resp.text[:200])
                    except Exception as e:
                        logger.error("Failed to trigger rollback via dashboard: %s", e)
                        await send_telegram(
                            f"⚠️ Could not reach dashboard to trigger rollback: {e}\n"
                            "Manual intervention required."
                        )

        except Exception as e:
            logger.error("watch_container_events error (will retry in 10s): %s", e)
            await asyncio.sleep(10)


# ---------------------------------------------------------------------------
# Server health + recovery
# ---------------------------------------------------------------------------
async def check_health() -> bool:
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(f"{PAPERCLIP_API_URL}/api/health")
            return resp.status_code == 200 and resp.json().get("status") == "ok"
    except Exception:
        return False


def restart_server() -> bool:
    try:
        dc = docker.DockerClient(base_url="unix:///var/run/docker.sock")
        container = dc.containers.get(SERVER_CONTAINER)
        container.restart(timeout=30)
        logger.info("Server container restarted")
        return True
    except Exception as e:
        logger.error("Docker restart failed: %s", e)
        return False


# ---------------------------------------------------------------------------
# Main check loop
# ---------------------------------------------------------------------------
async def run_checks() -> None:
    # 1. Credentials sync
    try:
        synced = sync_credentials()
        if synced:
            _clear_alert("creds_stale")
            await notify("🔑 Claude credentials synced automatically (were stale). Agents should recover.")
    except Exception as e:
        logger.error("Credentials sync error: %s", e)
        await alert(
            "creds_stale",
            "Claude credentials sync failed",
            f"Error: {e}\n\nAgents will fail with 401 until this is resolved.\n"
            "Check that ~/.claude/.credentials.json exists on the host.",
        )

    # 2. GitHub credentials sync
    try:
        gh_synced = sync_gh_credentials()
        if gh_synced:
            _clear_alert("gh_creds_stale")
            await notify("🔑 GitHub credentials synced automatically (were stale). Agents should recover.")
        elif not HOST_GH_CREDS.exists():
            await alert(
                "gh_creds_missing",
                "GitHub credentials not found on host",
                f"Expected: {HOST_GH_CREDS}\n\n"
                "Run `gh auth login` on the host, then re-run the stack.\n"
                "Agents using `gh` or GitHub API will fail until this is resolved.",
            )
    except Exception as e:
        logger.error("GH credentials sync error: %s", e)
        await alert(
            "gh_creds_stale",
            "GitHub credentials sync failed",
            f"Error: {e}\n\nAgents using `gh` will fail until this is resolved.\n"
            "Check that gh is authenticated on the host.",
        )

    # 3. Expiry checks — trigger host-side refresher if tokens are actually expired
    global _last_token_expired_alert
    if HOST_CREDS.exists() and _is_claude_token_expired(HOST_CREDS):
        _write_trigger("claude-auth", {
            "reason": "claudeAiOauth.expiresAt is in the past",
            "timestamp": time.time(),
        })
        _log_event("token_expired", {"target": "claude", "action": "trigger_written"})
        # Only send Telegram once per hour for token_expired (not every 2-minute cycle)
        now = time.time()
        if now - _last_token_expired_alert > 3600:
            _last_token_expired_alert = now
            await alert(
                "claude_token_expired",
                "Claude OAuth token expired — auto-refresh triggered",
                "The host Claude token has expired.\n"
                "The credential refresher will open a browser to re-authenticate automatically.\n"
                "Agents will recover once the new token is synced.",
            )
    else:
        _clear_alert("claude_token_expired")

    if HOST_GH_CREDS.exists():
        gh_token = _read_gh_token(HOST_GH_CREDS)
        if gh_token and not await _is_gh_token_valid(gh_token):
            _write_trigger("gh-auth", {
                "reason": "GitHub API returned non-200 for token",
                "timestamp": time.time(),
            })
            _log_event("token_expired", {"target": "github", "action": "trigger_written"})
            await alert(
                "gh_token_expired",
                "GitHub token expired — auto-refresh triggered",
                "The host GitHub token is invalid or expired.\n"
                "The credential refresher will open a browser to re-authenticate automatically.",
            )
        else:
            _clear_alert("gh_token_expired")

    # 4. Pending approvals
    try:
        await check_approvals()
    except Exception as e:
        logger.error("Approval check error: %s", e)

    # 5. Server health
    healthy = await check_health()
    _log_event("health_check", {"status": "ok" if healthy else "fail"})
    if healthy:
        _clear_alert("server_down")
        return

    if _rollback_triggered:
        logger.info("Rollback in progress — skipping restart attempt")
        return

    logger.warning("Server unhealthy, attempting restart…")
    restarted = restart_server()
    _log_event("server_restarted", {"success": restarted})

    if restarted:
        await asyncio.sleep(20)
        healthy = await check_health()

    if healthy:
        _clear_alert("server_down")
        await notify("✅ Paperclip server recovered after auto-restart.")
        return

    restart_status = "restarted but still unhealthy" if restarted else "restart failed"
    await alert(
        "server_down",
        "Paperclip server is DOWN",
        f"Health check: {PAPERCLIP_API_URL}/api/health\n"
        f"Auto-recovery: {restart_status}\n\n"
        "Manual intervention required.",
    )


async def _check_loop() -> None:
    """Periodic check loop (credentials, approvals, health)."""
    logger.info(
        "Watchdog started — interval=%ds  server=%s  approvals=%s",
        CHECK_INTERVAL,
        PAPERCLIP_API_URL,
        "enabled" if PAPERCLIP_API_KEY else "disabled (no API key)",
    )

    # Wait for the rest of the stack to come up
    await asyncio.sleep(30)

    while True:
        try:
            await run_checks()
        except Exception as e:
            logger.error("Unexpected error in run_checks: %s", e)
        await asyncio.sleep(CHECK_INTERVAL)


async def main() -> None:
    await asyncio.gather(
        watch_container_events(),
        _check_loop(),
    )


if __name__ == "__main__":
    asyncio.run(main())
