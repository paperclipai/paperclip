#!/usr/bin/env python3
"""
last30days - Research a topic from the last 30 days on Reddit + X + YouTube + Web.

Usage:
    python3 last30days.py <topic> [options]

Options:
    --mock              Use fixtures instead of real API calls
    --emit=MODE         Output mode: compact|json|md|context|path (default: compact)
    --sources=MODE      Source selection: auto|reddit|x|both (default: auto)
    --quick             Faster research with fewer sources (8-12 each)
    --deep              Comprehensive research with more sources (50-70 Reddit, 40-60 X)
    --debug             Enable verbose debug logging
    --store             Persist findings to SQLite database
    --diagnose          Show source availability diagnostics and exit
"""

import argparse
import atexit
import json
import os
import signal
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

# Add lib to path
SCRIPT_DIR = Path(__file__).parent.resolve()
sys.path.insert(0, str(SCRIPT_DIR))

# ---------------------------------------------------------------------------
# Global timeout & child process management
# ---------------------------------------------------------------------------
_child_pids: set = set()
_child_pids_lock = threading.Lock()

TIMEOUT_PROFILES = {
    "quick":   {"global": 90,  "future": 30, "reddit_future": 60,  "youtube_future": 60,  "tiktok_future": 90,   "instagram_future": 90,   "hackernews_future": 30,  "bluesky_future": 30,  "truthsocial_future": 30,  "polymarket_future": 15,  "http": 15, "enrich_per": 8,  "enrich_total": 30, "enrich_max_items": 10},
    "default": {"global": 180, "future": 60, "reddit_future": 90,  "youtube_future": 90,  "tiktok_future": 120,  "instagram_future": 120,  "hackernews_future": 60,  "bluesky_future": 60,  "truthsocial_future": 60,  "polymarket_future": 30,  "http": 30, "enrich_per": 15, "enrich_total": 45, "enrich_max_items": 15},
    "deep":    {"global": 300, "future": 90, "reddit_future": 120, "youtube_future": 120, "tiktok_future": 150,  "instagram_future": 150,  "hackernews_future": 90,  "bluesky_future": 90,  "truthsocial_future": 90,  "polymarket_future": 45,  "http": 30, "enrich_per": 15, "enrich_total": 60, "enrich_max_items": 25},
}

# Valid source names for the --search flag
VALID_SEARCH_SOURCES = {
    "reddit", "x", "hn", "bluesky", "bsky", "truthsocial", "truth", "youtube", "tiktok", "instagram",
    "polymarket", "web", "xiaohongshu", "xhs",
}


def parse_search_flag(search_str: str) -> set:
    """Parse and validate the --search flag value.

    Args:
        search_str: Comma-separated source names (e.g. "reddit,hn")

    Returns:
        Set of validated source names

    Raises:
        SystemExit: If invalid sources are specified
    """
    sources = set()
    for s in search_str.split(","):
        s = s.strip().lower()
        if not s:
            continue
        if s == "xhs":
            s = "xiaohongshu"
        if s not in VALID_SEARCH_SOURCES:
            print(
                f"Error: Unknown search source '{s}'. "
                f"Valid: {', '.join(sorted(VALID_SEARCH_SOURCES))}",
                file=sys.stderr,
            )
            sys.exit(1)
        sources.add(s)
    if not sources:
        print("Error: --search requires at least one source.", file=sys.stderr)
        sys.exit(1)
    return sources


def register_child_pid(pid: int):
    """Track a child process for cleanup."""
    with _child_pids_lock:
        _child_pids.add(pid)


def unregister_child_pid(pid: int):
    """Remove a child process from tracking."""
    with _child_pids_lock:
        _child_pids.discard(pid)


def _cleanup_children():
    """Kill all tracked child processes."""
    with _child_pids_lock:
        pids = list(_child_pids)
    for pid in pids:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass


atexit.register(_cleanup_children)


def _install_global_timeout(timeout_seconds: int):
    """Install a global timeout watchdog.

    Uses SIGALRM on Unix, threading.Timer as fallback.
    """
    if hasattr(signal, 'SIGALRM'):
        def _handler(signum, frame):
            sys.stderr.write(f"\n[TIMEOUT] Global timeout ({timeout_seconds}s) exceeded. Cleaning up.\n")
            sys.stderr.flush()
            _cleanup_children()
            sys.exit(1)
        signal.signal(signal.SIGALRM, _handler)
        signal.alarm(timeout_seconds)
    else:
        # Windows fallback
        def _watchdog():
            sys.stderr.write(f"\n[TIMEOUT] Global timeout ({timeout_seconds}s) exceeded. Cleaning up.\n")
            sys.stderr.flush()
            _cleanup_children()
            os._exit(1)
        timer = threading.Timer(timeout_seconds, _watchdog)
        timer.daemon = True
        timer.start()

from lib import (
    bird_x,
    bluesky,
    truthsocial,
    dates,
    dedupe,
    hackernews,
    xiaohongshu_api,
    polymarket,
    entity_extract,
    env,
    http,
    models,
    normalize,
    openai_reddit,
    reddit,
    reddit_enrich,
    render,
    schema,
    score,
    scrapecreators_x,
    ui,
    tiktok,
    instagram,
    websearch,
    xai_x,
    youtube_yt,
)


def load_fixture(name: str) -> dict:
    """Load a fixture file."""
    fixture_path = SCRIPT_DIR.parent / "fixtures" / name
    if fixture_path.exists():
        with open(fixture_path) as f:
            return json.load(f)
    return {}


def _search_reddit(
    topic: str,
    config: dict,
    selected_models: dict,
    from_date: str,
    to_date: str,
    depth: str,
    mock: bool,
) -> tuple:
    """Search Reddit (runs in thread).

    Uses ScrapeCreators when SCRAPECREATORS_API_KEY is available (preferred).
    Falls back to OpenAI Responses API otherwise.

    Returns:
        Tuple of (reddit_items, raw_response, error, used_scrapecreators)
    """
    raw_response = None
    reddit_error = None
    used_scrapecreators = False

    sc_token = config.get("SCRAPECREATORS_API_KEY")

    if mock:
        raw_response = load_fixture("openai_sample.json")
    elif sc_token:
        # === ScrapeCreators path (preferred) ===
        used_scrapecreators = True
        try:
            sys.stderr.write("[Reddit] Using ScrapeCreators API\n")
            sys.stderr.flush()
            result = reddit.search_and_enrich(
                topic, from_date, to_date,
                depth=depth, token=sc_token,
            )
            reddit_items = result.get("items", [])
            if result.get("error"):
                reddit_error = result["error"]
            return reddit_items, result, reddit_error, used_scrapecreators
        except Exception as e:
            reddit_error = f"ScrapeCreators: {type(e).__name__}: {e}"
            sys.stderr.write(f"[Reddit] ScrapeCreators failed: {e}\n")
            sys.stderr.flush()
            # Fall through to OpenAI if we have that key
            if not config.get("OPENAI_API_KEY"):
                # No OpenAI either: try public Reddit fallback.
                try:
                    reddit_items = openai_reddit.search_reddit_public(
                        topic, from_date, to_date, depth=depth,
                    )
                    raw_response = {"source": "reddit_public", "items": reddit_items}
                    return reddit_items, raw_response, None, False
                except Exception as e2:
                    return [], {"error": str(e)}, reddit_error, used_scrapecreators
            used_scrapecreators = False
            sys.stderr.write("[Reddit] Falling back to OpenAI\n")
            sys.stderr.flush()

    # === OpenAI path (fallback) ===
    if not mock:
        if config.get("OPENAI_API_KEY"):
            try:
                raw_response = openai_reddit.search_reddit(
                    config["OPENAI_API_KEY"],
                    selected_models["openai"],
                    topic,
                    from_date,
                    to_date,
                    depth=depth,
                    auth_source=config.get("OPENAI_AUTH_SOURCE", "api_key"),
                    account_id=config.get("OPENAI_CHATGPT_ACCOUNT_ID"),
                )
            except http.HTTPError as e:
                raw_response = {"error": str(e)}
                reddit_error = f"API error: {e}"
            except Exception as e:
                raw_response = {"error": str(e)}
                reddit_error = f"{type(e).__name__}: {e}"
        else:
            # No OpenAI auth: direct Reddit public JSON fallback.
            try:
                reddit_items = openai_reddit.search_reddit_public(
                    topic, from_date, to_date, depth=depth,
                )
                raw_response = {"source": "reddit_public", "items": reddit_items}
            except http.HTTPError as e:
                reddit_items = []
                raw_response = {"error": str(e), "source": "reddit_public"}
                reddit_error = f"Reddit public API error: {e}"
            except Exception as e:
                reddit_items = []
                raw_response = {"error": str(e), "source": "reddit_public"}
                reddit_error = f"Reddit public search error: {type(e).__name__}: {e}"

    # Parse response
    reddit_items = openai_reddit.parse_reddit_response(raw_response or {})

    # Quick retry with simpler query if few results
    if len(reddit_items) < 5 and not mock and not reddit_error and config.get("OPENAI_API_KEY"):
        core = openai_reddit._extract_core_subject(topic)
        if core.lower() != topic.lower():
            try:
                retry_raw = openai_reddit.search_reddit(
                    config["OPENAI_API_KEY"],
                    selected_models["openai"],
                    core,
                    from_date, to_date,
                    depth=depth,
                    auth_source=config.get("OPENAI_AUTH_SOURCE", "api_key"),
                    account_id=config.get("OPENAI_CHATGPT_ACCOUNT_ID"),
                )
                retry_items = openai_reddit.parse_reddit_response(retry_raw)
                existing_urls = {item.get("url") for item in reddit_items}
                for item in retry_items:
                    if item.get("url") not in existing_urls:
                        reddit_items.append(item)
            except Exception:
                pass

    # Subreddit-targeted fallback if still < 3 results
    if len(reddit_items) < 3 and not mock and not reddit_error and config.get("OPENAI_API_KEY"):
        sub_query = openai_reddit._build_subreddit_query(topic)
        try:
            sub_raw = openai_reddit.search_reddit(
                config["OPENAI_API_KEY"],
                selected_models["openai"],
                sub_query,
                from_date, to_date,
                depth=depth,
            )
            sub_items = openai_reddit.parse_reddit_response(sub_raw)
            existing_urls = {item.get("url") for item in reddit_items}
            for item in sub_items:
                if item.get("url") not in existing_urls:
                    reddit_items.append(item)
        except Exception:
            pass

    return reddit_items, raw_response, reddit_error, used_scrapecreators


