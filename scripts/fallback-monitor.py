#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from mc_emergency_stop_guard import guard_decision, include_audit_signature, guard_summary

LIMIT_RE = re.compile(
    # Codex/Spark has emitted both "You've hit your usage limit" and the
    # terser "usage limit reached" family.  Keep the first capture compatible
    # with limit_kind_from_match(), while infer_limit_kind() handles the terse
    # alternatives below.
    r"(?:You[‘’']ve hit your (session|weekly|daily|5-?hour|usage) limit|"
    r"You[‘’']ve reached your (session|weekly|daily|5-?hour|usage) limit|"
    r"(?:session|weekly|daily|5-?hour|usage) limit(?: has been)? reached)",
    re.IGNORECASE,
)
GEMINI_QUOTA_RE = re.compile(
    r"resource[ _-]?exhausted|resource has been exhausted|"
    r"quota (?:exceeded|exhausted|reached)|individual quota reached|"
    r"exceeded your[^.\n]{0,40}quota|ineligible[ _-]?tier|"
    r"upgrade your subscription to increase your limits",
    re.IGNORECASE,
)
GROK_QUOTA_RE = re.compile(
    # The literal `code` xAI returns on account-level exhaustion. This is the same
    # marker ~/scripts/grok-quota-watcher.sh keys on, and it is matched literally on
    # purpose: the human-readable half of that 403 reads
    #   "You have run out of credits or need a Grok subscription. Add credits at
    #    https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok."
    # and the sentence periods in "Grok subscription." / "grok.com" mean no [^.\n]
    # span can bridge from a grok token to a limit/quota token. The three legacy
    # alternations below therefore all returned False against the real production
    # string (TSKB0181 s1.5; 686 occurrences in ~/.hermes/logs/gateway.error.log).
    r"personal-team-blocked[:\s_-]*spending-limit|"
    # Human-readable half of the same 403, kept grok-scoped so an "out of credits"
    # from some other provider cannot claim a grok provider hint.
    r"run out of credits[^.\n]{0,80}(?:grok|xai|x\.ai)|"
    r"(?:grok|xai|x\.ai)[^.\n]{0,80}run out of credits|"
    r"need a (?:grok|xai) subscription|"
    # Legacy fuzzy alternations. Best-effort only — the literal marker above is the
    # load-bearing detection (it is what xAI actually emits, 1347/1347 real log lines).
    #
    # `rate` was REMOVED from the period-token groups and a not-preceded-by-"rate"
    # guard added to the third alternation. A "rate limit" is a TRANSIENT 429 throttle,
    # not account exhaustion, and matching it let a momentary throttle trigger a full
    # 6h sister takeover (e.g. "xai-oauth: rate limit exceeded"). TSKB0014 s10.5.
    r"(?:grok|xai|x\.ai)[^.\n]{0,120}(weekly|daily|session|usage|quota)[^.\n]{0,120}"
    r"(?:limit|quota|cap)|"
    r"(?:weekly|daily|session|usage)\s+(?:limit|quota|cap)[^.\n]{0,120}"
    r"(?:grok|xai|x\.ai)|"
    r"(?:grok|xai|x\.ai)[^.\n]{0,120}"
    r"(?<!rate)(?<!rate )(?<!rate-)(?<!rate_)"
    r"(?:limit|quota|cap)[^.\n]{0,40}"
    r"(?:reached|exceeded|exhausted|hit)",
    re.IGNORECASE,
)
# Adapter families whose runs are backed by xAI/Grok as the PRIMARY provider. These
# lanes carry an in-process Hermes fallback chain (grok-4.3 -> gpt-5.4 openai-codex,
# ~/.hermes/config.yaml fallback_providers), so their surfaced error text may belong
# to a DOWNSTREAM provider rather than to the lane's own primary.
GROK_BACKED_ADAPTERS = {"grok_local", "hermes_local"}
# provider_hint used when limit wording on a grok-backed lane is Codex/Claude-worded,
# i.e. the Hermes fallback chain exhausted and surfaced the downstream provider's
# error. Any reset window stated in that text belongs to the downstream provider and
# must NOT be carried onto the Grok lane (TSKB0181 s1.5, disagreement mode 1).
HERMES_FALLBACK_CHAIN_HINT = "hermes_fallback_chain"
ISO_RESET_RE = re.compile(
    r"(?:Your limit will reset at|reset at)\s+([0-9TZ:._+-]+)",
    re.IGNORECASE,
)
CLOCK_RESET_RE = re.compile(
    r"(?:try again at|reset(?:s)?\s+at|resets?)\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*(?:\(([^)]+)\))?",
    re.IGNORECASE,
)
RELATIVE_RESET_RE = re.compile(
    r"resets?\s+in\s+(?=[0-9dhms ]*[0-9])(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?",
    re.IGNORECASE,
)

OPEN_STATUSES = "todo,in_progress,in_review,blocked"
ACTIVE_RUN_STATUSES = {"queued", "running"}
NON_BLOCKING_RUN_SOURCES = {
    "issue.assignment_recovery",
    "issue_recovery_action",
}
PAUSED_BY_DESIGN_ROLES = {"ceo", "chief executive officer"}
PAUSED_BY_DESIGN_PAUSE_REASONS = {"manual"}
GROK_BACKED_ADAPTER_TYPES = {"grok_local", "hermes_local"}
GROK_RENDER_LANE_RE = re.compile(
    r"Designer-Media|Media-Drafter|BrandDesigner|Imagine|-Media",
    re.IGNORECASE,
)
GROK_VIDEO_RENDER_RE = re.compile(
    r"video|clip|movie|short|shorts|reel|animation|animate|mp4",
    re.IGNORECASE,
)
GROK_QUOTA_STATE_PATH = Path.home() / "scripts/state/grok-quota-state.json"
SESSION_FALLBACK_HOURS = 6
WEEKLY_FALLBACK_DAYS = 7
USAGE_FALLBACK_HOURS = 6
GEMINI_USAGE_FALLBACK_HOURS = 108
# Spark can exhaust without an adapter error: it reports successful heartbeats
# with q=0.000 / zero output.  The TSBC burn driver has used a 12-run threshold
# since 2026-07-24; preserve that deliberately conservative proven value here.
SPARK_MODEL_ID = "gpt-5.3-codex-spark"
SPARK_EMPTY_OUTPUT_MAX_TOKENS = 1
SPARK_EMPTY_OUTPUT_STREAK = 12

# A transient blip on an idempotent read must NOT crash this handler with a hard
# exit: a non-zero exit cascades the execution issue back onto the primary's
# Claude adapter (claude_local), which is the exact session/weekly-limit failure
# mode this monitor exists to survive. Mirror the dispatcher's hardening
# (THIAAAAAA-1564) on the handler's own reads. See THIAAAAAA-1834.
TRANSIENT_HTTP = {425, 429, 500, 502, 503, 504}
GET_RETRIES = 4
RETRY_BACKOFF_SECONDS = 0.75
CONNECTION_REFUSED_BACKOFFS = (2.0, 5.0, 10.0)
CONNECTION_REFUSED_ERRNOS = {61, 111}
LOCAL_API_FALLBACK = "http://127.0.0.1:3100"
TRANSPORT_ERRORS = (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError)


