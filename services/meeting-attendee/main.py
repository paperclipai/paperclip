"""
FastAPI service for the meeting-attendee agent.

Run: uvicorn main:app --port 8200
Expose via ngrok: ngrok http 8200 --domain <your-static-domain>

Endpoints:
  POST /meetings                    - Start a meeting (Vardaan posts a Teams URL)
  POST /webhook/transcript          - Recall.ai transcript chunks
  POST /webhook/meeting-end         - Recall.ai meeting end
  GET  /health                      - liveness for ngrok / launchd
  GET  /meetings/<id>               - meeting state for debugging

Environment variables (from ../../.env.koenig):
  RECALL_API_KEY                            - Recall.ai dashboard API key
  RECALL_REGION                             - us-east-1 (default)
  RECALL_WORKSPACE_VERIFICATION_SECRET      - HMAC verification for webhooks
  MEETING_BOT_PUBLIC_URL                    - ngrok static domain
  ANTHROPIC_API_KEY                         - subscription-billed (claude_local)
  KOKORO_TTS_URL                            - http://localhost:8888 (default)
  PAPERCLIP_URL                             - http://localhost:3100
  COMPANY_ID                                - 1ce472ae-... (learnova-academy)
"""
from __future__ import annotations

import asyncio
import base64
import hmac
import hashlib
import json
import os
import re as _re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

# ──── Configuration ────

REPO_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = REPO_ROOT / ".env.koenig"


def _load_env_file() -> dict[str, str]:
    if not ENV_FILE.exists():
        return {}
    out = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


_ENV = {**_load_env_file(), **os.environ}

RECALL_API_KEY = _ENV.get("RECALL_API_KEY", "")
RECALL_REGION = _ENV.get("RECALL_REGION", "us-west-2")
RECALL_VERIFY = _ENV.get("RECALL_WORKSPACE_VERIFICATION_SECRET", "")
PUBLIC_URL = _ENV.get("MEETING_BOT_PUBLIC_URL", "")
PAPERCLIP_URL = _ENV.get("PAPERCLIP_URL", "http://localhost:3100")
COMPANY_ID = _ENV.get("COMPANY_ID", "1ce472ae-c3fe-47cb-ae1c-99cd79a43b8d")
VAULT_ROOT = _ENV.get("KOENIG_VAULT_ROOT", str(REPO_ROOT / "vault"))
OPENAI_API_KEY = _ENV.get("OPENAI_API_KEY", "")
CARTESIA_API_KEY = _ENV.get("CARTESIA_API_KEY", "")
ANTHROPIC_API_KEY = _ENV.get("ANTHROPIC_API_KEY", "")
TTS_VOICE_OPENAI = _ENV.get("TTS_VOICE_OPENAI", "alloy")  # alloy | ash | echo | nova | onyx | shimmer
TTS_VOICE_CARTESIA = _ENV.get("TTS_VOICE_CARTESIA", "")  # leave blank → uses Cartesia default

RECALL_BASE = f"https://{RECALL_REGION}.recall.ai/api/v1"

CONFIDENTIAL_KEYWORDS = (
    "salary",
    "termination",
    "performance review",
    "personnel issue",
    "lawsuit",
    "legal claim",
    "harassment",
    "compensation negotiation",
)


# ──── State ────

# In-memory; for V1. For production move to a Postgres-backed store.
class MeetingState(BaseModel):
    meeting_id: str
    bot_id: str | None = None
    teams_url: str
    started_at: float
    transcript_buffer: list[dict[str, Any]] = []
    decisions: list[str] = []
    action_items: list[dict[str, Any]] = []
    key_quotes: list[dict[str, Any]] = []
    bot_interventions: list[dict[str, Any]] = []
    confidential: bool = False


_meetings: dict[str, MeetingState] = {}


# ──── Utilities ────

def _verify_recall_signature(body: bytes, headers: Any) -> bool:
    """Recall webhooks use Svix-style signatures. Verify whichever signature header is present.

    Headers:
      svix-id, svix-timestamp, svix-signature  (newer; Recall standard)
      OR x-recall-signature  (older format, body HMAC only)

    Signature scheme: HMAC-SHA256(secret, f"{svix_id}.{svix_timestamp}.{body}")
    """
    if not RECALL_VERIFY:
        # No secret configured → permissive mode (V1 testing). Log warning.
        return True

    svix_id = headers.get("svix-id") or headers.get("Svix-Id")
    svix_ts = headers.get("svix-timestamp") or headers.get("Svix-Timestamp")
    svix_sig = headers.get("svix-signature") or headers.get("Svix-Signature")

    if svix_id and svix_ts and svix_sig:
        # Strip "whsec_" prefix from secret if present (Svix convention)
        secret = RECALL_VERIFY[len("whsec_"):] if RECALL_VERIFY.startswith("whsec_") else RECALL_VERIFY
        try:
            secret_bytes = base64.b64decode(secret)
        except Exception:
            secret_bytes = secret.encode("utf-8")
        signed_payload = f"{svix_id}.{svix_ts}.{body.decode('utf-8', errors='replace')}".encode("utf-8")
        expected = base64.b64encode(
            hmac.new(secret_bytes, signed_payload, hashlib.sha256).digest()
        ).decode("ascii")
        # svix-signature can be space-separated list of "v1,<sig>" entries
        for entry in svix_sig.split():
            if "," in entry:
                _, sig = entry.split(",", 1)
                if hmac.compare_digest(expected, sig):
                    return True
        return False

    # Legacy header (not used by current Recall but kept for fallback)
    legacy_sig = headers.get("x-recall-signature") or headers.get("X-Recall-Signature")
    if legacy_sig:
        expected = hmac.new(RECALL_VERIFY.encode("utf-8"), body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, legacy_sig)

    # No signature header at all → permissive in V1 (Recall is sending; just log)
    return True


def _is_confidential(text: str) -> bool:
    lower = text.lower()
    return any(kw in lower for kw in CONFIDENTIAL_KEYWORDS)


# ──── Org-context loader ────

def _read_safe(path: Path, max_chars: int = 8000) -> str:
    try:
        return path.read_text()[:max_chars] if path.exists() else ""
    except Exception:
        return ""


def _fetch_paperclip_issues() -> dict[str, list[dict[str, Any]]]:
    """GET live tickets from Paperclip; group by status. Synchronous helper used at meeting boot."""
    try:
        import urllib.request
        import urllib.error
        url = f"{PAPERCLIP_URL}/api/companies/{COMPANY_ID}/issues"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read())
        items = data.get("items", []) if isinstance(data, dict) else data
        grouped: dict[str, list[dict[str, Any]]] = {
            "todo": [], "in_progress": [], "in_review": [], "blocked": [],
            "awaiting-g3": [], "awaiting-g4": [], "published-ready": [],
            "done": [], "backlog": [], "other": [],
        }
        from datetime import datetime as _dt, timedelta as _td, timezone as _tz
        today_cutoff = (_dt.now(_tz.utc) - _td(hours=24)).isoformat()
        for it in items:
            status = it.get("status") or "other"
            row = {
                "id": it.get("id"),
                "title": (it.get("title") or "")[:120],
                "assignee": it.get("assigneeAgentSlug") or it.get("assignee") or "?",
                "updated": it.get("updatedAt") or it.get("updated_at") or "",
                "high_stakes": (it.get("metadata") or {}).get("high_stakes", False),
            }
            # "done" → only include if updated in last 24h (else it's noise)
            if status == "done" and row["updated"] and row["updated"] < today_cutoff:
                continue
            grouped.setdefault(status, []).append(row)
        return grouped
    except Exception as e:
        print(f"[org-context] Paperclip fetch failed: {e}")
        return {}


def _git_log_recent(repo_path: Path, hours: int = 24) -> list[str]:
    """Last N hours of git commits in a repo. Returns list of one-line summaries."""
    try:
        import subprocess
        if not (repo_path / ".git").exists():
            return []
        out = subprocess.run(
            ["git", "-C", str(repo_path), "log", f"--since={hours} hours ago",
             "--pretty=format:%h %s (%an, %ar)"],
            capture_output=True, text=True, timeout=10,
        )
        return [line for line in out.stdout.splitlines() if line.strip()][:30]
    except Exception:
        return []


