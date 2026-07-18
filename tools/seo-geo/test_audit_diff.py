from audit_diff import (finding_key, diff_findings, find_regressions,
                        site_alerts, any_alert, render_markdown)

def _f(url, field, sev="medium", issue="x"):
    return {"url": url, "field": field, "severity": sev, "issue": issue}

def test_diff_new_und_resolved_nach_url_field():
    prev = [_f("a", "h1"), _f("a", "meta_description")]
    cur = [_f("a", "meta_description"), _f("b", "h1")]
    d = diff_findings(prev, cur)
    assert {finding_key(x) for x in d["new"]} == {("b", "h1")}
    assert {finding_key(x) for x in d["resolved"]} == {("a", "h1")}

def test_issue_textaenderung_ist_nicht_neu():
    prev = [_f("a", "meta_description", issue="Länge 282")]
    cur = [_f("a", "meta_description", issue="Länge 95")]
    d = diff_findings(prev, cur)
    assert d["new"] == [] and d["resolved"] == []

def test_find_regressions_nur_wenn_in_aelterem_snapshot():
    new = [_f("a", "h1"), _f("c", "alt_text")]
    older = [[_f("a", "h1")], [_f("x", "y")]]   # "a/h1" war mal da, "c/alt_text" nie
    reg = find_regressions(new, older)
    assert {finding_key(x) for x in reg} == {("a", "h1")}

def test_site_alerts_neues_high():
    d = {"new": [_f("a", "meta_description", sev="high")], "resolved": []}
    assert any("high" in a for a in site_alerts(d, [], 3, 3, "🟢"))

def test_site_alerts_regression():
    d = {"new": [], "resolved": []}
    assert any("Regression" in a for a in site_alerts(d, [_f("a", "h1")], 3, 3, "🟢"))

def test_site_alerts_netto_anstieg():
    d = {"new": [], "resolved": []}
    assert any("gestiegen" in a for a in site_alerts(d, [], 3, 5, "🟢"))

def test_site_alerts_gsc_rot():
    d = {"new": [], "resolved": []}
    assert any("GSC" in a for a in site_alerts(d, [], 3, 3, "🔴"))

def test_site_alerts_kein_alarm():
    d = {"new": [_f("a", "h1", sev="medium")], "resolved": []}
    assert site_alerts(d, [], 5, 3, "🟢") == []   # weniger Findings, kein high, keine Regression, GSC grün

def test_any_alert():
    assert any_alert([{"alerts": []}, {"alerts": ["x"]}]) is True
    assert any_alert([{"alerts": []}]) is False

def test_render_markdown_enthaelt_sitename_und_marker():
    md = render_markdown([{"name": "whitestag.ai", "new": [_f("a", "h1")],
                           "resolved": [_f("b", "meta_description")],
                           "regressions": [], "alerts": ["1 neues high-Finding"]}])
    assert "whitestag.ai" in md and "⚠️" in md
