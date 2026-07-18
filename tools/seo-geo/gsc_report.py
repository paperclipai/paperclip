"""Reine Report-Logik für den GSC-Block der Wochen-Mail. Kein HTTP, kein Mailversand."""
from urllib.parse import urlparse

_RANK = {"🟢": 0, "🟡": 1, "🔴": 2}


def delta_pct(cur, prev):
    if prev == 0:
        return None
    return round((cur - prev) / prev * 100, 1)


def ampel(click_delta_pct):
    if click_delta_pct is None or click_delta_pct >= -10:
        return "🟢"
    if click_delta_pct >= -25:
        return "🟡"
    return "🔴"


def movers(prev_rows, cur_rows, n=3):
    prev = {r["key"]: r["clicks"] for r in prev_rows}
    cur = {r["key"]: r["clicks"] for r in cur_rows}
    diffs = [{"key": k, "delta": cur.get(k, 0) - prev.get(k, 0)}
             for k in set(prev) | set(cur)]
    diffs.sort(key=lambda d: d["delta"], reverse=True)
    winners = [d for d in diffs if d["delta"] > 0][:n]
    losers = [d for d in reversed(diffs) if d["delta"] < 0][:n]
    return winners, losers


def _host(value):
    host = value.split(":", 1)[1] if value.startswith("sc-domain:") else urlparse(value).netloc
    return host.removeprefix("www.")


def resolve_property(site, client):
    if site.gsc_property:
        return site.gsc_property
    target = _host(site.url)
    for prop in client.list_properties():
        if _host(prop) == target:
            return prop
    return None


def build_site_block(site, client, windows):
    (ls, le), (ps, pe) = windows
    block = {"name": site.name, "property": None, "ok": False, "error": None,
             "cur": {}, "prev": {}, "deltas": {}, "top_queries": [], "top_pages": [],
             "winners": [], "losers": [], "ampel": "🟢"}
    try:
        prop = resolve_property(site, client)
    except Exception as e:  # list_properties kann fehlschlagen
        block["error"] = f"GSC-Abruf fehlgeschlagen ({e})"
        return block
    if not prop:
        block["error"] = "nicht in GSC / nicht verifiziert"
        return block
    block["property"] = prop
    try:
        cur = client.fetch_totals(prop, ls, le)
        prev = client.fetch_totals(prop, ps, pe)
        tq = client.fetch_top(prop, "query", ls, le, 5)
        tp = client.fetch_top(prop, "page", ls, le, 5)
        pq = client.fetch_top(prop, "query", ps, pe, 25)
    except Exception as e:
        block["error"] = f"GSC-Abruf fehlgeschlagen ({e})"
        return block
    block["ok"] = True
    block["cur"], block["prev"] = cur, prev
    block["deltas"] = {k: delta_pct(cur[k], prev[k]) for k in ("clicks", "impressions", "ctr", "position")}
    block["top_queries"], block["top_pages"] = tq, tp
    block["winners"], block["losers"] = movers(pq, tq, n=3)
    block["ampel"] = ampel(block["deltas"]["clicks"])
    return block


def overall_ampel(blocks):
    worst = "🟢"
    for b in blocks:
        if _RANK.get(b.get("ampel", "🟢"), 0) > _RANK[worst]:
            worst = b["ampel"]
    return worst


def _fmt_delta(v):
    if v is None:
        return "n/a"
    return f"{'+' if v >= 0 else ''}{v}%"


def render_markdown(blocks):
    lines = ["", "## Google Search Console (letzte 7 vs. vorherige 7 Tage)", ""]
    for b in blocks:
        if not b.get("ok"):
            lines.append(f"**{b['name']}** — {b.get('error') or 'keine Daten'}")
            continue
        c, d = b["cur"], b["deltas"]
        lines.append(f"**{b['name']}** {b['ampel']} — "
                     f"Klicks {c['clicks']} ({_fmt_delta(d['clicks'])}) · "
                     f"Impressionen {c['impressions']} ({_fmt_delta(d['impressions'])}) · "
                     f"CTR {round(c['ctr']*100,1)}% · Ø-Pos {round(c['position'],1)}")
        if b["top_queries"]:
            lines.append("  - Top-Queries: " + ", ".join(f"{r['key']} ({r['clicks']})" for r in b["top_queries"]))
        if b["top_pages"]:
            lines.append("  - Top-Seiten: " + ", ".join(f"{r['key']} ({r['clicks']})" for r in b["top_pages"]))
        if b["winners"]:
            lines.append("  - Gewinner: " + ", ".join(f"{w['key']} (+{w['delta']})" for w in b["winners"]))
        if b["losers"]:
            lines.append("  - Verlierer: " + ", ".join(f"{l['key']} ({l['delta']})" for l in b["losers"]))
    lines.append("")
    return "\n".join(lines)