def _search_x(
    topic: str,
    config: dict,
    selected_models: dict,
    from_date: str,
    to_date: str,
    depth: str,
    mock: bool,
    x_source: str = "xai",
) -> tuple:
    """Search X via Bird CLI or xAI (runs in thread).

    Args:
        x_source: 'bird' or 'xai' - which backend to use

    Returns:
        Tuple of (x_items, raw_response, error)
    """
    raw_response = None
    x_error = None

    if mock:
        raw_response = load_fixture("xai_sample.json")
        x_items = xai_x.parse_x_response(raw_response or {})
        return x_items, raw_response, x_error

    # Use Bird if specified
    if x_source == "bird":
        try:
            raw_response = bird_x.search_x(
                topic,
                from_date,
                to_date,
                depth=depth,
            )
        except Exception as e:
            raw_response = {"error": str(e)}
            x_error = f"{type(e).__name__}: {e}"

        x_items = bird_x.parse_bird_response(raw_response or {})

        # Check for error in response (Bird returns list on success, dict on error)
        if raw_response and isinstance(raw_response, dict) and raw_response.get("error") and not x_error:
            x_error = raw_response["error"]

        return x_items, raw_response, x_error

    # Use ScrapeCreators if specified
    if x_source == "scrapecreators":
        try:
            raw_response = scrapecreators_x.search_x(
                topic, from_date, to_date,
                depth=depth,
                token=config.get("SCRAPECREATORS_API_KEY"),
            )
        except Exception as e:
            raw_response = {"error": str(e)}
            x_error = f"{type(e).__name__}: {e}"

        x_items = scrapecreators_x.parse_x_response(raw_response or {})

        if raw_response and isinstance(raw_response, dict) and raw_response.get("error") and not x_error:
            x_error = raw_response["error"]

        return x_items, raw_response, x_error

    # Use xAI (original behavior)
    try:
        raw_response = xai_x.search_x(
            config["XAI_API_KEY"],
            selected_models["xai"],
            topic,
            from_date,
            to_date,
            depth=depth,
        )
    except http.HTTPError as e:
        raw_response = {"error": str(e)}
        x_error = f"API error: {e}"
    except Exception as e:
        raw_response = {"error": str(e)}
        x_error = f"{type(e).__name__}: {e}"

    x_items = xai_x.parse_x_response(raw_response or {})

    return x_items, raw_response, x_error


def _search_youtube(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str,
) -> tuple:
    """Search YouTube via yt-dlp (runs in thread).

    Returns:
        Tuple of (youtube_items, youtube_error)
    """
    youtube_error = None

    try:
        response = youtube_yt.search_and_transcribe(
            topic, from_date, to_date, depth=depth,
        )
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"

    youtube_items = youtube_yt.parse_youtube_response(response)

    if response.get("error"):
        youtube_error = response["error"]

    return youtube_items, youtube_error


def _search_tiktok(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str,
    token: str,
) -> tuple:
    """Search TikTok via ScrapeCreators (runs in thread).

    Returns:
        Tuple of (tiktok_items, tiktok_error)
    """
    tiktok_error = None

    try:
        response = tiktok.search_and_enrich(
            topic, from_date, to_date, depth=depth, token=token,
        )
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"

    tiktok_items = tiktok.parse_tiktok_response(response)

    if response.get("error"):
        tiktok_error = response["error"]

    return tiktok_items, tiktok_error


def _search_instagram(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str,
    token: str,
) -> tuple:
    """Search Instagram via ScrapeCreators (runs in thread).

    Returns:
        Tuple of (instagram_items, instagram_error)
    """
    instagram_error = None

    try:
        response = instagram.search_and_enrich(
            topic, from_date, to_date, depth=depth, token=token,
        )
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"

    instagram_items = instagram.parse_instagram_response(response)

    if response.get("error"):
        instagram_error = response["error"]

    return instagram_items, instagram_error


def _search_hackernews(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str,
) -> tuple:
    """Search Hacker News via Algolia (runs in thread).

    Returns:
        Tuple of (hn_items, hn_error)
    """
    hn_error = None

    try:
        response = hackernews.search_hackernews(
            topic, from_date, to_date, depth=depth,
        )
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"

    hn_items = hackernews.parse_hackernews_response(response)

    if response.get("error"):
        hn_error = response["error"]

    return hn_items, hn_error


def _search_bluesky(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str,
    config: dict = None,
) -> tuple:
    """Search Bluesky via AT Protocol (runs in thread).

    Returns:
        Tuple of (bsky_items, bsky_error)
    """
    bsky_error = None

    try:
        response = bluesky.search_bluesky(
            topic, from_date, to_date, depth=depth, config=config,
        )
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"

    bsky_items = bluesky.parse_bluesky_response(response)

    if response.get("error"):
        bsky_error = response["error"]

    return bsky_items, bsky_error


def _search_truthsocial(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str,
    config: dict = None,
) -> tuple:
    """Search Truth Social via Mastodon API (runs in thread).

    Returns:
        Tuple of (ts_items, ts_error)
    """
    ts_error = None

    try:
        response = truthsocial.search_truthsocial(
            topic, from_date, to_date, depth=depth, config=config,
        )
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"

    ts_items = truthsocial.parse_truthsocial_response(response)

    if response.get("error"):
        ts_error = response["error"]

    return ts_items, ts_error


def _search_polymarket(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str,
) -> tuple:
    """Search Polymarket via Gamma API (runs in thread).

    Returns:
        Tuple of (pm_items, pm_error)
    """
    pm_error = None

    try:
        response = polymarket.search_polymarket(
            topic, from_date, to_date, depth=depth,
        )
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"

    pm_items = polymarket.parse_polymarket_response(response, topic=topic)

    if response.get("error"):
        pm_error = response["error"]

    return pm_items, pm_error


def _search_web(
    topic: str,
    config: dict,
    from_date: str,
    to_date: str,
    depth: str,
) -> tuple:
    """Search the web via native API backend (runs in thread).

    Uses the best available backend: Parallel AI > Brave > OpenRouter.

    Returns:
        Tuple of (web_items, web_error)
        web_items are raw dicts ready for websearch.normalize_websearch_items()
    """
    from lib import brave_search, parallel_search, openrouter_search

    backend = env.get_web_search_source(config)
    if not backend:
        return [], "No web search API keys configured"

    web_error = None
    raw_results = []

    try:
        if backend == "parallel":
            raw_results = parallel_search.search_web(
                topic, from_date, to_date, config["PARALLEL_API_KEY"], depth=depth,
            )
        elif backend == "brave":
            raw_results = brave_search.search_web(
                topic, from_date, to_date, config["BRAVE_API_KEY"], depth=depth,
            )
        elif backend == "openrouter":
            raw_results = openrouter_search.search_web(
                topic, from_date, to_date, config["OPENROUTER_API_KEY"], depth=depth,
            )
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"

    # Add IDs and date_confidence for websearch.normalize_websearch_items()
    for i, item in enumerate(raw_results):
        item.setdefault("id", f"W{i+1}")
        if item.get("date") and not item.get("date_confidence"):
            item["date_confidence"] = "med"
        elif not item.get("date"):
            item["date_confidence"] = "low"
        item.setdefault("why_relevant", "")

    return raw_results, web_error


