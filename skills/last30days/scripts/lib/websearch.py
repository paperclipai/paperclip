"""WebSearch module for last30days skill.

NOTE: WebSearch uses the assistant's built-in web search tool, which runs inside the host environment.
Unlike Reddit/X which use external APIs, web search results are obtained by the assistant
directly and passed to this module for normalization and scoring.

The typical flow is:
1. The assistant invokes its web search tool with the topic
2. The assistant passes results to parse_websearch_results()
3. Results are normalized into WebSearchItem objects
"""

import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from . import schema


# Month name mappings for date parsing
MONTH_MAP = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}


def extract_date_from_url(url: str) -> Optional[str]:
    """Try to extract a date from URL path.

    Many sites embed dates in URLs like:
    - /2026/01/24/article-title
    - /2026-01-24/article
    - /blog/20260124/title

    Args:
        url: URL to parse

    Returns:
        Date string in YYYY-MM-DD format, or None
    """
    # Pattern 1: /YYYY/MM/DD/ (most common)
    match = re.search(r'/(\d{4})/(\d{2})/(\d{2})/', url)
    if match:
        year, month, day = match.groups()
        if 2020 <= int(year) <= 2030 and 1 <= int(month) <= 12 and 1 <= int(day) <= 31:
            return f"{year}-{month}-{day}"

    # Pattern 2: /YYYY-MM-DD/ or /YYYY-MM-DD-
    match = re.search(r'/(\d{4})-(\d{2})-(\d{2})[-/]', url)
    if match:
        year, month, day = match.groups()
        if 2020 <= int(year) <= 2030 and 1 <= int(month) <= 12 and 1 <= int(day) <= 31:
            return f"{year}-{month}-{day}"

    # Pattern 3: /YYYYMMDD/ (compact)
    match = re.search(r'/(\d{4})(\d{2})(\d{2})/', url)
    if match:
        year, month, day = match.groups()
        if 2020 <= int(year) <= 2030 and 1 <= int(month) <= 12 and 1 <= int(day) <= 31:
            return f"{year}-{month}-{day}"

    return None


def extract_date_from_snippet(text: str) -> Optional[str]:
    """Try to extract a date from text snippet or title.

    Looks for patterns like:
    - January 24, 2026 or Jan 24, 2026
    - 24 January 2026
    - 2026-01-24
    - "3 days ago", "yesterday", "last week"

    Args:
        text: Text to parse

    Returns:
        Date string in YYYY-MM-DD format, or None
    """
    if not text:
        return None

    text_lower = text.lower()

    # Pattern 1: Month DD, YYYY (e.g., "January 24, 2026")
    match = re.search(
        r'\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|'
        r'jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
        r'\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b',
        text_lower
    )
    if match:
        month_str, day, year = match.groups()
        month = MONTH_MAP.get(month_str[:3])
        if month and 2020 <= int(year) <= 2030 and 1 <= int(day) <= 31:
            return f"{year}-{month:02d}-{int(day):02d}"

    # Pattern 2: DD Month YYYY (e.g., "24 January 2026")
    match = re.search(
        r'\b(\d{1,2})(?:st|nd|rd|th)?\s+'
        r'(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|'
        r'jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
        r'\s+(\d{4})\b',
        text_lower
    )
    if match:
        day, month_str, year = match.groups()
        month = MONTH_MAP.get(month_str[:3])
        if month and 2020 <= int(year) <= 2030 and 1 <= int(day) <= 31:
            return f"{year}-{month:02d}-{int(day):02d}"

    # Pattern 3: YYYY-MM-DD (ISO format)
    match = re.search(r'\b(\d{4})-(\d{2})-(\d{2})\b', text)
    if match:
        year, month, day = match.groups()
        if 2020 <= int(year) <= 2030 and 1 <= int(month) <= 12 and 1 <= int(day) <= 31:
            return f"{year}-{month}-{day}"

    # Pattern 4: Relative dates ("3 days ago", "yesterday", etc.)
    today = datetime.now()

    if "yesterday" in text_lower:
        date = today - timedelta(days=1)
        return date.strftime("%Y-%m-%d")

    if "today" in text_lower:
        return today.strftime("%Y-%m-%d")

    # "N days ago"
    match = re.search(r'\b(\d+)\s*days?\s*ago\b', text_lower)
    if match:
        days = int(match.group(1))
        if days <= 60:  # Reasonable range
            date = today - timedelta(days=days)
            return date.strftime("%Y-%m-%d")

    # "N hours ago" -> today
    match = re.search(r'\b(\d+)\s*hours?\s*ago\b', text_lower)
    if match:
        return today.strftime("%Y-%m-%d")

    # "last week" -> ~7 days ago
    if "last week" in text_lower:
        date = today - timedelta(days=7)
        return date.strftime("%Y-%m-%d")

    # "this week" -> ~3 days ago (middle of week)
    if "this week" in text_lower:
        date = today - timedelta(days=3)
        return date.strftime("%Y-%m-%d")

    return None


