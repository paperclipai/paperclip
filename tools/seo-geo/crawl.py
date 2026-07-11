import json
from dataclasses import dataclass, field
from bs4 import BeautifulSoup

@dataclass
class PageSignals:
    url: str
    title: str | None = None
    meta_description: str | None = None
    og_title: str | None = None
    og_description: str | None = None
    canonical: str | None = None
    h1_count: int = 0
    images_total: int = 0
    images_missing_alt: int = 0
    jsonld_types: list[str] = field(default_factory=list)

def _meta(soup, **attrs):
    tag = soup.find("meta", attrs=attrs)
    return tag.get("content").strip() if tag and tag.get("content") else None

def parse_page(url: str, html: str) -> PageSignals:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text().strip() if soup.title else None
    canonical_tag = soup.find("link", rel="canonical")
    imgs = soup.find_all("img")
    types = []
    for s in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(s.get_text())
        except (ValueError, TypeError):
            continue
        for node in (data if isinstance(data, list) else [data]):
            t = node.get("@type") if isinstance(node, dict) else None
            if isinstance(t, str):
                types.append(t)
    return PageSignals(
        url=url,
        title=title,
        meta_description=_meta(soup, name="description"),
        og_title=_meta(soup, property="og:title"),
        og_description=_meta(soup, property="og:description"),
        canonical=canonical_tag.get("href").strip() if canonical_tag and canonical_tag.get("href") else None,
        h1_count=len(soup.find_all("h1")),
        images_total=len(imgs),
        images_missing_alt=sum(1 for i in imgs if not i.get("alt", "").strip()),
        jsonld_types=types,
    )
