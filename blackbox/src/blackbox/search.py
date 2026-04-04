"""Search client with Brave primary + DuckDuckGo fallback."""

from __future__ import annotations

import asyncio
import logging

import httpx
from duckduckgo_search import DDGS

from blackbox.models import ResearchArea, SearchQuery, SearchResult

logger = logging.getLogger(__name__)

BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search"


class AuthError(Exception):
    pass


class DuckDuckGoClient:
    """Synchronous DDG search wrapped for async use."""

    def __init__(self, results_per_query: int = 5) -> None:
        self.results_per_query = results_per_query

    async def search(self, query: str, area: ResearchArea) -> list[SearchResult]:
        loop = asyncio.get_event_loop()
        try:
            results = await loop.run_in_executor(None, self._search_sync, query)
            return [
                SearchResult(
                    area=area,
                    query=query,
                    title=r.get("title", ""),
                    url=r.get("href", ""),
                    snippet=r.get("body", ""),
                    age="",
                )
                for r in results
            ]
        except Exception as exc:
            logger.warning("DDG search failed for '%s': %s", query, exc)
            return []

    def _search_sync(self, query: str) -> list[dict]:
        with DDGS() as ddgs:
            return list(ddgs.text(query, max_results=self.results_per_query))


class BraveSearchClient:
    def __init__(
        self,
        api_key: str,
        max_concurrent: int = 2,  # reduced from 10 to avoid 429s
        timeout: int = 10,
        max_retries: int = 3,
        results_per_query: int = 5,
    ) -> None:
        self.api_key = api_key
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self.timeout = timeout
        self.max_retries = max_retries
        self.results_per_query = results_per_query
        self._client = httpx.AsyncClient(
            headers={
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
                "X-Subscription-Token": api_key,
            },
            timeout=timeout,
        )
        self._ddg = DuckDuckGoClient(results_per_query=results_per_query)
        self._brave_failures = 0

    async def search(self, query: str, area: ResearchArea) -> list[SearchResult]:
        """Search with Brave, fall back to DuckDuckGo on 429/failure."""
        # If Brave has failed too many times, go straight to DDG
        if self._brave_failures >= 5:
            return await self._ddg.search(query, area)

        delays = [1, 2, 4]
        for attempt in range(self.max_retries):
            try:
                resp = await self._client.get(
                    BRAVE_API_URL,
                    params={"q": query, "count": self.results_per_query},
                )
                if resp.status_code == 401:
                    raise AuthError("Brave API authentication failed. Check BRAVE_API_KEY.")
                if resp.status_code == 429 or resp.status_code >= 500:
                    if attempt < self.max_retries - 1:
                        await asyncio.sleep(delays[attempt])
                        continue
                    # Brave exhausted — fall back to DDG
                    self._brave_failures += 1
                    logger.info("Brave 429 for '%s', falling back to DuckDuckGo", query)
                    return await self._ddg.search(query, area)
                resp.raise_for_status()
                self._brave_failures = max(0, self._brave_failures - 1)
                data = resp.json()
                web_results = data.get("web", {}).get("results", [])
                return [
                    SearchResult(
                        area=area,
                        query=query,
                        title=r.get("title", ""),
                        url=r.get("url", ""),
                        snippet=r.get("description", ""),
                        age=r.get("age", ""),
                    )
                    for r in web_results
                ]
            except AuthError:
                raise
            except httpx.TimeoutException:
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(delays[attempt])
                    continue
                logger.info("Brave timeout for '%s', falling back to DuckDuckGo", query)
                return await self._ddg.search(query, area)
            except Exception as exc:
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(delays[attempt])
                    continue
                logger.info("Brave failed for '%s': %s, falling back to DuckDuckGo", query, exc)
                return await self._ddg.search(query, area)
        return []

    async def search_batch(
        self,
        queries: list[SearchQuery],
        relevance_terms: list[str] | None = None,
    ) -> list[SearchResult]:
        """Execute multiple searches in parallel with rate limiting and relevance filtering."""
        async def _run(q: SearchQuery) -> list[SearchResult]:
            async with self.semaphore:
                return await self.search(q.query, q.area)

        tasks = [_run(q) for q in queries]
        results_lists = await asyncio.gather(*tasks, return_exceptions=True)
        all_results: list[SearchResult] = []
        for r in results_lists:
            if isinstance(r, list):
                all_results.extend(r)
            elif isinstance(r, AuthError):
                raise r
            else:
                logger.warning("Batch search task error: %s", r)

        # Relevance filter: drop results that don't mention any relevance terms
        if relevance_terms:
            terms_lower = [t.lower() for t in relevance_terms if len(t) > 2]
            before = len(all_results)
            all_results = [
                r for r in all_results
                if _is_relevant(r, terms_lower)
            ]
            dropped = before - len(all_results)
            if dropped:
                logger.info("Relevance filter dropped %d/%d results", dropped, before)

        return all_results

    async def close(self) -> None:
        await self._client.aclose()


def _is_relevant(result: SearchResult, terms_lower: list[str]) -> bool:
    """Check if a search result mentions at least one relevance term."""
    text = f"{result.title} {result.snippet} {result.url}".lower()
    return any(term in text for term in terms_lower)
