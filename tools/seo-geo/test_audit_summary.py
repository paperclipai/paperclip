import datetime
import json

from audit_summary import _count, _dated_snapshots, _prev_snapshot, gsc_section


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
