"""OpenAI Responses API client for Reddit discovery."""

import json
import re
import sys
from typing import Any, Dict, List, Optional

from . import http, env

# Fallback models when the selected model isn't accessible (e.g., org not verified for GPT-5)
# Note: gpt-4o-mini does NOT support web_search with filters param, so exclude it
MODEL_FALLBACK_ORDER = ["gpt-4.1", "gpt-4o"]


def _log_error(msg: str):
    """Log error to stderr."""
    sys.stderr.write(f"[REDDIT ERROR] {msg}\n")
    sys.stderr.flush()


def _log_info(msg: str):
    """Log info to stderr."""
    sys.stderr.write(f"[REDDIT] {msg}\n")
    sys.stderr.flush()


def _is_model_access_error(error: http.HTTPError) -> bool:
    """Check if error is due to model access/verification issues."""
    if error.status_code not in (400, 403):
        return False
    if not error.body:
        return False
    body_lower = error.body.lower()
    # Check for common access/verification error messages
    return any(phrase in body_lower for phrase in [
        "verified",
        "organization must be",
        "does not have access",
        "not available",
        "not found",
    ])


OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
CODEX_INSTRUCTIONS = (
    "You are a research assistant for a skill that summarizes what people are "
    "discussing in the last 30 days. Your goal is to find relevant Reddit threads "
    "about the topic and return ONLY the required JSON. Be inclusive (return more "
    "rather than fewer), but avoid irrelevant results. Prefer threads with discussion "
    "and comments. If you can infer a date, include it; otherwise use null. "
    "Do not include developers.reddit.com or business.reddit.com."
)


def _parse_sse_chunk(chunk: str) -> Optional[Dict[str, Any]]:
    """Parse a single SSE chunk into a JSON object."""
    lines = chunk.split("\n")
    data_lines = []

    for line in lines:
        if line.startswith("data:"):
            data_lines.append(line[5:].strip())

    if not data_lines:
        return None

    data = "\n".join(data_lines).strip()
    if not data or data == "[DONE]":
        return None

    try:
        return json.loads(data)
    except json.JSONDecodeError:
        return None


def _parse_sse_stream_raw(raw: str) -> List[Dict[str, Any]]:
    """Parse SSE stream from raw text and return JSON events."""
    events: List[Dict[str, Any]] = []
    buffer = ""
    for chunk in raw.splitlines(keepends=True):
        buffer += chunk
        while "\n\n" in buffer:
            event_chunk, buffer = buffer.split("\n\n", 1)
            event = _parse_sse_chunk(event_chunk)
            if event is not None:
                events.append(event)
    if buffer.strip():
        event = _parse_sse_chunk(buffer)
        if event is not None:
            events.append(event)
    return events


def _parse_codex_stream(raw: str) -> Dict[str, Any]:
    """Parse SSE stream from Codex responses into a response-like dict."""
    events = _parse_sse_stream_raw(raw)

    # Prefer explicit completed response payload if present
    for evt in reversed(events):
        if isinstance(evt, dict):
            if evt.get("type") == "response.completed" and isinstance(evt.get("response"), dict):
                return evt["response"]
            if isinstance(evt.get("response"), dict):
                return evt["response"]

    # Fallback: reconstruct output text from deltas
    output_text = ""
    for evt in events:
        if not isinstance(evt, dict):
            continue
        delta = evt.get("delta")
        if isinstance(delta, str):
            output_text += delta
            continue
        text = evt.get("text")
        if isinstance(text, str):
            output_text += text

    if output_text:
        return {
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": output_text}],
                }
            ]
        }

    return {}

# Depth configurations: (min, max) threads to request
# Request MORE than needed since many get filtered by date
DEPTH_CONFIG = {
    "quick": (15, 25),
    "default": (30, 50),
    "deep": (70, 100),
}

REDDIT_SEARCH_PROMPT = """Find Reddit discussion threads about: {topic}

STEP 1: EXTRACT THE CORE SUBJECT
Get the MAIN NOUN/PRODUCT/TOPIC:
- "best nano banana prompting practices" → "nano banana"
- "killer features of clawdbot" → "clawdbot"
- "top Claude Code skills" → "Claude Code"
DO NOT include "best", "top", "tips", "practices", "features" in your search.

STEP 2: SEARCH BROADLY
Search for the core subject:
1. "[core subject] site:reddit.com"
2. "reddit [core subject]"
3. "[core subject] reddit"

Return as many relevant threads as you find. We filter by date server-side.

STEP 3: INCLUDE ALL MATCHES
- Include ALL threads about the core subject
- Set date to "YYYY-MM-DD" if you can determine it, otherwise null
- We verify dates and filter old content server-side
- DO NOT pre-filter aggressively - include anything relevant

REQUIRED: URLs must contain "/r/" AND "/comments/"
REJECT: developers.reddit.com, business.reddit.com

Find {min_items}-{max_items} threads. Return MORE rather than fewer.

Return JSON:
{{
  "items": [
    {{
      "title": "Thread title",
      "url": "https://www.reddit.com/r/sub/comments/xyz/title/",
      "subreddit": "subreddit_name",
      "date": "YYYY-MM-DD or null",
      "why_relevant": "Why relevant",
      "relevance": 0.85
    }}
  ]
}}"""


