# Design: Google-Search-Console-Anbindung (SEO/GEO-Monitoring 5a)

**Datum:** 2026-07-18
**Status:** Freigegeben (Brainstorming), bereit für Implementierungsplan
**Kontext:** Task 5a aus dem SEO/GEO-Monitoring. Ergänzt die bestehende
wöchentliche Onpage-Audit-Routine (`ing.whitestag.seo-geo-audit`, Mo 05:00) um
echte Ranking-Daten (Klicks/Impressionen/Position) je Site aus der Google Search
Console.

## Ziel

Die Montag-Audit-Mail an ws@whitestag.ai bekommt pro Site einen **GSC-Block**:
Kernkennzahlen mit Wochendelta, Top-Suchbegriffe, Top-Seiten, größte
Gewinner/Verlierer und eine eigene **Klick-Einbruch-Ampel**. Deterministisch,
DSGVO-lokal, headless (kein Browser, kein Token-Ablauf).

## Nicht-Ziele (bewusst ausgeklammert)

- Finding-Level-Diff des Onpage-Audits (= Task 5b, separat).
- GEO-Citation-Check / KI-Bot-Logauswertung (= Task 5c).
- Backlink-/SERP-Bausteine (= Task 5d).
- Interaktives Dashboard. Ausgabe ist ausschließlich die Wochen-Mail + History.

## Architektur (Variante A — Modul im bestehenden `tools/seo-geo/`-Dienst)

Ein Deploy, eine `sites.json`, ein Mailweg, ein Testschema. Zwei neue Module +
Erweiterungen an drei bestehenden Dateien.

### Neue Komponenten

**`gsc.py` — GSC-API-Client**
- Auth über Service-Account-JSON-Key. Pfad aus Env `GSC_SA_KEY_FILE`
  (in `~/.whitestag.env`); Key liegt **lokal** unter `~/.paperclip/scripts/seo-geo/`,
  **nicht** in CloudStorage (launchd-Lesbarkeit + Geheimhaltung).
- `list_properties() -> list[str]`: Properties, die der SA sehen darf
  (`webmasters.sites.list`) — Selbstauskunft für Auto-Match & Diagnose.
- `fetch_totals(property, start, end) -> dict`: Summen ohne Dimension
  (`searchanalytics.query`) → `clicks, impressions, ctr, position`.
- `fetch_top(property, dimension, start, end, limit) -> list[dict]`:
  Top-N nach `dimension` (`query` bzw. `page`), rowLimit=limit.
- Reine Datenschicht, kein Reporting, kein Mailversand. Testbar mit gemocktem
  HTTP-Client (analog `wpclient`/`test_wpclient`).

**`gsc_report.py` — Report-Bausteine**
- `build_site_block(site, gsc_client, window) -> SiteGscBlock`: holt Totals
  (letzte 7 vs. vorherige 7), Top-5-Queries, Top-5-Pages; berechnet Deltas;
  bestimmt Ampel.
- `movers(prev_top, cur_top) -> (gewinner, verlierer)`: größte Klick-Änderungen
  je Query.
- `ampel(click_delta_pct) -> str`: 🟢 ≥ −10 % · 🟡 −10 … −25 % · 🔴 < −25 %.
- `render_markdown(blocks) -> str`: die GSC-Sektion der Mail.
- Kennt keine Auth-Details und keinen Mailversand.

### Erweiterungen an Bestehendem

**`sites.json`** — je Site optionales Feld `gsc_property`:
- URL-Präfix-Property: `"https://www.whitestag.film/"`, **oder**
- Domain-Property: `"sc-domain:whitestag.film"`.
- Fehlt das Feld, versucht `gsc.py` Auto-Match gegen `list_properties()`
  (Heuristik: Property-Host == Site-Host); scheitert das → Block meldet
  „nicht in GSC / nicht verifiziert".

**`audit_summary.py`** — nach der Onpage-Ampel eine GSC-Sektion anhängen
(`gsc_report.render_markdown`). Betreff/Kopf wird 🔴, wenn **eine** Site
GSC-rot ist. Schreibt zusätzlich `_audit-history/<datum>-gsc.json`
(Roh-Kennzahlen je Site für spätere Trends).

**`audit-all.sh`** — keine Struktur­änderung nötig: `audit_summary.py` zieht die
GSC-Daten selbst; der Wrapper ruft es unverändert auf. (Falls Laufzeit/Robustheit
es nahelegt, kann die GSC-Erhebung ein eigener Schritt vor dem Summary werden —
Detail für den Plan.)

**`requirements.txt`** — `google-api-python-client`, `google-auth`.

