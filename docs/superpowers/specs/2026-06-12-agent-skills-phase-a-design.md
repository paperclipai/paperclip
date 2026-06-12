# Agent-Skills-Verbesserung — Phase A: Audit & Zuweisung

**Datum:** 2026-06-12
**Status:** Design (genehmigt, bereit für Planung)
**Company:** WHITESTAG (`9cebf3cf-efe8-4597-a400-f06488900a87`)

## Kontext & Ziel

Die WHITESTAG Company hat 25 Agenten. Eine Bestandsaufnahme der Skill-Zuweisungen
(`adapterConfig.paperclipSkillSync.desiredSkills`) zeigt zwei systematische Probleme:

1. **Lücken:** Genau die Fach-Spezialisten haben oft 0 Skills, obwohl passende Skills
   in der Company installiert sind (z. B. Online-Rechercheur ohne `online-recherche`,
   Social Media / Marken-Spezialist / Web-Design / Buchhaltung / Drehbuch / Bild & Video /
   Creative Director / CRO komplett leer).
2. **Streuung:** Mehrere installierte Skills sind keinem Agenten zugewiesen
   (`newsletter-redaktion`, `newsletter-scoring`), und einige Spezialisten tragen
   Infra-Skills (`paperclip-create-agent/-plugin`, `online-recherche`), die sie selten
   brauchen und die beim kleinen lokalen Modell unnötig Kontext kosten.

Zusätzlich gibt es eine **Phantom-Referenz:** `comfyui-flux` wird von Adobe referenziert,
existiert aber weder auf Platte noch in der Company.

Dieses Vorhaben ist Teil eines 3-Phasen-Programms:

- **Phase A (dieser Spec):** Audit & Zuweisung — Rollen→Skill-Matrix definieren und
  per Sync-API anwenden. Reine Config, reversibel.
- **Phase B (separat):** Skill-*Inhalte* verbessern (Trigger, Länge, Klarheit — kritisch
  für kleine Modelle).
- **Phase C (separat):** Neue Skills bauen für echte Fähigkeitslücken
  (`comfyui-flux`, ein `link-detektor`-Skill).

**Phase-A-Ziel:** Jeder Agent trägt genau den Skill-Satz, der seiner Rolle entspricht —
nach einem zweistufigen Modell (C-Suite breit, Spezialisten schlank & tief).

## Designprinzip: Zweistufig

**Tier 1 — Breit (C-Suite & Manager):** CEO, CTO, CFO, CMO, CPO, CRO, VP Engineering,
Creative Director. Treffen Entscheidungen über viele Domänen → breiterer Baseline-Satz.

**Tier 2 — Schlank & tief (Spezialisten):** Adobe, Bild & Video, Blender, Buchhaltung,
Drehbuch, Marken-Spezialist, Mistika VR, Online-Rechercheur, Produktentwicklung,
Social Media, Web-Design, Vermögensverwaltung, Vault-Maintainer, Sekretärin,
Link-Detektor. Nur Fachgebiet + minimale Basis.

**Ausgenommen:** HomePod-Test-Agent bleibt skill-frei (Testagent).

## Baseline-Sätze

**Tier-1-Baseline (jeder C-Level):**
`paperclip` · `para-memory-files` · `paperclip-create-agent` · `paperclip-create-plugin` ·
`online-recherche` · `whitestag-brand` · `whitestag-dsgvo`

**Tier-2-Baseline (jeder Spezialist):**
`paperclip` · `para-memory-files` · `whitestag-dsgvo`
(+ `whitestag-brand` nur bei output-/kundenseitigen Rollen, unten mit ⭐ markiert)

Spezialisten erhalten bewusst **nicht** `create-agent`/`create-plugin`/`online-recherche`.

## Ziel-Matrix

### Tier 1 (Baseline impliziert + folgende Spezial-Skills)

