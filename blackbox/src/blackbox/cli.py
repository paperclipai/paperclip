"""Typer CLI entry point for Blackbox."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from blackbox import __version__
from blackbox.cache import CacheManager
from blackbox.config import Settings

app = typer.Typer(
    name="blackbox",
    help="ConsultAdd RFP Research Agent — agency dossiers with qualification scoring.",
    no_args_is_help=True,
)
cache_app = typer.Typer(name="cache", help="Manage cached agency dossiers.")
app.add_typer(cache_app)
console = Console()


def _check_env() -> Settings:
    """Validate required environment variables and return Settings."""
    # Load .env file from the blackbox package root if it exists
    env_file = Path(__file__).resolve().parents[2] / ".env"
    if env_file.exists():
        from dotenv import load_dotenv
        load_dotenv(env_file, override=False)

    missing = []
    if not os.environ.get("ANTHROPIC_API_KEY"):
        missing.append("ANTHROPIC_API_KEY")
    if not os.environ.get("BRAVE_API_KEY"):
        missing.append("BRAVE_API_KEY")
    if missing:
        console.print(f"[bold red]Missing required environment variables:[/] {', '.join(missing)}")
        console.print("Set them in your shell or in a .env file. See .env.example.")
        raise typer.Exit(1)
    return Settings()


@app.command()
def research(
    rfp_file: Optional[Path] = typer.Argument(None, help="Path to RFP file (PDF or DOCX)"),
    agency: Optional[str] = typer.Option(None, "--agency", "-a", help="Agency name (required if no RFP file)"),
    scope: str = typer.Option("", "--scope", "-s", help="Scope description"),
    output: Path = typer.Option(Path("output"), "--output", "-o", help="Output directory"),
    fmt: str = typer.Option("both", "--format", "-f", help="Output format: json, md, or both"),
    no_cache: bool = typer.Option(False, "--no-cache", help="Skip cache, force fresh research"),
    cache_ttl: Optional[int] = typer.Option(None, "--cache-ttl", help="Cache TTL in days"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Generate queries but don't execute"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
) -> None:
    """Research an agency and produce a dossier with qualification scoring."""
    if not rfp_file and not agency:
        console.print("[bold red]Error:[/] Provide an RFP file or use --agency flag.")
        raise typer.Exit(1)

    if rfp_file and not rfp_file.exists():
        console.print(f"[bold red]Error:[/] File not found: {rfp_file}")
        raise typer.Exit(1)

    if fmt not in ("json", "md", "both"):
        console.print(f"[bold red]Error:[/] Invalid format: {fmt}. Use json, md, or both.")
        raise typer.Exit(1)

    settings = _check_env()

    import logging
    if verbose:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.WARNING)

    from blackbox.pipeline import run

    asyncio.run(
        run(
            rfp_path=rfp_file,
            agency=agency,
            scope=scope,
            output_dir=output,
            fmt=fmt,
            no_cache=no_cache,
            cache_ttl=cache_ttl,
            dry_run=dry_run,
            settings=settings,
        )
    )


@cache_app.command("list")
def cache_list() -> None:
    """List cached agency dossiers."""
    settings = Settings()
    cache = CacheManager(settings.cache_dir, settings.cache_ttl_days)
    entries = cache.list_entries()

    if not entries:
        console.print("Cache is empty.")
        return

    table = Table(title="Cached Agency Dossiers")
    table.add_column("Agency", style="cyan")
    table.add_column("Created", style="green")
    table.add_column("Expires", style="yellow")
    table.add_column("Size", justify="right")

    for e in entries:
        table.add_row(
            e["agency"],
            e["created"][:19] if e["created"] else "—",
            e["expires"][:19] if e["expires"] else "—",
            f"{e['size_kb']:.1f} KB",
        )

    console.print(table)


@cache_app.command("clear")
def cache_clear(
    agency: Optional[str] = typer.Option(None, "--agency", "-a", help="Clear specific agency"),
) -> None:
    """Clear cached dossiers."""
    settings = Settings()
    cache = CacheManager(settings.cache_dir, settings.cache_ttl_days)
    count = cache.clear(agency)
    if count:
        console.print(f"[bold green]Cleared[/] {count} cached dossier(s).")
    else:
        console.print("Nothing to clear.")


@app.command()
def agent(
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Verbose output"),
) -> None:
    """Run as a Paperclip agent — pick up tasks, research, report results."""
    import logging
    logging.basicConfig(level=logging.DEBUG if verbose else logging.WARNING)

    from blackbox.paperclip import PaperclipClient, get_paperclip_env, parse_task_for_research, find_rfp_folder
    from blackbox.pipeline import run
    from blackbox.output import render_markdown

    env = get_paperclip_env()
    if not env["agent_id"] or not env["company_id"]:
        console.print("[bold red]Error:[/] PAPERCLIP_AGENT_ID and PAPERCLIP_COMPANY_ID must be set.")
        console.print("This command is meant to be invoked by Paperclip's process adapter.")
        raise typer.Exit(1)

    settings = _check_env()
    pc = PaperclipClient(base_url=env["api_url"], api_key=env["api_key"])

    try:
        # Get assigned tasks
        tasks = pc.get_assigned_tasks(env["agent_id"], env["company_id"])
        if not tasks:
            console.print("[yellow]No tasks assigned. Nothing to do.[/]")
            return

        console.print(f"[bold green]Found {len(tasks)} task(s)[/]")

        for task in tasks:
            issue_id = task["id"]
            console.print(f"\n[bold blue]Processing:[/] {task.get('title', issue_id)}")

            # Atomic checkout
            claimed = pc.checkout_task(issue_id, env["agent_id"])
            if not claimed:
                console.print(f"[yellow]Skipped[/] — already claimed")
                continue

            # Parse task to extract research params
            params = parse_task_for_research(task)
            if not params["agency"]:
                pc.fail_task(issue_id, "Could not extract agency name from task title/description. Use format: 'Research {Agency Name}: {Scope}'")
                continue

            try:
                # Look up RFP folder for this agency
                rfp_path = None
                extra_notes = ""
                if params["rfp_path"]:
                    from pathlib import Path as P
                    rfp_path = P(params["rfp_path"])
                    if not rfp_path.exists():
                        rfp_path = None

                if not rfp_path:
                    rfp_info = find_rfp_folder(params["agency"], params.get("scope", ""))
                    if rfp_info["rfp_path"]:
                        rfp_path = rfp_info["rfp_path"]
                        extra_notes = rfp_info["notes"]
                        console.print(f"[bold green]Found RFP:[/] {rfp_path.name}")
                        # Enrich scope from meta if sparse
                        meta = rfp_info["meta"]
                        if not params["scope"] and meta.get("scope"):
                            params["scope"] = meta["scope"]

                    # Fetch documents from HigherGov if opp_key available
                    highergov_opp_key = rfp_info.get("highergov_opp_key", "")
                    if highergov_opp_key and settings.highergov_api_key:
                        console.print(f"[bold blue]Fetching from HigherGov:[/] {highergov_opp_key}")
                        from blackbox.highergov import HigherGovClient
                        hg = HigherGovClient(
                            api_key=settings.highergov_api_key,
                            base_url=settings.highergov_api_base_url,
                            doc_url=settings.highergov_api_doc_url,
                        )
                        try:
                            hg_text, hg_opp, hg_docs = hg.get_full_text(highergov_opp_key)
                            if hg_text:
                                extra_notes = f"{extra_notes}\n\n{hg_text}".strip()
                                console.print(f"[bold green]HigherGov:[/] {len(hg_docs)} document(s), {len(hg_text)} chars")
                            # Download PDFs to rfp folder
                            rfp_dir = rfp_info.get("rfp_dir")
                            if rfp_dir and hg_docs:
                                for doc in hg_docs:
                                    saved = hg.download_document(doc, rfp_dir)
                                    if saved:
                                        console.print(f"[bold green]Downloaded:[/] {saved.name}")
                                        if not rfp_path:
                                            rfp_path = saved
                        except Exception as exc:
                            console.print(f"[yellow]HigherGov fetch failed:[/] {exc}")
                        finally:
                            hg.close()

                dossier = asyncio.run(run(
                    rfp_path=rfp_path,
                    agency=params["agency"],
                    scope=params["scope"],
                    extra_context=extra_notes,
                    settings=settings,
                ))

                # Build result comment
                score_text = ""
                if dossier.score:
                    score_text = f"**Score: {dossier.score.overall_score}/100 — {dossier.score.recommendation.value}**\n\n"

                sections_summary = []
                for s in dossier.sections:
                    status = "INSUFFICIENT DATA" if s.status.value == "INSUFFICIENT_DATA" else f"{s.confidence:.0%}"
                    sections_summary.append(f"- {s.title}: {status}")

                comment = (
                    f"## Research Complete: {dossier.agency_name}\n\n"
                    f"{score_text}"
                    f"**Sections:**\n" + "\n".join(sections_summary) + "\n\n"
                    f"*{dossier.total_queries} queries | {dossier.total_sources} sources | ~${dossier.llm_cost_estimate_usd:.2f}*\n\n"
                    f"<details><summary>Full Dossier</summary>\n\n{render_markdown(dossier)}\n\n</details>"
                )

                pc.complete_task(issue_id, comment)
                console.print(f"[bold green]Done[/] — {dossier.agency_name}: {dossier.score.recommendation.value if dossier.score else 'no score'}")

            except Exception as exc:
                pc.fail_task(issue_id, f"Pipeline failed: {exc}")
                console.print(f"[bold red]Failed[/] — {exc}")

    finally:
        pc.close()


@app.command()
def version() -> None:
    """Print version."""
    console.print(f"Blackbox v{__version__}")


if __name__ == "__main__":
    app()
