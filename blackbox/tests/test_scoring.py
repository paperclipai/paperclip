"""Tests for qualification scoring."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from blackbox.models import (
    DossierSection,
    RFPContext,
    Recommendation,
    ResearchArea,
    ScoreDimension,
)
from blackbox.scoring import _compute_weighted_score, score_opportunity, score_to_recommendation


class TestScoreToRecommendation:
    def test_strong_pursue(self):
        assert score_to_recommendation(85) == Recommendation.STRONG_PURSUE
        assert score_to_recommendation(100) == Recommendation.STRONG_PURSUE

    def test_pursue(self):
        assert score_to_recommendation(70) == Recommendation.PURSUE

    def test_conditional(self):
        assert score_to_recommendation(50) == Recommendation.CONDITIONAL

    def test_pass(self):
        assert score_to_recommendation(30) == Recommendation.PASS
        assert score_to_recommendation(0) == Recommendation.PASS

    def test_boundaries(self):
        assert score_to_recommendation(80) == Recommendation.STRONG_PURSUE
        assert score_to_recommendation(79) == Recommendation.PURSUE
        assert score_to_recommendation(60) == Recommendation.PURSUE
        assert score_to_recommendation(59) == Recommendation.CONDITIONAL
        assert score_to_recommendation(40) == Recommendation.CONDITIONAL
        assert score_to_recommendation(39) == Recommendation.PASS


class TestComputeWeightedScore:
    def test_uniform_weights(self):
        dims = [
            ScoreDimension(name="A", score=80, weight=0.5, rationale=""),
            ScoreDimension(name="B", score=60, weight=0.5, rationale=""),
        ]
        assert _compute_weighted_score(dims) == 70

    def test_varied_weights(self):
        dims = [
            ScoreDimension(name="A", score=100, weight=0.25, rationale=""),
            ScoreDimension(name="B", score=0, weight=0.75, rationale=""),
        ]
        assert _compute_weighted_score(dims) == 25

    def test_empty_returns_zero(self):
        assert _compute_weighted_score([]) == 0


def _mock_scoring_response(dimensions: list[dict]):
    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.input = {
        "dimensions": dimensions,
        "strengths": ["Good fit"],
        "risks": ["Incumbent"],
        "go_no_go_summary": "Pursue with caveats.",
    }
    message = MagicMock()
    message.content = [tool_block]
    return message


@pytest.fixture
def rfp_context():
    return RFPContext(agency_name="FDA", scope="IT modernization")


@pytest.fixture
def sections():
    return [
        DossierSection(area=ResearchArea.NEWS, title="News", summary="Latest news.", confidence=0.8),
        DossierSection(area=ResearchArea.IT_LANDSCAPE, title="IT", summary="Cloud migration.", confidence=0.7),
    ]


class TestScoreOpportunity:
    @pytest.mark.asyncio
    async def test_returns_qualification_score(self, rfp_context, sections):
        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(
            return_value=_mock_scoring_response([
                {"name": "Deal Size", "score": 70, "rationale": "Mid-range"},
                {"name": "Capability Match", "score": 85, "rationale": "Strong fit"},
                {"name": "Competition Level", "score": 60, "rationale": "Moderate"},
                {"name": "Timeline Feasibility", "score": 75, "rationale": "OK"},
                {"name": "Compliance Match", "score": 65, "rationale": "Minor gaps"},
                {"name": "Win Probability", "score": 55, "rationale": "Possible"},
            ])
        )
        score = await score_opportunity(sections, rfp_context, mock_client, "sonnet")
        assert score is not None
        assert 0 <= score.overall_score <= 100
        assert score.recommendation in list(Recommendation)
        assert len(score.dimensions) == 6
        assert len(score.strengths) == 1
        assert len(score.risks) == 1

    @pytest.mark.asyncio
    async def test_returns_none_on_failure(self, rfp_context, sections):
        mock_client = AsyncMock()
        mock_client.messages.create = AsyncMock(side_effect=Exception("API error"))
        score = await score_opportunity(sections, rfp_context, mock_client, "sonnet")
        assert score is None
        # Should have retried once (2 calls total)
        assert mock_client.messages.create.call_count == 2
