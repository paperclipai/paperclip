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


def test_validate_reports_problems_and_exits_1(tmp_path, capsys):
    sites = _write_sites(tmp_path)
    cs = tmp_path / "bad.json"
    cs.write_text(json.dumps({"site":"x","changes":[
        {"target":"post","id":474,"field":"seo_title","old":None,"new":"z"*71},
        {"target":"post","id":1,"field":"body","old":None,"new":"boese"},
    ]}))
    rc = main(["validate","--site","x","--sites",sites,"--changeset",str(cs),"--no-live"], {})
    out = capsys.readouterr().out
    assert rc == 1
    assert "FEHLGESCHLAGEN" in out
    assert "Whitelist" in out and "474" in out

def test_validate_live_check_catches_forbidden_page(tmp_path, capsys):
    sites = _write_sites(tmp_path)
    cs = tmp_path / "cs.json"
    cs.write_text(json.dumps({"site":"x","changes":[
        {"target":"page","id":290,"field":"meta_description","old":None,"new":"d"*140}]}))
    class C:
        def check_editable(self, target, oid):
            return "nicht editierbar (HTTP 403 rest_forbidden_context)"
    rc = main(["validate","--site","x","--sites",sites,"--changeset",str(cs)],
              {"X_WP_USER":"u","X_WP_PW":"p"}, client_factory=lambda s,a: C())
    out = capsys.readouterr().out
    assert rc == 1
    assert "403" in out and "290" in out

def test_validate_clean_exits_0(tmp_path, capsys):
    sites = _write_sites(tmp_path)
    cs = tmp_path / "ok.json"
    cs.write_text(json.dumps({"site":"x","changes":[
        {"target":"page","id":1,"field":"meta_description","old":None,"new":"d"*140}]}))
    class C:
        def check_editable(self, t, i): return None
    rc = main(["validate","--site","x","--sites",sites,"--changeset",str(cs)],
              {"X_WP_USER":"u","X_WP_PW":"p"}, client_factory=lambda s,a: C())
    assert rc == 0
    assert "VALIDIERUNG OK" in capsys.readouterr().out


def test_resolve_fills_ids_and_writes(tmp_path):
    sites = _write_sites(tmp_path)
    cs = tmp_path / "agent.json"
    cs.write_text(json.dumps({"target_site":"x","changes":[
        {"url":"https://x.de/start/","field":"seo_title","wordpress_id":None,
         "target":"page","current":"Alt","new":"Neu"}]}))
    out = tmp_path / "resolved.json"
    class C:
        def find_id_by_slug(self, ep, slug): return 845 if (ep=="pages" and slug=="start") else None
    rc = main(["resolve","--site","x","--sites",sites,"--changeset",str(cs),"--out",str(out)],
              {"X_WP_USER":"u","X_WP_PW":"p"}, client_factory=lambda s,a: C())
    assert rc == 0
    d = json.loads(out.read_text())
    assert d["changes"][0] == {"target":"page","id":845,"field":"seo_title","old":"Alt","new":"Neu"}

def test_resolve_reports_unresolved_exit1(tmp_path, capsys):
    sites = _write_sites(tmp_path)
    cs = tmp_path / "agent.json"
    cs.write_text(json.dumps({"target_site":"x","changes":[
        {"url":"https://x.de/weg/","field":"seo_title","wordpress_id":None,
         "target":"page","current":"A","new":"B"}]}))
    class C:
        def find_id_by_slug(self, ep, slug): return None
    rc = main(["resolve","--site","x","--sites",sites,"--changeset",str(cs),"--out",str(tmp_path/"o.json")],
              {"X_WP_USER":"u","X_WP_PW":"p"}, client_factory=lambda s,a: C())
    assert rc == 1
    assert "NICHT auflösbar" in capsys.readouterr().out


def test_resolve_corrects_target_from_where_id_found(tmp_path):
    sites = _write_sites(tmp_path)
    cs = tmp_path / "agent.json"
    # Agent labelt als 'page', Objekt ist aber ein POST
    cs.write_text(json.dumps({"target_site":"x","changes":[
        {"url":"https://x.de/news/","field":"meta_description","wordpress_id":None,
         "target":"page","current":"A","new":"d"*140}]}))
    out = tmp_path / "r.json"
    class C:
        def find_id_by_slug(self, ep, slug):
            return 4184 if ep=="posts" else None   # nur in posts
    rc = main(["resolve","--site","x","--sites",sites,"--changeset",str(cs),"--out",str(out)],
              {"X_WP_USER":"u","X_WP_PW":"p"}, client_factory=lambda s,a: C())
    assert rc == 0
    ch = json.loads(out.read_text())["changes"][0]
    assert ch["target"] == "post" and ch["id"] == 4184   # target korrigiert!
