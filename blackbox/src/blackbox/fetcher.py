"""Fetch full page content from search result URLs."""

from __future__ import annotations

import asyncio
import logging
import re
from collections import defaultdict
from datetime import UTC, datetime

import httpx

from blackbox.models import FetchedPage, ResearchArea, SearchResult

logger = logging.getLogger(__name__)

MAX_CONTENT_LENGTH = 10_000


def extract_text_from_html(html: str) -> str:
    """Extract main text content from HTML. Strip tags, scripts, styles, nav."""
    # Remove script and style blocks
    text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
    # Remove nav, header, footer blocks
    for tag in ("nav", "header", "footer", "aside"):
        text = re.sub(rf"<{tag}[^>]*>.*?</{tag}>", "", text, flags=re.DOTALL | re.IGNORECASE)
    # Strip all remaining HTML tags
    text = re.sub(r"<[^>]+>", " ", text)
    # Decode common HTML entities
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&nbsp;", " ").replace("&quot;", '"')
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_CONTENT_LENGTH]


async def fetch_pages(
    results: list[SearchResult],
    max_per_area: int = 3,
    max_concurrent: int = 10,
    timeout: int = 10,
) -> list[FetchedPage]:
    """Fetch full page content for top URLs per research area."""
    # Group by area and take top N per area
    by_area: dict[ResearchArea, list[SearchResult]] = defaultdict(list)
    for r in results:
        by_area[r.area].append(r)

    to_fetch: list[SearchResult] = []
    seen_urls: set[str] = set()
    for area in ResearchArea:
        for r in by_area.get(area, [])[:max_per_area]:
            if r.url not in seen_urls:
                to_fetch.append(r)
                seen_urls.add(r.url)

    if not to_fetch:
        return []

    semaphore = asyncio.Semaphore(max_concurrent)

    async def _fetch_one(result: SearchResult) -> FetchedPage | None:
        async with semaphore:
            try:
                async with httpx.AsyncClient(
                    timeout=timeout, follow_redirects=True
                ) as client:
                    resp = await client.get(result.url)
                    content_type = resp.headers.get("content-type", "")
                    if "text/html" not in content_type:
                        return None
                    text = extract_text_from_html(resp.text)
                    if len(text) < 50:
                        return None
                    return FetchedPage(
                        url=result.url,
                        area=result.area,
                        title=result.title,
                        content=text,
                        fetched_at=datetime.now(tz=UTC),
                    )
            except Exception as exc:
                logger.debug("Fetch failed for %s: %s", result.url, exc)
                return None

    tasks = [_fetch_one(r) for r in to_fetch]
    raw = await asyncio.gather(*tasks)
    return [p for p in raw if p is not None]