def _search_xiaohongshu(
    topic: str,
    config: dict,
    from_date: str,
    to_date: str,
    depth: str,
) -> tuple:
    """Search Xiaohongshu via xiaohongshu-mcp HTTP API (runs in thread).

    Returns:
        Tuple of (xiaohongshu_items, xiaohongshu_error)
        Items are in web-item dict shape and can be normalized with websearch module.
    """
    base_url = env.get_xiaohongshu_api_base(config)
    try:
        items = xiaohongshu_api.search_feeds(
            topic=topic,
            from_date=from_date,
            to_date=to_date,
            base_url=base_url,
            depth=depth,
        )
    except Exception as e:
        return [], f"{type(e).__name__}: {e}"

    # Ensure all required keys exist for normalize_websearch_items()
    for i, item in enumerate(items):
        item.setdefault("id", f"XHS{i+1}")
        item.setdefault("title", "")
        item.setdefault("url", "")
        item.setdefault("source_domain", "xiaohongshu.com")
        item.setdefault("snippet", "")
        if item.get("date") and not item.get("date_confidence"):
            item["date_confidence"] = "med"
        elif not item.get("date"):
            item["date_confidence"] = "low"
        item.setdefault("relevance", 0.5)
        item.setdefault("why_relevant", "")

    return items, None


def _run_supplemental(
    topic: str,
    reddit_items: list,
    x_items: list,
    from_date: str,
    to_date: str,
    depth: str,
    x_source: str,
    progress: ui.ProgressDisplay = None,
    skip_reddit: bool = False,
    resolved_handle: str = None,
) -> tuple:
    """Run Phase 2 supplemental searches based on entities from Phase 1.

    Extracts handles/subreddits from initial results, then runs targeted
    searches to find additional content the broad search missed.

    Args:
        topic: Original search topic
        reddit_items: Phase 1 Reddit items (raw dicts)
        x_items: Phase 1 X items (raw dicts)
        from_date: Start date
        to_date: End date
        depth: Research depth
        x_source: 'bird' or 'xai'
        progress: Optional progress display
        skip_reddit: If True, skip Reddit supplemental (e.g. rate-limited)
        resolved_handle: X handle resolved by the agent (without @), searched unfiltered

    Returns:
        Tuple of (supplemental_reddit, supplemental_x)
    """
    # Depth-dependent caps
    if depth == "default":
        max_handles = 3
        max_subs = 3
        count_per = 3
    else:  # deep
        max_handles = 5
        max_subs = 5
        count_per = 5

    # Extract entities from Phase 1 results
    entities = entity_extract.extract_entities(
        reddit_items, x_items,
        max_handles=max_handles,
        max_subreddits=max_subs,
    )

    has_handles = entities["x_handles"] and x_source == "bird"
    has_subs = entities["reddit_subreddits"] and not skip_reddit

    # Always run unfiltered search for resolved handle (even if entity-extracted).
    # Entity-extracted handles get topic-filtered queries (from:handle topic),
    # but resolved handles need UNFILTERED search (from:handle) to find posts
    # that don't mention the topic string (e.g. Dor Brothers' viral tweet about
    # Logan Paul doesn't contain "dor brothers" in the text).
    has_resolved = bool(resolved_handle) and x_source == "bird"

    if not has_handles and not has_subs and not has_resolved:
        return [], []

    parts = []
    if has_resolved:
        parts.append(f"@{resolved_handle} (resolved)")
    if has_handles:
        parts.append(f"@{', @'.join(entities['x_handles'][:3])}")
    if has_subs:
        parts.append(f"r/{', r/'.join(entities['reddit_subreddits'][:3])}")
    sys.stderr.write(f"[Phase 2] Drilling into {' + '.join(parts)}\n")
    sys.stderr.flush()

    supplemental_reddit = []
    supplemental_x = []

    # Collect existing URLs to avoid adding duplicates before dedupe
    existing_urls = set()
    for item in reddit_items:
        existing_urls.add(item.get("url", ""))
    for item in x_items:
        existing_urls.add(item.get("url", ""))

    # Run supplemental searches in parallel
    reddit_future = None
    x_future = None
    resolved_future = None

    max_workers = sum([bool(has_subs), bool(has_handles), bool(has_resolved)])
    with ThreadPoolExecutor(max_workers=max(max_workers, 1)) as executor:
        if has_subs:
            reddit_future = executor.submit(
                openai_reddit.search_subreddits,
                entities["reddit_subreddits"],
                topic,
                from_date,
                to_date,
                count_per,
            )

        if has_handles:
            x_future = executor.submit(
                bird_x.search_handles,
                entities["x_handles"],
                topic,
                from_date,
                count_per,
            )

        if has_resolved:
            # Resolved handle: search unfiltered (topic=None) to get all recent posts
            resolved_future = executor.submit(
                bird_x.search_handles,
                [resolved_handle],
                None,  # No topic filter - get all recent activity
                from_date,
                10,  # More results for the topic entity
            )

        if reddit_future:
            try:
                raw_reddit = reddit_future.result(timeout=30)
                # Filter out URLs already found in Phase 1
                supplemental_reddit = [
                    item for item in raw_reddit
                    if item.get("url", "") not in existing_urls
                ]
            except TimeoutError:
                sys.stderr.write("[Phase 2] Supplemental Reddit timed out (30s)\n")
            except Exception as e:
                sys.stderr.write(f"[Phase 2] Supplemental Reddit error: {e}\n")

        if x_future:
            try:
                raw_x = x_future.result(timeout=30)
                supplemental_x = [
                    item for item in raw_x
                    if item.get("url", "") not in existing_urls
                ]
            except TimeoutError:
                sys.stderr.write("[Phase 2] Supplemental X timed out (30s)\n")
            except Exception as e:
                sys.stderr.write(f"[Phase 2] Supplemental X error: {e}\n")

        if resolved_future:
            try:
                raw_resolved = resolved_future.result(timeout=30)
                # Lower relevance for unfiltered handle posts (no topic keyword signal)
                for item in raw_resolved:
                    item["relevance"] = 0.5
                resolved_new = [
                    item for item in raw_resolved
                    if item.get("url", "") not in existing_urls
                ]
                supplemental_x.extend(resolved_new)
                if resolved_new:
                    sys.stderr.write(f"[Phase 2] +{len(resolved_new)} from @{resolved_handle}\n")
            except TimeoutError:
                sys.stderr.write(f"[Phase 2] Resolved handle @{resolved_handle} timed out (30s)\n")
            except Exception as e:
                sys.stderr.write(f"[Phase 2] Resolved handle error: {e}\n")

    if supplemental_reddit or supplemental_x:
        sys.stderr.write(
            f"[Phase 2] +{len(supplemental_reddit)} Reddit, +{len(supplemental_x)} X\n"
        )
        sys.stderr.flush()

    return supplemental_reddit, supplemental_x


