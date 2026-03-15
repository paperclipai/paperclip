"""Polymarket prediction market search via Gamma API (free, no auth required).

Uses gamma-api.polymarket.com for event/market discovery.
No API key needed - public read-only API with generous rate limits (350 req/10s).
"""

import json
import math
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus, urlencode

from . import http

GAMMA_SEARCH_URL = "https://gamma-api.polymarket.com/public-search"

# Pages to fetch per query (API returns 5 events per page, limit param is a no-op)
DEPTH_CONFIG = {
    "quick": 1,
    "default": 3,
    "deep": 4,
}

# Max events to return after merge + dedup + re-ranking
RESULT_CAP = {
    "quick": 5,
    "default": 15,
    "deep": 25,
}


def _log(msg: str):
    """Log to stderr (only in TTY mode to avoid cluttering Claude Code output)."""
    if sys.stderr.isatty():
        sys.stderr.write(f"[PM] {msg}\n")
        sys.stderr.flush()


def _extract_core_subject(topic: str) -> str:
    """Extract core subject from topic string.

    Strips common prefixes like 'last 7 days', 'what are people saying about', etc.
    """
    topic = topic.strip()
    # Remove common leading phrases
    prefixes = [
        r"^last \d+ days?\s+",
        r"^what(?:'s| is| are) (?:people saying about|happening with|going on with)\s+",
        r"^how (?:is|are)\s+",
        r"^tell me about\s+",
        r"^research\s+",
    ]
    for pattern in prefixes:
        topic = re.sub(pattern, "", topic, flags=re.IGNORECASE)
    return topic.strip()


def _expand_queries(topic: str) -> List[str]:
    """Generate search queries to cast a wider net.

    Strategy:
    - Always include the core subject
    - Add ALL individual words as standalone searches (not just first)
    - Include the full topic if different from core
    - Cap at 6 queries, dedupe
    """
    core = _extract_core_subject(topic)
    queries = [core]

    # Add ALL individual words as separate queries
    words = core.split()
    if len(words) >= 2:
        for word in words:
            if len(word) > 1:  # skip single-char words
                queries.append(word)

    # Add the full topic if different from core
    if topic.lower().strip() != core.lower():
        queries.append(topic.strip())

    # Dedupe while preserving order, cap at 6
    seen = set()
    unique = []
    for q in queries:
        q_lower = q.lower().strip()
        if q_lower and q_lower not in seen:
            seen.add(q_lower)
            unique.append(q.strip())
    return unique[:6]


_GENERIC_TAGS = frozenset({"sports", "politics", "crypto", "science", "culture", "pop culture"})


def _extract_domain_queries(topic: str, events: List[Dict]) -> List[str]:
    """Extract domain-indicator search terms from first-pass event tags.

    Uses structured tag metadata from Gamma API events to discover broader
    domain categories (e.g., 'NCAA CBB' from a Big 12 basketball event).
    Falls back to frequent title bigrams if no useful tags exist.
    """
    query_words = set(_extract_core_subject(topic).lower().split())

    # Collect tag labels from all first-pass events, count occurrences
    tag_counts: Dict[str, int] = {}
    for event in events:
        tags = event.get("tags") or []
        for tag in tags:
            label = tag.get("label", "") if isinstance(tag, dict) else str(tag)
            if not label:
                continue
            label_lower = label.lower()
            # Skip generic category tags and tags matching existing queries
            if label_lower in _GENERIC_TAGS:
                continue
            if label_lower in query_words:
                continue
            tag_counts[label] = tag_counts.get(label, 0) + 1

    # Sort by frequency, take top 2 that appear in 2+ events
    domain_queries = [
        label for label, count in sorted(tag_counts.items(), key=lambda x: -x[1])
        if count >= 2
    ][:2]

    return domain_queries


def _search_single_query(query: str, page: int = 1) -> Dict[str, Any]:
    """Run a single search query against Gamma API."""
    params = {"q": query, "page": str(page)}
    url = f"{GAMMA_SEARCH_URL}?{urlencode(params)}"

    try:
        response = http.request("GET", url, timeout=15, retries=2)
        return response
    except http.HTTPError as e:
        _log(f"Search failed for '{query}' page {page}: {e}")
        return {"events": [], "error": str(e)}
    except Exception as e:
        _log(f"Search failed for '{query}' page {page}: {e}")
        return {"events": [], "error": str(e)}


