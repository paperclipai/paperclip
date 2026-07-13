from resolve import slug_from_url, resolve_ids


def test_slug_from_url_page():
    assert slug_from_url("https://www.whitestag.film/brandenburgische-technische-universitaet/") \
        == "brandenburgische-technische-universitaet"

def test_slug_from_url_dated_post():
    assert slug_from_url("https://www.whitestag.ai/2024/03/08/gefahr/") == "gefahr"

def test_slug_from_url_no_trailing_slash():
    assert slug_from_url("https://x.de/impressum") == "impressum"


# Das reiche Agenten-Changeset: url + current + null id
AGENT_CS = {
    "target_site": "whitestag.film",
    "changes": [
        {"url": "https://www.whitestag.film/a/", "field": "seo_title", "wordpress_id": None,
         "target": "page", "current": "Alt A", "new": "Neu A"},
        {"url": "https://www.whitestag.film/a/", "field": "meta_description", "wordpress_id": None,
         "target": "page", "current": "Desc A", "new": "d"*140},
        {"url": "https://www.whitestag.film/b/", "field": "meta_description", "wordpress_id": None,
         "target": "post", "current": "Desc B", "new": "d"*140},
        {"url": "https://www.whitestag.film/geloescht/", "field": "seo_title", "wordpress_id": None,
         "target": "page", "current": "X", "new": "Y"},
    ],
}

def _fake_lookup(target, slug):
    # liefert (id, korrigiertes_target) — "a" ist wirklich eine page, "b" ein post
    table = {("page", "a"): (11, "page"), ("post", "b"): (22, "post")}
    return table.get((target, slug))

def test_resolve_fills_ids_and_normalizes():
    cs, unresolved = resolve_ids(AGENT_CS, _fake_lookup)
    assert cs["site"] == "whitestag.film"
    # 3 aufloesbar (a x2, b), 1 nicht (geloescht)
    assert len(cs["changes"]) == 3
    a_title = cs["changes"][0]
    assert a_title == {"target": "page", "id": 11, "field": "seo_title", "old": "Alt A", "new": "Neu A"}
    # 'current' wurde zu 'old', 'wordpress_id' verschwunden
    assert "current" not in a_title and "wordpress_id" not in a_title

def test_resolve_caches_same_url():
    calls = []
    def counting_lookup(target, slug):
        calls.append((target, slug))
        return (11,"page") if slug == "a" else ((22,"post") if slug == "b" else None)
    resolve_ids(AGENT_CS, counting_lookup)
    # /a/ kommt 2x vor, darf aber nur EINMAL nachgeschlagen werden
    assert calls.count(("page", "a")) == 1

def test_resolve_reports_unresolved():
    cs, unresolved = resolve_ids(AGENT_CS, _fake_lookup)
    assert len(unresolved) == 1
    assert "geloescht" in unresolved[0]["url"]
