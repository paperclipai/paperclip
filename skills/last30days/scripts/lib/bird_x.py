"""Bird X search client - vendored Twitter GraphQL search for /last30days v2.1.

Uses a vendored subset of @steipete/bird v0.8.0 (MIT License) to search X
via Twitter's GraphQL API. No external `bird` CLI binary needed - just Node.js 22+.
"""

import json
import os
import signal
import shutil
import subprocess
import sys
from pathlib import Path
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

# Path to the vendored bird-search wrapper
_BIRD_SEARCH_MJS = Path(__file__).parent / "vendor" / "bird-search" / "bird-search.mjs"

# Depth configurations: number of results to request
DEPTH_CONFIG = {
    "quick": 12,
    "default": 30,
    "deep": 60,
}

# Module-level credentials injected from .env config
_credentials: Dict[str, str] = {}


def set_credentials(auth_token: Optional[str], ct0: Optional[str]):
    """Inject AUTH_TOKEN/CT0 from .env config so Node subprocesses can use them."""
    if auth_token:
        _credentials['AUTH_TOKEN'] = auth_token
    if ct0:
        _credentials['CT0'] = ct0


def _subprocess_env() -> Dict[str, str]:
    """Build env dict for Node subprocesses, merging injected credentials."""
    env = os.environ.copy()
    env.update(_credentials)
    return env


def _log(msg: str):
    """Log to stderr."""
    sys.stderr.write(f"[Bird] {msg}\n")
    sys.stderr.flush()


def _extract_core_subject(topic: str) -> str:
    """Extract core subject from verbose query for X search.

    X search is literal keyword AND matching — all words must appear.
    Aggressively strip question/meta/research words to keep only the
    core product/concept name (2-3 words max).
    """
    text = topic.lower().strip()

    # Phase 1: Strip multi-word prefixes (longest first)
    prefixes = [
        'what are the best', 'what is the best', 'what are the latest',
        'what are people saying about', 'what do people think about',
        'how do i use', 'how to use', 'how to',
        'what are', 'what is', 'tips for', 'best practices for',
    ]
    for p in prefixes:
        if text.startswith(p + ' '):
            text = text[len(p):].strip()
            break

    # Phase 2: Strip multi-word suffixes
    suffixes = [
        'best practices', 'use cases', 'prompt techniques',
        'prompting techniques', 'prompting tips',
    ]
    for s in suffixes:
        if text.endswith(' ' + s):
            text = text[:-len(s)].strip()
            break

    # Phase 3: Filter individual noise words
    _noise = {
        # Question/filler words
        'a', 'an', 'the', 'is', 'are', 'was', 'were', 'and', 'or',
        'of', 'in', 'on', 'for', 'with', 'about', 'to',
        'people', 'saying', 'think', 'said', 'lately',
        # Research/meta descriptors
        'best', 'top', 'good', 'great', 'awesome', 'killer',
        'latest', 'new', 'news', 'update', 'updates',
        'trendiest', 'trending', 'hottest', 'hot', 'popular', 'viral',
        'practices', 'features', 'guide', 'tutorial',
        'recommendations', 'advice', 'review', 'reviews',
        'usecases', 'examples', 'comparison', 'versus', 'vs',
        'plugin', 'plugins', 'skill', 'skills', 'tool', 'tools',
        # Prompting meta words
        'prompt', 'prompts', 'prompting', 'techniques', 'tips',
        'tricks', 'methods', 'strategies', 'approaches',
        # Action words
        'using', 'uses', 'use',
    }
    words = text.split()
    result = [w for w in words if w not in _noise]

    return ' '.join(result[:3]) or topic.lower().strip()  # Max 3 words


def is_bird_installed() -> bool:
    """Check if vendored Bird search module is available.

    Returns:
        True if bird-search.mjs exists and Node.js 22+ is in PATH.
    """
    if not _BIRD_SEARCH_MJS.exists():
        return False
    return shutil.which("node") is not None


