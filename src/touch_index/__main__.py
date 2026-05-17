"""Touch Index ingestion worker CLI — python -m touch_index [fr|bug] [options].

Workers
-------
  fr   (default)  FR ingestion worker — upserts touch_index_fr_files
  bug              Bug-close ingestion worker — upserts touch_index_bug_files

Common flags (both workers)
----------------------------
  --issue-id <uuid>              Process a single issue by Paperclip UUID
  --lookback-minutes <N>         Look back N minutes (default: 30)
  --dry-run                      Log without writing to DB or transitioning
  --validate                     Run data quality validation after ingestion
  --stale-days <N>               Bug worker: stale alert threshold in days (default: 30)
  --stale-hours <N>              FR worker: stale alert threshold in hours (default: 168 = 7d)
  --json-summary                 Output structured JSON summary to stdout

Usage
-----
    python -m touch_index [fr|bug]                          # run polling mode
    python -m touch_index [fr|bug] --issue-id <uuid>        # process single issue
    python -m touch_index [fr|bug] --lookback-minutes 60    # custom lookback window
    python -m touch_index [fr|bug] --dry-run                # dry run
    python -m touch_index [fr|bug] --validate               # validate after ingestion
    python -m touch_index bug --stale-days 60               # custom stale threshold
    python -m touch_index [fr|bug] --json-summary           # structured JSON output
"""

from __future__ import annotations

import atexit
import json
import logging
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)


def _print_help() -> None:
    sys.stdout.write(__doc__.strip() + "\n")


