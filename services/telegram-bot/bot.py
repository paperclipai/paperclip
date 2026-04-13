"""
Telegram bot sidecar for Paperclip.

Receives messages via polling, exposes FastAPI endpoint for sending.
Stores chat_id on /start so notifications can be pushed.
Forwards incoming messages to Paperclip API as issue comments or new issues.
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

logging.basicConfig(
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    level=os.getenv("LOG_LEVEL", "INFO"),
)
logger = logging.getLogger("telegram-bot")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
CHAT_IDS_FILE = Path(os.getenv("CHAT_IDS_FILE", "/data/chat_ids.json"))
PAPERCLIP_API_URL = os.getenv("PAPERCLIP_API_URL", "http://server:3100")
# Default company — avoids a round-trip to /api/companies on every command
PAPERCLIP_COMPANY_ID = os.getenv(
    "PAPERCLIP_COMPANY_ID", "dbc742c7-9a38-4542-936b-523dfa3a7fd2"
)
# CTO agent for /priority delegation
PAPERCLIP_CTO_AGENT_ID = os.getenv(
    "PAPERCLIP_CTO_AGENT_ID", "4e5cbf52-a530-439f-917c-a6cfee78d76d"
)
# Optional service token for Paperclip API mutations
PAPERCLIP_API_KEY = os.getenv("PAPERCLIP_API_KEY", "")
# Angel's chat_id — always whitelisted, receives access-request notifications
ANGEL_CHAT_ID = int(os.getenv("ANGEL_CHAT_ID", "1978432218"))

# ---------------------------------------------------------------------------
# Chat ID persistence
# ---------------------------------------------------------------------------
_chat_ids: set[int] = set()
# Maps chat_id -> ISO timestamp of last /deliverables call
_deliverables_cursors: dict[int, str] = {}
_DELIVERABLES_CURSORS_FILE = CHAT_IDS_FILE.parent / "deliverables_cursors.json"

# ---------------------------------------------------------------------------
# Whitelist persistence
# ---------------------------------------------------------------------------
_whitelist: set[int] = set()
_WHITELIST_FILE = CHAT_IDS_FILE.parent / "whitelist.json"


def _load_whitelist() -> None:
    global _whitelist
    if _WHITELIST_FILE.exists():
        _whitelist = set(json.loads(_WHITELIST_FILE.read_text()))
        logger.info("Loaded %d whitelisted chat_id(s) from %s", len(_whitelist), _WHITELIST_FILE)
    # Angel is always present
    _whitelist.add(ANGEL_CHAT_ID)


def _save_whitelist() -> None:
    _WHITELIST_FILE.parent.mkdir(parents=True, exist_ok=True)
    _WHITELIST_FILE.write_text(json.dumps(sorted(_whitelist)))


def is_whitelisted(chat_id: int) -> bool:
    """Return True if chat_id is Angel or explicitly whitelisted."""
    return chat_id == ANGEL_CHAT_ID or chat_id in _whitelist


def _load_chat_ids() -> None:
    global _chat_ids, _deliverables_cursors
    if CHAT_IDS_FILE.exists():
        _chat_ids = set(json.loads(CHAT_IDS_FILE.read_text()))
        logger.info("Loaded %d chat_id(s) from %s", len(_chat_ids), CHAT_IDS_FILE)
    if _DELIVERABLES_CURSORS_FILE.exists():
        _deliverables_cursors = json.loads(_DELIVERABLES_CURSORS_FILE.read_text())
        logger.info("Loaded deliverables cursors for %d chat(s)", len(_deliverables_cursors))


def _save_chat_ids() -> None:
    CHAT_IDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CHAT_IDS_FILE.write_text(json.dumps(sorted(_chat_ids)))


def _save_deliverables_cursor(chat_id: int, ts: str) -> None:
    _deliverables_cursors[str(chat_id)] = ts
    _DELIVERABLES_CURSORS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _DELIVERABLES_CURSORS_FILE.write_text(json.dumps(_deliverables_cursors))


def register_chat(chat_id: int) -> bool:
    """Register a chat_id. Returns True if it was new."""
    if chat_id in _chat_ids:
        return False
    _chat_ids.add(chat_id)
    _save_chat_ids()
    logger.info("Registered new chat_id: %d", chat_id)
    return True


# ---------------------------------------------------------------------------
# Telegram handlers
# ---------------------------------------------------------------------------
async def _notify_angel_access_request(bot, chat_id: int, username: str | None) -> None:
    """Send Angel an access-request notification."""
    uname = f"@{username}" if username else "unknown"
    await bot.send_message(
        chat_id=ANGEL_CHAT_ID,
        text=(
            f"⚠️ Access request from chat_id={chat_id} username={uname}. "
            f"Reply /approve {chat_id} or /reject {chat_id}"
        ),
    )


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    username = update.effective_user.username if update.effective_user else None
    # Always register so Angel can see who tried
    register_chat(chat_id)

    if not is_whitelisted(chat_id):
        await update.message.reply_text(
            "Access restricted. Your request has been sent to the admin for approval."
        )
        await _notify_angel_access_request(ctx.bot, chat_id, username)
        return

    await update.message.reply_text(
        f"Registered with Paperclip. chat_id={chat_id}\n"
        "You'll receive notifications here.\n\n"
        "Commands:\n"
        "/list — top 10 open issues sorted by priority\n"
        "/show ANGA-NNN — issue detail\n"
        "/deliverables — what was shipped since last check\n"
        "/priority <text> — create urgent issue (delegated immediately)\n"
        "/comment ANGA-NNN <text> — post comment\n"
        "/status — Paperclip health\n"
        "/id — show your chat_id\n\n"
        "Send any plain message to create a Paperclip issue."
    )


async def _check_whitelist(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> bool:
    """Return True if the user is allowed. If not, send restriction notices and return False."""
    chat_id = update.effective_chat.id
    if is_whitelisted(chat_id):
        return True
    username = update.effective_user.username if update.effective_user else None
    await update.message.reply_text(
        "Access restricted. Your request has been sent to the admin for approval."
    )
    await _notify_angel_access_request(ctx.bot, chat_id, username)
    return False


async def cmd_id(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _check_whitelist(update, ctx):
        return
    await update.message.reply_text(f"chat_id: {update.effective_chat.id}")


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Proxy Paperclip health check."""
    if not await _check_whitelist(update, ctx):
        return
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{PAPERCLIP_API_URL}/api/health")
            data = resp.json()
            await update.message.reply_text(f"Paperclip: {json.dumps(data, indent=2)}")
    except Exception as e:
        await update.message.reply_text(f"Paperclip unreachable: {e}")


