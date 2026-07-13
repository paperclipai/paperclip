"""URL → WordPress-ID auflösen und das reiche Agenten-Changeset ins kanonische Format normalisieren.

Der SEO-Agent liefert Änderungen mit `url` + `current` + `wordpress_id: null`. Die
ID-Zuordnung ist mechanisch (WP-REST-Abfrage nach Slug) und gehört ins Werkzeug,
nicht ins LLM. Ergebnis: `{site, changes:[{target,id,field,old,new}]}` — genau das
Format, das validate/apply erwarten.
"""
from urllib.parse import urlparse


def slug_from_url(url: str) -> str:
    """Letztes Pfad-Segment einer URL (der WordPress-Slug)."""
    path = urlparse(url).path.rstrip("/")
    return path.split("/")[-1] if path else ""


def resolve_ids(changeset: dict, lookup):
    """Füllt IDs und normalisiert. `lookup(target, slug) -> (id, target)|None` ist injizierbar.

    Der Lookup liefert das KORRIGIERTE target (den Typ, in dem die ID tatsächlich
    gefunden wurde) — das Label des Agenten (page/post) ist unzuverlässig. Nur so
    schreibt der Apply später auf den richtigen Endpoint.

    Rückgabe: (kanonisches_changeset, unaufgelöste_liste). Cache pro (target, slug).
    """
    site = changeset.get("target_site") or changeset.get("site")
    out, unresolved, cache = [], [], {}
    for c in changeset.get("changes", []):
        url, target = c.get("url"), c.get("target")
        slug = slug_from_url(url) if url else ""
        key = (target, slug)
        if key not in cache:
            cache[key] = lookup(target, slug) if slug else None
        hit = cache[key]
        if hit is None:
            unresolved.append({"url": url, "field": c.get("field")})
            continue
        wid, resolved_target = hit
        out.append({
            "target": resolved_target,
            "id": wid,
            "field": c.get("field"),
            "old": c.get("current"),
            "new": c.get("new"),
        })
    return {"site": site, "changes": out}, unresolved