def _run_bug_cli() -> None:
    """Bug worker CLI entry point (from python -m touch_index bug ...)."""
    import argparse

    from touch_index.bug_worker import (
        backfill_null_closed_at,
        catch_up_eligible_bug_issues,
        process_bug_issue,
        run_bug_worker,
    )
    from touch_index.db import get_engine, health_check
    from touch_index.paperclip_client import (
        check_paperclip_credentials,
        get_closed_non_fdr_issues,
        transition_issue_status_board,
    )
    from touch_index.quality import run_bug_quality_checks

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Touch Index bug-close ingestion worker \u2014 upsert bug issue file references",
    )
    parser.add_argument(
        "--issue-id",
        type=str,
        metavar="UUID",
        help="Process a single non-FDR issue by Paperclip UUID (webhook trigger)",
    )
    parser.add_argument(
        "--lookback-minutes",
        type=int,
        default=30,
        help="Process bug issues closed within this many minutes (default: 30)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log what would be ingested without writing to DB",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Run bug data quality validation after ingestion (exits non-zero on failure)",
    )
    parser.add_argument(
        "--json-summary",
        action="store_true",
        help="Output structured JSON summary to stdout after ingestion and validation",
    )
    parser.add_argument(
        "--stale-days",
        type=int,
        default=30,
        help="Validation alert threshold in days for stale rows (default: 30)",
    )
    args = parser.parse_args()
    report: Any | None = None

    engine = get_engine()
    atexit.register(engine.dispose)
    if not health_check(engine):
        logger.error("DB health check failed \u2014 aborting")
        if args.json_summary:
            _emit_json_summary(args, worker="bug")
        raise SystemExit(1)

    cred_err = check_paperclip_credentials()
    if cred_err:
        logger.error("Paperclip credential check failed: %s", cred_err)
        if args.json_summary:
            _emit_json_summary(args, worker="bug")
        raise SystemExit(1)

    if args.issue_id:
        try:
            result = process_bug_issue(engine, args.issue_id, dry_run=args.dry_run)
        except Exception:
            logger.exception("Failed to process bug issue %s", args.issue_id)
            if args.json_summary:
                _emit_json_summary(args, worker="bug")
            raise SystemExit(1)
        if result is None:
            logger.info("No bug issue found for %s", args.issue_id)
        else:
            logger.info(
                "%s: %d files indexed via %s, skipped=%s",
                result.issue_identifier,
                result.files_indexed,
                result.source,
                result.skipped_no_commits,
            )
            if not args.dry_run:
                try:
                    if result.issue_status == "done":
                        transition_issue_status_board(result.issue_id, "done")
                        logger.info("Marked %s as done", result.issue_identifier)
                    else:
                        logger.info(
                            "Bug %s: ingested but status is '%s' — "
                            "skipping transition to done",
                            result.issue_identifier,
                            result.issue_status,
                        )
                except Exception:
                    logger.exception(
                        "Failed to mark %s as done", result.issue_identifier
                    )
            if args.validate:
                report = run_bug_quality_checks(
                    engine, stale_threshold_days=args.stale_days
                )
                if not report.passed:
                    logger.error("VALIDATION FAILED after single-issue ingestion")
                    if args.json_summary:
                        _emit_json_summary(
                            args,
                            worker="bug",
                            result=result,
                            quality_report=report,
                        )
                    raise SystemExit(1)
                logger.info("VALIDATION PASSED after single-issue ingestion")
        if args.json_summary:
            _emit_json_summary(
                args,
                worker="bug",
                result=result,
                quality_report=report,
            )
        return

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=args.lookback_minutes)
    logger.info("Fetching closed non-FDR issues completed after %s", cutoff.isoformat())
    try:
        issues = get_closed_non_fdr_issues(closed_after=cutoff)
    except Exception:
        logger.exception("Failed to fetch closed non-FDR issues from Paperclip API")
        if args.json_summary:
            _emit_json_summary(args, worker="bug")
        raise SystemExit(1)
    logger.info("Found %d closed non-FDR issue(s) to process", len(issues))

    if not issues:
        logger.info("Nothing to do")
        try:
            catchup_results = catch_up_eligible_bug_issues(engine, dry_run=args.dry_run)
        except Exception:
            logger.exception("Catch-up eligible bug issues failed")
            catchup_results = []
        if catchup_results:
            logger.info(
                "Catch-up indexed %d file(s) across %d issue(s)",
                sum(r.files_indexed for r in catchup_results),
                len(catchup_results),
            )
        try:
            backfilled = backfill_null_closed_at(engine, dry_run=args.dry_run)
            if backfilled:
                logger.info("Backfilled %d null-closed_at row(s)", backfilled)
        except Exception:
            logger.exception("Backfill null closed_at failed")
        if args.validate:
            report = run_bug_quality_checks(
                engine, stale_threshold_days=args.stale_days
            )
            if not report.passed:
                logger.error("VALIDATION FAILED \u2014 investigate existing data")
                if args.json_summary:
                    _emit_json_summary(
                        args,
                        worker="bug",
                        results=catchup_results if catchup_results is not None else [],
                        total_files=sum(
                            r.files_indexed for r in (catchup_results or [])
                        ),
                        skipped=sum(
                            1 for r in (catchup_results or []) if r.skipped_no_commits
                        ),
                        quality_report=report,
                    )
                raise SystemExit(1)
            logger.info("VALIDATION PASSED \u2014 existing data clean")
        if args.json_summary:
            _emit_json_summary(
                args,
                worker="bug",
                results=catchup_results if catchup_results is not None else [],
                total_files=sum(r.files_indexed for r in (catchup_results or [])),
                skipped=sum(1 for r in (catchup_results or []) if r.skipped_no_commits),
                quality_report=report,
            )
        return

    results = run_bug_worker(engine, issues, dry_run=args.dry_run)
    worker_count = len(results)
    worker_results = list(results)

    try:
        catchup_results = catch_up_eligible_bug_issues(engine, dry_run=args.dry_run)
    except Exception:
        logger.exception("Catch-up eligible bug issues failed")
        catchup_results = []
    if catchup_results:
        logger.info(
            "Catch-up indexed %d file(s) across %d issue(s)",
            sum(r.files_indexed for r in catchup_results),
            len(catchup_results),
        )
    results.extend(catchup_results)

    try:
        backfilled = backfill_null_closed_at(engine, dry_run=args.dry_run)
        if backfilled:
            logger.info("Backfilled %d null-closed_at row(s)", backfilled)
    except Exception:
        logger.exception("Backfill null closed_at failed")

    errors = len(issues) - worker_count
    if errors:
        logger.warning(
            "%d issue(s) had processing errors \u2014 check logs above for details",
            errors,
        )

    total_files = sum(r.files_indexed for r in results)
    skipped = sum(1 for r in results if r.skipped_no_commits)

    if args.dry_run:
        logger.info(
            "DRY RUN \u2014 skipping transition-to-done for %d issue(s)", len(issues)
        )
    else:
        for r in worker_results:
            try:
                if r.issue_status == "done":
                    transition_issue_status_board(r.issue_id, "done")
                    logger.info("Marked %s as done", r.issue_identifier)
                else:
                    logger.info(
                        "Bug %s: ingested but status is '%s' \u2014 "
                        "skipping transition to done",
                        r.issue_identifier,
                        r.issue_status,
                    )
            except Exception:
                logger.exception("Failed to mark %s as done", r.issue_identifier)

    if args.validate:
        report = run_bug_quality_checks(engine, stale_threshold_days=args.stale_days)
        if not report.passed:
            logger.error("VALIDATION FAILED after ingestion \u2014 investigate")
            if args.json_summary:
                _emit_json_summary(
                    args,
                    worker="bug",
                    results=results,
                    total_files=total_files,
                    skipped=skipped,
                    errors=errors,
                    quality_report=report,
                )
            raise SystemExit(1)
        logger.info("VALIDATION PASSED: all bug quality checks clean")

    logger.info(
        "Bug worker done \u2014 %d issues processed, %d files indexed, %d skipped (no commits), %d errors",
        len(results),
        total_files,
        skipped,
        errors,
    )

    if args.json_summary:
        _emit_json_summary(
            args,
            worker="bug",
            results=results,
            total_files=total_files,
            skipped=skipped,
            errors=errors,
            quality_report=report,
        )


