from config import Site
from sitemap import fetch_sitemap_urls

SITE = Site("x","https://x.de","https://x.de/wp-json","X_WP",100,"yoast")

INDEX = """<sitemapindex><sitemap><loc>https://x.de/post-sitemap.xml</loc></sitemap></sitemapindex>"""
POSTS = """<urlset><url><loc>https://x.de/a</loc></url><url><loc>https://x.de/b</loc></url></urlset>"""

def test_follows_index_to_urls():
    resp = {"https://x.de/sitemap.xml": INDEX, "https://x.de/post-sitemap.xml": POSTS}
    urls = fetch_sitemap_urls(SITE, lambda u: resp[u])
    assert urls == ["https://x.de/a", "https://x.de/b"]

def test_plain_urlset():
    resp = {"https://x.de/sitemap.xml": POSTS}
    urls = fetch_sitemap_urls(SITE, lambda u: resp[u])
    assert set(urls) == {"https://x.de/a", "https://x.de/b"}
