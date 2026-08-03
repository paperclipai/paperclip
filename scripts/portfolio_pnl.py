#!/usr/bin/env python3
"""Weekly portfolio P&L (Ledger / TSMC-11472).

Each Monday 09:00 Europe/Dublin, Ledger runs this for the *prior* week
(Mon 00:00 .. next Mon 00:00, Europe/Dublin) against the live control plane:

  - GET /api/portfolio/runs           -> per company+agent activity and run-cost rollup
  - GET /api/portfolio/finance_events -> recorded money (revenue/refund/fee/cost)

It builds a markdown P&L and (unless --dry-run) posts it to the wake issue as a
comment AND upserts it as an issue document keyed `weekly-pnl`.

No LLM extraction — this is deterministic arithmetic over the two endpoints.
The endpoints are TSMC-10044 / migration 0099 (portfolio_metrics:read).

Auth / transport
  - Base URL: --base or $PAPERCLIP_API_URL (default http://127.0.0.1:3100).
    Normalised to end in /api. On a connection-level failure to a non-local host
    (e.g. a stale LAN url) it retries http://127.0.0.1:3100/api.
  - Bearer: $PAPERCLIP_API_KEY (the Ledger agent run JWT) is sent as
    Authorization: Bearer ... when present, plus X-Paperclip-Run-Id from
    $PAPERCLIP_RUN_ID. On local_trusted with no key, the server treats the
    caller as local board, which also has portfolio + issue-write access.

Usage
  portfolio_pnl.py [--issue TSMC-11472] [--week-of YYYY-MM-DD]
                   [--base URL] [--companies id,id,...] [--dry-run]
"""
import argparse
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    DUBLIN = ZoneInfo("Europe/Dublin")
except Exception:  # pragma: no cover - zoneinfo always present on 3.9+
    DUBLIN = timezone(timedelta(hours=1))  # IST fallback (no DST handling)

# The 6 OpCo children of TSMC (migration 0099). Override with --companies / env.
# issuePrefix labels are baked in: `/api/companies` requires board access, which the
# Ledger agent JWT does not have, so we don't depend on it for display names.
OPCO_LABELS = {
    "e7507bfa-ecfd-4dde-bd2a-7b19947ffdde": "DP",   # Dastardly Print
    "baba1235-7f5b-4555-aed8-c06efa095125": "TSB",  # ThinkStack Books
    "211e0f96-ecd2-4fe0-81f8-72059bc6ed46": "TSC",  # ThinkStack Capital
    "6d2c1656-dabd-4aa1-b45a-0f5aedea3092": "TSK",  # ThinkStack KISS
    "d71c9e82-1a4b-497f-9bbc-5b9dd028c367": "TSM",  # ThinkStack Media
    "cefbbf68-0ca7-4383-967e-03bc1b037ae7": "TSR",  # ThinkStack Recruitment
}
DEFAULT_COMPANIES = list(OPCO_LABELS)
LOCAL_BASE = "http://127.0.0.1:3100/api"
DOC_KEY = "weekly-pnl"


def normalise_base(raw: str) -> str:
    base = (raw or "").strip().rstrip("/")
    if not base:
        return LOCAL_BASE
    if not base.endswith("/api"):
        base = base + "/api"
    return base


def make_client(base: str):
    key = os.environ.get("PAPERCLIP_API_KEY", "").strip()
    run_id = os.environ.get("PAPERCLIP_RUN_ID", "").strip()

    def headers(extra=None):
        h = {"Accept": "application/json"}
        if key:
            h["Authorization"] = f"Bearer {key}"
        if run_id:
            h["X-Paperclip-Run-Id"] = run_id
        if extra:
            h.update(extra)
        return h

    def request(method: str, path: str, body=None):
        url = base + path
        data = None
        extra = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            extra = {"Content-Type": "application/json"}
        req = urllib.request.Request(url, data=data, method=method, headers=headers(extra))
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode("utf-8")
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw)
            except Exception:
                payload = {"error": raw[:500]}
            return e.status, payload

    return request


