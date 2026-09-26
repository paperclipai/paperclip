#!/usr/bin/env python3
"""
Nano Image Generator - Generate images using Google's Gemini 3 Pro Preview API.

Requires: GEMINI_API_KEY environment variable

Usage:
    python generate_image.py "A cute robot mascot" --output ./mascot.png
    python generate_image.py "Banner for app launch" --aspect 16:9 --output ./banner.png
    python generate_image.py "High-res logo" --size 4K --output ./logo.png
"""

import argparse
import base64
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path


# Gemini 3 Pro Preview - the "Nano Banana Pro" model
MODEL_ID = "gemini-3-pro-image-preview"

ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
IMAGE_SIZES = ["1K", "2K", "4K"]

API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


def get_api_key():
    """Get API key from environment."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        print("Error: GEMINI_API_KEY environment variable not set", file=sys.stderr)
        print("Get your API key at: https://aistudio.google.com/apikey", file=sys.stderr)
        sys.exit(1)
    return key


def detect_image_format(image_bytes: bytes) -> tuple[str, str]:
    """
    Detect actual image format from magic bytes.
    Returns: (mime_type, extension)

    Gemini API sometimes reports incorrect mime types, so we verify
    the actual format from the image data itself.
    """
    if image_bytes[:8] == b'\x89PNG\r\n\x1a\n':
        return "image/png", ".png"
    elif image_bytes[:2] == b'\xff\xd8':
        return "image/jpeg", ".jpg"
    elif image_bytes[:4] == b'RIFF' and image_bytes[8:12] == b'WEBP':
        return "image/webp", ".webp"
    elif image_bytes[:6] in (b'GIF87a', b'GIF89a'):
        return "image/gif", ".gif"
    else:
        # Default to PNG if unknown
        return "image/png", ".png"


def generate_image(
    prompt: str,
    aspect_ratio: str = "1:1",
    image_size: str = "2K",
) -> tuple[bytes, str]:
    """
    Generate an image using Gemini 3 Pro Preview API.

    Returns: (image_bytes, mime_type)
    """
    api_key = get_api_key()

    url = f"{API_BASE}/{MODEL_ID}:generateContent?key={api_key}"

    # Build request payload per Gemini 3 Pro Preview spec
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {
                "aspectRatio": aspect_ratio,
                "imageSize": image_size,
            },
        },
    }

    # Make request
    headers = {"Content-Type": "application/json"}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8")
        print(f"API Error ({e.code}): {error_body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Network Error: {e.reason}", file=sys.stderr)
        sys.exit(1)

    # Extract image from response
    candidates = result.get("candidates", [])
    if not candidates:
        print("Error: No candidates in response", file=sys.stderr)
        print(f"Response: {json.dumps(result, indent=2)}", file=sys.stderr)
        sys.exit(1)

    parts = candidates[0].get("content", {}).get("parts", [])

    for part in parts:
        if "inlineData" in part:
            inline_data = part["inlineData"]
            image_bytes = base64.b64decode(inline_data["data"])
            # Detect actual format from magic bytes (API mime_type can be wrong)
            actual_mime, _ = detect_image_format(image_bytes)
            reported_mime = inline_data.get("mimeType", "image/png")
            if actual_mime != reported_mime:
                print(f"Note: API reported {reported_mime}, actual format is {actual_mime}", file=sys.stderr)
            return image_bytes, actual_mime

    # No image found - check for text response
    for part in parts:
        if "text" in part:
            print(f"Model response (no image): {part['text']}", file=sys.stderr)

    print("Error: No image data in response", file=sys.stderr)
    sys.exit(1)


def get_extension(mime_type: str) -> str:
    """Get file extension from MIME type."""
    extensions = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }
    return extensions.get(mime_type, ".png")


def main():
    parser = argparse.ArgumentParser(
        description="Generate images using Gemini 3 Pro Preview (Nano Banana Pro)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s "A friendly robot mascot" --output ./robot.png
  %(prog)s "Website banner" --aspect 16:9 --output ./banner.png
  %(prog)s "Detailed landscape" --size 4K --output ./landscape.png
        """,
    )
    parser.add_argument("prompt", help="Image description/prompt")
    parser.add_argument(
        "--output", "-o",
        required=True,
        help="Output file path (extension auto-added if missing)",
    )
    parser.add_argument(
        "--aspect", "-a",
        choices=ASPECT_RATIOS,
        default="1:1",
        help="Aspect ratio. Default: 1:1",
    )
    parser.add_argument(
        "--size", "-s",
        choices=IMAGE_SIZES,
        default="2K",
        help="Image resolution: 1K, 2K, or 4K. Default: 2K",
    )

    args = parser.parse_args()

    print(f"Generating image with Gemini 3 Pro Preview...", file=sys.stderr)
    print(f"Prompt: {args.prompt}", file=sys.stderr)
    print(f"Aspect: {args.aspect}, Size: {args.size}", file=sys.stderr)

    image_bytes, mime_type = generate_image(
        prompt=args.prompt,
        aspect_ratio=args.aspect,
        image_size=args.size,
    )

    # Determine output path - always use correct extension for actual format
    output_path = Path(args.output)
    correct_ext = get_extension(mime_type)

    # Replace any user-specified extension with the correct one
    output_path = output_path.with_suffix(correct_ext)

    if args.output != str(output_path):
        print(f"Note: Using {correct_ext} extension (actual format: {mime_type})", file=sys.stderr)

    # Create parent directories if needed
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Write image
    output_path.write_bytes(image_bytes)

    print(f"Image saved: {output_path}", file=sys.stderr)
    # Print path to stdout for easy capture
    print(output_path)


if __name__ == "__main__":
    main()
