import re

def _locs(xml): return re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", xml)

def fetch_sitemap_urls(site, fetch) -> list[str]:
    root = site.url.rstrip("/") + "/sitemap.xml"
    xml = fetch(root)
    locs = _locs(xml)
    if "<sitemapindex" in xml:
        urls = []
        for sub in locs:
            urls.extend(_locs(fetch(sub)))
    else:
        urls = locs
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u); out.append(u)
    return out[: site.crawl_limit]
