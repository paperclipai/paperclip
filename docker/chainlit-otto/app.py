"""
NUC-116: Chainlit Copilot Widget — Otto (claude CLI subprocess backend)

Authentication via Claude Max OAuth — no Anthropic API billing.
The `claude` CLI must be installed and authenticated on the server.

Run with:
    chainlit run app.py --host 0.0.0.0 --port 8000

Required env:
    CHAINLIT_JWT_SECRET  — shared secret with Paperclip for JWT validation
"""

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time

import chainlit as cl

# ── JWT validation ────────────────────────────────────────────────────────────

_JWT_SECRET = os.environ.get("CHAINLIT_JWT_SECRET", "")

OTTO_SYSTEM_PROMPT = (
    "You are Otto, an AI assistant at Nucleotto. "
    "Help team members with questions, tasks, and information. "
    "Be concise, helpful, and direct."
)


def _verify_jwt(token: str) -> dict | None:
    """Verify a HS256 JWT signed by the Paperclip server."""
    if not _JWT_SECRET:
        # Dev mode: no secret configured — allow all connections
        return {"sub": "anonymous", "dev": True}

    parts = token.split(".")
    if len(parts) != 3:
        return None

    header_b64, payload_b64, sig_b64 = parts
    signing_input = f"{header_b64}.{payload_b64}".encode()

    expected_sig = base64.urlsafe_b64encode(
        hmac.new(_JWT_SECRET.encode(), signing_input, hashlib.sha256).digest()
    ).rstrip(b"=")

    if not hmac.compare_digest(expected_sig, sig_b64.encode()):
        return None

    # Decode payload
    padding = 4 - len(payload_b64) % 4
    payload_padded = payload_b64 + "=" * (padding % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_padded))
    except Exception:
        return None

    # Check expiry
    if payload.get("exp", 0) < time.time():
        return None

    return payload


# ── Chainlit auth ─────────────────────────────────────────────────────────────


@cl.header_auth_callback
def header_auth_callback(headers: dict) -> cl.User | None:
    """Validate the JWT passed by mountChainlitWidget as accessToken."""
    auth = headers.get("Authorization") or headers.get("authorization", "")
    token = auth.removeprefix("Bearer ").strip()

    if not token:
        # No token — allow anonymous access (widget without auth)
        return cl.User(identifier="anonymous", metadata={})

    claims = _verify_jwt(token)
    if claims is None:
        return None  # Reject invalid/expired tokens

    user_id = claims.get("sub", "user")
    return cl.User(identifier=user_id, metadata={"claims": claims})


# ── Chat lifecycle ─────────────────────────────────────────────────────────────


@cl.on_chat_start
async def on_chat_start() -> None:
    cl.user_session.set("history", [])

    greeting = "Hi! I'm Otto. How can I help?"
    if cl.context.session.client_type == "copilot":
        greeting = "Hi! I'm Otto 👋 Ask me anything."

    await cl.Message(content=greeting).send()


@cl.on_message
async def on_message(message: cl.Message) -> None:
    history: list[dict] = cl.user_session.get("history", [])

    # Handle host→widget postMessage context updates (system_message type)
    if (
        cl.context.session.client_type == "copilot"
        and message.type == "system_message"
    ):
        cl.user_session.set("page_context", message.content)
        return

    history.append({"role": "user", "content": message.content})

    # Build full prompt for claude CLI
    # Prepend system and conversation history as context
    page_context = cl.user_session.get("page_context")
    system_lines = [OTTO_SYSTEM_PROMPT]
    if page_context:
        system_lines.append(f"Current page context: {page_context}")

    conversation = "\n".join(
        f"{'Human' if m['role'] == 'user' else 'Assistant'}: {m['content']}"
        for m in history
    )

    full_prompt = "\n\n".join([
        "\n".join(system_lines),
        conversation,
        "Assistant:",
    ])

    msg = cl.Message(content="")
    await msg.send()

    try:
        proc = await asyncio.create_subprocess_exec(
            "claude", "-p", full_prompt,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        response = stdout.decode(errors="replace").strip()

        if not response and proc.returncode != 0:
            response = "Sorry, I encountered an error. Please try again."

    except FileNotFoundError:
        response = (
            "⚠️ The `claude` CLI is not installed or not in PATH. "
            "Please authenticate the Claude Max account on this server."
        )

    await msg.stream_token(response)
    await msg.update()

    history.append({"role": "assistant", "content": response})
    cl.user_session.set("history", history)
