"""Output rendering for last30days skill."""

import json
import os
import tempfile
from pathlib import Path
from typing import Optional

from . import schema

OUTPUT_DIR = Path.home() / ".local" / "share" / "last30days" / "out"


def _xref_tag(item) -> str:
    """Return ' [also on: Reddit, HN]' string if item has cross_refs, else ''."""
    refs = getattr(item, 'cross_refs', None)
    if not refs:
        return ""
    source_names = set()
    for ref_id in refs:
        if ref_id.startswith('R'):
            source_names.add('Reddit')
        elif ref_id.startswith('X'):
            source_names.add('X')
        elif ref_id.startswith('YT'):
            source_names.add('YouTube')
        elif ref_id.startswith('TK'):
            source_names.add('TikTok')
        elif ref_id.startswith('IG'):
            source_names.add('Instagram')
        elif ref_id.startswith('HN'):
            source_names.add('HN')
        elif ref_id.startswith('BS'):
            source_names.add('Bluesky')
        elif ref_id.startswith('TS'):
            source_names.add('Truth Social')
        elif ref_id.startswith('PM'):
            source_names.add('Polymarket')
        elif ref_id.startswith('W'):
            source_names.add('Web')
    if source_names:
        return f" [also on: {', '.join(sorted(source_names))}]"
    return ""


def ensure_output_dir():
    """Ensure output directory exists. Supports env override and sandbox fallback."""
    global OUTPUT_DIR
    env_dir = os.environ.get("LAST30DAYS_OUTPUT_DIR")
    if env_dir:
        OUTPUT_DIR = Path(env_dir)

    try:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        OUTPUT_DIR = Path(tempfile.gettempdir()) / "last30days" / "out"
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def _assess_data_freshness(report: schema.Report) -> dict:
    """Assess how much data is actually from the last 30 days."""
    reddit_recent = sum(1 for r in report.reddit if r.date and r.date >= report.range_from)
    x_recent = sum(1 for x in report.x if x.date and x.date >= report.range_from)
    web_recent = sum(1 for w in report.web if w.date and w.date >= report.range_from)
    hn_recent = sum(1 for h in report.hackernews if h.date and h.date >= report.range_from)
    bsky_recent = sum(1 for b in report.bluesky if b.date and b.date >= report.range_from)
    ts_recent = sum(1 for ts in report.truthsocial if ts.date and ts.date >= report.range_from)
    pm_recent = sum(1 for p in report.polymarket if p.date and p.date >= report.range_from)

    tiktok_recent = sum(1 for t in report.tiktok if t.date and t.date >= report.range_from)
    ig_recent = sum(1 for ig in report.instagram if ig.date and ig.date >= report.range_from)

    total_recent = reddit_recent + x_recent + web_recent + hn_recent + bsky_recent + ts_recent + pm_recent + tiktok_recent + ig_recent
    total_items = len(report.reddit) + len(report.x) + len(report.web) + len(report.hackernews) + len(report.bluesky) + len(report.truthsocial) + len(report.polymarket) + len(report.tiktok) + len(report.instagram)

    return {
        "reddit_recent": reddit_recent,
        "x_recent": x_recent,
        "web_recent": web_recent,
        "total_recent": total_recent,
        "total_items": total_items,
        "is_sparse": total_recent < 5,
        "mostly_evergreen": total_items > 0 and total_recent < total_items * 0.3,
    }