def load_org_context() -> dict[str, Any]:
    """Comprehensive context loader: static docs + live tickets + recent vault + git log.
    Run on every meeting start so the bot's opening + decision loop are grounded in fact.
    """
    from datetime import datetime as _dt, timedelta as _td
    company_dir = REPO_ROOT / "companies" / "learnova-academy"
    vault = Path(VAULT_ROOT)

    # Static org docs
    out: dict[str, Any] = {
        "company_md": _read_safe(company_dir / "COMPANY.md", 4000),
        "culture_md": _read_safe(company_dir / "CULTURE.md", 4000),
        "vault_index": "",
        "recent_meetings": [],
        "recent_retros": [],
        "yesterday_eod": "",
        "todays_research": "",
        "active_seed_topics": "",
        "paperclip_tickets": {},
        "git_log_24h_main": [],
        "git_log_24h_academy": [],
        "ticket_summary_text": "",
    }

    # Vault index (vault-historian's daily summary)
    out["vault_index"] = _read_safe(vault / "_index" / "by-date.md", 4000)[-4000:]

    # Last 8 meeting summaries
    meetings_dir = vault / "meetings"
    if meetings_dir.exists():
        files = sorted([f for f in meetings_dir.glob("*.md") if not f.name.startswith("_")], reverse=True)[:8]
        out["recent_meetings"] = [f.read_text()[:1500] for f in files]

    # Yesterday's EOD digest
    yesterday = (_dt.utcnow() - _td(days=1)).strftime("%Y-%m-%d")
    out["yesterday_eod"] = _read_safe(vault / "decisions" / f"eod-{yesterday}.md", 3000)
    if not out["yesterday_eod"]:
        # Fallback: most recent eod-*.md in decisions/
        decisions = vault / "decisions"
        if decisions.exists():
            eods = sorted(decisions.glob("eod-*.md"), reverse=True)[:1]
            if eods:
                out["yesterday_eod"] = eods[0].read_text()[:3000]

    # Today's daily research brief
    today = _dt.utcnow().strftime("%Y-%m-%d")
    out["todays_research"] = _read_safe(vault / "research" / "_daily" / f"{today}.md", 3000)

    # Last 4 weekly retrospectives
    retros_dir = vault / "retrospectives"
    if retros_dir.exists():
        retros = sorted(retros_dir.rglob("*.md"), reverse=True)[:4]
        out["recent_retros"] = [r.read_text()[:1200] for r in retros]

    # Active seed topics (most recent yaml)
    seed_files = sorted(company_dir.glob("seed-topics-*.yaml"), reverse=True)[:1]
    if seed_files:
        out["active_seed_topics"] = seed_files[0].read_text()[:3500]

    # Live Paperclip task list (todo / in_progress / in_review / blocked / awaiting-g4 / done-today)
    out["paperclip_tickets"] = _fetch_paperclip_issues()

    # Build a human-readable ticket-summary string for the prompt
    pt = out["paperclip_tickets"]
    if pt:
        lines = []
        for status in ["awaiting-g4", "blocked", "in_review", "in_progress", "todo", "published-ready", "done", "backlog"]:
            rows = pt.get(status, [])
            if not rows:
                continue
            label = {
                "awaiting-g4": "🚨 AWAITING YOUR APPROVAL (G4)",
                "blocked": "⚠️ BLOCKED",
                "in_review": "👀 IN REVIEW",
                "in_progress": "🔄 IN PROGRESS",
                "todo": "📋 TODO",
                "published-ready": "🚀 READY TO PUBLISH",
                "done": "✅ DONE (last 24h)",
                "backlog": "📦 BACKLOG",
            }.get(status, status.upper())
            lines.append(f"\n{label} ({len(rows)}):")
            for r in rows[:8]:
                hs = " [high_stakes]" if r.get("high_stakes") else ""
                lines.append(f"  - [{r['assignee']}] {r['title']}{hs}")
            if len(rows) > 8:
                lines.append(f"  ... and {len(rows) - 8} more")
        out["ticket_summary_text"] = "\n".join(lines)

    # Last 24h git log on both repos (what shipped recently in code)
    out["git_log_24h_main"] = _git_log_recent(REPO_ROOT, hours=24)
    learnova = REPO_ROOT.parent / "learnovaBeast"
    if learnova.exists():
        out["git_log_24h_academy"] = _git_log_recent(learnova, hours=24)

    return out


# ──── Recall.ai client ────

SILENT_MP3_PATH = Path(__file__).parent / "silent_1s.mp3"


def _silent_mp3_b64() -> str:
    """Load the 1-sec silent mp3 placeholder; required by Recall to enable audio output."""
    import base64
    if not SILENT_MP3_PATH.exists():
        # Final fallback if mp3 file is missing — minimal but valid MPEG-1 Layer III silent frame
        return base64.b64encode(b"\xff\xe3" + b"\x00" * 4094).decode("ascii")
    return base64.b64encode(SILENT_MP3_PATH.read_bytes()).decode("ascii")


async def recall_create_bot(meeting_url: str) -> dict[str, Any]:
    """Create a Recall bot to join the meeting."""
    if not RECALL_API_KEY:
        raise HTTPException(503, "RECALL_API_KEY not configured")
    if not PUBLIC_URL:
        raise HTTPException(503, "MEETING_BOT_PUBLIC_URL not configured (need ngrok URL)")

    # Recall API v1 schema (2026 update):
    # - recording_config wraps transcript provider + realtime endpoints
    # - "meeting_captions" uses Teams' native captions (free, no extra provider key needed)
    # - realtime_endpoints carries our webhook URL + the events we subscribe to
    payload = {
        "meeting_url": meeting_url,
        "bot_name": "Koenig Meeting Attendee",
        "recording_config": {
            "transcript": {
                "provider": {
                    "meeting_captions": {},
                },
            },
            "realtime_endpoints": [
                {
                    "type": "webhook",
                    "url": f"{PUBLIC_URL}/webhook/transcript",
                    "events": [
                        "transcript.data",
                        "transcript.partial_data",
                        "participant_events.leave",
                    ],
                },
            ],
            # Note: bot lifecycle events (call_ended, done) come via the workspace-level
            # "status_change" webhook configured in Recall dashboard → Webhooks.
            # That webhook should also point at f"{PUBLIC_URL}/webhook/meeting-end".
        },
        "automatic_audio_output": {
            # Required by Recall to enable on-demand audio injection later.
            "in_call_recording": {
                "data": {
                    "kind": "mp3",
                    "b64_data": _silent_mp3_b64(),
                },
            },
        },
        # Bump the auto-leave timeouts so the bot doesn't drop in 2 minutes
        # when the user briefly steps away from the meeting (Recall default is 60-120s).
        "automatic_leave": {
            "everyone_left_timeout": 600,        # 10 min alone before bot leaves
            "noone_joined_timeout": 600,         # 10 min waiting in lobby before bot gives up
            "in_call_not_recording_timeout": 1800,  # 30 min if recording can't start
        },
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{RECALL_BASE}/bot/",
            json=payload,
            headers={"Authorization": RECALL_API_KEY},
        )
        if resp.status_code >= 400:
            raise HTTPException(resp.status_code, f"Recall API error: {resp.text}")
        return resp.json()


async def recall_inject_audio(bot_id: str, mp3_bytes: bytes) -> None:
    """Send synthesized audio to the meeting via Recall."""
    import base64
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            f"{RECALL_BASE}/bot/{bot_id}/output_audio/",
            json={
                "kind": "mp3",
                "b64_data": base64.b64encode(mp3_bytes).decode("ascii"),
            },
            headers={"Authorization": f"Token {RECALL_API_KEY}"},
        )
        resp.raise_for_status()


async def recall_leave(bot_id: str) -> None:
    async with httpx.AsyncClient(timeout=15.0) as client:
        await client.post(
            f"{RECALL_BASE}/bot/{bot_id}/leave_call/",
            headers={"Authorization": f"Token {RECALL_API_KEY}"},
        )


async def recall_send_chat(bot_id: str, message: str, to: str = "everyone") -> bool:
    """Post a message in the meeting's chat panel.

    Recall.ai endpoint: POST /api/v1/bot/{id}/output_chat/ — supported on
    Teams/Zoom/Google Meet. Returns False on error so callers can degrade
    gracefully (chat is supplementary; a chat-send failure must not block
    the speak path).
    """
    if not message or not message.strip():
        return False
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{RECALL_BASE}/bot/{bot_id}/output_chat/",
                json={"to": to, "message": message[:4000]},
                headers={"Authorization": f"Token {RECALL_API_KEY}"},
            )
            if resp.status_code >= 400:
                print(f"[chat] send failed: {resp.status_code} {resp.text[:200]}")
                return False
            return True
    except Exception as e:
        print(f"[chat] exception: {e}")
        return False


# ──── TTS providers (cascading: Cartesia → OpenAI → Kokoro local) ────

async def cartesia_tts(text: str) -> bytes:
    """Synthesize via Cartesia Sonic 3 (40ms TTFA, best-in-class for real-time)."""
    if not CARTESIA_API_KEY:
        raise RuntimeError("CARTESIA_API_KEY not set")
    voice_id = TTS_VOICE_CARTESIA or "f786b574-daa5-4673-aa0c-cbe3e8534c02"
    # Default "slowest" for measured, human-like cadence. Vardaan reported the
    # bot sounded rushed at "slow"; "slowest" gives natural pacing closer to
    # a calm human speaker. Override via TTS_SPEED_CARTESIA env var if needed.
    speed = _ENV.get("TTS_SPEED_CARTESIA", "slowest")  # "slowest" | "slow" | "normal" | "fast" | "fastest"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.cartesia.ai/tts/bytes",
            headers={
                "X-API-Key": CARTESIA_API_KEY,
                "Cartesia-Version": "2024-11-13",
                "Content-Type": "application/json",
            },
            json={
                "model_id": "sonic-2",
                "transcript": text,
                "voice": {
                    "mode": "id",
                    "id": voice_id,
                    "experimental_controls": {
                        "speed": speed,
                        "emotion": ["positivity:low", "curiosity:low"],
                    },
                },
                "output_format": {
                    "container": "mp3",
                    "encoding": "mp3",
                    "sample_rate": 22050,
                    "bit_rate": 64000,
                },
            },
        )
        resp.raise_for_status()
        return resp.content


async def openai_tts(text: str) -> bytes:
    """Synthesize via OpenAI tts-1-hd (best quality cloud TTS, ~300ms latency)."""
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set")
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.openai.com/v1/audio/speech",
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "tts-1-hd",
                "voice": TTS_VOICE_OPENAI,
                "input": text,
                "response_format": "mp3",
            },
        )
        resp.raise_for_status()
        return resp.content


_kokoro_singleton = None


def _kokoro_load():
    """Lazy-load Kokoro ONNX model + voices on first use."""
    global _kokoro_singleton
    if _kokoro_singleton is not None:
        return _kokoro_singleton
    try:
        from kokoro_onnx import Kokoro  # type: ignore
        # Standard model paths after `python -m kokoro_onnx download` (or HF auto-download)
        candidates = [
            (Path.home() / ".cache" / "kokoro-onnx" / "kokoro-v1.0.onnx", Path.home() / ".cache" / "kokoro-onnx" / "voices-v1.0.bin"),
            (Path("/tmp") / "kokoro-v1.0.onnx", Path("/tmp") / "voices-v1.0.bin"),
        ]
        for model_path, voices_path in candidates:
            if model_path.exists() and voices_path.exists():
                _kokoro_singleton = Kokoro(str(model_path), str(voices_path))
                return _kokoro_singleton
    except Exception:
        pass
    return None


async def kokoro_tts(text: str) -> bytes:
    """Synthesize via local Kokoro ONNX (free, ~600-1500ms on Apple Silicon)."""
    import io
    import soundfile as sf  # type: ignore
    kokoro = _kokoro_load()
    if kokoro is None:
        raise RuntimeError("Kokoro model not available — run scripts/install-kokoro.sh first")
    samples, sample_rate = kokoro.create(text, voice="af_sarah", speed=1.0, lang="en-us")
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="MP3")
    return buf.getvalue()


