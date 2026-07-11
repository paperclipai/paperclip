from crawl import PageSignals
from findings import evaluate_page

def _fields(findings):
    return {(f.field, f.severity) for f in findings}

def test_missing_title_and_description_are_high():
    sig = PageSignals(url="https://x.de/a", h1_count=1)
    fields = _fields(evaluate_page(sig))
    assert ("seo_title", "high") in fields
    assert ("meta_description", "high") in fields

def test_length_violations_are_medium():
    sig = PageSignals(url="https://x.de/b", title="x"*70,
                      meta_description="y"*80, og_title="o", og_description="o",
                      h1_count=1, jsonld_types=["WebPage"])
    fields = _fields(evaluate_page(sig))
    assert ("seo_title", "medium") in fields
    assert ("meta_description", "medium") in fields

def test_clean_page_has_no_findings():
    sig = PageSignals(url="https://x.de/c", title="Guter Titel",
                      meta_description="d"*140, og_title="o", og_description="o",
                      canonical="https://x.de/c", h1_count=1, images_total=0,
                      images_missing_alt=0, jsonld_types=["WebPage"])
    assert evaluate_page(sig) == []
