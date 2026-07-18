import datetime

from audit_summary import gsc_section


def test_gsc_section_ohne_key_ist_failsoft(tmp_path):
    sites = tmp_path / "sites.json"
    sites.write_text('{"report_root":"%s","sites":[{"name":"a","url":"https://a.de",'
                     '"wp_rest_base":"https://a.de/wp-json","credential_ref":"A",'
                     '"crawl_limit":10,"seo_plugin":"yoast"}]}' % tmp_path)
    md, amp, blocks = gsc_section(str(sites), {}, datetime.date(2026, 7, 18))
    assert "nicht konfiguriert" in md
    assert amp == "🟢"
    assert blocks == []