async def synthesize(text: str) -> tuple[bytes, str]:
    """Try TTS providers in cascading order: Cartesia → OpenAI → Kokoro local.
    Returns (mp3_bytes, provider_name).
    """
    if CARTESIA_API_KEY:
        try:
            return await cartesia_tts(text), "cartesia"
        except Exception as e:
            print(f"[tts] Cartesia failed: {e}; trying OpenAI")
    if OPENAI_API_KEY:
        try:
            return await openai_tts(text), "openai"
        except Exception as e:
            print(f"[tts] OpenAI failed: {e}; trying Kokoro")
    return await kokoro_tts(text), "kokoro"


# ──── Decision loop ────

_DECISION_SYSTEM_PROMPT = """You are the Meeting Attendee bot for Koenig AI Academy ("Ronald" voice — thoughtful, composed, calm).

YOUR ROLE: be a useful, human-feeling assistant in Vardaan's meetings. Listen, take notes, and respond naturally when he addresses you OR asks any direct question OR seems to want your input. You have RESEARCH TOOLS — use them when a fact-based answer is needed.

═══════════════════════════════════════════════════════════
HOW TO SOUND HUMAN (this is the most important rule):
═══════════════════════════════════════════════════════════

- Use plain English. NO jargon unless Vardaan uses it first. Examples:
  - ❌ "G0 review" → ✅ "the editorial review"
  - ❌ "course-delta" → ✅ "the course update"
  - ❌ "Paperclip ticket KOE-16" → ✅ "the ticket — K-O-E sixteen"
  - ❌ "in_progress / in_review" → ✅ "in flight" / "with the reviewer"
  - ❌ "DefinedTerm schema" → ✅ "glossary entry"
  - ❌ "MCP server" → ✅ "the connector" (or just say "MCP" once if needed; don't keep saying it)
- Use contractions: "I'll", "you've", "we're", "let's".
- Vary sentence length. Short sentences feel natural when spoken.
- ONE thought per sentence. No comma-stacked clauses.
- Don't read out IDs character by character unless asked. Say "the connector ticket" not "K-O-E sixteen" most of the time.
- ≤2 sentences per turn unless answering a complex factual question (then ≤4).
- Don't list. Speak in prose. If listing is unavoidable, use "first... second... third" — never bullet points.
- Don't say "Sure" / "Of course" / "Absolutely". Just answer.
- Don't say "Great question". Just answer.
- Acknowledge briefly when given a task: "Got it." / "On it." / "Done." Then move on.
- It's fine to use occasional natural fillers in moderation: "right", "yeah", "ok" — sparingly.
- When uncertain, say "I'm not sure" or "Let me check" rather than inventing.

═══════════════════════════════════════════════════════════
LIVE ORG CONTEXT (loaded once per meeting):
═══════════════════════════════════════════════════════════
{org_context}

═══════════════════════════════════════════════════════════
RECENT BUFFER (last ~60 seconds of utterances):
═══════════════════════════════════════════════════════════
{recent_buffer}

═══════════════════════════════════════════════════════════
CURRENT UTTERANCE from {speaker}:
"{utterance}"

DECIDE one of these actions:

1. **"silent"** — the default. Don't speak. Don't log unless this is a clear decision or action item.
2. **"speak"** — speak whenever ANY of these are true (be liberal, not stingy):
   (a) Vardaan addressed the bot directly ("Bot, ...", "Ronald, ...", "Hey ...") — even if he just said your name.
   (b) Vardaan asked a direct question (sentence ends in "?", or starts with "what / how / when / where / why / who / can you / could you / should / do you / does" / etc.).
   (c) Vardaan said "let me know", "thoughts?", "your take?", "any feedback?", or used "you / your" pronouns toward the bot.
   (d) Vardaan said "raise a ticket", "file a ticket", "log this", "make a note" — confirm + log it.
   (e) A topic has stalled 3+ utterances without resolution AND you have a relevant fact from the briefing or tools.
3. **"log"** — capture as decision / action_item / quote for the post-meeting summary.

WHEN VARDAAN ASKS A QUESTION:
- Use the research tools FIRST (search_vault, list_tickets, get_capability, web_search) to ground your answer in current facts.
- Then respond in ≤2 short, factual sentences. Cite the source ("Per the seed-topics yaml, ..." / "Looking at Paperclip, the Cursor blog is in_review with content-reviewer.").
- If you can't find a definitive answer, say so honestly.

WHEN TO USE TOOLS:
- "What's the status of X?" → list_tickets or search_vault
- "Did we decide on Y?" → search_vault for vault/decisions/ + vault/meetings/
- "What did Anthropic ship today?" → search_vault for vault/research/anthropic/ OR web_search
- "Pull up the determinism benchmark" → search_vault for vault/data/
- "What's Cursor's latest update?" → get_capability("community", "cursor-...") or web_search

LOG SCHEMA when "log":
- decision: short declarative summary
- action_item: include `assignee` (chief-content / chief-research / chief-engineering / chief-marketing-seo / ceo)
- quote: verbatim text + speaker

When you've finished using tools and reached a final decision, output STRICT JSON:
{{"action": "silent" | "speak" | "log",
  "log_kind": "decision" | "action_item" | "quote" | null,
  "text": "...",
  "assignee": "...",
  "reason": "..."}}

When in doubt, prefer "silent" over "speak". Brevity is your virtue."""


# ──── Tools available to the decision agent ────

import re as _re

def _tool_search_vault(query: str, paths: list[str] | None = None, max_results: int = 8) -> str:
    """Grep across vault subdirectories, return matching file paths + a snippet from each."""
    import subprocess
    vault = Path(VAULT_ROOT)
    if not vault.exists():
        return "(vault not found)"
    targets = paths or ["blogs", "courses", "research", "meetings", "decisions", "glossary", "capabilities", "retrospectives"]
    target_paths = [str(vault / p) for p in targets if (vault / p).exists()]
    if not target_paths:
        return "(no vault subdirs match)"
    try:
        result = subprocess.run(
            ["grep", "-rli", "--include=*.md", query, *target_paths],
            capture_output=True, text=True, timeout=10,
        )
        files = [line for line in result.stdout.splitlines() if line.strip()][:max_results]
        if not files:
            return f"(no vault files match '{query}')"
        snippets = []
        for f in files:
            try:
                content = Path(f).read_text()
                # find the first match line + 2 lines around it
                lines = content.splitlines()
                idx = next((i for i, ln in enumerate(lines) if query.lower() in ln.lower()), 0)
                ctx = "\n".join(lines[max(0, idx - 1):min(len(lines), idx + 3)])
                rel = f.replace(str(vault) + "/", "vault/")
                snippets.append(f"--- {rel} ---\n{ctx[:400]}")
            except Exception:
                continue
        return "\n\n".join(snippets[:max_results])
    except Exception as e:
        return f"(search error: {e})"


def _tool_list_tickets(status: str | None = None, assignee: str | None = None, limit: int = 12) -> str:
    """List Paperclip tickets with optional status/assignee filter."""
    try:
        import urllib.request
        url = f"{PAPERCLIP_URL}/api/companies/{COMPANY_ID}/issues"
        with urllib.request.urlopen(url, timeout=8) as r:
            data = json.loads(r.read())
        items = data.get("items", []) if isinstance(data, dict) else data
        rows = []
        for it in items:
            if status and it.get("status") != status:
                continue
            ag = it.get("assigneeAgentSlug") or it.get("assignee") or ""
            if assignee and assignee.lower() not in ag.lower():
                continue
            rows.append(
                f"[{it.get('status','?')}] [{ag or '?'}] {(it.get('title') or '')[:120]}"
            )
        if not rows:
            return f"(no tickets match status={status} assignee={assignee})"
        return "\n".join(rows[:limit])
    except Exception as e:
        return f"(list error: {e})"


def _tool_get_capability(vendor: str, slug: str | None = None) -> str:
    """Read a vendor capability page from vault/capabilities/<vendor>/<slug>.md (or list if slug omitted)."""
    cap_dir = Path(VAULT_ROOT) / "capabilities" / vendor.lower()
    if not cap_dir.exists():
        return f"(vendor '{vendor}' not in capabilities tracker)"
    if not slug:
        files = sorted(cap_dir.glob("*.md"))
        return f"Available {vendor} capabilities:\n" + "\n".join(f.stem for f in files)
    f = cap_dir / f"{slug}.md"
    if not f.exists():
        files = sorted(cap_dir.glob("*.md"))
        return f"(slug not found; available: {', '.join(f.stem for f in files[:10])})"
    return f.read_text()[:3000]


def _tool_web_search(query: str, max_results: int = 5) -> str:
    """Tavily search for current web info (if TAVILY_API_KEY set; else fallback)."""
    tavily_key = _ENV.get("TAVILY_API_KEY", "")
    if not tavily_key:
        return "(no TAVILY_API_KEY; web search unavailable)"
    try:
        import urllib.request
        body = json.dumps({
            "api_key": tavily_key,
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
        }).encode()
        req = urllib.request.Request(
            "https://api.tavily.com/search",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
        results = data.get("results", [])
        if not results:
            return "(no web results)"
        return "\n\n".join(
            f"{r.get('title','?')}\n{r.get('url','')}\n{(r.get('content','') or '')[:300]}"
            for r in results[:max_results]
        )
    except Exception as e:
        return f"(web search error: {e})"


_TOOL_DEFINITIONS = [
    {
        "name": "search_vault",
        "description": "Search the Koenig AI Academy vault (vault/blogs/, vault/courses/, vault/research/, vault/meetings/, vault/decisions/, vault/glossary/, vault/capabilities/, vault/retrospectives/) for files matching a query. Returns file paths + snippets. Use to look up past decisions, research notes, blog drafts, course chapters, or meeting records.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "search keyword or phrase"},
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "subdirs under vault/ to search; omit for all",
                },
            },
            "required": ["query"],
        },
    },
    {
        "name": "list_tickets",
        "description": "List Paperclip tickets, optionally filtered by status (todo, in_progress, in_review, blocked, awaiting-g3, awaiting-g4, published-ready, done, backlog) or assignee (agent slug like blog-author, content-reviewer, ceo). Use to answer 'what's the status of X?' or 'what's blocking us?'",
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string"},
                "assignee": {"type": "string"},
            },
        },
    },
    {
        "name": "get_capability",
        "description": "Read a vendor capability page from the /capabilities tracker. Vendors: anthropic, openai, google, meta, mistral, alibaba, cohere, deepseek, zhipu, 01-ai, community. Omit slug to list all capabilities for a vendor.",
        "input_schema": {
            "type": "object",
            "properties": {
                "vendor": {"type": "string"},
                "slug": {"type": "string"},
            },
            "required": ["vendor"],
        },
    },
    {
        "name": "web_search",
        "description": "Search the public web via Tavily for current info Vardaan asks about that's not in the vault. Use sparingly — prefer vault-grounded answers.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
            },
            "required": ["query"],
        },
    },
]


