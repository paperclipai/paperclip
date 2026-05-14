"""Tests for Brave Search client."""

import pytest
import respx
import httpx

from blackbox.models import ResearchArea, SearchQuery
from blackbox.search import AuthError, BraveSearchClient, BRAVE_API_URL


SAMPLE_BRAVE_RESPONSE = {
    "web": {
        "results": [
            {
                "title": "FDA IT Modernization Plan",
                "url": "https://fda.gov/it-plan",
                "description": "The FDA announced a new IT modernization initiative...",
                "age": "5 days ago",
            },
            {
                "title": "FDA Cloud Migration",
                "url": "https://fda.gov/cloud",
                "description": "FDA is migrating to AWS GovCloud...",
                "age": "2 weeks ago",
            },
        ]
    }
}


@pytest.fixture
def client():
    return BraveSearchClient(
        api_key="test-key",
        max_concurrent=5,
        timeout=5,
        max_retries=2,
        results_per_query=5,
    )


class TestBraveSearch:
    @pytest.mark.asyncio
    @respx.mock
    async def test_successful_search(self, client):
        respx.get(BRAVE_API_URL).mock(return_value=httpx.Response(200, json=SAMPLE_BRAVE_RESPONSE))
        results = await client.search("FDA IT", ResearchArea.IT_LANDSCAPE)
        assert len(results) == 2
        assert results[0].title == "FDA IT Modernization Plan"
        assert results[0].area == ResearchArea.IT_LANDSCAPE
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_401_raises_auth_error(self, client):
        respx.get(BRAVE_API_URL).mock(return_value=httpx.Response(401))
        with pytest.raises(AuthError):
            await client.search("FDA", ResearchArea.NEWS)
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_429_falls_back_to_ddg(self, client):
        from unittest.mock import patch, MagicMock
        respx.get(BRAVE_API_URL).mock(return_value=httpx.Response(429))
        # Mock DDG to return predictable results
        mock_ddg_results = [
            {"title": "FDA Homepage", "href": "https://fda.gov", "body": "Food and Drug Administration"}
        ]
        with patch.object(client._ddg, "_search_sync", return_value=mock_ddg_results):
            results = await client.search("FDA", ResearchArea.NEWS)
        assert len(results) == 1
        assert results[0].title == "FDA Homepage"
        assert results[0].area == ResearchArea.NEWS
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_empty_response(self, client):
        respx.get(BRAVE_API_URL).mock(return_value=httpx.Response(200, json={}))
        results = await client.search("FDA", ResearchArea.NEWS)
        assert results == []
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_batch_search(self, client):
        respx.get(BRAVE_API_URL).mock(return_value=httpx.Response(200, json=SAMPLE_BRAVE_RESPONSE))
        queries = [
            SearchQuery(area=ResearchArea.NEWS, query="FDA news"),
            SearchQuery(area=ResearchArea.IT_LANDSCAPE, query="FDA IT"),
        ]
        results = await client.search_batch(queries)
        assert len(results) == 4  # 2 results per query
        await client.close()

    @pytest.mark.asyncio
    @respx.mock
    async def test_batch_auth_error_propagates(self, client):
        respx.get(BRAVE_API_URL).mock(return_value=httpx.Response(401))
        queries = [SearchQuery(area=ResearchArea.NEWS, query="FDA news")]
        with pytest.raises(AuthError):
            await client.search_batch(queries)
        await client.close()