def _emergency_guard(
    base: str,
    key: str,
    company_id: str,
    category: str,
    allowlist: set[str] | None = None,
) -> dict[str, Any]:
    return guard_decision(
        category=category,
        base=base,
        key=key,
        company_id=company_id,
        allowlist=allowlist or set(),
        strict=False,
    )


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description=(
            "Detect Claude/Codex usage-limit failures (failed heartbeat runs) and "
            "paused registry primaries, then reassign their open issues to fallback sisters."
        )
    )
    ap.add_argument(
        "--registry",
        default=str(Path(__file__).resolve().parents[1] / "fallback-registry.json"),
    )
    ap.add_argument(
        "--state-dir",
        default=str(Path.home() / ".paperclip/instances/default/companies"),
    )
    ap.add_argument("--primary-id", help="Only check this primary agent ID.")
    ap.add_argument(
        "--force",
        action="store_true",
        help="Force fallback reassignment for the selected primary id (skip detection).",
    )
    # The monitor now runs every 20 minutes; keep the scan window wider than
    # the schedule so a slightly late tick still sees the last failed run.
    ap.add_argument("--since-minutes", type=int, default=25)
    ap.add_argument("--max-runs", type=int, default=100)
    ap.add_argument(
        "--spark-empty-streak",
        type=int,
        default=SPARK_EMPTY_OUTPUT_STREAK,
        help="Consecutive successful near-zero-output Spark runs that signal quota exhaustion.",
    )
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--source-issue-id",
        default=None,
        help="Compatibility alias for execution_issue positional arg.",
    )
    ap.add_argument(
        "execution_issue",
        nargs="?",
        default=None,
        help="Optional execution issue id; when present the script patches it to done with a heartbeat summary.",
    )
    return ap.parse_args()


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return None


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def api_roots() -> list[str]:
    primary = os.environ["PAPERCLIP_API_URL"].rstrip("/")
    roots = [primary]
    parsed = urlparse(primary)
    if (
        parsed.scheme == "http"
        and parsed.hostname not in {"127.0.0.1", "localhost"}
        and parsed.port == 3100
    ):
        roots.append(LOCAL_API_FALLBACK)
    return roots


