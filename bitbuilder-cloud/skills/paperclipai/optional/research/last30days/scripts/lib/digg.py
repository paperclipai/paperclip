"""Digg AI 1000 source for last30days.

Shells out to ``digg-pp-cli`` (read-only, no auth required) to surface
clustered stories curated from ~1000 high-signal AI accounts on X. Each
cluster carries a published TLDR, a curatorial rank, and a list of X
posts that can be fetched as inline quotes.

Activation gate: this source is only available when ``digg-pp-cli`` is
on PATH. ``pipeline.available_sources`` checks ``shutil.which`` before
including ``digg`` in the source list. The functions below also detect
the missing-binary case as a defensive fallback.

Primary path: ``digg-pp-cli search <topic> --since 30d --agent --limit N``.
Optional enrichment: ``digg-pp-cli posts <clusterUrlId> --agent --by rank
--limit M`` for the top K clusters in default/deep depth, attaching the
top-ranked X posts to each cluster's ``posts`` field.
"""

from __future__ import annotations

import json
import shutil
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from . import log, subproc
from .relevance import token_overlap_relevance


CLI_BIN = "digg-pp-cli"

# Per-depth knobs.
DEPTH_CONFIG = {
    "quick": 8,
    "default": 20,
    "deep": 40,
}

# How many top-ranked clusters get post enrichment, per depth. Quick mode
# skips enrichment to keep latency low (clusters already carry a TLDR).
ENRICH_CONFIG = {
    "quick": 0,
    "default": 3,
    "deep": 5,
}

# X posts pulled per enriched cluster. Matches the 5-comment cap used by
# Reddit/HN/YouTube/TikTok/GitHub enrichment.
POSTS_PER_CLUSTER = 5

SEARCH_TIMEOUT = 30
POSTS_TIMEOUT = 15


def _log(msg: str) -> None:
    log.source_log("Digg", msg)


def _is_available() -> bool:
    """True when the digg-pp-cli binary is on PATH."""
    return shutil.which(CLI_BIN) is not None


def _today() -> datetime:
    return datetime.now(timezone.utc)


def _parse_first_post_age(age: Optional[str], today: Optional[datetime] = None) -> Optional[str]:
    """Convert a digg firstPostAge token (e.g. '5d', '17d', '5h', '1w', '1m')
    into a YYYY-MM-DD string. Returns None when the value is outside the
    last-30-day window or cannot be parsed.

    Digg uses minutes-symbol-collision for 'months' (per agent-context:
    'Nh, Nd, Nw, Nm (e.g. 30d, 1w, 12h, 1m)'), so 'Nm' is months ~30 days.
    """
    if not age or not isinstance(age, str):
        return None
    age = age.strip().lower()
    if len(age) < 2:
        return None
    unit = age[-1]
    try:
        amount = int(age[:-1])
    except (ValueError, TypeError):
        return None
    if amount < 0:
        return None

    base = today or _today()

    if unit == "h":
        delta = timedelta(hours=amount)
    elif unit == "d":
        delta = timedelta(days=amount)
    elif unit == "w":
        delta = timedelta(weeks=amount)
    elif unit == "m":
        delta = timedelta(days=amount * 30)
    else:
        return None

    if delta > timedelta(days=30):
        return None

    point = base - delta
    return point.date().isoformat()


def _build_search_args(query: str, limit: int) -> List[str]:
    return [
        CLI_BIN,
        "search",
        query,
        "--since",
        "30d",
        "--agent",
        "--limit",
        str(limit),
    ]


def _build_posts_args(cluster_url_id: str, posts_per: int) -> List[str]:
    return [
        CLI_BIN,
        "posts",
        cluster_url_id,
        "--agent",
        "--by",
        "rank",
        "--limit",
        str(posts_per),
    ]