def is_bird_authenticated() -> Optional[str]:
    """Check if X credentials are available (env vars or browser cookies).

    Returns:
        Auth source string if authenticated, None otherwise.
    """
    if not is_bird_installed():
        return None

    try:
        result = subprocess.run(
            ["node", str(_BIRD_SEARCH_MJS), "--whoami"],
            capture_output=True,
            text=True,
            timeout=15,
            env=_subprocess_env(),
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().split('\n')[0]
        return None
    except (subprocess.TimeoutExpired, FileNotFoundError, subprocess.SubprocessError):
        return None


def check_npm_available() -> bool:
    """Check if npm is available (kept for API compatibility).

    Returns:
        True if 'npm' command is available in PATH, False otherwise.
    """
    return shutil.which("npm") is not None


def install_bird() -> Tuple[bool, str]:
    """No-op - Bird search is vendored in v2.1, no installation needed.

    Returns:
        Tuple of (success, message).
    """
    if is_bird_installed():
        return True, "Bird search is bundled with /last30days v2.1 - no installation needed."
    if not shutil.which("node"):
        return False, "Node.js 22+ is required for X search. Install Node.js first."
    return False, f"Vendored bird-search.mjs not found at {_BIRD_SEARCH_MJS}"


def get_bird_status() -> Dict[str, Any]:
    """Get comprehensive Bird search status.

    Returns:
        Dict with keys: installed, authenticated, username, can_install
    """
    installed = is_bird_installed()
    auth_source = is_bird_authenticated() if installed else None

    return {
        "installed": installed,
        "authenticated": auth_source is not None,
        "username": auth_source,  # Now returns auth source (e.g., "Safari", "env AUTH_TOKEN")
        "can_install": True,  # Always vendored in v2.1
    }


def _run_bird_search(query: str, count: int, timeout: int) -> Dict[str, Any]:
    """Run a search using the vendored bird-search.mjs module.

    Args:
        query: Full search query string (including since: filter)
        count: Number of results to request
        timeout: Timeout in seconds

    Returns:
        Raw Bird JSON response or error dict.
    """
    cmd = [
        "node", str(_BIRD_SEARCH_MJS),
        query,
        "--count", str(count),
        "--json",
    ]

    # Use process groups for clean cleanup on timeout/kill
    preexec = os.setsid if hasattr(os, 'setsid') else None

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            preexec_fn=preexec,
            env=_subprocess_env(),
        )

        # Register for cleanup tracking (if available)
        try:
            from last30days import register_child_pid, unregister_child_pid
            register_child_pid(proc.pid)
        except ImportError:
            pass

        try:
            stdout, stderr = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            # Kill the entire process group
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                proc.kill()
            proc.wait(timeout=5)
            return {"error": f"Search timed out after {timeout}s", "items": []}
        finally:
            try:
                from last30days import unregister_child_pid
                unregister_child_pid(proc.pid)
            except (ImportError, Exception):
                pass

        if proc.returncode != 0:
            error = stderr.strip() if stderr else "Bird search failed"
            return {"error": error, "items": []}

        output = stdout.strip() if stdout else ""
        if not output:
            return {"items": []}

        return json.loads(output)

    except json.JSONDecodeError as e:
        return {"error": f"Invalid JSON response: {e}", "items": []}
    except Exception as e:
        return {"error": str(e), "items": []}


def search_x(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
) -> Dict[str, Any]:
    """Search X using Bird CLI with automatic retry on 0 results.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD) - unused but kept for API compatibility
        depth: Research depth - "quick", "default", or "deep"

    Returns:
        Raw Bird JSON response or error dict.
    """
    count = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    timeout = 30 if depth == "quick" else 45 if depth == "default" else 60

    # Extract core subject - X search is literal, not semantic
    core_topic = _extract_core_subject(topic)
    query = f"{core_topic} since:{from_date}"

    _log(f"Searching: {query}")
    response = _run_bird_search(query, count, timeout)

    # Check if we got results
    items = parse_bird_response(response)

    # Retry with fewer keywords if 0 results and query has 3+ words
    core_words = core_topic.split()
    if not items and len(core_words) > 2:
        shorter = ' '.join(core_words[:2])
        _log(f"0 results for '{core_topic}', retrying with '{shorter}'")
        query = f"{shorter} since:{from_date}"
        response = _run_bird_search(query, count, timeout)
        items = parse_bird_response(response)

    # Last-chance retry: use strongest remaining token (often the product name)
    if not items and core_words:
        low_signal = {
            'trendiest', 'trending', 'hottest', 'hot', 'popular', 'viral',
            'best', 'top', 'latest', 'new', 'plugin', 'plugins',
            'skill', 'skills', 'tool', 'tools',
        }
        candidates = [w for w in core_words if w not in low_signal]
        if candidates:
            strongest = max(candidates, key=len)
            _log(f"0 results for '{core_topic}', retrying with strongest token '{strongest}'")
            query = f"{strongest} since:{from_date}"
            response = _run_bird_search(query, count, timeout)

    return response


