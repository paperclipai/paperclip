# Design: Audit-Diff + Alerting (SEO/GEO-Monitoring 5b)

**Datum:** 2026-07-18
**Status:** Freigegeben (Brainstorming), bereit für Implementierungsplan
**Kontext:** Task 5b aus dem SEO/GEO-Monitoring. Erweitert die wöchentliche
Audit-Routine (`ing.whitestag.seo-geo-audit`, Mo 05:00) von reiner
Momentaufnahme zu echtem **Monitoring mit Alarm**: Findings werden Woche-zu-Woche
auf **Finding-Ebene** verglichen (neu / behoben / Regression), und bei
Verschlechterung schlägt der Bericht Alarm (⚠️-Betreff + rote Markierung).

## Ziel

Die Montags-Audit-Mail bekommt eine Sektion „**Veränderungen seit Vorwoche**"
je Site (`+ neu`, `− behoben`, `⚠️ Regression`) und einen **Gesamt-Alarm**, der
den Mail-Betreff mit `⚠️` markiert, sobald bei irgendeiner Site einer von vier
Triggern feuert.

## Alarm-Trigger (alle vier aktiv; Alarm feuert bei JEDEM)

1. **Neues `high`-Finding** — ein high-Severity-Finding, das im Vorwochen-Snapshot
   nicht vorhanden war.
2. **Regression** — ein Finding, das diese Woche neu ist (vs. Vorwoche) UND in
   einem **älteren** Snapshot schon einmal vorhanden war (behoben → wieder da).
3. **Netto-Anstieg** — die Gesamt-Finding-Zahl einer Site ist höher als in der Vorwoche.
4. **GSC-Klick-Einbruch** — GSC-Ampel der Site ist 🔴 (Klicks > 25 % runter; aus 5a).

## Nicht-Ziele

- GEO-Citation-Check (= 5c), Backlink/SERP (= 5d).
- Historie-UI/Dashboard. Ausgabe bleibt die Wochen-Mail + `_audit-history/`.
- Kein Alarm bei Verbesserung (behoben ist gut, nur informativ).

## Speicher-Änderung (Voraussetzung fürs Finding-Diff)

Heute speichert `_audit-history/<date>.json` je Site nur Zählwerte
(`total, pages, high, medium, low, by_field`). Für ein Finding-Diff muss der
Snapshot die **Findings selbst** enthalten.

- **Additiv:** je Site-Eintrag ein neues Feld
  `findings: [{url, field, severity, issue}]` neben den bestehenden Zählwerten.
- Bestehende Felder bleiben unverändert → das vorhandene Wochendelta
  (`_prev_snapshot`/`_delta`, liest `[name]["total"]`) bricht nicht.
- **Finding-Schlüssel = `(url, field)`.** Ein Finding ist „dasselbe" über Wochen,
  wenn URL und Feld gleich sind (der `issue`-Text mit Zahlen wie „Länge 282" ist
  instabil und wird nur zur Anzeige gespeichert, nicht zum Matchen).
- Quelle der Findings: die frische `report.json` je Site (die `collect()` ohnehin
  liest) — `_count()` liefert künftig zusätzlich die Roh-Findings mit.

## Architektur (Modul im bestehenden `tools/seo-geo/`-Dienst)

### Neue Komponente

**`audit_diff.py`** — reine Diff-/Alarm-Logik, kein HTTP, kein Mailversand.
- `finding_key(f) -> tuple` → `(f["url"], f["field"])`.
- `diff_findings(prev, cur) -> dict` → `{"new": [...], "resolved": [...]}` (Listen
  von Findings; `new` = Schlüssel nur in `cur`, `resolved` = nur in `prev`).
- `find_regressions(cur_new, older_snapshots) -> list` → aus den neu-Findings jene,
  deren `(url, field)` in mindestens einem älteren Snapshot vorkam.
- `site_alerts(diff, regressions, prev_count, cur_count, gsc_ampel) -> list[str]`
  → welche der 4 Trigger für diese Site feuern (Klartext-Gründe).
- `render_markdown(per_site) -> str` → Sektion „Veränderungen seit Vorwoche".
- `any_alert(per_site) -> bool` → Gesamt-Alarm-Flag.

### Erweiterungen an Bestehendem

