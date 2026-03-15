"""Reddit search via ScrapeCreators API for /last30days.

Uses ScrapeCreators REST API to search Reddit globally, discover relevant
subreddits, run targeted subreddit searches, and fetch comment trees.

Replaces openai_reddit.py as the primary Reddit search backend.
Falls back to openai_reddit.py if SCRAPECREATORS_API_KEY is missing but
OPENAI_API_KEY is present.

Requires SCRAPECREATORS_API_KEY in config (same key as TikTok + Instagram).
API docs: https://scrapecreators.com/docs
"""

import re
import sys
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

try:
    import requests as _requests
except ImportError:
    _requests = None

from . import http

SCRAPECREATORS_BASE = "https://api.scrapecreators.com/v1/reddit"

# Depth configurations: how many API calls per phase
DEPTH_CONFIG = {
    "quick": {
        "global_searches": 1,
        "subreddit_searches": 2,
        "comment_enrichments": 3,
        "timeframe": "week",
    },
    "default": {
        "global_searches": 2,
        "subreddit_searches": 3,
        "comment_enrichments": 5,
        "timeframe": "month",
    },
    "deep": {
        "global_searches": 3,
        "subreddit_searches": 5,
        "comment_enrichments": 8,
        "timeframe": "month",
    },
}

# Stopwords for query extraction
NOISE_WORDS = frozenset({
    'best', 'top', 'good', 'great', 'awesome', 'killer',
    'latest', 'new', 'news', 'update', 'updates',
    'trending', 'hottest', 'popular',
    'practices', 'features', 'tips',
    'recommendations', 'advice',
    'prompt', 'prompts', 'prompting',
    'methods', 'strategies', 'approaches',
    'how', 'to', 'the', 'a', 'an', 'for', 'with',
    'of', 'in', 'on', 'is', 'are', 'what', 'which',
    'guide', 'tutorial', 'using',
})


def _log(msg: str):
    """Log to stderr."""
    sys.stderr.write(f"[Reddit] {msg}\n")
    sys.stderr.flush()


def _sc_headers(token: str) -> Dict[str, str]:
    """Build ScrapeCreators request headers."""
    return {
        "x-api-key": token,
        "Content-Type": "application/json",
    }