def run_research(
    topic: str,
    sources: str,
    config: dict,
    selected_models: dict,
    from_date: str,
    to_date: str,
    depth: str = "default",
    mock: bool = False,
    progress: ui.ProgressDisplay = None,
    x_source: str = "xai",
    run_youtube: bool = False,
    run_tiktok: bool = False,
    run_instagram: bool = False,
    run_xiaohongshu: bool = False,
    timeouts: dict = None,
    resolved_handle: str = None,
    do_hackernews: bool = True,
    do_bluesky: bool = True,
    do_truthsocial: bool = True,
    do_polymarket: bool = True,
    no_native_web: bool = False,
) -> tuple:
    """Run the research pipeline.

    Returns:
        Tuple of (reddit_items, x_items, youtube_items, tiktok_items, instagram_items,
                  hackernews_items, bluesky_items, truthsocial_items, polymarket_items, web_items, web_needed,
                  raw_openai, raw_xai, raw_reddit_enriched,
                  reddit_error, x_error, youtube_error, tiktok_error, instagram_error,
                  hackernews_error, bluesky_error, truthsocial_error, polymarket_error, web_error)

    Note: web_needed is True when web search should be performed by the assistant
    (i.e., no native web search API keys are configured). When native web search
    runs, web_items will be populated and web_needed will be False.
    """
    if timeouts is None:
        timeouts = TIMEOUT_PROFILES[depth]
    future_timeout = timeouts["future"]

    reddit_items = []
    x_items = []
    youtube_items = []
    tiktok_items = []
    instagram_items = []
    hackernews_items = []
    bluesky_items = []
    truthsocial_items = []
    polymarket_items = []
    web_items = []
    raw_openai = None
    raw_xai = None
    raw_reddit_enriched = []
    reddit_error = None
    x_error = None
    youtube_error = None
    tiktok_error = None
    instagram_error = None
    hackernews_error = None
    bluesky_error = None
    truthsocial_error = None
    polymarket_error = None
    web_error = None
    xiaohongshu_error = None

    # Determine web search mode
    do_web = sources in ("all", "web", "reddit-web", "x-web")
    web_backend = env.get_web_search_source(config) if (do_web and not no_native_web) else None
    web_needed = do_web and not web_backend

    # Web-only mode
    if sources == "web":
        if web_backend:
            # Native web search available — run it
            sys.stderr.write(f"[web] Searching via {web_backend}\n")
            sys.stderr.flush()
            try:
                web_items, web_error = _search_web(topic, config, from_date, to_date, depth)
                if web_error and progress:
                    progress.show_error(f"Web error: {web_error}")
            except Exception as e:
                web_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"Web error: {e}")
            sys.stderr.write(f"[web] {len(web_items)} results\n")
            sys.stderr.flush()
        else:
            # No native backend — assistant handles WebSearch
            if progress:
                progress.start_web_only()
                progress.end_web_only()
        # Optional Xiaohongshu search in web-only mode.
        if run_xiaohongshu:
            try:
                xhs_items, xiaohongshu_error = _search_xiaohongshu(
                    topic, config, from_date, to_date, depth,
                )
                web_items.extend(xhs_items)
                if xiaohongshu_error and progress:
                    progress.show_error(f"Xiaohongshu error: {xiaohongshu_error}")
            except Exception as e:
                xiaohongshu_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"Xiaohongshu error: {e}")
        # Still run YouTube/TikTok/Instagram in web-only mode if available
        if run_youtube:
            if progress:
                progress.start_youtube()
            try:
                youtube_items, youtube_error = _search_youtube(topic, from_date, to_date, depth)
                if youtube_error and progress:
                    progress.show_error(f"YouTube error: {youtube_error}")
            except Exception as e:
                youtube_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"YouTube error: {e}")
            if progress:
                progress.end_youtube(len(youtube_items))
        if run_tiktok:
            if progress:
                progress.start_tiktok()
            try:
                tiktok_items, tiktok_error = _search_tiktok(topic, from_date, to_date, depth, env.get_tiktok_token(config))
                if tiktok_error and progress:
                    progress.show_error(f"TikTok error: {tiktok_error}")
            except Exception as e:
                tiktok_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"TikTok error: {e}")
            if progress:
                progress.end_tiktok(len(tiktok_items))
        if run_instagram:
            if progress:
                progress.start_instagram()
            try:
                ig_timeout = timeouts.get("instagram_future", future_timeout)
                instagram_items, instagram_error = _search_instagram(topic, from_date, to_date, depth, env.get_instagram_token(config))
                if instagram_error and progress:
                    progress.show_error(f"Instagram error: {instagram_error}")
            except Exception as e:
                instagram_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"Instagram error: {e}")
            if progress:
                progress.end_instagram(len(instagram_items))
        return reddit_items, x_items, youtube_items, tiktok_items, instagram_items, hackernews_items, bluesky_items, truthsocial_items, polymarket_items, web_items, web_needed, raw_openai, raw_xai, raw_reddit_enriched, reddit_error, x_error, youtube_error, tiktok_error, instagram_error, hackernews_error, bluesky_error, truthsocial_error, polymarket_error, web_error

    # Determine which searches to run
    do_reddit = sources in ("both", "reddit", "all", "reddit-web")
    do_x = sources in ("both", "x", "all", "x-web")
    # do_hackernews / do_polymarket are always True by default, but can be
    # restricted via the --search flag to run a focused source subset.

    # Run Reddit, X, YouTube, HN, Polymarket, and Web searches in parallel
    reddit_future = None
    x_future = None
    youtube_future = None
    tiktok_future = None
    instagram_future = None
    xiaohongshu_future = None
    hackernews_future = None
    bluesky_future = None
    truthsocial_future = None
    polymarket_future = None
    web_future = None
    max_workers = (
        2
        + (1 if run_youtube else 0)
        + (1 if run_tiktok else 0)
        + (1 if run_instagram else 0)
        + (1 if run_xiaohongshu else 0)
        + (1 if do_hackernews else 0)
        + (1 if do_bluesky else 0)
        + (1 if do_truthsocial else 0)
        + (1 if do_polymarket else 0)
        + (1 if web_backend else 0)
    )

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        # Submit searches
        if do_reddit:
            if progress:
                progress.start_reddit()
            reddit_future = executor.submit(
                _search_reddit, topic, config, selected_models,
                from_date, to_date, depth, mock
            )

        if do_x:
            if progress:
                progress.start_x()
            x_future = executor.submit(
                _search_x, topic, config, selected_models,
                from_date, to_date, depth, mock, x_source
            )

        if run_youtube:
            if progress:
                progress.start_youtube()
            youtube_future = executor.submit(
                _search_youtube, topic, from_date, to_date, depth
            )

        if run_tiktok:
            if progress:
                progress.start_tiktok()
            tiktok_future = executor.submit(
                _search_tiktok, topic, from_date, to_date, depth,
                env.get_tiktok_token(config),
            )

        if run_instagram:
            if progress:
                progress.start_instagram()
            instagram_future = executor.submit(
                _search_instagram, topic, from_date, to_date, depth,
                env.get_instagram_token(config),
            )

        if run_xiaohongshu:
            xiaohongshu_future = executor.submit(
                _search_xiaohongshu, topic, config, from_date, to_date, depth,
            )

        if do_hackernews:
            if progress:
                progress.start_hackernews()
            hackernews_future = executor.submit(
                _search_hackernews, topic, from_date, to_date, depth
            )

        if do_bluesky:
            bluesky_future = executor.submit(
                _search_bluesky, topic, from_date, to_date, depth, config
            )

        if do_truthsocial:
            truthsocial_future = executor.submit(
                _search_truthsocial, topic, from_date, to_date, depth, config
            )

        if do_polymarket:
            if progress:
                progress.start_polymarket()
            polymarket_future = executor.submit(
                _search_polymarket, topic, from_date, to_date, depth
            )

        if web_backend:
            sys.stderr.write(f"[web] Searching via {web_backend}\n")
            sys.stderr.flush()
            web_future = executor.submit(
                _search_web, topic, config, from_date, to_date, depth
            )

        # Collect results (with timeouts to prevent indefinite blocking)
        reddit_used_sc = False  # Track if ScrapeCreators was used for Reddit
        if reddit_future:
            reddit_timeout = timeouts.get("reddit_future", future_timeout)
            try:
                reddit_items, raw_openai, reddit_error, reddit_used_sc = reddit_future.result(timeout=reddit_timeout)
                if reddit_error and progress:
                    progress.show_error(f"Reddit error: {reddit_error}")
            except TimeoutError:
                reddit_error = f"Reddit search timed out after {reddit_timeout}s"
                if progress:
                    progress.show_error(reddit_error)
            except Exception as e:
                reddit_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"Reddit error: {e}")
            if progress:
                progress.end_reddit(len(reddit_items))

        if x_future:
            try:
                x_items, raw_xai, x_error = x_future.result(timeout=future_timeout)
                if x_error and progress:
                    progress.show_error(f"X error: {x_error}")
            except TimeoutError:
                x_error = f"X search timed out after {future_timeout}s"
                if progress:
                    progress.show_error(x_error)
            except Exception as e:
                x_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"X error: {e}")
            if progress:
                progress.end_x(len(x_items))

        if youtube_future:
            yt_timeout = timeouts.get("youtube_future", future_timeout)
            try:
                youtube_items, youtube_error = youtube_future.result(timeout=yt_timeout)
                if youtube_error and progress:
                    progress.show_error(f"YouTube error: {youtube_error}")
            except TimeoutError:
                youtube_error = f"YouTube search timed out after {yt_timeout}s"
                if progress:
                    progress.show_error(youtube_error)
            except Exception as e:
                youtube_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"YouTube error: {e}")
            if progress:
                progress.end_youtube(len(youtube_items))

        if tiktok_future:
            tk_timeout = timeouts.get("tiktok_future", future_timeout)
            try:
                tiktok_items, tiktok_error = tiktok_future.result(timeout=tk_timeout)
                if tiktok_error and progress:
                    progress.show_error(f"TikTok error: {tiktok_error}")
            except TimeoutError:
                tiktok_error = f"TikTok search timed out after {tk_timeout}s"
                if progress:
                    progress.show_error(tiktok_error)
            except Exception as e:
                tiktok_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"TikTok error: {e}")
            if progress:
                progress.end_tiktok(len(tiktok_items))

        if instagram_future:
            ig_timeout = timeouts.get("instagram_future", future_timeout)
            try:
                instagram_items, instagram_error = instagram_future.result(timeout=ig_timeout)
                if instagram_error and progress:
                    progress.show_error(f"Instagram error: {instagram_error}")
            except TimeoutError:
                instagram_error = f"Instagram search timed out after {ig_timeout}s"
                if progress:
                    progress.show_error(instagram_error)
            except Exception as e:
                instagram_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"Instagram error: {e}")
            if progress:
                progress.end_instagram(len(instagram_items))

        if xiaohongshu_future:
            try:
                xhs_items, xiaohongshu_error = xiaohongshu_future.result(timeout=future_timeout)
                web_items.extend(xhs_items)
                if xiaohongshu_error and progress:
                    progress.show_error(f"Xiaohongshu error: {xiaohongshu_error}")
            except TimeoutError:
                xiaohongshu_error = f"Xiaohongshu search timed out after {future_timeout}s"
                if progress:
                    progress.show_error(xiaohongshu_error)
            except Exception as e:
                xiaohongshu_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"Xiaohongshu error: {e}")

        if hackernews_future:
            hn_timeout = timeouts.get("hackernews_future", future_timeout)
            try:
                hackernews_items, hackernews_error = hackernews_future.result(timeout=hn_timeout)
                if hackernews_error and progress:
                    progress.show_error(f"HN error: {hackernews_error}")
            except TimeoutError:
                hackernews_error = f"HN search timed out after {hn_timeout}s"
                if progress:
                    progress.show_error(hackernews_error)
            except Exception as e:
                hackernews_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"HN error: {e}")
            if progress:
                progress.end_hackernews(len(hackernews_items))

        if bluesky_future:
            bsky_timeout = timeouts.get("bluesky_future", future_timeout)
            try:
                bluesky_items, bluesky_error = bluesky_future.result(timeout=bsky_timeout)
                if bluesky_error and progress:
                    progress.show_error(f"Bluesky error: {bluesky_error}")
            except TimeoutError:
                bluesky_error = f"Bluesky search timed out after {bsky_timeout}s"
                if progress:
                    progress.show_error(bluesky_error)
            except Exception as e:
                bluesky_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"Bluesky error: {e}")

        if truthsocial_future:
            ts_timeout = timeouts.get("truthsocial_future", future_timeout)
            try:
                truthsocial_items, truthsocial_error = truthsocial_future.result(timeout=ts_timeout)
                if truthsocial_error and progress:
                    progress.show_error(f"Truth Social error: {truthsocial_error}")
            except TimeoutError:
                truthsocial_error = f"Truth Social search timed out after {ts_timeout}s"
                if progress:
                    progress.show_error(truthsocial_error)
            except Exception as e:
                truthsocial_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"Truth Social error: {e}")

        if polymarket_future:
            pm_timeout = timeouts.get("polymarket_future", future_timeout)
            try:
                polymarket_items, polymarket_error = polymarket_future.result(timeout=pm_timeout)
                if polymarket_error and progress:
                    progress.show_error(f"Polymarket error: {polymarket_error}")
            except TimeoutError:
                polymarket_error = f"Polymarket search timed out after {pm_timeout}s"
                if progress:
                    progress.show_error(polymarket_error)
            except Exception as e:
                polymarket_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"Polymarket error: {e}")
            if progress:
                progress.end_polymarket(len(polymarket_items))

        if web_future:
            try:
                web_items, web_error = web_future.result(timeout=future_timeout)
                if web_error and progress:
                    progress.show_error(f"Web error: {web_error}")
            except TimeoutError:
                web_error = f"Web search timed out after {future_timeout}s"
                if progress:
                    progress.show_error(web_error)
            except Exception as e:
                web_error = f"{type(e).__name__}: {e}"
                if progress:
                    progress.show_error(f"Web error: {e}")
            sys.stderr.write(f"[web] {len(web_items)} results\n")
            sys.stderr.flush()

    # Enrich Reddit items with real data (parallel, capped)
    # Skip enrichment if ScrapeCreators already provided comments + engagement
    enrich_max = timeouts["enrich_max_items"]
    enrich_total_timeout = timeouts["enrich_total"]
    items_to_enrich = reddit_items[:enrich_max]
    rate_limited = False  # Set True if Reddit returns 429 during enrichment

    if reddit_used_sc and items_to_enrich:
        # ScrapeCreators already enriched items with comments — just copy to raw list
        sys.stderr.write(f"[Reddit] Skipping old enrichment — ScrapeCreators already provided comments\n")
        sys.stderr.flush()
        raw_reddit_enriched = list(reddit_items[:enrich_max])
        items_to_enrich = []  # Skip the enrichment block below

    if items_to_enrich:
        if progress:
            progress.start_reddit_enrich(1, len(items_to_enrich))

        if mock:
            # Sequential mock enrichment (fast, no need for parallelism)
            for i, item in enumerate(items_to_enrich):
                if progress and i > 0:
                    progress.update_reddit_enrich(i + 1, len(items_to_enrich))
                try:
                    mock_thread = load_fixture("reddit_thread_sample.json")
                    reddit_items[i] = reddit_enrich.enrich_reddit_item(item, mock_thread)
                except Exception as e:
                    if progress:
                        progress.show_error(f"Enrich failed for {item.get('url', 'unknown')}: {e}")
                raw_reddit_enriched.append(reddit_items[i])
        else:
            # Parallel enrichment with bounded concurrency and total timeout
            # Uses short HTTP timeout (10s) and 1 retry to fail fast on 429
            completed_count = 0
            rate_limited = False
            with ThreadPoolExecutor(max_workers=5) as enrich_pool:
                futures = {
                    enrich_pool.submit(reddit_enrich.enrich_reddit_item, item): i
                    for i, item in enumerate(items_to_enrich)
                }
                try:
                    for future in as_completed(futures, timeout=enrich_total_timeout):
                        idx = futures[future]
                        completed_count += 1
                        if progress:
                            progress.update_reddit_enrich(completed_count, len(items_to_enrich))
                        try:
                            reddit_items[idx] = future.result(timeout=timeouts["enrich_per"])
                        except reddit_enrich.RedditRateLimitError:
                            rate_limited = True
                            if progress:
                                progress.show_error(
                                    "Reddit rate-limited (429) — skipping remaining enrichment"
                                )
                            # Cancel remaining futures and bail
                            for f in futures:
                                f.cancel()
                            break
                        except Exception as e:
                            if progress:
                                progress.show_error(
                                    f"Enrich failed for {items_to_enrich[idx].get('url', 'unknown')}: {e}"
                                )
                        raw_reddit_enriched.append(reddit_items[idx])
                except TimeoutError:
                    if progress:
                        progress.show_error(
                            f"Enrichment timed out after {enrich_total_timeout}s "
                            f"({completed_count}/{len(items_to_enrich)} done)"
                        )
                    # Keep unenriched items as-is
                    for idx in futures.values():
                        if reddit_items[idx] not in raw_reddit_enriched:
                            raw_reddit_enriched.append(reddit_items[idx])

        if progress:
            progress.end_reddit_enrich()

    # Enrich HN stories with comments
    if hackernews_items:
        try:
            hackernews_items = hackernews.enrich_top_stories(hackernews_items, depth=depth)
        except Exception as e:
            sys.stderr.write(f"[HN] Enrichment error: {e}\n")
            sys.stderr.flush()

    # Phase 2: Supplemental search based on entities from Phase 1
    # Skip on --quick (speed matters), mock mode, or if Reddit is rate-limiting
    # Also skip Reddit supplemental when ScrapeCreators was used (subreddit drilling already done)
    if depth != "quick" and not mock and (reddit_items or x_items):
        sup_reddit, sup_x = _run_supplemental(
            topic, reddit_items, x_items,
            from_date, to_date, depth, x_source, progress,
            skip_reddit=(rate_limited or reddit_used_sc),
            resolved_handle=resolved_handle,
        )
        if sup_reddit:
            reddit_items.extend(sup_reddit)
        if sup_x:
            x_items.extend(sup_x)

    return reddit_items, x_items, youtube_items, tiktok_items, instagram_items, hackernews_items, bluesky_items, truthsocial_items, polymarket_items, web_items, web_needed, raw_openai, raw_xai, raw_reddit_enriched, reddit_error, x_error, youtube_error, tiktok_error, instagram_error, hackernews_error, bluesky_error, truthsocial_error, polymarket_error, web_error