def _emit_json_summary(
    args: argparse.Namespace,
    worker: str,
    results: list[Any] | None = None,
    result: Any | None = None,
    total_files: int = 0,
    skipped: int = 0,
    errors: int = 0,
    quality_report: Any | None = None,
) -> None:
    """Emit a structured JSON summary of the worker run to stdout."""
    summary: dict[str, Any] = {
        "worker": worker,
        "mode": "single-issue" if args.issue_id else "polling",
        "dry_run": args.dry_run,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if result is not None:
        summary["result"] = {
            "issue_identifier": result.issue_identifier,
            "issue_id": result.issue_id,
            "files_indexed": result.files_indexed,
            "source": result.source,
            "skipped_no_commits": result.skipped_no_commits,
            "issue_status": result.issue_status,
        }
    if results is not None:
        summary["issues_processed"] = len(results)
        summary["total_files_indexed"] = total_files
        summary["issues_skipped"] = skipped
        if errors:
            summary["issues_with_errors"] = errors
    if quality_report is not None:
        summary["quality"] = quality_report.to_dict()
    sys.stdout.write(json.dumps(summary, default=str) + "\n")


def _run_fr_cli() -> None:
    """FR worker CLI entry point (from python -m touch_index fr ...)."""
    import argparse

    from touch_index.db import get_engine, health_check
    from touch_index.fr_worker import (
        catch_up_eligible_fr_issues,
        process_fr_issue,
        run_fr_worker,
    )
    from touch_index.paperclip_client import (
        check_paperclip_credentials,
        get_fdr_issues,
        transition_issue_status_board,
    )
    from touch_index.quality import run_quality_checks

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Touch Index FR ingestion worker \u2014 upsert FDR issue file references",
    )
    parser.add_argument(
        "--issue-id",
        type=str,
        metavar="UUID",
        help="Process a single FDR issue by Paperclip UUID (webhook trigger)",
    )
    parser.add_argument(
        "--lookback-minutes",
        type=int,
        default=30,
        help="Process FDR issues updated within this many minutes (default: 30)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log what would be ingested without writing to DB or transitioning issues",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Run FR data quality validation after ingestion (exits non-zero on failure)",
    )
    parser.add_argument(
        "--json-summary",
        action="store_true",
        help="Output structured JSON summary to stdout after ingestion and validation",
    )
    parser.add_argument(
        "--stale-hours",
        type=int,
        default=168,
        help="Validation alert threshold in hours for stale rows (default: 168 = 7d)",
    )
    args = parser.parse_args()
    report: Any | None = None

    engine = get_engine()
    atexit.register(engine.dispose)
    if not health_check(engine):
        logger.error("DB health check failed \u2014 aborting")
        if args.json_summary:
            _emit_json_summary(args, worker="fr")
        raise SystemExit(1)

    cred_err = check_paperclip_credentials()
    if cred_err:
        logger.error("Paperclip credential check failed: %s", cred_err)
        if args.json_summary:
            _emit_json_summary(args, worker="fr")
        raise SystemExit(1)

    if args.issue_id:
        try:
            result = process_fr_issue(engine, args.issue_id, dry_run=args.dry_run)
        except Exception:
            logger.exception("Failed to process FR issue %s", args.issue_id)
            if args.json_summary:
                _emit_json_summary(args, worker="fr")
            raise SystemExit(1)
        if result is None:
            logger.info("No FR issue found for %s", args.issue_id)
        else:
            logger.info(
                "%s: %d files indexed via %s, skipped=%s",
                result.issue_identifier,
                result.files_indexed,
                result.source,
                result.skipped_no_commits,
            )
            if not args.dry_run:
                try:
                    if result.issue_status == "done":
                        transition_issue_status_board(result.issue_id, "done")
                        logger.info("Marked %s as done", result.issue_identifier)
                    else:
                        logger.info(
                            "FR %s: ingested but status is '%s' — "
                            "skipping transition to done",
                            result.issue_identifier,
                            result.issue_status,
                        )
                except Exception:
                    logger.exception(
                        "Failed to mark %s as done", result.issue_identifier
                    )
            if args.validate:
                report = run_quality_checks(
                    engine, stale_threshold_hours=args.stale_hours
                )
                if not report.passed:
                    logger.error("VALIDATION FAILED after single-issue ingestion")
                    if args.json_summary:
                        _emit_json_summary(
                            args, worker="fr", result=result, quality_report=report
                        )
                    raise SystemExit(1)
                logger.info("VALIDATION PASSED after single-issue ingestion")
        if args.json_summary:
            _emit_json_summary(args, worker="fr", result=result, quality_report=report)
        return

    cutoff = datetime.now(timezone.utc) - timedelta(minutes=args.lookback_minutes)
    logger.info("Fetching FDR issues updated after %s", cutoff.isoformat())
    try:
        issues = get_fdr_issues(updated_after=cutoff)
    except Exception:
        logger.exception("Failed to fetch FDR issues from Paperclip API")
        if args.json_summary:
            _emit_json_summary(args, worker="fr")
        raise SystemExit(1)
    logger.info("Found %d FDR issue(s) to process", len(issues))

    if not issues:
        logger.info("Nothing to do")
        try:
            catchup_results = catch_up_eligible_fr_issues(engine, dry_run=args.dry_run)
        except Exception:
            logger.exception("Catch-up eligible FR issues failed")
            catchup_results = []
        if catchup_results:
            logger.info(
                "Catch-up indexed %d file(s) across %d issue(s)",
                sum(r.files_indexed for r in catchup_results),
                len(catchup_results),
            )
        if args.validate:
            report = run_quality_checks(engine, stale_threshold_hours=args.stale_hours)
            if not report.passed:
                logger.error("VALIDATION FAILED \u2014 investigate existing data")
                if args.json_summary:
                    _emit_json_summary(
                        args,
                        worker="fr",
                        results=catchup_results if catchup_results is not None else [],
                        total_files=sum(
                            r.files_indexed for r in (catchup_results or [])
                        ),
                        skipped=sum(
                            1 for r in (catchup_results or []) if r.skipped_no_commits
                        ),
                        quality_report=report,
                    )
                raise SystemExit(1)
            logger.info("VALIDATION PASSED \u2014 existing data clean")
        if args.json_summary:
            _emit_json_summary(
                args,
                worker="fr",
                results=catchup_results if catchup_results is not None else [],
                total_files=sum(r.files_indexed for r in (catchup_results or [])),
                skipped=sum(1 for r in (catchup_results or []) if r.skipped_no_commits),
                quality_report=report,
            )
        return

    results = run_fr_worker(engine, issues, dry_run=args.dry_run)
    worker_count = len(results)
    worker_results = list(results)

    try:
        catchup_results = catch_up_eligible_fr_issues(engine, dry_run=args.dry_run)
    except Exception:
        logger.exception("Catch-up eligible FR issues failed")
        catchup_results = []
    if catchup_results:
        logger.info(
            "Catch-up indexed %d file(s) across %d issue(s)",
            sum(r.files_indexed for r in catchup_results),
            len(catchup_results),
        )
    results.extend(catchup_results)

    errors = len(issues) - worker_count
    if errors:
        logger.warning(
            "%d issue(s) had processing errors \u2014 check logs above for details",
            errors,
        )

    total_files = sum(r.files_indexed for r in results)
    skipped = sum(1 for r in results if r.skipped_no_commits)

    if args.dry_run:
        logger.info(
            "DRY RUN \u2014 skipping transition-to-done for %d issue(s)", len(issues)
        )
    else:
        for r in worker_results:
            try:
                if r.issue_status == "done":
                    transition_issue_status_board(r.issue_id, "done")
                    logger.info("Marked %s as done", r.issue_identifier)
                else:
                    logger.info(
                        "FR %s: ingested but status is '%s' — "
                        "skipping transition to done",
                        r.issue_identifier,
                        r.issue_status,
                    )
            except Exception:
                logger.exception("Failed to mark %s as done", r.issue_identifier)

    if args.validate:
        report = run_quality_checks(engine, stale_threshold_hours=args.stale_hours)
        if not report.passed:
            logger.error("VALIDATION FAILED after ingestion \u2014 investigate")
            if args.json_summary:
                _emit_json_summary(
                    args,
                    worker="fr",
                    results=results,
                    total_files=total_files,
                    skipped=skipped,
                    errors=errors,
                    quality_report=report,
                )
            raise SystemExit(1)
        logger.info("VALIDATION PASSED: all quality checks clean")
    logger.info(
        "FR worker done \u2014 %d issues processed, %d files indexed, %d skipped (no commits), %d errors",
        len(results),
        total_files,
        skipped,
        errors,
    )

    if args.json_summary:
        _emit_json_summary(
            args,
            worker="fr",
            results=results,
            total_files=total_files,
            skipped=skipped,
            errors=errors,
            quality_report=report,
        )


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] in ("--help", "-h"):
        _print_help()
        return

    worker = "fr"
    if len(sys.argv) > 1:
        if sys.argv[1] in ("fr", "bug"):
            worker = sys.argv.pop(1)
        elif not sys.argv[1].startswith("-"):
            logger.warning("Unknown worker '%s' — defaulting to 'fr'", sys.argv[1])
            sys.argv.pop(1)

    if worker == "bug":
        _run_bug_cli()
    else:
        _run_fr_cli()


if __name__ == "__main__":
    main()