import requests, requests_mock
from wpclient import WPClient

BASE = "https://x.de/wp-json"

def _client():
    return WPClient(BASE, auth=("bot", "pw"))

def test_set_yoast_meta_maps_field_and_posts():
    with requests_mock.Mocker() as m:
        m.post(f"{BASE}/wp/v2/posts/12",
               json={"id": 12, "meta": {"_yoast_wpseo_title": "Neu"}})
        res = _client().set_yoast_meta(12, "seo_title", "Neu")
        assert res["meta"]["_yoast_wpseo_title"] == "Neu"
        assert m.last_request.json() == {"meta": {"_yoast_wpseo_title": "Neu"}}

def test_set_alt_text_posts_media():
    with requests_mock.Mocker() as m:
        m.post(f"{BASE}/wp/v2/media/7", json={"id": 7, "alt_text": "Bild"})
        res = _client().set_alt_text(7, "Bild")
        assert res["alt_text"] == "Bild"

def test_set_yoast_meta_pages_endpoint():
    with requests_mock.Mocker() as m:
        m.post(f"{BASE}/wp/v2/pages/5",
               json={"id": 5, "meta": {"_yoast_wpseo_title": "Neu"}})
        res = _client().set_yoast_meta(5, "seo_title", "Neu", post_type="pages")
        assert res["meta"]["_yoast_wpseo_title"] == "Neu"
        assert m.last_request.json() == {"meta": {"_yoast_wpseo_title": "Neu"}}

def test_set_llms_txt_hits_custom_route():
    with requests_mock.Mocker() as m:
        m.post(f"{BASE}/whitestag-seo-geo/v1/llms", json={"ok": True})
        res = _client().set_llms_txt("# Site\n")
        assert res["ok"] is True
        assert m.last_request.json() == {"content": "# Site\n"}

def test_set_gsc_verification_hits_route():
    with requests_mock.Mocker() as m:
        m.post(f"{BASE}/whitestag-seo-geo/v1/gsc-verify", json={"ok": True})
        res = _client().set_gsc_verification("81fbff23ab17d859")
        assert res["ok"] is True
        assert m.last_request.json() == {"token": "81fbff23ab17d859"}


def test_check_editable_ok():
    with requests_mock.Mocker() as m:
        m.get(f"{BASE}/wp/v2/pages/845", json={"id": 845})
        assert _client().check_editable("page", 845) is None

def test_check_editable_flags_forbidden():
    # Die Datenschutzseite liefert 403 rest_forbidden_context fuer Redakteure
    with requests_mock.Mocker() as m:
        m.get(f"{BASE}/wp/v2/pages/290", status_code=403,
              json={"code": "rest_forbidden_context"})
        p = _client().check_editable("page", 290)
        assert p is not None and "403" in p and "rest_forbidden_context" in p

def test_check_editable_flags_missing():
    with requests_mock.Mocker() as m:
        m.get(f"{BASE}/wp/v2/posts/9999", status_code=404, json={"code": "rest_post_invalid_id"})
        assert "404" in _client().check_editable("post", 9999)

def test_check_editable_skips_site_target():
    assert _client().check_editable("site", None) is None


def test_find_id_by_slug_hit():
    with requests_mock.Mocker() as m:
        m.get(f"{BASE}/wp/v2/pages", json=[{"id": 845}])
        assert _client().find_id_by_slug("pages", "start") == 845

def test_find_id_by_slug_miss():
    with requests_mock.Mocker() as m:
        m.get(f"{BASE}/wp/v2/posts", json=[])
        assert _client().find_id_by_slug("posts", "gibtsnicht") is None


def test_get_ai_bot_hits():
    with requests_mock.Mocker() as m:
        m.get(f"{BASE}/whitestag-seo-geo/v1/aibots",
              json={"2026-W29": {"GPTBot": 4}})
        assert _client().get_ai_bot_hits() == {"2026-W29": {"GPTBot": 4}}