def main():
    # Fix Unicode output on Windows (cp1252 can't encode emoji)
    if sys.platform == "win32":
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Research a topic from the last N days on Reddit + X"
    )
    parser.add_argument("topic", nargs="*", help="Topic to research")
    parser.add_argument("--mock", action="store_true", help="Use fixtures")
    parser.add_argument(
        "--emit",
        choices=["compact", "json", "md", "context", "path"],
        default="compact",
        help="Output mode",
    )
    parser.add_argument(
        "--sources",
        choices=["auto", "reddit", "x", "both"],
        default="auto",
        help="Source selection",
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Faster research with fewer sources (8-12 each)",
    )
    parser.add_argument(
        "--deep",
        action="store_true",
        help="Comprehensive research with more sources (50-70 Reddit, 40-60 X)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable verbose debug logging",
    )
    parser.add_argument(
        "--include-web",
        action="store_true",
        help="Include general web search alongside Reddit/X (lower weighted)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=30,
        choices=range(1, 31),
        metavar="N",
        help="Number of days to look back (1-30, default: 30)",
    )
    parser.add_argument(
        "--store",
        action="store_true",
        help="Persist findings to SQLite database (~/.local/share/last30days/research.db)",
    )
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Show source availability diagnostics and exit",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=None,
        metavar="SECS",
        help="Global timeout in seconds (default: 180, quick: 90, deep: 300)",
    )
    parser.add_argument(
        "--x-handle",
        type=str,
        default=None,
        metavar="HANDLE",
        help="Resolved X handle for topic entity (without @). Searched unfiltered in Phase 2.",
    )
    parser.add_argument(
        "--search",
        type=str,
        default=None,
        metavar="SOURCES",
        help=(
            "Comma-separated list of sources to run. "
            f"Valid: {', '.join(sorted(VALID_SEARCH_SOURCES))}. "
            "Example: --search reddit,hn  (default: all configured sources)"
        ),
    )
    parser.add_argument(
        "--no-native-web",
        action="store_true",
        default=False,
        help="Skip native web search backends (Parallel/Brave/OpenRouter). Use when the assistant has its own WebSearch tool.",
    )
    parser.add_argument(
        "--save-dir",
        type=str,
        default=None,
        metavar="DIR",
        help="Auto-save raw research output to DIR/{topic-slug}.md",
    )

    args = parser.parse_args()
    args.topic = " ".join(args.topic) if args.topic else None

    # Enable debug logging if requested
    if args.debug:
        os.environ["LAST30DAYS_DEBUG"] = "1"
        # Re-import http to pick up debug flag
        from lib import http as http_module
        http_module.DEBUG = True

    # Determine depth
    if args.quick and args.deep:
        print("Error: Cannot use both --quick and --deep", file=sys.stderr)
        sys.exit(1)
    elif args.quick:
        depth = "quick"
    elif args.deep:
        depth = "deep"
    else:
        depth = "default"

    # Install global timeout watchdog
    timeouts = TIMEOUT_PROFILES[depth]
    global_timeout = args.timeout or timeouts["global"]
    _install_global_timeout(global_timeout)

    # Load config
    config = env.get_config()

    # Inject .env credentials into Bird module before auth check
    bird_x.set_credentials(config.get('AUTH_TOKEN'), config.get('CT0'))

    # Auto-detect Bird (no prompts - just use it if available)
    x_source_status = env.get_x_source_status(config)
    x_source = x_source_status["source"]  # 'bird', 'xai', or None

    # Auto-detect yt-dlp for YouTube search
    has_ytdlp = env.is_ytdlp_available()

    # Auto-detect ScrapeCreators/Apify for TikTok
    has_tiktok = env.is_tiktok_available(config)

    # Auto-detect ScrapeCreators for Instagram
    has_instagram = env.is_instagram_available(config)

    # Auto-detect Xiaohongshu HTTP API (requires service + login)
    has_xiaohongshu = env.is_xiaohongshu_available(config)

    # Auto-detect Bluesky (requires BSKY_HANDLE + BSKY_APP_PASSWORD)
    has_bluesky = env.is_bluesky_available(config)

    # Auto-detect Truth Social (requires TRUTHSOCIAL_TOKEN)
    has_truthsocial = env.is_truthsocial_available(config)

    # --diagnose: show source availability and exit
    if args.diagnose:
        web_source = env.get_web_search_source(config)
        diag = {
            "openai": bool(config.get("OPENAI_API_KEY")),
            "reddit_public": True,
            "xai": bool(config.get("XAI_API_KEY")),
            "x_source": x_source_status["source"],
            "bird_installed": x_source_status["bird_installed"],
            "bird_authenticated": x_source_status["bird_authenticated"],
            "bird_username": x_source_status.get("bird_username"),
            "youtube": has_ytdlp,
            "tiktok": has_tiktok,
            "instagram": has_instagram,
            "xiaohongshu": has_xiaohongshu,
            "xiaohongshu_api_base": env.get_xiaohongshu_api_base(config),
            "hackernews": True,
            "bluesky": has_bluesky,
            "truthsocial": has_truthsocial,
            "polymarket": True,
            "web_search_backend": web_source,
            "parallel_ai": bool(config.get("PARALLEL_API_KEY")),
            "brave": bool(config.get("BRAVE_API_KEY")),
            "openrouter": bool(config.get("OPENROUTER_API_KEY")),
        }
        print(json.dumps(diag, indent=2))
        sys.exit(0)

    # Validate topic (--diagnose doesn't need one)
    if not args.topic:
        print("Error: Please provide a topic to research.", file=sys.stderr)
        print("Usage: python3 last30days.py <topic> [options]", file=sys.stderr)
        sys.exit(1)

    # Initialize progress display with topic
    progress = ui.ProgressDisplay(args.topic, show_banner=True)

    # Show diagnostic banner when sources are missing
    web_source = env.get_web_search_source(config)
    diag = {
        "openai": bool(config.get("OPENAI_API_KEY")),
        "reddit_public": True,
        "xai": bool(config.get("XAI_API_KEY")),
        "x_source": x_source_status["source"],
        "bird_installed": x_source_status["bird_installed"],
        "bird_authenticated": x_source_status["bird_authenticated"],
        "bird_username": x_source_status.get("bird_username"),
        "youtube": has_ytdlp,
        "tiktok": has_tiktok,
        "instagram": has_instagram,
        "xiaohongshu": has_xiaohongshu,
        "hackernews": True,
        "bluesky": True,
        "truthsocial": has_truthsocial,
        "polymarket": True,
        "web_search_backend": "deferred to assistant" if args.no_native_web else web_source,
    }
    ui.show_diagnostic_banner(diag)

    # Check available sources (accounting for Bird auto-detection)
    available = env.get_available_sources(config)

    # Override available if Bird or ScrapeCreators provides X
    if x_source in ('bird', 'scrapecreators'):
        if available == 'reddit':
            available = 'both'  # Now have both Reddit + X
        elif available == 'reddit-web':
            available = 'all'  # Reddit + X + Web
        elif available == 'web':
            available = 'x-web'  # X + Web

    # Mock mode can work without keys
    if args.mock:
        if args.sources == "auto":
            sources = "both"
        else:
            sources = args.sources
    else:
        # Validate requested sources against available
        sources, error = env.validate_sources(args.sources, available, args.include_web)
        if error:
            # If it's a warning about WebSearch fallback, print but continue
            if "WebSearch fallback" in error:
                print(f"Note: {error}", file=sys.stderr)
            else:
                print(f"Error: {error}", file=sys.stderr)
                sys.exit(1)

    # Get date range
    from_date, to_date = dates.get_date_range(args.days)

    # Check what keys are missing for promo messaging
    missing_keys = env.get_missing_keys(config)

    # Show NUX / promo for missing keys BEFORE research
    if missing_keys != 'none':
        progress.show_promo(missing_keys, diag=diag)

    # Select models
    if args.mock:
        # Use mock models
        mock_openai_models = load_fixture("models_openai_sample.json").get("data", [])
        mock_xai_models = load_fixture("models_xai_sample.json").get("data", [])
        selected_models = models.get_models(
            {
                "OPENAI_API_KEY": "mock",
                "XAI_API_KEY": "mock",
                **config,
            },
            mock_openai_models,
            mock_xai_models,
        )
    else:
        selected_models = models.get_models(config)

    # Determine mode string
    if sources == "all":
        mode = "all"  # reddit + x + web
    elif sources == "both":
        mode = "both"  # reddit + x
    elif sources == "reddit":
        mode = "reddit-only"
    elif sources == "reddit-web":
        mode = "reddit-web"
    elif sources == "x":
        mode = "x-only"
    elif sources == "x-web":
        mode = "x-web"
    elif sources == "web":
        mode = "web-only"
    else:
        mode = sources

    # Apply --search flag: restrict sources to the specified subset
    search_do_hackernews = True
    search_do_bluesky = has_bluesky
    search_do_truthsocial = has_truthsocial
    search_do_polymarket = True
    search_run_youtube = has_ytdlp
    search_run_tiktok = has_tiktok
    search_run_instagram = has_instagram
    search_run_xiaohongshu = has_xiaohongshu
    if args.search:
        search_sources = parse_search_flag(args.search)
        has_reddit = "reddit" in search_sources
        has_x = "x" in search_sources
        search_do_hackernews = "hn" in search_sources
        search_do_bluesky = ("bluesky" in search_sources or "bsky" in search_sources) and has_bluesky
        search_do_truthsocial = ("truthsocial" in search_sources or "truth" in search_sources) and has_truthsocial
        search_do_polymarket = "polymarket" in search_sources
        search_run_youtube = "youtube" in search_sources and has_ytdlp
        search_run_tiktok = "tiktok" in search_sources and has_tiktok
        search_run_instagram = "instagram" in search_sources and has_instagram
        # If explicitly requested, attempt Xiaohongshu even when preflight says unavailable.
        search_run_xiaohongshu = "xiaohongshu" in search_sources
        include_search_web = "web" in search_sources
        # Map to existing sources string
        if has_reddit and has_x:
            sources = "both" + ("-web" if include_search_web else "")
            sources = "all" if include_search_web else "both"
        elif has_reddit:
            sources = "reddit-web" if include_search_web else "reddit"
        elif has_x:
            sources = "x-web" if include_search_web else "x"
        else:
            sources = "web"  # hn/polymarket only; no Reddit/X

    # Run research
    reddit_items, x_items, youtube_items, tiktok_items, instagram_items, hackernews_items, bluesky_items, truthsocial_items, polymarket_items, web_items, web_needed, raw_openai, raw_xai, raw_reddit_enriched, reddit_error, x_error, youtube_error, tiktok_error, instagram_error, hackernews_error, bluesky_error, truthsocial_error, polymarket_error, web_error = run_research(
        args.topic,
        sources,
        config,
        selected_models,
        from_date,
        to_date,
        depth,
        args.mock,
        progress,
        x_source=x_source or "xai",
        run_youtube=search_run_youtube,
        run_tiktok=search_run_tiktok,
        run_instagram=search_run_instagram,
        run_xiaohongshu=search_run_xiaohongshu,
        timeouts=timeouts,
        resolved_handle=args.x_handle,
        do_hackernews=search_do_hackernews,
        do_bluesky=search_do_bluesky,
        do_truthsocial=search_do_truthsocial,
        do_polymarket=search_do_polymarket,
        no_native_web=args.no_native_web,
    )

    # Processing phase
    progress.start_processing()

    # Normalize items
    normalized_reddit = normalize.normalize_reddit_items(reddit_items, from_date, to_date)
    normalized_x = normalize.normalize_x_items(x_items, from_date, to_date)
    normalized_youtube = normalize.normalize_youtube_items(youtube_items, from_date, to_date) if youtube_items else []
    normalized_tiktok = normalize.normalize_tiktok_items(tiktok_items, from_date, to_date) if tiktok_items else []
    normalized_ig = normalize.normalize_instagram_items(instagram_items, from_date, to_date) if instagram_items else []
    normalized_hn = normalize.normalize_hackernews_items(hackernews_items, from_date, to_date) if hackernews_items else []
    normalized_bsky = normalize.normalize_bluesky_items(bluesky_items, from_date, to_date) if bluesky_items else []
    normalized_ts = normalize.normalize_truthsocial_items(truthsocial_items, from_date, to_date) if truthsocial_items else []
    normalized_pm = normalize.normalize_polymarket_items(polymarket_items, from_date, to_date) if polymarket_items else []
    normalized_web = websearch.normalize_websearch_items(web_items, from_date, to_date) if web_items else []

    # Hard date filter: exclude items with verified dates outside the range
    # This is the safety net - even if prompts let old content through, this filters it
    filtered_reddit = normalize.filter_by_date_range(normalized_reddit, from_date, to_date)
    filtered_x = normalize.filter_by_date_range(normalized_x, from_date, to_date)
    # YouTube: skip hard date filter — youtube_yt.py already applies a soft filter
    # that prefers recent videos but keeps older ones for evergreen topics.
    # YouTube content has a longer shelf life than tweets/posts.
    filtered_youtube = normalized_youtube
    # TikTok: hard date filter (tiktok.py already pre-filters, but safety net)
    filtered_tiktok = normalize.filter_by_date_range(normalized_tiktok, from_date, to_date) if normalized_tiktok else []
    # Instagram: hard date filter (instagram.py already pre-filters, but safety net)
    filtered_ig = normalize.filter_by_date_range(normalized_ig, from_date, to_date) if normalized_ig else []
    filtered_hn = normalize.filter_by_date_range(normalized_hn, from_date, to_date) if normalized_hn else []
    filtered_bsky = normalize.filter_by_date_range(normalized_bsky, from_date, to_date) if normalized_bsky else []
    filtered_ts = normalize.filter_by_date_range(normalized_ts, from_date, to_date) if normalized_ts else []
    # Polymarket: skip hard date filter - markets are active/traded, updatedAt is fine
    filtered_pm = normalized_pm
    filtered_web = normalize.filter_by_date_range(normalized_web, from_date, to_date) if normalized_web else []

    # Score items
    scored_reddit = score.score_reddit_items(filtered_reddit)
    scored_x = score.score_x_items(filtered_x)
    scored_youtube = score.score_youtube_items(filtered_youtube) if filtered_youtube else []
    scored_tiktok = score.score_tiktok_items(filtered_tiktok) if filtered_tiktok else []
    scored_ig = score.score_instagram_items(filtered_ig) if filtered_ig else []
    scored_hn = score.score_hackernews_items(filtered_hn) if filtered_hn else []
    scored_bsky = score.score_bluesky_items(filtered_bsky) if filtered_bsky else []
    scored_ts = score.score_truthsocial_items(filtered_ts) if filtered_ts else []
    scored_pm = score.score_polymarket_items(filtered_pm) if filtered_pm else []
    scored_web = score.score_websearch_items(filtered_web) if filtered_web else []

    # Sort items
    sorted_reddit = score.sort_items(scored_reddit)
    sorted_x = score.sort_items(scored_x)
    sorted_youtube = score.sort_items(scored_youtube) if scored_youtube else []
    sorted_tiktok = score.sort_items(scored_tiktok) if scored_tiktok else []
    sorted_ig = score.sort_items(scored_ig) if scored_ig else []
    sorted_hn = score.sort_items(scored_hn) if scored_hn else []
    sorted_bsky = score.sort_items(scored_bsky) if scored_bsky else []
    sorted_ts = score.sort_items(scored_ts) if scored_ts else []
    sorted_pm = score.sort_items(scored_pm) if scored_pm else []
    sorted_web = score.sort_items(scored_web) if scored_web else []

    # Dedupe items
    deduped_reddit = dedupe.dedupe_reddit(sorted_reddit)
    deduped_x = dedupe.dedupe_x(sorted_x)
    deduped_youtube = dedupe.dedupe_youtube(sorted_youtube) if sorted_youtube else []
    deduped_tiktok = dedupe.dedupe_tiktok(sorted_tiktok) if sorted_tiktok else []
    deduped_ig = dedupe.dedupe_instagram(sorted_ig) if sorted_ig else []
    deduped_hn = dedupe.dedupe_hackernews(sorted_hn) if sorted_hn else []
    deduped_bsky = dedupe.dedupe_bluesky(sorted_bsky) if sorted_bsky else []
    deduped_ts = dedupe.dedupe_truthsocial(sorted_ts) if sorted_ts else []
    deduped_pm = dedupe.dedupe_polymarket(sorted_pm) if sorted_pm else []
    deduped_web = websearch.dedupe_websearch(sorted_web) if sorted_web else []

    # Minimum result guarantee: if all Reddit results were filtered out but
    # we had raw results, keep top 3 by relevance regardless of score
    if not deduped_reddit and normalized_reddit:
        print("[REDDIT WARNING] All results scored below threshold, keeping top 3 by relevance", file=sys.stderr)
        by_relevance = sorted(normalized_reddit, key=lambda item: item.relevance, reverse=True)
        deduped_reddit = by_relevance[:3]

    # Cross-source linking: annotate items that discuss the same story
    dedupe.cross_source_link(
        deduped_reddit, deduped_x, deduped_youtube, deduped_tiktok, deduped_ig, deduped_hn, deduped_bsky, deduped_ts, deduped_pm, deduped_web,
    )

    progress.end_processing()

    # Create report
    report = schema.create_report(
        args.topic,
        from_date,
        to_date,
        mode,
        selected_models.get("openai"),
        selected_models.get("xai"),
    )
    report.reddit = deduped_reddit
    report.x = deduped_x
    report.youtube = deduped_youtube
    report.tiktok = deduped_tiktok
    report.instagram = deduped_ig
    report.hackernews = deduped_hn
    report.bluesky = deduped_bsky
    report.truthsocial = deduped_ts
    report.polymarket = deduped_pm
    report.web = deduped_web
    report.reddit_error = reddit_error
    report.x_error = x_error
    report.youtube_error = youtube_error
    report.tiktok_error = tiktok_error
    report.instagram_error = instagram_error
    report.hackernews_error = hackernews_error
    report.bluesky_error = bluesky_error
    report.truthsocial_error = truthsocial_error
    report.polymarket_error = polymarket_error
    report.web_error = web_error
    report.resolved_x_handle = args.x_handle

    # Generate context snippet
    report.context_snippet_md = render.render_context_snippet(report)

    # Write outputs
    render.write_outputs(report, raw_openai, raw_xai, raw_reddit_enriched)

    # Show completion
    if sources == "web":
        progress.show_web_only_complete()
    else:
        progress.show_complete(len(deduped_reddit), len(deduped_x), len(deduped_youtube), len(deduped_hn), len(deduped_pm), len(deduped_tiktok), len(deduped_ig))

    # Build source info for status footer
    source_info = {}
    if not x_source:
        if x_source_status["bird_installed"]:
            source_info["x_skip_reason"] = "Bird installed but not authenticated — log into x.com in browser"
        else:
            source_info["x_skip_reason"] = "No Bird CLI, XAI_API_KEY, or SCRAPECREATORS_API_KEY"
    if not has_ytdlp:
        source_info["youtube_skip_reason"] = "yt-dlp not installed — fix: brew install yt-dlp"
    elif has_ytdlp and not report.youtube:
        source_info["youtube_skip_reason"] = "0 results (query may be too specific)"
    if not has_tiktok:
        source_info["tiktok_skip_reason"] = "No SCRAPECREATORS_API_KEY - sign up at scrapecreators.com (100 free credits)"
    if not has_instagram:
        source_info["instagram_skip_reason"] = "No SCRAPECREATORS_API_KEY - sign up at scrapecreators.com (100 free credits)"
    if not has_xiaohongshu:
        source_info["xiaohongshu_skip_reason"] = (
            f"Xiaohongshu API unavailable or not logged in - start xiaohongshu-mcp and login "
            f"(base: {env.get_xiaohongshu_api_base(config)})"
        )
    if not web_source:
        source_info["web_skip_reason"] = "assistant will use WebSearch (add BRAVE_API_KEY for native search)"

    # Output result
    output_result(report, args.emit, web_needed, args.topic, from_date, to_date, missing_keys, args.days, source_info)

    # Auto-save raw research to file if --save-dir is set
    if args.save_dir:
        import re
        save_dir = Path(args.save_dir).expanduser()
        save_dir.mkdir(parents=True, exist_ok=True)
        slug = re.sub(r'[^a-z0-9]+', '-', args.topic.lower()).strip('-')[:60]
        save_path = save_dir / f"{slug}-raw.md"
        if save_path.exists():
            save_path = save_dir / f"{slug}-raw-{datetime.now().strftime('%Y-%m-%d')}.md"
        content = render.render_compact(report, missing_keys=missing_keys)
        content += "\n" + render.render_source_status(report, source_info)
        save_path.write_text(content, encoding="utf-8")
        print(f"📎 {save_path}", file=sys.stderr)

    # Persist findings to SQLite if requested
    if args.store:
        import store as store_mod
        store_mod.init_db()
        topic_row = store_mod.add_topic(args.topic)
        topic_id = topic_row["id"]
        run_id = store_mod.record_run(topic_id, source_mode=mode, status="completed")

        findings = []
        for item in deduped_reddit:
            findings.append({
                "source": "reddit",
                "url": item.url,
                "title": item.title,
                "author": item.subreddit,
                "content": item.title,
                "engagement_score": item.engagement.score if item.engagement else 0,
                "relevance_score": item.relevance,
            })
        for item in deduped_x:
            findings.append({
                "source": "x",
                "url": item.url,
                "title": item.text[:100],
                "author": item.author_handle,
                "content": item.text,
                "engagement_score": item.engagement.likes if item.engagement else 0,
                "relevance_score": item.relevance,
            })
        for item in deduped_youtube:
            findings.append({
                "source": "youtube",
                "url": item.url,
                "title": item.title,
                "author": item.channel_name,
                "content": item.transcript_snippet[:500] if item.transcript_snippet else item.title,
                "engagement_score": item.engagement.views if item.engagement and item.engagement.views else 0,
                "relevance_score": item.relevance,
            })
        for item in deduped_hn:
            findings.append({
                "source": "hackernews",
                "url": item.hn_url,
                "title": item.title,
                "author": item.author,
                "content": item.title,
                "engagement_score": item.engagement.score if item.engagement else 0,
                "relevance_score": item.relevance,
            })
        for item in deduped_bsky:
            findings.append({
                "source": "bluesky",
                "url": item.url,
                "title": item.text[:100],
                "author": item.author_handle,
                "content": item.text,
                "engagement_score": item.engagement.likes if item.engagement else 0,
                "relevance_score": item.relevance,
            })
        for item in deduped_pm:
            findings.append({
                "source": "polymarket",
                "url": item.url,
                "title": item.question,
                "author": "polymarket",
                "content": item.title,
                "engagement_score": item.engagement.volume if item.engagement and item.engagement.volume else 0,
                "relevance_score": item.relevance,
            })
        for item in deduped_ig:
            findings.append({
                "source": "instagram",
                "url": item.url,
                "title": item.text[:100],
                "author": item.author_name,
                "content": item.caption_snippet[:500] if item.caption_snippet else item.text,
                "engagement_score": item.engagement.views if item.engagement and item.engagement.views else 0,
                "relevance_score": item.relevance,
            })
        for item in deduped_web:
            findings.append({
                "source": "web",
                "url": item.url,
                "title": item.title,
                "author": item.source_domain,
                "content": item.snippet,
                "engagement_score": 0,
                "relevance_score": item.relevance,
            })

        counts = store_mod.store_findings(run_id, topic_id, findings)
        store_mod.update_run(
            run_id,
            status="completed",
            findings_new=counts["new"],
            findings_updated=counts["updated"],
        )
        sys.stderr.write(
            f"[store] Saved {counts['new']} new, {counts['updated']} updated findings\n"
        )
        sys.stderr.flush()


