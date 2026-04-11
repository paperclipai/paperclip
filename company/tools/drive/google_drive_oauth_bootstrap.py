#!/usr/bin/env python3
import http.server
import json
import os
import threading
import urllib.parse
import urllib.request
import webbrowser


AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REDIRECT_HOST = "127.0.0.1"
REDIRECT_PORT = 8766
REDIRECT_URI = f"http://{REDIRECT_HOST}:{REDIRECT_PORT}/callback"
SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
]


def required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise SystemExit(f"환경변수 {name} 이(가) 비어 있습니다.")
    return value


class CallbackHandler(http.server.BaseHTTPRequestHandler):
    code = None
    error = None
    done = threading.Event()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        CallbackHandler.code = query.get("code", [None])[0]
        CallbackHandler.error = query.get("error", [None])[0]

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        if CallbackHandler.code:
            self.wfile.write(
                "<html><body><h2>Drive 인증이 완료되었습니다.</h2><p>터미널로 돌아가세요.</p></body></html>".encode(
                    "utf-8"
                )
            )
        else:
            self.wfile.write(
                "<html><body><h2>Drive 인증에 실패했습니다.</h2><p>터미널 출력을 확인하세요.</p></body></html>".encode(
                    "utf-8"
                )
            )
        CallbackHandler.done.set()

    def log_message(self, format, *args):
        return


def exchange_code(code: str, client_id: str, client_secret: str):
    payload = urllib.parse.urlencode(
        {
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": REDIRECT_URI,
            "grant_type": "authorization_code",
        }
    ).encode("utf-8")

    request = urllib.request.Request(
        TOKEN_URL,
        data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def main():
    client_id = required_env("GOOGLE_DRIVE_CLIENT_ID")
    client_secret = required_env("GOOGLE_DRIVE_CLIENT_SECRET")

    params = {
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
    }
    auth_url = f"{AUTH_URL}?{urllib.parse.urlencode(params)}"

    server = http.server.HTTPServer((REDIRECT_HOST, REDIRECT_PORT), CallbackHandler)
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()

    print("아래 URL로 Drive 인증을 시작합니다.")
    print(auth_url)
    webbrowser.open(auth_url)

    CallbackHandler.done.wait(timeout=300)
    server.server_close()

    if CallbackHandler.error:
        raise SystemExit(f"OAuth 인증 오류: {CallbackHandler.error}")
    if not CallbackHandler.code:
        raise SystemExit("5분 안에 인증 코드가 도착하지 않았습니다.")

    token_data = exchange_code(CallbackHandler.code, client_id, client_secret)
    print(
        json.dumps(
            {
                "refresh_token": token_data.get("refresh_token"),
                "access_token": token_data.get("access_token"),
                "scope": token_data.get("scope"),
                "token_type": token_data.get("token_type"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print()
    print("refresh_token 값을 .env 의 GOOGLE_DRIVE_REFRESH_TOKEN 에 저장하세요.")


if __name__ == "__main__":
    main()
