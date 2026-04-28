#!/usr/bin/env python3
"""
Subscriber attribution report — queries Supabase email_waitlist.

Usage:
    python subscriber_report.py
    python subscriber_report.py --since 2026-04-01
    python subscriber_report.py --since 2026-04-01 --campaign pi-phase2
    python subscriber_report.py --since 2026-04-01 --json

Requires env:
    SUPABASE_URL       e.g. https://xxxx.supabase.co
    SUPABASE_SERVICE_KEY   service role key (for read access — do not use anon key here)
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone


def env(name: str) -> str:
    v = os.environ.get(name, "")
    if not v:
        raise RuntimeError(
            f"Missing required env var: {name}\n"
            "Copy scripts/integrations/.env.local.example → .env.local and fill in Supabase values."
        )
    return v


def load_dotenv() -> None:
    """Load .env.local from the integrations directory if present."""
    env_path = os.path.join(os.path.dirname(__file__), ".env.local")
    if not os.path.exists(env_path):
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def supabase_get(path: str, params: dict | None = None) -> list[dict]:
    url_str = env("SUPABASE_URL").rstrip("/") + path
    if params:
        url_str += "?" + urllib.parse.urlencode(params)
    key = env("SUPABASE_SERVICE_KEY")
    req = urllib.request.Request(
        url_str,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"Supabase {e.code} GET {path}: {body[:300]}")


def fetch_rows(since: str | None, campaign: str | None) -> list[dict]:
    params: dict = {"select": "email,campaign_id,utm_source,utm_medium,utm_campaign,created_at"}
    if since:
        params["created_at"] = f"gte.{since}"
    if campaign:
        params["utm_campaign"] = f"eq.{campaign}"
    params["order"] = "created_at.desc"
    params["limit"] = "5000"
    return supabase_get("/rest/v1/email_waitlist", params)


def build_report(rows: list[dict], since: str | None, campaign: str | None) -> dict:
    total = len(rows)
    by_campaign: dict[str, int] = {}
    by_source: dict[str, int] = {}
    by_page: dict[str, int] = {}
    by_day: dict[str, int] = {}

    for r in rows:
        camp = r.get("utm_campaign") or r.get("campaign_id") or "(none)"
        src = r.get("utm_source") or "(direct)"
        page = r.get("campaign_id") or "(unknown)"
        ts = r.get("created_at", "")
        day = ts[:10] if ts else "(unknown)"

        by_campaign[camp] = by_campaign.get(camp, 0) + 1
        by_source[src] = by_source.get(src, 0) + 1
        by_page[page] = by_page.get(page, 0) + 1
        by_day[day] = by_day.get(day, 0) + 1

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "filters": {"since": since, "campaign": campaign},
        "total": total,
        "by_campaign": dict(sorted(by_campaign.items(), key=lambda x: -x[1])),
        "by_source": dict(sorted(by_source.items(), key=lambda x: -x[1])),
        "by_page": dict(sorted(by_page.items(), key=lambda x: -x[1])),
        "by_day": dict(sorted(by_day.items())),
    }


def print_report(report: dict) -> None:
    filters = report["filters"]
    since_str = f" since {filters['since']}" if filters.get("since") else ""
    camp_str = f" campaign={filters['campaign']}" if filters.get("campaign") else ""
    print(f"\n=== Subscriber Report{since_str}{camp_str} ===")
    print(f"Generated: {report['generated_at']}")
    print(f"\nTotal signups: {report['total']}")

    if report["by_campaign"]:
        print("\nBy campaign (utm_campaign):")
        for k, v in report["by_campaign"].items():
            print(f"  {k:<35} {v:>5}")

    if report["by_source"]:
        print("\nBy source (utm_source):")
        for k, v in report["by_source"].items():
            print(f"  {k:<35} {v:>5}")

    if report["by_page"]:
        print("\nBy product page:")
        for k, v in report["by_page"].items():
            print(f"  {k:<35} {v:>5}")

    if report["by_day"]:
        print("\nBy day:")
        for k, v in report["by_day"].items():
            print(f"  {k}  {v:>5}")
    print()


def main() -> int:
    load_dotenv()

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--since", metavar="YYYY-MM-DD", help="Only include rows created on or after this date (UTC)")
    parser.add_argument("--campaign", metavar="SLUG", help="Filter by utm_campaign value")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Output raw JSON instead of formatted report")
    args = parser.parse_args()

    rows = fetch_rows(args.since, args.campaign)
    report = build_report(rows, args.since, args.campaign)

    if args.as_json:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        print_report(report)

    return 0 if report["total"] >= 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
