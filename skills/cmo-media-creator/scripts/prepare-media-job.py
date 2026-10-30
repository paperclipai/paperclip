#!/usr/bin/env python3
"""Validate a CMO media brief and print a Skillboss command."""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from pathlib import Path


FORBIDDEN_TERMS = [
    "Skillboss",
    "OpenAI",
    "Claude",
    "Anthropic",
    "OpenRouter",
    "Gemini",
    "Veo",
    "Synthflow",
    "ElevenLabs",
    "GoHighLevel",
    "Zapier",
    "Docker",
    "Tailscale",
    "Mac Mini",
]

DEFAULT_MODELS = {
    "image": "vertex/gemini-3-pro-image-preview",
    "video": "vertex/veo-3.1-fast-generate-preview",
    "image-to-video": "mm/i2v",
}


def load_brief(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def die(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def validate(brief: dict) -> None:
    mode = brief.get("asset_type")
    if mode not in DEFAULT_MODELS:
        die("asset_type must be one of: image, video, image-to-video")

    prompt = str(brief.get("prompt", "")).strip()
    if len(prompt) < 40:
        die("prompt must be at least 40 characters")

    output = str(brief.get("output", "")).strip()
    if not output:
        die("output is required")

    if mode == "image-to-video" and not str(brief.get("image", "")).strip():
        die("image-to-video requires an image URL or path in the image field")

    public_text = " ".join(
        str(brief.get(key, ""))
        for key in ["prompt", "caption", "public_copy", "onscreen_text"]
    )
    hits = [term for term in FORBIDDEN_TERMS if term.lower() in public_text.lower()]
    if hits:
        die("public-facing brief contains forbidden vendor term(s): " + ", ".join(hits))


def build_command(brief: dict, cli: str) -> list[str]:
    mode = brief["asset_type"]
    model = brief.get("model") or DEFAULT_MODELS[mode]
    cmd = ["node", cli, "video" if mode in {"video", "image-to-video"} else "image"]
    cmd.extend(["--model", model, "--prompt", brief["prompt"], "--output", brief["output"]])
    if mode == "image-to-video":
        cmd.extend(["--image", brief["image"]])
    if brief.get("size") and mode == "image":
        cmd.extend(["--size", str(brief["size"])])
    if brief.get("duration") and mode in {"video", "image-to-video"}:
        cmd.extend(["--duration", str(brief["duration"])])
    return cmd


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("brief", type=Path, help="Path to media brief JSON")
    parser.add_argument(
        "--cli",
        default=str(Path.home() / ".claude/skills/skillboss/scripts/api-hub.js"),
        help="Path to Skillboss api-hub.js",
    )
    parser.add_argument("--json", action="store_true", help="Print JSON instead of shell")
    args = parser.parse_args()

    brief = load_brief(args.brief)
    validate(brief)
    cmd = build_command(brief, args.cli)

    if args.json:
        print(json.dumps({"command": cmd, "model": cmd[cmd.index("--model") + 1]}, indent=2))
    else:
        print(" ".join(shlex.quote(part) for part in cmd))


if __name__ == "__main__":
    main()