def render_compact(report: schema.Report, limit: int = 15, missing_keys: str = "none") -> str:
    """Render compact output for the assistant to synthesize.

    Args:
        report: Report data
        limit: Max items per source
        missing_keys: 'both', 'reddit', 'x', or 'none'

    Returns:
        Compact markdown string
    """
    lines = []

    # Header
    lines.append(f"## Research Results: {report.topic}")
    lines.append("")

    # Assess data freshness and add honesty warning if needed
    freshness = _assess_data_freshness(report)
    if freshness["is_sparse"]:
        lines.append("**⚠️ LIMITED RECENT DATA** - Few discussions from the last 30 days.")
        lines.append(f"Only {freshness['total_recent']} item(s) confirmed from {report.range_from} to {report.range_to}.")
        lines.append("Results below may include older/evergreen content. Be transparent with the user about this.")
        lines.append("")

    # Web-only mode banner (when no API keys)
    if report.mode == "web-only":
        lines.append("**🌐 WEB SEARCH MODE** - assistant will search blogs, docs & news")
        lines.append("")
        lines.append("---")
        lines.append("**⚡ Want better results?** Add API keys to unlock Reddit, TikTok, Instagram & X data:")
        lines.append("- `SCRAPECREATORS_API_KEY` → Reddit + TikTok + Instagram (one key, all three!) — real upvotes, comments, views")
        lines.append("- `XAI_API_KEY` → X posts with real likes & reposts")
        lines.append("- `OPENAI_API_KEY` (legacy) → Reddit threads (slower, higher cost)")
        lines.append("- Edit `~/.config/last30days/.env` to add keys")
        lines.append("---")
        lines.append("")

    # Cache indicator
    if report.from_cache:
        age_str = f"{report.cache_age_hours:.1f}h old" if report.cache_age_hours else "cached"
        lines.append(f"**⚡ CACHED RESULTS** ({age_str}) - use `--refresh` for fresh data")
        lines.append("")

    lines.append(f"**Date Range:** {report.range_from} to {report.range_to}")
    lines.append(f"**Mode:** {report.mode}")
    if report.openai_model_used:
        lines.append(f"**OpenAI Model:** {report.openai_model_used}")
    if report.xai_model_used:
        lines.append(f"**xAI Model:** {report.xai_model_used}")
    if report.resolved_x_handle:
        lines.append(f"**Resolved X Handle:** @{report.resolved_x_handle}")
    lines.append("")

    # Coverage note for partial coverage
    if report.mode == "reddit-only" and missing_keys in ("x", "none"):
        lines.append("*💡 Tip: Add an xAI key (`XAI_API_KEY`) for X/Twitter data and better triangulation.*")
        lines.append("")
    elif report.mode == "x-only" and missing_keys in ("reddit", "none"):
        lines.append("*💡 Tip: Add `SCRAPECREATORS_API_KEY` for Reddit + TikTok + Instagram data (one key, all three) and better triangulation.*")
        lines.append("")

    # Reddit items
    if report.reddit_error:
        lines.append("### Reddit Threads")
        lines.append("")
        lines.append(f"**ERROR:** {report.reddit_error}")
        lines.append("")
    elif report.mode in ("both", "reddit-only") and not report.reddit:
        lines.append("### Reddit Threads")
        lines.append("")
        lines.append("*No relevant Reddit threads found for this topic.*")
        lines.append("")
    elif report.reddit:
        lines.append("### Reddit Threads")
        lines.append("")
        for item in report.reddit[:limit]:
            eng_str = ""
            if item.engagement:
                eng = item.engagement
                parts = []
                if eng.score is not None:
                    parts.append(f"{eng.score}pts")
                if eng.num_comments is not None:
                    parts.append(f"{eng.num_comments}cmt")
                if parts:
                    eng_str = f" [{', '.join(parts)}]"

            date_str = f" ({item.date})" if item.date else " (date unknown)"
            conf_str = f" [date:{item.date_confidence}]" if item.date_confidence != "high" else ""

            lines.append(f"**{item.id}** (score:{item.score}) r/{item.subreddit}{date_str}{conf_str}{eng_str}{_xref_tag(item)}")
            lines.append(f"  {item.title}")
            lines.append(f"  {item.url}")
            lines.append(f"  *{item.why_relevant}*")

            # Top comment (elevated — Reddit's value IS the comments)
            if item.top_comments and item.top_comments[0].score >= 10:
                tc = item.top_comments[0]
                excerpt = tc.excerpt[:200]
                if len(tc.excerpt) > 200:
                    excerpt = excerpt.rstrip() + "..."
                lines.append(f'  \U0001f4ac Top comment ({tc.score} upvotes): "{excerpt}"')

            # Comment insights
            if item.comment_insights:
                lines.append("  Insights:")
                for insight in item.comment_insights[:3]:
                    lines.append(f"    - {insight}")

            lines.append("")

    # X items
    if report.x_error:
        lines.append("### X Posts")
        lines.append("")
        lines.append(f"**ERROR:** {report.x_error}")
        lines.append("")
    elif report.mode in ("both", "x-only", "all", "x-web") and not report.x:
        lines.append("### X Posts")
        lines.append("")
        lines.append("*No relevant X posts found for this topic.*")
        lines.append("")
    elif report.x:
        lines.append("### X Posts")
        lines.append("")
        for item in report.x[:limit]:
            eng_str = ""
            if item.engagement:
                eng = item.engagement
                parts = []
                if eng.likes is not None:
                    parts.append(f"{eng.likes}likes")
                if eng.reposts is not None:
                    parts.append(f"{eng.reposts}rt")
                if parts:
                    eng_str = f" [{', '.join(parts)}]"

            date_str = f" ({item.date})" if item.date else " (date unknown)"
            conf_str = f" [date:{item.date_confidence}]" if item.date_confidence != "high" else ""

            lines.append(f"**{item.id}** (score:{item.score}) @{item.author_handle}{date_str}{conf_str}{eng_str}{_xref_tag(item)}")
            lines.append(f"  {item.text[:200]}...")
            lines.append(f"  {item.url}")
            lines.append(f"  *{item.why_relevant}*")
            lines.append("")

    # YouTube items
    if report.youtube_error:
        lines.append("### YouTube Videos")
        lines.append("")
        lines.append(f"**ERROR:** {report.youtube_error}")
        lines.append("")
    elif report.youtube:
        lines.append("### YouTube Videos")
        lines.append("")
        for item in report.youtube[:limit]:
            eng_str = ""
            if item.engagement:
                eng = item.engagement
                parts = []
                if eng.views is not None:
                    parts.append(f"{eng.views:,} views")
                if eng.likes is not None:
                    parts.append(f"{eng.likes:,} likes")
                if parts:
                    eng_str = f" [{', '.join(parts)}]"

            date_str = f" ({item.date})" if item.date else ""

            lines.append(f"**{item.id}** (score:{item.score}) {item.channel_name}{date_str}{eng_str}{_xref_tag(item)}")
            lines.append(f"  {item.title}")
            lines.append(f"  {item.url}")
            if item.transcript_snippet:
                snippet = item.transcript_snippet[:200]
                if len(item.transcript_snippet) > 200:
                    snippet += "..."
                lines.append(f"  Transcript: {snippet}")
            lines.append(f"  *{item.why_relevant}*")
            lines.append("")

    # TikTok items
    if report.tiktok_error:
        lines.append("### TikTok Videos")
        lines.append("")
        lines.append(f"**ERROR:** {report.tiktok_error}")
        lines.append("")
    elif report.tiktok:
        lines.append("### TikTok Videos")
        lines.append("")
        for item in report.tiktok[:limit]:
            eng_str = ""
            if item.engagement:
                eng = item.engagement
                parts = []
                if eng.views is not None:
                    parts.append(f"{eng.views:,} views")
                if eng.likes is not None:
                    parts.append(f"{eng.likes:,} likes")
                if parts:
                    eng_str = f" [{', '.join(parts)}]"

            date_str = f" ({item.date})" if item.date else ""

            lines.append(f"**{item.id}** (score:{item.score}) @{item.author_name}{date_str}{eng_str}{_xref_tag(item)}")
            lines.append(f"  {item.text[:200]}")
            lines.append(f"  {item.url}")
            if item.caption_snippet and item.caption_snippet != item.text[:len(item.caption_snippet)]:
                snippet = item.caption_snippet[:200]
                if len(item.caption_snippet) > 200:
                    snippet += "..."
                lines.append(f"  Caption: {snippet}")
            if item.hashtags:
                lines.append(f"  Tags: {' '.join('#' + h for h in item.hashtags[:8])}")
            lines.append(f"  *{item.why_relevant}*")
            lines.append("")

    # Instagram items
    if report.instagram_error:
        lines.append("### Instagram Reels")
        lines.append("")
        lines.append(f"**ERROR:** {report.instagram_error}")
        lines.append("")
    elif report.instagram:
        lines.append("### Instagram Reels")
        lines.append("")
        for item in report.instagram[:limit]:
            eng_str = ""
            if item.engagement:
                eng = item.engagement
                parts = []
                if eng.views is not None:
                    parts.append(f"{eng.views:,} views")
                if eng.likes is not None:
                    parts.append(f"{eng.likes:,} likes")
                if parts:
                    eng_str = f" [{', '.join(parts)}]"

            date_str = f" ({item.date})" if item.date else ""

            lines.append(f"**{item.id}** (score:{item.score}) @{item.author_name}{date_str}{eng_str}{_xref_tag(item)}")
            lines.append(f"  {item.text[:200]}")
            lines.append(f"  {item.url}")
            if item.caption_snippet and item.caption_snippet != item.text[:len(item.caption_snippet)]:
                snippet = item.caption_snippet[:200]
                if len(item.caption_snippet) > 200:
                    snippet += "..."
                lines.append(f"  Caption: {snippet}")
            if item.hashtags:
                lines.append(f"  Tags: {' '.join('#' + h for h in item.hashtags[:8])}")
            lines.append(f"  *{item.why_relevant}*")
            lines.append("")

    # Hacker News items
    if report.hackernews_error:
        lines.append("### Hacker News Stories")
        lines.append("")
        lines.append(f"**ERROR:** {report.hackernews_error}")
        lines.append("")
    elif report.hackernews:
        lines.append("### Hacker News Stories")
        lines.append("")
        for item in report.hackernews[:limit]:
            eng_str = ""
            if item.engagement:
                eng = item.engagement
                parts = []
                if eng.score is not None:
                    parts.append(f"{eng.score}pts")
                if eng.num_comments is not None:
                    parts.append(f"{eng.num_comments}cmt")
                if parts:
                    eng_str = f" [{', '.join(parts)}]"

            date_str = f" ({item.date})" if item.date else ""

            lines.append(f"**{item.id}** (score:{item.score}) hn/{item.author}{date_str}{eng_str}{_xref_tag(item)}")
            lines.append(f"  {item.title}")
            lines.append(f"  {item.hn_url}")
            lines.append(f"  *{item.why_relevant}*")

            # Comment insights
            if item.comment_insights:
                lines.append(f"  Insights:")
                for insight in item.comment_insights[:3]:
                    lines.append(f"    - {insight}")

            lines.append("")

    # Bluesky items
    if report.bluesky_error:
        lines.append("### Bluesky Posts")
        lines.append("")
        lines.append(f"**ERROR:** {report.bluesky_error}")
        lines.append("")
    elif report.bluesky:
        lines.append("### Bluesky Posts")
        lines.append("")
        for item in report.bluesky[:limit]:
            eng_str = ""
            if item.engagement:
                eng = item.engagement
                parts = []
                if eng.likes is not None:
                    parts.append(f"{eng.likes}lk")
                if eng.reposts is not None:
                    parts.append(f"{eng.reposts}rp")
                if eng.replies is not None:
                    parts.append(f"{eng.replies}re")
                if parts:
                    eng_str = f" [{', '.join(parts)}]"

            date_str = f" ({item.date})" if item.date else ""

            lines.append(f"**{item.id}** (score:{item.score}) @{item.author_handle}{date_str}{eng_str}{_xref_tag(item)}")
            if item.text:
                snippet = item.text[:200]
                if len(item.text) > 200:
                    snippet += "..."
                lines.append(f"  {snippet}")
            if item.url:
                lines.append(f"  {item.url}")
            lines.append(f"  *{item.why_relevant}*")
            lines.append("")

    # Truth Social items
    if report.truthsocial_error:
        lines.append("### Truth Social Posts")
        lines.append("")
        lines.append(f"**ERROR:** {report.truthsocial_error}")
        lines.append("")
    elif report.truthsocial:
        lines.append("### Truth Social Posts")
        lines.append("")
        for item in report.truthsocial[:limit]:
            eng_str = ""
            if item.engagement:
                eng = item.engagement
                parts = []
                if eng.likes is not None:
                    parts.append(f"{eng.likes}lk")
                if eng.reposts is not None:
                    parts.append(f"{eng.reposts}rp")
                if eng.replies is not None:
                    parts.append(f"{eng.replies}re")
                if parts:
                    eng_str = f" [{', '.join(parts)}]"

            date_str = f" ({item.date})" if item.date else ""

            lines.append(f"**{item.id}** (score:{item.score}) @{item.author_handle}{date_str}{eng_str}{_xref_tag(item)}")
            if item.text:
                snippet = item.text[:200]
                if len(item.text) > 200:
                    snippet += "..."
                lines.append(f"  {snippet}")
            if item.url:
                lines.append(f"  {item.url}")
            lines.append(f"  *{item.why_relevant}*")
            lines.append("")

    # Polymarket items
    if report.polymarket_error:
        lines.append("### Prediction Markets (Polymarket)")
        lines.append("")
        lines.append(f"**ERROR:** {report.polymarket_error}")
        lines.append("")
    elif report.polymarket:
        lines.append("### Prediction Markets (Polymarket)")
        lines.append("")
        for item in report.polymarket[:limit]:
            eng_str = ""
            if item.engagement:
                eng = item.engagement
                parts = []
                if eng.volume is not None:
                    if eng.volume >= 1_000_000:
                        parts.append(f"${eng.volume/1_000_000:.1f}M volume")
                    elif eng.volume >= 1_000:
                        parts.append(f"${eng.volume/1_000:.0f}K volume")
                    else:
                        parts.append(f"${eng.volume:.0f} volume")
                if eng.liquidity is not None:
                    if eng.liquidity >= 1_000_000:
                        parts.append(f"${eng.liquidity/1_000_000:.1f}M liquidity")
                    elif eng.liquidity >= 1_000:
                        parts.append(f"${eng.liquidity/1_000:.0f}K liquidity")
                    else:
                        parts.append(f"${eng.liquidity:.0f} liquidity")
                if parts:
                    eng_str = f" [{', '.join(parts)}]"

            date_str = f" ({item.date})" if item.date else ""

            lines.append(f"**{item.id}** (score:{item.score}){eng_str}{_xref_tag(item)}")
            lines.append(f"  {item.question}")

            # Outcome prices with price movement
            if item.outcome_prices:
                outcomes = []
                for name, price in item.outcome_prices:
                    pct = price * 100
                    outcomes.append(f"{name}: {pct:.0f}%")
                outcome_line = " | ".join(outcomes)
                if item.outcomes_remaining > 0:
                    outcome_line += f" and {item.outcomes_remaining} more"
                if item.price_movement:
                    outcome_line += f" ({item.price_movement})"
                lines.append(f"  {outcome_line}")

            lines.append(f"  {item.url}")
            lines.append(f"  *{item.why_relevant}*")
            lines.append("")

    # Web items (if any - populated by the assistant)
    if report.web_error:
        lines.append("### Web Results")
        lines.append("")
        lines.append(f"**ERROR:** {report.web_error}")
        lines.append("")
    elif report.web:
        lines.append("### Web Results")
        lines.append("")
        for item in report.web[:limit]:
            date_str = f" ({item.date})" if item.date else " (date unknown)"
            conf_str = f" [date:{item.date_confidence}]" if item.date_confidence != "high" else ""

            lines.append(f"**{item.id}** [WEB] (score:{item.score}) {item.source_domain}{date_str}{conf_str}{_xref_tag(item)}")
            lines.append(f"  {item.title}")
            lines.append(f"  {item.url}")
            lines.append(f"  {item.snippet[:150]}...")
            lines.append(f"  *{item.why_relevant}*")
            lines.append("")

    return "\n".join(lines)


