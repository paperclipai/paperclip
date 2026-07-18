import datetime
import json

from audit_summary import _count, _dated_snapshots, _prev_snapshot, gsc_section, diff_section, geo_section


def test_count_enthaelt_findings():
    rep = {"pages": [{}], "findings": [
        {"url": "https://a.de/", "field": "meta_description", "severity": "medium", "issue": "x"}]}
    c = _count(rep)
    assert c["total"] == 1
    assert c["findings"] == rep["findings"]


def test_dated_snapshots_ignoriert_gsc_und_alert(tmp_path):
    (tmp_path / "2026-07-11.json").write_text('{"a": {"total": 5}}')
    (tmp_path / "2026-07-11-gsc.json").write_text('[{"name": "a"}]')
    (tmp_path / "2026-07-18-alert.txt").write_text('OK')
    snaps = _dated_snapshots(str(tmp_path))
    assert [d for d, _ in snaps] == ["2026-07-11"]
    assert snaps[0][1] == {"a": {"total": 5}}


def test_prev_snapshot_nimmt_datei_nicht_gsc(tmp_path):
    (tmp_path / "2026-07-11.json").write_text('{"a": {"total": 5}}')
    (tmp_path / "2026-07-11-gsc.json").write_text('[{"name": "a"}]')
    prev = _prev_snapshot(str(tmp_path), "2026-07-18")
    assert prev == {"a": {"total": 5}}


def test_gsc_section_ohne_key_ist_failsoft(tmp_path):
    sites = tmp_path / "sites.json"
    sites.write_text('{"report_root":"%s","sites":[{"name":"a","url":"https://a.de",'
                     '"wp_rest_base":"https://a.de/wp-json","credential_ref":"A",'
                     '"crawl_limit":10,"seo_plugin":"yoast"}]}' % tmp_path)
    md, amp, blocks = gsc_section(str(sites), {}, datetime.date(2026, 7, 18))
    assert "nicht konfiguriert" in md
    assert amp == "🟢"
    assert blocks == []


def test_diff_section_erstlauf_ohne_basis(tmp_path):
    cur = {"a": {"total": 2, "high": 0, "findings": [
        {"url": "https://a.de/", "field": "h1", "severity": "medium", "issue": "x"}]}}
    md, alert = diff_section(cur, [], str(tmp_path), "2026-07-18")
    assert "keine Vergleichsbasis" in md
    assert alert is False


def test_diff_section_neues_high_alarmiert(tmp_path):
    (tmp_path / "2026-07-11.json").write_text(
        '{"a": {"total": 0, "high": 0, "findings": []}}')
    cur = {"a": {"total": 1, "high": 1, "findings": [
        {"url": "https://a.de/x", "field": "meta_description", "severity": "high", "issue": "fehlt"}]}}
    md, alert = diff_section(cur, [], str(tmp_path), "2026-07-18")
    assert alert is True
    assert "a" in md


def test_diff_section_altformat_ohne_findings_kein_falscher_alarm(tmp_path):
    # Vorwochen-Snapshot vor Task 5b: nur "total", keine "findings"-Liste.
    (tmp_path / "2026-07-11.json").write_text('{"a": {"total": 1}}')
    cur = {"a": {"total": 1, "high": 1, "findings": [
        {"url": "https://a.de/x", "field": "meta_description", "severity": "high", "issue": "fehlt"}]}}
    md, alert = diff_section(cur, [], str(tmp_path), "2026-07-18")
    # total gleich geblieben (1 == 1) -> kein Netto-Anstieg, kein new-high-Alarm,
    # kein "+ neu"-Spam, weil die Finding-Ebene wie Erstlauf behandelt wird.
    assert alert is False
    assert "neues high-Finding" not in md
    assert "+ neu" not in md


def test_diff_section_altformat_ohne_findings_aber_netto_anstieg(tmp_path):
    # Vorwochen-Snapshot ohne "findings", aber total ist gestiegen -> Netto-Anstieg
    # bleibt weiterhin als Alarmkanal erhalten, auch ohne Finding-Ebenen-Diff.
    (tmp_path / "2026-07-11.json").write_text('{"a": {"total": 1}}')
    cur = {"a": {"total": 2, "high": 1, "findings": [
        {"url": "https://a.de/x", "field": "meta_description", "severity": "high", "issue": "fehlt"},
        {"url": "https://a.de/y", "field": "h1", "severity": "medium", "issue": "fehlt"}]}}
    md, alert = diff_section(cur, [], str(tmp_path), "2026-07-18")
    assert alert is True
    assert "gestiegen" in md
    assert "neues high-Finding" not in md
    assert "+ neu" not in md


def test_geo_section_ohne_prompts_und_ohne_route_ist_failsoft(tmp_path, monkeypatch):
    # sites.json ohne echte WP-Route; keine geo_prompts.json im cwd
    sites = tmp_path / "sites.json"
    sites.write_text('{"report_root":"%s","sites":[]}' % tmp_path)
    monkeypatch.chdir(tmp_path)
    md, data = geo_section(str(sites), {}, datetime.date(2026, 7, 18))
    assert "GEO-Sichtbarkeit" in md
    assert isinstance(data, dict)
    assert data == {"prompts": [], "bots": {}}
