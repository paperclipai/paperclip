#!/usr/bin/env python3
"""
Runtime Topology Report for Paperclip/Selarix

Enumerates and indexes all operational runtime state on disk:
- Companies, projects, agents, prompt caches
- Storage assets, backup archives
- Identifies orphaned state, stale entities, duplicates, missing metadata

Output: JSON report + markdown summary to stdout or file.

Usage:
    python scripts/runtime_topology_report.py [--json] [--output DIR]
"""

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Default instance root
DEFAULT_INSTANCE_ROOT = Path.home() / ".paperclip" / "instances" / "default"

# Staleness threshold: 14 days without modification
STALE_DAYS = 14


def _update_stale_days(days: int):
    global STALE_DAYS
    STALE_DAYS = days


def get_dir_stats(path: Path) -> dict:
    """Get file count, total size, and most recent modification time for a directory."""
    file_count = 0
    total_size = 0
    most_recent = None

    if not path.exists():
        return {"file_count": 0, "total_size_bytes": 0, "most_recent_modified": None}

    for f in path.rglob("*"):
        if f.is_file():
            file_count += 1
            stat = f.stat()
            total_size += stat.st_size
            mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
            if most_recent is None or mtime > most_recent:
                most_recent = mtime

    return {
        "file_count": file_count,
        "total_size_bytes": total_size,
        "most_recent_modified": most_recent.isoformat() if most_recent else None,
    }


