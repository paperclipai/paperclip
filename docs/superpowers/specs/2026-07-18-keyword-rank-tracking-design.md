# Design: Keyword-Rank-Tracking (SEO/GEO-Monitoring 5d, Gratis-Variante)

**Datum:** 2026-07-18
**Status:** Freigegeben (Brainstorming), bereit für Implementierungsplan
**Kontext:** Task 5d. **Bewusst die kostenlose Variante:** statt bezahlter SERP-/
Backlink-APIs nutzen wir die bereits angebundene **Google Search Console** (5a),
um die tatsächlichen Google-Rankings (Ø-Position) je Ziel-Keyword wöchentlich zu
tracken.

## Ziel

Neue Mail-Sektion „Keyword-Rankings" je Site: je Keyword die **Ø-Position** dieser
Woche + **Veränderung zur Vorwoche** (verbessert ↑ / verschlechtert ↓), plus
Impressionen. Getrackt werden **Kern-Keywords (feste Liste je Site) ∪ automatische
Top-Queries aus GSC**. History in `_audit-history/<date>-ranks.json`.

## Nicht-Ziele / bewusste Grenzen

- **Keine Backlinks** — die GSC-API gibt den Links-Report nicht her; echte
  Backlink-Daten nur bei bezahlten Diensten. Bleibt Walters manueller GSC-UI-Blick.
- **Keine bezahlten SERP-/Scraping-Dienste** (SerpBear/Oxylabs) — kostenlos only.
- **Nur Keywords mit Impressionen:** GSC liefert nur Begriffe, bei denen die Site
  bereits erscheint. Ein Kern-Keyword ohne Impressionen wird als „nicht in GSC
  (keine Impressionen)" ausgewiesen — ehrlich statt erfunden.
- **Kein neuer Alarm-Trigger** in v1 (informativ; der 5b-Alarm bleibt unberührt).

## Architektur (Module im bestehenden `tools/seo-geo/`-Dienst, GSC-Wiederverwendung)

### Erweiterung `gsc.py`

- `fetch_query_metrics(property_url, queries, start, end) -> list[dict]` — gezielte
  `searchanalytics.query` mit `dimensions:["query"]` und `dimensionFilterGroups`
  (Filter `query`/`equals` je Kern-Keyword, ODER-verknüpft). Liefert je gefundenem
  Keyword `{key, clicks, impressions, ctr, position}` (nur die mit Impressionen).
  (Auto-Top nutzt das bestehende `fetch_top(prop,"query",…)`.)

### Neues Modul `rank_tracking.py` (rein)

- `pos_delta(prev_pos, cur_pos) -> float | None` — `prev - cur` (positiv = verbessert,
  weil kleinere Position besser); `None` wenn keine Vorwoche.
- `merge_keywords(core_rows, auto_rows) -> list[dict]` — Union nach `key`
  (Kern-Keywords markiert `core: True`), dedupliziert; Kern-Keywords ohne Row
  erscheinen als `{key, core: True, missing: True}`.
- `build_site_ranks(cur_rows, prev_rows, core_keys) -> list[dict]` — je Keyword
  `{key, core, position, impressions, delta, missing?}`; `delta` aus `pos_delta`.
- `render_markdown(per_site) -> str` — Sektion „Keyword-Rankings"; Pfeil ↑ (besser)
  / ↓ (schlechter) / – (neu/keine Vorwoche); Kern-Keywords zuerst.

### Config `geo_keywords.example.json`

```json
{
  "auto_top": 10,
  "keywords": {
    "whitestag.film": ["360 grad film", "vr filmproduktion cottbus", "virtuelles cottbus"],
    "whitestag.ai": ["ki beratung lausitz", "ki agenten unternehmen"],
    "whitestag.de": [],
    "virtuelle-lausitz.de": []
  }
}
```

### Integration `audit_summary.py`

- `rank_section(sites_path, environ, today) -> tuple[str, dict]` (markdown, ranks_data),
  **fail-soft**: baut GSC-Client (wie `gsc_section`); je Site: Kern-Keywords via
  `fetch_query_metrics` (last7 + prev7) + Auto-Top via `fetch_top`; `rank_tracking`
  rechnet Delta; rendert. Kein SA-Key / keine `geo_keywords.json` / Fehler →
  Sektion meldet, Rest läuft.
- `main()`: Sektion nach dem GSC/GEO-Block anhängen; `<date>-ranks.json` schreiben.

## Datenfluss

```
audit_summary.main()
  └─ rank_section()
       ├─ GSC-Client (Service-Account, wie 5a)
       ├─ je Site: core = fetch_query_metrics(kernliste, last7|prev7)
       │           auto = fetch_top("query", last7|prev7, auto_top)
       │           rank_tracking.build_site_ranks(...) → Ø-Pos + Δ
       ├─ Sektion „Keyword-Rankings" an Body
       └─ _audit-history/<date>-ranks.json
```

Zeitfenster: dieselben `gsc.report_windows(today)` wie 5a (letzte 7 vs. vorherige 7, Lag 3).

## Fehlerbehandlung (fail-soft)

| Situation | Verhalten |
|-----------|-----------|
| kein `GSC_SA_KEY_FILE` | Sektion: „GSC nicht konfiguriert — kein Rank-Tracking". |
| `geo_keywords.json` fehlt | nur Auto-Top; Kern-Liste leer. |
| Site ohne Property / API-Fehler | Site-Zeile: „keine Rank-Daten (…)"; übrige Sites normal. |
| Kern-Keyword ohne Impressionen | als „nicht in GSC (keine Impressionen)" markiert. |
| Exception in `rank_section` | gefangen; Onpage+Diff+GSC+GEO+Mail laufen normal. |

## Tests

- `test_gsc.py`: `fetch_query_metrics` (Filter-Body korrekt, Parsing) via requests_mock.
- `test_rank_tracking.py`: `pos_delta` (Vorzeichen/None), `merge_keywords` (Union,
  core-Markierung, missing), `build_site_ranks`, `render_markdown` (Pfeile).
- `test_audit_summary.py`: `rank_section` fail-soft ohne Key/ohne Keywords.

## Offene Detailfragen (für den Plan, nicht blockierend)

- `auto_top`-Default = 10; justierbar in der Config.
- Sortierung der Ausgabe: Kern-Keywords zuerst, dann Auto nach Impressionen.
- Rank-Verschlechterung als späteres 5b-Alarm-Kriterium denkbar (v2).