**`audit_summary.py`**
- `_count()` (bzw. `collect()`) liefert je Site zusätzlich die Roh-`findings`
  (für den Snapshot + Diff).
- Der `<date>.json`-Snapshot enthält je Site das neue `findings`-Feld.
- Neue `diff_section(cur_counts, gsc_blocks, hist_dir, today) -> tuple[str, bool]`
  lädt Vorwochen- und ältere Snapshots, ruft `audit_diff` auf, liefert
  `(markdown, alert_flag)`. Fail-soft.
- In `main()`: Diff-Sektion in den Body einfügen (zwischen Onpage-Tabelle und
  GSC-Block); Alarm-Flag in eine kleine Datei `_audit-history/<date>-alert.txt`
  schreiben (`ALERT`/`OK`), damit `audit-all.sh` den Betreff setzen kann.

**`audit-all.sh`**
- Nach `audit_summary` die Flag-Datei lesen; ist sie `ALERT`, den Mail-Betreff
  auf `⚠️ SEO/GEO Wochen-Audit <date> — Verschlechterung` setzen, sonst wie bisher.

## Datenfluss

```
audit-all.sh
  ├─ cli.py audit --site … (4×)             [bestehend]
  ├─ audit_summary.py
  │    ├─ collect(): Counts + Roh-Findings je Site
  │    ├─ Snapshot <date>.json  (jetzt inkl. findings[])
  │    ├─ Onpage-Ampel-Tabelle                [bestehend]
  │    ├─ diff_section(): Vorwoche + ältere Snapshots → neu/behoben/Regression + Alarm
  │    │     └─ schreibt <date>-alert.txt = ALERT|OK
  │    ├─ gsc_section()                        [5a]
  │    └─ Body = Onpage + Diff + GSC
  └─ Betreff aus <date>-alert.txt (⚠️ … — Verschlechterung | normal) → Mail
```

## Fehlerbehandlung (fail-soft)

| Situation | Verhalten |
|-----------|-----------|
| Kein Vorwochen-Snapshot (Erstlauf) | Diff-Sektion: „keine Vergleichsbasis — Diff ab nächster Woche"; Alarm-Flag `OK`. |
| Vorwochen-Snapshot ohne `findings` (Alt-Format) | wie Erstlauf für die Diff-Ebene behandeln; Netto-Anstieg über `total` bleibt möglich. |
| Defekte/unlesbare History-Datei | überspringen; restliche Sites normal; Flag konservativ `OK` wenn nichts vergleichbar. |
| Exception in der Diff-Sektion | gefangen, Sektion meldet Fehler, `OK`; **Onpage + GSC + Mail laufen normal**. |

Regel wie 5a: Der Diff-Teil darf die bestehende Mail nie kippen.

## Tests (`test_audit_diff.py`, gemockte Findings-Sets)

- `diff_findings`: neu-/behoben-Erkennung über `(url, field)`; `issue`-Text-Änderung
  bei gleichem Schlüssel gilt NICHT als neu.
- `find_regressions`: neu-Finding, das in einem älteren (nicht dem letzten) Snapshot
  war → Regression; neu-Finding ohne Historie → keine Regression.
- `site_alerts`: jede der 4 Regeln einzeln (neues high; Regression; Netto-Anstieg;
  GSC-🔴) und der Fall „kein Alarm".
- `any_alert`, `render_markdown` (enthält Sitename, +neu/−behoben/⚠️).
- Erstlauf ohne Vorwoche → keine Krise, Flag OK.
- Ergänzung `test_audit_summary.py`: Snapshot enthält `findings`; `diff_section`
  fail-soft ohne History.

## Offene Detailfragen (für den Plan, nicht blockierend)

- „Älterer Snapshot" für Regression: alle `<date>.json` außer dem der Vorwoche und
  dem heutigen, oder ein Fenster (z. B. letzte 8 Wochen). Default: alle vorhandenen
  älteren, das ist bei wöchentlicher Kadenz überschaubar.
- Betreff-Kombinatorik mit 5a: aktuell trägt der Betreff das 5b-Alarm-`⚠️`; die
  GSC-🔴 ist Teil von Trigger 4, fließt also mit ein. Onpage-Ampel bleibt im Body.
