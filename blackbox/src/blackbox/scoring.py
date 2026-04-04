"""Qualification scoring using Claude Sonnet."""

from __future__ import annotations

import logging

from anthropic import AsyncAnthropic

from blackbox.models import (
    DossierSection,
    QualificationScore,
    RFPContext,
    Recommendation,
    ScoreDimension,
)

logger = logging.getLogger(__name__)

SCORING_RUBRIC = [
    {"name": "Deal Size", "weight": 0.15, "guide": "0-25: <$500K / 26-50: $500K-2M / 51-75: $2M-10M / 76-100: >$10M or IDIQ"},
    {"name": "Capability Match", "weight": 0.25, "guide": "How well ConsultAdd capabilities (IT modernization, cloud, data, cybersecurity, Agile) align with RFP scope"},
    {"name": "Competition Level", "weight": 0.15, "guide": "0-25: >20 bidders / 26-50: 10-20 / 51-75: 5-10 / 76-100: <5 or set-aside advantage"},
    {"name": "Timeline Feasibility", "weight": 0.10, "guide": "Is the proposal timeline realistic given scope?"},
    {"name": "Compliance Match", "weight": 0.15, "guide": "Does ConsultAdd meet certifications, clearances, past performance requirements?"},
    {"name": "Win Probability", "weight": 0.20, "guide": "Incumbency, relationship history, strategic factors, competitive position"},
]

SCORING_TOOL = {
    "name": "score_opportunity",
    "description": "Score the opportunity across dimensions and provide a go/no-go recommendation.",
    "input_schema": {
        "type": "object",
        "properties": {
            "dimensions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "score": {"type": "integer", "minimum": 0, "maximum": 100},
                        "rationale": {"type": "string"},
                    },
                    "required": ["name", "score", "rationale"],
                },
            },
            "strengths": {"type": "array", "items": {"type": "string"}},
            "risks": {"type": "array", "items": {"type": "string"}},
            "go_no_go_summary": {"type": "string"},
        },
        "required": ["dimensions", "strengths", "risks", "go_no_go_summary"],
    },
}


def score_to_recommendation(score: int) -> Recommendation:
    if score >= 80:
        return Recommendation.STRONG_PURSUE
    if score >= 60:
        return Recommendation.PURSUE
    if score >= 40:
        return Recommendation.CONDITIONAL
    return Recommendation.PASS


def _compute_weighted_score(dimensions: list[ScoreDimension]) -> int:
    """Compute weighted overall score from dimension scores."""
    total = sum(d.score * d.weight for d in dimensions)
    total_weight = sum(d.weight for d in dimensions)
    if total_weight == 0:
        return 0
    return round(total / total_weight)


async def score_opportunity(
    sections: list[DossierSection],
    rfp_context: RFPContext,
    client: AsyncAnthropic,
    model: str,
) -> QualificationScore | None:
    """Score the opportunity using Claude Sonnet. Returns None on failure."""
    # Build dossier summary for scoring
    dossier_text = []
    for s in sections:
        status_note = " [INSUFFICIENT DATA]" if s.status.value == "INSUFFICIENT_DATA" else ""
        dossier_text.append(f"## {s.title}{status_note}\n{s.summary}")

    rubric_text = "\n".join(
        f"- {r['name']} (weight: {r['weight']}): {r['guide']}" for r in SCORING_RUBRIC
    )

    prompt = (
        f"Evaluate this RFP opportunity for ConsultAdd, an IT consulting firm "
        f"specializing in cloud, data, cybersecurity, Agile, and IT modernization "
        f"for US state/local government.\n\n"
        f"**Agency:** {rfp_context.agency_name}\n"
        f"**Scope:** {rfp_context.scope or 'Not specified'}\n"
        f"**Contract Type:** {rfp_context.contract_type.value}\n"
        f"**Estimated Value:** {rfp_context.estimated_value or 'Unknown'}\n"
        f"**Set-Aside:** {rfp_context.set_aside or 'None'}\n\n"
        f"**Agency Dossier:**\n\n{chr(10).join(dossier_text)}\n\n"
        f"**Scoring Rubric:**\n{rubric_text}\n\n"
        f"Score each dimension 0-100 with rationale. List strengths, risks, "
        f"and a 2-3 sentence go/no-go summary."
    )

    for attempt in range(2):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=2048,
                system=(
                    "You are a federal government proposal strategist evaluating "
                    "bid opportunities for ConsultAdd. Be realistic about scoring — "
                    "do not inflate scores. If information is insufficient to score "
                    "a dimension, score it 50 and note the uncertainty."
                ),
                messages=[{"role": "user", "content": prompt}],
                tools=[SCORING_TOOL],
                tool_choice={"type": "tool", "name": "score_opportunity"},
            )
            tool_block = next((b for b in response.content if b.type == "tool_use"), None)
            if tool_block is None:
                raise ValueError("No tool_use block in scoring response")

            data = tool_block.input
            # Build dimensions with weights from rubric
            weight_map = {r["name"]: r["weight"] for r in SCORING_RUBRIC}
            dimensions = [
                ScoreDimension(
                    name=d["name"],
                    score=max(0, min(100, d["score"])),
                    weight=weight_map.get(d["name"], 0.15),
                    rationale=d.get("rationale", ""),
                )
                for d in data.get("dimensions", [])
            ]

            overall = _compute_weighted_score(dimensions)
            return QualificationScore(
                overall_score=overall,
                recommendation=score_to_recommendation(overall),
                dimensions=dimensions,
                strengths=data.get("strengths", []),
                risks=data.get("risks", []),
                go_no_go_summary=data.get("go_no_go_summary", ""),
            )
        except Exception as exc:
            if attempt == 0:
                logger.warning("Scoring attempt 1 failed: %s. Retrying.", exc)
                continue
            logger.warning("Scoring failed after 2 attempts: %s", exc)
            return None
    return None
