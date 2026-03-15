"""Instagram Reels search via ScrapeCreators API for /last30days.

Uses ScrapeCreators REST API to search Instagram Reels by keyword, extract
engagement metrics (views, likes, comments), and fetch video transcripts.

Requires SCRAPECREATORS_API_KEY in config. 100 free credits, then PAYG.
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

SCRAPECREATORS_BASE = "https://api.scrapecreators.com"

# Depth configurations: how many results to fetch / captions to extract
DEPTH_CONFIG = {
    "quick":   {"results_per_page": 10, "max_captions": 3},
    "default": {"results_per_page": 20, "max_captions": 5},
    "deep":    {"results_per_page": 40, "max_captions": 8},
}

# Max words to keep from each caption
CAPTION_MAX_WORDS = 500

# Stopwords for relevance computation (shared with tiktok.py pattern)
STOPWORDS = frozenset({
    'the', 'a', 'an', 'to', 'for', 'how', 'is', 'in', 'of', 'on',
    'and', 'with', 'from', 'by', 'at', 'this', 'that', 'it', 'my',
    'your', 'i', 'me', 'we', 'you', 'what', 'are', 'do', 'can',
    'its', 'be', 'or', 'not', 'no', 'so', 'if', 'but', 'about',
    'all', 'just', 'get', 'has', 'have', 'was', 'will',
})

# Synonym groups for relevance scoring
SYNONYMS = {
    'hip': {'rap', 'hiphop'},
    'hop': {'rap', 'hiphop'},
    'rap': {'hip', 'hop', 'hiphop'},
    'hiphop': {'rap', 'hip', 'hop'},
    'js': {'javascript'},
    'javascript': {'js'},
    'ts': {'typescript'},
    'typescript': {'ts'},
    'ai': {'artificial', 'intelligence'},
    'ml': {'machine', 'learning'},
    'react': {'reactjs'},
    'reactjs': {'react'},
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


def _compute_relevance(query: str, text: str, hashtags: List[str] = None) -> float:
    """Compute relevance as ratio of query tokens found in text + hashtags.

    Uses ratio overlap (intersection / query_length). Hashtags provide
    an Instagram-specific relevance boost. Floors at 0.1.
    """
    q_tokens = _tokenize(query)

    # Combine text and hashtags for matching
    combined = text
    if hashtags:
        combined = f"{text} {' '.join(hashtags)}"
    t_tokens = _tokenize(combined)

    # Split concatenated hashtags (e.g., "claudecode" -> "claude", "code")
    if hashtags:
        for tag in hashtags:
            tag_lower = tag.lower()
            for qt in q_tokens:
                if qt in tag_lower and qt != tag_lower:
                    t_tokens.add(qt)

    if not q_tokens:
        return 0.5  # Neutral fallback

    overlap = len(q_tokens & t_tokens)
    ratio = overlap / len(q_tokens)
    return max(0.1, min(1.0, ratio))


def _extract_core_subject(topic: str) -> str:
    """Extract core subject from verbose query for Instagram search.

    Strips meta/research words to keep only the core product/concept name.
    """
    text = topic.lower().strip()

    # Strip multi-word prefixes
    prefixes = [
        'what are the best', 'what is the best', 'what are the latest',
        'what are people saying about', 'what do people think about',
        'how do i use', 'how to use', 'how to',
        'what are', 'what is', 'tips for', 'best practices for',
    ]
    for p in prefixes:
        if text.startswith(p + ' '):
            text = text[len(p):].strip()

    # Strip individual noise words
    noise = {
        'best', 'top', 'good', 'great', 'awesome', 'killer',
        'latest', 'new', 'news', 'update', 'updates',
        'trending', 'hottest', 'popular', 'viral',
        'practices', 'features',
        'recommendations', 'advice',
        'prompt', 'prompts', 'prompting',
        'methods', 'strategies', 'approaches',
    }
    words = text.split()
    filtered = [w for w in words if w not in noise]

    result = ' '.join(filtered) if filtered else text
    return result.rstrip('?!.')


def _log(msg: str):
    """Log to stderr (only in interactive terminals; spinner handles non-TTY)."""
    if sys.stderr.isatty():
        sys.stderr.write(f"[Instagram] {msg}\n")
        sys.stderr.flush()


def _sc_headers(token: str) -> Dict[str, str]:
    """Build ScrapeCreators request headers."""
    return {
        "x-api-key": token,
        "Content-Type": "application/json",
    }


def _parse_date(item: Dict[str, Any]) -> Optional[str]:
    """Parse date from ScrapeCreators Instagram item to YYYY-MM-DD.

    Handles taken_at as ISO string (e.g. "2026-02-26T16:00:00.000Z")
    or unix timestamp.
    """
    ts = item.get("taken_at")
    if not ts:
        return None

    # Try ISO string first (ScrapeCreators reels/search returns this)
    if isinstance(ts, str):
        try:
            # Handle "2026-02-26T16:00:00.000Z" format
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return dt.strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            pass
        # Try just the date portion
        if len(ts) >= 10:
            return ts[:10]

    # Fall back to unix timestamp
    try:
        dt = datetime.fromtimestamp(int(ts), tz=timezone.utc)
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError, OSError):
        pass

    return None


def _extract_hashtags(caption_text: str) -> List[str]:
    """Extract hashtags from Instagram caption text."""
    if not caption_text:
        return []
    return re.findall(r'#(\w+)', caption_text)


def search_instagram(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
    token: str = None,
) -> Dict[str, Any]:
    """Search Instagram Reels via ScrapeCreators API.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD)
        depth: 'quick', 'default', or 'deep'
        token: ScrapeCreators API key

    Returns:
        Dict with 'items' list and optional 'error'.
    """
    if not token:
        return {"items": [], "error": "No SCRAPECREATORS_API_KEY configured"}

    if not _requests:
        return {"items": [], "error": "requests library not installed"}

    config = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    core_topic = _extract_core_subject(topic)

    _log(f"Searching Instagram for '{core_topic}' (depth={depth}, count={config['results_per_page']})")

    try:
        resp = _requests.get(
            f"{SCRAPECREATORS_BASE}/v1/instagram/reels/search",
            params={"query": core_topic},
            headers=_sc_headers(token),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        _log(f"ScrapeCreators error: {e}")
        return {"items": [], "error": f"{type(e).__name__}: {e}"}

    # Items are in the 'reels' array (ScrapeCreators v1 response)
    raw_items = data.get("reels") or data.get("items") or data.get("data") or []

    # Limit to configured count
    raw_items = raw_items[:config["results_per_page"]]

    # Parse items
    items = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue

        # Extract reel ID and shortcode
        reel_pk = str(raw.get("id", raw.get("pk", "")))
        shortcode = raw.get("shortcode", raw.get("code", ""))

        # Caption text — can be a string or dict depending on endpoint
        caption_obj = raw.get("caption", "")
        if isinstance(caption_obj, dict):
            text = caption_obj.get("text", "")
        elif isinstance(caption_obj, str):
            text = caption_obj
        else:
            text = raw.get("desc", raw.get("text", ""))

        # Engagement metrics
        play_count = raw.get("video_play_count") or raw.get("video_view_count") or raw.get("play_count") or 0
        like_count = raw.get("like_count") or 0
        comment_count = raw.get("comment_count") or 0

        # Author info — 'owner' in reels/search, 'user' in user/reels
        owner = raw.get("owner") or raw.get("user") or {}
        author_name = owner.get("username", "")

        # Duration
        duration = raw.get("video_duration")

        # Date
        date_str = _parse_date(raw)

        # Hashtags from caption text
        hashtags = _extract_hashtags(text)

        # Compute relevance with hashtag boost
        relevance = _compute_relevance(core_topic, text, hashtags)

        # Build URL — prefer API-provided url, fallback to shortcode
        url = raw.get("url", "")
        if not url and shortcode:
            url = f"https://www.instagram.com/reel/{shortcode}"

        items.append({
            "video_id": reel_pk,
            "text": text,
            "url": url,
            "author_name": author_name,
            "date": date_str,
            "engagement": {
                "views": play_count,
                "likes": like_count,
                "comments": comment_count,
            },
            "hashtags": hashtags,
            "duration": duration,
            "relevance": relevance,
            "why_relevant": f"Instagram: {text[:60]}" if text else f"Instagram: {core_topic}",
            "caption_snippet": "",  # populated by fetch_captions
        })

    # Hard date filter
    in_range = [i for i in items if i["date"] and from_date <= i["date"] <= to_date]
    out_of_range = len(items) - len(in_range)
    if in_range:
        items = in_range
        if out_of_range:
            _log(f"Filtered {out_of_range} reels outside date range")
    else:
        _log(f"No reels within date range, keeping all {len(items)}")

    # Sort by views descending
    items.sort(key=lambda x: x["engagement"]["views"], reverse=True)

    _log(f"Found {len(items)} Instagram reels")
    return {"items": items}


def fetch_captions(
    video_items: List[Dict[str, Any]],
    token: str,
    depth: str = "default",
) -> Dict[str, str]:
    """Fetch transcripts for top N Instagram reels via ScrapeCreators.

    Strategy:
    1. Use the 'text' field (caption) as baseline
    2. For top N, call /v2/instagram/media/transcript for spoken-word captions

    Args:
        video_items: Items from search_instagram()
        token: ScrapeCreators API key
        depth: Depth level for caption limit

    Returns:
        Dict mapping video_id -> caption text (truncated to 500 words)
    """
    config = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    max_captions = config["max_captions"]

    if not video_items or not token or not _requests:
        return {}

    top_items = video_items[:max_captions]
    _log(f"Enriching captions for {len(top_items)} reels")

    captions = {}

    # First pass: use text field as caption (always available, free)
    for item in top_items:
        vid = item["video_id"]
        text = item.get("text", "")
        if text:
            words = text.split()
            if len(words) > CAPTION_MAX_WORDS:
                text = ' '.join(words[:CAPTION_MAX_WORDS]) + '...'
            captions[vid] = text

    # Second pass: try to get spoken-word transcripts (1 credit each)
    for item in top_items:
        vid = item["video_id"]
        url = item.get("url", "")
        if not url:
            continue
        try:
            resp = _requests.get(
                f"{SCRAPECREATORS_BASE}/v2/instagram/media/transcript",
                params={"url": url},
                headers=_sc_headers(token),
                timeout=15,
            )
            if resp.status_code == 200:
                data = resp.json()
                transcripts = data.get("transcripts") or []
                if transcripts and isinstance(transcripts, list):
                    # Combine all transcript segments
                    transcript_text = " ".join(
                        t.get("text", "") for t in transcripts
                        if isinstance(t, dict) and t.get("text")
                    )
                    if transcript_text:
                        words = transcript_text.split()
                        if len(words) > CAPTION_MAX_WORDS:
                            transcript_text = ' '.join(words[:CAPTION_MAX_WORDS]) + '...'
                        captions[vid] = transcript_text
        except Exception as e:
            _log(f"Transcript fetch failed for {vid}: {e}")

    got = sum(1 for v in captions.values() if v)
    _log(f"Got captions for {got}/{len(top_items)} reels")
    return captions


def search_and_enrich(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
    token: str = None,
) -> Dict[str, Any]:
    """Full Instagram search: find reels, then fetch captions for top results.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD)
        depth: 'quick', 'default', or 'deep'
        token: ScrapeCreators API key

    Returns:
        Dict with 'items' list. Each item has a 'caption_snippet' field.
    """
    # Step 1: Search
    search_result = search_instagram(topic, from_date, to_date, depth, token)
    items = search_result.get("items", [])

    if not items:
        return search_result

    # Step 2: Fetch captions for top N
    captions = fetch_captions(items, token, depth)

    # Step 3: Attach captions to items
    for item in items:
        vid = item["video_id"]
        caption = captions.get(vid)
        if caption:
            item["caption_snippet"] = caption

    return {"items": items, "error": search_result.get("error")}


def parse_instagram_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse Instagram search response to normalized format.

    Returns:
        List of item dicts ready for normalization.
    """
    return response.get("items", [])
