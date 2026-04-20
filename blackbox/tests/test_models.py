"""Tests for Pydantic models."""

import pytest
from pydantic import ValidationError

from blackbox.models import (
    AgencyDossier,
    CitedSource,
    ContractType,
    DossierSection,
    FetchedPage,
    QualificationScore,
    RFPContext,
    Recommendation,
    ResearchArea,
    ScoreDimension,
    SearchQuery,
    SearchResult,
    SectionStatus,
)


class TestRFPContext:
    def test_minimal(self):
        ctx = RFPContext(agency_name="FDA")
        assert ctx.agency_name == "FDA"
        assert ctx.contract_type == ContractType.UNKNOWN
        assert ctx.scope == ""

    def test_full(self):
        ctx = RFPContext(
            agency_name="Texas DIR",
            scope="IT modernization",
            contract_type=ContractType.IDIQ,
            naics_code="541512",
            set_aside="8(a)",
            due_date="2026-04-15",
            estimated_value="$5M",
            solicitation_number="DIR-TSO-TMP-123",
        )
        assert ctx.contract_type == ContractType.IDIQ
        assert ctx.set_aside == "8(a)"

    def test_raw_text_excluded_from_serialization(self):
        ctx = RFPContext(agency_name="FDA", raw_text="huge RFP content here")
        data = ctx.model_dump()
        assert "raw_text" not in data

    def test_agency_name_required(self):
        with pytest.raises(ValidationError):
            RFPContext()


class TestSearchModels:
    def test_search_query(self):
        q = SearchQuery(
            area=ResearchArea.NEWS,
            query="FDA IT modernization 2024",
            rationale="Recent tech news",
        )
        assert q.area == ResearchArea.NEWS

    def test_search_result(self):
        r = SearchResult(
            area=ResearchArea.PROCUREMENTS,
            query="site:usaspending.gov FDA",
            title="FDA IT Contracts",
            url="https://usaspending.gov/...",
            snippet="FDA awarded $12M...",
            age="3 days ago",
        )
        assert r.url.startswith("https://")

    def test_all_research_areas(self):
        areas = list(ResearchArea)
        assert len(areas) == 8


class TestFetchedPage:
    def test_basic(self):
        page = FetchedPage(
            url="https://example.gov/about",
            area=ResearchArea.MISSION_VISION,
            title="About Us",
            content="Our mission is...",
        )
        assert page.fetched_at is not None
        assert len(page.content) > 0


class TestDossierSection:
    def test_ok_section(self):
        section = DossierSection(
            area=ResearchArea.IT_LANDSCAPE,
            title="IT Landscape",
            summary="The agency uses AWS...",
            key_findings=["Cloud-first strategy", "SAP migration underway"],
            sources=[CitedSource(url="https://example.gov", title="Agency IT Plan")],
            confidence=0.85,
        )
        assert section.status == SectionStatus.OK
        assert len(section.key_findings) == 2

    def test_insufficient_data_section(self):
        section = DossierSection(
            area=ResearchArea.CYBERSECURITY,
            title="Cybersecurity Posture",
            status=SectionStatus.INSUFFICIENT_DATA,
            summary="Insufficient public data available for this agency's cybersecurity posture.",
            confidence=0.0,
        )
        assert section.status == SectionStatus.INSUFFICIENT_DATA
        assert section.confidence == 0.0
        assert len(section.sources) == 0

    def test_confidence_bounds(self):
        with pytest.raises(ValidationError):
            DossierSection(
                area=ResearchArea.NEWS,
                title="News",
                summary="...",
                confidence=1.5,
            )
        with pytest.raises(ValidationError):
            DossierSection(
                area=ResearchArea.NEWS,
                title="News",
                summary="...",
                confidence=-0.1,
            )


class TestQualificationScore:
    def test_strong_pursue(self):
        score = QualificationScore(
            overall_score=85,
            recommendation=Recommendation.STRONG_PURSUE,
            dimensions=[
                ScoreDimension(name="Deal Size", score=80, weight=0.15, rationale="$5M+ IDIQ"),
            ],
            strengths=["Strong IT modernization match"],
            risks=["Incumbent advantage"],
            go_no_go_summary="Strong fit for ConsultAdd capabilities.",
        )
        assert score.overall_score == 85
        assert score.recommendation == Recommendation.STRONG_PURSUE

    def test_score_bounds(self):
        with pytest.raises(ValidationError):
            QualificationScore(
                overall_score=101,
                recommendation=Recommendation.PASS,
                dimensions=[],
            )
        with pytest.raises(ValidationError):
            QualificationScore(
                overall_score=-1,
                recommendation=Recommendation.PASS,
                dimensions=[],
            )

    def test_dimension_weight_bounds(self):
        with pytest.raises(ValidationError):
            ScoreDimension(name="Bad", score=50, weight=1.5, rationale="too high")


class TestAgencyDossier:
    def test_minimal(self):
        dossier = AgencyDossier(
            agency_name="FDA",
            rfp_context=RFPContext(agency_name="FDA"),
        )
        assert dossier.score is None
        assert dossier.generated_at is not None

    def test_serialization_roundtrip(self):
        dossier = AgencyDossier(
            agency_name="FDA",
            rfp_context=RFPContext(agency_name="FDA", scope="IT"),
            sections=[
                DossierSection(
                    area=ResearchArea.NEWS,
                    title="News",
                    summary="Latest news...",
                    confidence=0.7,
                    sources=[CitedSource(url="https://news.gov", published_date="2026-01-15")],
                )
            ],
            score=QualificationScore(
                overall_score=72,
                recommendation=Recommendation.PURSUE,
                dimensions=[
                    ScoreDimension(name="Capability", score=80, weight=0.25, rationale="Good fit"),
                ],
                go_no_go_summary="Pursue with caveats.",
            ),
            cache_key="fda",
            total_sources=5,
            total_queries=30,
        )
        json_str = dossier.model_dump_json()
        roundtripped = AgencyDossier.model_validate_json(json_str)
        assert roundtripped.agency_name == "FDA"
        assert roundtripped.score.overall_score == 72
        assert len(roundtripped.sections) == 1
        assert roundtripped.sections[0].sources[0].published_date == "2026-01-15"


class TestCitedSource:
    def test_with_date(self):
        s = CitedSource(url="https://oig.gov/report", title="OIG Report", published_date="2025-06-01")
        assert s.published_date == "2025-06-01"

    def test_without_date(self):
        s = CitedSource(url="https://example.gov")
        assert s.published_date == ""
