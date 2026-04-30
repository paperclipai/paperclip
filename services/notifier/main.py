"""
Koenig Telegram notifier — single-user bot bridging Paperclip events to a
mobile-friendly chat. Runs as a small FastAPI service that:

1. Polls Paperclip's /api/companies/{cid}/issues every TICK_SECONDS
2. Detects state-deltas (new tickets, status changes, blocks, completions, fails)
3. Pushes formatted messages to a Telegram chat via Bot API
4. Listens for inbound /status, /blocked, /done, /cancel, /priority, /pause,
   /resume, /wake, /note commands from the user

Environment (read from .env.koenig in compose):
- TELEGRAM_BOT_TOKEN          — from @BotFather
- TELEGRAM_CHAT_ID            — your numeric chat id (call /start, then /api)
- PAPERCLIP_BASE_URL          — default http://host.docker.internal:3100
- PAPERCLIP_BOARD_TOKEN       — pcb_... bearer token (board API key)
- KOENIG_COMPANY_ID           — defaults to active learnova-academy id
- NOTIFIER_TICK_SECONDS       — default 30
- NOTIFIER_DAILY_DIGEST_HOUR  — default 9 (09:00 IST)

Spec for output messages:
- ▶️ Started, ✅ Shipped, 🚫 Blocked, ❌ Failed, 🎯 MEETING ACTION (high-prio
  pinned), 🎙 Meeting wrap, 💸 Spend alert.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("koenig-notifier")

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
PAPERCLIP_BASE_URL = os.getenv("PAPERCLIP_BASE_URL", "http://host.docker.internal:3100").rstrip("/")
PAPERCLIP_BOARD_TOKEN = os.getenv("PAPERCLIP_BOARD_TOKEN", "").strip()
COMPANY_ID = os.getenv("KOENIG_COMPANY_ID", "2a77f89b-33f0-4133-a20c-77ddaac5e744")
TICK_SECONDS = int(os.getenv("NOTIFIER_TICK_SECONDS", "30"))
DAILY_DIGEST_HOUR_IST = int(os.getenv("NOTIFIER_DAILY_DIGEST_HOUR", "9"))
STATE_DIR = Path(os.getenv("NOTIFIER_STATE_DIR", "/var/lib/koenig-notifier"))
STATE_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = STATE_DIR / "state.json"

TG_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}" if TELEGRAM_BOT_TOKEN else None

app = FastAPI(title="Koenig Telegram Notifier", version="0.1.0")


@dataclass
class TicketSnapshot:
    identifier: str
    title: str
    status: str
    assignee_slug: str | None
    publish_state: str | None
    parent_identifier: str | None
    is_meeting_mandate: bool

    @classmethod
    def from_api(cls, t: dict[str, Any]) -> "TicketSnapshot":
        ag = t.get("assigneeAgent") or {}
        md = t.get("metadata") or {}
        labels = [l.get("name") or l.get("slug") for l in (t.get("labels") or [])]
        return cls(
            identifier=t.get("identifier", "?"),
            title=(t.get("title") or "")[:120],
            status=t.get("status", "?"),
            assignee_slug=ag.get("urlKey") or ag.get("slug"),
            publish_state=md.get("publish_state"),
            parent_identifier=(t.get("parent") or {}).get("identifier") if t.get("parent") else None,
            is_meeting_mandate="meeting-mandate" in labels or md.get("source") == "meeting-attendee",
        )


def load_state() -> dict[str, Any]:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            log.warning("state file corrupt; starting fresh")
    return {"tickets": {}, "last_digest_date": None}


def save_state(state: dict[str, Any]) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2))


async def tg_send(text: str, *, parse_mode: str = "Markdown", disable_preview: bool = True) -> None:
    if not TG_API or not TELEGRAM_CHAT_ID:
        log.info("TELEGRAM_BOT_TOKEN/CHAT_ID not set; would have sent: %s", text[:200])
        return
    async with httpx.AsyncClient(timeout=10) as c:
        try:
            r = await c.post(
                f"{TG_API}/sendMessage",
                json={
                    "chat_id": TELEGRAM_CHAT_ID,
                    "text": text,
                    "parse_mode": parse_mode,
                    "disable_web_page_preview": disable_preview,
                },
            )
            if r.status_code != 200:
                log.warning("telegram send %s: %s", r.status_code, r.text[:300])
        except Exception as e:
            log.exception("telegram send failed: %s", e)


async def paperclip_fetch_issues(status: str | None = None) -> list[dict[str, Any]]:
    headers = {"Authorization": f"Bearer {PAPERCLIP_BOARD_TOKEN}"} if PAPERCLIP_BOARD_TOKEN else {}
    url = f"{PAPERCLIP_BASE_URL}/api/companies/{COMPANY_ID}/issues"
    params = {"limit": 200}
    if status:
        params["status"] = status
    async with httpx.AsyncClient(timeout=15) as c:
        try:
            r = await c.get(url, params=params, headers=headers)
            if r.status_code != 200:
                log.warning("paperclip fetch %s: %s", r.status_code, r.text[:200])
                return []
            data = r.json()
            return data if isinstance(data, list) else (data.get("issues") or [])
        except Exception as e:
            log.exception("paperclip fetch failed: %s", e)
            return []


async def paperclip_patch_issue(identifier_or_id: str, body: dict[str, Any]) -> dict[str, Any] | None:
    headers = {
        "Authorization": f"Bearer {PAPERCLIP_BOARD_TOKEN}",
        "Content-Type": "application/json",
    } if PAPERCLIP_BOARD_TOKEN else {"Content-Type": "application/json"}
    url = f"{PAPERCLIP_BASE_URL}/api/issues/{identifier_or_id}"
    async with httpx.AsyncClient(timeout=10) as c:
        try:
            r = await c.patch(url, json=body, headers=headers)
            if r.status_code >= 400:
                log.warning("paperclip patch %s: %s", r.status_code, r.text[:200])
                return None
            return r.json()
        except Exception as e:
            log.exception("paperclip patch failed: %s", e)
            return None


def format_ticket_event(kind: str, prev: TicketSnapshot | None, cur: TicketSnapshot) -> str:
    prefix = {
        "created": "📋 New",
        "started": "▶️ Started",
        "blocked": "🚫 Blocked",
        "failed": "❌ FAILED",
        "shipped": "✅ Shipped",
        "done": "🏁 Done",
        "g4_needed": "⚠️ APPROVAL",
    }.get(kind, "🔔")
    if cur.is_meeting_mandate:
        prefix = "🎯 MEETING ACTION"
    title = cur.title
    asg = f" · {cur.assignee_slug}" if cur.assignee_slug else ""
    return f"{prefix}: *[{cur.identifier}]* {title}{asg}"


async def detect_and_emit(state: dict[str, Any]) -> None:
    issues = await paperclip_fetch_issues()
    if not issues:
        return
    snapshots = {t["identifier"]: TicketSnapshot.from_api(t) for t in issues}
    prior = state.get("tickets", {})
    events: list[tuple[str, TicketSnapshot | None, TicketSnapshot]] = []

    for ident, snap in snapshots.items():
        old_d = prior.get(ident)
        old = TicketSnapshot(**old_d) if old_d else None
        if old is None:
            events.append(("created", None, snap))
        elif old.status != snap.status:
            kind = {
                "in_progress": "started",
                "blocked": "blocked",
                "done": "done",
                "cancelled": "done",
            }.get(snap.status, "started")
            events.append((kind, old, snap))
        elif old.publish_state != snap.publish_state and snap.publish_state == "ready":
            events.append(("shipped", old, snap))

    for kind, prev, cur in events:
        await tg_send(format_ticket_event(kind, prev, cur))

    state["tickets"] = {k: v.__dict__ for k, v in snapshots.items()}
    save_state(state)


async def daily_digest(state: dict[str, Any]) -> None:
    """Send a 09:00 IST digest pinging open meeting-mandate tickets + queue summary."""
    now = datetime.now(timezone.utc)
    today_key = now.date().isoformat()
    if state.get("last_digest_date") == today_key:
        return
    # IST = UTC+5:30
    ist_hour = (now.hour + 5 + (1 if now.minute >= 30 else 0)) % 24
    if ist_hour != DAILY_DIGEST_HOUR_IST:
        return
    issues = await paperclip_fetch_issues()
    by_status: dict[str, int] = {}
    meeting_mandate: list[TicketSnapshot] = []
    for t in issues:
        s = t.get("status", "?")
        by_status[s] = by_status.get(s, 0) + 1
        snap = TicketSnapshot.from_api(t)
        if snap.is_meeting_mandate and snap.status not in ("done", "cancelled"):
            meeting_mandate.append(snap)
    lines = [f"☀️ *Daily digest — {today_key}*", ""]
    lines.append(f"Queue: " + " · ".join(f"{k}={v}" for k, v in sorted(by_status.items())))
    if meeting_mandate:
        lines.append("")
        lines.append("*Open meeting mandates:*")
        for m in meeting_mandate[:10]:
            lines.append(f"  • [{m.identifier}] {m.title} · {m.status}")
    lines.append("")
    lines.append("Reply with a command: /status /blocked /queue /cancel KOE-X /priority KOE-X high /pause /resume")
    await tg_send("\n".join(lines))
    state["last_digest_date"] = today_key
    save_state(state)


async def poll_loop() -> None:
    log.info(
        "Notifier started — paperclip=%s company=%s tick=%ss telegram=%s",
        PAPERCLIP_BASE_URL,
        COMPANY_ID,
        TICK_SECONDS,
        "configured" if TG_API else "DISABLED",
    )
    state = load_state()
    while True:
        try:
            await detect_and_emit(state)
            await daily_digest(state)
        except Exception as e:
            log.exception("poll tick failed: %s", e)
        await asyncio.sleep(TICK_SECONDS)


async def telegram_poll_loop() -> None:
    """Poll Telegram getUpdates for inbound /commands so we don't need a webhook URL."""
    if not TG_API or not TELEGRAM_CHAT_ID:
        log.info("telegram poll DISABLED (no token/chat_id)")
        return
    last_offset = 0
    log.info("telegram getUpdates poll started")
    while True:
        try:
            async with httpx.AsyncClient(timeout=35) as c:
                r = await c.get(f"{TG_API}/getUpdates", params={"offset": last_offset + 1, "timeout": 30})
                if r.status_code == 200:
                    data = r.json() or {}
                    for upd in data.get("result", []):
                        last_offset = max(last_offset, upd.get("update_id", 0))
                        msg = upd.get("message") or upd.get("edited_message") or {}
                        chat_id = str((msg.get("chat") or {}).get("id", ""))
                        if chat_id != TELEGRAM_CHAT_ID:
                            continue
                        text = (msg.get("text") or "").strip()
                        if not text.startswith("/"):
                            continue
                        # Reuse webhook handler logic by faking a request body
                        await _handle_command(text)
        except Exception as e:
            log.warning("telegram poll error: %s", e)
            await asyncio.sleep(5)
        # short pause before next long-poll
        await asyncio.sleep(1)


