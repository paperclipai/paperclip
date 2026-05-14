"""Tests for the pipeline orchestration."""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from blackbox.models import (
    AgencyDossier,
    DossierSection,
    QualificationScore,
    RFPContext,
    Recommendation,
    ResearchArea,
    ScoreDimension,
    SearchQuery,
    SearchResult,
    SectionStatus,
)
from blackbox.pipeline import run


def _make_settings(tmp_path: Path):
    """Create test settings with temp cache dir."""
    from blackbox.config import Settings

    return Settings(
        anthropic_api_key="test-key",
        brave_api_key="test-key",
        cache_dir=tmp_path / "cache",
    )


def _mock_section(area: ResearchArea) -> DossierSection:
    return DossierSection(area=area, title=area.value, summary="Test", confidence=0.7)


def _mock_score() -> QualificationScore:
    return QualificationScore(
        overall_score=70,
        recommendation=Recommendation.PURSUE,
        dimensions=[ScoreDimension(name="Test", score=70, weight=1.0, rationale="Test")],
        go_no_go_summary="Test",
    )


class TestPipeline:
    @pytest.mark.asyncio
    async def test_agency_flag_runs_pipeline(self, tmp_path):
        settings = _make_settings(tmp_path)
        output_dir = tmp_path / "output"

        queries = [SearchQuery(area=ResearchArea.NEWS, query="test")]
        results = [SearchResult(area=ResearchArea.NEWS, query="test", title="T", url="http://t", snippet="s")]
        sections = [_mock_section(a) for a in ResearchArea]
        score = _mock_score()

        with (
            patch("blackbox.pipeline.AsyncAnthropic") as mock_anthropic_cls,
            patch("blackbox.pipeline.generate_queries", new_callable=AsyncMock, return_value=queries),
            patch("blackbox.pipeline.BraveSearchClient") as mock_search_cls,
            patch("blackbox.pipeline.fetch_pages", new_callable=AsyncMock, return_value=[]),
            patch("blackbox.pipeline.synthesize_all", new_callable=AsyncMock, return_value=sections),
            patch("blackbox.pipeline.score_opportunity", new_callable=AsyncMock, return_value=score),
        ):
            mock_client = AsyncMock()
            mock_anthropic_cls.return_value = mock_client
            mock_search = AsyncMock()
            mock_search.search_batch = AsyncMock(return_value=results)
            mock_search_cls.return_value = mock_search

            dossier = await run(
                agency="FDA",
                scope="IT modernization",
                output_dir=output_dir,
                settings=settings,
            )

        assert dossier.agency_name == "FDA"
        assert dossier.score is not None
        assert dossier.score.overall_score == 70
        assert output_dir.exists()

    @pytest.mark.asyncio
    async def test_dry_run_skips_search(self, tmp_path):
        settings = _make_settings(tmp_path)
        queries = [SearchQuery(area=ResearchArea.NEWS, query="test")]

        with (
            patch("blackbox.pipeline.AsyncAnthropic") as mock_anthropic_cls,
            patch("blackbox.pipeline.generate_queries", new_callable=AsyncMock, return_value=queries),
        ):
            mock_client = AsyncMock()
            mock_anthropic_cls.return_value = mock_client

            dossier = await run(
                agency="FDA",
                dry_run=True,
                settings=settings,
            )

        assert dossier.agency_name == "FDA"
        assert dossier.total_queries == 1
        assert dossier.sections == []

    @pytest.mark.asyncio
    async def test_no_rfp_or_agency_raises(self, tmp_path):
        settings = _make_settings(tmp_path)
        with (
            patch("blackbox.pipeline.AsyncAnthropic") as mock_anthropic_cls,
        ):
            mock_client = AsyncMock()
            mock_anthropic_cls.return_value = mock_client
            with pytest.raises(ValueError, match="Either"):
                await run(settings=settings)