def _extract_core_subject(topic: str) -> str:
    """Extract core subject from verbose query.

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

    words = text.split()
    filtered = [w for w in words if w not in NOISE_WORDS]

    result = ' '.join(filtered) if filtered else text
    return result.rstrip('?!.')


def expand_reddit_queries(topic: str, depth: str) -> List[str]:
    """Generate multiple Reddit search queries from a topic.

    Uses local logic (no LLM call needed):
    1. Extract core subject (strip noise words)
    2. Include original topic if different from core
    3. For default/deep: add casual/review variant
    4. For deep: add problem/issues variant

    Returns 1-4 query strings depending on depth.
    """
    core = _extract_core_subject(topic)
    queries = [core]

    # Broader variant: include more context from original topic
    original_clean = topic.strip().rstrip('?!.')
    if core.lower() != original_clean.lower() and len(original_clean.split()) <= 8:
        queries.append(original_clean)

    if depth in ("default", "deep"):
        queries.append(f"{core} worth it OR thoughts OR review")

    if depth == "deep":
        queries.append(f"{core} issues OR problems OR bug OR broken")

    return queries


# Known utility/meta subreddits that match queries but aren't discussion subs.
# These get a 0.3x penalty (not banned) in subreddit discovery scoring.
UTILITY_SUBS = frozenset({
    'namethatsong', 'findthatsong', 'tipofmytongue',
    'whatisthissong', 'helpmefind', 'whatisthisthing',
    'whatsthissong', 'findareddit', 'subredditdrama',
})


def discover_subreddits(
    results: List[Dict[str, Any]],
    topic: str = "",
    max_subs: int = 5,
) -> List[str]:
    """Extract top subreddits from global search results with relevance weighting.

    Uses frequency + topic-word matching + utility-sub penalties + engagement
    bonus to find discussion subs rather than utility/meta subs.

    Args:
        results: List of post dicts from global search
        topic: Original search topic (for relevance matching)
        max_subs: Maximum subreddits to return

    Returns:
        Top subreddit names sorted by weighted score
    """
    core = _extract_core_subject(topic) if topic else ""
    core_words = set(core.lower().split()) if core else set()

    scores = Counter()
    for post in results:
        sub = post.get("subreddit", "")
        if not sub:
            continue

        # Base: frequency count
        base = 1.0

        # Bonus: subreddit name contains a core topic word
        sub_lower = sub.lower()
        if core_words and any(w in sub_lower for w in core_words if len(w) > 2):
            base += 2.0

        # Penalty: known utility/meta subreddits
        if sub_lower in UTILITY_SUBS:
            base *= 0.3

        # Bonus: post engagement (high-engagement posts = better sub)
        ups = post.get("ups") or post.get("score", 0)
        if ups and ups > 100:
            base += 0.5

        scores[sub] += base

    return [sub for sub, _ in scores.most_common(max_subs)]


def _parse_date(created_utc) -> Optional[str]:
    """Convert Unix timestamp to YYYY-MM-DD."""
    if not created_utc:
        return None
    try:
        dt = datetime.fromtimestamp(float(created_utc), tz=timezone.utc)
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError, OSError):
        return None


def _normalize_post(post: Dict[str, Any], idx: int, source_label: str = "global") -> Dict[str, Any]:
    """Normalize a ScrapeCreators Reddit post to our internal format."""
    permalink = post.get("permalink", "")
    url = f"https://www.reddit.com{permalink}" if permalink else post.get("url", "")

    # Ensure URL looks like a Reddit thread
    if url and "reddit.com" not in url:
        url = ""

    return {
        "id": f"R{idx}",
        "reddit_id": post.get("id", ""),
        "title": str(post.get("title", "")).strip(),
        "url": url,
        "subreddit": str(post.get("subreddit", "")).strip(),
        "date": _parse_date(post.get("created_utc")),
        "engagement": {
            "score": post.get("ups") or post.get("score", 0),
            "num_comments": post.get("num_comments", 0),
            "upvote_ratio": post.get("upvote_ratio"),
        },
        "relevance": 0.7,
        "why_relevant": f"Reddit {source_label} search",
        "selftext": str(post.get("selftext", ""))[:500],
    }


def _global_search(
    query: str,
    token: str,
    sort: str = "relevance",
    timeframe: str = "month",
) -> List[Dict[str, Any]]:
    """Search across all of Reddit via ScrapeCreators global search.

    Args:
        query: Search query
        token: ScrapeCreators API key
        sort: Sort order (relevance, hot, top, new)
        timeframe: Time filter (hour, day, week, month, year, all)

    Returns:
        List of post dicts
    """
    if not _requests:
        _log("requests library not installed, falling back to urllib")
        # Use stdlib http module as fallback
        try:
            from urllib.parse import urlencode
            params = urlencode({"query": query, "sort": sort, "timeframe": timeframe})
            url = f"{SCRAPECREATORS_BASE}/search?{params}"
            headers = _sc_headers(token)
            headers["User-Agent"] = http.USER_AGENT
            data = http.get(url, headers=headers, timeout=30, retries=2)
            return data.get("posts", data.get("data", []))
        except Exception as e:
            _log(f"Global search error (urllib): {e}")
            return []

    try:
        resp = _requests.get(
            f"{SCRAPECREATORS_BASE}/search",
            params={"query": query, "sort": sort, "timeframe": timeframe},
            headers=_sc_headers(token),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("posts", data.get("data", []))
    except Exception as e:
        _log(f"Global search error: {e}")
        return []


def _subreddit_search(
    subreddit: str,
    query: str,
    token: str,
    sort: str = "relevance",
    timeframe: str = "month",
) -> List[Dict[str, Any]]:
    """Search within a specific subreddit via ScrapeCreators.

    Args:
        subreddit: Subreddit name (without r/)
        query: Search query
        token: ScrapeCreators API key
        sort: Sort order
        timeframe: Time filter

    Returns:
        List of post dicts
    """
    if not _requests:
        try:
            from urllib.parse import urlencode
            params = urlencode({
                "subreddit": subreddit, "query": query,
                "sort": sort, "timeframe": timeframe,
            })
            url = f"{SCRAPECREATORS_BASE}/subreddit/search?{params}"
            headers = _sc_headers(token)
            headers["User-Agent"] = http.USER_AGENT
            data = http.get(url, headers=headers, timeout=30, retries=2)
            return data.get("posts", data.get("data", []))
        except Exception as e:
            _log(f"Subreddit search error (urllib) for r/{subreddit}: {e}")
            return []

    try:
        resp = _requests.get(
            f"{SCRAPECREATORS_BASE}/subreddit/search",
            params={
                "subreddit": subreddit,
                "query": query,
                "sort": sort,
                "timeframe": timeframe,
            },
            headers=_sc_headers(token),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("posts", data.get("data", []))
    except Exception as e:
        _log(f"Subreddit search error for r/{subreddit}: {e}")
        return []


def fetch_post_comments(
    url: str,
    token: str,
) -> List[Dict[str, Any]]:
    """Fetch comments for a Reddit post via ScrapeCreators.

    Args:
        url: Reddit post URL or permalink
        token: ScrapeCreators API key

    Returns:
        List of comment dicts with score, author, body, etc.
    """
    if not _requests:
        try:
            from urllib.parse import urlencode
            params = urlencode({"url": url})
            api_url = f"{SCRAPECREATORS_BASE}/post/comments?{params}"
            headers = _sc_headers(token)
            headers["User-Agent"] = http.USER_AGENT
            data = http.get(api_url, headers=headers, timeout=30, retries=2)
            return data.get("comments", data.get("data", []))
        except Exception as e:
            _log(f"Comment fetch error (urllib): {e}")
            return []

    try:
        resp = _requests.get(
            f"{SCRAPECREATORS_BASE}/post/comments",
            params={"url": url},
            headers=_sc_headers(token),
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("comments", data.get("data", []))
    except Exception as e:
        _log(f"Comment fetch error: {e}")
        return []


def _dedupe_posts(posts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Deduplicate posts by reddit_id, keeping first occurrence."""
    seen_ids = set()
    seen_urls = set()
    unique = []
    for post in posts:
        rid = post.get("reddit_id", "")
        url = post.get("url", "")
        if rid and rid in seen_ids:
            continue
        if url and url in seen_urls:
            continue
        if rid:
            seen_ids.add(rid)
        if url:
            seen_urls.add(url)
        unique.append(post)
    return unique