def _run_queries_parallel(
    queries: List[str], pages: int, all_events: Dict, errors: List, start_idx: int = 0,
) -> None:
    """Run (query, page) combinations in parallel, merging into all_events."""
    with ThreadPoolExecutor(max_workers=min(8, len(queries) * pages)) as executor:
        futures = {}
        for i, q in enumerate(queries, start=start_idx):
            for p in range(1, pages + 1):
                future = executor.submit(_search_single_query, q, p)
                futures[future] = i

        for future in as_completed(futures):
            query_idx = futures[future]
            try:
                response = future.result(timeout=15)
                if response.get("error"):
                    errors.append(response["error"])

                events = response.get("events", [])
                for event in events:
                    event_id = event.get("id", "")
                    if not event_id:
                        continue
                    if event_id not in all_events:
                        all_events[event_id] = (event, query_idx)
                    elif query_idx < all_events[event_id][1]:
                        all_events[event_id] = (event, query_idx)
            except Exception as e:
                errors.append(str(e))


def search_polymarket(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
) -> Dict[str, Any]:
    """Search Polymarket via Gamma API with two-pass query expansion.

    Pass 1: Run expanded queries in parallel, merge and dedupe by event ID.
    Pass 2: Extract domain-indicator terms from first-pass titles, search those.

    Args:
        topic: Search topic
        from_date: Start date (YYYY-MM-DD) - used for activity filtering
        to_date: End date (YYYY-MM-DD)
        depth: 'quick', 'default', or 'deep'

    Returns:
        Dict with 'events' list and optional 'error'.
    """
    pages = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    cap = RESULT_CAP.get(depth, RESULT_CAP["default"])
    queries = _expand_queries(topic)

    _log(f"Searching for '{topic}' with queries: {queries} (pages={pages})")

    # Pass 1: run expanded queries in parallel
    all_events: Dict[str, tuple] = {}
    errors: List[str] = []
    _run_queries_parallel(queries, pages, all_events, errors)

    # Pass 2: extract domain-indicator terms from first-pass titles and search
    first_pass_events = [ev for ev, _ in all_events.values()]
    domain_queries = _extract_domain_queries(topic, first_pass_events)
    # Filter out queries we already ran
    seen_queries = {q.lower() for q in queries}
    domain_queries = [dq for dq in domain_queries if dq.lower() not in seen_queries]

    if domain_queries:
        _log(f"Domain expansion queries: {domain_queries}")
        _run_queries_parallel(domain_queries, 1, all_events, errors, start_idx=len(queries))

    merged_events = [ev for ev, _ in sorted(all_events.values(), key=lambda x: x[1])]
    total_queries = len(queries) + len(domain_queries)
    _log(f"Found {len(merged_events)} unique events across {total_queries} queries")

    result = {"events": merged_events, "_cap": cap}
    if errors and not merged_events:
        result["error"] = "; ".join(errors[:2])
    return result


def _format_price_movement(market: Dict[str, Any]) -> Optional[str]:
    """Pick the most significant price change and format it.

    Returns string like 'down 11.7% this month' or None if no significant change.
    """
    changes = [
        (abs(market.get("oneDayPriceChange") or 0), market.get("oneDayPriceChange"), "today"),
        (abs(market.get("oneWeekPriceChange") or 0), market.get("oneWeekPriceChange"), "this week"),
        (abs(market.get("oneMonthPriceChange") or 0), market.get("oneMonthPriceChange"), "this month"),
    ]

    # Pick the largest absolute change
    changes.sort(key=lambda x: x[0], reverse=True)
    abs_change, raw_change, period = changes[0]

    # Skip if change is less than 1% (noise)
    if abs_change < 0.01:
        return None

    direction = "up" if raw_change > 0 else "down"
    pct = abs_change * 100
    return f"{direction} {pct:.1f}% {period}"


def _parse_outcome_prices(market: Dict[str, Any]) -> List[tuple]:
    """Parse outcomePrices JSON string into list of (outcome_name, price) tuples."""
    outcomes_raw = market.get("outcomes") or []
    prices_raw = market.get("outcomePrices")

    if not prices_raw:
        return []

    # Both outcomes and outcomePrices can be JSON-encoded strings
    try:
        if isinstance(outcomes_raw, str):
            outcomes = json.loads(outcomes_raw)
        else:
            outcomes = outcomes_raw
    except (json.JSONDecodeError, TypeError):
        outcomes = []

    try:
        if isinstance(prices_raw, str):
            prices = json.loads(prices_raw)
        else:
            prices = prices_raw
    except (json.JSONDecodeError, TypeError):
        return []

    result = []
    for i, price in enumerate(prices):
        try:
            p = float(price)
        except (ValueError, TypeError):
            continue
        name = outcomes[i] if i < len(outcomes) else f"Outcome {i+1}"
        result.append((name, p))

    return result