def extract_date_signals(
    url: str,
    snippet: str,
    title: str,
) -> Tuple[Optional[str], str]:
    """Extract date from any available signal.

    Tries URL first (most reliable), then snippet, then title.

    Args:
        url: Page URL
        snippet: Page snippet/description
        title: Page title

    Returns:
        Tuple of (date_string, confidence)
        - date from URL: 'high' confidence
        - date from snippet/title: 'med' confidence
        - no date found: None, 'low' confidence
    """
    # Try URL first (most reliable)
    url_date = extract_date_from_url(url)
    if url_date:
        return url_date, "high"

    # Try snippet
    snippet_date = extract_date_from_snippet(snippet)
    if snippet_date:
        return snippet_date, "med"

    # Try title
    title_date = extract_date_from_snippet(title)
    if title_date:
        return title_date, "med"

    return None, "low"


# Domains to exclude (Reddit and X are handled separately)
EXCLUDED_DOMAINS = {
    "reddit.com",
    "www.reddit.com",
    "old.reddit.com",
    "twitter.com",
    "www.twitter.com",
    "x.com",
    "www.x.com",
    "mobile.twitter.com",
}


def extract_domain(url: str) -> str:
    """Extract the domain from a URL.

    Args:
        url: Full URL

    Returns:
        Domain string (e.g., "medium.com")
    """
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        # Remove www. prefix for cleaner display
        if domain.startswith("www."):
            domain = domain[4:]
        return domain
    except Exception:
        return ""


def is_excluded_domain(url: str) -> bool:
    """Check if URL is from an excluded domain (Reddit/X).

    Args:
        url: URL to check

    Returns:
        True if URL should be excluded
    """
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        return domain in EXCLUDED_DOMAINS
    except Exception:
        return False


def parse_websearch_results(
    results: List[Dict[str, Any]],
    topic: str,
    from_date: str = "",
    to_date: str = "",
) -> List[Dict[str, Any]]:
    """Parse WebSearch results into normalized format.

    This function expects results from Claude's WebSearch tool.
    Each result should have: title, url, snippet, and optionally date/relevance.

    Uses "Date Detective" approach:
    1. Extract dates from URLs (high confidence)
    2. Extract dates from snippets/titles (med confidence)
    3. Hard filter: exclude items with verified old dates
    4. Keep items with no date signals (with low confidence penalty)

    Args:
        results: List of WebSearch result dicts
        topic: Original search topic (for context)
        from_date: Start date for filtering (YYYY-MM-DD)
        to_date: End date for filtering (YYYY-MM-DD)

    Returns:
        List of normalized item dicts ready for WebSearchItem creation
    """
    items = []

    for i, result in enumerate(results):
        if not isinstance(result, dict):
            continue

        url = result.get("url", "")
        if not url:
            continue

        # Skip Reddit/X URLs (handled separately)
        if is_excluded_domain(url):
            continue

        title = str(result.get("title", "")).strip()
        snippet = str(result.get("snippet", result.get("description", ""))).strip()

        if not title and not snippet:
            continue

        # Use Date Detective to extract date signals
        date = result.get("date")  # Use provided date if available
        date_confidence = "low"

        if date and re.match(r'^\d{4}-\d{2}-\d{2}$', str(date)):
            # Provided date is valid
            date_confidence = "med"
        else:
            # Try to extract date from URL/snippet/title
            extracted_date, confidence = extract_date_signals(url, snippet, title)
            if extracted_date:
                date = extracted_date
                date_confidence = confidence

        # Hard filter: if we found a date and it's too old, skip
        if date and from_date and date < from_date:
            continue  # DROP - verified old content

        # Hard filter: if date is in the future, skip (parsing error)
        if date and to_date and date > to_date:
            continue  # DROP - future date

        # Get relevance if provided, default to 0.5
        relevance = result.get("relevance", 0.5)
        try:
            relevance = min(1.0, max(0.0, float(relevance)))
        except (TypeError, ValueError):
            relevance = 0.5

        item = {
            "id": f"W{i+1}",
            "title": title[:200],  # Truncate long titles
            "url": url,
            "source_domain": extract_domain(url),
            "snippet": snippet[:500],  # Truncate long snippets
            "date": date,
            "date_confidence": date_confidence,
            "relevance": relevance,
            "why_relevant": str(result.get("why_relevant", "")).strip(),
        }

        items.append(item)

    return items


def normalize_websearch_items(
    items: List[Dict[str, Any]],
    from_date: str,
    to_date: str,
) -> List[schema.WebSearchItem]:
    """Convert parsed dicts to WebSearchItem objects.

    Args:
        items: List of parsed item dicts
        from_date: Start of date range (YYYY-MM-DD)
        to_date: End of date range (YYYY-MM-DD)

    Returns:
        List of WebSearchItem objects
    """
    result = []

    for item in items:
        web_item = schema.WebSearchItem(
            id=item["id"],
            title=item["title"],
            url=item["url"],
            source_domain=item["source_domain"],
            snippet=item["snippet"],
            date=item.get("date"),
            date_confidence=item.get("date_confidence", "low"),
            relevance=item.get("relevance", 0.5),
            why_relevant=item.get("why_relevant", ""),
        )
        result.append(web_item)

    return result


def dedupe_websearch(items: List[schema.WebSearchItem]) -> List[schema.WebSearchItem]:
    """Remove duplicate WebSearch items.

    Deduplication is based on URL.

    Args:
        items: List of WebSearchItem objects

    Returns:
        Deduplicated list
    """
    seen_urls = set()
    result = []

    for item in items:
        # Normalize URL for comparison
        url_key = item.url.lower().rstrip("/")
        if url_key not in seen_urls:
            seen_urls.add(url_key)
            result.append(item)

    return result
