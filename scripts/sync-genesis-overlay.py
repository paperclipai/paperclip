#!/usr/bin/env python3
"""
scripts/sync-genesis-overlay.py

Regenerate the per-agent inlined copy of the canonical Genesis guardrail in
each agent's AGENTS.md. The canonical source lives at
`instances/default/companies/<company-id>/shared/GENESIS-WEBSITE-GUARDRAILS.md`.

When to run:
  - You edit the canonical GENESIS-WEBSITE-GUARDRAILS.md.
  - You add or remove an agent under the Genesis company.
  - You want to verify the inlined copies are in sync with the canonical.

Modes:
  (default)   dry-run: print what would change, never modify a file.
  --apply     actually write the new content.
  --check     exit 1 if any AGENTS.md is out of sync (use as a CI gate).

The marker block is the only thing this script touches:
  <!-- BEGIN CANONICAL GENESIS GUARDRAILS (...) -->
  <canonical content>
  <!-- END CANONICAL GENESIS GUARDRAILS -->

Everything else in each AGENTS.md is preserved verbatim.
"""

from __future__ import annotations

import argparse
import difflib
import pathlib
import re
import sys
from typing import Iterable

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
COMPANY_ID = "4b7fd6fc-b920-430e-a3bd-defc09fc4326"
CANONICAL_PATH = REPO_ROOT / "instances" / "default" / "companies" / COMPANY_ID / "shared" / "GENESIS-WEBSITE-GUARDRAILS.md"
COMPANY_DIR = REPO_ROOT / "instances" / "default" / "companies" / COMPANY_ID

MARKER_BEGIN_RE = re.compile(r"^<!-- BEGIN CANONICAL GENESIS GUARDRAILS[^\n]*-->\s*$", re.MULTILINE)
MARKER_END_RE = re.compile(r"^<!-- END CANONICAL GENESIS GUARDRAILS -->\s*$", re.MULTILINE)

PREAMBLE = (
    "The rules below are loaded into your prompt as part of this agent entry file.\n"
    "They are the canonical source of truth for any task touching genesismotiondesign.com.\n"
    "If a rule below conflicts with anything else in this file, the canonical rules win.\n"
    "To change a rule, edit ../shared/GENESIS-WEBSITE-GUARDRAILS.md — DO NOT edit the inlined copy."
)

DANGEROUS_CANONICAL_PATTERNS = {
    r"GENESIS_SAFETY_BYPASS\s*=\s*1": "executable safety-bypass assignment",
    r"putenv\([^\n]*GENESIS_SAFETY_BYPASS": "PHP safety-bypass recipe",
    r"remove_all_filters\(\s*[\"']wp_insert_post_data": "content-safety filter removal",
    r"(?im)^\s*\d+\.\s+Drop L2 trigger": "instruction to drop the database guard",
    r"(?im)^\s*\d+\.\s+Rename L1 mu-plugins": "instruction to disable the application guard",
    r"cloudflare-genesis\.json": "retired persisted Cloudflare credential-file recipe",
    r"(?im)^\s*(?:OR\s+)?post_content\s+LIKE\s+[\"']%rn %": "false-positive-prone rn-space detector",
}


def validate_canonical_semantics(body: str) -> list[str]:
    """Reject known fail-open recipes before propagating them to every agent."""
    errors = []
    for pattern, description in DANGEROUS_CANONICAL_PATTERNS.items():
        if re.search(pattern, body):
            errors.append(description)
    required = (
        "## 0.1 Implementation-lane gate (Hailey-first)",
        "never drop, disable, rename or bypass a Wall layer",
        "GENESIS_PROTECTED posts (no bypass permitted)",
        "wpseo_sitemap_urlimages",
        "A sitemap-only crawl is not a full archive audit.",
        "genesis-converted-gif-background-video-js",
        "genesis-converted-gif-background-video-css",
        "update only `wp_posts.post_excerpt`",
        "CLOUDFLARE_ZONE_ID",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "Yoast may strip an unknown cache-buster",
        "header/logo boxes",
        "fail-safe dark boot shield",
        "generation tokens and cancelled timers",
        "visible follower is 24 px",
        "Scope Jarallax overrides",
        "visible “GEO section” is not required",
        "Never strip the letter `t` globally",
        "Compare deployed mu-plugin SHA-256 values",
        "scripts/sync-genesis-overlay.py --apply",
    )
    for text in required:
        if text not in body:
            errors.append(f"missing required fail-closed clause: {text}")
    return errors


def build_canonical_block() -> str:
    """Build the full marker block (BEGIN + preamble + canonical body + END).

    Strips the leading '# <title>' from the canonical because the marker block
    is already labelled, and the canonical H1 inside the inlined copy is noise.
    """
    body = CANONICAL_PATH.read_text(encoding="utf-8")
    lines = body.splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
        # also drop the first blank line if present
        if lines and not lines[0].strip():
            lines = lines[1:]
    body_clean = "\n".join(lines)

    # Find the actual markers from the canonical so we use the same phrasing.
    begin_match = MARKER_BEGIN_RE.search(body_clean)
    end_match = MARKER_END_RE.search(body_clean)
    if begin_match and end_match and end_match.start() > begin_match.end():
        body_clean = body_clean[begin_match.end():end_match.start()].strip("\n")

    begin = "<!-- BEGIN CANONICAL GENESIS GUARDRAILS (auto-prepended into this entry file by Hermes; canonical lives at ../shared/GENESIS-WEBSITE-GUARDRAILS.md) -->"
    end = "<!-- END CANONICAL GENESIS GUARDRAILS -->"
    return f"{begin}\n{PREAMBLE}\n\n{body_clean}\n\n{end}\n"