def _run_tool(name: str, inputs: dict) -> str:
    if name == "search_vault":
        return _tool_search_vault(inputs.get("query", ""), inputs.get("paths"))
    if name == "list_tickets":
        return _tool_list_tickets(inputs.get("status"), inputs.get("assignee"))
    if name == "get_capability":
        return _tool_get_capability(inputs.get("vendor", ""), inputs.get("slug"))
    if name == "web_search":
        return _tool_web_search(inputs.get("query", ""))
    return f"(unknown tool: {name})"


def _build_recent_buffer(state: MeetingState, max_chars: int = 2000) -> str:
    """Format last ~60s of transcript buffer for the decision prompt."""
    if not state.transcript_buffer:
        return "(empty — meeting just started)"
    out = []
    total = 0
    for entry in reversed(state.transcript_buffer):
        line = f"{entry['speaker']}: {entry['text']}"
        total += len(line)
        if total > max_chars:
            break
        out.append(line)
    return "\n".join(reversed(out))


def _format_org_context(ctx: dict[str, Any], max_chars: int = 14000) -> str:
    """Compress comprehensive org context into a system-prompt fragment within token budget."""
    parts = [
        "## Company structure\n" + ctx.get("company_md", "")[:1200],
        "## Culture / collaboration norms\n" + ctx.get("culture_md", "")[:1000],
        "## 📋 LIVE PAPERCLIP TICKETS (the source of truth for what's todo/blocked/done)\n"
        + (ctx.get("ticket_summary_text") or "(no tickets fetched)"),
        "## 📅 Yesterday's EOD digest\n" + (ctx.get("yesterday_eod") or "(no digest yet)")[:2000],
        "## 🔬 Today's research daily-brief\n" + (ctx.get("todays_research") or "(researchers haven't synthesized yet today)")[:1500],
        "## 📚 Active content seed (current week)\n" + (ctx.get("active_seed_topics") or "")[:2000],
        "## 🗒️ Recent vault index (vault-historian summary)\n" + (ctx.get("vault_index") or "")[:1500],
        "## 🔁 Last 4 weekly retrospectives\n" + "\n---\n".join(ctx.get("recent_retros") or [])[:2000],
        "## 🤝 Last 8 meeting summaries\n" + "\n---\n".join(ctx.get("recent_meetings") or [])[:2500],
        "## 🛠️ Git activity (last 24h)\n"
        + "[koenig-ai-org]\n" + "\n".join(ctx.get("git_log_24h_main") or ["(no commits)"])[:1000]
        + "\n[learnovaBeast/academy]\n" + "\n".join(ctx.get("git_log_24h_academy") or ["(no commits)"])[:1000],
    ]
    out = "\n\n".join(parts)
    return out[:max_chars]


async def decide(state: MeetingState, utterance: str, speaker: str) -> dict[str, Any]:
    """Call Haiku 4.5 with tool-use to decide silent / speak / log.
    Haiku for low-latency conversational pacing. Wake-word fast-path bypasses
    extensive tool use when user is directly addressing the bot.
    """
    if not utterance.strip():
        return {"action": "silent", "text": "", "reason": "empty-utterance"}

    if not _ENV.get("ANTHROPIC_API_KEY"):
        lower = utterance.lower()
        if any(kw in lower for kw in ("we decided", "let's go with", "agreed", "approved")):
            return {"action": "log", "log_kind": "decision", "text": utterance, "reason": "keyword-decision"}
        return {"action": "silent", "text": "", "reason": "no-api-key-default-silent"}

    # Wake-word fast-path detection: if anyone (not just Vardaan) directly addresses
    # the bot, give it priority + fewer tool rounds for snappier response.
    # Includes Teams ASR mis-hearings ("Donald", "Roland", "Reynold") of "Ronald".
    _utt_lower = utterance.lower()
    _wake_pattern = _re.compile(
        r"\b(bot|nova|ronald|donald|roland|reynold|renault|"
        r"claude|agent|hey\s+(bot|nova|ronald|donald|claude)|"
        r"meeting\s+bot|note\s*taker|notetaker|are\s+you\s+there|you\s+there|"
        r"hi\s+(bot|nova|ronald|donald|claude))\b",
        _re.IGNORECASE,
    )
    is_directly_addressed = bool(_wake_pattern.search(_utt_lower))

    # When directly addressed AND we just got a fresh utterance, short-circuit
    # the LLM entirely with a hardcoded acknowledgment for instant response.
    # The actual answer (if a question was asked) follows from the LLM path
    # in subsequent transcript chunks.
    if is_directly_addressed and len(utterance.split()) <= 4:
        return {
            "action": "speak",
            "text": "Yes, I'm here. Go ahead.",
            "reason": "wake-word-instant-ack",
        }

    org_ctx = state.__dict__.get("_org_context") or {}
    system = _DECISION_SYSTEM_PROMPT.format(
        org_context=_format_org_context(org_ctx),
        recent_buffer=_build_recent_buffer(state),
        speaker=speaker,
        utterance=utterance,
    )

    try:
        from anthropic import AsyncAnthropic  # type: ignore
        client = AsyncAnthropic(api_key=_ENV["ANTHROPIC_API_KEY"])

        # Wake-word path: tight token cap, fewer tool rounds for snappy reply.
        # Normal path: more tool rounds for thoughtful research-backed answers.
        if is_directly_addressed:
            initial_user = "User directly addressed the bot. Respond in ≤25 words. Use at most 1 quick tool call only if status/data is essential. Return strict JSON."
            max_rounds = 2
            max_toks = 250
        else:
            initial_user = "Decide. Use research tools if asked a question that benefits from current data. Then return strict JSON. If you DO speak, keep it ≤30 words."
            max_rounds = 4
            max_toks = 350

        messages: list[dict] = [{"role": "user", "content": initial_user}]

        for _round in range(max_rounds):
            resp = await client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=max_toks,
                system=system,
                tools=_TOOL_DEFINITIONS,
                messages=messages,
            )

            if resp.stop_reason == "tool_use":
                # Append assistant turn + run tools + append tool results
                messages.append({"role": "assistant", "content": resp.content})
                tool_results = []
                for block in resp.content:
                    if block.type == "tool_use":
                        result = _run_tool(block.name, dict(block.input))
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": result[:4000],
                        })
                messages.append({"role": "user", "content": tool_results})
                continue

            # End of tool loop — extract final JSON
            text = "".join(b.text for b in resp.content if hasattr(b, "text")).strip()
            # Strip code-fence wrappers
            if text.startswith("```"):
                text = text.strip("`").lstrip("json").strip()
            # Trim everything before the first { (model may prepend prose)
            start = text.find("{")
            if start >= 0:
                text = text[start:]
            # Use raw_decode to tolerate trailing prose after the JSON
            try:
                obj, _idx = json.JSONDecoder().raw_decode(text)
                return obj
            except json.JSONDecodeError:
                # Fallback: regex-extract a balanced { ... } block
                # (module-level `import re as _re` covers this; do not re-import
                # locally — it would shadow the module-level binding and break
                # other _re references in the same function via Python scoping.)
                m = _re.search(r"\{[\s\S]*?\}", text)
                if m:
                    return json.loads(m.group(0))
                raise

        return {"action": "silent", "text": "", "reason": "tool-loop-exceeded"}
    except Exception as e:
        return {"action": "silent", "text": "", "reason": f"decide-error:{e}"}


# ──── FastAPI app ────

app = FastAPI(title="Koenig Meeting Attendee")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "meeting-attendee", "ts": datetime.now(timezone.utc).isoformat()}


class StartMeetingRequest(BaseModel):
    teams_url: str
    meeting_type: str | None = "general"
    proactive_mode: bool | None = False  # If true, bot opens with stand-up summary
    proactive_delay_s: int | None = 12   # Seconds after join before opening (lobby admit time)


def _parse_last_meeting_action_items(meeting_md: str) -> list[dict[str, str]]:
    """Pull action items out of a previous meeting summary file (markdown).
    Looks for lines under '## Action items' formatted as `- → @<assignee>: <desc>`.
    """
    out = []
    in_section = False
    for line in meeting_md.splitlines():
        if line.startswith("## Action items"):
            in_section = True
            continue
        if in_section and line.startswith("## "):
            break
        if in_section and line.strip().startswith("- "):
            text = line.strip()[2:].strip()
            if text.startswith("→"):
                text = text[1:].strip()
            assignee = ""
            desc = text
            if text.startswith("@"):
                parts = text.split(":", 1)
                if len(parts) == 2:
                    assignee = parts[0].lstrip("@").strip()
                    desc = parts[1].strip()
            out.append({"assignee": assignee, "description": desc})
    return out


def _check_action_item_status(description: str, current_tickets: dict[str, list[dict]]) -> str:
    """Best-effort match: did this action item get a ticket? what's its status?"""
    desc_words = set(w.lower() for w in description.split() if len(w) > 3)
    if not desc_words:
        return "no-match"
    best_match = None
    best_score = 0
    for status, rows in current_tickets.items():
        for r in rows:
            title = (r.get("title") or "").lower()
            score = len(desc_words & set(title.split()))
            if score > best_score and score >= 2:
                best_score = score
                best_match = (status, r)
    if not best_match:
        return "no-matching-ticket-found"
    status, ticket = best_match
    return f"matched ticket [{status}] '{ticket.get('title','')[:60]}' assignee={ticket.get('assignee','?')}"