def search_handles(
    handles: List[str],
    topic: Optional[str],
    from_date: str,
    count_per: int = 5,
) -> List[Dict[str, Any]]:
    """Search specific X handles for topic-related content.

    Runs targeted Bird searches using `from:handle topic` syntax.
    Used in Phase 2 supplemental search after entity extraction.

    Args:
        handles: List of X handles to search (without @)
        topic: Search topic (core subject), or None for unfiltered search
        from_date: Start date (YYYY-MM-DD)
        count_per: Results to request per handle

    Returns:
        List of raw item dicts (same format as parse_bird_response output).
    """
    all_items = []
    core_topic = _extract_core_subject(topic) if topic else None

    for handle in handles:
        handle = handle.lstrip("@")
        if core_topic:
            query = f"from:{handle} {core_topic} since:{from_date}"
        else:
            query = f"from:{handle} since:{from_date}"

        cmd = [
            "node", str(_BIRD_SEARCH_MJS),
            query,
            "--count", str(count_per),
            "--json",
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
                stdout, stderr = proc.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except (ProcessLookupError, PermissionError, OSError):
                    proc.kill()
                proc.wait(timeout=5)
                _log(f"Handle search timed out for @{handle}")
                continue

            if proc.returncode != 0:
                _log(f"Handle search failed for @{handle}: {(stderr or '').strip()}")
                continue

            output = (stdout or "").strip()
            if not output:
                continue

            response = json.loads(output)
            items = parse_bird_response(response)
            all_items.extend(items)

        except json.JSONDecodeError:
            _log(f"Invalid JSON from handle search for @{handle}")
        except Exception as e:
            _log(f"Handle search error for @{handle}: {e}")

    return all_items


def parse_bird_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse Bird response to match xai_x output format.

    Args:
        response: Raw Bird JSON response

    Returns:
        List of normalized item dicts matching xai_x.parse_x_response() format.
    """
    items = []

    # Check for errors
    if "error" in response and response["error"]:
        _log(f"Bird error: {response['error']}")
        return items

    # Bird returns a list of tweets directly or under a key
    raw_items = response if isinstance(response, list) else response.get("items", response.get("tweets", []))

    if not isinstance(raw_items, list):
        return items

    for i, tweet in enumerate(raw_items):
        if not isinstance(tweet, dict):
            continue

        # Extract URL - Bird uses permanent_url or we construct from id
        url = tweet.get("permanent_url") or tweet.get("url", "")
        if not url and tweet.get("id"):
            # Try different field structures Bird might use
            author = tweet.get("author", {}) or tweet.get("user", {})
            screen_name = author.get("username") or author.get("screen_name", "")
            if screen_name:
                url = f"https://x.com/{screen_name}/status/{tweet['id']}"

        if not url:
            continue

        # Parse date from created_at/createdAt (e.g., "Wed Jan 15 14:30:00 +0000 2026")
        date = None
        created_at = tweet.get("createdAt") or tweet.get("created_at", "")
        if created_at:
            try:
                # Try ISO format first (e.g., "2026-02-03T22:33:32Z")
                # Check for ISO date separator, not just "T" (which appears in "Tue")
                if len(created_at) > 10 and created_at[10] == "T":
                    dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                else:
                    # Twitter format: "Wed Jan 15 14:30:00 +0000 2026"
                    dt = datetime.strptime(created_at, "%a %b %d %H:%M:%S %z %Y")
                date = dt.strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                pass

        # Extract user info (Bird uses author.username, older format uses user.screen_name)
        author = tweet.get("author", {}) or tweet.get("user", {})
        author_handle = author.get("username") or author.get("screen_name", "") or tweet.get("author_handle", "")

        # Build engagement dict (Bird uses camelCase: likeCount, retweetCount, etc.)
        engagement = {
            "likes": tweet.get("likeCount") or tweet.get("like_count") or tweet.get("favorite_count"),
            "reposts": tweet.get("retweetCount") or tweet.get("retweet_count"),
            "replies": tweet.get("replyCount") or tweet.get("reply_count"),
            "quotes": tweet.get("quoteCount") or tweet.get("quote_count"),
        }
        # Convert to int where possible
        for key in engagement:
            if engagement[key] is not None:
                try:
                    engagement[key] = int(engagement[key])
                except (ValueError, TypeError):
                    engagement[key] = None

        # Build normalized item
        item = {
            "id": f"X{i+1}",
            "text": str(tweet.get("text", tweet.get("full_text", ""))).strip()[:500],
            "url": url,
            "author_handle": author_handle.lstrip("@"),
            "date": date,
            "engagement": engagement if any(v is not None for v in engagement.values()) else None,
            "why_relevant": "",  # Bird doesn't provide relevance explanations
            "relevance": 0.7,  # Default relevance, let score.py re-rank
        }

        items.append(item)

    return items