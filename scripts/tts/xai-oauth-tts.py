#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
from pathlib import Path


def load_xai_oauth_access_token() -> str:
    auth_path = Path.home() / ".hermes" / "auth.json"
    if not auth_path.is_file():
        raise SystemExit(f"Missing Hermes OAuth cache: {auth_path}")
    data = json.loads(auth_path.read_text())
    token = (
        data.get("providers", {})
        .get("xai-oauth", {})
        .get("tokens", {})
        .get("access_token")
    )
    if not token or not isinstance(token, str):
        raise SystemExit(f"No xAI OAuth access token found in {auth_path}")
    return token


def ffprobe_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "/opt/homebrew/bin/ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nk=1:nw=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render Grok TTS audio from the local Hermes xAI OAuth session.",
    )
    text_group = parser.add_mutually_exclusive_group(required=True)
    text_group.add_argument("--text", help="Inline text to synthesize.")
    text_group.add_argument("--text-file", type=Path, help="UTF-8 text file to synthesize.")
    parser.add_argument("--voice", default="lumen", help="xAI voice id (default: lumen).")
    parser.add_argument("--language", default="en", help="Language code (default: en).")
    parser.add_argument("--out", type=Path, required=True, help="Output audio file path.")
    parser.add_argument("--request-json", type=Path, help="Optional preserved request payload path.")
    parser.add_argument("--response-json", type=Path, help="Optional preserved raw response path.")
    parser.add_argument("--headers-path", type=Path, help="Optional preserved response headers path.")
    parser.add_argument(
        "--provenance-json",
        type=Path,
        help="Optional summary JSON containing request + output metadata.",
    )
    parser.add_argument(
        "--with-timestamps",
        action="store_true",
        help="Request audio_timestamps in the provider response.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    script_text = args.text if args.text is not None else args.text_file.read_text(encoding="utf-8")
    args.out.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "text": script_text,
        "voice_id": args.voice,
        "language": args.language,
        "text_normalization": True,
        "with_timestamps": bool(args.with_timestamps),
    }
    if args.request_json:
        args.request_json.parent.mkdir(parents=True, exist_ok=True)
        args.request_json.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    response_path = args.response_json or (args.out.parent / f"{args.out.stem}.response.json")
    headers_path = args.headers_path or (args.out.parent / f"{args.out.stem}.headers.txt")
    response_path.parent.mkdir(parents=True, exist_ok=True)
    headers_path.parent.mkdir(parents=True, exist_ok=True)

    token = load_xai_oauth_access_token()
    command = [
        "curl",
        "-sS",
        "https://api.x.ai/v1/tts",
        "-H",
        f"Authorization: Bearer {token}",
        "-H",
        "Content-Type: application/json",
        "-D",
        str(headers_path),
        "-o",
        str(response_path),
        "-w",
        "%{http_code}",
        "-d",
        json.dumps(payload),
    ]
    result = subprocess.run(command, check=True, capture_output=True, text=True)
    try:
        http_status = int(result.stdout.strip())
    except ValueError as exc:
        raise SystemExit(f"Unexpected HTTP status output: {result.stdout!r}") from exc

    raw = response_path.read_bytes()

    # The endpoint returns the audio bytes DIRECTLY (content-type: audio/mpeg).
    # It used to return JSON carrying base64 in an "audio" field, and this path
    # assumed that forever after. The failure was silent and total:
    # `raw.decode("utf-8")` on a binary body raises UnicodeDecodeError, which is
    # a SIBLING of JSONDecodeError under ValueError -- not a subclass -- so the
    # `except json.JSONDecodeError` below never caught it, and every TTS call on
    # the platform died uncaught (found on TSM-6997, 2026-08-25). Detect the
    # response shape instead of assuming it; keep the JSON path for error bodies.
    header_blob = ""
    try:
        header_blob = headers_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        pass
    header_says_audio = "content-type: audio/" in header_blob.lower()
    # ID3 tag, or an MPEG frame sync (11 set bits).
    magic_says_audio = raw[:3] == b"ID3" or (
        len(raw) > 1 and raw[0] == 0xFF and (raw[1] & 0xE0) == 0xE0
    )

    if http_status == 200 and (header_says_audio or magic_says_audio):
        data = {}
        content_type = "audio/mpeg"
        args.out.write_bytes(raw)
    else:
        try:
            # ValueError, not json.JSONDecodeError: this also catches UnicodeDecodeError.
            data = json.loads(raw.decode("utf-8"))
        except ValueError as exc:
            raise SystemExit(
                f"xAI TTS returned an unparseable body with status {http_status}: {exc}"
            ) from exc

        if http_status != 200 or "audio" not in data:
            raise SystemExit(
                json.dumps(
                    {
                        "http_status": http_status,
                        "error": data.get("error", data),
                        "response_json": str(response_path),
                        "headers_path": str(headers_path),
                    },
                    indent=2,
                ),
            )

        content_type = data.get("content_type", "audio/mpeg")
        if content_type != "audio/mpeg":
            raise SystemExit(f"Unexpected content_type {content_type!r}; expected 'audio/mpeg'")
        args.out.write_bytes(base64.b64decode(data["audio"]))

    duration_seconds = float(data.get("duration") or 0.0)
    if duration_seconds <= 0:
        duration_seconds = ffprobe_duration(args.out)

    if args.provenance_json:
        args.provenance_json.parent.mkdir(parents=True, exist_ok=True)
        args.provenance_json.write_text(
            json.dumps(
                {
                    "engine": "xai-oauth-subscription",
                    "voice_id": args.voice,
                    "language": args.language,
                    "http_status": http_status,
                    "content_type": content_type,
                    "duration_seconds": duration_seconds,
                    "out_path": str(args.out),
                    "request_json": str(args.request_json) if args.request_json else None,
                    "response_json": str(response_path),
                    "headers_path": str(headers_path),
                    "with_timestamps": bool(args.with_timestamps),
                    "text_char_count": len(script_text),
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    print(
        json.dumps(
            {
                "ok": True,
                "out_path": str(args.out),
                "duration_seconds": duration_seconds,
                "response_json": str(response_path),
                "headers_path": str(headers_path),
            },
        ),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
