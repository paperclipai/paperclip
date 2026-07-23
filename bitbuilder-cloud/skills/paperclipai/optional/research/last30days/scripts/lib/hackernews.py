"""Hacker News search via Algolia API (free, no auth required).

Uses hn.algolia.com/api/v1 for story discovery and comment enrichment.
No API key needed - just HTTP calls via stdlib urllib.
"""

import datetime
import html
import math
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional

import re

from . import http, log
from .query import extract_core_subject
from .relevance import token_overlap_relevance

# Common HN prefixes that can cause false-positive keyword matches
_HN_PREFIXES = re.compile(r"^(Tell HN|Show HN|Ask HN|Launch HN)\s*:\s*", re.IGNORECASE)

ALGOLIA_SEARCH_URL = "https://hn.algolia.com/api/v1/search"
ALGOLIA_SEARCH_BY_DATE_URL = "https://hn.algolia.com/api/v1/search_by_date"
ALGOLIA_ITEM_URL = "https://hn.algolia.com/api/v1/items"

DEPTH_CONFIG = {
    "quick": 15,
    "default": 30,
    "deep": 60,
}

ENRICH_LIMITS = {
    "quick": 3,
    "default": 5,
    "deep": 10,
}


def _log(msg: str):
    log.source_log("HN", msg)


def _date_to_unix(date_str: str) -> int:
    """Convert YYYY-MM-DD to Unix timestamp (start of day UTC)."""
    parts = date_str.split("-")
    year, month, day = int(parts[0]), int(parts[1]), int(parts[2])
    dt = datetime.datetime(year, month, day, tzinfo=datetime.timezone.utc)
    return int(dt.timestamp())


def _unix_to_date(ts: int) -> str:
    """Convert Unix timestamp to YYYY-MM-DD."""
    dt = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)
    return dt.strftime("%Y-%m-%d")


def _strip_html(text: str) -> str:
    """Strip HTML tags and decode entities from HN comment text."""
    import re
    text = html.unescape(text)
    text = re.sub(r'<p>', '\n', text)
    text = re.sub(r'<[^>]+>', '', text)
    return text.strip()


def search_hackernews(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
) -> Dict[str, Any]:
    """Search Hacker News via Algolia API.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD)
        depth: 'quick', 'default', or 'deep'

    Returns:
        Dict with Algolia response (contains 'hits' list).
    """
    count = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    from_ts = _date_to_unix(from_date)
    to_ts = _date_to_unix(to_date) + 86400  # Include the end date

    # Use extracted core subject instead of raw topic for cleaner Algolia matching
    core = extract_core_subject(topic)
    # Hyphens and commas tokenize awkwardly in Algolia; flatten them so themed
    # queries like "ts-bun-node" or "claude, personal agents" become plain words.
    core_flat = _flatten_query_for_algolia(core)
    _log(f"Searching for '{core_flat}' (raw: '{topic}', since {from_date}, count={count})")

    # Use relevance-sorted search with minimum engagement filter.
    # NOTE: restrictSearchableAttributes=title omitted intentionally — it would
    # miss Ask HN/Show HN threads where the topic appears in the body.
    params = {
        "query": core_flat,
        "tags": "story",
        "numericFilters": f"created_at_i>{from_ts},created_at_i<{to_ts},points>2",
        "hitsPerPage": str(count),
    }
    # Algolia defaults to AND across query tokens, so a 4-5 word theme query
    # matches no stories. Mark all-but-the-first token as optional so Algolia
    # ranks by how many tokens match instead of requiring every one.
    tokens = core_flat.split()
    if len(tokens) > 1:
        params["optionalWords"] = " ".join(tokens[1:])

    from urllib.parse import urlencode
    url = f"{ALGOLIA_SEARCH_URL}?{urlencode(params)}"

    try:
        response = http.request("GET", url, timeout=30)
    except http.HTTPError as e:
        _log(f"Search failed: {e}")
        return {"hits": [], "error": str(e)}
    except Exception as e:
        _log(f"Search failed: {e}")
        return {"hits": [], "error": str(e)}

    hits = response.get("hits", [])
    _log(f"Found {len(hits)} stories")
    return response


_WORD_BOUNDARY_RE_CACHE: Dict[str, "re.Pattern[str]"] = {}


def _flatten_query_for_algolia(text: str) -> str:
    """Normalise query for Algolia + post-filter comparison.

    Multi-keyword theme queries frequently contain commas (delimiters) or
    hyphens (compound terms like ``ts-bun-node``); both tokenize awkwardly.
    Flatten them to spaces and collapse runs of whitespace so the search
    parameter and the post-filter operate on the same shape.
    """
    return " ".join(text.replace(",", " ").replace("-", " ").split())


def _title_matches_query(title: str, query: str, author: str = "") -> bool:
    """Check if any query token appears as a whole word in the title.

    Returns True when the query is empty (no filter), or when at least one
    query token matches as a whole word in the title after stripping
    "Tell HN:", "Show HN:", "Ask HN:", "Launch HN:" prefixes.

    We previously required *every* token to appear (all-words), which killed
    every Algolia hit on multi-keyword themes like "claude, personal agents,
    agentic infra" because real HN titles never contain all five tokens
    verbatim. Relaxing to any-word matches Algolia's `optionalWords` behaviour
    in `search_hackernews`. Token-overlap relevance scoring at parse time
    demotes hits where only one weak token matched, so the loosened gate
    won't surface noise to the top of the ranking.

    Word-boundary matching (rather than naive substring) prevents short
    tokens like ``ai`` or ``ts`` from matching unrelated words like
    ``email`` or ``artists``.
    """
    if not query:
        return True
    stripped = _HN_PREFIXES.sub("", title).strip()
    check_text = stripped.lower()
    # Normalise the query the same way search_hackernews does so post-filter
    # tokens line up with what Algolia actually saw.
    query_words = [w for w in _flatten_query_for_algolia(query.lower()).split() if w]
    if not query_words:
        return True
    for word in query_words:
        pattern = _WORD_BOUNDARY_RE_CACHE.get(word)
        if pattern is None:
            pattern = re.compile(rf"\b{re.escape(word)}\b")
            _WORD_BOUNDARY_RE_CACHE[word] = pattern
        if pattern.search(check_text):
            return True
    return False


