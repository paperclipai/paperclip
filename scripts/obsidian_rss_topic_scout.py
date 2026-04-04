#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any


DEFAULT_DASHBOARD_PATH = Path("/Users/daehan/Documents/Obsidian Vault/무제 폴더/data.json")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_pub_date(value: str | None) -> datetime | None:
    if not value:
      return None
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def normalize_title(title: str) -> str:
    lowered = title.lower().strip()
    lowered = re.sub(r"\s+", " ", lowered)
    lowered = re.sub(r"\s*[\-|·|—|:]\s*[^-|·|—|:]{1,30}$", "", lowered)
    lowered = re.sub(r"[^a-z0-9가-힣 ]+", " ", lowered)
    lowered = re.sub(r"\s+", " ", lowered).strip()
    return lowered


def keyword_hits(text: str, keywords: list[str]) -> int:
    lowered = text.lower()
    return sum(1 for keyword in keywords if keyword.lower() in lowered)


def freshness_score(pub_date: datetime | None, horizon_hours: int) -> float:
    if pub_date is None:
        return 0.0
    age_hours = max(0.0, (now_utc() - pub_date).total_seconds() / 3600)
    if age_hours <= 6:
        return 10.0
    if age_hours <= 24:
        return 8.0
    if age_hours <= 72:
        return 6.0
    if age_hours <= horizon_hours:
        return 3.0
    return 0.0


SOURCE_RULES = [
    (re.compile(r"openai|deepmind|anthropic|google|meta|apple|nvidia|microsoft|samsung", re.I), "official", 10.0),
    (re.compile(r"statnews|nature|nejm|fiercebiotech|endpts|investing|reuters|bloomberg|wsj|ft|wired|the verge", re.I), "tier_s", 8.0),
    (re.compile(r"macrumors|businesspost|global|economic|koreatimes|koreaherald|zdnet|techcrunch", re.I), "tier_a", 6.0),
]


VERTICALS: dict[str, dict[str, Any]] = {
    "ai-tech": {
        "folder_keywords": ["AI", "Tech"],
        "title_keywords": [
            "openai", "gpt", "gemini", "claude", "anthropic", "mcp", "agent",
            "meta", "apple", "samsung", "ai", "model", "glasses", "chip", "nvidia",
        ],
        "reader_keywords": ["pricing", "launch", "release", "adopt", "business", "workflow", "operator", "enterprise"],
        "bucket": "ai_updates",
    },
    "bio-pharma": {
        "folder_keywords": ["Biotech"],
        "title_keywords": [
            "drug", "trial", "clinical", "phase", "fda", "approval", "therapy", "cancer",
            "obesity", "pharma", "biotech", "임상", "신약", "승인", "치료",
        ],
        "reader_keywords": ["meaning", "risk", "readout", "approval", "safety", "efficacy", "uncertainty"],
        "bucket": "clinical_readout",
    },
    "market-stocks": {
        "folder_keywords": ["Stocks"],
        "title_keywords": [
            "stock", "shares", "earnings", "guidance", "price", "forecast", "revenue",
            "margin", "buyback", "acquisition", "catalyst", "주가", "실적", "가이던스",
        ],
        "reader_keywords": ["catalyst", "sector", "peer", "outlook", "next", "guidance", "valuation"],
        "bucket": "stock_movers",
    },
}


@dataclass
class Candidate:
    title: str
    link: str
    feed_title: str
    feed_url: str
    pub_date: str | None
    source_tier: str
    bucket: str
    score: float
    why_now: str
    topic_scorecard: dict[str, Any]


def classify_source(feed_title: str, feed_url: str) -> tuple[str, float]:
    haystack = f"{feed_title} {feed_url}"
    for pattern, tier, score in SOURCE_RULES:
        if pattern.search(haystack):
            return tier, score
    return "tier_b", 4.0


def score_item(item: dict[str, Any], feed: dict[str, Any], profile: dict[str, Any], horizon_hours: int) -> Candidate | None:
    title = (item.get("title") or "").strip()
    link = (item.get("link") or "").strip()
    if not title or not link:
        return None

    pub_date_raw = item.get("pubDate")
    pub_date = parse_pub_date(pub_date_raw)
    f_score = freshness_score(pub_date, horizon_hours)
    if f_score <= 0:
        return None

    feed_title = (feed.get("title") or item.get("feedTitle") or "").strip()
    feed_url = (feed.get("url") or item.get("feedUrl") or "").strip()
    source_tier, source_score = classify_source(feed_title, feed_url)

    title_hit_score = min(10.0, keyword_hits(title, profile["title_keywords"]) * 2.5)
    reader_hit_score = min(8.0, keyword_hits(f"{title} {(item.get('summary') or item.get('description') or '')}", profile["reader_keywords"]) * 2.0)
    structure_bonus = 2.0 if any(ch.isdigit() for ch in title) or ":" in title else 0.0
    unread_bonus = 1.0 if not item.get("read") else 0.0
    total = round(source_score + f_score + title_hit_score + reader_hit_score + structure_bonus + unread_bonus, 1)

    why_parts = [
        f"source={source_tier}",
        f"freshness={f_score:.0f}",
    ]
    if title_hit_score:
        why_parts.append(f"vertical_match={title_hit_score:.0f}")
    if reader_hit_score:
        why_parts.append(f"reader_value={reader_hit_score:.0f}")

    return Candidate(
        title=title,
        link=link,
        feed_title=feed_title,
        feed_url=feed_url,
        pub_date=pub_date_raw,
        source_tier=source_tier,
        bucket=profile["bucket"],
        score=total,
        why_now=", ".join(why_parts),
        topic_scorecard={
            "source_score": source_score,
            "freshness_score": f_score,
            "vertical_match_score": title_hit_score,
            "reader_value_score": reader_hit_score,
            "structure_bonus": structure_bonus,
            "unread_bonus": unread_bonus,
            "total": total,
        },
    )


