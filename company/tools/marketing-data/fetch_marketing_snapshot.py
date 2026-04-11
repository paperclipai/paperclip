#!/usr/bin/env python3
"""
Google Ads, GA4, PostHog의 핵심 마케팅 숫자를 한 번에 가져오는 스크립트.

이 스크립트는 실제 시크릿 값을 저장소에 두지 않고, 환경변수 기준으로 동작한다.

필수 환경변수 예시:
- GOOGLE_OAUTH_CLIENT_ID
- GOOGLE_OAUTH_CLIENT_SECRET
- GOOGLE_OAUTH_REFRESH_TOKEN
- GOOGLE_ADS_DEVELOPER_TOKEN
- GOOGLE_ADS_CUSTOMER_ID
- GA4_PROPERTY_ID
- POSTHOG_HOST
- POSTHOG_PROJECT_ID
- POSTHOG_PERSONAL_API_KEY
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/145.0.0.0 Safari/537.36"
)

GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_ADS_BASE = "https://googleads.googleapis.com/v23"
GA4_BASE = "https://analyticsdata.googleapis.com/v1beta"


class SkipService(RuntimeError):
    """필수 자격증명이 없어 서비스를 건너뛸 때 사용."""


def request_json(
    method: str,
    url: str,
    *,
    headers: Optional[Dict[str, str]] = None,
    json_data: Optional[Dict[str, Any]] = None,
    form_data: Optional[Dict[str, Any]] = None,
) -> Any:
    payload = None
    merged_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
    }
    if headers:
        merged_headers.update(headers)

    if json_data is not None:
        payload = json.dumps(json_data).encode("utf-8")
        merged_headers.setdefault("Content-Type", "application/json")
    elif form_data is not None:
        payload = urllib.parse.urlencode(form_data).encode("utf-8")
        merged_headers.setdefault(
            "Content-Type", "application/x-www-form-urlencoded"
        )

    request = urllib.request.Request(
        url,
        data=payload,
        headers=merged_headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} 실패: {exc.code} {body}") from exc

    if not body:
        return {}
    return json.loads(body)


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SkipService(f"{name} 가 비어 있어 연결을 건너뜁니다.")
    return value


def get_google_access_token() -> str:
    client_id = require_env("GOOGLE_OAUTH_CLIENT_ID")
    client_secret = require_env("GOOGLE_OAUTH_CLIENT_SECRET")
    refresh_token = require_env("GOOGLE_OAUTH_REFRESH_TOKEN")
    response = request_json(
        "POST",
        GOOGLE_OAUTH_TOKEN_URL,
        form_data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
    )
    access_token = response.get("access_token")
    if not access_token:
        raise RuntimeError("Google OAuth access token을 가져오지 못했습니다.")
    return access_token


def parse_int(value: Any) -> int:
    if value in (None, ""):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).replace(",", "").strip()
    if not text:
        return 0
    if "." in text:
        return int(float(text))
    return int(text)


def parse_float(value: Any) -> float:
    if value in (None, ""):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return float(str(value).replace(",", "").strip())


def end_date_exclusive(to_date: str) -> str:
    date_value = dt.date.fromisoformat(to_date)
    return (date_value + dt.timedelta(days=1)).isoformat()


def hogql_string(value: str) -> str:
    """Return a single-quoted HogQL string literal."""
    escaped = value.replace("\\", "\\\\").replace("'", "\\'")
    return f"'{escaped}'"


def fetch_google_ads(from_date: str, to_date: str) -> Dict[str, Any]:
    access_token = get_google_access_token()
    customer_id = require_env("GOOGLE_ADS_CUSTOMER_ID").replace("-", "")
    developer_token = require_env("GOOGLE_ADS_DEVELOPER_TOKEN")
    login_customer_id = os.getenv("GOOGLE_ADS_LOGIN_CUSTOMER_ID", "").replace("-", "")

    query = os.getenv(
        "GOOGLE_ADS_QUERY",
        (
            "SELECT "
            "campaign.id, campaign.name, campaign.status, "
            "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions "
            "FROM campaign "
            f"WHERE segments.date BETWEEN '{from_date}' AND '{to_date}' "
            "ORDER BY metrics.cost_micros DESC "
            "LIMIT 20"
        ),
    )

    headers = {
        "Authorization": f"Bearer {access_token}",
        "developer-token": developer_token,
    }
    if login_customer_id:
        headers["login-customer-id"] = login_customer_id

    response = request_json(
        "POST",
        f"{GOOGLE_ADS_BASE}/customers/{customer_id}/googleAds:searchStream",
        headers=headers,
        json_data={"query": query},
    )

    campaigns: List[Dict[str, Any]] = []
    totals = {
        "impressions": 0,
        "clicks": 0,
        "cost_micros": 0,
        "conversions": 0.0,
    }

    for chunk in response:
        for row in chunk.get("results", []):
            campaign = row.get("campaign", {})
            metrics = row.get("metrics", {})
            item = {
                "campaign_id": campaign.get("id"),
                "campaign_name": campaign.get("name"),
                "status": campaign.get("status"),
                "impressions": parse_int(metrics.get("impressions")),
                "clicks": parse_int(metrics.get("clicks")),
                "cost_micros": parse_int(metrics.get("costMicros")),
                "conversions": parse_float(metrics.get("conversions")),
            }
            campaigns.append(item)
            totals["impressions"] += item["impressions"]
            totals["clicks"] += item["clicks"]
            totals["cost_micros"] += item["cost_micros"]
            totals["conversions"] += item["conversions"]

    return {
        "status": "ok",
        "customer_id": customer_id,
        "date_range": {"from_date": from_date, "to_date": to_date},
        "totals": {
            "impressions": totals["impressions"],
            "clicks": totals["clicks"],
            "cost": round(totals["cost_micros"] / 1_000_000, 2),
            "conversions": round(totals["conversions"], 2),
        },
        "campaigns": campaigns,
    }


def fetch_ga4(from_date: str, to_date: str) -> Dict[str, Any]:
    access_token = get_google_access_token()
    property_id = require_env("GA4_PROPERTY_ID")
    headers = {"Authorization": f"Bearer {access_token}"}
    url = f"{GA4_BASE}/properties/{property_id}:runReport"

    summary = request_json(
        "POST",
        url,
        headers=headers,
        json_data={
            "dateRanges": [{"startDate": from_date, "endDate": to_date}],
            "metrics": [
                {"name": "sessions"},
                {"name": "totalUsers"},
                {"name": "eventCount"},
            ],
        },
    )

    by_source = request_json(
        "POST",
        url,
        headers=headers,
        json_data={
            "dateRanges": [{"startDate": from_date, "endDate": to_date}],
            "dimensions": [{"name": "sessionSourceMedium"}],
            "metrics": [
                {"name": "sessions"},
                {"name": "totalUsers"},
                {"name": "eventCount"},
            ],
            "limit": 10,
            "orderBys": [
                {
                    "metric": {"metricName": "sessions"},
                    "desc": True,
                }
            ],
        },
    )

    totals = {}
    rows = summary.get("rows") or []
    if rows:
        metric_values = rows[0].get("metricValues", [])
        metric_headers = summary.get("metricHeaders", [])
        for index, header in enumerate(metric_headers):
            totals[header.get("name", f"metric_{index}")] = metric_values[index].get(
                "value"
            )

    sources = []
    for row in by_source.get("rows") or []:
        dim_values = row.get("dimensionValues", [])
        metric_values = row.get("metricValues", [])
        sources.append(
            {
                "session_source_medium": dim_values[0].get("value", "")
                if dim_values
                else "",
                "sessions": metric_values[0].get("value", "0")
                if len(metric_values) > 0
                else "0",
                "total_users": metric_values[1].get("value", "0")
                if len(metric_values) > 1
                else "0",
                "event_count": metric_values[2].get("value", "0")
                if len(metric_values) > 2
                else "0",
            }
        )

    return {
        "status": "ok",
        "property_id": property_id,
        "date_range": {"from_date": from_date, "to_date": to_date},
        "totals": totals,
        "top_sources": sources,
    }


def normalize_posthog_rows(response: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = response.get("results") or []
    columns = response.get("columns") or []
    if rows and isinstance(rows[0], dict):
        return rows
    if rows and columns:
        normalized = []
        for row in rows:
            normalized.append(
                {columns[index]: value for index, value in enumerate(row)}
            )
        return normalized
    return []


def fetch_posthog(from_date: str, to_date: str) -> Dict[str, Any]:
    host = require_env("POSTHOG_HOST").rstrip("/")
    project_id = require_env("POSTHOG_PROJECT_ID")
    personal_api_key = require_env("POSTHOG_PERSONAL_API_KEY")
    key_events = [
        event.strip()
        for event in os.getenv(
            "POSTHOG_KEY_EVENTS",
            "contact_submitted,signup_completed,workflow_completed,value_delivered",
        ).split(",")
        if event.strip()
    ]

    headers = {"Authorization": f"Bearer {personal_api_key}"}
    url = f"{host}/api/projects/{project_id}/query/"
    end_exclusive = end_date_exclusive(to_date)

    event_list_sql = ", ".join(hogql_string(event) for event in key_events)
    events_response = request_json(
        "POST",
        url,
        headers=headers,
        json_data={
            "name": "key marketing events",
            "query": {
                "kind": "HogQLQuery",
                "query": (
                    "select event, count() as event_count "
                    "from events "
                    f"where timestamp >= toDateTime('{from_date} 00:00:00') "
                    f"and timestamp < toDateTime('{end_exclusive} 00:00:00') "
                    f"and event in ({event_list_sql}) "
                    "group by event "
                    "order by event_count desc"
                ),
            },
        },
    )

    pageview_response = request_json(
        "POST",
        url,
        headers=headers,
        json_data={
            "name": "pageview count",
            "query": {
                "kind": "HogQLQuery",
                "query": (
                    "select count() as pageviews "
                    "from events "
                    f"where timestamp >= toDateTime('{from_date} 00:00:00') "
                    f"and timestamp < toDateTime('{end_exclusive} 00:00:00') "
                    "and event = '$pageview'"
                ),
            },
        },
    )

    key_event_rows = normalize_posthog_rows(events_response)
    pageview_rows = normalize_posthog_rows(pageview_response)
    pageviews = 0
    if pageview_rows:
        row = pageview_rows[0]
        pageviews = parse_int(row.get("pageviews"))

    return {
        "status": "ok",
        "project_id": project_id,
        "host": host,
        "date_range": {"from_date": from_date, "to_date": to_date},
        "pageviews": pageviews,
        "key_events": key_event_rows,
    }


def fetch_services(services: Iterable[str], from_date: str, to_date: str) -> Dict[str, Any]:
    output: Dict[str, Any] = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "date_range": {"from_date": from_date, "to_date": to_date},
        "services": {},
    }
    for service in services:
        try:
            if service == "google_ads":
                output["services"][service] = fetch_google_ads(from_date, to_date)
            elif service == "ga4":
                output["services"][service] = fetch_ga4(from_date, to_date)
            elif service == "posthog":
                output["services"][service] = fetch_posthog(from_date, to_date)
            else:
                output["services"][service] = {
                    "status": "skipped",
                    "reason": f"지원하지 않는 서비스: {service}",
                }
        except SkipService as exc:
            output["services"][service] = {"status": "skipped", "reason": str(exc)}
        except Exception as exc:  # pylint: disable=broad-except
            output["services"][service] = {"status": "error", "reason": str(exc)}
    return output


def render_markdown(data: Dict[str, Any]) -> str:
    lines = [
        "# 마케팅 스냅샷",
        "",
        f"- 기준 기간: `{data['date_range']['from_date']} ~ {data['date_range']['to_date']}`",
        f"- 생성 시각(UTC): `{data['generated_at']}`",
        "",
    ]

    ads = data["services"].get("google_ads", {})
    lines.append("## Google Ads")
    if ads.get("status") == "ok":
        totals = ads.get("totals", {})
        lines.extend(
            [
                f"- 고객 ID: `{ads.get('customer_id', '')}`",
                f"- 노출수: `{totals.get('impressions', 0)}`",
                f"- 클릭수: `{totals.get('clicks', 0)}`",
                f"- 비용: `{totals.get('cost', 0)}`",
                f"- 전환: `{totals.get('conversions', 0)}`",
                "- 상위 캠페인:",
            ]
        )
        for campaign in ads.get("campaigns", [])[:5]:
            lines.append(
                "  - "
                f"{campaign['campaign_name']} | 비용 `{round(campaign['cost_micros'] / 1_000_000, 2)}` "
                f"| 클릭 `{campaign['clicks']}` | 전환 `{campaign['conversions']}`"
            )
    else:
        lines.append(f"- 상태: `{ads.get('status', 'unknown')}`")
        if ads.get("reason"):
            lines.append(f"- 사유: {ads['reason']}")
    lines.append("")

    ga4 = data["services"].get("ga4", {})
    lines.append("## GA4")
    if ga4.get("status") == "ok":
        totals = ga4.get("totals", {})
        lines.extend(
            [
                f"- Property ID: `{ga4.get('property_id', '')}`",
                f"- 세션: `{totals.get('sessions', 0)}`",
                f"- 총 사용자: `{totals.get('totalUsers', 0)}`",
                f"- 이벤트 수: `{totals.get('eventCount', 0)}`",
                "- 상위 source / medium:",
            ]
        )
        for source in ga4.get("top_sources", [])[:5]:
            lines.append(
                "  - "
                f"{source['session_source_medium']} | 세션 `{source['sessions']}` "
                f"| 사용자 `{source['total_users']}` | 이벤트 `{source['event_count']}`"
            )
    else:
        lines.append(f"- 상태: `{ga4.get('status', 'unknown')}`")
        if ga4.get("reason"):
            lines.append(f"- 사유: {ga4['reason']}")
    lines.append("")

    posthog = data["services"].get("posthog", {})
    lines.append("## PostHog")
    if posthog.get("status") == "ok":
        lines.extend(
            [
                f"- Project ID: `{posthog.get('project_id', '')}`",
                f"- Host: `{posthog.get('host', '')}`",
                f"- 페이지뷰: `{posthog.get('pageviews', 0)}`",
                "- 핵심 이벤트:",
            ]
        )
        for row in posthog.get("key_events", [])[:10]:
            lines.append(
                "  - "
                f"{row.get('event', '')} | `{row.get('event_count', 0)}`"
            )
    else:
        lines.append(f"- 상태: `{posthog.get('status', 'unknown')}`")
        if posthog.get("reason"):
            lines.append(f"- 사유: {posthog['reason']}")
    lines.append("")

    return "\n".join(lines)


def maybe_save(save_dir: Optional[str], data: Dict[str, Any], markdown: str) -> None:
    if not save_dir:
        return
    path = pathlib.Path(save_dir)
    path.mkdir(parents=True, exist_ok=True)
    (path / "marketing-snapshot.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (path / "marketing-snapshot.md").write_text(markdown, encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="마케팅 스냅샷 수집")
    parser.add_argument("--from-date", required=True, help="YYYY-MM-DD")
    parser.add_argument("--to-date", required=True, help="YYYY-MM-DD")
    parser.add_argument(
        "--services",
        default="google_ads,ga4,posthog",
        help="쉼표로 구분한 서비스 목록",
    )
    parser.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        help="출력 형식",
    )
    parser.add_argument("--save-dir", help="스냅샷 저장 경로")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    services = [service.strip() for service in args.services.split(",") if service.strip()]
    data = fetch_services(services, args.from_date, args.to_date)
    markdown = render_markdown(data)
    maybe_save(args.save_dir, data, markdown)

    if args.format == "json":
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(markdown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