| Agent | Spezial-Skills zusätzlich zur Tier-1-Baseline | Hinweis |
|---|---|---|
| CEO | `whitestag-angebot`, `vermoegen-overview`, `vr-produktion-pipeline` | `buchhaltung-*`, `drehbuch-vr` entfernen (delegiert) |
| CTO | `whitestag-n8n-workflow`, `paperclip-dev`, `diagnose-why-work-stopped` | |
| CFO | `vermoegen-overview`, `vermoegen-aktien`, `vermoegen-etf`, `vermoegen-gold`, `buchhaltung-euer`, `buchhaltung-einkommensteuer`, `whitestag-angebot` | |
| CMO | `copywriting`, `marketing-ideas`, `marketing-psychology`, `social-content`, `newsletter-redaktion`, `newsletter-scoring` | Newsletter-Owner |
| CPO | `whitestag-n8n-workflow`, `web-design-guidelines` | |
| CRO | — (nur Tier-1-Baseline) | war 0 Skills |
| VP Engineering | `whitestag-n8n-workflow`, `paperclip-dev`, `diagnose-why-work-stopped` | |
| Creative Director | `vr-produktion-pipeline`, `drehbuch-vr`, `adobe-automation`, `mistika-vr-pipeline` | war 0 Skills |

### Tier 2 (Lean-Baseline impliziert; ⭐ = zusätzlich `whitestag-brand`)

| Agent | Spezial-Skills zusätzlich zur Tier-2-Baseline | Hinweis |
|---|---|---|
| Adobe ⭐ | `adobe-automation`, `vr-produktion-pipeline` | `comfyui-flux` (Phantom) + Infra-Skills entfernen |
| Bild & Video ⭐ | `adobe-automation`, `vr-produktion-pipeline` | war 0; `comfyui-flux` folgt in Phase C |
| Blender | `blender-scripting`, `vr-produktion-pipeline` | Infra-Skills entfernen |
| Buchhaltung | `buchhaltung-euer`, `buchhaltung-einkommensteuer` | war 0 Skills |
| Drehbuch ⭐ | `drehbuch-vr`, `vr-produktion-pipeline` | war 0 Skills |
| Marken-Spezialist ⭐ | `copywriting`, `marketing-psychology` | war 0 Skills (`whitestag-brand` tief via ⭐) |
| Mistika VR | `mistika-vr-pipeline`, `vr-produktion-pipeline` | Infra-Skills entfernen |
| Online-Rechercheur | `online-recherche` | war 0 Skills |
| Produktentwicklung | `whitestag-n8n-workflow`, `vr-produktion-pipeline` | Infra-Skills entfernen |
| Social Media ⭐ | `social-content`, `copywriting`, `marketing-psychology` | war 0 Skills |
| Web-Design ⭐ | `web-design-guidelines` | war 0 Skills |
| Vermögensverwaltung | `vermoegen-overview`, `vermoegen-aktien`, `vermoegen-etf`, `vermoegen-gold` | Infra-Skills entfernen |
| Vault-Maintainer | — (nur Lean-Baseline) | `whitestag-dsgvo` ergänzen |
| Sekretärin ⭐ | `pdf`, `whitestag-angebot` | |
| Link-Detektor | — (nur `paperclip`, `para-memory-files`) | Domain-Skill folgt in Phase C |

## Umsetzung

Rein Config-basiert, kein Agent-Neustart. Skills greifen beim nächsten Heartbeat.

**Ref-Auflösung:** Skill-Slugs werden zu kanonischen namespaced Refs aufgelöst
(`paperclipai/paperclip/<slug>`, `local/<pack-hash>/<slug>`, offizielle Runtime-Refs).
Vorhandene Refs werden aus den aktuellen `desiredSkills` der Agenten wiederverwendet;
verwaiste Skills (`newsletter-*`, `copywriting`, `marketing-*`, `social-content`,
`web-design-guidelines`, `pdf`) werden über die Company-Skills-API aufgelöst.

