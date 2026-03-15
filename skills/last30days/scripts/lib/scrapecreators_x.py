"""X/Twitter search via ScrapeCreators API for /last30days.

Uses ScrapeCreators REST API to search Twitter/X by keyword.
Same API key as Reddit, TikTok, and Instagram - one key covers all social sources.

Requires SCRAPECREATORS_API_KEY in config.
API docs: https://scrapecreators.com/docs
"""

import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

try:
    import requests as _requests
except ImportError:
    _requests = None

SCRAPECREATORS_BASE = "https://api.scrapecreators.com/v1/twitter"

DEPTH_CONFIG = {
    "quick":   {"results_per_page": 10},
    "default": {"results_per_page": 20},
    "deep":    {"results_per_page": 40},
}

STOPWORDS = frozenset({
    'the', 'a', 'an', 'to', 'for', 'how', 'is', 'in', 'of', 'on',
    'and', 'with', 'from', 'by', 'at', 'this', 'that', 'it', 'my',
    'your', 'i', 'me', 'we', 'you', 'what', 'are', 'do', 'can',
    'its', 'be', 'or', 'not', 'no', 'so', 'if', 'but', 'about',
    'all', 'just', 'get', 'has', 'have', 'was', 'will',
})

SYNONYMS = {
    'js': {'javascript'}, 'javascript': {'js'},
    'ts': {'typescript'}, 'typescript': {'ts'},
    'ai': {'artificial', 'intelligence'},
    'ml': {'machine', 'learning'},
    'react': {'reactjs'}, 'reactjs': {'react'},
}


def _tokenize(text: str) -> Set[str]:
    """Lowercase, strip punctuation, remove stopwords, drop single-char tokens."""
    words = re.sub(r'[^\w\s]', ' ', text.lower()).split()
    tokens = {w for w in words if w not in STOPWORDS and len(w) > 1}
    expanded = set(tokens)
    for t in tokens:
        if t in SYNONYMS:
            expanded.update(SYNONYMS[t])
    return expanded


def _compute_relevance(query: str, text: str) -> float:
    """Compute relevance as ratio of query tokens found in text. Floors at 0.1."""
    q_tokens = _tokenize(query)
    t_tokens = _tokenize(text)
    if not q_tokens:
        return 0.5
    overlap = len(q_tokens & t_tokens)
    ratio = overlap / len(q_tokens)
    return max(0.1, min(1.0, ratio))


def _extract_core_subject(topic: str) -> str:
    """Extract core subject from verbose query for Twitter search."""
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


def _log(msg: str):
    if sys.stderr.isatty():
        sys.stderr.write(f"[X/SC] {msg}\n")
        sys.stderr.flush()


def _sc_headers(token: str) -> Dict[str, str]:
    return {
        "x-api-key": token,
        "Content-Type": "application/json",
    }


def _parse_date(item: Dict[str, Any]) -> Optional[str]:
    """Parse date from ScrapeCreators Twitter item to YYYY-MM-DD."""
    # Try created_at string (e.g. "Wed Oct 10 20:19:24 +0000 2018")
    created_at = item.get("created_at")
    if created_at and isinstance(created_at, str):
        try:
            dt = datetime.strptime(created_at, "%a %b %d %H:%M:%S %z %Y")
            return dt.strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            pass

    # Try unix timestamp
    ts = item.get("timestamp") or item.get("created_at_timestamp")
    if ts:
        try:
            dt = datetime.fromtimestamp(int(ts), tz=timezone.utc)
            return dt.strftime("%Y-%m-%d")
        except (ValueError, TypeError, OSError):
            pass

    # Try ISO format
    for key in ("created_at", "date"):
        val = item.get(key)
        if val and isinstance(val, str):
            try:
                dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
                return dt.strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                pass

    return None


def search_x(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
    token: str = None,
) -> Dict[str, Any]:
    """Search X/Twitter via ScrapeCreators API.

    Returns:
        Dict with 'items' list (in normalize_x_items format) and optional 'error'.
    """
    if not token:
        return {"items": [], "error": "No SCRAPECREATORS_API_KEY configured"}

    if not _requests:
        return {"items": [], "error": "requests library not installed"}

    config = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    core_topic = _extract_core_subject(topic)

    _log(f"Searching X for '{core_topic}' (depth={depth}, count={config['results_per_page']})")

    try:
        resp = _requests.get(
            f"{SCRAPECREATORS_BASE}/search/tweets",
            params={"query": core_topic, "sort_by": "relevance"},
            headers=_sc_headers(token),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        _log(f"ScrapeCreators error: {e}")
        return {"items": [], "error": f"{type(e).__name__}: {e}"}

    raw_items = data.get("tweets") or data.get("data") or data.get("results") or []
    raw_items = raw_items[:config["results_per_page"]]

    items = []
    for i, raw in enumerate(raw_items):
        tweet_id = str(raw.get("id") or raw.get("tweet_id") or raw.get("id_str") or f"sc-x-{i}")
        text = raw.get("full_text") or raw.get("text") or ""
        user = raw.get("user") or raw.get("author") or {}
        author_handle = user.get("screen_name") or user.get("username") or ""

        # Engagement metrics
        likes = raw.get("favorite_count") or raw.get("likes") or 0
        retweets = raw.get("retweet_count") or raw.get("retweets") or 0
        replies = raw.get("reply_count") or raw.get("replies") or 0
        quotes = raw.get("quote_count") or raw.get("quotes") or 0

        date_str = _parse_date(raw)
        relevance = _compute_relevance(core_topic, text)

        url = ""
        if author_handle and tweet_id and not tweet_id.startswith("sc-x-"):
            url = f"https://x.com/{author_handle}/status/{tweet_id}"

        items.append({
            "id": tweet_id,
            "text": text,
            "url": url,
            "author_handle": author_handle,
            "date": date_str,
            "engagement": {
                "likes": likes,
                "reposts": retweets,
                "replies": replies,
                "quotes": quotes,
            },
            "relevance": relevance,
            "why_relevant": f"X: @{author_handle}: {text[:60]}" if text else f"X: {core_topic}",
        })

    # Date filter
    in_range = [i for i in items if i["date"] and from_date <= i["date"] <= to_date]
    out_of_range = len(items) - len(in_range)
    if in_range:
        items = in_range
        if out_of_range:
            _log(f"Filtered {out_of_range} tweets outside date range")
    else:
        _log(f"No tweets within date range, keeping all {len(items)}")

    # Sort by engagement (likes + retweets)
    items.sort(key=lambda x: (x["engagement"]["likes"] + x["engagement"]["reposts"]), reverse=True)

    _log(f"Found {len(items)} tweets")
    return {"items": items}


def parse_x_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse search response to normalized format."""
    return response.get("items", [])