## Datenfluss

```
launchd (Mo 05:00) → audit-all.sh
  ├─ cli.py audit --site … (4×)         [bestehend, Onpage]
  └─ audit_summary.py
       ├─ Onpage-Findings zählen         [bestehend]
       ├─ gsc.py: je Site Totals+Top holen (falls GSC_SA_KEY_FILE gesetzt)
       ├─ gsc_report.py: Blöcke + Ampel bauen
       ├─ _audit-history/<datum>.{json,md}  (+ <datum>-gsc.json)
       └─ send-walter-report.sh  (Onpage-Ampel + GSC-Sektion, kombinierter Betreff)
```

**Zeitfenster (GSC-Lag ~2-3 Tage):** `end = heute − 3`;
letzte Woche = `[end−6, end]`, Vorwoche = `[end−13, end−7]`. Datumsberechnung in
normalem Python (`datetime.date`), kein Workflow-Kontext → unbedenklich.

## Setup (einmalig)

**Durch Walter (extern, nicht automatisierbar):**
1. Google-Cloud-Projekt anlegen → **Google Search Console API** aktivieren →
   Service-Account erstellen → JSON-Key herunterladen.
2. Key nach `~/.paperclip/scripts/seo-geo/gsc-sa-key.json` legen (chmod 600),
   `GSC_SA_KEY_FILE` in `~/.whitestag.env` eintragen.
3. Die **SA-E-Mail** in jeder GSC-Property als Nutzer (Rolle „Eingeschränkt"
   genügt) hinzufügen.

**Durch Claude/Dienst (automatisierbar):**
4. **Verifizierung ai/de/vl:** mu-Plugin um Ausgabe eines
   `google-site-verification`-Meta-Tags erweitern (Token in WP-Option, per REST
   gesetzt). Walter holt den Token aus GSC („Property hinzufügen → HTML-Tag") →
   Claude spielt ihn per REST ein → Walter klickt „Bestätigen".
   (whitestag.film ist bereits verifiziert — Meta-Tag `81fbff23…` + DNS-TXT.)
5. `gsc_property` je Site in `sites.json` eintragen (nach Verifizierung bekannt).

Die Setup-Schritte 1-3 sind ein **Blocker** für Live-Daten, aber **nicht** für
die Implementierung: Der Code wird gegen gemockte API entwickelt und getestet und
verhält sich ohne Key fail-soft.

## Fehlerbehandlung (fail-soft, oberstes Prinzip)

Der GSC-Teil darf die bestehende Onpage-Audit-Mail **nie** kippen.

| Situation | Verhalten |
|-----------|-----------|
| `GSC_SA_KEY_FILE` fehlt/leer | GSC-Sektion: „GSC nicht konfiguriert"; Onpage-Audit + Mail laufen normal. |
| Site ohne `gsc_property` & kein Auto-Match | Nur dieser Block: „nicht in GSC / nicht verifiziert"; andere Sites normal. |
| API-/Netz-/Quota-Fehler je Property | 1× Retry, dann Block: „GSC-Abruf fehlgeschlagen (<grund>)"; übrige Sites + Onpage unberührt. |
| SA hat keinen Zugriff auf Property | Block meldet Zugriffsfehler mit Hinweis „SA-E-Mail als Nutzer hinzufügen". |

## Tests (Muster wie bestehende `test_*.py`, gemockte API)

- `test_gsc.py`: Totals-/Top-Parsing, Property-Auto-Match, Lag-Zeitfenster-Berechnung,
  Fehler-/Retry-Pfad, fehlender Key.
- `test_gsc_report.py`: Delta-Prozent-Rechnung (inkl. Division-durch-Null bei 0
  Vorwochen-Klicks), Ampel-Schwellen (−10/−25 % Grenzfälle), Movers-Berechnung,
  Markdown-Rendering, Site-ohne-Property-Block.
- Ergänzung `test_config.py`: `gsc_property` wird geladen/ist optional.

## Offene Detailfragen (für den Implementierungsplan, nicht blockierend)

- Genaue Query für Totals: eine `searchanalytics.query` ohne Dimension pro
  Zeitfenster (2 Calls je Site) vs. ein Call mit `date`-Dimension und lokaler
  Aggregation. Default: zwei Calls, simpel.
- Ampel-Betreff-Kombinatorik: getrennte Onpage- und GSC-Ampel im Betreff oder
  ein kombiniertes „schlechtestes" Signal. Default: beide Signale nennen.
- mu-Plugin-Versionierung (v0.1.0 → v0.2.0) für das Verifizierungs-Tag.
