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
