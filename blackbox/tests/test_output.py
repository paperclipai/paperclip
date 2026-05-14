"""Tests for output rendering."""

from datetime import UTC, datetime

import pytest

from blackbox.models import (
    AgencyDossier,
    CitedSource,
    DossierSection,
    QualificationScore,
    RFPContext,
    Recommendation,
    ResearchArea,
    ScoreDimension,
    SectionStatus,
)
from blackbox.output import render_json, render_markdown, write_output


@pytest.fixture
def full_dossier():
    return AgencyDossier(
        agency_name="FDA",
        rfp_context=RFPContext(
            agency_name="FDA",
            scope="IT modernization",
            solicitation_number="FDA-2026-001",
            estimated_value="$5M",
        ),
        sections=[
            DossierSection(
                area=ResearchArea.NEWS,
                title="News & Recent Developments",
                summary="The FDA announced a cloud migration initiative in Q1 2026.",
                key_findings=["Cloud migration underway", "$12M AWS contract"],
                sources=[
                    CitedSource(url="https://fda.gov/news", title="FDA News", published_date="2026-01-15"),
                    CitedSource(url="https://usaspending.gov/fda", title="USASpending"),
                ],
                confidence=0.85,
            ),
            DossierSection(
                area=ResearchArea.CYBERSECURITY,
                title="Cybersecurity Posture",
                status=SectionStatus.INSUFFICIENT_DATA,
                summary="Insufficient public data available for FDA cybersecurity posture.",
                confidence=0.0,
            ),
        ],
        score=QualificationScore(
            overall_score=72,
            recommendation=Recommendation.PURSUE,
            dimensions=[
                ScoreDimension(name="Deal Size", score=75, weight=0.15, rationale="$5M IDIQ"),
                ScoreDimension(name="Capability Match", score=85, weight=0.25, rationale="Strong fit"),
            ],
            strengths=["IT modernization expertise"],
            risks=["Incumbent advantage"],
            go_no_go_summary="Pursue. Strong capability match despite incumbent risk.",
        ),
        generated_at=datetime(2026, 3, 29, 12, 0, 0, tzinfo=UTC),
        total_queries=30,
        total_sources=15,
        llm_cost_estimate_usd=0.40,
    )


@pytest.fixture
def dossier_no_score():
    return AgencyDossier(
        agency_name="EPA",
        rfp_context=RFPContext(agency_name="EPA"),
        sections=[
            DossierSection(area=ResearchArea.NEWS, title="News", summary="EPA news.", confidence=0.6),
        ],
        score=None,
    )


class TestRenderMarkdown:
    def test_contains_all_sections(self, full_dossier):
        md = render_markdown(full_dossier)
        assert "# Agency Dossier: FDA" in md
        assert "FDA-2026-001" in md
        assert "News & Recent Developments" in md
        assert "Cloud migration underway" in md
        assert "72/100" in md
        assert "PURSUE" in md
        assert "Deal Size" in md
        assert "fda.gov/news" in md
        assert "2026-01-15" in md

    def test_insufficient_data_section(self, full_dossier):
        md = render_markdown(full_dossier)
        assert "INSUFFICIENT DATA" in md
        assert "Cybersecurity Posture" in md

    def test_no_score_shows_unavailable(self, dossier_no_score):
        md = render_markdown(dossier_no_score)
        assert "Scoring unavailable" in md

    def test_footer_has_stats(self, full_dossier):
        md = render_markdown(full_dossier)
        assert "30 queries" in md
        assert "15 sources" in md
        assert "$0.40" in md


class TestRenderJson:
    def test_valid_json_roundtrip(self, full_dossier):
        json_str = render_json(full_dossier)
        roundtripped = AgencyDossier.model_validate_json(json_str)
        assert roundtripped.agency_name == "FDA"
        assert roundtripped.score.overall_score == 72


class TestWriteOutput:
    def test_both_creates_two_files(self, tmp_path, full_dossier):
        paths = write_output(full_dossier, tmp_path, fmt="both")
        assert len(paths) == 2
        exts = {p.suffix for p in paths}
        assert exts == {".md", ".json"}

    def test_json_only(self, tmp_path, full_dossier):
        paths = write_output(full_dossier, tmp_path, fmt="json")
        assert len(paths) == 1
        assert paths[0].suffix == ".json"

    def test_md_only(self, tmp_path, full_dossier):
        paths = write_output(full_dossier, tmp_path, fmt="md")
        assert len(paths) == 1
        assert paths[0].suffix == ".md"

    def test_creates_output_dir(self, tmp_path, full_dossier):
        out = tmp_path / "deep" / "nested"
        paths = write_output(full_dossier, out, fmt="json")
        assert out.exists()
        assert len(paths) == 1

    def test_filename_is_slugified(self, tmp_path, full_dossier):
        paths = write_output(full_dossier, tmp_path, fmt="md")
        assert "fda-dossier.md" == paths[0].name