async def _generate_ceo_perspective(ctx: dict[str, Any]) -> str:
    """Sonnet acts as the CEO and gives a brief priority statement.
    Used by the pre-meeting brief so the bot can open with both ground-truth
    data AND a CEO-level take on what matters most right now."""
    if not ANTHROPIC_API_KEY:
        return ""
    try:
        from anthropic import AsyncAnthropic  # type: ignore
        client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        system = """You are the CEO of Koenig AI Academy. You are reviewing the current org state right before Vardaan (founder) starts a meeting.

Produce a SHORT priority briefing (2-3 sentences max). Output exactly:
1. What matters most right now (specific item, ticket ID, or blocker)
2. The single most leveraged decision/action that would unlock the most value today

Be specific. Reference actual ticket IDs, blog slugs, or vault paths from the context. Plain English. No jargon. NO preamble like "Based on the context...". Output the briefing directly."""

        user = "Current org state:\n\n" + _format_org_context(ctx, max_chars=10000)
        resp = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=300,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return "".join(b.text for b in resp.content if hasattr(b, "text")).strip()
    except Exception as e:
        print(f"[ceo-prep] failed: {e}")
        return ""


async def build_pre_meeting_brief_async(ctx: dict[str, Any]) -> dict[str, Any]:
    """Async wrapper that includes the CEO perspective."""
    brief = build_pre_meeting_brief(ctx)
    brief["ceo_perspective"] = await _generate_ceo_perspective(ctx)
    return brief


def build_pre_meeting_brief(ctx: dict[str, Any]) -> dict[str, Any]:
    """Comprehensive pre-meeting briefing. Run BEFORE the bot joins.

    Produces:
    - achievements_24h: what shipped in the last 24h
    - pending: what's todo / in_progress / in_review (grouped by assignee)
    - blockers: what's blocked + likely cause
    - awaiting_human: tickets needing Vardaan's input (awaiting-g4 + high_stakes)
    - last_meeting: what was discussed last meeting + status update on each action item
    - questions_for_human: specific items that need Vardaan's call
    """
    from datetime import datetime as _dt
    tickets = ctx.get("paperclip_tickets") or {}

    achievements_24h: list[str] = []
    # Done in last 24h
    for r in tickets.get("done", []):
        achievements_24h.append(f"✅ [{r['assignee']}] {r['title']}")
    # Recent commits
    for line in (ctx.get("git_log_24h_main") or [])[:10]:
        achievements_24h.append(f"🛠️ koenig-ai-org: {line}")
    for line in (ctx.get("git_log_24h_academy") or [])[:10]:
        achievements_24h.append(f"🛠️ academy: {line}")

    pending = {
        "in_progress": tickets.get("in_progress", []),
        "in_review": tickets.get("in_review", []),
        "todo": tickets.get("todo", []),
        "published-ready": tickets.get("published-ready", []),
    }
    blockers = tickets.get("blocked", [])
    awaiting_human = [
        *tickets.get("awaiting-g4", []),
        *[r for r in tickets.get("awaiting-g3", []) if r.get("high_stakes")],
    ]

    # Last meeting follow-up: parse the most recent meeting file's action items,
    # then check current ticket status of each to surface "did this get done?"
    last_meeting_followup = []
    last_meeting_summary = ""
    recent_meetings = ctx.get("recent_meetings") or []
    if recent_meetings:
        last_meeting_md = recent_meetings[0]
        last_meeting_summary = last_meeting_md[:1500]
        items = _parse_last_meeting_action_items(last_meeting_md)
        for item in items:
            status_text = _check_action_item_status(item["description"], tickets)
            last_meeting_followup.append({
                "from_last_meeting": item["description"],
                "assigned_to": item["assignee"] or "unassigned",
                "current_status": status_text,
            })

    # Questions for human: combine awaiting-human + last-meeting-unresolved + decisions needed
    questions = []
    for r in awaiting_human:
        questions.append({
            "kind": "approval-needed",
            "ticket": r["title"],
            "ask": f"Approve or reject the {r['title'][:60]} ticket?",
        })
    for f in last_meeting_followup:
        if "no-match" in f["current_status"]:
            questions.append({
                "kind": "previous-action-stalled",
                "from_last_meeting": f["from_last_meeting"],
                "ask": f"You asked about '{f['from_last_meeting'][:80]}' last meeting — no ticket exists. Should I create one?",
            })

    brief = {
        "generated_at": _dt.utcnow().isoformat(),
        "achievements_24h": achievements_24h[:15],
        "pending_counts": {k: len(v) for k, v in pending.items()},
        "pending_top_5_by_assignee": _top_pending_per_assignee(pending),
        "blockers_count": len(blockers),
        "blockers": [{"title": r["title"], "assignee": r["assignee"]} for r in blockers[:5]],
        "awaiting_human_count": len(awaiting_human),
        "awaiting_human": [{"title": r["title"]} for r in awaiting_human[:5]],
        "last_meeting_summary": last_meeting_summary,
        "last_meeting_action_items_followup": last_meeting_followup,
        "questions_for_human": questions[:5],
    }
    return brief


def _top_pending_per_assignee(pending: dict[str, list]) -> dict[str, list[str]]:
    """For each assignee, pick the top 1-2 in-flight items they're working on."""
    by_assignee: dict[str, list[str]] = {}
    for status, rows in pending.items():
        for r in rows:
            ag = r.get("assignee") or "?"
            if ag not in by_assignee:
                by_assignee[ag] = []
            if len(by_assignee[ag]) < 2:
                by_assignee[ag].append(f"[{status}] {r['title'][:80]}")
    return by_assignee


def _write_brief_to_vault(bot_id: str, state: MeetingState, brief: dict[str, Any]) -> Path:
    """Persist the pre-meeting brief as Obsidian markdown.
    Path: vault/meetings/<date>-meeting-<short-id>-brief.md
    Frontmatter + sections that match Obsidian wikilink conventions.
    """
    from datetime import datetime as _dt
    date_str = _dt.utcnow().strftime("%Y-%m-%d")
    time_str = _dt.utcnow().strftime("%H-%M")
    short = bot_id[:8]
    meetings_dir = Path(VAULT_ROOT) / "meetings"
    meetings_dir.mkdir(parents=True, exist_ok=True)
    path = meetings_dir / f"{date_str}-meeting-{short}-brief.md"

    pc = brief.get("pending_counts", {})
    lines = [
        "---",
        f"date: {date_str}",
        f"time: {time_str}",
        f"meeting_id: {bot_id}",
        f"teams_url: {state.teams_url}",
        f"kind: pre-meeting-brief",
        f"achievements_24h: {len(brief.get('achievements_24h', []))}",
        f"pending_in_progress: {pc.get('in_progress', 0)}",
        f"pending_in_review: {pc.get('in_review', 0)}",
        f"pending_todo: {pc.get('todo', 0)}",
        f"blockers: {brief.get('blockers_count', 0)}",
        f"awaiting_human: {brief.get('awaiting_human_count', 0)}",
        f"questions_for_human: {len(brief.get('questions_for_human', []))}",
        f"tags: [meeting, brief, pre-meeting]",
        "---",
        "",
        f"# Pre-meeting brief — {date_str} {time_str}",
        "",
        f"Meeting bot ID: `{bot_id}` · Teams URL: <{state.teams_url}>",
        "",
    ]

    if brief.get("ceo_perspective"):
        lines.append("## 👔 CEO's take (priority right now)")
        lines.append("")
        lines.append("> " + brief["ceo_perspective"].replace("\n", "\n> "))
        lines.append("")

    # Achievements
    lines.append("## ✅ Achievements (last 24h)")
    if brief.get("achievements_24h"):
        for a in brief["achievements_24h"]:
            lines.append(f"- {a}")
    else:
        lines.append("- _(no logged achievements in the last 24h)_")
    lines.append("")

    # Pending by assignee
    lines.append("## ⏳ Pending — by assignee")
    tp = brief.get("pending_top_5_by_assignee") or {}
    if tp:
        for ag, items in tp.items():
            lines.append(f"### {ag}")
            for it in items:
                lines.append(f"- {it}")
    else:
        lines.append("- _(no pending items)_")
    lines.append("")

    # Blockers
    lines.append("## ⚠️ Blockers")
    if brief.get("blockers"):
        for b in brief["blockers"]:
            lines.append(f"- **[{b['assignee']}]** {b['title']}")
    else:
        lines.append("- _(no blockers — clean run)_")
    lines.append("")

    # Awaiting human
    lines.append("## 🚨 Awaiting your approval")
    if brief.get("awaiting_human"):
        for ah in brief["awaiting_human"]:
            lines.append(f"- {ah['title']}")
    else:
        lines.append("- _(nothing awaiting G4 approval)_")
    lines.append("")

    # Last meeting follow-up
    lines.append("## 📅 Last meeting — action item follow-up")
    fu = brief.get("last_meeting_action_items_followup") or []
    if fu:
        for f in fu:
            lines.append(f"- **{f['from_last_meeting']}** _(assigned: {f['assigned_to']})_")
            lines.append(f"  - Current status: {f['current_status']}")
    else:
        lines.append("- _(no prior meeting on file, or last meeting had no action items)_")
    lines.append("")

    # Last meeting summary embed
    if brief.get("last_meeting_summary"):
        lines.append("## 📝 Last meeting summary")
        lines.append("```markdown")
        lines.append(brief["last_meeting_summary"][:2000])
        lines.append("```")
        lines.append("")

    # Questions for human
    lines.append("## ❓ Questions for Vardaan")
    questions = brief.get("questions_for_human") or []
    if questions:
        for q in questions:
            lines.append(f"- **[{q['kind']}]** {q['ask']}")
    else:
        lines.append("- _(no specific questions — bot will follow your lead)_")
    lines.append("")

    # Wikilinks footer (Obsidian niceties)
    lines.append("---")
    lines.append("")
    lines.append("Related: [[CULTURE]] · [[COMPANY]] · [[meetings/_index]]")
    lines.append("")

    path.write_text("\n".join(lines))
    print(f"[brief] wrote {path}")
    return path


