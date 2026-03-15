"""YouTube search and transcript extraction via yt-dlp for /last30days v2.1.

Uses yt-dlp (https://github.com/yt-dlp/yt-dlp) for both YouTube search and
transcript extraction. No API keys needed — just have yt-dlp installed.

Inspired by Peter Steinberger's toolchain approach (yt-dlp + summarize CLI).
"""

import json
import math
import os
import re
import signal
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

# Depth configurations: how many videos to search / transcribe
DEPTH_CONFIG = {
    "quick": 10,
    "default": 20,
    "deep": 40,
}

TRANSCRIPT_LIMITS = {
    "quick": 3,
    "default": 5,
    "deep": 8,
}

# Max words to keep from each transcript
TRANSCRIPT_MAX_WORDS = 500

# Stopwords for relevance computation (common English words that dilute token overlap)
STOPWORDS = frozenset({
    'the', 'a', 'an', 'to', 'for', 'how', 'is', 'in', 'of', 'on',
    'and', 'with', 'from', 'by', 'at', 'this', 'that', 'it', 'my',
    'your', 'i', 'me', 'we', 'you', 'what', 'are', 'do', 'can',
    'its', 'be', 'or', 'not', 'no', 'so', 'if', 'but', 'about',
    'all', 'just', 'get', 'has', 'have', 'was', 'will',
})


# Synonym groups for relevance scoring (bidirectional expansion)
SYNONYMS = {
    'hip': {'rap', 'hiphop'},
    'hop': {'rap', 'hiphop'},
    'rap': {'hip', 'hop', 'hiphop'},
    'hiphop': {'rap', 'hip', 'hop'},
    'js': {'javascript'},
    'javascript': {'js'},
    'ts': {'typescript'},
    'typescript': {'ts'},
    'ai': {'artificial', 'intelligence'},
    'ml': {'machine', 'learning'},
    'react': {'reactjs'},
    'reactjs': {'react'},
    'svelte': {'sveltejs'},
    'sveltejs': {'svelte'},
    'vue': {'vuejs'},
    'vuejs': {'vue'},
}


def _tokenize(text: str) -> Set[str]:
    """Lowercase, strip punctuation, remove stopwords, drop single-char tokens.
    Expands tokens with synonyms for better cross-domain matching."""
    words = re.sub(r'[^\w\s]', ' ', text.lower()).split()
    tokens = {w for w in words if w not in STOPWORDS and len(w) > 1}
    # Expand synonyms
    expanded = set(tokens)
    for t in tokens:
        if t in SYNONYMS:
            expanded.update(SYNONYMS[t])
    return expanded


def _compute_relevance(query: str, title: str) -> float:
    """Compute relevance as ratio of query tokens found in title.

    Uses ratio overlap (intersection / query_length) so short queries
    score higher when fully represented in the title. Floors at 0.1.
    """
    q_tokens = _tokenize(query)
    t_tokens = _tokenize(title)

    if not q_tokens:
        return 0.5  # Neutral fallback for empty/stopword-only queries

    overlap = len(q_tokens & t_tokens)
    ratio = overlap / len(q_tokens)
    return max(0.1, min(1.0, ratio))


def _log(msg: str):
    """Log to stderr."""
    sys.stderr.write(f"[YouTube] {msg}\n")
    sys.stderr.flush()


def is_ytdlp_installed() -> bool:
    """Check if yt-dlp is available in PATH."""
    return shutil.which("yt-dlp") is not None