async def cmd_issues(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """List open issues from the first company."""
    if not await _check_whitelist(update, ctx):
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Get first company
            companies_resp = await client.get(f"{PAPERCLIP_API_URL}/api/companies")
            companies = companies_resp.json()
            if not companies:
                await update.message.reply_text("No companies found.")
                return
            company_id = companies[0]["id"]

            # Get in-progress and todo issues
            issues_resp = await client.get(
                f"{PAPERCLIP_API_URL}/api/companies/{company_id}/issues",
                params={"status": "in_progress,todo"},
            )
            issues = issues_resp.json()
            if not issues.get("data"):
                await update.message.reply_text("No open issues.")
                return

            lines = [f"Open issues ({len(issues['data'])}):\n"]
            for issue in issues["data"][:15]:
                status = issue.get("status", "?")
                title = issue.get("title", "Untitled")
                identifier = issue.get("identifier", "")
                emoji = {"in_progress": "🔄", "todo": "📋"}.get(status, "•")
                lines.append(f"{emoji} [{identifier}] {title}")

            await update.message.reply_text("\n".join(lines))
    except Exception as e:
        logger.error("Failed to fetch issues: %s", e)
        await update.message.reply_text(f"Error fetching issues: {e}")


_PRIORITY_ORDER = {"critical": 0, "urgent": 1, "high": 2, "medium": 3, "low": 4}
_PRIORITY_EMOJI = {"critical": "🔴", "urgent": "🔴", "high": "🟠", "medium": "🟡", "low": "🟢"}
_STATUS_EMOJI = {"in_progress": "🔄", "todo": "📋", "blocked": "🚫", "done": "✅", "cancelled": "❌"}


async def cmd_list(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """List top 10 open issues sorted by priority."""
    if not await _check_whitelist(update, ctx):
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{PAPERCLIP_API_URL}/api/companies/{PAPERCLIP_COMPANY_ID}/issues",
            )
            all_issues = resp.json()

        # Support both array and {data:[]} shapes
        items = all_issues if isinstance(all_issues, list) else all_issues.get("data", [])
        active = [i for i in items if i.get("status") in ("in_progress", "todo", "blocked")]

        if not active:
            await update.message.reply_text("No open issues.")
            return

        # Sort by priority (critical first), then by status (in_progress before todo)
        status_rank = {"in_progress": 0, "blocked": 1, "todo": 2}
        active.sort(key=lambda i: (
            _PRIORITY_ORDER.get(i.get("priority", ""), 99),
            status_rank.get(i.get("status", ""), 99),
        ))
        top10 = active[:10]

        lines: list[str] = [f"Top {len(top10)} open issues (by priority):"]
        for issue in top10:
            pid = _PRIORITY_EMOJI.get(issue.get("priority", ""), "")
            sid = _STATUS_EMOJI.get(issue.get("status", ""), "•")
            ident = issue.get("identifier", "")
            title = issue.get("title", "Untitled")
            if len(title) > 48:
                title = title[:45] + "…"
            lines.append(f"{sid}{pid} [{ident}] {title}")

        await update.message.reply_text("\n".join(lines))
    except Exception as e:
        logger.error("cmd_list error: %s", e)
        await update.message.reply_text(f"Error: {e}")


async def _resolve_assignee(client: httpx.AsyncClient, issue: dict) -> str:
    """Return a human-readable assignee string for an issue."""
    agent_id = issue.get("assigneeAgentId")
    user_id = issue.get("assigneeUserId")
    if not agent_id and not user_id:
        return "unassigned"
    if agent_id:
        try:
            r = await client.get(
                f"{PAPERCLIP_API_URL}/api/companies/{PAPERCLIP_COMPANY_ID}/agents",
            )
            agents = r.json() if r.status_code == 200 else []
            agents = agents if isinstance(agents, list) else agents.get("data", [])
            agent = next((a for a in agents if a.get("id") == agent_id), None)
            if agent:
                return agent.get("name") or agent_id
        except Exception:
            pass
        return agent_id
    return f"user:{user_id}"


async def cmd_show(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Show detail card for a specific issue: /show ANGA-NNN"""
    if not await _check_whitelist(update, ctx):
        return
    text = update.message.text or ""
    parts = text.strip().split(None, 1)
    if len(parts) < 2:
        await update.message.reply_text("Usage: /show ANGA-NNN")
        return

    identifier = parts[1].strip().upper()
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            # Use search to avoid fetching all issues
            resp = await client.get(
                f"{PAPERCLIP_API_URL}/api/companies/{PAPERCLIP_COMPANY_ID}/issues",
                params={"q": identifier},
            )
            all_issues = resp.json()

            items = all_issues if isinstance(all_issues, list) else all_issues.get("data", [])
            issue = next((i for i in items if i.get("identifier") == identifier), None)

            if not issue:
                await update.message.reply_text(f"Issue {identifier} not found.")
                return

            assignee = await _resolve_assignee(client, issue)

        p = _PRIORITY_EMOJI.get(issue.get("priority", ""), "")
        s = _STATUS_EMOJI.get(issue.get("status", ""), "•")
        desc = issue.get("description") or ""
        # Strip markdown and trim
        desc_clean = desc.replace("_", "").replace("*", "").replace("#", "").strip()
        desc_preview = (desc_clean[:200] + "…") if len(desc_clean) > 200 else desc_clean

        lines = [
            f"{s}{p} [{issue['identifier']}] {issue.get('title', 'Untitled')}",
            f"Status: {issue.get('status', '?')}  Priority: {issue.get('priority', '?')}",
            f"Assignee: {assignee}",
        ]
        if desc_preview:
            lines.append(f"\n{desc_preview}")
        lines.append(f"\n{PAPERCLIP_API_URL.replace(':3100', ':3000')}/ANGA/issues/{identifier}")

        await update.message.reply_text("\n".join(lines))
    except Exception as e:
        logger.error("cmd_show error: %s", e)
        await update.message.reply_text(f"Error: {e}")


async def cmd_priority(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Create a high-priority issue and confirm delegation: /priority <text>"""
    if not await _check_whitelist(update, ctx):
        return
    text = update.message.text or ""
    parts = text.strip().split(None, 1)
    if len(parts) < 2 or not parts[1].strip():
        await update.message.reply_text("Usage: /priority <title or description>")
        return

    content = parts[1].strip()
    lines = content.split("\n")
    title = lines[0].strip()
    description = "\n".join(lines[1:]).strip() if len(lines) > 1 else None
    username = update.effective_user.username if update.effective_user else None
    from_tag = f"@{username}" if username else f"chat_id:{update.effective_chat.id}"

    auth_headers: dict = {}
    if PAPERCLIP_API_KEY:
        auth_headers["Authorization"] = f"Bearer {PAPERCLIP_API_KEY}"

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            payload: dict = {
                "title": title,
                "status": "todo",
                "priority": "critical",
                "assigneeAgentId": PAPERCLIP_CTO_AGENT_ID,
                "description": f"🚨 Priority request from {from_tag}\n\n{description or ''}".strip(),
            }
            resp = await client.post(
                f"{PAPERCLIP_API_URL}/api/companies/{PAPERCLIP_COMPANY_ID}/issues",
                json=payload,
                headers=auth_headers,
            )
            issue = resp.json()

        if resp.status_code not in (200, 201) or "identifier" not in issue:
            await update.message.reply_text(f"⚠️ Failed to create issue: {issue.get('error', resp.status_code)}")
            return

        identifier = issue["identifier"]
        ui_base = PAPERCLIP_API_URL.replace(":3100", ":3000")
        await update.message.reply_text(
            f"🔴 Urgent issue created: {identifier}\n"
            f"{title}\n"
            f"{ui_base}/ANGA/issues/{identifier}\n\n"
            "Assigned to CTO for immediate triage."
        )
        logger.info("cmd_priority: created urgent issue %s by %s", identifier, from_tag)
    except Exception as e:
        logger.error("cmd_priority error: %s", e)
        await update.message.reply_text(f"Error: {e}")


async def cmd_deliverables(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Show what was completed since last check: /deliverables"""
    if not await _check_whitelist(update, ctx):
        return
    chat_id = update.effective_chat.id

    # Determine "since" timestamp — use stored cursor or default to 24 hours ago
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    stored_cursor = _deliverables_cursors.get(str(chat_id))

    if stored_cursor:
        since_iso = stored_cursor
        # Human-readable label
        try:
            since_dt = datetime.fromisoformat(stored_cursor.rstrip("Z")).replace(tzinfo=timezone.utc)
            since_label = since_dt.strftime("%b %d %H:%M UTC")
        except Exception:
            since_label = stored_cursor
    else:
        # First call — show last 24 h
        from datetime import timedelta
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        since_iso = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
        since_label = "last 24 hours"

    # Persist cursor BEFORE the query so we don't miss anything
    _save_deliverables_cursor(chat_id, now_iso)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{PAPERCLIP_API_URL}/api/companies/{PAPERCLIP_COMPANY_ID}/issues",
                params={"status": "done"},
            )
            all_issues = resp.json()

        items = all_issues if isinstance(all_issues, list) else all_issues.get("data", [])

        # Filter by completedAt or updatedAt > since cursor
        recent = [
            i for i in items
            if (i.get("completedAt") or i.get("updatedAt") or "") >= since_iso
        ]

        if not recent:
            await update.message.reply_text(f"No deliverables since {since_label}.")
            return

        # Sort most recent first
        recent.sort(key=lambda i: (i.get("completedAt") or i.get("updatedAt") or ""), reverse=True)
        shown = recent[:15]

        lines = [f"✅ Shipped since {since_label} ({len(recent)} issue{'s' if len(recent) != 1 else ''}):"]
        for issue in shown:
            ident = issue.get("identifier", "")
            title = issue.get("title", "Untitled")
            if len(title) > 52:
                title = title[:49] + "…"
            lines.append(f"✅ [{ident}] {title}")

        if len(recent) > 15:
            lines.append(f"…and {len(recent) - 15} more")

        await update.message.reply_text("\n".join(lines))
    except Exception as e:
        logger.error("cmd_deliverables error: %s", e)
        await update.message.reply_text(f"Error fetching deliverables: {e}")


async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Forward incoming messages to Paperclip as issues or comments."""
    if not await _check_whitelist(update, ctx):
        return
    chat_id = update.effective_chat.id
    text = update.message.text
    username = update.effective_user.username if update.effective_user else None
    logger.info("Received from %d: %s", chat_id, text)
    register_chat(chat_id)

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{PAPERCLIP_API_URL}/api/telegram/ingest",
                json={
                    "chat_id": chat_id,
                    "text": text,
                    "message_id": update.message.message_id,
                    "username": username,
                },
            )
            data = resp.json()

        if resp.status_code == 200 and data.get("ok"):
            action = data.get("action")
            if action == "issue":
                await update.message.reply_text(
                    f"✅ Issue created: {data['identifier']}\n"
                    f"http://localhost:3100/ANGA/issues/{data['identifier']}"
                )
            elif action == "comment":
                await update.message.reply_text(
                    f"💬 Comment posted on {data['identifier']}"
                )
            else:
                await update.message.reply_text("✅ Received by Paperclip.")
        else:
            err = data.get("error", "unknown error")
            await update.message.reply_text(f"⚠️ Paperclip error: {err}")
    except Exception as e:
        logger.error("Failed to forward message to Paperclip: %s", e)
        await update.message.reply_text(f"⚠️ Could not reach Paperclip: {e}")


# ---------------------------------------------------------------------------
# Approval / rejection handlers (Angel only)
# ---------------------------------------------------------------------------
async def cmd_approve(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """/approve <chat_id> — whitelist a user (Angel only)."""
    if update.effective_chat.id != ANGEL_CHAT_ID:
        await update.message.reply_text("Not authorised.")
        return

    text = update.message.text or ""
    parts = text.strip().split()
    if len(parts) < 2 or not parts[1].lstrip("-").isdigit():
        await update.message.reply_text("Usage: /approve <chat_id>")
        return

    target_id = int(parts[1])
    _whitelist.add(target_id)
    _save_whitelist()
    logger.info("Approved chat_id=%d by Angel", target_id)

    await update.message.reply_text(f"chat_id={target_id} approved and whitelisted.")

    # Notify the approved user
    try:
        await ctx.bot.send_message(
            chat_id=target_id,
            text="Your access request has been approved. You can now use the bot.",
        )
    except Exception as e:
        logger.warning("Could not notify approved user %d: %s", target_id, e)


async def cmd_reject(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """/reject <chat_id> — reject a user's access request (Angel only)."""
    if update.effective_chat.id != ANGEL_CHAT_ID:
        await update.message.reply_text("Not authorised.")
        return

    text = update.message.text or ""
    parts = text.strip().split()
    if len(parts) < 2 or not parts[1].lstrip("-").isdigit():
        await update.message.reply_text("Usage: /reject <chat_id>")
        return

    target_id = int(parts[1])
    logger.info("Rejected chat_id=%d by Angel", target_id)

    await update.message.reply_text(f"chat_id={target_id} rejected.")

    # Notify the rejected user
    try:
        await ctx.bot.send_message(
            chat_id=target_id,
            text="Your access request has been rejected.",
        )
    except Exception as e:
        logger.warning("Could not notify rejected user %d: %s", target_id, e)


# ---------------------------------------------------------------------------
# Telegram application (polling)
# ---------------------------------------------------------------------------
_app: Application | None = None


def _build_telegram_app() -> Application:
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("id", cmd_id))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("issues", cmd_issues))
    app.add_handler(CommandHandler("list", cmd_list))
    app.add_handler(CommandHandler("show", cmd_show))
    app.add_handler(CommandHandler("priority", cmd_priority))
    app.add_handler(CommandHandler("deliverables", cmd_deliverables))
    app.add_handler(CommandHandler("approve", cmd_approve))
    app.add_handler(CommandHandler("reject", cmd_reject))
    # /issue and /comment forward to handle_message — they parse the full text
    app.add_handler(CommandHandler("issue", handle_message))
    app.add_handler(CommandHandler("comment", handle_message))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    return app


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
class SendRequest(BaseModel):
    chat_id: int | None = None  # if None, broadcast to all registered
    text: str
    parse_mode: str | None = None  # "HTML", "MarkdownV2", or None


class SendResponse(BaseModel):
    ok: bool
    sent_to: list[int]


@asynccontextmanager
async def lifespan(api: FastAPI):
    global _app
    _load_chat_ids()
    _load_whitelist()
    _app = _build_telegram_app()
    await _app.initialize()
    await _app.start()
    await _app.updater.start_polling(drop_pending_updates=True)
    logger.info("Telegram polling started")
    yield
    logger.info("Shutting down Telegram polling")
    await _app.updater.stop()
    await _app.stop()
    await _app.shutdown()


api = FastAPI(title="Paperclip Telegram Bot", lifespan=lifespan)


@api.get("/health")
async def health():
    return {"status": "ok", "registered_chats": len(_chat_ids)}


@api.get("/chats")
async def list_chats():
    return {"chat_ids": sorted(_chat_ids)}


@api.post("/send", response_model=SendResponse)
async def send_message(req: SendRequest):
    if _app is None:
        raise HTTPException(503, "Bot not initialized")

    targets = [req.chat_id] if req.chat_id else sorted(_chat_ids)
    if not targets:
        raise HTTPException(
            400,
            "No chat_id specified and no registered chats. Send /start to the bot first.",
        )

    sent: list[int] = []
    for cid in targets:
        try:
            await _app.bot.send_message(
                chat_id=cid,
                text=req.text,
                parse_mode=req.parse_mode,
            )
            sent.append(cid)
        except Exception as e:
            logger.error("Failed to send to %d: %s", cid, e)

    if not sent:
        raise HTTPException(500, "Failed to send to any chat")

    return SendResponse(ok=True, sent_to=sent)