def render_source_status(report: schema.Report, source_info: dict = None) -> str:
    """Render source status footer showing what was used/skipped and why.

    Args:
        report: Report data
        source_info: Dict with source availability info:
            x_skip_reason, youtube_skip_reason, web_skip_reason

    Returns:
        Source status markdown string
    """
    if source_info is None:
        source_info = {}

    lines = []
    lines.append("---")
    lines.append("**Sources:**")

    # Reddit
    if report.reddit_error:
        lines.append(f"  ❌ Reddit: error — {report.reddit_error}")
    elif report.reddit:
        lines.append(f"  ✅ Reddit: {len(report.reddit)} threads")
    elif report.mode in ("both", "reddit-only", "all", "reddit-web"):
        pass  # Hide zero-result sources
    else:
        reason = source_info.get("reddit_skip_reason", "not configured")
        lines.append(f"  ⏭️ Reddit: skipped — {reason}")

    # X
    if report.x_error:
        lines.append(f"  ❌ X: error — {report.x_error}")
    elif report.x:
        x_line = f"  ✅ X: {len(report.x)} posts"
        if report.resolved_x_handle:
            x_line += f" (via @{report.resolved_x_handle} + keyword search)"
        lines.append(x_line)
    elif report.mode in ("both", "x-only", "all", "x-web"):
        pass  # Hide zero-result sources
    else:
        reason = source_info.get("x_skip_reason", "No Bird CLI or XAI_API_KEY")
        lines.append(f"  ⏭️ X: skipped — {reason}")

    # YouTube
    if report.youtube_error:
        lines.append(f"  ❌ YouTube: error — {report.youtube_error}")
    elif report.youtube:
        with_transcripts = sum(1 for v in report.youtube if getattr(v, 'transcript_snippet', None))
        lines.append(f"  ✅ YouTube: {len(report.youtube)} videos ({with_transcripts} with transcripts)")
    # Hide when zero results (no skip reason line needed)

    # TikTok
    if report.tiktok_error:
        lines.append(f"  ❌ TikTok: error — {report.tiktok_error}")
    elif report.tiktok:
        with_captions = sum(1 for v in report.tiktok if getattr(v, 'caption_snippet', None))
        lines.append(f"  ✅ TikTok: {len(report.tiktok)} videos ({with_captions} with captions)")
    # Hide when zero results

    # Instagram
    if report.instagram_error:
        lines.append(f"  ❌ Instagram: error — {report.instagram_error}")
    elif report.instagram:
        with_captions = sum(1 for v in report.instagram if getattr(v, 'caption_snippet', None))
        lines.append(f"  ✅ Instagram: {len(report.instagram)} reels ({with_captions} with captions)")
    # Hide when zero results

    # Xiaohongshu (from Web source bucket)
    xhs_count = 0
    if report.web:
        xhs_count = sum(
            1 for w in report.web
            if getattr(w, "source_domain", "").lower().endswith("xiaohongshu.com")
        )
    if xhs_count > 0:
        lines.append(f"  ✅ Xiaohongshu: {xhs_count} notes")
    else:
        reason = source_info.get("xiaohongshu_skip_reason")
        if reason:
            lines.append(f"  ⚡ Xiaohongshu: {reason}")

    # Hacker News
    if report.hackernews_error:
        lines.append(f"  ❌ HN: error - {report.hackernews_error}")
    elif report.hackernews:
        lines.append(f"  ✅ HN: {len(report.hackernews)} stories")
    # Hide when zero results

    # Bluesky
    if report.bluesky_error:
        lines.append(f"  ❌ Bluesky: error - {report.bluesky_error}")
    elif report.bluesky:
        lines.append(f"  ✅ Bluesky: {len(report.bluesky)} posts")
    # Hide when zero results

    # Truth Social
    if report.truthsocial_error:
        lines.append(f"  ❌ Truth Social: error - {report.truthsocial_error}")
    elif report.truthsocial:
        lines.append(f"  ✅ Truth Social: {len(report.truthsocial)} posts")
    # Hide when zero results

    # Polymarket
    if report.polymarket_error:
        lines.append(f"  ❌ Polymarket: error - {report.polymarket_error}")
    elif report.polymarket:
        lines.append(f"  ✅ Polymarket: {len(report.polymarket)} markets")
    # Hide when zero results

    # Web
    if report.web_error:
        lines.append(f"  ❌ Web: error — {report.web_error}")
    elif report.web:
        lines.append(f"  ✅ Web: {len(report.web)} pages")
    else:
        reason = source_info.get("web_skip_reason", "assistant will use WebSearch")
        lines.append(f"  ⚡ Web: {reason}")

    lines.append("")
    return "\n".join(lines)