def is_connection_refused_error(exc: BaseException) -> bool:
    candidates = [
        exc,
        getattr(exc, "reason", None),
        getattr(exc, "__cause__", None),
        getattr(getattr(exc, "reason", None), "__cause__", None),
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        errno = getattr(candidate, "errno", None)
        if errno in CONNECTION_REFUSED_ERRNOS or isinstance(candidate, ConnectionRefusedError):
            return True
        if isinstance(candidate, OSError) and errno in CONNECTION_REFUSED_ERRNOS:
            return True
        if "connection refused" in str(candidate).lower():
            return True
    return False


def api(base: str, key: str, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    last_exc: Exception | None = None
    roots = api_roots()
    for connection_refused_attempt, backoff in enumerate((0.0, *CONNECTION_REFUSED_BACKOFFS)):
        if connection_refused_attempt:
            time.sleep(backoff)
        try:
            for root_index, root in enumerate(roots):
                # Retry only idempotent reads; mutating calls run once so we never
                # double-apply them across transient runtime failures.
                attempts = GET_RETRIES if method.upper() == "GET" else 1
                for attempt in range(attempts):
                    req = urllib.request.Request(f"{root}{path}", method=method, data=data)
                    req.add_header("Authorization", f"Bearer {key}")
                    run_id = os.environ.get("PAPERCLIP_RUN_ID")
                    if run_id:
                        req.add_header("X-Paperclip-Run-Id", run_id)
                    if body is not None:
                        req.add_header("Content-Type", "application/json")
                    try:
                        with urllib.request.urlopen(req, timeout=20) as resp:
                            raw = resp.read().decode("utf-8")
                            return json.loads(raw) if raw else {}
                    except urllib.error.HTTPError as exc:
                        if exc.code in TRANSIENT_HTTP and attempt < attempts - 1:
                            last_exc = exc
                            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
                            continue
                        raise
                    except TRANSPORT_ERRORS as exc:
                        last_exc = exc
                        if is_connection_refused_error(exc):
                            raise
                        # Retry connection-level blips on the current root first.
                        if attempt < attempts - 1:
                            time.sleep(RETRY_BACKOFF_SECONDS * (attempt + 1))
                            continue
                        # Then fall back to localhost when the injected LAN address is stale.
                        if root_index < len(roots) - 1:
                            break
                        raise
        except TRANSPORT_ERRORS as exc:
            last_exc = exc
            if not is_connection_refused_error(exc):
                raise
            if connection_refused_attempt == len(CONNECTION_REFUSED_BACKOFFS):
                raise
    if last_exc:
        raise last_exc
    raise RuntimeError(f"api: exhausted retries on {method} {path}")


def api_optional(base: str, key: str, method: str, path: str) -> Any | None:
    try:
        return api(base, key, method, path)
    except urllib.error.HTTPError as exc:
        if exc.code in (403, 404):
            return None
        raise


def read_json_file(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return payload if isinstance(payload, dict) else None


def load_registry(path: str) -> dict[str, list[str]]:
    with open(path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    if not isinstance(raw, dict):
        raise SystemExit("registry must be object: {primaryId: sisterId | [sisterId, ...]}")

    registry: dict[str, list[str]] = {}
    for primary, sisters in raw.items():
        primary_id = str(primary)
        if isinstance(sisters, str):
            normalized = [sisters]
        elif isinstance(sisters, list):
            normalized = [str(s) for s in sisters if str(s).strip()]
        elif isinstance(sisters, dict) and isinstance(sisters.get("sisters"), list):
            normalized = [str(s) for s in sisters["sisters"] if str(s).strip()]
        else:
            raise SystemExit(
                "registry values must be sister id strings, sister id arrays, "
                "or objects with a sisters array"
            )
        if not normalized:
            raise SystemExit(f"registry entry for {primary_id} has no sister ids")
        registry[primary_id] = normalized
    return registry


def detect_limit_text(
    text: str,
    adapter: str | None = None,
) -> tuple[re.Match[str], str] | tuple[None, None]:
    """Classify limit wording, consulting the lane's adapter family FIRST.

    Order matters on grok-backed lanes. When the Hermes in-process fallback chain
    exhausts, the surfaced error is the LAST provider's — Codex-worded, and so
    matched by LIMIT_RE. Checking LIMIT_RE first (the pre-2026-07-25 behavior)
    classified that as provider_hint="generic" and let a Codex reset window be
    carried onto a Grok lane. So on a grok-backed lane: try GROK_QUOTA_RE first,
    and if only LIMIT_RE matches, hint HERMES_FALLBACK_CHAIN_HINT so callers do
    not trust the reset window stated in that text.
    """
    if not text:
        return None, None
    grok_backed = str(adapter or "").strip().lower() in GROK_BACKED_ADAPTERS
    if grok_backed:
        match = GROK_QUOTA_RE.search(text)
        if match:
            return match, "grok"
    match = LIMIT_RE.search(text)
    if match:
        return match, HERMES_FALLBACK_CHAIN_HINT if grok_backed else "generic"
    if not grok_backed:
        match = GROK_QUOTA_RE.search(text)
        if match:
            return match, "grok"
    match = GEMINI_QUOTA_RE.search(text)
    if match:
        return match, "gemini"
    return None, None


def has_reset_hint(text: str) -> bool:
    if not text:
        return False
    return bool(
        ISO_RESET_RE.search(text)
        or CLOCK_RESET_RE.search(text)
        or RELATIVE_RESET_RE.search(text)
    )


def infer_limit_kind(text: str, provider_hint: str | None = None) -> str:
    if provider_hint == HERMES_FALLBACK_CHAIN_HINT:
        # "weekly"/"5-hour" in this text describes the DOWNSTREAM provider's cycle,
        # not this lane's. Fall back to the neutral usage window.
        return "usage"
    lowered = (text or "").lower()
    if "weekly" in lowered:
        return "weekly"
    if "5-hour" in lowered or "5 hour" in lowered:
        return "5-hour"
    if "daily" in lowered:
        return "daily"
    if "session" in lowered:
        return "session"
    if "usage" in lowered or "quota" in lowered or "rate limit" in lowered or "rate-limit" in lowered:
        return "usage"
    if provider_hint in {"gemini", "grok"}:
        return "usage"
    return "usage"


def limit_kind_from_match(
    match: re.Match[str],
    text: str = "",
    provider_hint: str | None = None,
) -> str:
    if provider_hint == HERMES_FALLBACK_CHAIN_HINT:
        return infer_limit_kind(text, provider_hint)
    if match.lastindex and match.lastindex >= 1:
        candidate = match.group(1)
        if candidate:
            normalized = str(candidate).lower()
            if normalized in {"weekly", "daily", "session", "usage", "5-hour"}:
                return normalized
    return infer_limit_kind(text, provider_hint)


def parse_reset_at(
    text: str,
    kind: str | None = None,
    anchor: datetime | None = None,
    provider_hint: str | None = None,
) -> datetime:
    if provider_hint == HERMES_FALLBACK_CHAIN_HINT:
        # Every reset window stated in this text is the downstream fallback
        # provider's (Codex), not this Grok lane's. Ignore the text entirely and
        # use the neutral usage window rather than stranding the lane for a week.
        return (anchor or now_utc()).astimezone(timezone.utc) + timedelta(
            hours=USAGE_FALLBACK_HOURS
        )

    iso_match = ISO_RESET_RE.search(text or "")
    if iso_match:
        parsed = parse_iso(iso_match.group(1))
        if parsed:
            return parsed.astimezone(timezone.utc)

    base = (anchor or now_utc()).astimezone(timezone.utc)
    relative = RELATIVE_RESET_RE.search(text or "")
    if relative:
        days = int(relative.group(1) or 0)
        hours = int(relative.group(2) or 0)
        minutes = int(relative.group(3) or 0)
        seconds = int(relative.group(4) or 0)
        if any((days, hours, minutes, seconds)):
            return base + timedelta(days=days, hours=hours, minutes=minutes, seconds=seconds)

    clock = CLOCK_RESET_RE.search(text or "")
    if clock:
        hour = int(clock.group(1))
        minute = int(clock.group(2) or 0)
        meridiem = (clock.group(3) or "").lower()
        tz_name = clock.group(4)
        if meridiem == "pm" and hour < 12:
            hour += 12
        elif meridiem == "am" and hour == 12:
            hour = 0
        tz: Any = timezone.utc
        if tz_name:
            try:
                from zoneinfo import ZoneInfo  # type: ignore

                tz = ZoneInfo(tz_name)
            except Exception:
                tz = timezone.utc
        try:
            base_local = base.astimezone(tz)
            target = base_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if (kind or "").lower() == "weekly":
                if target <= base_local:
                    target = target + timedelta(days=WEEKLY_FALLBACK_DAYS)
                else:
                    target = target + timedelta(days=WEEKLY_FALLBACK_DAYS - 1)
            else:
                if target <= base_local:
                    target = target + timedelta(days=1)
            return target.astimezone(timezone.utc)
        except ValueError:
            pass

    kind_l = (kind or "").lower()
    if kind_l == "weekly":
        return base + timedelta(days=WEEKLY_FALLBACK_DAYS)
    if provider_hint == "gemini":
        return base + timedelta(hours=GEMINI_USAGE_FALLBACK_HOURS)
    if kind_l == "usage":
        return base + timedelta(hours=USAGE_FALLBACK_HOURS)
    return base + timedelta(hours=SESSION_FALLBACK_HOURS)


def state_paths(root: str, company_id: str, primary_id: str) -> tuple[Path, Path]:
    base = Path(root) / company_id / "fallback-state"
    base.mkdir(parents=True, exist_ok=True)
    return base, base / f"{primary_id}.json"


def list_recent_failed_runs(
    base: str, key: str, company_id: str, cutoff: datetime, max_runs: int
) -> list[dict[str, Any]]:
    q = urllib.parse.urlencode({"status": "failed", "limit": str(max_runs)})
    payload = api(base, key, "GET", f"/api/companies/{company_id}/heartbeat-runs?{q}")
    runs = payload if isinstance(payload, list) else payload.get("runs", []) if isinstance(payload, dict) else []
    fresh: list[dict[str, Any]] = []
    for r in runs:
        if (r.get("status") or "").lower() != "failed":
            continue
        ts = parse_iso(r.get("finishedAt") or r.get("startedAt") or r.get("createdAt"))
        if ts is None or ts >= cutoff:
            fresh.append(r)
    return fresh


def list_recent_successful_runs(
    base: str, key: str, company_id: str, cutoff: datetime, max_runs: int
) -> list[dict[str, Any]]:
    """Return recent successful runs for the Spark soft-degrade detector."""
    q = urllib.parse.urlencode({"status": "succeeded", "limit": str(max_runs)})
    payload = api(base, key, "GET", f"/api/companies/{company_id}/heartbeat-runs?{q}")
    runs = payload if isinstance(payload, list) else payload.get("runs", []) if isinstance(payload, dict) else []
    fresh: list[dict[str, Any]] = []
    for run in runs:
        if (run.get("status") or "").lower() != "succeeded":
            continue
        ts = parse_iso(run.get("finishedAt") or run.get("startedAt") or run.get("createdAt"))
        if ts is None or ts >= cutoff:
            fresh.append(run)
    return fresh


def agent_serves_spark(agent: dict[str, Any] | None) -> bool:
    """Whether this registered primary is served by the Spark pool.

    The model is nested differently across API generations, so matching the
    JSON representation is intentionally schema-tolerant while still exact on
    the model id.  Do not infer Spark from an agent name or role.
    """
    if not isinstance(agent, dict):
        return False
    return SPARK_MODEL_ID in json.dumps(agent.get("adapterConfig") or {}, sort_keys=True)


def run_output_tokens(run: dict[str, Any]) -> int | None:
    """Read persisted output-token telemetry without treating absent data as 0."""
    candidates: list[Any] = [
        run.get("outputTokens"),
        run.get("output_tokens"),
    ]
    for container_name in ("usageJson", "usage", "resultJson"):
        container = run.get(container_name)
        if isinstance(container, dict):
            candidates.extend((container.get("outputTokens"), container.get("output_tokens")))
            nested_usage = container.get("usage")
            if isinstance(nested_usage, dict):
                candidates.extend((nested_usage.get("outputTokens"), nested_usage.get("output_tokens")))
    for value in candidates:
        if isinstance(value, bool):
            continue
        try:
            if value is not None:
                return max(0, int(value))
        except (TypeError, ValueError):
            continue
    return None


def detect_spark_empty_output_streak(
    runs: list[dict[str, Any]], primary_id: str, threshold: int
) -> list[dict[str, Any]]:
    """Return the newest zero-output run streak when it proves Spark degraded.

    A missing usage payload is unknown, not zero.  A meaningful successful run
    breaks the streak, so only consecutive current results can trigger a move.
    """
    if threshold < 1:
        return []
    primary_runs = [run for run in runs if str(run.get("agentId") or "") == primary_id]
    primary_runs.sort(
        key=lambda run: parse_iso(run.get("finishedAt") or run.get("startedAt") or run.get("createdAt"))
        or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    streak: list[dict[str, Any]] = []
    for run in primary_runs:
        output = run_output_tokens(run)
        if output is None or output > SPARK_EMPTY_OUTPUT_MAX_TOKENS:
            break
        streak.append(run)
        if len(streak) >= threshold:
            return streak
    return []


def fetch_run_log_text(base: str, key: str, run_id: str) -> str:
    log = api_optional(base, key, "GET", f"/api/heartbeat-runs/{run_id}/log")
    if isinstance(log, dict):
        return str(log.get("content", "") or "")
    return ""


def list_open_issues(base: str, key: str, company_id: str, assignee_id: str) -> list[dict[str, Any]]:
    q = urllib.parse.urlencode(
        {"assigneeAgentId": assignee_id, "status": OPEN_STATUSES, "limit": "200"}
    )
    payload = api(base, key, "GET", f"/api/companies/{company_id}/issues?{q}")
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return payload.get("issues", []) or []
    return []


def fetch_agent(base: str, key: str, agent_id: str) -> dict[str, Any] | None:
    payload = api_optional(base, key, "GET", f"/api/agents/{agent_id}")
    return payload if isinstance(payload, dict) else None


def available_sisters(base: str, key: str, sister_ids: list[str]) -> tuple[list[str], list[str]]:
    available: list[str] = []
    skipped: list[str] = []
    for sister_id in sister_ids:
        agent = fetch_agent(base, key, sister_id)
        if not agent:
            # Keep backwards-compatible behavior if this run JWT cannot inspect
            # agents. Assignment PATCH will still be the final authority.
            available.append(sister_id)
            continue
        status = str(agent.get("status") or "").lower()
        if status in {"paused", "disabled", "archived", "suspended", "terminated"}:
            skipped.append(f"{sister_id} (status={status})")
            continue
        available.append(sister_id)
    return available, skipped


def agent_uses_grok_backend(agent: dict[str, Any] | None) -> bool:
    if not isinstance(agent, dict):
        return False
    return str(agent.get("adapterType") or "").strip().lower() in GROK_BACKED_ADAPTER_TYPES


def agent_is_render_only_grok_lane(agent: dict[str, Any] | None) -> bool:
    if not isinstance(agent, dict):
        return False
    haystack = " ".join(
        str(agent.get(key) or "")
        for key in ("name", "title", "urlKey")
    )
    return bool(GROK_RENDER_LANE_RE.search(haystack))


def agent_is_video_render_grok_lane(agent: dict[str, Any] | None) -> bool:
    if not isinstance(agent, dict):
        return False
    haystack = " ".join(
        str(agent.get(key) or "")
        for key in ("name", "title", "urlKey", "description")
    )
    if not GROK_RENDER_LANE_RE.search(haystack):
        return False
    return bool(GROK_VIDEO_RENDER_RE.search(haystack))


def load_grok_quota_state(path: Path = GROK_QUOTA_STATE_PATH) -> dict[str, Any] | None:
    return read_json_file(path)


def available_non_grok_sisters(
    base: str,
    key: str,
    sister_ids: list[str],
) -> tuple[list[str], list[str]]:
    available: list[str] = []
    skipped: list[str] = []
    for sister_id in sister_ids:
        agent = fetch_agent(base, key, sister_id)
        if not agent:
            skipped.append(f"{sister_id} (uninspectable)")
            continue
        status = str(agent.get("status") or "").lower()
        if status in {"paused", "disabled", "archived", "suspended", "terminated"}:
            skipped.append(f"{sister_id} (status={status})")
            continue
        if agent_uses_grok_backend(agent):
            skipped.append(f"{sister_id} (grok-backed)")
            continue
        available.append(sister_id)
    return available, skipped


def is_paused_by_design_primary(
    agent: dict[str, Any] | None,
    available_sister_ids: list[str],
) -> bool:
    if not isinstance(agent, dict):
        return False
    if not available_sister_ids:
        return False
    # Agent roles are operator-authored display text.  The controller used to
    # require the exact legacy value ``ceo`` here, which let a manually parked
    # active Codex CEO (for example ``Chief Executive Officer``) fall through
    # as a failed primary and create a spurious paused-primary recovery.
    # Preserve the safety boundary: only executive lanes with an explicit
    # manual pause are exempt; budget/session/adapter pauses still recover.
    role = str(agent.get("role") or "").strip().lower()
    if not any(token in role for token in PAUSED_BY_DESIGN_ROLES):
        return False
    pause_reason = str(agent.get("pauseReason") or "").strip().lower()
    return any(reason in pause_reason for reason in PAUSED_BY_DESIGN_PAUSE_REASONS)


def issue_has_active_run(base: str, key: str, issue_id: str) -> bool:
    payload = api_optional(base, key, "GET", f"/api/issues/{issue_id}/runs?limit=5")
    runs = payload if isinstance(payload, list) else []
    return any(is_blocking_issue_run(r, issue_id) for r in runs)


def is_blocking_issue_run(run: dict[str, Any], issue_id: str) -> bool:
    status = str(run.get("status") or "").lower()
    if status not in ACTIVE_RUN_STATUSES:
        return False

    context = run.get("contextSnapshot")
    if not isinstance(context, dict):
        return True

    context_issue_id = str(context.get("issueId") or context.get("taskId") or "")
    if context_issue_id and context_issue_id != str(issue_id):
        return False

    # Recovery/status-only housekeeping runs are queued against the issue so the
    # platform can clean up stranded assignments, but they are not the issue
    # doing deliverable work. They must not block fallback reassignment of fresh
    # fixtures, or paused-primary smoke keeps skipping issues that have never
    # actually started.
    if context.get("allowDeliverableWork") is False:
        return False

    source = str(context.get("source") or "").strip().lower()
    if source in NON_BLOCKING_RUN_SOURCES:
        return False

    recovery_intent = str(context.get("recoveryIntent") or "").strip().lower()
    if recovery_intent == "status_only":
        return False

    wake_reason = str(context.get("wakeReason") or "").strip().lower()
    if wake_reason in {"issue_assignment_recovery", "source_scoped_recovery_action"}:
        return False

    return True


def release_issue_checkout(base: str, key: str, issue_id: str, dry_run: bool) -> tuple[bool, str | None]:
    if dry_run:
        return True, None
    try:
        api(base, key, "POST", f"/api/issues/{issue_id}/release", {})
        return True, None
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8")
        except Exception:
            detail = str(exc)
        return False, f"release-failed:{exc.code}:{detail}"


def fallback_reassign_reason(limit_kind: str) -> str:
    kind = (limit_kind or "").lower()
    if kind == "weekly":
        return "weekly_limit"
    if kind == "session":
        return "session_limit"
    if kind == "paused":
        return "paused_primary"
    return "usage_limit"


def request_sister_self_takeover(
    base: str,
    key: str,
    issue_id: str,
    sister_id: str,
    limit_kind: str,
    reset_at: datetime,
    dry_run: bool,
) -> tuple[bool, str | None]:
    comment = (
        "Fallback monitor: detected a fallback-eligible primary and selected "
        f"registered sister @agent://{sister_id} until `{iso_z(reset_at)}`.\n\n"
        "The monitor does not reassign on the sister's behalf. The selected sister "
        "must self-take over this issue through `POST /api/issues/:issueId/"
        "fallback-reassign` with its own agent identity and the matching limit reason."
    )
    if dry_run:
        return True, None
    # A monitor is a third-party executor.  The served route deliberately
    # rejects it when it targets a sister (third_party_target), so dispatch the
    # registered sister with an auditable mention and let that sister invoke the
    # self-takeover route under its own identity.
    try:
        api(
            base,
            key,
            "POST",
            f"/api/issues/{issue_id}/comments",
            {"body": comment},
        )
        return True, None
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8")
        except Exception:
            detail = str(exc)
        return False, f"reassign-failed:{exc.code}:{detail}"


def patch_issue_to_first_available_sister(
    base: str,
    key: str,
    issue_id: str,
    sister_ids: list[str],
    limit_kind: str,
    reset_at: datetime,
    dry_run: bool,
) -> tuple[str | None, list[str]]:
    failures: list[str] = []
    for sister_id in sister_ids:
        ok, reason = request_sister_self_takeover(
            base, key, issue_id, sister_id, limit_kind, reset_at, dry_run
        )
        if ok:
            return sister_id, failures
        failures.append(f"{sister_id} ({reason})")
    return None, failures


def read_state(state_file: Path) -> dict[str, Any] | None:
    if not state_file.exists():
        return None
    try:
        with state_file.open("r", encoding="utf-8") as fh:
            raw = fh.read().strip()
        return json.loads(raw) if raw else None
    except Exception:
        return None


def preview_issue_moves(
    base: str,
    key: str,
    issues: list[dict[str, Any]],
    candidate_sister_ids: list[str],
) -> tuple[list[str], list[str], list[str]]:
    moved_preview: list[str] = []
    skipped_preview: list[str] = []
    would_release_preview: list[str] = []
    for issue in issues:
        issue_id = issue.get("id")
        if not issue_id:
            continue
        if not candidate_sister_ids:
            skipped_preview.append(
                f"{issue.get('identifier') or issue_id} (no available sister)"
            )
            continue
        if issue_has_active_run(base, key, issue_id):
            skipped_preview.append(issue.get("identifier") or issue_id)
            continue
        if issue.get("checkoutRunId"):
            would_release_preview.append(issue.get("identifier") or issue_id)
        moved_preview.append(issue.get("identifier") or issue_id)
    return moved_preview, skipped_preview, would_release_preview


def move_issues_to_sisters(
    base: str,
    key: str,
    issues: list[dict[str, Any]],
    candidate_sister_ids: list[str],
    unavailable_sisters: list[str],
    limit_kind: str,
    reset_at: datetime,
) -> tuple[list[str], dict[str, str], list[str], list[str], list[str]]:
    moved: list[str] = []
    moved_targets: dict[str, str] = {}
    skipped: list[str] = []
    released: list[str] = []
    reassign_failed: list[str] = []
    if not candidate_sister_ids:
        reassign_failed.append(
            f"all configured sisters unavailable ({'; '.join(unavailable_sisters)})"
        )
    for issue in issues:
        if not candidate_sister_ids:
            break
        issue_id = issue.get("id")
        issue_ref = issue.get("identifier") or issue_id
        if not issue_id:
            continue
        if issue_has_active_run(base, key, issue_id):
            skipped.append(issue_ref)
            continue
        target_sister, failures = patch_issue_to_first_available_sister(
            base, key, issue_id, candidate_sister_ids, limit_kind, reset_at, False
        )
        if not target_sister:
            reassign_failed.append(f"{issue_ref} ({'; '.join(failures)})")
            continue
        moved.append(issue_ref)
        moved_targets[issue_ref] = target_sister
    return moved, moved_targets, skipped, released, reassign_failed


def detect_limit(
    run: dict[str, Any],
    base: str,
    key: str,
    adapter: str | None = None,
) -> tuple[re.Match[str] | None, str | None, str]:
    error_text = str(run.get("error") or "")
    match, provider_hint = detect_limit_text(error_text, adapter)
    log_text = ""
    if not match or not has_reset_hint(error_text):
        log_text = fetch_run_log_text(base, key, run["id"])
    if log_text:
        match, provider_hint = detect_limit_text(log_text, adapter)
        if match:
            return match, provider_hint, error_text + "\n" + log_text
    if match:
        return match, provider_hint, error_text
    return None, None, error_text


def scan_grok_quota_exhausted_primaries(
    base: str,
    key: str,
    company_id: str,
    registry: dict[str, list[str]],
    handled_primaries: set[str],
    state_dir: str,
    dry_run: bool,
) -> list[dict[str, Any]]:
    quota_state = load_grok_quota_state()
    if str((quota_state or {}).get("status") or "").lower() != "exhausted":
        return []

    swaps: list[dict[str, Any]] = []
    state_updated_at = str((quota_state or {}).get("updated") or "")
    placeholder_reset_at = now_utc() + timedelta(days=WEEKLY_FALLBACK_DAYS + 1)
    for primary_id, sister_ids in registry.items():
        if primary_id in handled_primaries:
            continue
        agent = fetch_agent(base, key, primary_id)
        if not agent or not agent_uses_grok_backend(agent):
            continue
        if agent_is_render_only_grok_lane(agent):
            continue

        _, state_file = state_paths(state_dir, company_id, primary_id)
        existing_state = read_state(state_file)
        active_state: dict[str, Any] | None = None
        if existing_state and str(existing_state.get("trigger") or "").lower() == "grok-quota-watcher":
            active_state = existing_state

        reset_at = parse_iso((active_state or {}).get("resetAt")) or placeholder_reset_at
        candidate_sister_ids, unavailable_sisters = available_non_grok_sisters(
            base,
            key,
            sister_ids,
        )
        first_sister_id = sister_ids[0]

        if dry_run:
            issues = list_open_issues(base, key, company_id, primary_id)
            if not issues:
                continue
            handled_primaries.add(primary_id)
            moved_preview, skipped_preview, would_release_preview = preview_issue_moves(
                base, key, issues, candidate_sister_ids
            )
            swaps.append(
                {
                    "primary": primary_id,
                    "sister": first_sister_id,
                    "sisters": sister_ids,
                    "availableSisters": candidate_sister_ids,
                    "unavailableSisters": unavailable_sisters,
                    "runId": None,
                    "trigger": "grok-quota-watcher-top-up" if active_state else "grok-quota-watcher",
                    "limitKind": "weekly",
                    "limitProvider": "grok",
                    "resetAt": iso_z(reset_at),
                    "grokQuotaStateUpdatedAt": state_updated_at or None,
                    "wouldMove": moved_preview,
                    "wouldSkipActiveRun": skipped_preview,
                    "wouldReleaseCheckout": would_release_preview,
                }
            )
            continue

        with state_file.open("a+", encoding="utf-8") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            issues = list_open_issues(base, key, company_id, primary_id)
            if not issues:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
                continue
            handled_primaries.add(primary_id)
            moved, moved_targets, skipped, released, reassign_failed = move_issues_to_sisters(
                base,
                key,
                issues,
                candidate_sister_ids,
                unavailable_sisters,
                "weekly",
                reset_at,
            )
            if active_state is not None:
                merged_targets = dict(active_state.get("movedIssueTargets") or {})
                merged_targets.update(moved_targets)
                merged_moved = list(active_state.get("movedIssues") or [])
                for ref in moved:
                    if ref not in merged_moved:
                        merged_moved.append(ref)
                state = dict(active_state)
                state["movedIssues"] = merged_moved
                state["movedIssueTargets"] = merged_targets
                state["skippedActiveRun"] = skipped
                state["releasedCheckouts"] = (
                    list(active_state.get("releasedCheckouts") or []) + released
                )
                state["reassignFailed"] = reassign_failed
                state["lastTopUpAt"] = iso_z(now_utc())
                state["grokQuotaStateStatus"] = "exhausted"
                state["grokQuotaStateUpdatedAt"] = state_updated_at or None
            else:
                state = {
                    "primaryAgentId": primary_id,
                    "sisterAgentId": first_sister_id,
                    "sisterAgentIds": sister_ids,
                    "runId": None,
                    "trigger": "grok-quota-watcher",
                    "limitKind": "weekly",
                    "limitProvider": "grok",
                    "status": "active",
                    "detectedAt": iso_z(now_utc()),
                    "resetAt": iso_z(reset_at),
                    "grokQuotaStatePath": str(GROK_QUOTA_STATE_PATH),
                    "grokQuotaStateStatus": "exhausted",
                    "grokQuotaStateUpdatedAt": state_updated_at or None,
                    "movedIssues": moved,
                    "movedIssueTargets": moved_targets,
                    "skippedActiveRun": skipped,
                    "releasedCheckouts": released,
                    "reassignFailed": reassign_failed,
                }
            fh.seek(0)
            fh.truncate(0)
            fh.write(json.dumps(state, indent=2) + "\n")
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

        swaps.append(
            {
                "primary": primary_id,
                "sister": first_sister_id,
                "sisters": sister_ids,
                "availableSisters": candidate_sister_ids,
                "unavailableSisters": unavailable_sisters,
                "runId": None,
                "trigger": "grok-quota-watcher-top-up" if active_state else "grok-quota-watcher",
                "limitKind": "weekly",
                "limitProvider": "grok",
                "resetAt": iso_z(reset_at),
                "grokQuotaStateUpdatedAt": state_updated_at or None,
                "moved": moved,
                "movedTargets": moved_targets,
                "skippedActiveRun": skipped,
                "releasedCheckouts": released,
                "reassignFailed": reassign_failed,
            }
        )
    return swaps


def scan_paused_primaries(
    base: str,
    key: str,
    company_id: str,
    registry: dict[str, list[str]],
    handled_primaries: set[str],
    state_dir: str,
    dry_run: bool,
) -> list[dict[str, Any]]:
    """Detect registry primaries paused out-of-band (external session-limit
    watcher/controller, manual pause). Paused agents produce no FAILED heartbeat
    runs, so the failed-run scan above is blind to them while their queues sit
    unseen (2026-06-11 incident: 72 open issues stranded on paused primaries
    across 6 companies). Mirrors the failed-run path's state-file guard so
    fallback-swap-back.py can return the issues after the primary resumes."""
    swaps: list[dict[str, Any]] = []
    for primary_id, sister_ids in registry.items():
        if primary_id in handled_primaries:
            continue
        agent = fetch_agent(base, key, primary_id)
        if not agent:
            continue
        if str(agent.get("status") or "").lower() != "paused":
            continue
        _, state_file = state_paths(state_dir, company_id, primary_id)
        existing_state = read_state(state_file)
        active_state: dict[str, Any] | None = None
        if existing_state:
            existing_reset = parse_iso(existing_state.get("resetAt"))
            # Same zero-move retry rule as the failed-run path above — but an
            # ACTIVE swap (something moved, resetAt unexpired) is not a reason
            # to go blind: issues delegated onto a still-paused primary
            # mid-window would otherwise strand until resetAt (seen 2026-06-11:
            # 4 fresh TSC delegations onto paused Engineer minutes after its
            # sweep). Top up instead — move only NEW arrivals (moved issues are
            # no longer on the primary's queue, so nothing can double-move) and
            # merge them into the open state so swap-back returns everything.
            if (
                existing_reset
                and existing_reset > now_utc()
                and (existing_state.get("movedIssues") or [])
            ):
                active_state = existing_state
        # The watcher does not record a reset hint on the agent, so fall back
        # to the session horizon anchored on pausedAt when present. Swap-back
        # additionally defers past resetAt while the primary is still paused.
        # A top-up keeps the open swap's resetAt so swap-back timing is stable.
        if active_state is not None:
            reset_at = parse_iso(active_state.get("resetAt")) or (
                now_utc() + timedelta(hours=SESSION_FALLBACK_HOURS)
            )
        else:
            paused_anchor = parse_iso(agent.get("pausedAt"))
            reset_at = (paused_anchor or now_utc()) + timedelta(hours=SESSION_FALLBACK_HOURS)
            if reset_at <= now_utc():
                reset_at = now_utc() + timedelta(hours=SESSION_FALLBACK_HOURS)
        candidate_sister_ids, unavailable_sisters = available_sisters(base, key, sister_ids)
        if is_paused_by_design_primary(agent, candidate_sister_ids):
            handled_primaries.add(primary_id)
            continue
        first_sister_id = sister_ids[0]

        if dry_run:
            issues = list_open_issues(base, key, company_id, primary_id)
            if not issues:
                continue
            handled_primaries.add(primary_id)
            moved_preview, skipped_preview, would_release_preview = preview_issue_moves(
                base, key, issues, candidate_sister_ids
            )
            swaps.append(
                {
                    "primary": primary_id,
                    "sister": first_sister_id,
                    "sisters": sister_ids,
                    "availableSisters": candidate_sister_ids,
                    "unavailableSisters": unavailable_sisters,
                    "runId": None,
                    "trigger": "paused-primary-top-up" if active_state else "paused-primary",
                    "limitKind": "paused",
                    "pauseReason": agent.get("pauseReason"),
                    "resetAt": iso_z(reset_at),
                    "wouldMove": moved_preview,
                    "wouldSkipActiveRun": skipped_preview,
                    "wouldReleaseCheckout": would_release_preview,
                }
            )
            continue

        with state_file.open("a+", encoding="utf-8") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            issues = list_open_issues(base, key, company_id, primary_id)
            if not issues:
                # No state write on an empty queue: stay unhandled so a later
                # tick still sees this primary and catches issues created
                # mid-pause (a state file here would blind us until resetAt).
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
                continue
            handled_primaries.add(primary_id)
            moved, moved_targets, skipped, released, reassign_failed = move_issues_to_sisters(
                base,
                key,
                issues,
                candidate_sister_ids,
                unavailable_sisters,
                "paused",
                reset_at,
            )
            if active_state is not None:
                # Top-up: merge new arrivals into the open swap, preserving its
                # detectedAt/resetAt so fallback-swap-back returns the whole
                # batch on the original schedule.
                merged_targets = dict(active_state.get("movedIssueTargets") or {})
                merged_targets.update(moved_targets)
                state = dict(active_state)
                state["movedIssues"] = list(active_state.get("movedIssues") or []) + moved
                state["movedIssueTargets"] = merged_targets
                state["skippedActiveRun"] = skipped
                state["releasedCheckouts"] = (
                    list(active_state.get("releasedCheckouts") or []) + released
                )
                state["reassignFailed"] = reassign_failed
                state["lastTopUpAt"] = iso_z(now_utc())
            else:
                state = {
                    "primaryAgentId": primary_id,
                    "sisterAgentId": first_sister_id,
                    "sisterAgentIds": sister_ids,
                    "runId": None,
                    "trigger": "paused-primary",
                    "limitKind": "paused",
                    "pauseReason": agent.get("pauseReason"),
                    "status": "active",
                    "detectedAt": iso_z(now_utc()),
                    "resetAt": iso_z(reset_at),
                    "movedIssues": moved,
                    "movedIssueTargets": moved_targets,
                    "skippedActiveRun": skipped,
                    "releasedCheckouts": released,
                    "reassignFailed": reassign_failed,
                }
            fh.seek(0)
            fh.truncate(0)
            fh.write(json.dumps(state, indent=2) + "\n")
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

        swaps.append(
            {
                "primary": primary_id,
                "sister": first_sister_id,
                "sisters": sister_ids,
                "availableSisters": candidate_sister_ids,
                "unavailableSisters": unavailable_sisters,
                "runId": None,
                "trigger": "paused-primary-top-up" if active_state else "paused-primary",
                "limitKind": "paused",
                "pauseReason": agent.get("pauseReason"),
                "resetAt": iso_z(reset_at),
                "moved": moved,
                "movedTargets": moved_targets,
                "skippedActiveRun": skipped,
                "releasedCheckouts": released,
                "reassignFailed": reassign_failed,
            }
        )
    return swaps


def patch_execution_issue(
    base: str,
    key: str,
    execution_issue: str | None,
    *,
    status: str,
    comment: str | None = None,
) -> None:
    if not execution_issue:
        return
    try:
        payload = {"status": status}
        if comment is not None:
            payload["comment"] = comment
        api(
            base,
            key,
            "PATCH",
            f"/api/issues/{execution_issue}",
            payload,
        )
    except Exception as exc:
        print(
            json.dumps(
                {
                    "executionIssuePatchFailed": True,
                    "status": status,
                    "issueId": execution_issue,
                    "error": f"{type(exc).__name__}: {exc}",
                },
                indent=2,
            )
        )


def main() -> None:
    args = parse_args()
    base = os.environ["PAPERCLIP_API_URL"]
    key = os.environ["PAPERCLIP_API_KEY"]
    company_id = os.environ["PAPERCLIP_COMPANY_ID"]
    execution_issue = args.execution_issue or args.source_issue_id
    guard = _emergency_guard(base, key, company_id, "fallback_reassign")
    try:
        if guard["blocked"]:
            summary = {
                "ok": True,
                "dryRun": args.dry_run,
                "checkedRuns": 0,
                "sinceMinutes": args.since_minutes,
                "swaps": [],
                "guard": include_audit_signature("fallback_reassign", guard),
            }
            print(json.dumps(summary, indent=2))
            if execution_issue and not args.dry_run:
                patch_execution_issue(
                    base,
                    key,
                    execution_issue,
                    status="done",
                    comment=guard_summary(guard),
                )
            return

        registry = load_registry(args.registry)
        scan_targets = set(registry.keys())
        if args.primary_id:
            target_id = str(args.primary_id).strip()
            if target_id:
                scan_targets = {target_id}
        cutoff = now_utc() - timedelta(minutes=args.since_minutes)
        runs = list_recent_failed_runs(base, key, company_id, cutoff, args.max_runs)
        # Spark quota exhaustion can look like a clean success with no output,
        # so it never appears in the failed-run feed above.  Fetch successful
        # runs once, then synthesize the same bounded usage-limit transition the
        # proven TSBC burn driver uses after 12 q=0.000 results.
        successful_runs = list_recent_successful_runs(
            base, key, company_id, cutoff, args.max_runs
        )
        spark_soft_degrades: dict[str, list[dict[str, Any]]] = {}
        for primary_id in scan_targets:
            agent = fetch_agent(base, key, primary_id)
            if not agent_serves_spark(agent):
                continue
            streak = detect_spark_empty_output_streak(
                successful_runs, primary_id, args.spark_empty_streak
            )
            if streak:
                spark_soft_degrades[primary_id] = streak
                newest = streak[0]
                runs.insert(
                    0,
                    {
                        "id": newest.get("id") or f"spark-empty-{primary_id}",
                        "agentId": primary_id,
                        "error": "Spark usage limit reached (successful empty-output streak)",
                        "finishedAt": newest.get("finishedAt") or newest.get("startedAt") or newest.get("createdAt"),
                        "softDegrade": True,
                        "emptyOutputStreak": len(streak),
                        "emptyOutputRunIds": [str(item.get("id")) for item in streak if item.get("id")],
                    },
                )
        if args.force and args.primary_id:
            target_id = str(args.primary_id).strip()
            if target_id:
                synthetic_run = {
                    "id": f"forced-{target_id}",
                    "agentId": target_id,
                    "error": "You've hit your session limit",
                    "finishedAt": iso_z(now_utc()),
                }
                runs = [synthetic_run] + [
                    run for run in runs if str(run.get("agentId") or "") != target_id
                ]
        if args.primary_id:
            runs = [run for run in runs if str(run.get("agentId") or "") in scan_targets]
    except TRANSPORT_ERRORS as exc:
        summary = {
            "ok": False,
            "degraded": True,
            "reason": "transport_failure",
            "error": f"{type(exc).__name__}: {exc}",
        }
        print(json.dumps(summary, indent=2))
        if not args.dry_run:
            patch_execution_issue(
                base,
                key,
                execution_issue,
                status="done",
                comment=(
                    "Fallback monitor: transport failure while scanning failed runs. "
                    "No reassignment was attempted; leaving this tick as a no-op so the "
                    "next scheduled run can retry.\n\n"
                    f"- error: `{type(exc).__name__}: {exc}`"
                ),
            )
        return

    swaps: list[dict[str, Any]] = []
    filtered_registry = {
        pid: sister_ids for pid, sister_ids in registry.items() if pid in scan_targets
    }
    handled_primaries: set[str] = set()
    # Per-tick memo so a primary with several failed runs costs one agent GET.
    primary_agent_cache: dict[str, dict[str, Any] | None] = {}
    checked = 0
    for run in runs:
        checked += 1
        primary_id = str(run.get("agentId") or "")
        if primary_id not in filtered_registry:
            continue
        if primary_id in handled_primaries:
            continue
        if primary_id not in primary_agent_cache:
            primary_agent_cache[primary_id] = fetch_agent(base, key, primary_id)
        primary_adapter = str(
            (primary_agent_cache[primary_id] or {}).get("adapterType") or ""
        )
        match, provider_hint, reset_source = detect_limit(run, base, key, primary_adapter)
        if not match:
            continue
        sister_ids = filtered_registry[primary_id]
        candidate_sister_ids, unavailable_sisters = available_sisters(base, key, sister_ids)
        first_sister_id = sister_ids[0]
        # provider_hint was being passed positionally into the `text` slot, so the
        # hint never reached infer_limit_kind and the limit text was never read.
        limit_kind = limit_kind_from_match(match, reset_source, provider_hint)
        run_anchor = parse_iso(
            run.get("finishedAt") or run.get("startedAt") or run.get("createdAt")
        )
        reset_at = parse_reset_at(reset_source, limit_kind, run_anchor, provider_hint)
        if reset_at <= now_utc():
            handled_primaries.add(primary_id)
            continue
        _, state_file = state_paths(args.state_dir, company_id, primary_id)

        existing_state = read_state(state_file)
        if existing_state:
            existing_reset = parse_iso(existing_state.get("resetAt"))
            # Honor an unexpired state only when it represents an ACTIVE swap
            # (something actually moved). A zero-move state — every reassign
            # failed (e.g. the 2026-06-11 tasks:manage_active_checkouts
            # permission gap) or every issue was skipped — protects nothing,
            # and honoring it strands the queue until resetAt. Retrying is
            # idempotent: nothing was moved, so nothing can double-move.
            if (
                existing_reset
                and existing_reset > now_utc()
                and (existing_state.get("movedIssues") or [])
            ):
                handled_primaries.add(primary_id)
                continue

        handled_primaries.add(primary_id)

        if args.dry_run:
            issues = list_open_issues(base, key, company_id, primary_id)
            moved_preview, skipped_preview, would_release_preview = preview_issue_moves(
                base, key, issues, candidate_sister_ids
            )
            swaps.append(
                {
                    "primary": primary_id,
                    "sister": first_sister_id,
                    "sisters": sister_ids,
                    "availableSisters": candidate_sister_ids,
                    "unavailableSisters": unavailable_sisters,
                    "runId": run["id"],
                    "limitKind": limit_kind,
                    "trigger": "spark-empty-output-streak" if run.get("softDegrade") else "run-limit-text",
                    "limitProvider": "spark" if run.get("softDegrade") else provider_hint,
                    "emptyOutputStreak": run.get("emptyOutputStreak"),
                    "emptyOutputRunIds": run.get("emptyOutputRunIds") or [],
                    "resetAt": iso_z(reset_at),
                    "wouldMove": moved_preview,
                    "wouldSkipActiveRun": skipped_preview,
                    "wouldReleaseCheckout": would_release_preview,
                }
            )
            continue

        with state_file.open("a+", encoding="utf-8") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            issues = list_open_issues(base, key, company_id, primary_id)
            moved, moved_targets, skipped, released, reassign_failed = move_issues_to_sisters(
                base,
                key,
                issues,
                candidate_sister_ids,
                unavailable_sisters,
                limit_kind,
                reset_at,
            )

            state = {
                "primaryAgentId": primary_id,
                "sisterAgentId": first_sister_id,
                "sisterAgentIds": sister_ids,
                "runId": run["id"],
                "trigger": "spark-empty-output-streak" if run.get("softDegrade") else "run-limit-text",
                "limitKind": limit_kind,
                "limitProvider": "spark" if run.get("softDegrade") else provider_hint,
                "status": "active",
                "detectedAt": iso_z(now_utc()),
                "resetAt": iso_z(reset_at),
                "movedIssues": moved,
                "movedIssueTargets": moved_targets,
                "skippedActiveRun": skipped,
                "releasedCheckouts": released,
                "reassignFailed": reassign_failed,
            }
            if run.get("softDegrade"):
                state["emptyOutputStreak"] = run.get("emptyOutputStreak")
                state["emptyOutputRunIds"] = run.get("emptyOutputRunIds") or []
            fh.seek(0)
            fh.truncate(0)
            fh.write(json.dumps(state, indent=2) + "\n")
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

        swaps.append(
            {
                "primary": primary_id,
                "sister": first_sister_id,
                "sisters": sister_ids,
                "availableSisters": candidate_sister_ids,
                "unavailableSisters": unavailable_sisters,
                "runId": run["id"],
                "limitKind": limit_kind,
                "trigger": "spark-empty-output-streak" if run.get("softDegrade") else "run-limit-text",
                "limitProvider": "spark" if run.get("softDegrade") else provider_hint,
                "emptyOutputStreak": run.get("emptyOutputStreak"),
                "emptyOutputRunIds": run.get("emptyOutputRunIds") or [],
                "resetAt": iso_z(reset_at),
                "moved": moved,
                "movedTargets": moved_targets,
                "skippedActiveRun": skipped,
                "releasedCheckouts": released,
                "reassignFailed": reassign_failed,
            }
        )

    # Second detection layer: primaries paused out-of-band produce no failed
    # runs, so scan agent status directly (pause-blindness fix, 2026-06-11).
    try:
        swaps.extend(
            scan_grok_quota_exhausted_primaries(
                base, key, company_id, filtered_registry, handled_primaries,
                args.state_dir, args.dry_run,
            )
        )
        swaps.extend(
            scan_paused_primaries(
                base, key, company_id, filtered_registry, handled_primaries,
                args.state_dir, args.dry_run,
            )
        )
        paused_scan_error: str | None = None
    except TRANSPORT_ERRORS as exc:
        # Same hardening contract as the failed-run scan: a transient blip must
        # not crash the handler and cascade onto claude_local (THIAAAAAA-1834).
        paused_scan_error = f"{type(exc).__name__}: {exc}"

    summary = {
        "ok": True,
        "dryRun": args.dry_run,
        "checkedRuns": checked,
        "sinceMinutes": args.since_minutes,
        "swaps": swaps,
    }
    if paused_scan_error:
        summary["pausedScanDegraded"] = paused_scan_error
    print(json.dumps(summary, indent=2))

    if execution_issue and not args.dry_run:
        moved_any = any(bool(s.get("moved")) for s in swaps)
        failed_any = any(bool(s.get("reassignFailed")) for s in swaps)
        if swaps:
            if moved_any:
                intro = (
                    "Fallback monitor: detected usage-limit failures and/or paused "
                    "primaries and reassigned issues."
                )
            elif failed_any:
                intro = (
                    "Fallback monitor: detected usage-limit failures and/or paused "
                    "primaries, but reassignment was blocked."
                )
            else:
                intro = (
                    "Fallback monitor: detected usage-limit failures and/or paused "
                    "primaries, but there were no movable open issues."
                )
            lines = [intro]
            for s in swaps:
                moved_targets = s.get("movedTargets") or {}
                moved_refs = [
                    f"{ref} → `{moved_targets.get(ref)}`" if moved_targets.get(ref) else ref
                    for ref in s.get("moved") or []
                ]
                refs = ", ".join(moved_refs) or "(no open issues)"
                skip = s.get("skippedActiveRun") or []
                released = s.get("releasedCheckouts") or []
                failed = s.get("reassignFailed") or []
                unavailable = s.get("unavailableSisters") or []
                tail = f" skipped (active run): {', '.join(skip)}" if skip else ""
                if released:
                    tail += f" released stale checkout(s): {', '.join(released)}"
                if unavailable:
                    tail += f" unavailable sister(s): {', '.join(unavailable)}"
                if failed:
                    tail += (
                        f" reassign BLOCKED (permission gap THIAAAAAA-1154): "
                        f"{', '.join(failed)}"
                    )
                kind = s.get("limitKind") or ""
                trigger = str(s.get("trigger") or "").lower()
                if trigger.startswith("grok-quota-watcher"):
                    kind_label = "grok weekly allowance exhausted"
                    origin = "grok-quota watcher state"
                else:
                    kind_label = "primary paused" if kind == "paused" else f"{kind} limit"
                    origin = (
                        f"runId `{s['runId']}`" if s.get("runId") else "paused-primary scan"
                    )
                lines.append(
                    f"- primary `{s['primary']}` → sisters `{', '.join(s.get('sisters') or [s['sister']])}` "
                    f"({kind_label}) until `{s['resetAt']}` "
                    f"({origin}): {refs}{tail}"
                )
            comment = "\n".join(lines)
            if paused_scan_error:
                comment += (
                    f"\n\n- paused-primary scan degraded (transport failure, will "
                    f"retry next tick): `{paused_scan_error}`"
                )
        else:
            # Idle-noise reduction: suppress unchanged-state monitor comments
            comment = None
            if paused_scan_error:
                comment = (
                    f"Fallback monitor: no usage-limit failures detected, but "
                    f"paused-primary scan degraded (transport failure, will "
                    f"retry next tick): `{paused_scan_error}`"
                )
        patch_execution_issue(
            base,
            key,
            execution_issue,
            status="done",
            comment=comment,
        )


if __name__ == "__main__":
    main()
