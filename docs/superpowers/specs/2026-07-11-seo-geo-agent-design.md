---
title: SEO/GEO-Agent für WHITESTAG — Design-Spec
datum: 2026-07-11
typ: Spec
status: Entwurf (zur Freigabe)
company: WHITESTAG
verwandt:
  - SEO-GEO/Arbeitsanleitung llms.txt fuer Agenten.md
  - project_bild_service.md (Muster: Dienst macht Arbeit, Agent denkt)
---

# SEO/GEO-Agent für WHITESTAG

## 1. Ziel & Abgrenzung

Ein neuer, dedizierter **SEO/GEO-Agent** in der WHITESTAG-Company analysiert
Walters WordPress-Websites hinsichtlich technischer SEO und GEO (Generative
Engine Optimization) und **schlägt konkrete technische Änderungen vor**, die
nach Freigabe automatisch per WordPress-REST-API umgesetzt werden.

**In Scope (nur technische Metadaten):** SEO-Title, Meta-Description,
Open-Graph/Twitter-Cards, Bild-Alt-Texte, Canonical-URLs, Schema/JSON-LD,
`llms.txt`, robots.txt-/sitemap.xml-Hygiene, H1-Eindeutigkeit (nur Melden,
nicht Ändern).

**Explizit NICHT in Scope (redaktioneller Inhalt bleibt unangetastet):**
Fließtext, Überschriften-Wortlaut, Slugs/URLs (Redirect-Risiko), Seiten
anlegen/löschen, Design/Layout.

**Nicht-Ziel:** Seobility-Integration. Seobility bleibt Walters separater
manueller Workflow; der Agent macht ein eigenes technisches Audit.

## 2. Kernentscheidungen (aus dem Brainstorming)

| Frage | Entscheidung |
|---|---|
| Plattform | WordPress |
| Autonomie | Vorschlag zuerst → Walter gibt frei → dann Umsetzung |
| Datenquelle | Nur eigener Crawl (keine Seobility-API/-Import) |
| Agent | Neuer dedizierter SEO/GEO-Agent (nicht Web-Design Specialist) |
| Ausführung | Python-launchd-Dienst macht Crawl + WP-Writes (Muster: Bild-Dienst) |
| SEO-Plugin | Yoast SEO (REST-API für Meta-Felder) |
| Modell | `qwen3.6-35b` primär / `gemma-4-31b` Fallback (Fleet-Standard) |

## 3. Architektur

```
Routine (wöchentlich, pro Site)
        │
        ▼
seo-geo-dienst  audit <site>   ──►  Report-Inbox (report.json + report.md)
                                            │
                                            ▼
                        SEO/GEO-Agent  (liest Report, priorisiert,
                        formuliert deutsche Meta-Texte, erzeugt llms.txt)
                                            │
                                            ▼
                        changeset.json  +  Vorschlag (lesbar, Vorher/Nachher)
                                            │
                                    [ Walter gibt frei ]
                                            │
                                            ▼
seo-geo-dienst  apply <changeset>  ──►  WordPress REST-API (Yoast + Media)
                                            │
                                            ▼
                        Verify + Vorher/Nachher-Log (Rollback-fähig)
```

### 3.1 Baustein A — SEO/GEO-Agent (Paperclip, WHITESTAG)

- Neue Agenten-Rolle, angesiedelt unter CTO oder CMO (Governance-Frage, s.
  offene Punkte).
- Modell `qwen3.6-35b`, Fallback `gemma-4-31b`.
- **AGENTS.md** (vom `agents-instructions/`-Generator erzeugt) definiert:
  Persona „technischer SEO/GEO-Spezialist", die Feld-Whitelist, das Verbot,
  redaktionellen Inhalt zu ändern, und einen **Pointer auf die verifizierte
  GEO-Wissensbasis** `SEO-GEO/Arbeitsanleitung llms.txt fuer Agenten.md`
  (lokale Modelle erreichen Wissen nur via AGENTS.md + `fs_read`).
- Aufgaben des Agenten (Denken, nicht Mechanik):
  1. Report aus der Inbox lesen (`fs_read`).
  2. Findings nach Impact priorisieren (fehlende/duplizierte Titles &
     Descriptions zuerst, dann OG/Alt/Schema, dann GEO/`llms.txt`).
  3. Konkrete Neu-Werte formulieren (deutsche Meta-Texte, faktenbasiert,
     Längen-Budgets: Title ~55–60, Description ~150–160 Zeichen).
  4. `llms.txt` regelkonform nach der Arbeitsanleitung erzeugen/aktualisieren.
  5. `changeset.json` + lesbaren Vorschlag als Deliverable ausgeben.

### 3.2 Baustein B — `seo-geo-dienst` (Python-launchd)

Ablage: `~/.paperclip/scripts/seo-geo/` (launchd darf SynologyDrive/CloudStorage
nicht lesen → „Operation not permitted"; gleiche Konvention wie
n8n-Workflow-Wächter und Bild-Dienst).

Zwei Kommandos:

