import json, pathlib
from config import load_sites, resolve_credential

def test_load_sites_parses_entries(tmp_path):
    p = tmp_path / "sites.json"
    p.write_text(json.dumps({"report_root": "/tmp/r", "sites": [{
        "name": "x", "url": "https://x.de", "wp_rest_base": "https://x.de/wp-json",
        "credential_ref": "X_WP", "crawl_limit": 50, "seo_plugin": "yoast"}]}))
    sites = load_sites(str(p))
    assert sites[0].name == "x"
    assert sites[0].crawl_limit == 50

def test_resolve_credential_reads_env():
    from config import Site
    s = Site(name="x", url="https://x.de", wp_rest_base="https://x.de/wp-json",
             credential_ref="X_WP", crawl_limit=50, seo_plugin="yoast")
    user, pw = resolve_credential(s, {"X_WP_USER": "bot", "X_WP_PW": "abcd efgh"})
    assert (user, pw) == ("bot", "abcd efgh")
