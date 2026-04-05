#!/usr/bin/env python3
from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path


STAMP = "2026-04-05-legacy-permalink-cleanup"
PATTERN = re.compile(r"https://fluxaivory\.com/(?!posts/)([^\s\"'<>]+)")


@dataclass(frozen=True)
class ArchivePlan:
    source_root: Path
    archive_root: Path


PLANS = [
    ArchivePlan(
        source_root=Path("/Users/daehan/.paperclip/instances/default/data/blog-runs"),
        archive_root=Path("/Users/daehan/.paperclip/instances/default/data/blog-runs-archive") / STAMP,
    ),
    ArchivePlan(
        source_root=Path("/Users/daehan/ec2-migration/home-ubuntu/board-app/runtime/daily-task-evidence"),
        archive_root=Path("/Users/daehan/ec2-migration/home-ubuntu/board-app/runtime/daily-task-evidence-archive") / STAMP,
    ),
]


def matches_legacy_permalink(file_path: Path) -> bool:
    try:
      text = file_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
      return False
    return bool(PATTERN.search(text))


def archive_matching_files(plan: ArchivePlan) -> dict:
    moved = []
    if not plan.source_root.exists():
        return {"source_root": str(plan.source_root), "moved_count": 0, "moved": moved}

    for file_path in plan.source_root.rglob("*"):
        if not file_path.is_file():
            continue
        if not matches_legacy_permalink(file_path):
            continue
        relative = file_path.relative_to(plan.source_root)
        destination = plan.archive_root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(file_path), str(destination))
        moved.append(
            {
                "from": str(file_path),
                "to": str(destination),
            }
        )

    return {
        "source_root": str(plan.source_root),
        "archive_root": str(plan.archive_root),
        "moved_count": len(moved),
        "moved": moved,
    }


def main() -> None:
    results = [archive_matching_files(plan) for plan in PLANS]
    total = sum(item["moved_count"] for item in results)
    print(
        {
            "ok": True,
            "archive_stamp": STAMP,
            "total_moved": total,
            "results": results,
        }
    )


if __name__ == "__main__":
    main()
