from dataclasses import dataclass
from crawl import PageSignals

@dataclass
class Finding:
    url: str
    field: str
    severity: str
    issue: str

def evaluate_page(sig: PageSignals) -> list[Finding]:
    out: list[Finding] = []
    def add(field, sev, issue): out.append(Finding(sig.url, field, sev, issue))

    if not sig.title:
        add("seo_title", "high", "Kein Title vorhanden")
    elif len(sig.title) > 60:
        add("seo_title", "medium", f"Title zu lang ({len(sig.title)} > 60)")

    if not sig.meta_description:
        add("meta_description", "high", "Keine Meta-Description")
    elif not (120 <= len(sig.meta_description) <= 160):
        add("meta_description", "medium",
            f"Description-Länge {len(sig.meta_description)} außerhalb 120–160")

    if not sig.og_title:
        add("og_title", "low", "Kein og:title")
    if not sig.og_description:
        add("og_description", "low", "Kein og:description")
    if sig.h1_count != 1:
        add("h1", "medium", f"{sig.h1_count} H1-Überschriften (soll: genau 1)")
    if sig.images_missing_alt > 0:
        add("alt_text", "medium", f"{sig.images_missing_alt} Bilder ohne Alt-Text")
    if not sig.jsonld_types:
        add("schema", "low", "Kein JSON-LD/Schema gefunden")
    return out
