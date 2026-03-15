"""Brave Search web search for last30days skill.

Uses the Brave Search API as a fallback web search backend.
Simple, cheap (free tier: 2,000 queries/month), widely available.

API docs: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
"""

import html
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode, urlparse

from . import http

ENDPOINT = "https://api.search.brave.com/res/v1/web/search"

# Freshness codes: pd=24h, pw=7d, pm=31d
FRESHNESS_MAP = {1: "pd", 7: "pw", 31: "pm"}

# Domains to exclude (handled by Reddit/X search)
EXCLUDED_DOMAINS = {
    "reddit.com", "www.reddit.com", "old.reddit.com",
    "twitter.com", "www.twitter.com", "x.com", "www.x.com",
}


def search_web(
    topic: str,
    from_date: str,
    to_date: str,
    api_key: str,
    depth: str = "default",
) -> List[Dict[str, Any]]:
    """Search the web via Brave Search API.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD)
        api_key: Brave Search API key
        depth: 'quick', 'default', or 'deep'

    Returns:
        List of result dicts with keys: url, title, snippet, source_domain, date, relevance

    Raises:
        http.HTTPError: On API errors
    """
    count = {"quick": 8, "default": 15, "deep": 25}.get(depth, 15)

    # Calculate days for freshness filter
    days = _days_between(from_date, to_date)
    freshness = _brave_freshness(days)

    params = {
        "q": topic,
        "result_filter": "web,news",
        "count": count,
        "safesearch": "strict",
        "text_decorations": 0,
        "spellcheck": 0,
    }
    if freshness:
        params["freshness"] = freshness

    url = f"{ENDPOINT}?{urlencode(params)}"

    sys.stderr.write(f"[Web] Searching Brave for: {topic}\n")
    sys.stderr.flush()

    response = http.request(
        "GET",
        url,
        headers={"X-Subscription-Token": api_key},
        timeout=15,
    )

    return _normalize_results(response, from_date, to_date)


def _days_between(from_date: str, to_date: str) -> int:
    """Calculate days between two YYYY-MM-DD dates."""
    try:
        d1 = datetime.strptime(from_date, "%Y-%m-%d")
        d2 = datetime.strptime(to_date, "%Y-%m-%d")
        return max(1, (d2 - d1).days)
    except (ValueError, TypeError):
        return 30


def _brave_freshness(days: Optional[int]) -> Optional[str]:
    """Convert days to Brave freshness parameter.

    Uses canned codes for <=31d, explicit date range for longer periods.
    """
    if days is None:
        return None
    code = next((v for d, v in sorted(FRESHNESS_MAP.items()) if days <= d), None)
    if code:
        return code
    start = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    end = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return f"{start}to{end}"


def _normalize_results(
    response: Dict[str, Any],
    from_date: str,
    to_date: str,
) -> List[Dict[str, Any]]:
    """Convert Brave Search response to websearch item schema.

    Merges news + web results, cleans HTML entities, filters excluded domains.
    """
    items = []

    # Merge news results (tend to be more recent) with web results
    raw_results = (
        response.get("news", {}).get("results", []) +
        response.get("web", {}).get("results", [])
    )

    for i, result in enumerate(raw_results):
        if not isinstance(result, dict):
            continue

        url = result.get("url", "")
        if not url:
            continue

        # Skip excluded domains
        try:
            domain = urlparse(url).netloc.lower()
            if domain in EXCLUDED_DOMAINS:
                continue
            if domain.startswith("www."):
                domain = domain[4:]
        except Exception:
            domain = ""

        title = _clean_html(str(result.get("title", "")).strip())
        snippet = _clean_html(str(result.get("description", "")).strip())

        if not title and not snippet:
            continue

        # Parse date from Brave's 'age' field or 'page_age'
        date = _parse_brave_date(result.get("age"), result.get("page_age"))
        date_confidence = "med" if date else "low"

        items.append({
            "id": f"W{i+1}",
            "title": title[:200],
            "url": url,
            "source_domain": domain,
            "snippet": snippet[:500],
            "date": date,
            "date_confidence": date_confidence,
            "relevance": 0.6,  # Brave doesn't provide relevance scores
            "why_relevant": "",
        })

    sys.stderr.write(f"[Web] Brave: {len(items)} results\n")
    sys.stderr.flush()

    return items


def _clean_html(text: str) -> str:
    """Remove HTML tags and decode entities."""
    text = re.sub(r"<[^>]*>", "", text)
    text = html.unescape(text)
    return text


def _parse_brave_date(age: Optional[str], page_age: Optional[str]) -> Optional[str]:
    """Parse Brave's age/page_age fields to YYYY-MM-DD.

    Brave returns dates like "3 hours ago", "2 days ago", "January 24, 2026".
    """
    text = age or page_age
    if not text:
        return None

    text_lower = text.lower().strip()
    now = datetime.now()

    # "X hours ago" -> today
    if re.search(r'\d+\s*hours?\s*ago', text_lower):
        return now.strftime("%Y-%m-%d")

    # "X days ago"
    match = re.search(r'(\d+)\s*days?\s*ago', text_lower)
    if match:
        days = int(match.group(1))
        if days <= 60:
            return (now - timedelta(days=days)).strftime("%Y-%m-%d")

    # "X weeks ago"
    match = re.search(r'(\d+)\s*weeks?\s*ago', text_lower)
    if match:
        weeks = int(match.group(1))
        return (now - timedelta(weeks=weeks)).strftime("%Y-%m-%d")

    # ISO format: 2026-01-24T...
    match = re.search(r'(\d{4}-\d{2}-\d{2})', text)
    if match:
        return match.group(1)

    return None