def _extract_core_subject(topic: str) -> str:
    """Extract core subject from verbose query for retry."""
    noise = ['best', 'top', 'how to', 'tips for', 'practices', 'features',
             'killer', 'guide', 'tutorial', 'recommendations', 'advice',
             'prompting', 'using', 'for', 'with', 'the', 'of', 'in', 'on']
    words = topic.lower().split()
    result = [w for w in words if w not in noise]
    return ' '.join(result[:3]) or topic  # Keep max 3 words


def _build_subreddit_query(topic: str) -> str:
    """Build a subreddit-targeted search query for fallback.

    When standard search returns few results, try searching for the
    subreddit itself: 'r/kanye', 'r/howie', etc.
    """
    core = _extract_core_subject(topic)
    # Remove dots and special chars for subreddit name guess
    sub_name = core.replace('.', '').replace(' ', '').lower()
    return f"r/{sub_name} site:reddit.com"


def _build_payload(model: str, instructions_text: str, input_text: str, auth_source: str) -> Dict[str, Any]:
    """Build responses payload for OpenAI or Codex endpoints."""
    payload = {
        "model": model,
        "store": False,
        "tools": [
            {
                "type": "web_search",
                "filters": {
                    "allowed_domains": ["reddit.com"]
                }
            }
        ],
        "include": ["web_search_call.action.sources"],
        "instructions": instructions_text,
        "input": input_text,
    }
    if auth_source == env.AUTH_SOURCE_CODEX:
        payload["input"] = [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": input_text}],
            }
        ]
        payload["stream"] = True
    return payload


def search_reddit(
    api_key: str,
    model: str,
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
    auth_source: str = "api_key",
    account_id: Optional[str] = None,
    mock_response: Optional[Dict] = None,
    _retry: bool = False,
) -> Dict[str, Any]:
    """Search Reddit for relevant threads using OpenAI Responses API.

    Args:
        api_key: OpenAI API key
        model: Model to use
        topic: Search topic
        from_date: Start date (YYYY-MM-DD) - only include threads after this
        to_date: End date (YYYY-MM-DD) - only include threads before this
        depth: Research depth - "quick", "default", or "deep"
        mock_response: Mock response for testing

    Returns:
        Raw API response
    """
    if mock_response is not None:
        return mock_response

    min_items, max_items = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])

    if auth_source == env.AUTH_SOURCE_CODEX:
        if not account_id:
            raise ValueError("Missing chatgpt_account_id for Codex auth")
        headers = {
            "Authorization": f"Bearer {api_key}",
            "chatgpt-account-id": account_id,
            "OpenAI-Beta": "responses=experimental",
            "originator": "pi",
            "Content-Type": "application/json",
        }
        url = CODEX_RESPONSES_URL
    else:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        url = OPENAI_RESPONSES_URL

    # Adjust timeout based on depth (generous for OpenAI web_search which can be slow)
    timeout = 90 if depth == "quick" else 120 if depth == "default" else 180

    # Build list of models to try: requested model first, then fallbacks
    models_to_try = [model] + [m for m in MODEL_FALLBACK_ORDER if m != model]

    # Note: allowed_domains accepts base domain, not subdomains
    # We rely on prompt to filter out developers.reddit.com, etc.
    input_text = REDDIT_SEARCH_PROMPT.format(
        topic=topic,
        from_date=from_date,
        to_date=to_date,
        min_items=min_items,
        max_items=max_items,
    )

    if auth_source == env.AUTH_SOURCE_CODEX:
        # Codex auth: try model with fallback chain
        from . import models as models_mod
        codex_models_to_try = [model] + [m for m in models_mod.CODEX_FALLBACK_MODELS if m != model]
        instructions_text = CODEX_INSTRUCTIONS + "\n\n" + input_text
        last_error = None
        for current_model in codex_models_to_try:
            try:
                payload = _build_payload(current_model, instructions_text, topic, auth_source)
                raw = http.post_raw(url, payload, headers=headers, timeout=timeout)
                return _parse_codex_stream(raw or "")
            except http.HTTPError as e:
                last_error = e
                if e.status_code == 400:
                    _log_info(f"Model {current_model} not supported on Codex, trying fallback...")
                    continue
                raise
        if last_error:
            raise last_error
        raise http.HTTPError("No Codex-compatible models available")

    # Standard API key auth: try model fallback chain
    last_error = None
    for current_model in models_to_try:
        payload = {
            "model": current_model,
            "tools": [
                {
                    "type": "web_search",
                    "filters": {
                        "allowed_domains": ["reddit.com"]
                    }
                }
            ],
            "include": ["web_search_call.action.sources"],
            "input": input_text,
        }

        try:
            return http.post(url, payload, headers=headers, timeout=timeout)
        except http.HTTPError as e:
            last_error = e
            if _is_model_access_error(e):
                _log_info(f"Model {current_model} not accessible, trying fallback...")
                continue
            if e.status_code == 429:
                _log_info(f"Rate limited on {current_model}, trying fallback model...")
                continue
            # Non-access error, don't retry with different model
            raise

    # All models failed with access errors
    if last_error:
        _log_error(f"All models failed. Last error: {last_error}")
        raise last_error
    raise http.HTTPError("No models available")


