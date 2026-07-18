"""Keyword-Rank-Tracking aus GSC-Positionsdaten. Rein: kein HTTP, kein Mail."""


def pos_delta(prev_pos, cur_pos):
    if prev_pos is None:
        return None
    return round(prev_pos - cur_pos, 1)


def build_site_ranks(cur_rows, prev_rows, core_keys):
    cur = {r["key"]: r for r in cur_rows}
    prev = {r["key"]: r for r in prev_rows}
    core_keys = set(core_keys or [])
    ranks = []
    for key in list(cur.keys()) + [k for k in core_keys if k not in cur]:
        if key not in cur:
            ranks.append({"key": key, "core": True, "missing": True})
            continue
        r = cur[key]
        prev_pos = prev[key]["position"] if key in prev else None
        ranks.append({"key": key, "core": key in core_keys,
                      "position": r["position"], "impressions": r["impressions"],
                      "delta": pos_delta(prev_pos, r["position"])})
    return ranks


def _arrow(delta):
    if delta is None:
        return "–"
    if delta > 0:
        return f"↑ +{delta}"
    if delta < 0:
        return f"↓ {delta}"
    return "→ ±0"


def render_markdown(per_site):
    lines = ["", "## Keyword-Rankings (GSC, Ø-Position)", ""]
    for s in per_site:
        lines.append(f"**{s['name']}**")
        ranks = s.get("ranks", [])
        # Kern-Keywords zuerst, dann Auto nach Impressionen
        ranks = sorted(ranks, key=lambda r: (not r.get("core"), -(r.get("impressions") or 0)))
        if not ranks:
            lines.append("  - keine Rank-Daten")
            continue
        for r in ranks:
            tag = " (Kern)" if r.get("core") else ""
            if r.get("missing"):
                lines.append(f"  - {r['key']}{tag}: nicht in GSC (keine Impressionen)")
            else:
                lines.append(f"  - {r['key']}{tag}: Pos {round(r['position'],1)} "
                             f"{_arrow(r.get('delta'))} · {r['impressions']} Impr.")
    lines.append("")
    return "\n".join(lines)
