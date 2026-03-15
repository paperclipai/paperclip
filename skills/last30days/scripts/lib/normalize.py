"""Normalization of raw API data to canonical schema."""

from typing import Any, Dict, List, TypeVar, Union

from . import dates, schema

T = TypeVar("T", schema.RedditItem, schema.XItem, schema.WebSearchItem, schema.YouTubeItem, schema.TikTokItem, schema.InstagramItem, schema.HackerNewsItem, schema.BlueskyItem, schema.PolymarketItem)


def filter_by_date_range(
    items: List[T],
    from_date: str,
    to_date: str,
    require_date: bool = False,
) -> List[T]:
    """Hard filter: Remove items outside the date range.

    This is the safety net - even if the prompt lets old content through,
    this filter will exclude it.

    Args:
        items: List of items to filter
        from_date: Start date (YYYY-MM-DD) - exclude items before this
        to_date: End date (YYYY-MM-DD) - exclude items after this
        require_date: If True, also remove items with no date

    Returns:
        Filtered list with only items in range (or unknown dates if not required)
    """
    result = []
    for item in items:
        if item.date is None:
            if not require_date:
                result.append(item)  # Keep unknown dates (with scoring penalty)
            continue

        # Hard filter: if date is before from_date, exclude
        if item.date < from_date:
            continue  # DROP - too old

        # Hard filter: if date is after to_date, exclude (likely parsing error)
        if item.date > to_date:
            continue  # DROP - future date

        result.append(item)

    return result


def normalize_reddit_items(
    items: List[Dict[str, Any]],
    from_date: str,
    to_date: str,
) -> List[schema.RedditItem]:
    """Normalize raw Reddit items to schema.

    Args:
        items: Raw Reddit items from API
        from_date: Start of date range
        to_date: End of date range

    Returns:
        List of RedditItem objects
    """
    normalized = []

    for item in items:
        # Parse engagement
        engagement = None
        eng_raw = item.get("engagement")
        if isinstance(eng_raw, dict):
            engagement = schema.Engagement(
                score=eng_raw.get("score"),
                num_comments=eng_raw.get("num_comments"),
                upvote_ratio=eng_raw.get("upvote_ratio"),
            )

        # Parse comments
        top_comments = []
        for c in item.get("top_comments", []):
            top_comments.append(schema.Comment(
                score=c.get("score", 0),
                date=c.get("date"),
                author=c.get("author", ""),
                excerpt=c.get("excerpt", ""),
                url=c.get("url", ""),
            ))

        # Determine date confidence
        date_str = item.get("date")
        date_confidence = dates.get_date_confidence(date_str, from_date, to_date)

        normalized.append(schema.RedditItem(
            id=item.get("id", ""),
            title=item.get("title", ""),
            url=item.get("url", ""),
            subreddit=item.get("subreddit", ""),
            date=date_str,
            date_confidence=date_confidence,
            engagement=engagement,
            top_comments=top_comments,
            comment_insights=item.get("comment_insights", []),
            relevance=item.get("relevance", 0.5),
            why_relevant=item.get("why_relevant", ""),
        ))

    return normalized


def normalize_x_items(
    items: List[Dict[str, Any]],
    from_date: str,
    to_date: str,
) -> List[schema.XItem]:
    """Normalize raw X items to schema.

    Args:
        items: Raw X items from API
        from_date: Start of date range
        to_date: End of date range

    Returns:
        List of XItem objects
    """
    normalized = []

    for item in items:
        # Parse engagement
        engagement = None
        eng_raw = item.get("engagement")
        if isinstance(eng_raw, dict):
            engagement = schema.Engagement(
                likes=eng_raw.get("likes"),
                reposts=eng_raw.get("reposts"),
                replies=eng_raw.get("replies"),
                quotes=eng_raw.get("quotes"),
            )

        # Determine date confidence
        date_str = item.get("date")
        date_confidence = dates.get_date_confidence(date_str, from_date, to_date)

        normalized.append(schema.XItem(
            id=item.get("id", ""),
            text=item.get("text", ""),
            url=item.get("url", ""),
            author_handle=item.get("author_handle", ""),
            date=date_str,
            date_confidence=date_confidence,
            engagement=engagement,
            relevance=item.get("relevance", 0.5),
            why_relevant=item.get("why_relevant", ""),
        ))

    return normalized


