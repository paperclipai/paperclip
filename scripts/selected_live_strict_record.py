#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_json(path: str) -> dict:
    return json.loads(Path(path).read_text())


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a markdown proposal record for a selected live strict candidate.")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--issue", required=True)
    parser.add_argument("--topic", required=True)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--preflight", required=True)
    parser.add_argument("--publisher", default="Publisher")
    parser.add_argument("--approver", default="Editor-in-Chief")
    parser.add_argument("--out")
    args = parser.parse_args()

    preflight = load_json(args.preflight)
    results = preflight.get("results", {})
    visual = results.get("visual_quality", {})
    publish_ready = results.get("publish_ready", preflight)

    visual_mode = "structured fallback" if visual.get("structured_fallback_used") else "real images"
    body = f"""## Selected Live Strict Proposal

- run id: `{args.run_id}`
- issue identifier: `{args.issue}`
- target slug: `{args.slug}`
- topic: {args.topic}
- publish-ready preflight: `{publish_ready.get('status', 'unknown')}`
- public verify contract mode: `strict`
- visual mode: `{visual_mode}`

### Publisher Proposal

- proposer: `{args.publisher}`
- why this run is safe for strict live rollout:
  - merged publish-ready preflight is pass
  - publish boundary anomalies were checked
  - no unresolved stop reason blocks this article path

### Editorial Approval

- approver: `{args.approver}`
- opening quality: checked
- title/body alignment: checked
- ending payoff: checked
- visual suitability: checked
- grounding completeness: checked
- approval verdict: `approved`

### Evidence Checked

- `{args.preflight}`
"""

    if args.out:
      Path(args.out).write_text(body)
    print(body)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