def _run_cli(cmd: List[str], timeout: int) -> Dict[str, Any]:
    """Invoke digg-pp-cli and parse the JSON envelope.

    Returns ``{"results": [...]}`` on success, ``{"results": [], "error": "..."}``
    on failure. Never raises; the pipeline relies on shape consistency.
    """
    if not _is_available():
        return {"results": [], "error": f"{CLI_BIN} not on PATH"}
    try:
        result = subproc.run_with_timeout(cmd, timeout=timeout)
    except subproc.SubprocTimeout as exc:
        _log(f"Timeout: {exc}")
        return {"results": [], "error": str(exc)}
    except FileNotFoundError as exc:
        _log(f"Binary missing: {exc}")
        return {"results": [], "error": str(exc)}
    except OSError as exc:
        _log(f"Spawn failed: {exc}")
        return {"results": [], "error": str(exc)}

    if result.returncode != 0:
        snippet = (result.stderr or "").strip().splitlines()[:1]
        first = snippet[0] if snippet else f"exit {result.returncode}"
        _log(f"CLI exit {result.returncode}: {first}")
        return {"results": [], "error": first}

    stdout = result.stdout or ""
    if not stdout.strip():
        return {"results": []}
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        _log(f"JSON decode failed: {exc}")
        return {"results": [], "error": f"json decode: {exc}"}

    if not isinstance(data, dict):
        return {"results": []}
    results = data.get("results")
    if not isinstance(results, list):
        return {"results": []}
    return data


def search_digg(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
) -> Dict[str, Any]:
    """Search Digg AI 1000 clusters via digg-pp-cli.

    Args:
        topic: search query.
        from_date: YYYY-MM-DD start (advisory; --since 30d is the actual filter).
        to_date: YYYY-MM-DD end (advisory; same).
        depth: 'quick' | 'default' | 'deep'.

    Returns:
        Dict with ``results`` list. On failure, ``results`` is empty and an
        ``error`` key carries a one-line description.
    """
    limit = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    if not topic or not topic.strip():
        return {"results": []}
    cmd = _build_search_args(topic, limit)
    _log(f"search '{topic}' (limit={limit}, since=30d)")
    response = _run_cli(cmd, timeout=SEARCH_TIMEOUT)
    n = len(response.get("results") or [])
    _log(f"found {n} clusters")
    return response


def _build_url(cluster_url_id: str) -> str:
    return f"https://di.gg/ai/{cluster_url_id}"


def _rank_score(rank: Optional[int]) -> float:
    """Convert Digg rank (lower is better, top 50 are notable) into a
    positive engagement-style signal in [0, 50]. Anything off the top-50
    leaderboard contributes 0.
    """
    if rank is None:
        return 0.0
    try:
        r = int(rank)
    except (TypeError, ValueError):
        return 0.0
    if r < 1 or r > 50:
        return 0.0
    return float(51 - r)


def parse_digg_response(
    response: Dict[str, Any],
    query: str = "",
) -> List[Dict[str, Any]]:
    """Parse a digg search envelope into normalized item dicts.

    Args:
        response: payload from ``search_digg``.
        query: original search query, used for token-overlap relevance.

    Returns:
        List of dicts ready for ``normalize._normalize_digg``.
    """
    raw = response.get("results") if isinstance(response, dict) else None
    if not isinstance(raw, list):
        return []

    items: List[Dict[str, Any]] = []
    for i, cluster in enumerate(raw):
        if not isinstance(cluster, dict):
            continue
        cluster_url_id = cluster.get("clusterUrlId")
        if not cluster_url_id:
            continue

        title = str(cluster.get("title") or "").strip()
        tldr = str(cluster.get("tldr") or "").strip()
        rank = cluster.get("rank")
        post_count = cluster.get("postCount") or 0
        unique_authors = cluster.get("uniqueAuthors") or 0
        first_post_age = cluster.get("firstPostAge")
        date_str = _parse_first_post_age(first_post_age)
        if date_str is None and first_post_age:
            # firstPostAge present but outside 30d -> drop; last30days contract.
            continue

        rank_decay = max(0.3, 1.0 - (i * 0.02))
        if query:
            content_score = token_overlap_relevance(query, f"{title} {tldr}".strip())
        else:
            content_score = 0.5
        rank_boost = min(0.2, _rank_score(rank) / 250.0)
        relevance = min(1.0, 0.55 * rank_decay + 0.35 * content_score + rank_boost)

        items.append(
            {
                "id": str(cluster_url_id),
                "title": title or f"Digg cluster {i + 1}",
                "url": _build_url(str(cluster_url_id)),
                "tldr": tldr,
                "author": "",
                "date": date_str,
                "engagement": {
                    "postCount": int(post_count) if isinstance(post_count, (int, float)) else 0,
                    "uniqueAuthors": int(unique_authors) if isinstance(unique_authors, (int, float)) else 0,
                    "rank": int(rank) if isinstance(rank, (int, float)) else None,
                    "rank_score": _rank_score(rank),
                },
                "first_post_age": first_post_age,
                "posts": [],
                "relevance": round(relevance, 2),
                "why_relevant": (
                    f"Digg cluster (rank {rank}, {post_count} posts, {unique_authors} authors)"
                    if rank is not None
                    else f"Digg cluster ({post_count} posts, {unique_authors} authors)"
                ),
            }
        )

    return items