def build_candidates(data: dict[str, Any], vertical: str, limit: int, horizon_hours: int) -> list[Candidate]:
    profile = VERTICALS[vertical]
    out: list[Candidate] = []
    seen: set[str] = set()
    for feed in data.get("feeds", []):
        items = feed.get("items") or []
        for item in items:
            candidate = score_item(item, feed, profile, horizon_hours)
            if candidate is None:
                continue
            normalized = normalize_title(candidate.title)
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            out.append(candidate)
    out.sort(key=lambda c: (-c.score, c.pub_date or "", c.title))
    return out[:limit]


def dashboard_last_updated(data: dict[str, Any]) -> datetime | None:
    values = []
    for feed in data.get("feeds", []):
        raw = feed.get("lastUpdated")
        if raw is None:
            continue
        try:
            ts = float(raw) / 1000.0
        except Exception:
            continue
        values.append(datetime.fromtimestamp(ts, tz=timezone.utc))
    if not values:
        return None
    return max(values)


def main() -> int:
    parser = argparse.ArgumentParser(description="Score topic candidates from an Obsidian RSS dashboard cache.")
    parser.add_argument("--dashboard", default=str(DEFAULT_DASHBOARD_PATH))
    parser.add_argument("--vertical", choices=sorted(VERTICALS.keys()), required=True)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--horizon-hours", type=int, default=96)
    parser.add_argument("--stale-fallback-hours", type=int, default=1000)
    parser.add_argument("--stale-warning-hours", type=int, default=24)
    parser.add_argument("--min-score", type=float, default=20.0)
    parser.add_argument("--out")
    args = parser.parse_args()

    dashboard_path = Path(args.dashboard)
    data = json.loads(dashboard_path.read_text())
    dashboard_updated_at = dashboard_last_updated(data)
    dashboard_age_hours = None
    dashboard_stale_warning = None
    if dashboard_updated_at is not None:
        dashboard_age_hours = round((now_utc() - dashboard_updated_at).total_seconds() / 3600.0, 1)
        if dashboard_age_hours > args.stale_warning_hours:
            dashboard_stale_warning = (
                f"dashboard cache is stale ({dashboard_age_hours}h old; warning threshold {args.stale_warning_hours}h)"
            )
    candidates = build_candidates(data, args.vertical, args.limit, args.horizon_hours)
    used_stale_fallback = False
    if not candidates and args.stale_fallback_hours > args.horizon_hours:
        candidates = build_candidates(data, args.vertical, args.limit, args.stale_fallback_hours)
        used_stale_fallback = bool(candidates)

    result = {
        "source": "obsidian_rss_dashboard",
        "dashboard_path": str(dashboard_path),
        "vertical": args.vertical,
        "generated_at": now_utc().isoformat(),
        "dashboard_updated_at": dashboard_updated_at.isoformat() if dashboard_updated_at else None,
        "dashboard_age_hours": dashboard_age_hours,
        "dashboard_stale_warning": dashboard_stale_warning,
        "horizon_hours": args.horizon_hours,
        "stale_fallback_hours": args.stale_fallback_hours,
        "used_stale_fallback": used_stale_fallback,
        "selected_topic": candidates[0].title if candidates else None,
        "selected_bucket": candidates[0].bucket if candidates else None,
        "selection_reason": candidates[0].why_now if candidates else "no candidates",
        "topic_scorecard": candidates[0].topic_scorecard if candidates else {},
        "passes_quality_rubric": bool(candidates and candidates[0].score >= args.min_score),
        "top10_candidates": [
            {
                "rank": idx + 1,
                "title": candidate.title,
                "why_now": candidate.why_now,
                "bucket": candidate.bucket,
                "source_tier": candidate.source_tier,
                "source_type": candidate.source_tier,
                "score": candidate.score,
                "link": candidate.link,
                "feed_title": candidate.feed_title,
                "feed_url": candidate.feed_url,
                "pub_date": candidate.pub_date,
                "topic_scorecard": candidate.topic_scorecard,
            }
            for idx, candidate in enumerate(candidates)
        ],
    }

    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload)
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