def find_agent_markdown_files() -> Iterable[pathlib.Path]:
    """All agent AGENTS.md files under the Genesis company.

    Read-only built-in agents (Summarizer `92587782`, ReflectionCoach `d4e904f7`)
    do not ship content and are intentionally excluded — they don't need the
    Genesis guardrail. Update this skip-list if other read-only roles are added.
    """
    SKIP_AGENTS = {
        "92587782-c433-439d-aa79-bc87cc6d00ba",  # Summarizer
        "d4e904f7-b371-4887-a045-c84b71751624",  # Reflection Coach
    }
    for path in sorted((COMPANY_DIR / "agents").glob("*/instructions/AGENTS.md")):
        agent_id = path.parent.parent.name
        if agent_id in SKIP_AGENTS:
            continue
        yield path


def current_block(text: str) -> str | None:
    """Return the current marker block (inclusive of markers), or None if missing."""
    m_begin = MARKER_BEGIN_RE.search(text)
    if not m_begin:
        return None
    m_end = MARKER_END_RE.search(text, m_begin.end())
    if not m_end:
        return None
    return text[m_begin.start():m_end.end()]


def apply_block(text: str, new_block: str) -> str:
    """Replace the current marker block with new_block. Preserve everything else."""
    m_begin = MARKER_BEGIN_RE.search(text)
    if not m_begin:
        raise ValueError("apply_block called without a BEGIN marker present")
    m_end = MARKER_END_RE.search(text, m_begin.end())
    if not m_end:
        raise ValueError("apply_block called without an END marker after BEGIN")
    return text[:m_begin.start()] + new_block + text[m_end.end():]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Sync the Genesis overlay (canonical guardrail -> per-agent AGENTS.md).")
    parser.add_argument("--apply", action="store_true", help="Actually write changes. Default is dry-run.")
    parser.add_argument("--check", action="store_true", help="Exit 1 if any agent is out of sync.")
    parser.add_argument("--quiet", action="store_true", help="Suppress diff output (only show summary).")
    args = parser.parse_args(argv)

    if not CANONICAL_PATH.exists():
        print(f"ERROR: canonical file not found at {CANONICAL_PATH}", file=sys.stderr)
        return 2

    canonical_body = CANONICAL_PATH.read_text(encoding="utf-8")
    semantic_errors = validate_canonical_semantics(canonical_body)
    if semantic_errors:
        for error in semantic_errors:
            print(f"ERROR: unsafe canonical semantics: {error}", file=sys.stderr)
        return 2

    new_block = build_canonical_block()

    agent_files = list(find_agent_markdown_files())
    if not agent_files:
        print(f"ERROR: no agent AGENTS.md found under {COMPANY_DIR / 'agents'}", file=sys.stderr)
        return 2

    changed = unchanged = missing = unsafe = 0
    for path in agent_files:
        text = path.read_text(encoding="utf-8")
        existing = current_block(text)
        if existing is None:
            print(f"MISSING marker: {path.relative_to(REPO_ROOT)}")
            missing += 1
            continue
        in_sync = existing.strip() == new_block.strip()
        prospective_text = text if in_sync else apply_block(text, new_block)
        entry_errors = validate_canonical_semantics(prospective_text)
        if entry_errors:
            rel = path.relative_to(REPO_ROOT)
            for error in entry_errors:
                print(f"ERROR: unsafe full agent entry {rel}: {error}", file=sys.stderr)
            unsafe += 1
            continue
        if in_sync:
            unchanged += 1
            continue
        changed += 1
        rel = path.relative_to(REPO_ROOT)
        if args.check:
            print(f"OUT-OF-DATE: {rel}")
        elif args.apply:
            path.write_text(prospective_text, encoding="utf-8")
            print(f"UPDATED: {rel}")
        else:
            print(f"OUT-OF-DATE: {rel}")
            if not args.quiet:
                diff = difflib.unified_diff(
                    existing.splitlines(keepends=True),
                    new_block.splitlines(keepends=True),
                    fromfile="current",
                    tofile="canonical",
                    n=2,
                )
                for line in diff:
                    print(f"  {line}", end="")

    print(f"\nSummary: changed={changed} unchanged={unchanged} missing-marker={missing} unsafe-entry={unsafe}")

    if unsafe:
        print("SYNC BLOCKED — remove fail-open recipes from the complete AGENTS.md entry files.", file=sys.stderr)
        return 2

    if args.check and (changed or missing):
        print("CHECK FAILED — run scripts/sync-genesis-overlay.py --apply to bring in sync.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
