"""TikTok search via ScrapeCreators API for /last30days.

Uses ScrapeCreators REST API to search TikTok by keyword, extract engagement
metrics (views, likes, comments, shares), and fetch video transcripts.

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

SCRAPECREATORS_BASE = "https://api.scrapecreators.com/v1/tiktok"

# Depth configurations: how many results to fetch / captions to extract
DEPTH_CONFIG = {
    "quick":   {"results_per_page": 10, "max_captions": 3},
    "default": {"results_per_page": 20, "max_captions": 5},
    "deep":    {"results_per_page": 40, "max_captions": 8},
}

# Max words to keep from each caption
CAPTION_MAX_WORDS = 500

# Stopwords for relevance computation (shared with youtube_yt.py pattern)
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
    a TikTok-specific relevance boost. Floors at 0.1.
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
    """Extract core subject from verbose query for TikTok search.

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
        sys.stderr.write(f"[TikTok] {msg}\n")
        sys.stderr.flush()


def _sc_headers(token: str) -> Dict[str, str]:
    """Build ScrapeCreators request headers."""
    return {
        "x-api-key": token,
        "Content-Type": "application/json",
    }


def _parse_date(item: Dict[str, Any]) -> Optional[str]:
    """Parse date from ScrapeCreators TikTok item to YYYY-MM-DD.

    Handles create_time (unix timestamp).
    """
    ts = item.get("create_time")
    if ts:
        try:
            dt = datetime.fromtimestamp(int(ts), tz=timezone.utc)
            return dt.strftime("%Y-%m-%d")
        except (ValueError, TypeError, OSError):
            pass

    return None


def _clean_webvtt(text: str) -> str:
    """Strip WebVTT timestamps and headers from transcript text."""
    if not text:
        return ""
    lines = text.split('\n')
    cleaned = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith('WEBVTT'):
            continue
        if re.match(r'^\d{2}:\d{2}', line):
            continue
        if '-->' in line:
            continue
        cleaned.append(line)
    return ' '.join(cleaned)


def search_tiktok(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
    token: str = None,
) -> Dict[str, Any]:
    """Search TikTok via ScrapeCreators API.

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

    _log(f"Searching TikTok for '{core_topic}' (depth={depth}, count={config['results_per_page']})")

    try:
        resp = _requests.get(
            f"{SCRAPECREATORS_BASE}/search/keyword",
            params={"query": core_topic, "sort_by": "relevance"},
            headers=_sc_headers(token),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        _log(f"ScrapeCreators error: {e}")
        return {"items": [], "error": f"{type(e).__name__}: {e}"}

    # Items are nested under aweme_info
    raw_entries = data.get("search_item_list") or data.get("data") or []
    raw_items = []
    for entry in raw_entries:
        if isinstance(entry, dict):
            info = entry.get("aweme_info", entry)
            raw_items.append(info)

    # Limit to configured count
    raw_items = raw_items[:config["results_per_page"]]

    # Parse items
    items = []
    for raw in raw_items:
        video_id = str(raw.get("aweme_id", ""))
        text = raw.get("desc", "")
        stats = raw.get("statistics") or {}
        play_count = stats.get("play_count") or 0
        digg_count = stats.get("digg_count") or 0
        comment_count = stats.get("comment_count") or 0
        share_count = stats.get("share_count") or 0
        author = raw.get("author") or {}
        author_name = author.get("unique_id", "")
        share_url = raw.get("share_url", "")
        text_extra = raw.get("text_extra") or []
        hashtag_names = [t.get("hashtag_name", "") for t in text_extra
                         if isinstance(t, dict) and t.get("hashtag_name")]
        duration = (raw.get("video") or {}).get("duration")

        date_str = _parse_date(raw)

        # Compute relevance with hashtag boost
        relevance = _compute_relevance(core_topic, text, hashtag_names)

        # Build URL: prefer share_url, fallback to constructed URL
        url = share_url.split("?")[0] if share_url else ""
        if not url and author_name and video_id:
            url = f"https://www.tiktok.com/@{author_name}/video/{video_id}"

        items.append({
            "video_id": video_id,
            "text": text,
            "url": url,
            "author_name": author_name,
            "date": date_str,
            "engagement": {
                "views": play_count,
                "likes": digg_count,
                "comments": comment_count,
                "shares": share_count,
            },
            "hashtags": hashtag_names,
            "duration": duration,
            "relevance": relevance,
            "why_relevant": f"TikTok: {text[:60]}" if text else f"TikTok: {core_topic}",
            "caption_snippet": "",  # populated by fetch_captions
        })

    # Hard date filter
    in_range = [i for i in items if i["date"] and from_date <= i["date"] <= to_date]
    out_of_range = len(items) - len(in_range)
    if in_range:
        items = in_range
        if out_of_range:
            _log(f"Filtered {out_of_range} videos outside date range")
    else:
        _log(f"No videos within date range, keeping all {len(items)}")

    # Sort by views descending
    items.sort(key=lambda x: x["engagement"]["views"], reverse=True)

    _log(f"Found {len(items)} TikTok videos")
    return {"items": items}


def fetch_captions(
    video_items: List[Dict[str, Any]],
    token: str,
    depth: str = "default",
) -> Dict[str, str]:
    """Fetch transcripts for top N TikTok videos via ScrapeCreators.

    Strategy:
    1. Use the 'text' field (video description) as baseline caption
    2. For top N, call /video/transcript for spoken-word captions

    Args:
        video_items: Items from search_tiktok()
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
    _log(f"Enriching captions for {len(top_items)} videos")

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
                f"{SCRAPECREATORS_BASE}/video/transcript",
                params={"url": url},
                headers=_sc_headers(token),
                timeout=15,
            )
            if resp.status_code == 200:
                data = resp.json()
                transcript = data.get("transcript")
                if transcript:
                    if isinstance(transcript, list):
                        transcript = " ".join(str(s) for s in transcript)
                    transcript = _clean_webvtt(transcript)
                    if transcript:
                        words = transcript.split()
                        if len(words) > CAPTION_MAX_WORDS:
                            transcript = ' '.join(words[:CAPTION_MAX_WORDS]) + '...'
                        captions[vid] = transcript
        except Exception as e:
            _log(f"Transcript fetch failed for {vid}: {e}")

    got = sum(1 for v in captions.values() if v)
    _log(f"Got captions for {got}/{len(top_items)} videos")
    return captions


def search_and_enrich(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
    token: str = None,
) -> Dict[str, Any]:
    """Full TikTok search: find videos, then fetch captions for top results.

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
    search_result = search_tiktok(topic, from_date, to_date, depth, token)
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


def parse_tiktok_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse TikTok search response to normalized format.

    Returns:
        List of item dicts ready for normalization.
    """
    return response.get("items", [])