def render_context_snippet(report: schema.Report) -> str:
    """Render reusable context snippet.

    Args:
        report: Report data

    Returns:
        Context markdown string
    """
    lines = []
    lines.append(f"# Context: {report.topic} (Last 30 Days)")
    lines.append("")
    lines.append(f"*Generated: {report.generated_at[:10]} | Sources: {report.mode}*")
    lines.append("")

    # Key sources summary
    lines.append("## Key Sources")
    lines.append("")

    all_items = []
    for item in report.reddit[:5]:
        all_items.append((item.score, "Reddit", item.title, item.url))
    for item in report.x[:5]:
        all_items.append((item.score, "X", item.text[:50] + "...", item.url))
    for item in report.tiktok[:5]:
        all_items.append((item.score, "TikTok", item.text[:50] + "...", item.url))
    for item in report.instagram[:5]:
        all_items.append((item.score, "Instagram", item.text[:50] + "...", item.url))
    for item in report.hackernews[:5]:
        all_items.append((item.score, "HN", item.title[:50] + "...", item.hn_url))
    for item in report.bluesky[:5]:
        all_items.append((item.score, "Bluesky", item.text[:50] + "...", item.url))
    for item in report.truthsocial[:5]:
        all_items.append((item.score, "Truth Social", item.text[:50] + "...", item.url))
    for item in report.polymarket[:5]:
        all_items.append((item.score, "Polymarket", item.question[:50] + "...", item.url))
    for item in report.web[:5]:
        all_items.append((item.score, "Web", item.title[:50] + "...", item.url))

    all_items.sort(key=lambda x: -x[0])
    for score, source, text, url in all_items[:7]:
        lines.append(f"- [{source}] {text}")

    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("*See full report for best practices, prompt pack, and detailed sources.*")
    lines.append("")

    return "\n".join(lines)


