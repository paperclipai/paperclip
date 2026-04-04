"""Claude-powered query generation and dossier synthesis."""

from __future__ import annotations

import asyncio
import logging
from collections import defaultdict

from anthropic import AsyncAnthropic

from blackbox.models import (
    CitedSource,
    DossierSection,
    FetchedPage,
    RFPContext,
    ResearchArea,
    SearchQuery,
    SearchResult,
    SectionStatus,
)

logger = logging.getLogger(__name__)

AREA_LABELS = {
    ResearchArea.MISSION_VISION: "Mission, Vision & Strategic Goals",
    ResearchArea.ORG_STRUCTURE: "Organizational Structure & Leadership",
    ResearchArea.IT_LANDSCAPE: "IT Landscape & Modernization Initiatives",
    ResearchArea.PROCUREMENTS: "Recent Procurements & Contracts",
    ResearchArea.NEWS: "News & Recent Developments",
    ResearchArea.AUDIT_COMPLIANCE: "Audit Findings & Compliance",
    ResearchArea.CYBERSECURITY: "Cybersecurity Posture",
    ResearchArea.VENDOR_REQUIREMENTS: "Vendor & Methodology Requirements",
}

QUERIES_TOOL = {
    "name": "output_queries",
    "description": "Output search queries for each research area.",
    "input_schema": {
        "type": "object",
        "properties": {
            "queries": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "area": {"type": "string", "enum": [a.value for a in ResearchArea]},
                        "query": {"type": "string"},
                        "rationale": {"type": "string"},
                    },
                    "required": ["area", "query"],
                },
            }
        },
        "required": ["queries"],
    },
}

SECTION_TOOL = {
    "name": "output_section",
    "description": "Output a structured dossier section.",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "2-4 paragraph synthesis of findings"},
            "key_findings": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Bullet-point key findings",
            },
            "sources": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "title": {"type": "string"},
                        "published_date": {"type": "string", "description": "Publication date if known, empty string otherwise"},
                    },
                    "required": ["url"],
                },
            },
            "confidence": {
                "type": "number",
                "description": "Confidence in findings, 0.0-1.0",
            },
        },
        "required": ["summary", "key_findings", "sources", "confidence"],
    },
}


def _fallback_queries(rfp_context: RFPContext) -> list[SearchQuery]:
    """Generate template queries when Claude fails."""
    agency = rfp_context.agency_name
    templates = {
        ResearchArea.MISSION_VISION: [
            f'"{agency}" strategic plan 2024 2025',
            f'"{agency}" mission statement goals',
            f'"{agency}" annual report',
        ],
        ResearchArea.ORG_STRUCTURE: [
            f'"{agency}" organizational chart leadership',
            f'"{agency}" CIO CTO CISO 2024',
            f'"{agency}" director leadership team',
        ],
        ResearchArea.IT_LANDSCAPE: [
            f'"{agency}" IT modernization cloud',
            f'"{agency}" technology contracts SAM.gov',
            f'"{agency}" digital transformation',
        ],
        ResearchArea.PROCUREMENTS: [
            f'site:usaspending.gov "{agency}"',
            f'"{agency}" IDIQ BPA contract awards 2024',
            f'"{agency}" procurement contract technology',
        ],
        ResearchArea.NEWS: [
            f'"{agency}" news 2024 2025 technology',
            f'"{agency}" IT project announcement',
            f'"{agency}" technology initiative news',
        ],
        ResearchArea.AUDIT_COMPLIANCE: [
            f'"{agency}" OIG audit report 2024',
            f'"{agency}" GAO findings compliance',
            f'"{agency}" inspector general report',
        ],
        ResearchArea.CYBERSECURITY: [
            f'"{agency}" cybersecurity assessment CISA',
            f'"{agency}" zero trust FISMA',
            f'"{agency}" security incident breach',
        ],
        ResearchArea.VENDOR_REQUIREMENTS: [
            f'"{agency}" contractor requirements methodology',
            f'"{agency}" CMMI certification vendor',
            f'"{agency}" agile methodology requirements',
        ],
    }
    queries = []
    for area, query_list in templates.items():
        for q in query_list:
            queries.append(SearchQuery(area=area, query=q))
    return queries