async def _handle_command(text: str) -> None:
    """Shared command handler used by both the webhook and the polling loop."""
    cmd, *rest = text[1:].split(maxsplit=1)
    arg = rest[0] if rest else ""
    if cmd == "status":
        issues = await paperclip_fetch_issues()
        by_status: dict[str, int] = {}
        for t in issues:
            by_status[t.get("status", "?")] = by_status.get(t.get("status", "?"), 0) + 1
        await tg_send("Queue: " + " · ".join(f"{k}={v}" for k, v in sorted(by_status.items())))
    elif cmd == "blocked":
        items = await paperclip_fetch_issues(status="blocked")
        if not items:
            await tg_send("No blocked tickets.")
        else:
            lines = [f"🚫 Blocked ({len(items)}):"]
            for t in items[:20]:
                lines.append(f"  [{t.get('identifier')}] {(t.get('title') or '')[:60]}")
            await tg_send("\n".join(lines))
    elif cmd == "queue":
        items = (await paperclip_fetch_issues(status="todo")) + (await paperclip_fetch_issues(status="in_progress"))
        lines = [f"📋 Top of queue ({len(items)}):"]
        for t in items[:15]:
            lines.append(f"  [{t.get('identifier')}] {(t.get('title') or '')[:60]} · {t.get('status')}")
        await tg_send("\n".join(lines))
    elif cmd == "cancel" and arg:
        ident = arg.strip().split()[0]
        result = await paperclip_patch_issue(ident, {"status": "cancelled"})
        await tg_send(f"{'✅ cancelled' if result else '❌ failed to cancel'} {ident}")
    elif cmd == "priority" and arg:
        parts = arg.strip().split()
        if len(parts) >= 2:
            ident, level = parts[0], parts[1].lower()
            result = await paperclip_patch_issue(ident, {"priority": level})
            await tg_send(f"{'✅' if result else '❌'} {ident} → {level}")
        else:
            await tg_send("Usage: /priority KOE-X low|medium|high|urgent")
    elif cmd == "meeting" and arg:
        url = arg.strip().split()[0]
        async with httpx.AsyncClient(timeout=15) as c:
            try:
                r = await c.post("http://host.docker.internal:8200/meetings", json={"meeting_url": url, "source": "telegram"})
                if 200 <= r.status_code < 300:
                    await tg_send(f"🎙 Meeting bot dispatched → joining {url[:60]}")
                else:
                    await tg_send(f"❌ Bot dispatch failed: {r.status_code}")
            except Exception as e:
                await tg_send(f"❌ Meeting service unreachable: {e}")
    elif cmd == "task" and arg:
        title = arg.strip()
        async with httpx.AsyncClient(timeout=10) as c:
            try:
                r = await c.post(
                    f"{PAPERCLIP_BASE_URL}/api/companies/{COMPANY_ID}/issues",
                    headers={"Authorization": f"Bearer {PAPERCLIP_BOARD_TOKEN}", "Content-Type": "application/json"},
                    json={"title": title[:200], "priority": "medium", "description": f"Filed via Telegram by Vardaan.\n\n{title}"},
                )
                if 200 <= r.status_code < 300:
                    j = r.json() or {}
                    await tg_send(f"📋 Created {j.get('identifier')}: {title[:80]}")
                else:
                    await tg_send(f"❌ Failed: {r.status_code}")
            except Exception as e:
                await tg_send(f"❌ Paperclip unreachable: {e}")
    elif cmd == "help":
        await tg_send(
            "*Commands:*\n"
            "  /status — queue summary\n  /blocked — blocked tickets\n  /queue — top of todo+in_progress\n"
            "  /cancel KOE-X — cancel a ticket\n  /priority KOE-X high — set priority\n"
            "  /meeting <teams-url> — bot joins the meeting\n  /task <title> — file a Paperclip ticket\n"
            "  /help — this menu"
        )
    else:
        await tg_send(f"Unknown command: /{cmd}. Try /help.")