def _extract_core_subject(topic: str) -> str:
    """Extract core subject from verbose query for YouTube search.

    Strips meta/research words to keep only the core product/concept name,
    similar to bird_x.py's approach.
    """
    text = topic.lower().strip()

    # Strip multi-word prefixes
    prefixes = [
        'what are the best', 'what is the best', 'what are the latest',
        'what are people saying about', 'what do people think about',
        'how do i use', 'how to use', 'how to',
        'what are', 'what is', 'tips for', 'best practices for',
    ]
    for p in prefixes:
        if text.startswith(p + ' '):
            text = text[len(p):].strip()

    # Strip individual noise words
    # NOTE: 'tips', 'tricks', 'tutorial', 'guide', 'review', 'reviews'
    # are intentionally KEPT — they're YouTube content types that improve search
    noise = {
        'best', 'top', 'good', 'great', 'awesome', 'killer',
        'latest', 'new', 'news', 'update', 'updates',
        'trending', 'hottest', 'popular', 'viral',
        'practices', 'features',
        'recommendations', 'advice',
        'prompt', 'prompts', 'prompting',
        'methods', 'strategies', 'approaches',
    }
    words = text.split()
    filtered = [w for w in words if w not in noise]

    result = ' '.join(filtered) if filtered else text
    return result.rstrip('?!.')


def search_youtube(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
) -> Dict[str, Any]:
    """Search YouTube via yt-dlp. No API key needed.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD)
        depth: 'quick', 'default', or 'deep'

    Returns:
        Dict with 'items' list of video metadata dicts.
    """
    if not is_ytdlp_installed():
        return {"items": [], "error": "yt-dlp not installed"}

    count = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    core_topic = _extract_core_subject(topic)

    _log(f"Searching YouTube for '{core_topic}' (since {from_date}, count={count})")

    # yt-dlp search with full metadata (no --flat-playlist so dates are real).
    # No --dateafter — we filter by date in Python with a soft fallback,
    # because YouTube search returns relevance-sorted results and strict date
    # filtering returns 0 for evergreen topics like "thumbnail tips".
    cmd = [
        "yt-dlp",
        f"ytsearch{count}:{core_topic}",
        "--dump-json",
        "--no-warnings",
        "--no-download",
    ]

    preexec = os.setsid if hasattr(os, 'setsid') else None

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            preexec_fn=preexec,
        )
        try:
            stdout, stderr = proc.communicate(timeout=120)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                proc.kill()
            proc.wait(timeout=5)
            _log("YouTube search timed out (120s)")
            return {"items": [], "error": "Search timed out"}
    except FileNotFoundError:
        return {"items": [], "error": "yt-dlp not found"}

    if not (stdout or "").strip():
        _log("YouTube search returned 0 results")
        return {"items": []}

    # Parse JSON-per-line output
    items = []
    for line in stdout.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            video = json.loads(line)
        except json.JSONDecodeError:
            continue

        video_id = video.get("id", "")
        view_count = video.get("view_count") or 0
        like_count = video.get("like_count") or 0
        comment_count = video.get("comment_count") or 0
        upload_date = video.get("upload_date", "")  # YYYYMMDD

        # Convert YYYYMMDD to YYYY-MM-DD
        date_str = None
        if upload_date and len(upload_date) == 8:
            date_str = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}"

        items.append({
            "video_id": video_id,
            "title": video.get("title", ""),
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "channel_name": video.get("channel", video.get("uploader", "")),
            "date": date_str,
            "engagement": {
                "views": view_count,
                "likes": like_count,
                "comments": comment_count,
            },
            "duration": video.get("duration"),
            "relevance": _compute_relevance(core_topic, video.get("title", "")),
            "why_relevant": f"YouTube: {video.get('title', core_topic)[:60]}",
        })

    # Soft date filter: prefer recent items but fall back to all if too few
    recent = [i for i in items if i["date"] and i["date"] >= from_date]
    if len(recent) >= 3:
        items = recent
        _log(f"Found {len(items)} videos within date range")
    else:
        _log(f"Found {len(items)} videos ({len(recent)} within date range, keeping all)")

    # Sort by views descending
    items.sort(key=lambda x: x["engagement"]["views"], reverse=True)

    return {"items": items}