async def generate_queries(
    rfp_context: RFPContext, client: AsyncAnthropic, model: str
) -> list[SearchQuery]:
    """Generate 3-5 search queries per research area using Claude."""
    scope_text = f" focused on {rfp_context.scope}" if rfp_context.scope else ""
    prompt = (
        f"Generate targeted web search queries to research the government agency "
        f'"{rfp_context.agency_name}"{scope_text}.\n\n'
    )

    # If we have RFP text, include key excerpts so queries are RFP-specific
    if rfp_context.raw_text:
        # Include first 8K chars of RFP text for context
        rfp_excerpt = rfp_context.raw_text[:8000]
        prompt += (
            "## RFP Document Context\n"
            "Below is an excerpt from the actual RFP document. Use this to generate "
            "SPECIFIC queries about this agency's needs, mentioned technologies, "
            "requirements, certifications, and past contracts.\n\n"
            f"```\n{rfp_excerpt}\n```\n\n"
        )

    if rfp_context.solicitation_number:
        prompt += f"Solicitation Number: {rfp_context.solicitation_number}\n"
    if rfp_context.due_date:
        prompt += f"Due Date: {rfp_context.due_date}\n"
    if rfp_context.naics_code:
        prompt += f"NAICS: {rfp_context.naics_code}\n"

    prompt += f"\nGenerate 3-5 queries for EACH of these 8 research areas:\n"
    for area in ResearchArea:
        prompt += f"- {area.value}: {AREA_LABELS[area]}\n"
    prompt += (
        "\nQueries MUST:\n"
        "- Use the FULL official agency name (e.g. 'District of Columbia Water and Sewer Authority' not just 'DC Water')\n"
        "- Include common abbreviations as secondary terms\n"
        "- Target specific government sources (USASpending.gov, OIG, CISA, SAM.gov)\n"
        "- Include recent date qualifiers (2023-2025)\n"
        "- Reference specific technologies, requirements, or contract vehicles from the RFP when available\n"
        "- Be specific enough to return results ONLY about this agency, not generic results\n"
    )

    try:
        response = await client.messages.create(
            model=model,
            max_tokens=4096,
            system="You are a federal government research specialist generating targeted search queries.",
            messages=[{"role": "user", "content": prompt}],
            tools=[QUERIES_TOOL],
            tool_choice={"type": "tool", "name": "output_queries"},
        )
        tool_block = next((b for b in response.content if b.type == "tool_use"), None)
        if tool_block is None:
            logger.warning("No tool_use in query generation response, using fallback")
            return _fallback_queries(rfp_context)

        raw_queries = tool_block.input.get("queries", [])
        return [
            SearchQuery(
                area=ResearchArea(q["area"]),
                query=q["query"],
                rationale=q.get("rationale", ""),
            )
            for q in raw_queries
            if q.get("area") and q.get("query")
        ]
    except Exception as exc:
        logger.warning("Query generation failed: %s. Using fallback templates.", exc)
        return _fallback_queries(rfp_context)


