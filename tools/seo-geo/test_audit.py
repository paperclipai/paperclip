import json
from config import Site
from audit import run_audit, write_report

SITE = Site("x", "https://x.de", "https://x.de/wp-json", "X_WP", 10, "yoast")

def _fetch_factory(pages, llms=""):
    def fetch(url):
        if url.endswith("/llms.txt"):
            return llms
        return pages[url]
    return fetch

def test_run_audit_collects_pages_and_findings():
    pages = {"https://x.de/a": "<html><head></head><body></body></html>"}
    report = run_audit(SITE, _fetch_factory(pages), ["https://x.de/a"])
    assert report.site_name == "x"
    assert len(report.pages) == 1
    assert any(f.field == "seo_title" for f in report.findings)
    assert report.site_level["llms_txt_present"] is False

def test_run_audit_respects_crawl_limit():
    urls = [f"https://x.de/{i}" for i in range(20)]
    pages = {u: "<html></html>" for u in urls}
    small = Site("x", "https://x.de", "https://x.de/wp-json", "X_WP", 5, "yoast")
    report = run_audit(small, _fetch_factory(pages), urls)
    assert len(report.pages) == 5

def test_write_report_emits_json_and_md(tmp_path):
    pages = {"https://x.de/a": "<html><head></head><body></body></html>"}
    report = run_audit(SITE, _fetch_factory(pages), ["https://x.de/a"])
    jpath, mpath = write_report(report, str(tmp_path))
    data = json.loads(open(jpath).read())
    assert data["site_name"] == "x"
    assert "## Findings" in open(mpath).read()
