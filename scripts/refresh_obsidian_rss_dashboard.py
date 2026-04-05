#!/usr/bin/env python3
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit


DEFAULT_DASHBOARD_PATH = Path("/Users/daehan/Documents/Obsidian Vault/무제 폴더/data.json")
VERTICAL_FOLDER_KEYWORDS = {
    "ai-tech": ["AI", "Tech"],
    "bio-pharma": ["Biotech"],
    "market-stocks": ["Stocks"],
}

FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; Paperclip-RSS-Refresh/1.0)",
    "Accept": "application/rss+xml, application/xml, text/xml, */*",
}
FETCH_TIMEOUT = 12
SAFE_URL_PATH = "/%:@-._~!$&'()*+,;="
SAFE_URL_QUERY = "=&%:+-._~!$'()*;,/?:@"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Refresh Obsidian RSS dashboard data.json in place.")
    parser.add_argument("--dashboard-path", default=str(DEFAULT_DASHBOARD_PATH))
    parser.add_argument("--out")
    parser.add_argument("--max-items-per-feed", type=int, default=25)
    parser.add_argument("--limit-feeds", type=int, default=0)
    parser.add_argument("--vertical", choices=sorted(VERTICAL_FOLDER_KEYWORDS.keys()))
    parser.add_argument("--workers", type=int, default=8)
    return parser.parse_args()


def encode_request_url(url: str) -> str:
    parts = urlsplit(url.strip())
    return urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            quote(parts.path, safe=SAFE_URL_PATH),
            quote(parts.query, safe=SAFE_URL_QUERY),
            quote(parts.fragment, safe=SAFE_URL_QUERY),
        )
    )


def xml_text(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return (el.text or "").strip()


def fetch_feed_items(feed: dict[str, Any], max_items: int) -> tuple[list[dict[str, Any]], str | None]:
    url = str(feed.get("url", "")).strip()
    if not url:
      return [], "missing_url"

    try:
        request_url = encode_request_url(url)
        req = urllib.request.Request(request_url, headers=FETCH_HEADERS)
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw = resp.read()
    except Exception as exc:
        return [], f"fetch_error:{exc}"

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        return [], f"parse_error:{exc}"

    ns = ""
    if root.tag.startswith("{"):
        ns = root.tag.split("}")[0] + "}"

    channel_found = root.find(f"{ns}channel")
    channel = channel_found if channel_found is not None else root
    raw_items = channel.findall(f"{ns}item")
    if not raw_items:
        atom_ns = "http://www.w3.org/2005/Atom"
        raw_items = root.findall(f"{{{atom_ns}}}entry")

    items: list[dict[str, Any]] = []
    for el in raw_items[:max_items]:
        title = xml_text(el.find(f"{ns}title"))
        link_el = el.find(f"{ns}link")
        link = ""
        if link_el is not None:
            link = (link_el.text or link_el.get("href", "")).strip()
        guid = xml_text(el.find(f"{ns}guid")) or link
        pub_date = xml_text(el.find(f"{ns}pubDate")) or xml_text(el.find(f"{ns}updated"))
        description = xml_text(el.find(f"{ns}description")) or xml_text(el.find(f"{ns}summary"))
        author = xml_text(el.find(f"{ns}author"))
        if not title or not link:
            continue
        items.append(
            {
                "title": title,
                "link": link,
                "guid": guid or link,
                "pubDate": pub_date,
                "summary": description,
                "description": description,
                "author": author,
                "read": False,
                "starred": False,
            }
        )
    return items, None


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def main() -> int:
    args = parse_args()
    dashboard_path = Path(args.dashboard_path)
    data = json.loads(dashboard_path.read_text(encoding="utf-8"))
    feeds = data.get("feeds") or []
    if not isinstance(feeds, list):
        raise ValueError("dashboard_feeds_missing")

    now_ms = int(time.time() * 1000)
    updated = 0
    failed = 0
    failures: list[dict[str, Any]] = []
    processed_feeds = 0
    folder_keywords = VERTICAL_FOLDER_KEYWORDS.get(args.vertical or "", [])

    selected_feeds: list[dict[str, Any]] = []
    for feed in feeds:
        if not isinstance(feed, dict):
            continue
        folder = str(feed.get("folder", "")).strip()
        if folder_keywords and not any(keyword.lower() in folder.lower() for keyword in folder_keywords):
            continue
        selected_feeds.append(feed)
        if args.limit_feeds and len(selected_feeds) >= args.limit_feeds:
            break

    processed_feeds = len(selected_feeds)

    def worker(feed: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]], str | None]:
        max_items = int(feed.get("maxItemsLimit") or args.max_items_per_feed or 25)
        items, error = fetch_feed_items(feed, max_items)
        return feed, items, error

    with ThreadPoolExecutor(max_workers=max(1, int(args.workers or 8))) as executor:
        futures = [executor.submit(worker, feed) for feed in selected_feeds]
        for future in as_completed(futures):
            feed, items, error = future.result()
            if error:
                failed += 1
                failures.append(
                    {
                        "feed_title": str(feed.get("title", "")).strip(),
                        "feed_url": str(feed.get("url", "")).strip(),
                        "error": error,
                    }
                )
                continue
            feed["items"] = items
            feed["lastUpdated"] = now_ms
            updated += 1

    write_json_atomic(dashboard_path, data)

    result = {
        "ok": True,
        "dashboard_path": str(dashboard_path),
        "updated_feed_count": updated,
        "failed_feed_count": failed,
        "processed_feed_count": processed_feeds,
        "failures": failures[:20],
        "refreshed_at": now_ms,
    }

    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload, encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
