#!/usr/bin/env python3
"""
content_qa_judge.py — Vision-judge content-QA cell for TSBC pixel gate automation.

Takes a directory of image files (or cut-sequence frames for temporal cases), scores each on:
  (a) readable_text present (yes/no)
  (b) text_gibberish (yes/no)
  (c) wrong_brand_marker (yes/no)
  (d) fake_product_page (yes/no)
  (e) repetition_detected (yes/no) — catches b-roll looping / temporal non-uniqueness over cut sequences (new AC from TSM-5896 v2 validation case; cut-map provides ground truth)

Outputs one JSON object per file (JSONL). A vision-judge that passes the 5896 v2 cut (i.e. fails to flag repetition) FAILS acceptance.

Intended to be called by the operator quota driver per banked batch.
Vision backend: grok-4.5 vision (sub-surface lane; hook the vision_runner
to the active grok vision adapter or equivalent CLI that accepts image_path + prompt).

Validation target: >=90% agreement with operator pixel-QA labels on the
known-bad (DP-4175 _quarantine-product-truth) and known-good (TSC-7174 root +
TSR-4700-social-assets) sets. Extended validation includes TSM-5896 v2 cut sequences for repetition.

Usage:
  python3 content_qa_judge.py /path/to/images > scores.jsonl

The vision_runner must return a dict matching the JSON schema below.
For initial validation, run manually with vision_analyze tool or equivalent.
"""

import json
import sys
from pathlib import Path
from typing import Callable, Dict, Any

def default_vision_runner(prompt: str, image_path: Path) -> Dict[str, Any]:
    """
    Production hook to grok-4.5 vision via sub-surface adapter or CLI.
    Expects a CLI 'grok-vision' or equivalent that accepts --image and --prompt
    and returns the exact minified JSON dict on stdout.
    The agent runtime wires the active grok vision adapter here when invoked
    through the quota driver or benchmark harness.
    """
    import subprocess
    import json
    try:
        # Production path: call the grok vision CLI/adapter
        cmd = [
            "grok-vision",
            "--image", str(image_path),
            "--prompt", prompt,
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode == 0:
            return json.loads(result.stdout.strip())
        else:
            raise RuntimeError(f"vision CLI failed: {result.stderr}")
    except FileNotFoundError:
        # Fallback for agent runtime: the harness injects the wired runner
        raise NotImplementedError(
            "grok-vision CLI not found in PATH. "
            "Wire via sub-surface grok-4.5 vision adapter in the agent context "
            "or install the CLI for standalone runs. "
            "See AGENTS.md for harness integration."
        )

def judge_directory(
    dir_path: Path,
    vision_runner: Callable[[str, Path], Dict[str, Any]] = default_vision_runner,
    exts=(".jpg", ".jpeg", ".png", ".webp"),
) -> None:
    """Walk dir, judge each image, emit JSONL to stdout."""
    prompt_template = (
        "You are a strict pixel-level content QA judge for product and social imagery, including cut-sequence frames for temporal QA. "
        "Return ONLY valid minified JSON with exactly these keys (no extra text, no markdown):\n"
        '{"readable_text":"yes|no","text_gibberish":"yes|no",'
        '"wrong_brand_marker":"yes|no","fake_product_page":"yes|no",'
        '"repetition_detected":"yes|no","temporal_uniqueness":"high|low|na",'
        '"notes":"one-sentence pixel-based assessment including any repetition or looping evidence"}'
    )

    images = sorted(p for p in dir_path.iterdir() if p.is_file() and p.suffix.lower() in exts)
    for img in images:
        try:
            result = vision_runner(prompt_template, img)
            result["file"] = str(img)
            result["sha256"] = None  # caller can fill if needed
            print(json.dumps(result, separators=(",", ":")))
        except Exception as e:
            err = {
                "file": str(img),
                "error": str(e),
                "readable_text": "error",
                "text_gibberish": "error",
                "wrong_brand_marker": "error",
                "fake_product_page": "error",
                "repetition_detected": "error",
                "temporal_uniqueness": "error",
                "notes": "vision call failed",
            }
            print(json.dumps(err, separators=(",", ":")))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 content_qa_judge.py <directory>", file=sys.stderr)
        sys.exit(1)
    d = Path(sys.argv[1]).expanduser().resolve()
    if not d.is_dir():
        print(f"ERROR: {d} is not a directory", file=sys.stderr)
        sys.exit(1)
    judge_directory(d)
