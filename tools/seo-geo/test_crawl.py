from crawl import parse_page

HTML = """
<html><head>
<title>Beispielseite</title>
<meta name="description" content="Kurze Beschreibung.">
<meta property="og:title" content="OG Titel">
<link rel="canonical" href="https://x.de/seite">
<script type="application/ld+json">{"@type":"Organization"}</script>
</head><body>
<h1>Titel</h1>
<img src="a.jpg" alt="hat alt">
<img src="b.jpg">
</body></html>
"""

def test_parse_extracts_core_signals():
    s = parse_page("https://x.de/seite", HTML)
    assert s.title == "Beispielseite"
    assert s.meta_description == "Kurze Beschreibung."
    assert s.og_title == "OG Titel"
    assert s.canonical == "https://x.de/seite"
    assert s.h1_count == 1
    assert s.images_total == 2
    assert s.images_missing_alt == 1
    assert s.jsonld_types == ["Organization"]

def test_parse_handles_missing_fields():
    s = parse_page("https://x.de/leer", "<html><head></head><body></body></html>")
    assert s.title is None
    assert s.meta_description is None
    assert s.images_total == 0
    assert s.jsonld_types == []
