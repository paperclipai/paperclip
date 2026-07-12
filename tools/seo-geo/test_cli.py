import json, os
from cli import main

def _write_sites(tmp_path):
    p = tmp_path / "sites.json"
    p.write_text(json.dumps({"report_root": str(tmp_path/"r"), "sites": [{
        "name":"x","url":"https://x.de","wp_rest_base":"https://x.de/wp-json",
        "credential_ref":"X_WP","crawl_limit":10,"seo_plugin":"yoast"}]}))
    return str(p)

def test_approve_moves_pending_to_approved(tmp_path):
    root = tmp_path / "r" / "x"
    (root / "pending").mkdir(parents=True)
    cs = root / "pending" / "cs1.json"
    cs.write_text(json.dumps({"site":"x","changes":[]}))
    rc = main(["approve","--changeset",str(cs),"--root",str(tmp_path/"r")], {})
    assert rc == 0
    assert (root / "approved" / "cs1.json").exists()
    assert not cs.exists()

def test_apply_consumes_approved(tmp_path):
    sites = _write_sites(tmp_path)
    root = tmp_path / "r" / "x"
    (root / "approved").mkdir(parents=True)
    (root / "approved" / "cs1.json").write_text(json.dumps(
        {"site":"x","changes":[{"target":"post","id":1,"field":"seo_title","old":"a","new":"b"}]}))
    calls = []
    class C:
        def set_yoast_meta(self,*a): calls.append(a); return {}
    rc = main(["apply","--site","x","--sites",sites,"--root",str(tmp_path/"r")],
              {"X_WP_USER":"u","X_WP_PW":"p"}, client_factory=lambda site,auth: C())
    assert rc == 0
    assert calls == [(1,"seo_title","b")]
    assert (root / "applied" / "cs1.json").exists()

def test_apply_moves_failing_changeset_to_failed(tmp_path):
    sites = _write_sites(tmp_path)
    root = tmp_path / "r" / "x"
    (root / "approved").mkdir(parents=True)
    (root / "approved" / "cs1.json").write_text(json.dumps(
        {"site":"x","changes":[{"target":"post","id":1,"field":"seo_title","old":"a","new":"b"}]}))
    class C:
        def set_yoast_meta(self,*a): raise RuntimeError("boom")
    rc = main(["apply","--site","x","--sites",sites,"--root",str(tmp_path/"r")],
              {"X_WP_USER":"u","X_WP_PW":"p"}, client_factory=lambda site,auth: C())
    assert rc == 0
    assert not (root / "applied" / "cs1.json").exists()
    assert (root / "failed" / "cs1.json").exists()


def test_http_fetch_decodes_utf8_when_charset_missing():
    """Server ohne charset im Content-Type: requests raet ISO-8859-1 und macht aus
    einem UTF-8-BOM Mojibake. Wir muessen trotzdem korrekt als UTF-8 dekodieren."""
    import requests_mock
    from cli import _http_fetch
    body = "﻿# WHITESTAG\n> Beschreibung mit Umlaut: schön\n".encode("utf-8")
    with requests_mock.Mocker() as m:
        m.get("https://x.de/llms.txt", content=body,
              headers={"Content-Type": "text/plain"})   # KEIN charset
        text = _http_fetch("https://x.de/llms.txt")
    assert text.lstrip("﻿").startswith("#")
    assert "schön" in text

def test_http_fetch_respects_declared_charset():
    import requests_mock
    from cli import _http_fetch
    with requests_mock.Mocker() as m:
        m.get("https://x.de/p", content="<html>schön</html>".encode("utf-8"),
              headers={"Content-Type": "text/html; charset=UTF-8"})
        assert "schön" in _http_fetch("https://x.de/p")
