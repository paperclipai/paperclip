"""Diff-/Alarm-Logik für das wöchentliche SEO/GEO-Audit. Rein: kein IO, kein Mail."""


def finding_key(f):
    return (f.get("url"), f.get("field"))


def diff_findings(prev, cur):
    pk = {finding_key(f): f for f in prev}
    ck = {finding_key(f): f for f in cur}
    new = [ck[k] for k in ck if k not in pk]
    resolved = [pk[k] for k in pk if k not in ck]
    return {"new": new, "resolved": resolved}


def find_regressions(new_findings, older_findings_lists):
    older_keys = set()
    for lst in older_findings_lists:
        older_keys |= {finding_key(f) for f in lst}
    return [f for f in new_findings if finding_key(f) in older_keys]


def site_alerts(diff, regressions, prev_count, cur_count, gsc_ampel):
    alerts = []
    new_high = [f for f in diff["new"] if f.get("severity") == "high"]
    if new_high:
        alerts.append(f"{len(new_high)} neues high-Finding")
    if regressions:
        alerts.append(f"{len(regressions)} Regression(en)")
    if prev_count is not None and cur_count > prev_count:
        alerts.append(f"Findings gestiegen ({prev_count}→{cur_count})")
    if gsc_ampel == "\U0001F534":  # 🔴
        alerts.append("GSC-Klick-Einbruch")
    return alerts


def any_alert(per_site):
    return any(s.get("alerts") for s in per_site)


_FMT_CAP = 15


def _fmt(findings):
    shown = findings[:_FMT_CAP]
    rest = ", ".join(f"{f.get('url')} [{f.get('field')}]" for f in shown)
    if len(findings) > _FMT_CAP:
        rest += f" …und {len(findings) - _FMT_CAP} weitere"
    return rest


def render_markdown(per_site):
    lines = ["", "## Veränderungen seit Vorwoche", ""]
    for s in per_site:
        marker = " ⚠️ " + "; ".join(s["alerts"]) if s.get("alerts") else ""
        lines.append(f"**{s['name']}**{marker}")
        if s.get("new"):
            lines.append(f"  - + neu ({len(s['new'])}): {_fmt(s['new'])}")
        if s.get("resolved"):
            lines.append(f"  - − behoben ({len(s['resolved'])}): {_fmt(s['resolved'])}")
        if s.get("regressions"):
            lines.append(f"  - ⚠️ Regression ({len(s['regressions'])}): {_fmt(s['regressions'])}")
        if not (s.get("new") or s.get("resolved") or s.get("regressions")):
            lines.append("  - keine Änderung")
    lines.append("")
    return "\n".join(lines)