**`audit <site>`**
- Liest `sitemap.xml`, crawlt bis Crawl-Limit (Config), respektiert robots.txt.
- Sammelt je URL: `<title>`, Meta-Description, OG/Twitter-Tags, `<h1>`-Anzahl,
  `<img>`-Alt-Abdeckung, Canonical, JSON-LD-Blöcke, HTTP-Status, Indexierbarkeit.
- Site-Ebene: robots.txt, sitemap.xml, `llms.txt` vorhanden/gültig, aktives
  SEO-Plugin (Yoast erkannt?).
- Ausgabe: `report.json` (maschinenlesbar) + `report.md` (für Agent & Mensch)
  in die Report-Inbox.

**`apply <changeset>`**
- Nimmt freigegebenes `changeset.json`, schreibt **nur Whitelist-Felder**:
  - Yoast-Meta (Title/Description/OG/Canonical/Focus-Keyword) via Yoast-REST bzw.
    registrierte Post-Meta.
  - Bild-Alt-Texte via `/wp/v2/media/<id>`.
  - `llms.txt` / robots-/sitemap-Hinweise als Datei-Deliverable (Upload-Weg
    pro Site zu klären — via Plugin oder SFTP; s. offene Punkte).
- Auth: **WordPress Application Passwords** pro Site (kein Klartext-Login).
- Für jede Änderung Vorher-Wert sichern → `apply-log.json` (Rollback-Basis).
- `--dry-run` Pflicht-Vorstufe (zeigt Diff ohne zu schreiben).

### 3.3 Baustein C — Config `sites.json`

```json
{
  "sites": [
    {
      "name": "whitestag.ai",
      "url": "https://whitestag.ai",
      "wp_rest_base": "https://whitestag.ai/wp-json",
      "credential_ref": "WHITESTAG_AI_WP_APP_PW",   // löst in ~/.whitestag.env auf
      "crawl_limit": 200,
      "seo_plugin": "yoast"
    }
  ]
}
```

Credentials liegen in `~/.whitestag.env`, nie im Repo, nie auf der Site.

## 4. Freigabe- & Umsetzungs-Loop

1. Dienst legt Report ab → Agent wird per Routine/Trigger aktiv.
2. Agent erzeugt `changeset.json` + lesbaren Vorschlag (Vorher/Nachher-Tabelle).
   Zustellung an Walter als Paperclip-Deliverable/Issue (Kanal s. offene Punkte).
3. Walter prüft, gibt frei (bzw. streicht einzelne Änderungen).
4. Freigabe stößt `seo-geo-dienst apply` mit dem freigegebenen Changeset an.
5. Dienst schreibt, verifiziert per Re-Fetch, protokolliert Vorher/Nachher.
6. Bei Fehler/Regret: Rollback aus `apply-log.json`.

## 5. Routine

Wöchentliches Audit je Site als **Paperclip-Routine** (cron, Europe/Berlin),
die den Dienst `audit` laufen lässt und den Agenten zur Vorschlags-Erstellung
triggert. Frequenz und genaue Uhrzeit in der Umsetzung festzulegen.

## 6. Sicherheits-Leitplanken (zusammengefasst)

- Feld-Whitelist hart im Dienst kodiert; alles außerhalb wird verweigert.
- Kein Live-Write ohne Walters Freigabe; `--dry-run` als Standard-Vorstufe.
- Vorher/Nachher-Log für jeden Write → Rollback.
- Application Passwords statt Login; Secrets nur in `~/.whitestag.env`.
- Redaktioneller Inhalt, Slugs und Seiten-Struktur sind unantastbar.

## 7. Offene Punkte (in der Umsetzung/Planung zu klären)

1. **Site-Liste**: Welche konkreten WordPress-Domains kommen in `sites.json`?
2. **Governance/Vorgesetzter**: Unter welcher C-Suite-Rolle hängt der Agent
   (CTO vs. CMO)? Braucht der Neuzugang Board-Approval
   (`requireBoardApprovalForNewAgents` → `/agent-hires` + `/approve`)?
3. **Freigabe-Kanal**: Vorschlag als Paperclip-Issue, als `.docx`-Deliverable
   oder als Datei in einem „pending"-Ordner mit einfachem `approve`-Schritt?
4. **`llms.txt`/robots-Upload**: Schreibweg auf die Site — via WP-Plugin,
   REST-Datei-Endpoint oder SFTP? Pro Site zu prüfen.
5. **Yoast-REST-Details**: Ob die Yoast-Meta-Felder direkt via REST schreibbar
   sind oder ein kleiner Meta-Registrierungs-Snippet im Theme nötig ist.

## 8. Wiederverwendete Muster & Wissensquellen

- **Bild-Dienst** (`project_bild_service.md`): „Agent bestellt, Python-launchd
  liefert" — direkte Vorlage für Struktur, flock-Locking, launchd-Ablage.
- **n8n-Workflow-Wächter**: launchd-CloudStorage-Restriktion → Scripts nach
  `~/.paperclip/scripts/`.
- **LM-Studio Wissenskanäle**: Nur AGENTS.md + `fs_read` erreichen das lokale
  Modell → GEO-Wissen als Pointer, nicht als SKILL.md.
- **Arbeitsanleitung llms.txt**: verifizierte GEO-Regelbasis für den Agenten.