def _format_brief_for_prompt(brief: dict[str, Any]) -> str:
    """Compact human-readable briefing for the Sonnet system prompt."""
    parts = ["═══ PRE-MEETING BRIEF ═══"]
    if brief.get("ceo_perspective"):
        parts.append("\n👔 CEO'S TAKE (the most leveraged thing right now):")
        parts.append(brief["ceo_perspective"])
    if brief.get("achievements_24h"):
        parts.append("\n✅ ACHIEVEMENTS (last 24h):")
        for a in brief["achievements_24h"]:
            parts.append(f"  • {a}")
    pc = brief.get("pending_counts", {})
    if pc:
        parts.append(f"\n⏳ PENDING: {pc.get('in_progress',0)} in_progress, {pc.get('in_review',0)} in_review, {pc.get('todo',0)} todo, {pc.get('published-ready',0)} ready-to-publish")
    tp = brief.get("pending_top_5_by_assignee", {})
    if tp:
        parts.append("\n  By assignee:")
        for ag, items in list(tp.items())[:8]:
            parts.append(f"    {ag}:")
            for it in items:
                parts.append(f"      - {it}")
    if brief.get("blockers_count", 0) > 0:
        parts.append(f"\n⚠️ BLOCKERS ({brief['blockers_count']}):")
        for b in brief.get("blockers", []):
            parts.append(f"  • [{b['assignee']}] {b['title']}")
    if brief.get("awaiting_human_count", 0) > 0:
        parts.append(f"\n🚨 AWAITING YOUR APPROVAL ({brief['awaiting_human_count']}):")
        for ah in brief.get("awaiting_human", []):
            parts.append(f"  • {ah['title']}")
    fu = brief.get("last_meeting_action_items_followup") or []
    if fu:
        parts.append("\n📅 LAST MEETING — action item follow-up:")
        for f in fu[:6]:
            parts.append(f"  • '{f['from_last_meeting'][:80]}' (assigned: {f['assigned_to']})")
            parts.append(f"    └─ Current: {f['current_status']}")
    questions = brief.get("questions_for_human") or []
    if questions:
        parts.append(f"\n❓ QUESTIONS FOR VARDAAN ({len(questions)}):")
        for q in questions[:5]:
            parts.append(f"  • [{q['kind']}] {q['ask']}")
    return "\n".join(parts)


async def _generate_proactive_opening(state: MeetingState) -> str:
    """Compose a stand-up-style opening grounded in live ticket state + vault."""
    if not ANTHROPIC_API_KEY:
        return "Good morning Vardaan. I'm in the meeting and ready to take notes. What would you like to focus on?"
    try:
        from anthropic import AsyncAnthropic  # type: ignore
        client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
        ctx = state.__dict__.get("_org_context") or {}

        system = f"""You are the Koenig AI Academy meeting bot ("George" voice — composed British male, Jarvis-style butler/consultant tone). You've just joined a meeting with Vardaan Koenig (founder of Koenig Solutions, running Koenig AI Academy at academy.kspl.tech).

You are about to deliver an OPENING STAND-UP. Your job: orient Vardaan on the actual current state of his org (NOT a generic greeting) and ask ONE useful question.

ABSOLUTE RULES:
- Spoken aloud, conversational sentences (not bullet lists, not markdown).
- ≤55 seconds when read at 170 wpm — that's roughly 130 words MAX.
- Reference SPECIFIC concrete items from the live context below (ticket titles, blog slugs, agents, blockers). Names + numbers + dates.
- Tone: British, composed, slightly understated, calm authority. Like Jarvis but operationally focused. Address as "sir" once at most, otherwise use "Vardaan".
- Structure: (a) greet + 1-sentence acknowledgement of last meeting if any; (b) 2-3 sentences on what's actually in flight or blocked RIGHT NOW per the ticket list; (c) one specific question that helps unblock the next move.

DO NOT:
- Say "great to see you" / "hope you're well" / generic warmth.
- Recite the org chart back.
- Mention "MCP" or "Agent SDK" unless it's actually in today's tickets.
- List more than 3 items.
- Apologise for anything.

═══════════════════════════════════════════════════════════
PRE-MEETING BRIEFING (the structured digest you must base your opening on):
═══════════════════════════════════════════════════════════

{_format_brief_for_prompt(state.__dict__.get("_pre_meeting_brief", {}))}

═══════════════════════════════════════════════════════════
ADDITIONAL CONTEXT (for deeper grounding if needed):
═══════════════════════════════════════════════════════════

{_format_org_context(ctx, max_chars=8000)}

═══════════════════════════════════════════════════════════

Anti-hallucination rules:
- ONLY mention specific items that appear in the briefing above. Do NOT invent ticket titles, blog slugs, or status states.
- If the briefing has no achievements yet, acknowledge it: "The team hasn't logged anything since yesterday's wrap."
- If there are no pending items, say so honestly.
- Do NOT pad with generic phrasing.

Output ONLY the spoken text — no preamble, no markdown, no SSML. The text will go directly to TTS."""
        resp = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=400,
            system=system,
            messages=[{"role": "user", "content": "Generate the stand-up opening now."}],
        )
        text = "".join(b.text for b in resp.content if hasattr(b, "text")).strip()
        # Strip any quotation marks the model might have wrapped around
        if text.startswith('"') and text.endswith('"'):
            text = text[1:-1].strip()
        return text or "Good morning Vardaan. I'm in the meeting. What would you like to focus on?"
    except Exception as e:
        print(f"[proactive] opening generation failed: {e}")
        return "Good morning Vardaan. I'm online. What would you like to focus on first?"


async def _proactive_opening_task(bot_id: str, delay_s: int) -> None:
    """Background task: wait, generate opening, synthesize, inject."""
    import asyncio
    await asyncio.sleep(delay_s)
    state = _meetings.get(bot_id)
    if not state:
        return
    try:
        text = await _generate_proactive_opening(state)
        mp3, provider = await synthesize(text)
        await recall_inject_audio(bot_id, mp3)
        state.bot_interventions.append({
            "ts": time.time(),
            "text": text,
            "reason": "proactive-opening",
            "tts_provider": provider,
        })
        print(f"[proactive] opened via {provider}: {text[:80]}...")
    except Exception as e:
        print(f"[proactive] opening failed: {e}")


async def _poll_bot_status(bot_id: str) -> None:
    """Background poller: checks Recall every 15s for bot lifecycle.
    Two responsibilities:
      1. **Greet on admit** — when the bot transitions from waiting_room → in_call,
         post a one-time chat greeting telling participants the wake words and
         that the bot is now ready. This is review-style + non-intrusive.
      2. **Auto-finalize on call-end** — when bot reaches done/call_ended, write
         vault summary + create Paperclip child tickets + dispatch follow-up.
    """
    in_call_codes = {"in_call_recording", "in_call_not_recording"}
    terminal_codes = {"call_ended", "done", "fatal", "recording_done"}
    greeted = False
    while True:
        await asyncio.sleep(15)
        state = _meetings.get(bot_id)
        if not state:
            return
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.get(
                    f"{RECALL_BASE}/bot/{bot_id}/",
                    headers={"Authorization": f"Token {RECALL_API_KEY}"},
                )
                if resp.status_code != 200:
                    continue
                data = resp.json()
                changes = data.get("status_changes") or []
                # Greet on first detection of in_call status. One-shot.
                if not greeted and any(c.get("code") in in_call_codes for c in changes):
                    greeted = True
                    greeting = (
                        "👋 Hi all — Ronald (the Koenig AI Academy meeting bot) is now in the call. "
                        "How to talk to me:\n"
                        "• Say my name to wake me — I respond to: Ronald, Donald, Roland, Reynold, "
                        "Renault, Nova, hey bot, hey claude, or just \"bot\".\n"
                        "• Ask anything about the org, vault, current tickets, or recent decisions — "
                        "I have access to live context.\n"
                        "• I'll mirror anything I say into this chat so you can review it later.\n"
                        "• I'll also post a structured summary at the end of the meeting."
                    )
                    asyncio.create_task(recall_send_chat(bot_id, greeting))
                terminal = next((c for c in changes if c.get("code") in terminal_codes), None)
                if terminal:
                    print(f"[poller] bot {bot_id} reached terminal status: {terminal['code']}")
                    await _finalize_meeting(bot_id, reason=terminal["code"])
                    return
        except Exception as e:
            print(f"[poller] error: {e}")
            continue


# Module-level agent slug → uuid cache (refreshed lazily)
_AGENTS_BY_SLUG: dict[str, str] | None = None


async def _resolve_agent_id(slug: str) -> str | None:
    """Look up Paperclip agent UUID by urlKey slug. Cached for the process lifetime
    (meeting-attendee restarts will refresh it). Returns None if unresolvable."""
    global _AGENTS_BY_SLUG
    if not slug:
        return None
    if _AGENTS_BY_SLUG is None:
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                r = await client.get(f"{PAPERCLIP_URL}/api/companies/{COMPANY_ID}/agents")
                data = r.json()
                agents = data if isinstance(data, list) else data.get("items", [])
                _AGENTS_BY_SLUG = {a.get("urlKey") or a.get("slug") or "": a.get("id") for a in agents}
                _AGENTS_BY_SLUG = {k: v for k, v in _AGENTS_BY_SLUG.items() if k and v}
                print(f"[agents] resolved {len(_AGENTS_BY_SLUG)} agent slugs")
        except Exception as e:
            print(f"[agents] failed to load roster: {e}")
            _AGENTS_BY_SLUG = {}
    return _AGENTS_BY_SLUG.get(slug)