def parse_hackernews_response(response: Dict[str, Any], query: str = "") -> List[Dict[str, Any]]:
    """Parse Algolia response into normalized item dicts.

    Args:
        response: Algolia search response
        query: Original search query for token-overlap relevance scoring

    Returns:
        List of item dicts ready for normalization.
    """
    hits = response.get("hits", [])
    # Post-filter: remove items where query only matched an HN prefix like "Tell HN:"
    if query:
        before = len(hits)
        hits = [
            h for h in hits
            if _title_matches_query(h.get("title", ""), query, h.get("author", ""))
        ]
        dropped = before - len(hits)
        if dropped:
            _log(f"Prefix filter removed {dropped}/{before} false-positive hits for '{query}'")
    items = []

    for i, hit in enumerate(hits):
        object_id = hit.get("objectID", "")
        points = hit.get("points") or 0
        num_comments = hit.get("num_comments") or 0
        created_at_i = hit.get("created_at_i")

        date_str = None
        if created_at_i:
            date_str = _unix_to_date(created_at_i)

        # Article URL vs HN discussion URL
        article_url = hit.get("url") or ""
        hn_url = f"https://news.ycombinator.com/item?id={object_id}"

        # Relevance: blend Algolia rank with token-overlap content matching
        rank_score = max(0.3, 1.0 - (i * 0.02))  # 1.0 -> 0.3 over 35 items
        engagement_boost = min(0.2, math.log1p(points) / 40)
        if query:
            content_score = token_overlap_relevance(query, hit.get("title", ""))
            relevance = min(1.0, 0.6 * rank_score + 0.4 * content_score + engagement_boost)
        else:
            relevance = min(1.0, rank_score * 0.7 + engagement_boost + 0.1)

        items.append({
            "id": object_id,
            "title": hit.get("title", ""),
            "url": article_url,
            "hn_url": hn_url,
            "author": hit.get("author", ""),
            "date": date_str,
            "engagement": {
                "points": points,
                "comments": num_comments,
            },
            "relevance": round(relevance, 2),
            "why_relevant": f"HN story about {hit.get('title', 'topic')[:60]}",
        })

    return items


def _fetch_item_comments(object_id: str, max_comments: int = 5) -> Dict[str, Any]:
    """Fetch top-level comments for a story from Algolia items endpoint.

    Args:
        object_id: HN story ID
        max_comments: Max comments to return

    Returns:
        Dict with 'comments' list and 'comment_insights' list.
    """
    url = f"{ALGOLIA_ITEM_URL}/{object_id}"

    try:
        data = http.request("GET", url, timeout=15)
    except Exception as e:
        _log(f"Failed to fetch comments for {object_id}: {e}")
        return {"comments": [], "comment_insights": []}

    children = data.get("children", [])

    # Sort by points (highest first), filter to actual comments
    real_comments = [
        c for c in children
        if c.get("text") and c.get("author")
    ]
    real_comments.sort(key=lambda c: c.get("points") or 0, reverse=True)

    comments = []
    insights = []
    for c in real_comments[:max_comments]:
        text = _strip_html(c.get("text", ""))
        excerpt = text[:300] + "..." if len(text) > 300 else text
        comments.append({
            "author": c.get("author", ""),
            "text": excerpt,
            "points": c.get("points") or 0,
        })
        # First sentence as insight
        first_sentence = text.split(". ")[0].split("\n")[0][:200]
        if first_sentence:
            insights.append(first_sentence)

    return {"comments": comments, "comment_insights": insights}


def enrich_top_stories(
    items: List[Dict[str, Any]],
    depth: str = "default",
) -> List[Dict[str, Any]]:
    """Fetch comments for top N stories by points.

    Args:
        items: Parsed HN items
        depth: Research depth (controls how many to enrich)

    Returns:
        Items with top_comments and comment_insights added.
    """
    if not items:
        return items

    limit = ENRICH_LIMITS.get(depth, ENRICH_LIMITS["default"])

    # Sort by points to enrich the most popular stories
    by_points = sorted(
        range(len(items)),
        key=lambda i: items[i].get("engagement", {}).get("points", 0),
        reverse=True,
    )
    to_enrich = by_points[:limit]

    _log(f"Enriching top {len(to_enrich)} stories with comments")

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {
            executor.submit(
                _fetch_item_comments,
                items[idx]["id"],
            ): idx
            for idx in to_enrich
        }

        for future in as_completed(futures):
            idx = futures[future]
            try:
                result = future.result(timeout=15)
                items[idx]["top_comments"] = result["comments"]
                items[idx]["comment_insights"] = result["comment_insights"]
            except (KeyError, TypeError, OSError) as exc:
                _log(f"Comment enrichment failed for story {items[idx].get('id', '?')}: {type(exc).__name__}: {exc}")
                items[idx]["top_comments"] = []
                items[idx]["comment_insights"] = []

    return items