def _shorten_question(question: str) -> str:
    """Extract a short display name from a market question.

    'Will Arizona win the 2026 NCAA Tournament?' -> 'Arizona'
    'Will Duke be a number 1 seed in the 2026 NCAA...' -> 'Duke'
    """
    q = question.strip().rstrip("?")
    # Common patterns: "Will X win/be/...", "X wins/loses..."
    m = re.match(r"^Will\s+(.+?)\s+(?:win|be|make|reach|have|lose|qualify|advance|strike|agree|pass|sign|get|become|remain|stay|leave|survive|next)\b", q, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    m = re.match(r"^Will\s+(.+?)\s+", q, re.IGNORECASE)
    if m and len(m.group(1).split()) <= 4:
        return m.group(1).strip()
    # Fallback: truncate
    return question[:40] if len(question) > 40 else question


def _compute_text_similarity(topic: str, title: str, outcomes: List[str] = None) -> float:
    """Score how well the event title (or outcome names) match the search topic.

    Returns 0.0-1.0. Title substring match gets 1.0, outcome match gets 0.85/0.7,
    title token overlap gets proportional score.
    """
    core = _extract_core_subject(topic).lower()
    title_lower = title.lower()
    if not core:
        return 0.5

    # Full substring match in title
    if core in title_lower:
        return 1.0

    # Check if topic appears in any outcome name (bidirectional)
    if outcomes:
        core_tokens = set(core.split())
        best_outcome_score = 0.0
        for outcome_name in outcomes:
            outcome_lower = outcome_name.lower()
            # Bidirectional: "arizona" in "arizona basketball" OR "arizona basketball" contains "arizona"
            if core in outcome_lower or outcome_lower in core:
                best_outcome_score = max(best_outcome_score, 0.85)
            elif core_tokens & set(outcome_lower.split()):
                best_outcome_score = max(best_outcome_score, 0.7)
        if best_outcome_score > 0:
            return best_outcome_score

    # Token overlap fallback against title
    topic_tokens = set(core.split())
    title_tokens = set(title_lower.split())
    if not topic_tokens:
        return 0.5
    overlap = len(topic_tokens & title_tokens)
    return overlap / len(topic_tokens)


def _safe_float(val, default=0.0) -> float:
    """Safely convert a value to float."""
    try:
        return float(val or default)
    except (ValueError, TypeError):
        return default


def parse_polymarket_response(response: Dict[str, Any], topic: str = "") -> List[Dict[str, Any]]:
    """Parse Gamma API response into normalized item dicts.

    Each event becomes one item showing its title and top markets.

    Args:
        response: Raw Gamma API response
        topic: Original search topic (for relevance scoring)

    Returns:
        List of item dicts ready for normalization.
    """
    events = response.get("events", [])
    items = []

    for i, event in enumerate(events):
        event_id = event.get("id", "")
        title = event.get("title", "")
        slug = event.get("slug", "")

        # Filter: skip closed/resolved events
        if event.get("closed", False):
            continue
        if not event.get("active", True):
            continue

        # Get markets for this event
        markets = event.get("markets", [])
        if not markets:
            continue

        # Filter to active, open markets with liquidity (excludes resolved markets)
        active_markets = []
        for m in markets:
            if m.get("closed", False):
                continue
            if not m.get("active", True):
                continue
            # Must have liquidity (resolved markets have 0 or None)
            try:
                liq = float(m.get("liquidity", 0) or 0)
            except (ValueError, TypeError):
                liq = 0
            if liq > 0:
                active_markets.append(m)

        if not active_markets:
            continue

        # Sort markets by volume (most liquid first)
        def market_volume(m):
            try:
                return float(m.get("volume", 0) or 0)
            except (ValueError, TypeError):
                return 0
        active_markets.sort(key=market_volume, reverse=True)

        # Take top market for the event
        top_market = active_markets[0]

        # Collect outcome names from ALL active markets (not just top) for similarity scoring
        # Filter to outcomes with price > 1% to avoid noise
        # Also extract subjects from market questions for neg-risk events (outcomes are Yes/No)
        all_outcome_names = []
        for m in active_markets:
            for name, price in _parse_outcome_prices(m):
                if price > 0.01 and name not in all_outcome_names:
                    all_outcome_names.append(name)
            # For neg-risk binary markets (Yes/No outcomes), the team/entity name
            # lives in the question, e.g., "Will Arizona win the NCAA Tournament?"
            question = m.get("question", "")
            if question and question != title:
                all_outcome_names.append(question)

        # Parse outcome prices - for multi-market events with Yes/No binary
        # sub-markets, synthesize from market questions to show actual
        # team/entity probabilities instead of a single market's Yes/No
        outcome_prices = _parse_outcome_prices(top_market)
        top_outcomes_are_binary = (
            len(outcome_prices) == 2
            and {n.lower() for n, _ in outcome_prices} == {"yes", "no"}
        )
        if top_outcomes_are_binary and len(active_markets) > 1:
            synth_outcomes = []
            for m in active_markets:
                q = m.get("question", "")
                if not q:
                    continue
                pairs = _parse_outcome_prices(m)
                yes_price = next((p for name, p in pairs if name.lower() == "yes"), None)
                if yes_price is not None and yes_price > 0.005:
                    synth_outcomes.append((q, yes_price))
            if synth_outcomes:
                synth_outcomes.sort(key=lambda x: x[1], reverse=True)
                outcome_prices = [(_shorten_question(q), p) for q, p in synth_outcomes]

        # Format price movement
        price_movement = _format_price_movement(top_market)

        # Volume and liquidity - prefer event-level (more stable), fall back to market-level
        event_volume1mo = _safe_float(event.get("volume1mo"))
        event_volume1wk = _safe_float(event.get("volume1wk"))
        event_liquidity = _safe_float(event.get("liquidity"))
        event_competitive = _safe_float(event.get("competitive"))
        volume24hr = _safe_float(event.get("volume24hr")) or _safe_float(top_market.get("volume24hr"))
        liquidity = event_liquidity or _safe_float(top_market.get("liquidity"))

        # Event URL
        url = f"https://polymarket.com/event/{slug}" if slug else f"https://polymarket.com/event/{event_id}"

        # Date: use updatedAt from event
        updated_at = event.get("updatedAt", "")
        date_str = None
        if updated_at:
            try:
                date_str = updated_at[:10]  # YYYY-MM-DD
            except (IndexError, TypeError):
                pass

        # End date for the market
        end_date = top_market.get("endDate")
        if end_date:
            try:
                end_date = end_date[:10]
            except (IndexError, TypeError):
                end_date = None

        # Quality-signal relevance (replaces position-based decay)
        text_score = _compute_text_similarity(topic, title, all_outcome_names) if topic else 0.5

        # Volume signal: log-scaled monthly volume (most stable signal)
        vol_raw = event_volume1mo or event_volume1wk or volume24hr
        vol_score = min(1.0, math.log1p(vol_raw) / 16)  # ~$9M = 1.0

        # Liquidity signal
        liq_score = min(1.0, math.log1p(liquidity) / 14)  # ~$1.2M = 1.0

        # Price movement: daily weighted more than monthly
        day_change = abs(top_market.get("oneDayPriceChange") or 0) * 3
        week_change = abs(top_market.get("oneWeekPriceChange") or 0) * 2
        month_change = abs(top_market.get("oneMonthPriceChange") or 0)
        max_change = max(day_change, week_change, month_change)
        movement_score = min(1.0, max_change * 5)  # 20% change = 1.0

        # Competitive bonus: markets near 50/50 are more interesting
        competitive_score = event_competitive

        relevance = min(1.0, (
            0.30 * text_score +
            0.30 * vol_score +
            0.15 * liq_score +
            0.15 * movement_score +
            0.10 * competitive_score
        ))

        # Surface the topic-matching outcome to the front before truncating
        if topic and outcome_prices:
            core = _extract_core_subject(topic).lower()
            core_tokens = set(core.split())
            reordered = []
            rest = []
            for pair in outcome_prices:
                name_lower = pair[0].lower()
                # Match if full core is substring, or name is substring of core,
                # or any core token appears in the name (handles long question strings)
                if (core in name_lower or name_lower in core
                        or any(tok in name_lower for tok in core_tokens if len(tok) > 2)):
                    reordered.append(pair)
                else:
                    rest.append(pair)
            if reordered:
                outcome_prices = reordered + rest

        # Top 3 outcomes for multi-outcome markets
        top_outcomes = outcome_prices[:3]
        remaining = len(outcome_prices) - 3
        if remaining < 0:
            remaining = 0

        items.append({
            "event_id": event_id,
            "title": title,
            "question": top_market.get("question", title),
            "url": url,
            "outcome_prices": top_outcomes,
            "outcomes_remaining": remaining,
            "price_movement": price_movement,
            "volume24hr": volume24hr,
            "volume1mo": event_volume1mo,
            "liquidity": liquidity,
            "date": date_str,
            "end_date": end_date,
            "relevance": round(relevance, 2),
            "why_relevant": f"Prediction market: {title[:60]}",
        })

    # Sort by relevance (quality-signal ranked) and apply cap
    items.sort(key=lambda x: x["relevance"], reverse=True)
    cap = response.get("_cap", len(items))
    return items[:cap]
