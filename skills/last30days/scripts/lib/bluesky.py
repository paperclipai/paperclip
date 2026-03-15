"""Bluesky search via AT Protocol (requires app password).

Uses bsky.social for auth and public.api.bsky.app for post search.
Requires BSKY_HANDLE and BSKY_APP_PASSWORD env vars.
"""

import math
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from . import http

BSKY_SESSION_URL = "https://bsky.social/xrpc/com.atproto.server.createSession"
BSKY_SEARCH_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts"

DEPTH_CONFIG = {
    "quick": 15,
    "default": 30,
    "deep": 60,
}

# Module-level token cache (valid for the lifetime of a single research run)
_cached_token: Optional[str] = None


def _log(msg: str):
    """Log to stderr (only in TTY mode to avoid cluttering Claude Code output)."""
    if sys.stderr.isatty():
        sys.stderr.write(f"[Bluesky] {msg}\n")
        sys.stderr.flush()


def _create_session(handle: str, app_password: str) -> Optional[str]:
    """Create an AT Protocol session and return the access token.

    Args:
        handle: Bluesky handle (e.g. user.bsky.social)
        app_password: App password from bsky.app/settings/app-passwords

    Returns:
        Access JWT string, or None on failure.
    """
    global _cached_token
    if _cached_token:
        return _cached_token

    try:
        response = http.request(
            "POST",
            BSKY_SESSION_URL,
            json_data={"identifier": handle, "password": app_password},
            timeout=15,
        )
        token = response.get("accessJwt")
        if token:
            _cached_token = token
            _log("Session created successfully")
            return token
        _log("No accessJwt in session response")
        return None
    except Exception as e:
        _log(f"Session creation failed: {e}")
        return None


def _extract_core_subject(topic: str) -> str:
    """Extract core subject from verbose query for Bluesky search."""
    text = topic.lower().strip()
    prefixes = [
        'what are the best', 'what is the best', 'what are the latest',
        'what are people saying about', 'what do people think about',
        'how do i use', 'how to use', 'how to',
        'what are', 'what is', 'tips for', 'best practices for',
    ]
    for p in prefixes:
        if text.startswith(p + ' '):
            text = text[len(p):].strip()
    noise = {
        'best', 'top', 'good', 'great', 'awesome',
        'latest', 'new', 'news', 'update', 'updates',
        'trending', 'hottest', 'popular', 'viral',
        'practices', 'features', 'recommendations', 'advice',
    }
    words = text.split()
    filtered = [w for w in words if w not in noise]
    result = ' '.join(filtered) if filtered else text
    return result.rstrip('?!.')


def _parse_date(item: Dict[str, Any]) -> Optional[str]:
    """Parse date from Bluesky post to YYYY-MM-DD.

    AT Protocol uses ISO 8601 format in indexedAt and createdAt fields.
    """
    for key in ("indexedAt", "createdAt"):
        val = item.get(key)
        if val and isinstance(val, str):
            try:
                dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
                return dt.strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                pass
    return None


def search_bluesky(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Search Bluesky via AT Protocol API.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD)
        depth: 'quick', 'default', or 'deep'
        config: Config dict with BSKY_HANDLE and BSKY_APP_PASSWORD

    Returns:
        Dict with 'posts' list from AT Protocol response.
    """
    config = config or {}
    handle = config.get("BSKY_HANDLE", "")
    app_password = config.get("BSKY_APP_PASSWORD", "")

    if not handle or not app_password:
        return {"posts": [], "error": "Bluesky credentials not configured"}

    # Authenticate
    token = _create_session(handle, app_password)
    if not token:
        return {"posts": [], "error": "Bluesky auth failed"}

    count = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    core_topic = _extract_core_subject(topic)

    _log(f"Searching for '{core_topic}' (depth={depth}, limit={count})")

    from urllib.parse import urlencode
    params = {
        "q": core_topic,
        "limit": str(min(count, 100)),
        "sort": "top",
    }
    url = f"{BSKY_SEARCH_URL}?{urlencode(params)}"

    try:
        response = http.request(
            "GET", url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
    except http.HTTPError as e:
        _log(f"Search failed: {e}")
        return {"posts": [], "error": str(e)}
    except Exception as e:
        _log(f"Search failed: {e}")
        return {"posts": [], "error": str(e)}

    posts = response.get("posts", [])
    _log(f"Found {len(posts)} posts")
    return response


def parse_bluesky_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse AT Protocol response into normalized item dicts.

    Returns:
        List of item dicts ready for normalization.
    """
    posts = response.get("posts", [])
    items = []

    for i, post in enumerate(posts):
        record = post.get("record") or {}
        text = record.get("text") or ""

        author = post.get("author") or {}
        handle = author.get("handle") or ""
        display_name = author.get("displayName") or handle

        # Post URI -> URL
        # URI format: at://did:plc:xxx/app.bsky.feed.post/rkey
        uri = post.get("uri") or ""
        rkey = uri.rsplit("/", 1)[-1] if uri else ""
        url = f"https://bsky.app/profile/{handle}/post/{rkey}" if handle and rkey else ""

        likes = post.get("likeCount") or 0
        reposts = post.get("repostCount") or 0
        replies = post.get("replyCount") or 0
        quotes = post.get("quoteCount") or 0

        date_str = _parse_date(post) or _parse_date(record)

        # Relevance: position-based (AT Protocol sorts by relevance with sort=top)
        rank_score = max(0.3, 1.0 - (i * 0.02))
        engagement_boost = min(0.2, math.log1p(likes + reposts) / 40)
        relevance = min(1.0, rank_score * 0.7 + engagement_boost + 0.1)

        items.append({
            "handle": handle,
            "display_name": display_name,
            "text": text,
            "url": url,
            "date": date_str,
            "engagement": {
                "likes": likes,
                "reposts": reposts,
                "replies": replies,
                "quotes": quotes,
            },
            "relevance": round(relevance, 2),
            "why_relevant": f"Bluesky: @{handle}: {text[:60]}" if text else f"Bluesky: {handle}",
        })

    return items