def prior_week_window(week_of: str | None):
    """Return (since_utc, until_utc, mon_local, sun_local) for the prior Mon..Sun.

    Week boundaries are anchored to Europe/Dublin midnight, then converted to UTC
    for the API (which filters on UTC timestamptz).
    """
    if week_of:
        anchor = datetime.strptime(week_of, "%Y-%m-%d").replace(tzinfo=DUBLIN)
    else:
        anchor = datetime.now(DUBLIN)
    # Monday of the anchor's week, at local midnight.
    this_monday = (anchor - timedelta(days=anchor.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    prior_monday = this_monday - timedelta(days=7)
    next_monday = this_monday  # exclusive upper bound = start of current week
    since_utc = prior_monday.astimezone(timezone.utc)
    until_utc = next_monday.astimezone(timezone.utc)
    sun_local = next_monday - timedelta(days=1)  # for display only
    return since_utc, until_utc, prior_monday, sun_local


def company_names(client, company_ids):
    names = dict(OPCO_LABELS)
    # Best-effort enrichment for any non-default company (board sessions only).
    unknown = [c for c in company_ids if c not in names]
    if unknown:
        try:
            status, payload = client("GET", "/companies")
            if status == 200:
                rows = payload if isinstance(payload, list) else (payload or {}).get("companies", [])
                for c in rows:
                    cid = c.get("id")
                    if cid:
                        names.setdefault(cid, c.get("issuePrefix") or c.get("name") or cid[:8])
        except Exception:
            pass
    for cid in company_ids:
        names.setdefault(cid, cid[:8])
    return names


def usd(cents: int) -> str:
    neg = cents < 0
    v = abs(cents) / 100.0
    return ("-" if neg else "") + f"${v:,.2f}"


def fmt_hours(seconds: int) -> str:
    return f"{seconds / 3600.0:,.1f}h"


def build_report(window, names, runs_rows, fin_rows):
    since_utc, until_utc, mon_local, sun_local = window

    # --- money: aggregate finance_events per company by kind ---
    money = {}  # cid -> {revenue, refund, fee, cost} in cents
    for r in fin_rows:
        cid = r["company_id"]
        m = money.setdefault(cid, {"revenue": 0, "refund": 0, "fee": 0, "cost": 0})
        kind = r.get("kind")
        if kind in m:
            m[kind] += int(r.get("amount_cents") or 0)

    # --- activity and run-cost evidence: aggregate per company ---
    # Cost is provider-reported from cost_events, not a token-price estimate. A $0
    # with no source event is therefore unknown, while an explicit priced $0 is known.
    act = {}  # cid -> {runs, ok, fail, seconds, issues, cost evidence}
    for r in runs_rows:
        cid = r["company_id"]
        a = act.setdefault(cid, {
            "runs": 0, "ok": 0, "fail": 0, "seconds": 0, "issues": 0,
            "run_cost": 0, "priced_cost_events": 0, "unpriced_cost_events": 0,
        })
        a["runs"] += int(r.get("runs_total") or 0)
        a["ok"] += int(r.get("runs_succeeded") or 0)
        a["fail"] += int(r.get("runs_failed") or 0)
        a["seconds"] += int(r.get("seconds_on_task") or 0)
        a["issues"] += int(r.get("distinct_issues") or 0)
        a["run_cost"] += int(r.get("cost_cents") or 0)
        a["priced_cost_events"] += int(r.get("priced_cost_event_count") or 0)
        a["unpriced_cost_events"] += int(r.get("unpriced_cost_event_count") or 0)

    all_ids = sorted(set(money) | set(act), key=lambda c: names.get(c, c))

    tot = {"revenue": 0, "refund": 0, "fee": 0, "cost": 0, "run_cost": 0,
           "priced_cost_events": 0, "unpriced_cost_events": 0,
           "runs": 0, "ok": 0, "fail": 0, "seconds": 0, "issues": 0}

    def net(m):
        return m["revenue"] - m["refund"] - m["fee"] - m["cost"]

    lines = []
    title = f"Weekly Portfolio P&L — {mon_local:%Y-%m-%d} → {sun_local:%Y-%m-%d} (Europe/Dublin)"
    lines.append(f"# {title}")
    lines.append("")
    lines.append(
        f"_Window (UTC): {since_utc:%Y-%m-%dT%H:%MZ} → {until_utc:%Y-%m-%dT%H:%MZ}. "
        f"Source: `/api/portfolio/finance_events` + `/api/portfolio/runs`. "
        f"{len(runs_rows)} agent-rows, {len(fin_rows)} finance events._"
    )
    lines.append("")

    # --- P&L table (money) ---
    lines.append("## P&L — recorded money")
    lines.append("")
    lines.append("| Company | Revenue | Refunds | Fees | Cost (cash + run) | **Net** |")
    lines.append("|---|--:|--:|--:|--:|--:|")
    money_ids = [c for c in all_ids if c in money or act.get(c, {}).get("priced_cost_events", 0) > 0]
    if money_ids:
        for cid in money_ids:
            m = money.get(cid, {"revenue": 0, "refund": 0, "fee": 0, "cost": 0})
            run_cost = act.get(cid, {}).get("run_cost", 0)
            for k in ("revenue", "refund", "fee", "cost"):
                tot[k] += m[k]
            tot["run_cost"] += run_cost
            m = {**m, "cost": m["cost"] + run_cost}
            lines.append(
                f"| {names.get(cid, cid[:8])} | {usd(m['revenue'])} | {usd(m['refund'])} "
                f"| {usd(m['fee'])} | {usd(m['cost'])} | **{usd(net(m))}** |"
            )
    else:
        lines.append("| _(no finance_events recorded)_ |  |  |  |  | **$0.00** |")
    total_cost = tot["cost"] + tot["run_cost"]
    tot_net = tot["revenue"] - tot["refund"] - tot["fee"] - total_cost
    lines.append(
        f"| **PORTFOLIO** | **{usd(tot['revenue'])}** | **{usd(tot['refund'])}** "
        f"| **{usd(tot['fee'])}** | **{usd(total_cost)}** | **{usd(tot_net)}** |"
    )
    lines.append("")

    # --- Activity / effort table (runs) ---
    lines.append("## Effort — agent activity (cost-of-production proxy)")
    lines.append("")
    lines.append("| Company | Runs | Succeeded | Failed | Agent-hours | Distinct issues |")
    lines.append("|---|--:|--:|--:|--:|--:|")
    for cid in all_ids:
        a = act.get(cid)
        if not a:
            continue
        for k in ("runs", "ok", "fail", "seconds", "issues"):
            tot[k] += a[k]
        tot["priced_cost_events"] += a["priced_cost_events"]
        tot["unpriced_cost_events"] += a["unpriced_cost_events"]
        lines.append(
            f"| {names.get(cid, cid[:8])} | {a['runs']} | {a['ok']} | {a['fail']} "
            f"| {fmt_hours(a['seconds'])} | {a['issues']} |"
        )
    lines.append(
        f"| **PORTFOLIO** | **{tot['runs']}** | **{tot['ok']}** | **{tot['fail']}** "
        f"| **{fmt_hours(tot['seconds'])}** | **{tot['issues']}** |"
    )
    lines.append("")

    # --- Bottom line (outcomes, not motion) ---
    lines.append("## Bottom line")
    lines.append("")
    hrs = tot["seconds"] / 3600.0
    if tot["priced_cost_events"] == 0 and tot["unpriced_cost_events"] == 0:
        lines.append(
            "- **Run-cost attribution: unknown ($0.00)** — no source-attributed `cost_events` "
            "exist in this window, so the report does not invent a token-price estimate."
        )
    elif tot["unpriced_cost_events"] > 0:
        lines.append(
            f"- **Run-cost attribution: partial.** {tot['priced_cost_events']} provider-priced event(s) "
            f"rendered as {usd(tot['run_cost'])}; {tot['unpriced_cost_events']} token-bearing event(s) "
            "remain explicitly unpriced because the provider supplied no cost."
        )
    else:
        lines.append(
            f"- **Run-cost attribution: known.** {tot['priced_cost_events']} provider-priced event(s) "
            f"rendered as {usd(tot['run_cost'])}."
        )

    if tot["revenue"] == 0 and total_cost == 0:
        lines.append(
            f"- **${0:,.2f} revenue and $0.00 cost rendered** across {tot['runs']:,} agent-runs "
            f"/ {hrs:,.0f} agent-hours this week. Output is high; **tracked outcome is nil** — "
            f"the finance ledger is empty, so the portfolio cannot prove a single dollar earned or spent."
        )
        action = (
            "**Stand up the revenue feed.** Pick the one OpCo closest to a real sale "
            "(KDP royalties for ThinkStack Books, or Etsy payouts for Dastardly Print) and "
            "wire its payout export into `POST /api/portfolio/finance_events` so next Monday's "
            "P&L shows real money, not motion. Every other line here is effort with no proven return."
        )
    else:
        lines.append(
            f"- Portfolio net this week: **{usd(tot_net)}** "
            f"({usd(tot['revenue'])} revenue − {usd(tot['refund'] + tot['fee'] + total_cost)} "
            f"refunds/fees/cost) against {hrs:,.0f} agent-hours."
        )
        # Highest-leverage = best net contributor, else the biggest effort sink earning nothing.
        earners = [(net(money[c]), c) for c in money if net(money[c]) > 0]
        if earners:
            best = max(earners)[1]
            action = (
                f"**Double down on {names.get(best, best[:8])}** — it is the only line turning effort "
                f"into positive net. Re-route a low-yield OpCo's agent-hours toward replicating it."
            )
        else:
            action = (
                "**Cut the biggest effort sink earning $0.** Identify the OpCo burning the most "
                "agent-hours with no recorded revenue and pause/re-scope it until it has a live sale path."
            )
    lines.append("")
    lines.append("## ⟶ Highest-leverage action to raise CASH next week")
    lines.append("")
    lines.append(action)
    lines.append("")
    lines.append(
        "_Generated by `scripts/portfolio_pnl.py` (TSMC-11472). No LLM extraction; "
        "deterministic rollup of the portfolio endpoints._"
    )
    return title, "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Weekly portfolio P&L (Ledger)")
    ap.add_argument("--issue", default=os.environ.get("PAPERCLIP_ISSUE_ID")
                    or os.environ.get("WAKE_ISSUE_ID")
                    or os.environ.get("PAPERCLIP_TASK_ID")  # set by the routine wake
                    or "TSMC-11472",
                    help="wake issue ref/id to post the P&L onto")
    ap.add_argument("--week-of", default=None,
                    help="YYYY-MM-DD inside the CURRENT week; reports the prior week (default: now)")
    ap.add_argument("--base", default=os.environ.get("PAPERCLIP_API_URL", LOCAL_BASE))
    ap.add_argument("--companies", default=os.environ.get("PORTFOLIO_COMPANY_IDS"),
                    help="comma-separated company UUIDs (default: the 6 TSMC OpCos)")
    ap.add_argument("--dry-run", action="store_true", help="print markdown, do not post")
    args = ap.parse_args()

    company_ids = ([c.strip() for c in args.companies.split(",") if c.strip()]
                   if args.companies else list(DEFAULT_COMPANIES))
    cids = ",".join(company_ids)

    base = normalise_base(args.base)
    client = make_client(base)
    window = prior_week_window(args.week_of)
    since_utc, until_utc, _, _ = window
    qs = (f"?since={since_utc:%Y-%m-%dT%H:%M:%SZ}"
          f"&until={until_utc:%Y-%m-%dT%H:%M:%SZ}&companyIds={cids}")

    def fetch(path):
        try:
            return client("GET", path)
        except urllib.error.URLError as ex:
            if not base.startswith(LOCAL_BASE):  # stale LAN url fallback
                print(f"[warn] {base} unreachable ({ex}); retrying localhost")
                return make_client(LOCAL_BASE)("GET", path)
            raise

    rs, runs_payload = fetch("/portfolio/runs" + qs)
    if rs != 200:
        print(f"[error] /portfolio/runs -> HTTP {rs}: {runs_payload}")
        return 1
    fs, fin_payload = fetch("/portfolio/finance_events" + qs)
    if fs != 200:
        print(f"[error] /portfolio/finance_events -> HTTP {fs}: {fin_payload}")
        return 1

    runs_rows = (runs_payload or {}).get("rows", [])
    fin_rows = (fin_payload or {}).get("rows", [])

    # Bounded provenance fix for TSC phantom-wins (TSMC-15659 / TSMC-15657):
    # Add explicit runId/row dedup guard in reporting path. Fallback-monitor.py
    # already has idempotent-read retry, but provenance not propagated into
    # P&L aggregation. Source-of-truth identifiers:
    # - Runs: heartbeat_runs.id (DISTINCT in listRunsRollup) + (company_id, agent_id) pair
    # - Finance events: finance_events.id (event_id)
    # Prevents duplicate/false-positive fallback paths surfacing as phantom wins
    # in TSC weekly P&L / daily-summary output. No TSC-specific filter added
    # (would require upstream provenance column); this dedup is the minimal safe
    # change at the aggregation surface.
    seen_run_keys = set()
    dedup_runs = []
    for r in runs_rows:
        key = (r.get("company_id"), r.get("agent_id"))
        if key not in seen_run_keys:
            seen_run_keys.add(key)
            dedup_runs.append(r)
    runs_rows = dedup_runs

    seen_fin_keys = set()
    dedup_fin = []
    for r in fin_rows:
        key = r.get("event_id")
        if key and key not in seen_fin_keys:
            seen_fin_keys.add(key)
            dedup_fin.append(r)
    fin_rows = dedup_fin

    names = company_names(client, company_ids)

    title, report = build_report(window, names, runs_rows, fin_rows)

    if args.dry_run:
        print(report)
        return 0

    # 1) issue document keyed `weekly-pnl`
    ds, dp = client("PUT", f"/issues/{args.issue}/documents/{DOC_KEY}", {
        "title": title,
        "format": "markdown",
        "body": report,
        "changeSummary": f"Weekly P&L for {window[2]:%Y-%m-%d}..{window[3]:%Y-%m-%d}",
    })
    if ds not in (200, 201):
        print(f"[error] document upsert -> HTTP {ds}: {dp}")
        return 1
    print(f"[ok] document `{DOC_KEY}` upserted (HTTP {ds})")

    # 2) comment on the wake issue
    cs, cp = client("POST", f"/issues/{args.issue}/comments", {
        "body": report + f"\n\n> Also saved as issue document [`{DOC_KEY}`]."})
    if cs not in (200, 201):
        print(f"[error] comment -> HTTP {cs}: {cp}")
        return 1
    print(f"[ok] comment posted to {args.issue} (HTTP {cs})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