def format_size(size_bytes: int) -> str:
    """Human-readable file size."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"


def is_stale(most_recent_modified: str | None, threshold_days: int = STALE_DAYS) -> bool:
    """Check if a timestamp is older than threshold_days."""
    if most_recent_modified is None:
        return True
    mtime = datetime.fromisoformat(most_recent_modified)
    now = datetime.now(tz=timezone.utc)
    return (now - mtime).days > threshold_days


def enumerate_companies(root: Path) -> list[dict]:
    """Enumerate all companies and their agents/prompt caches."""
    companies_dir = root / "companies"
    companies = []

    if not companies_dir.exists():
        return companies

    for company_dir in sorted(companies_dir.iterdir()):
        if not company_dir.is_dir():
            continue

        company_id = company_dir.name
        stats = get_dir_stats(company_dir)

        # Agents
        agents = []
        agents_dir = company_dir / "agents"
        if agents_dir.exists():
            for agent_dir in sorted(agents_dir.iterdir()):
                if not agent_dir.is_dir():
                    continue
                agent_stats = get_dir_stats(agent_dir)
                has_instructions = (agent_dir / "instructions").exists()
                agents.append({
                    "agent_id": agent_dir.name,
                    "has_instructions": has_instructions,
                    "stats": agent_stats,
                    "stale": is_stale(agent_stats["most_recent_modified"]),
                })

        # Prompt caches
        prompt_caches = []
        cache_dir = company_dir / "claude-prompt-cache"
        if cache_dir.exists():
            for cache_entry in sorted(cache_dir.iterdir()):
                if not cache_entry.is_dir():
                    continue
                cache_stats = get_dir_stats(cache_entry)
                prompt_caches.append({
                    "cache_hash": cache_entry.name,
                    "stats": cache_stats,
                    "stale": is_stale(cache_stats["most_recent_modified"]),
                })

        companies.append({
            "company_id": company_id,
            "path": str(company_dir),
            "agents": agents,
            "agent_count": len(agents),
            "prompt_caches": prompt_caches,
            "prompt_cache_count": len(prompt_caches),
            "stats": stats,
            "stale": is_stale(stats["most_recent_modified"]),
        })

    return companies


def enumerate_projects(root: Path) -> list[dict]:
    """Enumerate all projects grouped by company."""
    projects_dir = root / "projects"
    projects = []

    if not projects_dir.exists():
        return projects

    for company_dir in sorted(projects_dir.iterdir()):
        if not company_dir.is_dir():
            continue

        company_id = company_dir.name
        for project_dir in sorted(company_dir.iterdir()):
            if not project_dir.is_dir():
                continue

            stats = get_dir_stats(project_dir)
            projects.append({
                "company_id": company_id,
                "project_id": project_dir.name,
                "path": str(project_dir),
                "stats": stats,
                "stale": is_stale(stats["most_recent_modified"]),
                "has_metadata": any(project_dir.glob("*.json")),
            })

    return projects


def enumerate_storage(root: Path) -> list[dict]:
    """Enumerate storage assets."""
    storage_dir = root / "data" / "storage"
    assets = []

    if not storage_dir.exists():
        return assets

    for company_dir in sorted(storage_dir.iterdir()):
        if not company_dir.is_dir():
            continue

        stats = get_dir_stats(company_dir)
        files = list(company_dir.rglob("*"))
        file_list = [str(f.relative_to(company_dir)) for f in files if f.is_file()]

        assets.append({
            "company_id": company_dir.name,
            "path": str(company_dir),
            "stats": stats,
            "files": file_list[:50],  # Cap at 50 for readability
            "stale": is_stale(stats["most_recent_modified"]),
        })

    return assets


def enumerate_backups(root: Path) -> dict:
    """Enumerate backup archives."""
    backup_dir = root / "data" / "backups"

    if not backup_dir.exists():
        return {"path": str(backup_dir), "exists": False, "archives": []}

    archives = []
    for f in sorted(backup_dir.iterdir()):
        if f.is_file():
            stat = f.stat()
            archives.append({
                "filename": f.name,
                "size_bytes": stat.st_size,
                "size_human": format_size(stat.st_size),
                "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
            })

    total_size = sum(a["size_bytes"] for a in archives)
    oldest = archives[0]["modified"] if archives else None
    newest = archives[-1]["modified"] if archives else None

    return {
        "path": str(backup_dir),
        "exists": True,
        "archive_count": len(archives),
        "total_size_bytes": total_size,
        "total_size_human": format_size(total_size),
        "oldest": oldest,
        "newest": newest,
        "archives": archives,
    }


def enumerate_run_logs(root: Path) -> list[dict]:
    """Enumerate run logs per company/agent."""
    logs_dir = root / "data" / "run-logs"
    entries = []

    if not logs_dir.exists():
        return entries

    for company_dir in sorted(logs_dir.iterdir()):
        if not company_dir.is_dir():
            continue

        company_id = company_dir.name
        for agent_dir in sorted(company_dir.iterdir()):
            if not agent_dir.is_dir():
                continue

            stats = get_dir_stats(agent_dir)
            entries.append({
                "company_id": company_id,
                "agent_id": agent_dir.name,
                "path": str(agent_dir),
                "stats": stats,
            })

    return entries


def detect_orphans(companies: list[dict], projects: list[dict], storage: list[dict], run_logs: list[dict]) -> dict:
    """Detect orphaned runtime state."""
    company_ids = {c["company_id"] for c in companies}
    project_company_ids = {p["company_id"] for p in projects}
    storage_company_ids = {s["company_id"] for s in storage}
    run_log_company_ids = {r["company_id"] for r in run_logs}

    # Agents referenced in run-logs but missing from companies
    company_agent_ids = {}
    for c in companies:
        company_agent_ids[c["company_id"]] = {a["agent_id"] for a in c["agents"]}

    orphaned_run_logs = []
    for r in run_logs:
        if r["company_id"] not in company_ids:
            orphaned_run_logs.append({"type": "company_missing", **r})
        elif r["agent_id"] not in company_agent_ids.get(r["company_id"], set()):
            orphaned_run_logs.append({"type": "agent_missing_from_company", **r})

    # Storage for companies that don't exist
    orphaned_storage = [s for s in storage if s["company_id"] not in company_ids]

    # Projects for companies that don't exist
    orphaned_projects = [p for p in projects if p["company_id"] not in company_ids]

    return {
        "orphaned_run_logs": orphaned_run_logs,
        "orphaned_storage": orphaned_storage,
        "orphaned_projects": orphaned_projects,
        "total_orphans": len(orphaned_run_logs) + len(orphaned_storage) + len(orphaned_projects),
    }


def detect_duplicates(companies: list[dict]) -> list[dict]:
    """Detect duplicate agents (same instructions hash across companies)."""
    agent_hashes = {}
    duplicates = []

    for company in companies:
        for agent in company["agents"]:
            agent_dir = Path(company["path"]) / "agents" / agent["agent_id"] / "instructions"
            if agent_dir.exists():
                # Hash all instruction files
                content = b""
                for f in sorted(agent_dir.rglob("*")):
                    if f.is_file():
                        content += f.read_bytes()
                if content:
                    h = hashlib.sha256(content).hexdigest()[:16]
                    key = h
                    entry = {
                        "company_id": company["company_id"],
                        "agent_id": agent["agent_id"],
                        "instructions_hash": h,
                    }
                    if key in agent_hashes:
                        agent_hashes[key].append(entry)
                    else:
                        agent_hashes[key] = [entry]

    for h, entries in agent_hashes.items():
        if len(entries) > 1:
            duplicates.append({"hash": h, "agents": entries})

    return duplicates


def detect_missing_metadata(companies: list[dict], projects: list[dict]) -> list[dict]:
    """Detect entities missing expected metadata."""
    issues = []

    for company in companies:
        for agent in company["agents"]:
            if not agent["has_instructions"]:
                issues.append({
                    "type": "agent_missing_instructions",
                    "company_id": company["company_id"],
                    "agent_id": agent["agent_id"],
                })

    for project in projects:
        if not project["has_metadata"]:
            issues.append({
                "type": "project_missing_metadata_json",
                "company_id": project["company_id"],
                "project_id": project["project_id"],
            })

    return issues


def build_health_flags(report: dict) -> list[str]:
    """Generate health flags based on report data."""
    flags = []

    if report["orphans"]["total_orphans"] > 0:
        flags.append(f"ORPHANED_STATE: {report['orphans']['total_orphans']} orphaned entries found")

    stale_companies = [c for c in report["companies"] if c["stale"]]
    if stale_companies:
        flags.append(f"STALE_COMPANIES: {len(stale_companies)} companies inactive > {STALE_DAYS} days")

    if report["duplicates"]:
        flags.append(f"DUPLICATE_AGENTS: {len(report['duplicates'])} duplicate instruction sets")

    if report["missing_metadata"]:
        flags.append(f"MISSING_METADATA: {len(report['missing_metadata'])} entities missing metadata")

    backups = report["backups"]
    if backups["exists"] and backups["archive_count"] > 0:
        newest = datetime.fromisoformat(backups["newest"])
        hours_since = (datetime.now(tz=timezone.utc) - newest).total_seconds() / 3600
        if hours_since > 24:
            flags.append(f"BACKUP_GAP: Last backup {hours_since:.0f}h ago")
    elif not backups["exists"]:
        flags.append("NO_BACKUPS: Backup directory missing")

    if not flags:
        flags.append("HEALTHY: No issues detected")

    return flags


def generate_markdown_summary(report: dict) -> str:
    """Generate markdown summary from report."""
    lines = []
    lines.append("# Runtime Topology Report")
    lines.append(f"\n**Generated:** {report['generated_at']}")
    lines.append(f"**Instance:** {report['instance_root']}")
    lines.append("")

    # Health flags
    lines.append("## Health Status")
    for flag in report["health_flags"]:
        icon = "[OK]" if flag.startswith("HEALTHY") else "[!!]"
        lines.append(f"- {icon} {flag}")
    lines.append("")

    # Summary
    lines.append("## Summary")
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|-------|")
    lines.append(f"| Companies | {len(report['companies'])} |")
    lines.append(f"| Projects | {len(report['projects'])} |")
    total_agents = sum(c["agent_count"] for c in report["companies"])
    lines.append(f"| Agents | {total_agents} |")
    total_caches = sum(c["prompt_cache_count"] for c in report["companies"])
    lines.append(f"| Prompt Caches | {total_caches} |")
    lines.append(f"| Storage Assets | {len(report['storage'])} |")
    lines.append(f"| Backup Archives | {report['backups']['archive_count']} |")
    lines.append(f"| Backup Total Size | {report['backups'].get('total_size_human', 'N/A')} |")
    lines.append("")

    # Companies
    lines.append("## Companies")
    for company in report["companies"]:
        stale_marker = " [STALE]" if company["stale"] else ""
        lines.append(f"\n### `{company['company_id']}`{stale_marker}")
        lines.append(f"- Agents: {company['agent_count']}")
        lines.append(f"- Prompt Caches: {company['prompt_cache_count']}")
        lines.append(f"- Files: {company['stats']['file_count']}")
        lines.append(f"- Size: {format_size(company['stats']['total_size_bytes'])}")
        lines.append(f"- Last Activity: {company['stats']['most_recent_modified'] or 'never'}")

        if company["agents"]:
            lines.append(f"- Agents:")
            for agent in company["agents"]:
                stale_a = " (stale)" if agent["stale"] else ""
                lines.append(f"  - `{agent['agent_id']}` -{agent['stats']['file_count']} files, "
                           f"{format_size(agent['stats']['total_size_bytes'])}{stale_a}")

    lines.append("")

    # Projects
    lines.append("## Projects")
    for project in report["projects"]:
        stale_marker = " [STALE]" if project["stale"] else ""
        lines.append(f"- `{project['project_id']}` (company: `{project['company_id']}`){stale_marker}")
        lines.append(f"  - Files: {project['stats']['file_count']}, "
                   f"Size: {format_size(project['stats']['total_size_bytes'])}")
    lines.append("")

    # Backups
    lines.append("## Backups")
    if report["backups"]["exists"]:
        lines.append(f"- Count: {report['backups']['archive_count']}")
        lines.append(f"- Total Size: {report['backups']['total_size_human']}")
        lines.append(f"- Oldest: {report['backups']['oldest']}")
        lines.append(f"- Newest: {report['backups']['newest']}")
    else:
        lines.append("- [!!] No backup directory found")
    lines.append("")

    # Issues
    if report["orphans"]["total_orphans"] > 0:
        lines.append("## Orphaned State")
        for item in report["orphans"]["orphaned_run_logs"]:
            lines.append(f"- Run log: company=`{item['company_id']}` agent=`{item['agent_id']}` ({item['type']})")
        for item in report["orphans"]["orphaned_storage"]:
            lines.append(f"- Storage: company=`{item['company_id']}`")
        for item in report["orphans"]["orphaned_projects"]:
            lines.append(f"- Project: `{item['project_id']}` (company=`{item['company_id']}`)")
        lines.append("")

    if report["duplicates"]:
        lines.append("## Duplicate Agents")
        for dup in report["duplicates"]:
            lines.append(f"- Hash `{dup['hash']}`: {len(dup['agents'])} copies")
            for a in dup["agents"]:
                lines.append(f"  - company=`{a['company_id']}` agent=`{a['agent_id']}`")
        lines.append("")

    if report["missing_metadata"]:
        lines.append("## Missing Metadata")
        for issue in report["missing_metadata"]:
            parts = [f"{k}=`{v}`" for k, v in issue.items() if k != "type"]
            lines.append(f"- {issue['type']}: {', '.join(parts)}")
        lines.append("")

    return "\n".join(lines)


def run_report(instance_root: Path) -> dict:
    """Build the full topology report."""
    companies = enumerate_companies(instance_root)
    projects = enumerate_projects(instance_root)
    storage = enumerate_storage(instance_root)
    backups = enumerate_backups(instance_root)
    run_logs = enumerate_run_logs(instance_root)

    orphans = detect_orphans(companies, projects, storage, run_logs)
    duplicates = detect_duplicates(companies)
    missing_metadata = detect_missing_metadata(companies, projects)

    report = {
        "generated_at": datetime.now(tz=timezone.utc).isoformat(),
        "instance_root": str(instance_root),
        "companies": companies,
        "projects": projects,
        "storage": storage,
        "backups": backups,
        "run_logs": run_logs,
        "orphans": orphans,
        "duplicates": duplicates,
        "missing_metadata": missing_metadata,
        "health_flags": [],
    }

    report["health_flags"] = build_health_flags(report)
    return report


def main():
    parser = argparse.ArgumentParser(description="Paperclip/Selarix Runtime Topology Report")
    parser.add_argument("--instance-root", type=Path, default=DEFAULT_INSTANCE_ROOT,
                        help="Path to instance root (default: ~/.paperclip/instances/default)")
    parser.add_argument("--json", action="store_true", help="Output JSON only")
    parser.add_argument("--output", type=Path, help="Write output to directory")
    parser.add_argument("--stale-days", type=int, default=STALE_DAYS,
                        help=f"Days of inactivity before marking stale (default: {STALE_DAYS})")
    args = parser.parse_args()

    _update_stale_days(args.stale_days)

    if not args.instance_root.exists():
        print(f"ERROR: Instance root not found: {args.instance_root}", file=sys.stderr)
        sys.exit(1)

    report = run_report(args.instance_root)

    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        json_path = args.output / "topology_report.json"
        md_path = args.output / "topology_report.md"
        json_path.write_text(json.dumps(report, indent=2))
        md_path.write_text(generate_markdown_summary(report))
        print(f"Written: {json_path}")
        print(f"Written: {md_path}")
    elif args.json:
        print(json.dumps(report, indent=2))
    else:
        # Both JSON and markdown to stdout
        markdown = generate_markdown_summary(report)
        print(markdown)
        print("\n---\n")
        print("JSON report available with --json flag or --output DIR")


if __name__ == "__main__":
    main()