def _public_relevance(score: int, num_comments: int) -> float:
    """Estimate relevance for public Reddit search results."""
    # Lightweight heuristic: blend normalized score + comments.
    score_component = min(1.0, max(0.0, score / 500.0))
    comments_component = min(1.0, max(0.0, num_comments / 200.0))
    return round((score_component * 0.6) + (comments_component * 0.4), 3)


def search_reddit_public(
    topic: str,
    from_date: str,
    to_date: str,
    depth: str = "default",
) -> List[Dict[str, Any]]:
    """Search Reddit directly via public JSON endpoint (no OpenAI key required).

    This is a fallback mode for environments where OpenAI auth is unavailable.
    It uses reddit.com/search/.json with recency filter (t=month).
    """
    _, max_items = DEPTH_CONFIG.get(depth, DEPTH_CONFIG["default"])
    limit = min(100, max(20, max_items))

    core = _extract_core_subject(topic)
    queries = [topic]
    if core and core.lower() != topic.lower():
        queries.append(core)
        queries.append(f'"{core}"')

    seen_urls = set()
    all_items: List[Dict[str, Any]] = []

    headers = {
        "User-Agent": http.USER_AGENT,
        "Accept": "application/json",
    }

    for query in queries:
        try:
            url = (
                "https://www.reddit.com/search/.json"
                f"?q={_url_encode(query)}&sort=new&t=month&limit={limit}&raw_json=1"
            )
            data = http.get(url, headers=headers, timeout=20, retries=2)
            children = data.get("data", {}).get("children", [])
            for child in children:
                if child.get("kind") != "t3":
                    continue
                post = child.get("data", {})
                permalink = str(post.get("permalink", "")).strip()
                if not permalink or "/comments/" not in permalink:
                    continue

                full_url = f"https://www.reddit.com{permalink}"
                if full_url in seen_urls:
                    continue
                seen_urls.add(full_url)

                score = int(post.get("score", 0) or 0)
                num_comments = int(post.get("num_comments", 0) or 0)

                # Parse date from created_utc
                created_utc = post.get("created_utc")
                date_value = None
                if created_utc:
                    from . import dates as dates_mod
                    date_value = dates_mod.timestamp_to_date(created_utc)

                all_items.append({
                    "id": f"R{len(all_items)+1}",
                    "title": str(post.get("title", "")).strip(),
                    "url": full_url,
                    "subreddit": str(post.get("subreddit", "")).strip(),
                    "date": date_value,
                    "why_relevant": "Found via Reddit public search",
                    "relevance": _public_relevance(score, num_comments),
                    "engagement": {
                        "score": score,
                        "num_comments": num_comments,
                        "upvote_ratio": post.get("upvote_ratio"),
                    },
                })

        except http.HTTPError as e:
            _log_info(f"Public Reddit search failed for query '{query}': {e}")
            # Continue with next query; partial results are still useful.
            continue
        except Exception as e:
            _log_info(f"Public Reddit search error for query '{query}': {e}")
            continue

    # Sort by date (desc, unknown dates last), then relevance desc
    def _sort_key(item: Dict[str, Any]):
        date_str = item.get("date") or ""
        return (date_str, float(item.get("relevance", 0.0)))

    all_items.sort(key=_sort_key, reverse=True)
    return all_items[: max_items * 2]