def render_full_report(report: schema.Report) -> str:
    """Render full markdown report.

    Args:
        report: Report data

    Returns:
        Full report markdown
    """
    lines = []

    # Title
    lines.append(f"# {report.topic} - Last 30 Days Research Report")
    lines.append("")
    lines.append(f"**Generated:** {report.generated_at}")
    lines.append(f"**Date Range:** {report.range_from} to {report.range_to}")
    lines.append(f"**Mode:** {report.mode}")
    lines.append("")

    # Models
    lines.append("## Models Used")
    lines.append("")
    if report.openai_model_used:
        lines.append(f"- **OpenAI:** {report.openai_model_used}")
    if report.xai_model_used:
        lines.append(f"- **xAI:** {report.xai_model_used}")
    lines.append("")

    # Reddit section
    if report.reddit:
        lines.append("## Reddit Threads")
        lines.append("")
        for item in report.reddit:
            lines.append(f"### {item.id}: {item.title}")
            lines.append("")
            lines.append(f"- **Subreddit:** r/{item.subreddit}")
            lines.append(f"- **URL:** {item.url}")
            lines.append(f"- **Date:** {item.date or 'Unknown'} (confidence: {item.date_confidence})")
            lines.append(f"- **Score:** {item.score}/100")
            lines.append(f"- **Relevance:** {item.why_relevant}")

            if item.engagement:
                eng = item.engagement
                lines.append(f"- **Engagement:** {eng.score or '?'} points, {eng.num_comments or '?'} comments")

            if item.top_comments and item.top_comments[0].score >= 10:
                tc = item.top_comments[0]
                excerpt = tc.excerpt[:200]
                if len(tc.excerpt) > 200:
                    excerpt = excerpt.rstrip() + "..."
                lines.append("")
                lines.append(f'**\U0001f4ac Top Comment** ({tc.score} upvotes, u/{tc.author}):')
                lines.append(f'> {excerpt}')

            if item.comment_insights:
                lines.append("")
                lines.append("**Key Insights from Comments:**")
                for insight in item.comment_insights:
                    lines.append(f"- {insight}")

            lines.append("")

    # X section
    if report.x:
        lines.append("## X Posts")
        lines.append("")
        for item in report.x:
            lines.append(f"### {item.id}: @{item.author_handle}")
            lines.append("")
            lines.append(f"- **URL:** {item.url}")
            lines.append(f"- **Date:** {item.date or 'Unknown'} (confidence: {item.date_confidence})")
            lines.append(f"- **Score:** {item.score}/100")
            lines.append(f"- **Relevance:** {item.why_relevant}")

            if item.engagement:
                eng = item.engagement
                lines.append(f"- **Engagement:** {eng.likes or '?'} likes, {eng.reposts or '?'} reposts")

            lines.append("")
            lines.append(f"> {item.text}")
            lines.append("")

    # TikTok section
    if report.tiktok:
        lines.append("## TikTok Videos")
        lines.append("")
        for item in report.tiktok:
            lines.append(f"### {item.id}: @{item.author_name}")
            lines.append("")
            lines.append(f"- **URL:** {item.url}")
            lines.append(f"- **Date:** {item.date or 'Unknown'}")
            lines.append(f"- **Score:** {item.score}/100")
            lines.append(f"- **Relevance:** {item.why_relevant}")

            if item.engagement:
                eng = item.engagement
                lines.append(f"- **Engagement:** {eng.views or '?'} views, {eng.likes or '?'} likes, {eng.num_comments or '?'} comments")

            if item.hashtags:
                lines.append(f"- **Hashtags:** {' '.join('#' + h for h in item.hashtags[:10])}")

            lines.append("")
            lines.append(f"> {item.text[:300]}")
            lines.append("")

    # Instagram section
    if report.instagram:
        lines.append("## Instagram Reels")
        lines.append("")
        for item in report.instagram:
            lines.append(f"### {item.id}: @{item.author_name}")
            lines.append("")
            lines.append(f"- **URL:** {item.url}")
            lines.append(f"- **Date:** {item.date or 'Unknown'}")
            lines.append(f"- **Score:** {item.score}/100")
            lines.append(f"- **Relevance:** {item.why_relevant}")

            if item.engagement:
                eng = item.engagement
                lines.append(f"- **Engagement:** {eng.views or '?'} views, {eng.likes or '?'} likes, {eng.num_comments or '?'} comments")

            if item.hashtags:
                lines.append(f"- **Hashtags:** {' '.join('#' + h for h in item.hashtags[:10])}")

            lines.append("")
            lines.append(f"> {item.text[:300]}")
            lines.append("")

    # HN section
    if report.hackernews:
        lines.append("## Hacker News Stories")
        lines.append("")
        for item in report.hackernews:
            lines.append(f"### {item.id}: {item.title}")
            lines.append("")
            lines.append(f"- **Author:** {item.author}")
            lines.append(f"- **HN URL:** {item.hn_url}")
            if item.url:
                lines.append(f"- **Article URL:** {item.url}")
            lines.append(f"- **Date:** {item.date or 'Unknown'}")
            lines.append(f"- **Score:** {item.score}/100")
            lines.append(f"- **Relevance:** {item.why_relevant}")

            if item.engagement:
                eng = item.engagement
                lines.append(f"- **Engagement:** {eng.score or '?'} points, {eng.num_comments or '?'} comments")

            if item.comment_insights:
                lines.append("")
                lines.append("**Key Insights from Comments:**")
                for insight in item.comment_insights:
                    lines.append(f"- {insight}")

            lines.append("")

    # Bluesky section
    if report.bluesky:
        lines.append("## Bluesky Posts")
        lines.append("")
        for item in report.bluesky:
            lines.append(f"### {item.id}: @{item.author_handle}")
            lines.append("")
            lines.append(f"- **URL:** {item.url}")
            lines.append(f"- **Date:** {item.date or 'Unknown'}")
            lines.append(f"- **Score:** {item.score}/100")
            lines.append(f"- **Relevance:** {item.why_relevant}")

            if item.engagement:
                eng = item.engagement
                lines.append(f"- **Engagement:** {eng.likes or '?'} likes, {eng.reposts or '?'} reposts, {eng.replies or '?'} replies")

            lines.append("")
            lines.append(f"> {item.text[:300]}")
            lines.append("")

    # Truth Social section
    if report.truthsocial:
        lines.append("## Truth Social Posts")
        lines.append("")
        for item in report.truthsocial:
            lines.append(f"### {item.id}: @{item.author_handle}")
            lines.append("")
            lines.append(f"- **URL:** {item.url}")
            lines.append(f"- **Date:** {item.date or 'Unknown'}")
            lines.append(f"- **Score:** {item.score}/100")
            lines.append(f"- **Relevance:** {item.why_relevant}")

            if item.engagement:
                eng = item.engagement
                lines.append(f"- **Engagement:** {eng.likes or '?'} likes, {eng.reposts or '?'} reposts, {eng.replies or '?'} replies")

            lines.append("")
            lines.append(f"> {item.text[:300]}")
            lines.append("")

    # Polymarket section
    if report.polymarket:
        lines.append("## Prediction Markets (Polymarket)")
        lines.append("")
        for item in report.polymarket:
            lines.append(f"### {item.id}: {item.question}")
            lines.append("")
            lines.append(f"- **Event:** {item.title}")
            lines.append(f"- **URL:** {item.url}")
            lines.append(f"- **Date:** {item.date or 'Unknown'}")
            lines.append(f"- **Score:** {item.score}/100")

            if item.outcome_prices:
                outcomes = [f"{name}: {price*100:.0f}%" for name, price in item.outcome_prices]
                lines.append(f"- **Outcomes:** {' | '.join(outcomes)}")
            if item.price_movement:
                lines.append(f"- **Trend:** {item.price_movement}")
            if item.engagement:
                eng = item.engagement
                lines.append(f"- **Volume:** ${eng.volume or 0:,.0f} | Liquidity: ${eng.liquidity or 0:,.0f}")

            lines.append("")

    # Web section
    if report.web:
        lines.append("## Web Results")
        lines.append("")
        for item in report.web:
            lines.append(f"### {item.id}: {item.title}")
            lines.append("")
            lines.append(f"- **Source:** {item.source_domain}")
            lines.append(f"- **URL:** {item.url}")
            lines.append(f"- **Date:** {item.date or 'Unknown'} (confidence: {item.date_confidence})")
            lines.append(f"- **Score:** {item.score}/100")
            lines.append(f"- **Relevance:** {item.why_relevant}")
            lines.append("")
            lines.append(f"> {item.snippet}")
            lines.append("")

    # Placeholders for assistant synthesis
    lines.append("## Best Practices")
    lines.append("")
    lines.append("*To be synthesized by assistant*")
    lines.append("")

    lines.append("## Prompt Pack")
    lines.append("")
    lines.append("*To be synthesized by assistant*")
    lines.append("")

    return "\n".join(lines)




