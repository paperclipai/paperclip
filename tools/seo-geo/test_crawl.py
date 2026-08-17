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


YOAST_GRAPH = """
<html><head>
<title>T</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","name":"x"},
  {"@type":"Organization","name":"y"},
  {"@type":["WebSite","CreativeWork"],"name":"z"}
]}
</script>
</head><body><h1>H</h1></body></html>
"""

def test_parse_reads_types_from_jsonld_graph():
    # Yoast verpackt seine Typen in @graph, nicht als Top-Level @type
    s = parse_page("https://x.de/g", YOAST_GRAPH)
    assert "WebPage" in s.jsonld_types
    assert "Organization" in s.jsonld_types

def test_parse_handles_list_valued_type_in_graph():
    s = parse_page("https://x.de/g", YOAST_GRAPH)
    assert "WebSite" in s.jsonld_types
    assert "CreativeWork" in s.jsonld_types


IMGS = """
<html><head><title>T</title></head><body><h1>H</h1>
<img src="/wp-content/uploads/2024/01/foto-a.jpg" alt="hat alt">
<img src="/wp-content/uploads/2024/01/foto-b.jpg">
<img src="https://x.de/wp-content/uploads/2024/02/foto-c.png" alt="   ">
</body></html>
"""

def test_parse_records_which_images_lack_alt():
    s = parse_page("https://x.de/p", IMGS)
    assert s.images_total == 3
    assert s.images_missing_alt == 2
    # Nicht nur zaehlen: die konkreten Quellen merken, sonst kann niemand sie zuordnen
    assert s.images_without_alt == [
        "/wp-content/uploads/2024/01/foto-b.jpg",
        "https://x.de/wp-content/uploads/2024/02/foto-c.png",
    ]

def test_images_without_alt_empty_when_all_have_alt():
    s = parse_page("https://x.de/p", '<html><body><img src="a.jpg" alt="da"></body></html>')
    assert s.images_without_alt == []