def search_subreddits(
    subreddits: List[str],
    topic: str,
    from_date: str,
    to_date: str,
    count_per: int = 5,
) -> List[Dict[str, Any]]:
    """Search specific subreddits via Reddit's free JSON endpoint.

    No API key needed. Uses reddit.com/r/{sub}/search/.json endpoint.
    Used in Phase 2 supplemental search after entity extraction.

    Args:
        subreddits: List of subreddit names (without r/)
        topic: Search topic
        from_date: Start date (YYYY-MM-DD)
        to_date: End date (YYYY-MM-DD)
        count_per: Results to request per subreddit

    Returns:
        List of raw item dicts (same format as parse_reddit_response output).
    """
    all_items = []
    core = _extract_core_subject(topic)

    for sub in subreddits:
        sub = sub.lstrip("r/")
        try:
            url = f"https://www.reddit.com/r/{sub}/search/.json"
            params = f"q={_url_encode(core)}&restrict_sr=on&sort=new&limit={count_per}&raw_json=1"
            full_url = f"{url}?{params}"

            headers = {
                "User-Agent": http.USER_AGENT,
                "Accept": "application/json",
            }

            data = http.get(full_url, headers=headers, timeout=15, retries=1)

            # Reddit search returns {"data": {"children": [...]}}
            children = data.get("data", {}).get("children", [])
            for i, child in enumerate(children):
                if child.get("kind") != "t3":  # t3 = link/submission
                    continue
                post = child.get("data", {})
                permalink = post.get("permalink", "")
                if not permalink:
                    continue

                item = {
                    "id": f"RS{len(all_items)+1}",
                    "title": str(post.get("title", "")).strip(),
                    "url": f"https://www.reddit.com{permalink}",
                    "subreddit": str(post.get("subreddit", sub)).strip(),
                    "date": None,
                    "why_relevant": f"Found in r/{sub} supplemental search",
                    "relevance": 0.65,  # Slightly lower default for supplemental
                }

                # Parse date from created_utc
                created_utc = post.get("created_utc")
                if created_utc:
                    from . import dates as dates_mod
                    item["date"] = dates_mod.timestamp_to_date(created_utc)

                all_items.append(item)

        except http.HTTPError as e:
            _log_info(f"Subreddit search failed for r/{sub}: {e}")
            if e.status_code == 429:
                _log_info("Reddit rate-limited (429) — skipping remaining subreddits")
                break
        except Exception as e:
            _log_info(f"Subreddit search error for r/{sub}: {e}")

    return all_items


def _url_encode(text: str) -> str:
    """Simple URL encoding for query parameters."""
    import urllib.parse
    return urllib.parse.quote_plus(text)


def parse_reddit_response(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Parse OpenAI response to extract Reddit items.

    Args:
        response: Raw API response

    Returns:
        List of item dicts
    """
    items = []

    # Check for API errors first
    if "error" in response and response["error"]:
        error = response["error"]
        err_msg = error.get("message", str(error)) if isinstance(error, dict) else str(error)
        _log_error(f"OpenAI API error: {err_msg}")
        if http.DEBUG:
            _log_error(f"Full error response: {json.dumps(response, indent=2)[:1000]}")
        return items

    # Try to find the output text
    output_text = ""
    if "output" in response:
        output = response["output"]
        if isinstance(output, str):
            output_text = output
        elif isinstance(output, list):
            for item in output:
                if isinstance(item, dict):
                    if item.get("type") == "message":
                        content = item.get("content", [])
                        for c in content:
                            if isinstance(c, dict) and c.get("type") == "output_text":
                                output_text = c.get("text", "")
                                break
                    elif "text" in item:
                        output_text = item["text"]
                elif isinstance(item, str):
                    output_text = item
                if output_text:
                    break

    # Also check for choices (older format)
    if not output_text and "choices" in response:
        for choice in response["choices"]:
            if "message" in choice:
                output_text = choice["message"].get("content", "")
                break

    if not output_text:
        print(f"[REDDIT WARNING] No output text found in OpenAI response. Keys present: {list(response.keys())}", flush=True)
        return items

    # Extract JSON from the response
    json_match = re.search(r'\{[\s\S]*"items"[\s\S]*\}', output_text)
    if json_match:
        try:
            data = json.loads(json_match.group())
            items = data.get("items", [])
        except json.JSONDecodeError:
            pass

    # Validate and clean items
    clean_items = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue

        url = item.get("url", "")
        if not url or "reddit.com" not in url:
            continue

        clean_item = {
            "id": f"R{i+1}",
            "title": str(item.get("title", "")).strip(),
            "url": url,
            "subreddit": str(item.get("subreddit", "")).strip().lstrip("r/"),
            "date": item.get("date"),
            "why_relevant": str(item.get("why_relevant", "")).strip(),
            "relevance": min(1.0, max(0.0, float(item.get("relevance", 0.5)))),
        }

        # Validate date format
        if clean_item["date"]:
            if not re.match(r'^\d{4}-\d{2}-\d{2}$', str(clean_item["date"])):
                clean_item["date"] = None

        clean_items.append(clean_item)

    return clean_items