**Ablauf:**

1. **Backup:** Aktuelle `desiredSkills` aller 25 Agenten in eine JSON-Datei sichern
   (Rollback-Anker, Zeitstempel im Dateinamen).
2. **Diff-Preview:** Pro Agent die geplante Änderung (Δ hinzufügen / Δ entfernen)
   ausgeben — vor jedem Schreibvorgang, zur Sichtkontrolle.
3. **Anwenden:** `POST /api/agents/{id}/skills/sync` je Agent, Tier 1 zuerst, dann Tier 2.
4. **Verifizieren:** Jeden Agenten neu lesen, Zielsatz bestätigen, prüfen dass keine
   Phantom-Refs übrig sind und kein Sync-Fehler auftrat.

**Reversibel:** Backup erlaubt vollständigen Rückbau.

## Nicht-Ziele (Phase A)

- Keine Änderung von Skill-*Inhalten* (Phase B).
- Kein Bau neuer Skills (Phase C: `comfyui-flux`, `link-detektor`-Skill).
- Kein Agent-Neustart, keine AGENTS.md-Änderung.

## Erfolgskriterien

- Kein Agent (außer HomePod-Test-Agent) hat 0 Skills.
- Jeder Agent trägt exakt seinen Matrix-Zielsatz.
- Keine Phantom-Referenz (`comfyui-flux`) mehr in irgendeiner `desiredSkills`.
- `newsletter-redaktion` + `newsletter-scoring` haben einen Owner (CMO).
- Backup-Datei vorhanden, Rückbau dokumentiert.

## Offene Phase-C-Backlog-Punkte (nicht Teil von Phase A)

- `comfyui-flux` neu bauen (Bildgenerierung für Bild & Video / Adobe).
- Eigener `link-detektor`-Skill für den Link-Detektor-Agenten.
- `online-recherche` neu schreiben — bei der Umsetzung in keiner Quelle auffindbar
  (keine Plattenkopie, nicht in paperclipai-Registry). Betroffen: CRO, C-Suite,
  Online-Rechercheur (hat vorerst nur Baseline).

## Durchführungsergebnis (2026-06-12)

Phase A wurde live angewandt (`scripts/skill-matrix/sync.py`, Branch
`feat/agent-skill-matrix-phase-a`). Zwei Erkenntnisse während der Umsetzung:

1. **Phase A0 nötig (Vorbedingung war nicht erfüllt):** Die 16 WHITESTAG-Domain-Skills
   waren nicht als company-managed installiert — sie zeigten als `external/readOnly`
   auf den toten `Desktop/Claude Code/`-Pfad (Canonical-Path-Fäule). Der validierende
   Sync-Endpoint lehnte sie mit HTTP 422 ab. Lösung: 15 Skills aus den Runtime-Katalog-
   Kopien als company-managed re-importiert (gleiche `local/<hash>/…`-Keys → tote Refs
   wiederbelebt); `online-recherche` blieb unauffindbar → Phase C. Company-Skills
   18 → 33.
2. **Paperclip-Pflichtbündel:** Die Plattform erzwingt bei jedem lokalen Adapter ein
   10er-Pflichtbündel (`paperclip`, `para-memory-files`, `*-create-agent/-plugin`,
   `paperclip-dev`, `*-converting-plans-to-tasks`, `diagnose-why-work-stopped`,
   `terminal-bench-loop`, `newsletter-redaktion/-scoring`). Diese sind nicht entfernbar.
   Die schlank/breit-Tier-Logik wirkt daher faktisch nur auf die Domain-Skills; das
   Verify prüft Ziel ⊆ Ist mit Pflichtbündel als erlaubte Extras.

Endergebnis: 24 Agenten gesynct, `--verify` = VERIFY OK. Domain-Skill-Zuweisung
entspricht exakt der Ziel-Matrix (außer `online-recherche`, deferred).
