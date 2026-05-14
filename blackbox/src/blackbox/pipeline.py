"""Main research pipeline orchestration."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path

from anthropic import AsyncAnthropic
from rich.console import Console
from rich.status import Status

from blackbox.cache import CacheManager
from blackbox.config import Settings
from blackbox.fetcher import fetch_pages
from blackbox.models import AgencyDossier, RFPContext, ResearchArea
from blackbox.output import write_output
from blackbox.paperclip import find_rfp_folder
from blackbox.parsers import parse_rfp
from blackbox.scoring import score_opportunity
from blackbox.search import BraveSearchClient
from blackbox.synthesizer import generate_queries, synthesize_all

logger = logging.getLogger(__name__)
console = Console()


def _enrich_from_rfps_folder(
    agency: str, scope: str, rfp_path: Path | None, settings: Settings
) -> tuple[Path | None, str]:
    """Look up rfps/ folder, load meta.yaml, fetch from HigherGov if available.

    Returns (rfp_path, extra_context).
    """
    extra_context = ""
    rfp_info = find_rfp_folder(agency, scope)
    if not rfp_info.get("meta"):
        return rfp_path, extra_context

    meta = rfp_info["meta"]
    console.print(f"[bold green]Found RFP folder:[/] {rfp_info.get('rfp_dir', 'unknown')}")

    # Use RFP file from folder if not provided
    if not rfp_path and rfp_info.get("rfp_path"):
        rfp_path = rfp_info["rfp_path"]
        console.print(f"[bold green]Found RFP:[/] {rfp_path.name}")

    # Collect notes from meta.yaml
    extra_context = rfp_info.get("notes", "")

    # Fetch from HigherGov if opp_key and API key available
    highergov_opp_key = rfp_info.get("highergov_opp_key", "")
    if highergov_opp_key and settings.highergov_api_key:
        console.print(f"[bold blue]Fetching from HigherGov:[/] {highergov_opp_key}")
        try:
            from blackbox.highergov import HigherGovClient

            hg = HigherGovClient(
                api_key=settings.highergov_api_key,
                base_url=settings.highergov_api_base_url,
                doc_url=settings.highergov_api_doc_url,
            )
            try:
                hg_text, hg_opp, hg_docs = hg.get_full_text(highergov_opp_key)
                if hg_text:
                    extra_context = f"{extra_context}\n\n{hg_text}".strip()
                    console.print(
                        f"[bold green]HigherGov:[/] {len(hg_docs)} document(s), {len(hg_text)} chars"
                    )
                # Download PDFs to rfp folder
                rfp_dir = rfp_info.get("rfp_dir")
                if rfp_dir and hg_docs:
                    for doc in hg_docs:
                        saved = hg.download_document(doc, rfp_dir)
                        if saved:
                            console.print(f"[bold green]Downloaded:[/] {saved.name}")
                            if not rfp_path:
                                rfp_path = saved
            finally:
                hg.close()
        except Exception as exc:
            console.print(f"[yellow]HigherGov fetch failed:[/] {exc}")

    return rfp_path, extra_context


async def run(
    rfp_path: Path | None = None,
    agency: str | None = None,
    scope: str = "",
    extra_context: str = "",
    output_dir: Path = Path("output"),
    fmt: str = "both",
    no_cache: bool = False,
    cache_ttl: int | None = None,
    dry_run: bool = False,
    settings: Settings | None = None,
) -> AgencyDossier:
    """Run the full research pipeline."""
    if settings is None:
        settings = Settings()

    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    cache = CacheManager(settings.cache_dir, cache_ttl or settings.cache_ttl_days)

    try:
        # Step 0: Enrich from rfps/ folder + HigherGov
        if agency:
            rfp_path, folder_context = _enrich_from_rfps_folder(
                agency, scope, rfp_path, settings
            )
            if folder_context:
                extra_context = f"{extra_context}\n\n{folder_context}".strip()

        # Step 1: Parse input
        if rfp_path:
            with Status("[bold blue]Parsing RFP...", console=console):
                rfp_context = await parse_rfp(rfp_path, client, settings.haiku_model)
                if agency:
                    rfp_context.agency_name = agency
                if scope:
                    rfp_context.scope = scope
        elif agency:
            rfp_context = RFPContext(agency_name=agency, scope=scope)
        else:
            raise ValueError("Either --rfp file or --agency name is required")

        # Append extra context (from meta.yaml notes, fit areas, etc.)
        if extra_context:
            rfp_context.raw_text = (rfp_context.raw_text + "\n\n" + extra_context).strip()

        console.print(f"[bold green]Agency:[/] {rfp_context.agency_name}")
        if rfp_context.scope:
            console.print(f"[bold green]Scope:[/] {rfp_context.scope}")

        # Step 2: Cache check
        if not no_cache:
            cached = cache.get(rfp_context.agency_name)
            if cached:
                console.print("[bold yellow]Cache hit[/] — using cached dossier")
                # Re-score if RFP context differs
                if cached.rfp_context.scope != rfp_context.scope:
                    with Status("[bold blue]Re-scoring with new context...", console=console):
                        cached.score = await score_opportunity(
                            cached.sections, rfp_context, client, settings.sonnet_model
                        )
                        cached.rfp_context = rfp_context
                write_output(cached, output_dir, fmt)
                return cached

        # Step 3: Generate queries
        with Status("[bold blue]Generating search queries...", console=console):
            queries = await generate_queries(rfp_context, client, settings.haiku_model)

        console.print(f"[bold green]Generated[/] {len(queries)} queries across {len(ResearchArea)} areas")

        if dry_run:
            console.print("\n[bold yellow]DRY RUN[/] — queries generated but not executed:\n")
            for area in ResearchArea:
                area_queries = [q for q in queries if q.area == area]
                if area_queries:
                    console.print(f"  [bold]{area.value}[/]:")
                    for q in area_queries:
                        console.print(f"    - {q.query}")
            return AgencyDossier(
                agency_name=rfp_context.agency_name,
                rfp_context=rfp_context,
                total_queries=len(queries),
            )

        # Step 4: Execute searches
        search_client = BraveSearchClient(
            api_key=settings.brave_api_key,
            max_concurrent=settings.brave_max_concurrent,
            timeout=settings.search_timeout_seconds,
            max_retries=settings.search_max_retries,
            results_per_query=settings.brave_results_per_query,
        )

        # Build relevance terms from agency name for filtering garbage results
        import re as _re
        agency_words = _re.sub(r"\[.*?\]", "", rfp_context.agency_name).strip()
        relevance_terms = [
            rfp_context.agency_name,
            agency_words,
        ]
        # Add key words from agency name (skip short ones like "of", "the")
        for word in agency_words.split():
            if len(word) > 3 and word.lower() not in {"the", "and", "for", "with"}:
                relevance_terms.append(word)
        # Add solicitation number if available
        if rfp_context.solicitation_number:
            relevance_terms.append(rfp_context.solicitation_number)

        try:
            with Status("[bold blue]Searching...", console=console):
                results = await search_client.search_batch(queries, relevance_terms=relevance_terms)
        finally:
            await search_client.close()

        console.print(f"[bold green]Found[/] {len(results)} search results")

        # Step 5: Fetch page content
        with Status("[bold blue]Fetching page content...", console=console):
            pages = await fetch_pages(
                results,
                max_per_area=settings.fetch_max_per_area,
                max_concurrent=settings.fetch_max_concurrent,
                timeout=settings.fetch_timeout_seconds,
            )

        console.print(f"[bold green]Fetched[/] {len(pages)} pages")

        # Step 6: Synthesize dossier
        with Status("[bold blue]Synthesizing dossier...", console=console):
            sections = await synthesize_all(
                results, pages, rfp_context, client,
                settings.sonnet_model, settings.anthropic_max_concurrent,
            )

        ok_count = sum(1 for s in sections if s.status.value == "OK")
        console.print(f"[bold green]Synthesized[/] {ok_count}/8 sections with data")

        # Step 7: Score opportunity
        with Status("[bold blue]Scoring opportunity...", console=console):
            score = await score_opportunity(sections, rfp_context, client, settings.sonnet_model)

        if score:
            color = {"STRONG PURSUE": "green", "PURSUE": "blue", "CONDITIONAL": "yellow", "PASS": "red"}.get(score.recommendation.value, "white")
            console.print(f"[bold {color}]Score: {score.overall_score}/100 — {score.recommendation.value}[/]")
        else:
            console.print("[bold yellow]Scoring unavailable[/]")

        # Build dossier
        total_sources = sum(len(s.sources) for s in sections)
        dossier = AgencyDossier(
            agency_name=rfp_context.agency_name,
            rfp_context=rfp_context,
            sections=sections,
            score=score,
            generated_at=datetime.now(tz=UTC),
            cache_key=cache._cache_key(rfp_context.agency_name),
            total_sources=total_sources,
            total_queries=len(queries),
            llm_cost_estimate_usd=0.40,
        )

        # Step 8: Cache and output
        if not no_cache:
            cache.put(rfp_context.agency_name, dossier)

        written = write_output(dossier, output_dir, fmt)
        for p in written:
            console.print(f"[bold green]Wrote[/] {p}")

        return dossier

    finally:
        await client.close()