def _parse_post(raw_post: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Reduce a digg post payload into the small dict render uses.

    We deliberately keep this minimal: an inline quote needs the author
    handle, the body, the post type, and the X URL.
    """
    if not isinstance(raw_post, dict):
        return None
    body = str(raw_post.get("body") or "").strip()
    if not body:
        return None
    author = raw_post.get("author") or {}
    if not isinstance(author, dict):
        author = {}
    username = str(author.get("username") or "").strip()
    if not username:
        return None
    x_url = str(raw_post.get("xUrl") or "").strip()
    if not x_url:
        return None
    return {
        "username": username,
        "display_name": str(author.get("display_name") or "").strip() or username,
        "category": str(author.get("category") or "").strip(),
        "rank": author.get("rank"),
        "body": body,
        "post_type": str(raw_post.get("post_type") or "tweet").strip(),
        "x_url": x_url,
        "posted_at": raw_post.get("posted_at"),
    }


def fetch_top_posts(cluster_url_id: str, posts_per: int = POSTS_PER_CLUSTER) -> List[Dict[str, Any]]:
    """Fetch top-ranked X posts attached to a cluster.

    Returns an empty list on any failure (timeout, missing cluster, JSON
    error). Never raises.
    """
    if posts_per <= 0:
        return []
    cmd = _build_posts_args(cluster_url_id, posts_per)
    response = _run_cli(cmd, timeout=POSTS_TIMEOUT)
    raw = response.get("results") or []
    out: List[Dict[str, Any]] = []
    for entry in raw:
        post = _parse_post(entry)
        if post is not None:
            out.append(post)
    return out


def enrich_with_top_posts(
    items: List[Dict[str, Any]],
    top_k: int = 3,
    posts_per: int = POSTS_PER_CLUSTER,
) -> List[Dict[str, Any]]:
    """Attach top X posts to the first ``top_k`` clusters by Digg rank order.

    Mutates and returns the same list. Items that already have posts, or
    whose ``postCount`` is 0, are skipped.
    """
    if top_k <= 0 or posts_per <= 0:
        return items
    enriched = 0
    for item in items:
        if enriched >= top_k:
            break
        if item.get("posts"):
            continue
        engagement = item.get("engagement") or {}
        if not engagement.get("postCount"):
            continue
        cluster_url_id = item.get("id")
        if not cluster_url_id:
            continue
        posts = fetch_top_posts(str(cluster_url_id), posts_per=posts_per)
        item["posts"] = posts
        enriched += 1
    if enriched:
        _log(f"enriched {enriched} clusters with X posts")
    return items


def enrich_source_items(items: list, top_k: int = 3, posts_per: int = POSTS_PER_CLUSTER) -> list:
    """Attach top X posts to the first ``top_k`` SourceItems that survived dedupe.

    Reads ``metadata['clusterUrlId']`` and writes ``metadata['posts']`` in
    place. Skips items that already carry a non-empty ``metadata['posts']``,
    items whose engagement ``postCount`` is 0, and items whose source is not
    'digg'. Designed to run from `_finalize_items_by_source` so enrichment
    is spent on the items the brief actually shows.
    """
    if top_k <= 0 or posts_per <= 0:
        return items
    enriched = 0
    for item in items:
        if enriched >= top_k:
            break
        if getattr(item, "source", None) != "digg":
            continue
        metadata = getattr(item, "metadata", None) or {}
        if metadata.get("posts"):
            continue
        engagement = getattr(item, "engagement", None) or {}
        if not engagement.get("postCount"):
            continue
        cluster_url_id = metadata.get("clusterUrlId") or item.item_id
        if not cluster_url_id:
            continue
        posts = fetch_top_posts(str(cluster_url_id), posts_per=posts_per)
        if posts:
            metadata["posts"] = posts
            enriched += 1
    if enriched:
        _log(f"post-dedupe enriched {enriched} clusters with X posts")
    return items