async def _wake_agent(agent_id: str, context: dict | None = None) -> None:
    """Fire a heartbeat for an agent so they pick up the new ticket NOW
    (instead of waiting for the next cron tick)."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{PAPERCLIP_URL}/api/agents/{agent_id}/heartbeat/invoke",
                json={"context": context or {}},
            )
            print(f"[wake] kicked agent {agent_id}")
    except Exception as e:
        print(f"[wake] failed to wake {agent_id}: {e}")


async def _finalize_meeting(bot_id: str, reason: str = "manual") -> dict[str, Any]:
    """Common finalization: write vault summary, create Paperclip child tickets,
    dispatch a follow-up ticket to @meeting-follower for email-followup skill."""
    state = _meetings.get(bot_id)
    if not state:
        return {"status": "unknown-meeting"}
    if state.__dict__.get("_finalized"):
        return {"status": "already-finalized"}
    state.__dict__["_finalized"] = True

    duration_min = round((time.time() - state.started_at) / 60, 1)
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    slug = f"{date_str}-meeting-{bot_id[:8]}"

    if state.confidential:
        audit_dir = Path(VAULT_ROOT) / "meetings" / "_audit"
        audit_dir.mkdir(parents=True, exist_ok=True)
        (audit_dir / f"{slug}-confidential.md").write_text(
            f"# Confidential meeting (no transcript)\n\nAttended at {date_str}, {duration_min} min. "
            f"Confidentiality keyword detected; no transcript or summary produced per CULTURE.md privacy policy.\n"
        )
        return {"status": "confidential", "audit_path": f"vault/meetings/_audit/{slug}-confidential.md"}

    # Write the meeting summary
    meetings_dir = Path(VAULT_ROOT) / "meetings"
    meetings_dir.mkdir(parents=True, exist_ok=True)
    summary_path = meetings_dir / f"{slug}.md"

    fm_lines = [
        "---",
        f"date: {date_str}",
        f"duration_min: {duration_min}",
        f"meeting_type: general",
        f"finalize_reason: {reason}",
        f"decisions_count: {len(state.decisions)}",
        f"action_items_count: {len(state.action_items)}",
        f"key_quotes_count: {len(state.key_quotes)}",
        f"bot_interventions_count: {len(state.bot_interventions)}",
        f"transcript_lines_captured: {len(state.transcript_buffer)}",
        f"confidential: false",
        "---",
        "",
        f"# Meeting — {date_str} (~{duration_min} min)",
        "",
        "## Decisions",
    ]
    fm_lines.extend(f"- {d}" for d in state.decisions) if state.decisions else fm_lines.append("- (none)")
    fm_lines.extend(["", "## Action items"])
    if state.action_items:
        for ai in state.action_items:
            fm_lines.append(f"- → @{ai['proposed_assignee']}: {ai['description']}")
    else:
        fm_lines.append("- (none)")
    fm_lines.extend(["", "## Key quotes"])
    if state.key_quotes:
        for kq in state.key_quotes:
            fm_lines.append(f"- *{kq.get('speaker','?')}*: \"{kq.get('text','')}\"")
    else:
        fm_lines.append("- (none)")
    fm_lines.extend(["", "## Bot interventions"])
    if state.bot_interventions:
        for bi in state.bot_interventions:
            fm_lines.append(f"- *{bi.get('reason','?')}* — \"{bi.get('text','')}\"")
    else:
        fm_lines.append("- (none)")

    # Append a transcript appendix so Vardaan can read everything back in Obsidian
    fm_lines.extend(["", "## 📜 Transcript (full capture)", ""])
    if state.transcript_buffer:
        for line in state.transcript_buffer:
            spk = line.get("speaker", "?")
            txt = line.get("text", "")
            ts = line.get("ts", "?")
            fm_lines.append(f"- *{spk}* ({ts}): {txt}")
    else:
        fm_lines.append("- _(no transcript captured — Teams captions may not have been enabled)_")

    fm_lines.extend([
        "",
        "---",
        "",
        f"Pre-meeting brief: [[{Path(VAULT_ROOT).name}/meetings/{date_str}-meeting-{bot_id[:8]}-brief]]",
        f"Related: [[CULTURE]] · [[COMPANY]] · [[meetings/_index]]",
        "",
    ])

    summary_path.write_text("\n".join(fm_lines))

    # Create Paperclip child tickets for each action item — directly assigned + woken.
    created_tickets = []
    woken_agents = set()
    async with httpx.AsyncClient(timeout=15.0) as client:
        for ai in state.action_items:
            try:
                slug = (ai.get("proposed_assignee") or "").strip()
                agent_id = await _resolve_agent_id(slug) if slug else None
                payload = {
                    "title": ai["description"][:80],
                    "description": (
                        f"Source: meeting-attendee · vault: {summary_path}\n\n"
                        f"Speaker: {ai.get('speaker', 'unknown')}\n"
                        f"Timestamp: {ai.get('ts', '')}\n"
                        f"Proposed assignee: @{slug or 'unassigned'}\n\n"
                        f"{ai['description']}"
                    ),
                    "status": "todo" if agent_id else "backlog",
                    "metadata": {
                        "source": "meeting-attendee",
                        "meeting_vault_path": str(summary_path),
                        "proposed_assignee": slug,
                    },
                }
                if agent_id:
                    payload["assigneeAgentId"] = agent_id
                resp = await client.post(
                    f"{PAPERCLIP_URL}/api/companies/{COMPANY_ID}/issues",
                    json=payload,
                )
                if resp.status_code < 300:
                    created = resp.json()
                    created_tickets.append(created.get("id"))
                    # Wake the chief immediately so they pick it up in real-time
                    if agent_id and agent_id not in woken_agents:
                        await _wake_agent(agent_id, {
                            "trigger": "meeting-attendee",
                            "meeting_vault_path": str(summary_path),
                            "ticket_id": created.get("id"),
                            "ticket_identifier": created.get("identifier"),
                        })
                        woken_agents.add(agent_id)
            except Exception as e:
                print(f"[finalize] ticket create failed: {e}")
                continue

        # Dispatch a follow-up ticket to @meeting-follower — also assigned + woken.
        followup_ticket_id = None
        if state.action_items or state.decisions:
            try:
                follower_id = await _resolve_agent_id("meeting-follower")
                payload = {
                    "title": f"Email follow-up for meeting {date_str}",
                    "description": (
                        f"Source: meeting-attendee\n"
                        f"Meeting vault path: {summary_path}\n"
                        f"Action items: {len(state.action_items)}\n"
                        f"Decisions: {len(state.decisions)}\n\n"
                        f"meeting-follower: read the summary, look up attendees in vault/people/, "
                        f"draft personalised follow-up emails, send via Resend, create reply-tracking tickets."
                    ),
                    "status": "todo" if follower_id else "backlog",
                    "metadata": {
                        "source": "meeting-attendee",
                        "meeting_vault_path": str(summary_path),
                        "child_ticket_ids": created_tickets,
                        "skill": "email-followup",
                    },
                }
                if follower_id:
                    payload["assigneeAgentId"] = follower_id
                resp = await client.post(
                    f"{PAPERCLIP_URL}/api/companies/{COMPANY_ID}/issues",
                    json=payload,
                )
                if resp.status_code < 300:
                    followup_ticket_id = resp.json().get("id")
                    if follower_id:
                        await _wake_agent(follower_id, {
                            "trigger": "meeting-attendee",
                            "meeting_vault_path": str(summary_path),
                        })
            except Exception as e:
                print(f"[finalize] follow-up dispatch failed: {e}")

        # ALSO wake the triage agent so it can re-check the queue and route
        # any backlog items the meeting bot couldn't auto-assign (fallback layer).
        try:
            triage_id = await _resolve_agent_id("triage-agent") or await _resolve_agent_id("triage")
            if triage_id:
                await _wake_agent(triage_id, {
                    "trigger": "meeting-attendee-finalize",
                    "meeting_vault_path": str(summary_path),
                    "tickets_created": created_tickets,
                })
        except Exception as e:
            print(f"[finalize] triage wake failed: {e}")

    # Tell Recall the bot can leave (idempotent if already gone)
    try:
        await recall_leave(state.bot_id)
    except Exception:
        pass

    return {
        "status": "complete",
        "summary_path": str(summary_path),
        "child_tickets": created_tickets,
        "followup_ticket_id": followup_ticket_id,
        "duration_min": duration_min,
        "reason": reason,
    }


@app.post("/meetings")
async def start_meeting(req: StartMeetingRequest) -> dict[str, Any]:
    import asyncio
    bot = await recall_create_bot(req.teams_url)
    bot_id = bot["id"]
    state = MeetingState(
        meeting_id=bot_id,
        bot_id=bot_id,
        teams_url=req.teams_url,
        started_at=time.time(),
    )
    state.__dict__["_org_context"] = load_org_context()
    # Pre-meeting briefing: gather what's done / pending / stuck / awaiting-input,
    # plus follow-up status on every action item from the last meeting,
    # plus a CEO-level priority statement (Sonnet acting as CEO).
    brief = await build_pre_meeting_brief_async(state.__dict__["_org_context"])
    state.__dict__["_pre_meeting_brief"] = brief
    _meetings[bot_id] = state

    # Write the brief to the Obsidian vault so Vardaan can see it BEFORE/DURING the meeting.
    try:
        _write_brief_to_vault(bot_id, state, brief)
    except Exception as e:
        print(f"[brief] vault write failed: {e}")

    if req.proactive_mode:
        asyncio.create_task(_proactive_opening_task(bot_id, req.proactive_delay_s or 12))

    # Auto-finalize poller — runs in background, detects when Recall reports
    # the bot has reached a terminal state, and finalizes (writes summary + tickets).
    asyncio.create_task(_poll_bot_status(bot_id))

    return {
        "meeting_id": bot_id,
        "bot_id": bot_id,
        "status": "joining",
        "context_loaded": bool(state.__dict__["_org_context"].get("company_md")),
        "tickets_in_context": sum(len(v) for v in (state.__dict__["_org_context"].get("paperclip_tickets") or {}).values()),
        "proactive_mode": bool(req.proactive_mode),
    }


@app.post("/meetings/{meeting_id}/finalize")
async def finalize_meeting(meeting_id: str) -> dict[str, Any]:
    """Manual override: force-finalize a meeting now (skip waiting for poller)."""
    return await _finalize_meeting(meeting_id, reason="manual")


class SpeakRequest(BaseModel):
    text: str


@app.post("/meetings/{meeting_id}/speak")
async def admin_speak(meeting_id: str, req: SpeakRequest) -> dict[str, Any]:
    """Admin-only: synthesize + inject arbitrary text into a live meeting.
    Useful for testing the TTS pipeline without waiting for a Sonnet decision.
    Mirrors the spoken text into the meeting chat panel (best-effort)."""
    state = _meetings.get(meeting_id)
    if not state:
        raise HTTPException(404, "unknown meeting")
    mp3, provider = await synthesize(req.text)
    await recall_inject_audio(state.bot_id, mp3)
    asyncio.create_task(recall_send_chat(state.bot_id, req.text))
    state.bot_interventions.append({
        "ts": time.time(),
        "text": req.text,
        "reason": "admin-speak",
        "tts_provider": provider,
    })
    return {"status": "spoken", "provider": provider, "bytes": len(mp3)}


class ChatRequest(BaseModel):
    message: str
    to: str | None = "everyone"


@app.post("/meetings/{meeting_id}/chat")
async def admin_chat(meeting_id: str, req: ChatRequest) -> dict[str, Any]:
    """Admin-only: post a chat message in the meeting WITHOUT speaking.
    Useful for posting status updates, links, or transcripts of decisions
    without interrupting the audio."""
    state = _meetings.get(meeting_id)
    if not state:
        raise HTTPException(404, "unknown meeting")
    ok = await recall_send_chat(state.bot_id, req.message, to=req.to or "everyone")
    return {"status": "sent" if ok else "failed", "message": req.message[:200]}


class TTSTestRequest(BaseModel):
    text: str
    provider: str | None = None  # "cartesia" | "openai" | "kokoro" | None=auto


@app.post("/tts/test")
async def tts_test(req: TTSTestRequest) -> Any:
    """Smoke-test the TTS pipeline. Returns mp3 binary if successful."""
    from fastapi.responses import Response
    if req.provider == "cartesia":
        mp3 = await cartesia_tts(req.text); provider = "cartesia"
    elif req.provider == "openai":
        mp3 = await openai_tts(req.text); provider = "openai"
    elif req.provider == "kokoro":
        mp3 = await kokoro_tts(req.text); provider = "kokoro"
    else:
        mp3, provider = await synthesize(req.text)
    return Response(
        content=mp3,
        media_type="audio/mpeg",
        headers={"X-TTS-Provider": provider, "X-TTS-Bytes": str(len(mp3))},
    )


def _extract_bot_id(payload: dict[str, Any]) -> str | None:
    """Recall webhook payload nests bot id in different places depending on event.
    Try the common shapes."""
    return (
        payload.get("bot_id")
        or (payload.get("data", {}) or {}).get("bot", {}).get("id")
        or (payload.get("data", {}) or {}).get("bot_id")
        or payload.get("bot", {}).get("id")
    )


def _extract_utterance(payload: dict[str, Any]) -> tuple[str, str, float]:
    """Pull (text, speaker, ts) from a Recall transcript.data webhook.
    The 2026 schema nests the words array under data.data.words[].text."""
    data = payload.get("data", {}) or {}
    inner = data.get("data", {}) if isinstance(data.get("data"), dict) else {}
    # Words list — concatenate text
    words = inner.get("words") or []
    if words:
        text = " ".join(w.get("text", "") for w in words if w.get("text")).strip()
    else:
        text = data.get("text") or payload.get("text") or ""
    # Speaker
    participant = inner.get("participant", {}) or data.get("participant", {}) or {}
    speaker = participant.get("name") or participant.get("id") or payload.get("speaker", "unknown")
    # Timestamp (s since epoch; Recall sends ISO or ms)
    ts_raw = inner.get("timestamp") or data.get("timestamp") or payload.get("timestamp")
    try:
        if isinstance(ts_raw, (int, float)):
            ts = float(ts_raw) if ts_raw < 1e12 else ts_raw / 1000
        elif isinstance(ts_raw, str):
            from datetime import datetime as _dt
            ts = _dt.fromisoformat(ts_raw.replace("Z", "+00:00")).timestamp()
        else:
            ts = time.time()
    except Exception:
        ts = time.time()
    return text, speaker, ts


def _extract_is_final(payload: dict[str, Any]) -> bool:
    """Recall transcript webhooks emit both partial (`transcript.partial_data`)
    and final (`transcript.data`) events. Partials fire 5–50× per utterance as
    the ASR refines its hypothesis. Only finals should drive LLM calls.

    Heuristics (in order):
    - event field literally says ".partial_data" → False
    - event field literally says ".data" → True
    - inner payload has explicit is_final flag → use it
    - default to True (treat unknown events as final to avoid silent drops)
    """
    event = (payload.get("event") or "").lower()
    if event.endswith(".partial_data") or "partial" in event:
        return False
    if event.endswith(".data"):
        return True
    data = payload.get("data", {}) or {}
    inner = data.get("data", {}) if isinstance(data.get("data"), dict) else {}
    for src in (inner, data, payload):
        if isinstance(src, dict) and "is_final" in src:
            return bool(src.get("is_final"))
    return True


# Webhook idempotency cache — Recall + Svix retries can deliver the same
# webhook up to 60×; store svix-id keys with a 60s TTL.
_SEEN_WEBHOOKS: dict[str, float] = {}
_SEEN_WEBHOOKS_TTL_S = 60.0


def _is_duplicate_webhook(svix_id: str | None, now: float) -> bool:
    if not svix_id:
        return False
    # Drop expired entries cheaply (small set; runs ~once/sec when busy).
    if len(_SEEN_WEBHOOKS) > 256:
        cutoff = now - _SEEN_WEBHOOKS_TTL_S
        for k in [k for k, t in _SEEN_WEBHOOKS.items() if t < cutoff]:
            _SEEN_WEBHOOKS.pop(k, None)
    last = _SEEN_WEBHOOKS.get(svix_id)
    if last and (now - last) < _SEEN_WEBHOOKS_TTL_S:
        return True
    _SEEN_WEBHOOKS[svix_id] = now
    return False


# Bot-is-speaking lock window. While the bot is mid-utterance, we suppress
# auto-speak from `decide()` so we don't talk over ourselves. The window is
# short by design — long enough to cover Cartesia/OpenAI mp3 generation +
# Recall.ai ingress + a few seconds of typical reply audio, but shorter than
# the prior 30s cooldown so the bot stays responsive.
BOT_SPEAKING_LOCK_S = 6.0
BARGE_IN_RESET_S = 1.5  # if a non-bot utterance arrives this long after we
                        # spoke, treat it as user-resumed and end the lock


@app.post("/webhook/transcript")
async def transcript(request: Request) -> dict[str, Any]:
    body = await request.body()
    if not _verify_recall_signature(body, request.headers):
        raise HTTPException(401, "invalid webhook signature")

    # Svix-id idempotency dedup (cheapest gate; covers retry storm) ──────────
    svix_id = request.headers.get("svix-id") or request.headers.get("Svix-Id")
    now = time.time()
    if _is_duplicate_webhook(svix_id, now):
        return {"status": "duplicate-webhook-id"}

    payload = json.loads(body)
    bot_id = _extract_bot_id(payload)
    state = _meetings.get(bot_id) if bot_id else None
    if not state:
        # Log + 200 so Recall doesn't retry forever
        print(f"[webhook] unknown bot {bot_id} (event={payload.get('event','?')}); dropping")
        return {"status": "unknown-bot", "bot_id": bot_id}

    utterance, speaker, ts = _extract_utterance(payload)
    if not utterance.strip():
        return {"status": "empty-utterance"}

    # Skip partial transcripts — only finals drive LLM decisions. ────────────
    # Recall emits ~5-50 partial_data per utterance; processing each one was
    # the dominant Sonnet/Haiku cost driver. Buffer partials for context but
    # do not call decide().
    is_final = _extract_is_final(payload)
    if not is_final:
        state.transcript_buffer.append({
            "ts": ts, "speaker": speaker, "text": utterance, "partial": True,
        })
        return {"status": "partial-buffered"}

    # Content-hash dedup as belt-and-braces (handles cases where the same
    # final fires twice with different svix-ids — rare but observed). ────────
    import hashlib as _hashlib
    utt_hash = _hashlib.md5(
        f"{(speaker or '').lower().strip()}|{utterance.lower().strip()}".encode("utf-8")
    ).hexdigest()
    DEDUP_WINDOW_S = 10.0
    recent_finals = [e for e in state.transcript_buffer[-15:]
                     if not e.get("partial") and (ts - e.get("ts", 0)) < DEDUP_WINDOW_S]
    if any(e.get("hash") == utt_hash for e in recent_finals):
        return {"status": "duplicate-content-skipped"}

    # Confidentiality check first
    if _is_confidential(utterance):
        state.confidential = True
        return {"status": "silent-confidential"}

    state.transcript_buffer.append({
        "ts": ts, "speaker": speaker, "text": utterance, "hash": utt_hash,
    })

    decision = await decide(state, utterance, speaker)
    action = decision["action"]
    if action == "speak":
        # Bot-speaking lock: if we spoke recently, suppress auto-speak so we
        # don't talk over our own previous reply. Wake-word ("Ronald, …") gets
        # a shorter window since the user is asking us to interrupt; default
        # gets the full BOT_SPEAKING_LOCK_S window.
        is_addressed = bool(_re.search(
            r"\b(bot|nova|ronald|donald|roland|reynold|claude|agent|hey)\b",
            utterance.lower(),
        ))
        speak_lock_s = 3.0 if is_addressed else BOT_SPEAKING_LOCK_S
        if state.bot_interventions:
            last_spoken_ts = state.bot_interventions[-1].get("ts", 0)
            elapsed = ts - last_spoken_ts
            if elapsed < speak_lock_s:
                print(f"[speak-lock] suppressed — last spoke {elapsed:.1f}s ago (< {speak_lock_s}s)")
                return {"status": "silent-speaking-lock", "elapsed_s": elapsed}
        try:
            mp3, provider = await synthesize(decision["text"])
            await recall_inject_audio(state.bot_id, mp3)
            # Mirror the spoken text into the meeting chat panel so participants
            # can scan back through what the bot said. Best-effort; chat-send
            # failures don't fail the speak path.
            asyncio.create_task(recall_send_chat(state.bot_id, decision["text"]))
            state.bot_interventions.append({
                "ts": ts,
                "text": decision["text"],
                "reason": decision.get("reason", ""),
                "tts_provider": provider,
            })
        except Exception as e:
            return {"status": "speak-failed", "error": str(e)}
    elif action == "log":
        log_kind = decision.get("log_kind", "")
        text = decision.get("text", "") or utterance
        if log_kind == "decision":
            state.decisions.append(text)
        elif log_kind == "quote":
            state.key_quotes.append({"ts": ts, "speaker": speaker, "text": text})
        else:
            state.action_items.append({
                "description": text,
                "proposed_assignee": decision.get("assignee", "ceo"),
                "ts": ts,
                "speaker": speaker,
            })

    return {"status": action}


@app.get("/meetings/{meeting_id}")
async def get_meeting(meeting_id: str) -> MeetingState:
    state = _meetings.get(meeting_id)
    if not state:
        raise HTTPException(404, "unknown meeting")
    return state


@app.get("/meetings/{meeting_id}/brief")
async def get_brief(meeting_id: str) -> dict[str, Any]:
    """Return the pre-meeting briefing for inspection before/during a meeting."""
    state = _meetings.get(meeting_id)
    if not state:
        raise HTTPException(404, "unknown meeting")
    return state.__dict__.get("_pre_meeting_brief", {"status": "not-yet-generated"})
