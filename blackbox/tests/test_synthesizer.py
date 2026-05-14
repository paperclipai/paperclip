"""Tests for the synthesizer (query generation + section synthesis)."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from blackbox.models import (
    FetchedPage,
    RFPContext,
    ResearchArea,
    SearchResult,
    SectionStatus,
)
from blackbox.synthesizer import generate_queries, synthesize_all, synthesize_section


def _mock_queries_response():
    """Mock Claude response for query generation."""
    queries = []
    for area in ResearchArea:
        for i in range(3):
            queries.append({"area": area.value, "query": f"{area.value} query {i}"})

    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.input = {"queries": queries}
    message = MagicMock()
    message.content = [tool_block]
    return message


def _mock_section_response(summary: str = "Test summary", confidence: float = 0.8):
    """Mock Claude response for section synthesis."""
    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.input = {
        "summary": summary,
        "key_findings": ["Finding 1", "Finding 2"],
        "sources": [{"url": "https://example.gov", "title": "Source", "published_date": "2025-01-15"}],
        "confidence": confidence,
    }
    message = MagicMock()
    message.content = [tool_block]
    return message


def _search_result(area: ResearchArea) -> SearchResult:
    return SearchResult(area=area, query="test", title="Test Result", url="https://example.gov", snippet="Test snippet")


def _fetched_page(area: ResearchArea) -> FetchedPage:
    return FetchedPage(url="https://example.gov", area=area, title="Test Page", content="Full page content here")


@pytest.fixture
def rfp_context():
    return RFPContext(agency_name="FDA", scope="IT modernization")


class TestGenerateQueries:
    @pytest.mark.asyncio
    async def test_generates_queries_for_all_areas(self, rfp_context):
        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(return_value=_mock_queries_response())
        queries = await generate_queries(rfp_context, mock_client, "haiku")
        areas_covered = {q.area for q in queries}
        assert len(areas_covered) == 8
        assert len(queries) == 24  # 3 per area

    @pytest.mark.asyncio
    async def test_fallback_on_failure(self, rfp_context):
        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(side_effect=Exception("API error"))
        queries = await generate_queries(rfp_context, mock_client, "haiku")
        assert len(queries) > 0
        areas_covered = {q.area for q in queries}
        assert len(areas_covered) == 8
        # Template queries should contain the agency name
        assert any("FDA" in q.query for q in queries)


class TestSynthesizeSection:
    @pytest.mark.asyncio
    async def test_produces_section(self, rfp_context):
        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(return_value=_mock_section_response())
        section = await synthesize_section(
            ResearchArea.NEWS,
            [_search_result(ResearchArea.NEWS)],
            [_fetched_page(ResearchArea.NEWS)],
            rfp_context,
            mock_client,
            "sonnet",
        )
        assert section.area == ResearchArea.NEWS
        assert section.status == SectionStatus.OK
        assert section.confidence == 0.8
        assert len(section.key_findings) == 2
        assert len(section.sources) == 1
        assert section.sources[0].published_date == "2025-01-15"

    @pytest.mark.asyncio
    async def test_no_data_returns_insufficient(self, rfp_context):
        mock_client = AsyncMock()
        section = await synthesize_section(
            ResearchArea.CYBERSECURITY, [], [], rfp_context, mock_client, "sonnet"
        )
        assert section.status == SectionStatus.INSUFFICIENT_DATA
        assert section.confidence == 0.0
        # Should NOT have called Claude
        mock_client.messages.create.assert_not_called()

    @pytest.mark.asyncio
    async def test_claude_failure_returns_raw_snippets(self, rfp_context):
        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(side_effect=Exception("API error"))
        results = [_search_result(ResearchArea.NEWS)]
        section = await synthesize_section(
            ResearchArea.NEWS, results, [], rfp_context, mock_client, "sonnet"
        )
        assert section.area == ResearchArea.NEWS
        assert section.confidence == 0.2
        assert "Test Result" in section.summary or "Test Result" in section.key_findings


class TestSynthesizeAll:
    @pytest.mark.asyncio
    async def test_processes_all_areas(self, rfp_context):
        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(return_value=_mock_section_response())
        # Provide data for 3 areas, empty for 5
        results = [_search_result(ResearchArea.NEWS), _search_result(ResearchArea.IT_LANDSCAPE), _search_result(ResearchArea.PROCUREMENTS)]
        pages = [_fetched_page(ResearchArea.NEWS)]
        sections = await synthesize_all(results, pages, rfp_context, mock_client, "sonnet", max_concurrent=2)
        assert len(sections) == 8
        insufficient = [s for s in sections if s.status == SectionStatus.INSUFFICIENT_DATA]
        assert len(insufficient) == 5  # 5 areas with no data

    @pytest.mark.asyncio
    async def test_all_empty_returns_all_insufficient(self, rfp_context):
        mock_client = AsyncMock()
        sections = await synthesize_all([], [], rfp_context, mock_client, "sonnet")
        assert len(sections) == 8
        assert all(s.status == SectionStatus.INSUFFICIENT_DATA for s in sections)
        mock_client.messages.create.assert_not_called()
