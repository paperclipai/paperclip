#!/usr/bin/env python3
"""
Alfred에서 매출/매입 세금계산서와 계좌 입출금 데이터를 가져오는 스크립트.

환경변수:
- ALFRED_EMAIL
- ALFRED_PASSWORD

예시:
  python3 tools/alfred/fetch_tax_invoices.py --from-date 2026-03-01 --to-date 2026-03-31
  python3 tools/alfred/fetch_tax_invoices.py --from-date 2026-03-01 --to-date 2026-03-31 --save-dir private-data/alfred
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
from http.cookiejar import CookieJar
from typing import Any, Dict, List, Optional


NEXUS_API_BASE = "https://nexus-api.alfred.kr"
TRANSACTION_API_BASE = "https://transaction-api.heumtax.com"
APP_BASE = "https://app.alfred.kr"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/145.0.0.0 Safari/537.36"
)


class AlfredClient:
    def __init__(self, email: str, password: str) -> None:
        self.email = email
        self.password = password
        self.cookie_jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookie_jar)
        )
        self.company: Optional[Dict[str, Any]] = None

    def _request(
        self,
        method: str,
        url: str,
        *,
        data: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
        expect_json: bool = True,
    ) -> Any:
        merged_headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/json, text/plain, */*",
        }
        if headers:
            merged_headers.update(headers)

        payload = None
        if data is not None:
            payload = json.dumps(data).encode("utf-8")
            merged_headers.setdefault("Content-Type", "application/json")

        request = urllib.request.Request(
            url,
            data=payload,
            headers=merged_headers,
            method=method,
        )
        try:
            response = self.opener.open(request)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} {url} 실패: {exc.code} {body}") from exc

        body = response.read().decode("utf-8", errors="replace")
        if not expect_json:
            return body
        if not body:
            return {}
        return json.loads(body)

    def _csrf_token(self) -> str:
        for preferred_name in ("nexus_csrftoken", "csrftoken"):
            for cookie in self.cookie_jar:
                if cookie.name == preferred_name:
                    return cookie.value
        return ""

    def login(self) -> Dict[str, Any]:
        # CSRF 쿠키를 먼저 심고 로그인한다.
        try:
            self._request(
                "GET",
                f"{NEXUS_API_BASE}/api/user/me/",
                headers={
                    "Origin": APP_BASE,
                    "Referer": f"{APP_BASE}/login",
                    "X-CSRFToken": "",
                },
            )
        except RuntimeError:
            pass

        self._request(
            "POST",
            f"{NEXUS_API_BASE}/api/login/",
            data={
                "email": self.email,
                "password": self.password,
                "stay_signed_in": True,
            },
            headers={
                "Origin": APP_BASE,
                "Referer": f"{APP_BASE}/login",
                "X-CSRFToken": self._csrf_token(),
            },
        )
        me = self.get_me()
        company = me.get("company")
        if company is None:
            companies = me.get("companies") or []
            if not companies:
                raise RuntimeError("회사 정보가 없습니다.")
            company = companies[0]
        self.company = company
        return me

    def get_me(self) -> Dict[str, Any]:
        return self._request(
            "GET",
            f"{NEXUS_API_BASE}/api/user/me/",
            headers={
                "Origin": APP_BASE,
                "Referer": APP_BASE,
                "X-CSRFToken": self._csrf_token(),
            },
        )

    def get_company_jwt(self, company_id: int) -> str:
        response = self._request(
            "POST",
            f"{NEXUS_API_BASE}/api/user/me/jwt/",
            data={"company_id": company_id},
            headers={
                "Origin": APP_BASE,
                "Referer": APP_BASE,
                "X-CSRFToken": self._csrf_token(),
                "X-Original-Path": "/",
            },
        )
        token = response.get("token")
        if not token:
            raise RuntimeError("회사 JWT를 가져오지 못했습니다.")
        return token

    def _transaction_get(
        self,
        token: str,
        path: str,
        params: Dict[str, Any],
        *,
        referer_path: str,
    ) -> Dict[str, Any]:
        query = urllib.parse.urlencode(params, doseq=True)
        url = f"{TRANSACTION_API_BASE}{path}?{query}"
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/plain, */*",
                "Authorization": f"Bearer {token}",
                "Origin": APP_BASE,
                "Referer": f"{APP_BASE}{referer_path}",
                "X-Original-Path": referer_path,
            },
        )
        try:
            response = urllib.request.urlopen(request)
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"GET {url} 실패: {exc.code} {body}") from exc
        return json.loads(response.read().decode("utf-8"))

    def get_sales_tax_invoices(
        self,
        company_id: int,
        token: str,
        from_date: str,
        to_date: str,
        page: int,
        page_size: int,
    ) -> Dict[str, Any]:
        summary = self._transaction_get(
            token,
            f"/api/company/{company_id}/tax-invoices/sales/aggregation",
            {
                "from_date": from_date,
                "to_date": to_date,
            },
            referer_path="/evidence/sales/tax-invoice",
        )
        items = self._transaction_get(
            token,
            f"/api/company/{company_id}/tax-invoices/sales",
            {
                "from_date": from_date,
                "to_date": to_date,
                "ordering": "MAKE_DATE_DESC",
                "page": page,
                "page_size": page_size,
            },
            referer_path="/evidence/sales/tax-invoice",
        )
        return {"summary": summary, "list": items}

    def get_purchase_tax_invoices(
        self,
        company_id: int,
        token: str,
        from_date: str,
        to_date: str,
        page: int,
        page_size: int,
    ) -> Dict[str, Any]:
        summary = self._transaction_get(
            token,
            f"/api/company/{company_id}/tax-invoices/purchases/aggregation",
            {
                "from_date": from_date,
                "to_date": to_date,
            },
            referer_path="/evidence/purchase/tax-invoice",
        )
        items = self._transaction_get(
            token,
            f"/api/company/{company_id}/tax-invoices/purchases",
            {
                "from_date": from_date,
                "to_date": to_date,
                "ordering": "MAKE_DATE_DESC",
                "page": page,
                "page_size": page_size,
            },
            referer_path="/evidence/purchase/tax-invoice",
        )
        return {"summary": summary, "list": items}

    def get_purchase_cards(
        self,
        company_id: int,
        token: str,
        from_date: str,
        to_date: str,
        page: int,
        page_size: int,
    ) -> Dict[str, Any]:
        summary = self._transaction_get(
            token,
            f"/api/company/{company_id}/card/purchases/aggregation",
            {
                "from_date": from_date,
                "to_date": to_date,
            },
            referer_path="/evidence/purchase/card",
        )
        items = self._transaction_get(
            token,
            f"/api/company/{company_id}/card/purchases",
            {
                "from_date": from_date,
                "to_date": to_date,
                "page": page,
                "page_size": page_size,
                "ordering": "ISSUE_DATE_DESC",
            },
            referer_path="/evidence/purchase/card",
        )
        return {"summary": summary, "list": items}

    def get_bank_transactions(
        self,
        company_id: int,
        token: str,
        from_date: str,
        to_date: str,
        page: int,
        page_size: int,
        *,
        search: str = "",
        account_number: str = "",
    ) -> Dict[str, Any]:
        summary = self._transaction_get(
            token,
            "/api/evidences/bank-transaction/summary",
            {
                "company_id": company_id,
                "from_date": from_date,
                "to_date": to_date,
                "account_number": account_number,
            },
            referer_path="/bank/account-history",
        )
        items = self._transaction_get(
            token,
            "/api/evidences/bank-transaction",
            {
                "company_id": company_id,
                "from_date": from_date,
                "to_date": to_date,
                "search": search,
                "account_number": account_number,
                "page": page,
                "page_size": page_size,
                "ordering": "-transacted_at",
            },
            referer_path="/bank/account-history",
        )
        return {"summary": summary, "list": items}


def format_currency(value: float) -> str:
    return f"{int(round(value)):,}원"


def format_signed_currency(value: float) -> str:
    prefix = "-" if value < 0 else ""
    return f"{prefix}{format_currency(abs(value))}"


def parse_number(value: Any) -> float:
    if value in (None, ""):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return float(str(value).replace(",", ""))


def build_markdown_report(payload: Dict[str, Any]) -> str:
    company = payload["company"]
    period = payload["period"]
    sales = payload["sales"]
    purchases = payload["purchases"]
    purchase_cards = payload.get("purchase_cards")
    bank = payload.get("bank")

    lines = [
        f"# Alfred 회계 스냅샷",
        "",
        f"- 생성시각: {payload['fetched_at']}",
        f"- 회사: {company['name']}",
        f"- 기간: {period['from_date']} ~ {period['to_date']}",
        "",
        "## 매출 세금계산서",
        f"- 건수: {sales['summary']['total']['count']}건",
        f"- 합계: {format_currency(sales['summary']['total']['amount'])}",
        f"- 분류 완료: {sales['summary']['classified']['count']}건 / {format_currency(sales['summary']['classified']['amount'])}",
        f"- 미분류: {sales['summary']['unclassified']['count']}건 / {format_currency(sales['summary']['unclassified']['amount'])}",
        "",
        "### 최근 매출 세금계산서",
    ]

    sales_items = sales["list"].get("items", [])[:5]
    if sales_items:
        for item in sales_items:
            partner = (item.get("partner") or {}).get("name", "-")
            lines.append(
                f"- {item.get('make_date')} | {partner} | "
                f"{item.get('item_name') or '-'} | {format_currency(item.get('amount', 0))}"
            )
    else:
        lines.append("- 없음")

    lines.extend(
        [
            "",
            "## 매입 세금계산서",
            f"- 건수: {purchases['summary']['total']['count']}건",
            f"- 합계: {format_currency(purchases['summary']['total']['amount'])}",
            f"- 분류 완료: {purchases['summary']['classified']['count']}건 / {format_currency(purchases['summary']['classified']['amount'])}",
            f"- 미분류: {purchases['summary']['unclassified']['count']}건 / {format_currency(purchases['summary']['unclassified']['amount'])}",
            "",
            "### 최근 매입 세금계산서",
        ]
    )

    purchase_items = purchases["list"].get("items", [])[:5]
    if purchase_items:
        for item in purchase_items:
            partner = (item.get("partner") or {}).get("name", "-")
            lines.append(
                f"- {item.get('make_date')} | {partner} | "
                f"{item.get('item_name') or '-'} | {format_currency(item.get('amount', 0))}"
            )
    else:
        lines.append("- 없음")

    if purchase_cards:
        lines.extend(
            [
                "",
                "## 매입 신용카드",
                f"- 건수: {purchase_cards['summary']['total']['count']}건",
                f"- 합계: {format_currency(purchase_cards['summary']['total']['amount'])}",
                f"- 분류 완료: {purchase_cards['summary']['classified']['count']}건 / {format_currency(purchase_cards['summary']['classified']['amount'])}",
                f"- 미분류: {purchase_cards['summary']['unclassified']['count']}건 / {format_currency(purchase_cards['summary']['unclassified']['amount'])}",
                "",
                "### 최근 매입 신용카드 내역",
            ]
        )

        card_items = purchase_cards["list"].get("items", [])[:10]
        if card_items:
            for item in card_items:
                partner = (item.get("partner") or {}).get("name", "-")
                amount = parse_number(item.get("amount_in_krw"))
                lines.append(
                    f"- {item.get('issued_at')} | {partner} | "
                    f"{item.get('card_no') or '-'} | {format_signed_currency(amount)}"
                )
        else:
            lines.append("- 없음")

    if bank:
        deposit_total = parse_number(
            (bank["summary"].get("deposit") or {}).get("total", {}).get("amount_as_kr")
        )
        withdrawal_total = parse_number(
            (bank["summary"].get("withdrawal") or {})
            .get("total", {})
            .get("amount_as_kr")
        )
        deposit_count = (
            (bank["summary"].get("deposit") or {}).get("total", {}).get("count", 0)
        )
        withdrawal_count = (
            (bank["summary"].get("withdrawal") or {}).get("total", {}).get("count", 0)
        )

        lines.extend(
            [
                "",
                "## 계좌 입출금",
                f"- 입금: {deposit_count}건 / {format_currency(deposit_total)}",
                f"- 출금: {withdrawal_count}건 / {format_currency(abs(withdrawal_total))}",
                "",
                "### 최근 입출금 내역",
            ]
        )

        bank_items = bank["list"].get("items", [])[:10]
        if bank_items:
            for item in bank_items:
                amount = parse_number(item.get("amount_kr") or item.get("amount"))
                direction = "입금" if amount > 0 else "출금"
                lines.append(
                    f"- {item.get('transacted_at')} | {direction} | "
                    f"{item.get('name') or '-'} | {item.get('summary') or '-'} | "
                    f"{format_currency(abs(amount))}"
                )
        else:
            lines.append("- 없음")

    return "\n".join(lines) + "\n"


def ensure_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"환경변수 {name} 이(가) 필요합니다.")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Alfred 세금계산서와 계좌 입출금 데이터를 가져옵니다."
    )
    parser.add_argument("--from-date", required=True, help="조회 시작일 (YYYY-MM-DD)")
    parser.add_argument("--to-date", required=True, help="조회 종료일 (YYYY-MM-DD)")
    parser.add_argument("--page", type=int, default=1, help="목록 페이지")
    parser.add_argument("--page-size", type=int, default=20, help="목록 크기")
    parser.add_argument(
        "--bank-page-size", type=int, default=25, help="계좌 입출금 목록 크기"
    )
    parser.add_argument(
        "--account-number", default="", help="특정 계좌번호로 필터링"
    )
    parser.add_argument("--search", default="", help="입출금 검색어")
    parser.add_argument(
        "--save-dir",
        help="JSON/Markdown 스냅샷을 저장할 디렉토리. 예: private-data/alfred",
    )
    parser.add_argument(
        "--format",
        choices=["markdown", "json"],
        default="markdown",
        help="표준출력 포맷",
    )
    return parser.parse_args()


def validate_date(value: str) -> str:
    dt.date.fromisoformat(value)
    return value


def main() -> int:
    args = parse_args()
    from_date = validate_date(args.from_date)
    to_date = validate_date(args.to_date)

    client = AlfredClient(
        email=ensure_env("ALFRED_EMAIL"),
        password=ensure_env("ALFRED_PASSWORD"),
    )
    client.login()

    if client.company is None:
        raise RuntimeError("회사 선택에 실패했습니다.")

    company = client.company
    company_id = company["id"]
    token = client.get_company_jwt(company_id)
    sales = client.get_sales_tax_invoices(
        company_id, token, from_date, to_date, args.page, args.page_size
    )
    purchases = client.get_purchase_tax_invoices(
        company_id, token, from_date, to_date, args.page, args.page_size
    )
    purchase_cards = client.get_purchase_cards(
        company_id, token, from_date, to_date, args.page, args.page_size
    )
    bank = client.get_bank_transactions(
        company_id,
        token,
        from_date,
        to_date,
        args.page,
        args.bank_page_size,
        search=args.search,
        account_number=args.account_number,
    )

    payload = {
        "fetched_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "company": {
            "id": company["id"],
            "sf_company_id": company.get("sf_company_id"),
            "name": company["name"],
            "business_number": company.get("business_number"),
            "tax_plan": company.get("tax_plan"),
        },
        "period": {
            "from_date": from_date,
            "to_date": to_date,
        },
        "sales": sales,
        "purchases": purchases,
        "purchase_cards": purchase_cards,
        "bank": bank,
    }

    markdown = build_markdown_report(payload)
    if args.format == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(markdown, end="")

    if args.save_dir:
        save_dir = pathlib.Path(args.save_dir)
        save_dir.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        base_name = f"alfred-tax-invoices-{from_date}-{to_date}-{stamp}"
        (save_dir / f"{base_name}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (save_dir / f"{base_name}.md").write_text(markdown, encoding="utf-8")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"오류: {exc}", file=sys.stderr)
        raise SystemExit(1)