def normalize_youtube_items(
    items: List[Dict[str, Any]],
    from_date: str,
    to_date: str,
) -> List[schema.YouTubeItem]:
    """Normalize raw YouTube items to schema.

    Args:
        items: Raw YouTube items from yt-dlp
        from_date: Start of date range
        to_date: End of date range

    Returns:
        List of YouTubeItem objects
    """
    normalized = []

    for item in items:
        # Parse engagement
        eng_raw = item.get("engagement") or {}
        engagement = schema.Engagement(
            views=eng_raw.get("views"),
            likes=eng_raw.get("likes"),
            num_comments=eng_raw.get("comments"),
        )

        # YouTube dates are reliable (always YYYY-MM-DD from yt-dlp)
        date_str = item.get("date")

        normalized.append(schema.YouTubeItem(
            id=item.get("video_id", ""),
            title=item.get("title", ""),
            url=item.get("url", ""),
            channel_name=item.get("channel_name", ""),
            date=date_str,
            date_confidence="high",
            engagement=engagement,
            transcript_snippet=item.get("transcript_snippet", ""),
            relevance=item.get("relevance", 0.7),
            why_relevant=item.get("why_relevant", ""),
        ))

    return normalized


def normalize_tiktok_items(
    items: List[Dict[str, Any]],
    from_date: str,
    to_date: str,
) -> List[schema.TikTokItem]:
    """Normalize raw TikTok items to schema.

    Args:
        items: Raw TikTok items from Apify
        from_date: Start of date range
        to_date: End of date range

    Returns:
        List of TikTokItem objects
    """
    normalized = []

    for i, item in enumerate(items):
        # Parse engagement
        eng_raw = item.get("engagement") or {}
        engagement = schema.Engagement(
            views=eng_raw.get("views"),
            likes=eng_raw.get("likes"),
            num_comments=eng_raw.get("comments"),
            shares=eng_raw.get("shares"),
        )

        # TikTok dates are reliable (exact timestamps from Apify)
        date_str = item.get("date")

        normalized.append(schema.TikTokItem(
            id=f"TK{i+1}",
            text=item.get("text", ""),
            url=item.get("url", ""),
            author_name=item.get("author_name", ""),
            date=date_str,
            date_confidence="high",
            engagement=engagement,
            caption_snippet=item.get("caption_snippet", ""),
            hashtags=item.get("hashtags", []),
            relevance=item.get("relevance", 0.7),
            why_relevant=item.get("why_relevant", ""),
        ))

    return normalized


def normalize_instagram_items(
    items: List[Dict[str, Any]],
    from_date: str,
    to_date: str,
) -> List[schema.InstagramItem]:
    """Normalize raw Instagram items to schema.

    Args:
        items: Raw Instagram items from ScrapeCreators
        from_date: Start of date range
        to_date: End of date range

    Returns:
        List of InstagramItem objects
    """
    normalized = []

    for i, item in enumerate(items):
        # Parse engagement
        eng_raw = item.get("engagement") or {}
        engagement = schema.Engagement(
            views=eng_raw.get("views"),
            likes=eng_raw.get("likes"),
            num_comments=eng_raw.get("comments"),
        )

        # Instagram dates are reliable (exact timestamps from ScrapeCreators)
        date_str = item.get("date")

        normalized.append(schema.InstagramItem(
            id=f"IG{i+1}",
            text=item.get("text", ""),
            url=item.get("url", ""),
            author_name=item.get("author_name", ""),
            date=date_str,
            date_confidence="high",
            engagement=engagement,
            caption_snippet=item.get("caption_snippet", ""),
            hashtags=item.get("hashtags", []),
            relevance=item.get("relevance", 0.7),
            why_relevant=item.get("why_relevant", ""),
        ))

    return normalized


def normalize_hackernews_items(
    items: List[Dict[str, Any]],
    from_date: str,
    to_date: str,
) -> List[schema.HackerNewsItem]:
    """Normalize raw Hacker News items to schema.

    Args:
        items: Raw HN items from Algolia API
        from_date: Start of date range
        to_date: End of date range

    Returns:
        List of HackerNewsItem objects
    """
    normalized = []

    for i, item in enumerate(items):
        # Parse engagement
        eng_raw = item.get("engagement") or {}
        engagement = schema.Engagement(
            score=eng_raw.get("points"),
            num_comments=eng_raw.get("num_comments"),
        )

        # Parse comments (from enrichment)
        top_comments = []
        for c in item.get("top_comments", []):
            top_comments.append(schema.Comment(
                score=c.get("points", 0),
                date=None,
                author=c.get("author", ""),
                excerpt=c.get("text", ""),
                url="",
            ))

        # HN dates are always high confidence (exact timestamps from Algolia)
        date_str = item.get("date")

        normalized.append(schema.HackerNewsItem(
            id=f"HN{i+1}",
            title=item.get("title", ""),
            url=item.get("url", ""),
            hn_url=item.get("hn_url", ""),
            author=item.get("author", ""),
            date=date_str,
            date_confidence="high",
            engagement=engagement,
            top_comments=top_comments,
            comment_insights=item.get("comment_insights", []),
            relevance=item.get("relevance", 0.5),
            why_relevant=item.get("why_relevant", ""),
        ))

    return normalized


