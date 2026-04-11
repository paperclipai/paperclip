#!/usr/bin/env python3
import argparse
import json
import os
import urllib.parse
import urllib.request


TOKEN_URL = "https://oauth2.googleapis.com/token"
DRIVE_API_ROOT = "https://www.googleapis.com/drive/v3"


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"환경변수 {name} 이(가) 비어 있습니다.")
    return value


def get_access_token() -> str:
    client_id = required_env("GOOGLE_DRIVE_CLIENT_ID")
    client_secret = required_env("GOOGLE_DRIVE_CLIENT_SECRET")
    refresh_token = required_env("GOOGLE_DRIVE_REFRESH_TOKEN")

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
        raise SystemExit("Google Drive access token 발급에 실패했습니다.")
    return token


def api_request(path: str, method: str = "GET", query=None):
    token = get_access_token()
    url = f"{DRIVE_API_ROOT}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"}, method=method)
    with urllib.request.urlopen(req) as response:
        return json.load(response)


def raw_request(url: str):
    token = get_access_token()
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as response:
        return response.read().decode("utf-8")


def print_files(items):
    for item in items:
        print(
            json.dumps(
                {
                    "id": item.get("id"),
                    "name": item.get("name"),
                    "mimeType": item.get("mimeType"),
                    "modifiedTime": item.get("modifiedTime"),
                    "owners": [owner.get("emailAddress") for owner in item.get("owners", [])],
                    "webViewLink": item.get("webViewLink"),
                },
                ensure_ascii=False,
            )
        )


def cmd_list(args):
    query = {
        "pageSize": args.page_size,
        "orderBy": "modifiedTime desc",
        "fields": "files(id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink)",
        "q": "trashed = false",
    }
    if args.folder_id:
        query["q"] = f"'{args.folder_id}' in parents and trashed = false"
    data = api_request("/files", query=query)
    print_files(data.get("files", []))


def cmd_search(args):
    safe_query = args.query.replace("'", "\\'")
    query = {
        "pageSize": args.page_size,
        "orderBy": "modifiedTime desc",
        "fields": "files(id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink)",
        "q": f"name contains '{safe_query}' and trashed = false",
    }
    data = api_request("/files", query=query)
    print_files(data.get("files", []))


def cmd_get(args):
    data = api_request(
        f"/files/{urllib.parse.quote(args.file_id, safe='')}",
        query={"fields": "id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,parents,size"},
    )
    print(json.dumps(data, ensure_ascii=False, indent=2))


def cmd_export_text(args):
    url = f"https://www.googleapis.com/drive/v3/files/{urllib.parse.quote(args.file_id, safe='')}/export?mimeType=text/plain"
    text = raw_request(url)
    print(text)


def build_parser():
    parser = argparse.ArgumentParser(description="Google Drive CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="파일 목록")
    list_parser.add_argument("--folder-id", default=None)
    list_parser.add_argument("--page-size", type=int, default=30)
    list_parser.set_defaults(func=cmd_list)

    search_parser = subparsers.add_parser("search", help="파일 검색")
    search_parser.add_argument("--query", required=True)
    search_parser.add_argument("--page-size", type=int, default=20)
    search_parser.set_defaults(func=cmd_search)

    get_parser = subparsers.add_parser("get", help="파일 메타데이터")
    get_parser.add_argument("--file-id", required=True)
    get_parser.set_defaults(func=cmd_get)

    export_parser = subparsers.add_parser("export-text", help="Google Docs를 텍스트로 export")
    export_parser.add_argument("--file-id", required=True)
    export_parser.set_defaults(func=cmd_export_text)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
