#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request


TOKEN_URL = "https://oauth2.googleapis.com/token"
CALENDAR_API_ROOT = "https://www.googleapis.com/calendar/v3"


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"환경변수 {name} 이(가) 비어 있습니다.")
    return value


def get_access_token() -> str:
    client_id = required_env("GOOGLE_CALENDAR_CLIENT_ID")
    client_secret = required_env("GOOGLE_CALENDAR_CLIENT_SECRET")
    refresh_token = required_env("GOOGLE_CALENDAR_REFRESH_TOKEN")

    payload = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        TOKEN_URL,
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req) as response:
        data = json.load(response)
    token = data.get("access_token")
    if not token:
        raise SystemExit("Google access token 발급에 실패했습니다.")
    return token


def api_request(path: str, method: str = "GET", query=None, body=None):
    token = get_access_token()
    url = f"{CALENDAR_API_ROOT}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)

    data = None
    headers = {"Authorization": f"Bearer {token}"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as response:
        return json.load(response)


def cmd_calendars(_args):
    data = api_request("/users/me/calendarList")
    items = data.get("items", [])
    for item in items:
        print(
            json.dumps(
                {
                    "id": item.get("id"),
                    "summary": item.get("summary"),
                    "primary": item.get("primary", False),
                    "timeZone": item.get("timeZone"),
                },
                ensure_ascii=False,
            )
        )


def cmd_list(args):
    calendar_id = args.calendar_id or os.getenv("GOOGLE_CALENDAR_PRIMARY_ID", "primary")
    query = {
        "singleEvents": "true",
        "orderBy": "startTime",
        "timeMin": args.from_date,
        "timeMax": args.to_date,
    }
    data = api_request(f"/calendars/{urllib.parse.quote(calendar_id, safe='')}/events", query=query)
    items = data.get("items", [])
    for item in items:
        start = item.get("start", {}).get("dateTime") or item.get("start", {}).get("date")
        end = item.get("end", {}).get("dateTime") or item.get("end", {}).get("date")
        print(
            json.dumps(
                {
                    "id": item.get("id"),
                    "summary": item.get("summary"),
                    "status": item.get("status"),
                    "start": start,
                    "end": end,
                    "htmlLink": item.get("htmlLink"),
                },
                ensure_ascii=False,
            )
        )


def cmd_insert(args):
    calendar_id = args.calendar_id or os.getenv("GOOGLE_CALENDAR_PRIMARY_ID", "primary")
    timezone = args.timezone or os.getenv("GOOGLE_CALENDAR_TIMEZONE", "Asia/Seoul")
    body = {
        "summary": args.summary,
        "start": {"dateTime": args.start, "timeZone": timezone},
        "end": {"dateTime": args.end, "timeZone": timezone},
    }
    if args.description:
        body["description"] = args.description
    if args.location:
        body["location"] = args.location

    result = api_request(
        f"/calendars/{urllib.parse.quote(calendar_id, safe='')}/events",
        method="POST",
        body=body,
    )
    print(
        json.dumps(
            {
                "id": result.get("id"),
                "summary": result.get("summary"),
                "htmlLink": result.get("htmlLink"),
                "start": result.get("start", {}).get("dateTime"),
                "end": result.get("end", {}).get("dateTime"),
            },
            ensure_ascii=False,
        )
    )


def build_parser():
    parser = argparse.ArgumentParser(description="Google Calendar CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    calendars_parser = subparsers.add_parser("calendars", help="캘린더 목록 조회")
    calendars_parser.set_defaults(func=cmd_calendars)

    list_parser = subparsers.add_parser("list", help="일정 목록 조회")
    list_parser.add_argument("--calendar-id", default=None)
    list_parser.add_argument("--from-date", required=True, help="RFC3339, 예: 2026-03-16T00:00:00+09:00")
    list_parser.add_argument("--to-date", required=True, help="RFC3339, 예: 2026-03-17T00:00:00+09:00")
    list_parser.set_defaults(func=cmd_list)

    insert_parser = subparsers.add_parser("insert", help="일정 추가")
    insert_parser.add_argument("--calendar-id", default=None)
    insert_parser.add_argument("--summary", required=True)
    insert_parser.add_argument("--start", required=True, help="RFC3339, 예: 2026-03-17T15:00:00+09:00")
    insert_parser.add_argument("--end", required=True, help="RFC3339, 예: 2026-03-17T16:00:00+09:00")
    insert_parser.add_argument("--description", default=None)
    insert_parser.add_argument("--location", default=None)
    insert_parser.add_argument("--timezone", default=None)
    insert_parser.set_defaults(func=cmd_insert)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