async def synthesize_section(
    area: ResearchArea,
    results: list[SearchResult],
    pages: list[FetchedPage],
    rfp_context: RFPContext,
    client: AsyncAnthropic,
    model: str,
) -> DossierSection:
    """Synthesize search results and fetched pages into a dossier section."""
    title = AREA_LABELS[area]

    # If no data at all, return INSUFFICIENT_DATA without calling Claude
    if not results and not pages:
        return DossierSection(
            area=area,
            title=title,
            status=SectionStatus.INSUFFICIENT_DATA,
            summary=f"No search results or page content found for {title}. "
            f"Searched for information about {rfp_context.agency_name} but found insufficient public data.",
            confidence=0.0,
        )

    # Build context from search results and fetched pages
    context_parts = []
    if results:
        context_parts.append("## Search Results (snippets)")
        for r in results:
            context_parts.append(f"- [{r.title}]({r.url}): {r.snippet}")

    if pages:
        context_parts.append("\n## Full Page Content")
        for p in pages:
            context_parts.append(f"### {p.title} ({p.url})\n{p.content[:5000]}")

    context = "\n".join(context_parts)

    prompt = (
        f"Synthesize the following research about {rfp_context.agency_name} "
        f"for the area: {title}.\n\n"
        f"Agency scope context: {rfp_context.scope or 'General IT services'}\n\n"
        f"{context}\n\n"
        "Produce a structured dossier section with:\n"
        "- A 2-4 paragraph summary synthesizing the findings\n"
        "- Key findings as bullet points\n"
        "- Sources with URLs and publication dates when available\n"
        "- Confidence score (0.0-1.0) reflecting data quality and coverage\n"
        "If the data is insufficient or unreliable, set confidence below 0.3 and note limitations."
    )

    try:
        response = await client.messages.create(
            model=model,
            max_tokens=2048,
            system="You are an agency intelligence analyst synthesizing research findings into a structured dossier section. Be factual, cite sources, and clearly indicate when data is uncertain or unavailable.",
            messages=[{"role": "user", "content": prompt}],
            tools=[SECTION_TOOL],
            tool_choice={"type": "tool", "name": "output_section"},
        )
        tool_block = next((b for b in response.content if b.type == "tool_use"), None)
        if tool_block is None:
            raise ValueError("No tool_use block in synthesis response")

        data = tool_block.input
        confidence = max(0.0, min(1.0, float(data.get("confidence", 0.5))))
        status = SectionStatus.INSUFFICIENT_DATA if confidence < 0.1 else SectionStatus.OK

        return DossierSection(
            area=area,
            title=title,
            status=status,
            summary=data.get("summary", ""),
            key_findings=data.get("key_findings", []),
            sources=[
                CitedSource(
                    url=s.get("url", ""),
                    title=s.get("title", ""),
                    published_date=s.get("published_date", ""),
                )
                for s in data.get("sources", [])
            ],
            confidence=confidence,
        )
    except Exception as exc:
        logger.warning("Synthesis failed for %s: %s. Using raw snippets.", area.value, exc)
        # Fallback: create section from raw snippets
        snippet_summary = "\n".join(f"- {r.title}: {r.snippet}" for r in results[:5])
        return DossierSection(
            area=area,
            title=title,
            status=SectionStatus.OK,
            summary=f"Raw search results (synthesis failed):\n{snippet_summary}" if snippet_summary else "Synthesis failed and no raw data available.",
            key_findings=[r.title for r in results[:5]],
            sources=[CitedSource(url=r.url, title=r.title) for r in results[:5]],
            confidence=0.2,
        )


async def synthesize_all(
    results: list[SearchResult],
    pages: list[FetchedPage],
    rfp_context: RFPContext,
    client: AsyncAnthropic,
    model: str,
    max_concurrent: int = 4,
) -> list[DossierSection]:
    """Synthesize all 8 research areas in parallel."""
    # Group by area
    results_by_area: dict[ResearchArea, list[SearchResult]] = defaultdict(list)
    pages_by_area: dict[ResearchArea, list[FetchedPage]] = defaultdict(list)
    for r in results:
        results_by_area[r.area].append(r)
    for p in pages:
        pages_by_area[p.area].append(p)

    semaphore = asyncio.Semaphore(max_concurrent)

    async def _synth(area: ResearchArea) -> DossierSection:
        async with semaphore:
            return await synthesize_section(
                area,
                results_by_area.get(area, []),
                pages_by_area.get(area, []),
                rfp_context,
                client,
                model,
            )

    tasks = [_synth(area) for area in ResearchArea]
    sections = await asyncio.gather(*tasks)
    return list(sections)
