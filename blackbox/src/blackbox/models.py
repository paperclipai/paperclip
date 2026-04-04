"""Pydantic models for the Blackbox research pipeline."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import Enum

from pydantic import BaseModel, Field


class ContractType(str, Enum):
    FIRM_FIXED_PRICE = "FFP"
    TIME_AND_MATERIALS = "T&M"
    COST_PLUS = "COST_PLUS"
    IDIQ = "IDIQ"
    BPA = "BPA"
    UNKNOWN = "UNKNOWN"


class ResearchArea(str, Enum):
    MISSION_VISION = "mission_vision"
    ORG_STRUCTURE = "org_structure"
    IT_LANDSCAPE = "it_landscape"
    PROCUREMENTS = "procurements"
    NEWS = "news"
    AUDIT_COMPLIANCE = "audit_compliance"
    CYBERSECURITY = "cybersecurity"
    VENDOR_REQUIREMENTS = "vendor_requirements"


class SectionStatus(str, Enum):
    OK = "OK"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


# --- Input Models ---


class RFPContext(BaseModel):
    """Extracted from an RFP file or provided via CLI flags."""

    agency_name: str
    scope: str = ""
    contract_type: ContractType = ContractType.UNKNOWN
    naics_code: str = ""
    set_aside: str = ""
    due_date: str = ""
    estimated_value: str = ""
    solicitation_number: str = ""
    raw_text: str = Field(default="", exclude=True)


# --- Search Models ---


class SearchQuery(BaseModel):
    """A single search query targeting a research area."""

    area: ResearchArea
    query: str
    rationale: str = ""


class SearchResult(BaseModel):
    """A single result from Brave Search."""

    area: ResearchArea
    query: str
    title: str
    url: str
    snippet: str
    age: str = ""


# --- Fetcher Models ---


class FetchedPage(BaseModel):
    """Full page content fetched from a search result URL."""

    url: str
    area: ResearchArea
    title: str
    content: str
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))


# --- Dossier Models ---


class CitedSource(BaseModel):
    """A source with URL and optional publication date."""

    url: str
    title: str = ""
    published_date: str = ""


class DossierSection(BaseModel):
    """One section of the agency dossier."""

    area: ResearchArea
    title: str
    status: SectionStatus = SectionStatus.OK
    summary: str
    key_findings: list[str] = Field(default_factory=list)
    sources: list[CitedSource] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)


# --- Scoring Models ---


class ScoreDimension(BaseModel):
    """One dimension of qualification scoring."""

    name: str
    score: int = Field(ge=0, le=100)
    weight: float = Field(ge=0.0, le=1.0)
    rationale: str


class Recommendation(str, Enum):
    STRONG_PURSUE = "STRONG PURSUE"
    PURSUE = "PURSUE"
    CONDITIONAL = "CONDITIONAL"
    PASS = "PASS"


class QualificationScore(BaseModel):
    """Overall qualification score with breakdown."""

    overall_score: int = Field(ge=0, le=100)
    recommendation: Recommendation
    dimensions: list[ScoreDimension]
    strengths: list[str] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    go_no_go_summary: str = ""


# --- Top-Level Output ---


class AgencyDossier(BaseModel):
    """Complete agency research dossier — the main output artifact."""

    agency_name: str
    rfp_context: RFPContext
    sections: list[DossierSection] = Field(default_factory=list)
    score: QualificationScore | None = None
    generated_at: datetime = Field(default_factory=lambda: datetime.now(tz=UTC))
    cache_key: str = ""
    total_sources: int = 0
    total_queries: int = 0
    llm_cost_estimate_usd: float = 0.0