def normalize_bluesky_items(
    items: List[Dict[str, Any]],
    from_date: str,
    to_date: str,
) -> List[schema.BlueskyItem]:
    """Normalize raw Bluesky items to schema.

    Args:
        items: Raw Bluesky items from AT Protocol API
        from_date: Start of date range
        to_date: End of date range

    Returns:
        List of BlueskyItem objects
    """
    normalized = []

    for i, item in enumerate(items):
        eng_raw = item.get("engagement") or {}
        engagement = schema.Engagement(
            likes=eng_raw.get("likes"),
            reposts=eng_raw.get("reposts"),
            replies=eng_raw.get("replies"),
            quotes=eng_raw.get("quotes"),
        )

        date_str = item.get("date")

        normalized.append(schema.BlueskyItem(
            id=f"BS{i+1}",
            text=item.get("text", ""),
            url=item.get("url", ""),
            author_handle=item.get("handle", ""),
            display_name=item.get("display_name", ""),
            date=date_str,
            date_confidence="high",
            engagement=engagement,
            relevance=item.get("relevance", 0.5),
            why_relevant=item.get("why_relevant", ""),
        ))

    return normalized


def normalize_truthsocial_items(
    items: List[Dict[str, Any]],
    from_date: str,
    to_date: str,
) -> List[schema.TruthSocialItem]:
    """Normalize raw Truth Social items to schema.

    Args:
        items: Raw Truth Social items from Mastodon API
        from_date: Start of date range
        to_date: End of date range

    Returns:
        List of TruthSocialItem objects
    """
    normalized = []

    for i, item in enumerate(items):
        eng_raw = item.get("engagement") or {}
        engagement = schema.Engagement(
            likes=eng_raw.get("likes"),
            reposts=eng_raw.get("reposts"),
            replies=eng_raw.get("replies"),
        )

        date_str = item.get("date")

        normalized.append(schema.TruthSocialItem(
            id=f"TS{i+1}",
            text=item.get("text", ""),
            url=item.get("url", ""),
            author_handle=item.get("handle", ""),
            display_name=item.get("display_name", ""),
            date=date_str,
            date_confidence="high",
            engagement=engagement,
            relevance=item.get("relevance", 0.5),
            why_relevant=item.get("why_relevant", ""),
        ))

    return normalized


def normalize_polymarket_items(
    items: List[Dict[str, Any]],
    from_date: str,
    to_date: str,
) -> List[schema.PolymarketItem]:
    """Normalize raw Polymarket items to schema.

    Args:
        items: Raw Polymarket items from Gamma API
        from_date: Start of date range
        to_date: End of date range

    Returns:
        List of PolymarketItem objects
    """
    normalized = []

    for i, item in enumerate(items):
        # Prefer volume1mo (more stable) for engagement scoring, fall back to volume24hr
        volume = item.get("volume1mo") or item.get("volume24hr", 0.0)
        engagement = schema.Engagement(
            volume=volume,
            liquidity=item.get("liquidity", 0.0),
        )

        date_str = item.get("date")

        normalized.append(schema.PolymarketItem(
            id=f"PM{i+1}",
            title=item.get("title", ""),
            question=item.get("question", ""),
            url=item.get("url", ""),
            outcome_prices=item.get("outcome_prices", []),
            outcomes_remaining=item.get("outcomes_remaining", 0),
            price_movement=item.get("price_movement"),
            date=date_str,
            date_confidence="high",
            engagement=engagement,
            end_date=item.get("end_date"),
            relevance=item.get("relevance", 0.5),
            why_relevant=item.get("why_relevant", ""),
        ))

    return normalized


def items_to_dicts(items: List) -> List[Dict[str, Any]]:
    """Convert schema items to dicts for JSON serialization."""
    return [item.to_dict() for item in items]