def write_outputs(
    report: schema.Report,
    raw_openai: Optional[dict] = None,
    raw_xai: Optional[dict] = None,
    raw_reddit_enriched: Optional[list] = None,
):
    """Write all output files.

    Args:
        report: Report data
        raw_openai: Raw OpenAI API response
        raw_xai: Raw xAI API response
        raw_reddit_enriched: Raw enriched Reddit thread data
    """
    ensure_output_dir()

    # report.json
    with open(OUTPUT_DIR / "report.json", 'w') as f:
        json.dump(report.to_dict(), f, indent=2)

    # report.md
    with open(OUTPUT_DIR / "report.md", 'w') as f:
        f.write(render_full_report(report))

    # last30days.context.md
    with open(OUTPUT_DIR / "last30days.context.md", 'w') as f:
        f.write(render_context_snippet(report))

    # Raw responses
    if raw_openai:
        with open(OUTPUT_DIR / "raw_openai.json", 'w') as f:
            json.dump(raw_openai, f, indent=2)

    if raw_xai:
        with open(OUTPUT_DIR / "raw_xai.json", 'w') as f:
            json.dump(raw_xai, f, indent=2)

    if raw_reddit_enriched:
        with open(OUTPUT_DIR / "raw_reddit_threads_enriched.json", 'w') as f:
            json.dump(raw_reddit_enriched, f, indent=2)


def get_context_path() -> str:
    """Get path to context file."""
    return str(OUTPUT_DIR / "last30days.context.md")