# ─────────────────────── Telegram inbound (webhook) ───────────────────────

@app.post("/telegram/webhook")
async def telegram_webhook(request: Request) -> dict[str, Any]:
    body = await request.json()
    msg = (body.get("message") or {})
    chat_id = str((msg.get("chat") or {}).get("id", ""))
    if chat_id != TELEGRAM_CHAT_ID:
        return {"ok": False, "reason": "chat_id mismatch"}
    text = (msg.get("text") or "").strip()
    if not text.startswith("/"):
        return {"ok": True}
    cmd, *rest = text[1:].split(maxsplit=1)
    arg = rest[0] if rest else ""

    if cmd == "status":
        issues = await paperclip_fetch_issues()
        by_status: dict[str, int] = {}
        for t in issues:
            by_status[t.get("status", "?")] = by_status.get(t.get("status", "?"), 0) + 1
        await tg_send("Queue: " + " · ".join(f"{k}={v}" for k, v in sorted(by_status.items())))
    elif cmd == "blocked":
        items = await paperclip_fetch_issues(status="blocked")
        if not items:
            await tg_send("No blocked tickets.")
        else:
            lines = [f"🚫 Blocked ({len(items)}):"]
            for t in items[:20]:
                lines.append(f"  [{t.get('identifier')}] {(t.get('title') or '')[:60]}")
            await tg_send("\n".join(lines))
    elif cmd == "queue":
        items = (await paperclip_fetch_issues(status="todo")) + (await paperclip_fetch_issues(status="in_progress"))
        lines = [f"📋 Top of queue ({len(items)}):"]
        for t in items[:15]:
            lines.append(f"  [{t.get('identifier')}] {(t.get('title') or '')[:60]} · {t.get('status')}")
        await tg_send("\n".join(lines))
    elif cmd == "cancel" and arg:
        ident = arg.strip().split()[0]
        result = await paperclip_patch_issue(ident, {"status": "cancelled"})
        await tg_send(f"{'✅ cancelled' if result else '❌ failed to cancel'} {ident}")
    elif cmd == "priority" and arg:
        parts = arg.strip().split()
        if len(parts) >= 2:
            ident, level = parts[0], parts[1].lower()
            result = await paperclip_patch_issue(ident, {"priority": level})
            await tg_send(f"{'✅ priority updated' if result else '❌ failed'} {ident} → {level}")
        else:
            await tg_send("Usage: /priority KOE-X low|medium|high|urgent")
    elif cmd == "pause":
        await tg_send("(pause/resume not yet wired; will pause all dispatch via watchdog when implemented)")
    elif cmd == "resume":
        await tg_send("(resume not yet wired)")
    elif cmd == "note" and arg:
        parts = arg.strip().split(maxsplit=1)
        if len(parts) == 2:
            ident, note_text = parts
            await tg_send(f"(note posting not yet wired; would post to {ident}: {note_text[:80]})")
        else:
            await tg_send("Usage: /note KOE-X some text")
    elif cmd == "meeting" and arg:
        # Forward Teams meeting URL to meeting-attendee FastAPI service so the bot joins.
        url = arg.strip().split()[0]
        async with httpx.AsyncClient(timeout=15) as c:
            try:
                r = await c.post(
                    "http://host.docker.internal:8200/meetings",
                    json={"meeting_url": url, "source": "telegram"},
                )
                if 200 <= r.status_code < 300:
                    bot_id = (r.json() or {}).get("bot_id", "?")
                    await tg_send(f"🎙 Meeting bot dispatched → joining {url[:60]}\n  bot_id={bot_id}")
                else:
                    await tg_send(f"❌ Failed to dispatch bot: {r.status_code}\n{r.text[:200]}")
            except Exception as e:
                await tg_send(f"❌ Meeting service unreachable: {e}")
    elif cmd == "task" and arg:
        # Quick task creation — file a ticket directly from Telegram.
        title = arg.strip()
        async with httpx.AsyncClient(timeout=10) as c:
            try:
                r = await c.post(
                    f"{PAPERCLIP_BASE_URL}/api/companies/{COMPANY_ID}/issues",
                    headers={"Authorization": f"Bearer {PAPERCLIP_BOARD_TOKEN}", "Content-Type": "application/json"},
                    json={"title": title[:200], "priority": "medium", "description": f"Filed via Telegram by Vardaan.\n\n{title}"},
                )
                if 200 <= r.status_code < 300:
                    j = r.json() or {}
                    await tg_send(f"📋 Created {j.get('identifier')}: {title[:80]}")
                else:
                    await tg_send(f"❌ Failed to create ticket: {r.status_code}")
            except Exception as e:
                await tg_send(f"❌ Paperclip unreachable: {e}")
    elif cmd == "help":
        await tg_send(
            "*Commands:*\n"
            "  /status — queue summary\n"
            "  /blocked — blocked tickets\n"
            "  /queue — top of todo+in_progress\n"
            "  /cancel KOE-X — cancel a ticket\n"
            "  /priority KOE-X high — set priority\n"
            "  /meeting <teams-url> — bot joins the meeting\n"
            "  /task <title> — file a Paperclip ticket\n"
            "  /note KOE-X text — add comment (TBD)\n"
            "  /pause /resume — toggle dispatch (TBD)\n"
            "  /help — this menu"
        )
    else:
        await tg_send(f"Unknown command: /{cmd}. Try /help.")
    return {"ok": True}


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "paperclip": PAPERCLIP_BASE_URL,
        "company_id": COMPANY_ID,
        "tick_seconds": TICK_SECONDS,
        "telegram_configured": bool(TG_API),
    }


@app.on_event("startup")
async def on_startup() -> None:
    asyncio.create_task(poll_loop())
    asyncio.create_task(telegram_poll_loop())
    log.info("startup complete (paperclip poll + telegram poll)")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8300")))