def _clean_vtt(vtt_text: str) -> str:
    """Convert VTT subtitle format to clean plaintext."""
    # Strip VTT header
    text = re.sub(r'^WEBVTT.*?\n\n', '', vtt_text, flags=re.DOTALL)
    # Strip timestamps
    text = re.sub(r'\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}.*\n', '', text)
    # Strip position/alignment tags
    text = re.sub(r'<[^>]+>', '', text)
    # Strip cue numbers
    text = re.sub(r'^\d+\s*$', '', text, flags=re.MULTILINE)
    # Deduplicate overlapping lines
    lines = text.strip().split('\n')
    seen = set()
    unique = []
    for line in lines:
        stripped = line.strip()
        if stripped and stripped not in seen:
            seen.add(stripped)
            unique.append(stripped)
    return re.sub(r'\s+', ' ', ' '.join(unique)).strip()


def fetch_transcript(video_id: str, temp_dir: str) -> Optional[str]:
    """Fetch auto-generated transcript for a YouTube video.

    Args:
        video_id: YouTube video ID
        temp_dir: Temporary directory for subtitle files

    Returns:
        Plaintext transcript string, or None if no captions available.
    """
    cmd = [
        "yt-dlp",
        "--write-auto-subs",
        "--sub-lang", "en",
        "--sub-format", "vtt",
        "--skip-download",
        "--no-warnings",
        "-o", f"{temp_dir}/%(id)s",
        f"https://www.youtube.com/watch?v={video_id}",
    ]

    preexec = os.setsid if hasattr(os, 'setsid') else None

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            preexec_fn=preexec,
        )
        try:
            proc.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                proc.kill()
            proc.wait(timeout=5)
            return None
    except FileNotFoundError:
        return None

    # yt-dlp may save as .en.vtt or .en-orig.vtt
    vtt_path = Path(temp_dir) / f"{video_id}.en.vtt"
    if not vtt_path.exists():
        # Try alternate naming
        for p in Path(temp_dir).glob(f"{video_id}*.vtt"):
            vtt_path = p
            break
        else:
            return None

    try:
        raw = vtt_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    transcript = _clean_vtt(raw)

    # Truncate to max words
    words = transcript.split()
    if len(words) > TRANSCRIPT_MAX_WORDS:
        transcript = ' '.join(words[:TRANSCRIPT_MAX_WORDS]) + '...'

    return transcript if transcript else None


def fetch_transcripts_parallel(
    video_ids: List[str],
    max_workers: int = 5,
) -> Dict[str, Optional[str]]:
    """Fetch transcripts for multiple videos in parallel.

    Args:
        video_ids: List of YouTube video IDs
        max_workers: Max parallel fetches

    Returns:
        Dict mapping video_id to transcript text (or None).
    """
    if not video_ids:
        return {}

    _log(f"Fetching transcripts for {len(video_ids)} videos")

    results = {}
    with tempfile.TemporaryDirectory() as temp_dir:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(fetch_transcript, vid, temp_dir): vid
                for vid in video_ids
            }
            for future in as_completed(futures):
                vid = futures[future]
                try:
                    results[vid] = future.result()
                except Exception:
                    results[vid] = None

    got = sum(1 for v in results.values() if v)
    _log(f"Got transcripts for {got}/{len(video_ids)} videos")
    return results


def search_and_transcribe(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
) -> Dict[str, Any]:
    """Full YouTube search: find videos, then fetch transcripts for top results.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD)
        depth: 'quick', 'default', or 'deep'

    Returns:
        Dict with 'items' list. Each item has a 'transcript_snippet' field.
    """
    # Step 1: Search
    search_result = search_youtube(topic, from_date, to_date, depth)
    items = search_result.get("items", [])

    if not items:
        return search_result

    # Step 2: Fetch transcripts for top N by views
    transcript_limit = TRANSCRIPT_LIMITS.get(depth, TRANSCRIPT_LIMITS["default"])
    top_ids = [item["video_id"] for item in items[:transcript_limit]]
    transcripts = fetch_transcripts_parallel(top_ids)

    # Step 3: Attach transcripts to items
    for item in items:
        vid = item["video_id"]
        transcript = transcripts.get(vid)
        item["transcript_snippet"] = transcript or ""

    return {"items": items}


def parse_youtube_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse YouTube search response to normalized format.

    Returns:
        List of item dicts ready for normalization.
    """
    return response.get("items", [])