def output_result(
    report: schema.Report,
    emit_mode: str,
    web_needed: bool = False,
    topic: str = "",
    from_date: str = "",
    to_date: str = "",
    missing_keys: str = "none",
    days: int = 30,
    source_info: dict = None,
):
    """Output the result based on emit mode."""
    if emit_mode == "compact":
        print(render.render_compact(report, missing_keys=missing_keys))
        # Append source status footer
        print(render.render_source_status(report, source_info))
    elif emit_mode == "json":
        print(json.dumps(report.to_dict(), indent=2))
    elif emit_mode == "md":
        print(render.render_full_report(report))
    elif emit_mode == "context":
        print(report.context_snippet_md)
    elif emit_mode == "path":
        print(render.get_context_path())

    # Output WebSearch instructions if needed
    if web_needed:
        print("\n" + "="*60)
        print("### WEBSEARCH REQUIRED ###")
        print("="*60)
        print(f"Topic: {topic}")
        print(f"Date range: {from_date} to {to_date}")
        print("")
        print("Assistant: Use your web search tool to find 8-15 relevant web pages.")
        print("EXCLUDE: reddit.com, x.com, twitter.com (already covered above)")
        print(f"INCLUDE: blogs, docs, news, tutorials from the last {days} days")
        print("")
        print("After searching, synthesize WebSearch results WITH the Reddit/X")
        print("results above. WebSearch items should rank LOWER than comparable")
        print("Reddit/X items (they lack engagement metrics).")
        print("="*60)


if __name__ == "__main__":
    main()