def search_reddit(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
    token: str = None,
) -> Dict[str, Any]:
    """Full Reddit search: multi-query global discovery + subreddit drill-down.

    This is the main entry point. Replaces openai_reddit.search_reddit().

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

    config = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    timeframe = config["timeframe"]

    # === Phase 1: Query Expansion ===
    queries = expand_reddit_queries(topic, depth)
    _log(f"Expanded '{topic}' into {len(queries)} queries: {queries}")

    # === Phase 2: Global Discovery ===
    all_raw_posts = []
    max_global = config["global_searches"]

    for i, query in enumerate(queries[:max_global]):
        sort = "relevance" if i == 0 else "top"
        _log(f"Global search {i+1}/{max_global}: '{query}' (sort={sort})")
        posts = _global_search(query, token, sort=sort, timeframe=timeframe)
        _log(f"  -> {len(posts)} results")
        all_raw_posts.extend(posts)

    # Normalize all posts
    all_items = []
    for i, post in enumerate(all_raw_posts):
        item = _normalize_post(post, i + 1, "global")
        all_items.append(item)

    # === Phase 3: Subreddit Discovery + Targeted Search ===
    discovered_subs = discover_subreddits(all_raw_posts, topic=topic, max_subs=config["subreddit_searches"])
    _log(f"Discovered subreddits: {discovered_subs}")

    core = _extract_core_subject(topic)
    for sub in discovered_subs[:config["subreddit_searches"]]:
        _log(f"Subreddit search: r/{sub} for '{core}'")
        sub_posts = _subreddit_search(sub, core, token, sort="relevance", timeframe=timeframe)
        _log(f"  -> {len(sub_posts)} results from r/{sub}")
        for j, post in enumerate(sub_posts):
            item = _normalize_post(post, len(all_items) + j + 1, f"r/{sub}")
            all_items.append(item)

    # === Phase 4: Deduplicate ===
    all_items = _dedupe_posts(all_items)
    _log(f"After dedup: {len(all_items)} unique posts")

    # === Phase 5: Date filter ===
    in_range = []
    out_of_range = 0
    for item in all_items:
        if item["date"] and from_date <= item["date"] <= to_date:
            in_range.append(item)
        elif item["date"] is None:
            in_range.append(item)  # Keep unknown dates
        else:
            out_of_range += 1

    if in_range:
        all_items = in_range
        if out_of_range:
            _log(f"Filtered {out_of_range} posts outside date range")
    else:
        _log(f"No posts within date range, keeping all {len(all_items)}")

    # === Phase 6: Sort by engagement ===
    all_items.sort(
        key=lambda x: (x.get("engagement", {}).get("score", 0) or 0),
        reverse=True,
    )

    # Re-index IDs
    for i, item in enumerate(all_items):
        item["id"] = f"R{i+1}"

    _log(f"Final: {len(all_items)} Reddit posts")
    return {"items": all_items}


def enrich_with_comments(
    items: List[Dict[str, Any]],
    token: str,
    depth: str = "default",
) -> List[Dict[str, Any]]:
    """Enrich top items with comment data from ScrapeCreators.

    Args:
        items: Reddit items from search_reddit()
        token: ScrapeCreators API key
        depth: Depth for comment limit

    Returns:
        Items with top_comments and comment_insights added.
    """
    config = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    max_comments = config["comment_enrichments"]

    if not items or not token:
        return items

    top_items = items[:max_comments]
    _log(f"Enriching comments for {len(top_items)} posts")

    for item in top_items:
        url = item.get("url", "")
        if not url:
            continue

        raw_comments = fetch_post_comments(url, token)
        if not raw_comments:
            continue

        # Parse comments into our format
        top_comments = []
        insights = []

        for ci, c in enumerate(raw_comments[:10]):  # Take top 10 comments
            body = c.get("body", "")
            if not body or body in ("[deleted]", "[removed]"):
                continue

            score = c.get("ups") or c.get("score", 0)
            author = c.get("author", "[deleted]")
            permalink = c.get("permalink", "")
            comment_url = f"https://reddit.com{permalink}" if permalink else ""

            # Top comment gets more room (400 chars) — funny/clever comments need it
            max_excerpt = 400 if ci == 0 else 300
            top_comments.append({
                "score": score,
                "date": _parse_date(c.get("created_utc")),
                "author": author,
                "excerpt": body[:max_excerpt],
                "url": comment_url,
            })

            # Extract insights from substantive comments
            if len(body) >= 30 and author not in ("[deleted]", "[removed]", "AutoModerator"):
                insight = body[:150]
                if len(body) > 150:
                    for i, char in enumerate(insight):
                        if char in '.!?' and i > 50:
                            insight = insight[:i+1]
                            break
                    else:
                        insight = insight.rstrip() + "..."
                insights.append(insight)

        # Sort comments by score
        top_comments.sort(key=lambda c: c.get("score", 0), reverse=True)

        item["top_comments"] = top_comments[:10]
        item["comment_insights"] = insights[:10]

    return items


def search_and_enrich(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
    token: str = None,
) -> Dict[str, Any]:
    """Full Reddit pipeline: search + comment enrichment.

    This is the convenience function that does everything.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD)
        depth: 'quick', 'default', or 'deep'
        token: ScrapeCreators API key

    Returns:
        Dict with 'items' list. Items include top_comments and comment_insights.
    """
    result = search_reddit(topic, from_date, to_date, depth, token)
    items = result.get("items", [])

    if items and token:
        items = enrich_with_comments(items, token, depth)
        result["items"] = items

    return result


def parse_reddit_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse ScrapeCreators response to item list.

    Compatibility shim matching openai_reddit.parse_reddit_response() signature.
    """
    return response.get("items", [])
