---
name: youtube-research
description: Use when you need to gather information from a YouTube video URL — metadata (title, description, channel, tags), subtitles, and transcription. Covers manual captions, auto-generated captions, and Whisper-based transcription fallback when no captions exist.
---

# YouTube Research

Extract metadata, subtitles, and transcription from any YouTube video URL using `yt-dlp` with a Whisper fallback.

## Prerequisites

```bash
pip install yt-dlp          # metadata + subtitles
pip install openai-whisper  # only needed for transcription fallback
```

## Quick Reference

| Goal | Command |
|------|---------|
| All metadata (JSON) | `yt-dlp --dump-json "<url>"` |
| Check available subtitles | `yt-dlp --list-subs "<url>"` |
| Download manual subtitles | `yt-dlp --write-subs --skip-download "<url>"` |
| Download auto-generated subs | `yt-dlp --write-auto-subs --skip-download "<url>"` |
| Download all English subs | `yt-dlp --write-subs --write-auto-subs --sub-langs "en.*" --skip-download "<url>"` |
| Extract audio for Whisper | `yt-dlp -x --audio-format mp3 -o "audio.%(ext)s" "<url>"` |

## Workflow

### Step 1 — Extract Metadata

```bash
yt-dlp --dump-json "<youtube-url>" > video_meta.json
```

Key fields in the JSON output:
- `title` — video title
- `description` — full description text
- `channel` / `uploader` — channel name
- `upload_date` — YYYYMMDD format
- `duration` — seconds
- `view_count`, `like_count` — engagement metrics
- `tags` — list of tags
- `subtitles` — available manual subtitle languages (e.g. `{"en": [...]}`)
- `automatic_captions` — available auto-generated subtitle languages

### Step 2 — Get Transcription

**Decision tree: which source to use**

```
Has manual subtitles (subtitles.en)?
  → Use them — most accurate, often human-verified
  No → Has auto-generated captions (automatic_captions.en)?
    → Use them — fast, decent accuracy for clear speech
    No → Use Whisper fallback (model=medium for most cases)
```

#### Option A: Subtitles (preferred)

```bash
# Check what's available first
yt-dlp --list-subs "<youtube-url>"

# Download subtitles — manual preferred, auto-generated as fallback
yt-dlp \
  --write-subs \
  --write-auto-subs \
  --sub-langs "en.*" \
  --skip-download \
  -o "%(title)s.%(ext)s" \
  "<youtube-url>"
```

Subtitle files are saved as `.vtt` or `.srt`. Strip VTT timing metadata to get clean text:

```bash
grep -v "^[0-9]" subtitles.vtt \
  | grep -v "^WEBVTT" \
  | grep -v "^$" \
  | sed 's/<[^>]*>//g'
```

#### Option B: Whisper (fallback — no subtitles available)

```bash
# Step 1: Download audio
yt-dlp -x --audio-format mp3 -o "audio.%(ext)s" "<youtube-url>"

# Step 2: Transcribe
whisper audio.mp3 --model medium --output_format txt --output_dir ./transcripts
```

Whisper model sizes (speed vs. accuracy tradeoff):
- `tiny` / `base` — fastest, lower accuracy
- `medium` — good balance (recommended default)
- `large` — most accurate, slowest; use for high-stakes analysis

### Step 3 — Combined One-Shot

Fetch metadata + all English subtitles in a single call:

```bash
yt-dlp \
  --write-subs \
  --write-auto-subs \
  --sub-langs "en.*" \
  --skip-download \
  -o "%(title)s.%(ext)s" \
  "<youtube-url>"
```

## Python Helper (Structured Output)

Use this to programmatically fetch metadata and determine the best transcript source:

```python
import subprocess
import json

def get_youtube_data(url: str) -> dict:
    """Fetch metadata and check subtitle availability for a YouTube URL."""
    result = subprocess.run(
        ["yt-dlp", "--dump-json", url],
        capture_output=True, text=True, check=True
    )
    meta = json.loads(result.stdout)

    has_manual_subs = bool(meta.get("subtitles", {}).get("en"))
    has_auto_subs = bool(meta.get("automatic_captions", {}).get("en"))

    return {
        "title": meta["title"],
        "description": meta.get("description", ""),
        "channel": meta.get("channel") or meta.get("uploader"),
        "upload_date": meta.get("upload_date"),
        "duration_sec": meta.get("duration"),
        "tags": meta.get("tags", []),
        "url": url,
        "transcript_source": (
            "manual_subs" if has_manual_subs
            else "auto_subs" if has_auto_subs
            else "whisper_needed"
        ),
    }


def get_transcript(url: str, output_dir: str = ".") -> str:
    """Download subtitles or generate Whisper transcript. Returns source used."""
    info = get_youtube_data(url)
    source = info["transcript_source"]

    if source in ("manual_subs", "auto_subs"):
        flags = ["--write-subs", "--write-auto-subs", "--sub-langs", "en.*",
                 "--skip-download", "-o", f"{output_dir}/%(title)s.%(ext)s"]
        subprocess.run(["yt-dlp"] + flags + [url], check=True)
        return source  # caller reads the .vtt/.srt file from output_dir

    # Whisper fallback
    subprocess.run(
        ["yt-dlp", "-x", "--audio-format", "mp3",
         "-o", f"{output_dir}/audio.%(ext)s", url],
        check=True
    )
    subprocess.run(
        ["whisper", f"{output_dir}/audio.mp3",
         "--model", "medium", "--output_format", "txt",
         "--output_dir", output_dir],
        check=True
    )
    return "whisper"
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| VTT file contains timing noise | Strip with `grep`/`sed` before analysis (see Option A above) |
| Whisper runs on wrong language | Add `--language en` flag to `whisper` command |
| Subtitles in wrong language | Run `--list-subs` first; use `--sub-langs "en"` explicitly |
| `--dump-json` output mixed with file writes | Redirect JSON with `> meta.json` |
| Audio file too large for Whisper | Add `--audio-quality 5` to `yt-dlp` to reduce bitrate |
| `yt-dlp` returns outdated results | Run `pip install -U yt-dlp` — YouTube changes frequently break older versions |
