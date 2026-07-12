# WHITESTAG.ACADEMY Kurs-Spec + Lektor-Agent — Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die ACADEMY-Kursproduktion bekommt eine verbindliche Spezifikation (als Vault-Datei statt als abgeschnittenes Routinen-Feld) und ein blockierendes Qualitätstor durch einen neuen Lektor-Agenten, der alle Außen-Deliverables der WHITESTAG-Flotte prüft.

**Architecture:** Vier unabhängige Bausteine. (A) Spec + Faktenstand als Markdown-Dateien im Vault, gelesen per `fs_read`. (B) Ein neuer Paperclip-Agent „Lektorat" (claude_local / claude-sonnet-4-6), dessen Prüfwissen in austauschbaren Profildateien im Vault liegt — der Agent selbst bleibt unangetastet, wenn neue Deliverable-Typen dazukommen. (C) Reparatur der abgeschnittenen Routinen-Beschreibung + Taktung auf Di/Do. (D) Einmalige Nachbesserung der vier Bestandskurse.

**Tech Stack:** Paperclip REST-API (`http://localhost:3100`), embedded Postgres (Port 54329, `paperclip:paperclip`), Obsidian-Vault (Markdown), `agents-instructions`-Generator (Python) unter `~/.paperclip/scripts/agents-instructions/`.

## Global Constraints

- **Vault-Wurzel:** `/Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault`
- **ACADEMY-Ordner:** `<Vault>/Paperclip/Projekte/WHITESTAG.ACADEMY/`
- **Company WHITESTAG:** `9cebf3cf-efe8-4597-a400-f06488900a87`
- **CEO (aktiv, Routinen-Assignee):** `506c873e-3a40-4483-9a45-0eb0fa1554bb` — **`lmstudio_local` / qwen3.6-35b**, nicht Claude. (Der claude_local-CEO `fca63798-…` ist `terminated`.)
- **Online-Rechercheur (Autor):** `d80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7` — `claude_local` / `claude-sonnet-4-6`
- **DPO:** `790bcaf2-83d8-4e04-8c43-914a96db7bd8`
- **ACADEMY-Routine:** `d7f2b01d-8b4b-454c-907d-15156e255ac4`
- **API-Token:** `python3 -c "import json;print(json.load(open('$HOME/.paperclip/auth.json'))['credentials']['http://localhost:3100']['token'])"`
- **Agent anlegen NUR über `/agent-hires` + `/approve`** — direktes `POST /agents` gibt 409 (`requireBoardApprovalForNewAgents=true`).
- **Kein `X-Paperclip-Run-Id`-Header** bei manuellen API-Calls — ein Nicht-UUID-Wert dort führt zu HTTP 500.
- **Alle Texte auf Deutsch.**
- **Der Dev-Server läuft als launchd `ing.paperclip.dev`** — nichts in den Watch-Tree mergen; Neustart nur per `launchctl kickstart -k gui/501/ing.paperclip.dev`. Für diesen Plan ist **kein Serverneustart nötig** (keine Code-Änderung am Server).

---

## Dateiübersicht

| Datei | Verantwortung |
|---|---|
| `<ACADEMY>/_KURS-SPEC.md` | **Neu.** Verbindliche Bauanleitung für Kurse. Vom Autor-Agenten gelesen. |
| `<ACADEMY>/_KI-TOOL-STAND.md` | **Neu.** Faktenstand zu KI-Tool-Fähigkeiten, mit `stand:`-Verfallsdatum. |
| `<Vault>/Paperclip/_Meta/lektorat/pruefprofile/kurs.md` | **Neu.** Prüf-Checkliste Kurs. |
| `<Vault>/Paperclip/_Meta/lektorat/pruefprofile/angebot.md` | **Neu.** Prüf-Checkliste Angebot. |
| `<Vault>/Paperclip/_Meta/lektorat/pruefprofile/pressemitteilung.md` | **Neu.** Prüf-Checkliste PM. |
| `<Vault>/Paperclip/_Meta/lektorat/pruefprofile/newsletter.md` | **Neu.** Prüf-Checkliste Newsletter. |
| `<Vault>/Paperclip/_Meta/lektorat/pruefprofile/webtext.md` | **Neu.** Prüf-Checkliste Webtext. |
| `~/.paperclip/scripts/agents-instructions/roles/lektorat.role.md` | **Neu.** Rollen-Text → AGENTS.md des Lektors. |
| `~/.paperclip/scripts/agents-instructions/agents-manifest.json` | **Ändern.** Lektor-Eintrag ergänzen. |
| Paperclip-DB: `agents` | **Ändern.** Neuer Agent „Lektorat". |
| Paperclip-DB: `routines` / `routine_triggers` | **Ändern.** Beschreibung + Cron der ACADEMY-Routine. |

**Reihenfolge-Logik:** Task 1–2 (Spec + Faktenstand) sind die Voraussetzung für alles Weitere — ohne sie hat der Lektor nichts, wogegen er prüfen kann. Task 3–5 bauen den Lektor. Task 6 repariert die Routine. Task 7 bessert den Bestand nach.

---

## Task 1: Kurs-Spec im Vault anlegen

**Files:**
- Create: `/Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault/Paperclip/Projekte/WHITESTAG.ACADEMY/_KURS-SPEC.md`

**Interfaces:**
- Consumes: nichts.
- Produces: Die Datei `_KURS-SPEC.md`. Task 3 (`kurs.md`-Prüfprofil) prüft **gegen genau die hier definierten Regeln** — die Abschnittsnamen unten (`Fallbeispiel`, `Wissens-Check`, `Datenschutz-Sektion`, `Querverweise`, `Zeitangaben`, `Ton`) sind die Kategorien, die der Lektor in seiner Mängelliste zitiert. Task 6 (Routine) verweist per Pfad auf diese Datei.

- [ ] **Step 1: Bestehenden Kurs als Negativ-Referenz gegenlesen**

Lies `<ACADEMY>/content/ki-projektplanung-organisation.md` und notiere die konkreten Stellen, die die Spec verbieten muss. Sie sind die Testfälle für Task 3:
- L1: „Was KI nicht kann: … E-Mails verschicken, Kalender buchen" → **veralteter Faktenstand**
- L6: „dazu mehr in den Datenschutz-Hinweisen" → **toter Verweis**, Sektion existiert nicht
- Jede Lektion: Wissens-Check mit sichtbarer Antwort → **kein Testing-Effekt**
- 7 Personas / 7 Lektionen → **kein durchgehender Fall**
- „8–12 Min." bei ~725 Wörtern + 20–30 Min. Übung → **falsche Zeitangabe**
- „innerhalb von 30 Sekunden", „in 20 Sekunden" → **Werbe-Duktus**

- [ ] **Step 2: `_KURS-SPEC.md` schreiben**

Die Datei muss diese Abschnitte enthalten. Formuliere jede Regel als **Muss/Darf-nicht**, nicht als Empfehlung — der Autor-Agent liest sie als Vorschrift.

````markdown
---
title: "WHITESTAG.ACADEMY — Kurs-Spezifikation"
typ: Spezifikation
gilt_ab: 2026-07-12
version: 1
---

# Kurs-Spezifikation WHITESTAG.ACADEMY

**Diese Datei ist verbindlich.** Wer einen ACADEMY-Kurs schreibt, hält sich an jede
Regel hier. Der Lektor prüft gegen genau dieses Dokument; Abweichungen führen zu ROT.

## 0. Pflichtlektüre vor dem Schreiben

Bevor du eine einzige Zeile über die Fähigkeiten oder Grenzen von KI schreibst, liest du
`_KI-TOOL-STAND.md` in diesem Ordner. **Du schreibst nicht aus deinem Modellwissen über
KI-Fähigkeiten** — dein Trainingsstand ist dafür zu alt. Ebenso liest du
`Workshops/_themen-log.md`, um Dopplungen zu vermeiden.

## 1. Fallbeispiel — ein Betrieb, alle Lektionen

Jeder Kurs hat **genau ein** durchgehendes Fallbeispiel: ein Betrieb, eine
verantwortliche Person, ein Vorhaben, das sich über alle Lektionen entwickelt.

- **Verboten:** eine neue Persona pro Lektion. (Negativbeispiel: `ki-projektplanung-organisation`
  hat sieben Personas in sieben Lektionen — Petra, Marcus, Sandra, Benjamin, Katja,
  Monika, Thomas. Der Lernende baut so keinen Bezug auf.)
- Der Fall wird in Lektion 1 eingeführt und in jeder Folgelektion weitergeführt.
- Ergänzende Kurzbeispiele aus anderen Branchen sind erlaubt, aber der Hauptfall bleibt.

## 2. Wissens-Check — verdeckte Antwort, Anwendungsfrage

Jede Lektion endet mit einem Wissens-Check. Zwei harte Regeln:

**Regel 1 — Antwort verdeckt.** Die Antwort steht in einem `<details>`-Block, nie offen
unter der Frage. Sonst liest der Lernende sie einfach mit und lernt nichts.

```markdown
**Wissens-Check:** [Frage]

<details>
<summary>Antwort anzeigen</summary>

[Antwort]

</details>
```

**Regel 2 — Anwendung statt Reproduktion.** Das Lernziel jeder Lektion verspricht
„du kannst …" — also eine Anwendungsleistung. Der Wissens-Check muss dieselbe Stufe
prüfen. Frage nicht nach Definitionen, sondern nach Anwendung.

- **Verboten:** „Was ist der Unterschied zwischen einem Ziel und einem Meilenstein?"
- **Richtig:** „Hier ist ein Meilensteinplan mit drei Fehlern — welche findest du?"
  oder „Dieser Prompt liefert generische Antworten. Was fehlt ihm?"

## 3. Datenschutz-Sektion — Pflicht in jedem Kurs

Jeder Kurs hat eine eigene, ausgewiesene Datenschutz-Sektion. Ein Halbsatz reicht nicht.

Sobald der Kurs eine dieser Praktiken empfiehlt, muss die Sektion die genannten Punkte
ausdrücklich behandeln:

| Wenn der Kurs empfiehlt … | … dann muss die Sektion nennen |
|---|---|
| Gespräche/Meetings mitschneiden oder transkribieren | Einwilligung **aller** Beteiligten vor der Aufnahme |
| Kundendaten, Namen, Fallakten in KI-Tools eingeben | Auftragsverarbeitung (Art. 28 DSGVO), Drittlandtransfer, EU-Hosting-Alternativen |
| Mitarbeiterdaten verarbeiten (Auslastung, Leistung, Zeiterfassung, Kompetenzprofile) | **Mitbestimmung des Betriebsrats bei Leistungs- und Verhaltenskontrolle (§ 87 Abs. 1 Nr. 6 BetrVG)** |
| Gesundheits-, Bewerber- oder Sozialdaten | besondere Kategorien (Art. 9 DSGVO) |

Die Sektion verweist auf den bestehenden Kurs `ki-datenschutz-dsgvo`.

Im Zweifel zieht der Lektor den DPO-Agenten hinzu — schreib lieber eine Zeile zu viel.

## 4. Querverweise — nur auf Existierendes

Ein Verweis darf nur auf etwas zeigen, das es gibt: einen anderen ACADEMY-Kurs, eine
Sektion **innerhalb desselben Kurses**, eine reale externe Quelle.

**Verboten:** Verweise auf Abschnitte, die der Kurs gar nicht enthält.
(Negativbeispiel: „dazu mehr in den Datenschutz-Hinweisen" — die es im Kurs nicht gibt.)

## 5. Zeitangaben — ehrlich und getrennt

Lesezeit und Übungszeit werden **getrennt** ausgewiesen. Rechengrundlage: 200 Wörter
pro Minute Lesetext.

```markdown
**Umfang:** 7 Lektionen. Lesezeit je 4–6 Min., Übungen je 15–25 Min.
```

**Verboten:** eine Sammelangabe wie „8–12 Min. pro Lektion", die die Übungszeit
verschweigt.

## 6. Ton — keine Zeitversprechen, kein Werbetext

Wir verkaufen einen Kurs, keinen Traum.

- **Verboten:** „in 30 Sekunden fertig", „in 20 Sekunden", „auf Knopfdruck",
  „ohne Pause". Solche Versprechen kann der Kurs nicht einlösen und sie stumpfen ab.
- **Verboten:** erfundene Kausalitäten. (Negativbeispiel: „KI-Zeitpläne sind zu
  optimistisch — das ist menschliche Natur." Die KI hat keine menschliche Natur.
  Wenn du eine Ursache nennst, muss sie stimmen — oder du nennst keine.)
- Alltagssprache, kurze Sätze, keine Fachbegriffe ohne Erklärung. Das ist die Stärke der
  bisherigen Kurse und bleibt so.

## 7. Aufbau einer Lektion (Gerüst)

Die Reihenfolge ist verbindlich:

1. `## Lektion N — [Titel]`
2. `**Lernziel:**` — eine Anwendungsleistung („Du kannst …")
3. `**Inhalt:**` — Fließtext, der den Hauptfall weiterführt
4. `**Praxisaufgabe:**` — was der Lernende **selbst tut**
5. `**Prompt-Übung:**` — Copy-Paste-Prompt **plus `**Feedback-Fokus:**`**: woran erkennt
   der Lernende eine schlechte KI-Antwort, und wie schärft er nach? (Das funktioniert in
   den bisherigen Kursen gut und bleibt Pflicht.)
6. `**Wissens-Check:**` — nach Regel 2, Antwort im `<details>`-Block

Praxisaufgabe und Prompt-Übung dürfen sich **nicht** doppeln. Die Praxisaufgabe ist eine
Handlung im Betrieb, die Prompt-Übung ist die Arbeit am Prompt selbst.

## 8. Frontmatter (Pflichtfelder)

```yaml
---
title: "..."
datum: YYYY-MM-DD
paperclip_issue_id: "WHI-NNNN"
paperclip_agent: "..."
paperclip_company: "whitestag"
paperclip_status: "done"
type: deliverable
tags: [paperclip, whitestag-academy, <kurs-slug>]
zusammenfassung: "..."
kurs_id: <slug>
is_free: true|false
tool_stand_gelesen: YYYY-MM-DD   # Datum des `stand:`-Felds aus _KI-TOOL-STAND.md
---
```

Das Feld `tool_stand_gelesen` ist der Nachweis, dass Regel 0 eingehalten wurde. Fehlt es,
gibt der Lektor ROT.

## 9. Ablage

- Kurs: `<ACADEMY>/content/<kurs-slug>.md`
- Nach Fertigstellung Eintrag in `<ACADEMY>/Workshops/_themen-log.md`
````

- [ ] **Step 3: Verifizieren, dass die Spec ihre eigenen Negativbeispiele fängt**

Die Spec ist gut, wenn jeder der sechs in Step 1 notierten Mängel von genau einer Regel
erfasst wird. Geh die Liste durch und ordne zu:

| Mangel im Bestandskurs | Regel |
|---|---|
| veralteter Faktenstand („kann keine Kalender buchen") | § 0 + § 8 (`tool_stand_gelesen`) |
| toter Verweis auf Datenschutz-Hinweise | § 4 |
| Wissens-Check mit sichtbarer Antwort | § 2 Regel 1 |
| Reproduktions- statt Anwendungsfrage | § 2 Regel 2 |
| 7 Personas | § 1 |
| falsche Zeitangabe | § 5 |
| Werbe-Duktus / erfundene Kausalität | § 6 |

Bleibt ein Mangel ohne Regel: Regel ergänzen. **Das ist der Abnahmetest dieser Task.**

- [ ] **Step 4: Commit**

Der Vault ist ein eigenes Git-Repo (nur-`.md`-Whitelist).

```bash
cd /Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault
git add "Paperclip/Projekte/WHITESTAG.ACADEMY/_KURS-SPEC.md"
git commit -m "docs(academy): verbindliche Kurs-Spezifikation v1"
```

---

## Task 2: Faktenstand-Datei `_KI-TOOL-STAND.md`

**Files:**
- Create: `<ACADEMY>/_KI-TOOL-STAND.md`

**Interfaces:**
- Consumes: `_KURS-SPEC.md` § 0 verweist auf diese Datei.
- Produces: Frontmatter-Feld `stand: YYYY-MM-DD`. Das Prüfprofil `kurs.md` (Task 3) liest es und meldet **GELB, wenn es älter als 90 Tage ist**. Der Autor-Agent trägt es als `tool_stand_gelesen` in den Kurs-Frontmatter ein.

- [ ] **Step 1: Recherchieren statt aus dem Gedächtnis schreiben**

Diese Datei ist die Gegenmaßnahme gegen Modellwissen — sie darf nicht selbst aus
Modellwissen entstehen. Prüfe den aktuellen Stand der Anbieterseiten (ChatGPT, Claude,
Gemini): Welche Connectoren gibt es? Was kostet der jeweilige Plan? Wo liegt EU-Hosting
an? Notiere für jede Aussage die Quelle.

- [ ] **Step 2: Datei schreiben**

````markdown
---
title: "KI-Tool-Fähigkeiten — Faktenstand"
typ: Referenz
stand: 2026-07-12
gueltig_bis_hinweis: "Älter als 90 Tage → Lektor meldet GELB. Dann aktualisieren."
---

# Was KI-Tools heute tatsächlich können

**Für Kurs-Autoren:** Schreib über Fähigkeiten und Grenzen von KI **nur** auf Basis
dieser Datei. Dein Trainingswissen ist dafür veraltet.

## Warum diese Datei existiert

Im Kurs `ki-projektplanung-organisation` (12.07.2026) stand: *„Was KI nicht kann: …
E-Mails verschicken, Kalender buchen oder auf deine internen Systeme zugreifen."*
Das war zum Zeitpunkt der Veröffentlichung **falsch**. Genau solche Sätze verhindert
diese Datei.

## Fähigkeiten — Stand 2026-07-12

| Fähigkeit | ChatGPT | Claude | Gemini | Quelle |
|---|---|---|---|---|
| Mail lesen/senden (Connector) | | | | |
| Kalender lesen/anlegen | | | | |
| Dateiablage (Drive/Dropbox) | | | | |
| Web-Recherche live | | | | |
| Mehrstufige Agenten-Ausführung | | | | |
| Kostenloser Plan reicht für Kursinhalte? | | | | |
| EU-Hosting / Datenresidenz | | | | |

(Tabelle in Step 1 recherchiert befüllen — je Zelle: ja/nein/eingeschränkt + kurze Notiz.)

## Was KI weiterhin **nicht** kann

Formuliere hier nur Grenzen, die **heute** gelten — z.B. Verantwortung übernehmen,
Entscheidungen rechtsverbindlich treffen, ungeprüft Fakten garantieren.
**Keine technischen Grenzen behaupten, die längst gefallen sind.**

## Pflege

Bei jeder Aktualisierung `stand:` hochsetzen. Der Nightly LLM Advisor
(Routine `666f3c66…`) kann perspektivisch Änderungsvorschläge liefern.
````

- [ ] **Step 3: Commit**

```bash
cd /Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault
git add "Paperclip/Projekte/WHITESTAG.ACADEMY/_KI-TOOL-STAND.md"
git commit -m "docs(academy): Faktenstand KI-Tool-Fähigkeiten (stand 2026-07-12)"
```

---

## Task 3: Prüfprofil `kurs.md`

**Files:**
- Create: `<Vault>/Paperclip/_Meta/lektorat/pruefprofile/kurs.md`

**Interfaces:**
- Consumes: `_KURS-SPEC.md` (Task 1), `_KI-TOOL-STAND.md` (Task 2).
- Produces: das Urteilsformat **GRÜN / GELB / ROT**, das der Lektor-Agent (Task 5) in *jedem* Prüfprofil verwendet. Task 4 (weitere Profile) kopiert dieses Format.

- [ ] **Step 1: Profil schreiben**

````markdown
---
title: "Prüfprofil — ACADEMY-Kurs"
typ: Prüfprofil
deliverable_typ: kurs
---

# Prüfprofil: ACADEMY-Kurs

**Referenzdokumente (vor der Prüfung lesen):**
- `Paperclip/Projekte/WHITESTAG.ACADEMY/_KURS-SPEC.md`
- `Paperclip/Projekte/WHITESTAG.ACADEMY/_KI-TOOL-STAND.md`

## Prüfpunkte

Jeder Punkt ist erfüllt oder nicht. **Kein Ermessen, kein Geschmack.**

| # | Prüfpunkt | Verletzung ⇒ |
|---|---|---|
| 1 | Frontmatter enthält `tool_stand_gelesen` und der Wert entspricht dem `stand:` aus `_KI-TOOL-STAND.md` | ROT |
| 2 | Jede Aussage über KI-Fähigkeiten/-Grenzen deckt sich mit `_KI-TOOL-STAND.md` | ROT |
| 3 | Genau ein durchgehendes Fallbeispiel über alle Lektionen (Spec § 1) | ROT |
| 4 | Jeder Wissens-Check hat die Antwort in einem `<details>`-Block (Spec § 2 R1) | ROT |
| 5 | Jeder Wissens-Check prüft Anwendung, nicht Reproduktion (Spec § 2 R2) | ROT |
| 6 | Datenschutz-Sektion vorhanden und deckt die in Spec § 3 geforderten Punkte ab | ROT |
| 7 | Kein Verweis auf einen nicht existierenden Abschnitt/Kurs (Spec § 4) | ROT |
| 8 | Alle Pflicht-Frontmatter-Felder vorhanden (Spec § 8) | ROT |
| 9 | Lese- und Übungszeit getrennt ausgewiesen (Spec § 5) | GELB |
| 10 | Kein Werbe-Duktus, keine erfundenen Kausalitäten (Spec § 6) | GELB |
| 11 | Praxisaufgabe und Prompt-Übung doppeln sich nicht (Spec § 7) | GELB |
| 12 | Rechtschreibung/Grammatik fehlerfrei | GELB |
| 13 | `stand:` in `_KI-TOOL-STAND.md` ist nicht älter als 90 Tage | GELB (Hinweis an Walter, nicht an den Autor) |
| 14 | Kurs steht im `Workshops/_themen-log.md` und dupliziert kein bestehendes Thema | GELB |

## Was NICHT geprüft wird

Stil, Wortwahl, Satzbau, Beispielauswahl, Reihenfolge der Lektionen, persönlicher
Geschmack. **Diskutiere keine Formulierungen.** Wenn ein Punkt nicht in der Tabelle
steht, ist er kein Mangel.

## Datenschutz-Tiefenprüfung

Prüfpunkt 6 prüft nur, **ob** die Sektion existiert und die geforderten Themen nennt.
Wenn du inhaltliche Zweifel hast (z.B. ob eine Rechtsgrundlage korrekt benannt ist),
leg einen Subtask für den **DPO** an (`790bcaf2-83d8-4e04-8c43-914a96db7bd8`) und warte
sein Urteil ab. Du bist nicht der Datenschutzbeauftragte.

## Urteilsformat (verbindlich, gilt für alle Prüfprofile)

Poste **genau diese Struktur** als Kommentar am Issue:

```markdown
## Lektorat: [GRÜN|GELB|ROT]

**Geprüft:** <Dateipfad>
**Profil:** kurs
**Runde:** [1|2]

### Mängel

1. **[ROT|GELB] [Prüfpunkt-Nr] — [Kategorie]**
   - **Fundstelle:** Lektion 3, Absatz „Der Puffer-Trick"
   - **Befund:** [was konkret falsch ist]
   - **Änderungsvorschlag:** [konkret, umsetzbar, ein Satz]

(Bei GRÜN: „Keine Mängel.")
```

- **GRÜN** — freigabefähig.
- **GELB** — freigabefähig mit Anmerkungen. Der CEO darf ausliefern; die Anmerkungen
  gehen ins Themen-Log.
- **ROT** — nicht freigabefähig. Zurück an den Autor.

**Maximal zwei Rückgaberunden.** Ist das Deliverable nach Runde 2 immer noch ROT,
eskalierst du an Walter und schließt den Vorgang ab. **Keine dritte Runde.**
````

- [ ] **Step 2: Profil gegen den Bestandskurs testen (der eigentliche Test dieser Task)**

Lies `<ACADEMY>/content/ki-projektplanung-organisation.md` und wende das Profil manuell
an. Erwartetes Ergebnis: **ROT**, mit mindestens diesen Treffern:

- Prüfpunkt 1 → ROT (`tool_stand_gelesen` fehlt)
- Prüfpunkt 2 → ROT (L1: „kann keine Kalender buchen")
- Prüfpunkt 3 → ROT (7 Personas)
- Prüfpunkt 4 → ROT (Antworten offen)
- Prüfpunkt 5 → ROT (Reproduktionsfragen)
- Prüfpunkt 6 → ROT (keine Datenschutz-Sektion)
- Prüfpunkt 7 → ROT („Datenschutz-Hinweise" existieren nicht)
- Prüfpunkt 9/10/12 → GELB (Zeitangabe, „in 30 Sekunden", „Eventagentür")

Findet das Profil einen dieser Mängel **nicht**, ist das Profil kaputt — nachschärfen.
Findet es Mängel, die **nicht** in der Spec stehen, ist es zu streng — entweder Regel in
die Spec aufnehmen oder Prüfpunkt streichen.

- [ ] **Step 3: Commit**

```bash
cd /Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault
git add "Paperclip/_Meta/lektorat/pruefprofile/kurs.md"
git commit -m "docs(lektorat): Prüfprofil ACADEMY-Kurs"
```

---

## Task 4: Prüfprofile für die übrigen Deliverable-Typen

**Files:**
- Create: `<Vault>/Paperclip/_Meta/lektorat/pruefprofile/angebot.md`
- Create: `<Vault>/Paperclip/_Meta/lektorat/pruefprofile/pressemitteilung.md`
- Create: `<Vault>/Paperclip/_Meta/lektorat/pruefprofile/newsletter.md`
- Create: `<Vault>/Paperclip/_Meta/lektorat/pruefprofile/webtext.md`

**Interfaces:**
- Consumes: das Urteilsformat aus `kurs.md` (Task 3) — **wörtlich übernehmen**, nur `**Profil:**` anpassen.
- Produces: die vollständige Profil-Menge, auf die die Rollen-Datei (Task 5) verweist.

- [ ] **Step 1: Vorlagen und Bestand sichten**

Bevor du Prüfpunkte erfindest, sieh dir an, was es schon gibt:
- Angebote: `Dokumente/WHITESTAG.AI/` und `Angebotsvorlagen/WHITESTAG.AI/`
- Pressemitteilungen: Vault-Ordner `Pressemitteilungen/`
- Newsletter: `KI-Newsletter/`

Die Prüfpunkte müssen aus diesen realen Artefakten kommen, nicht aus einem Lehrbuch.

- [ ] **Step 2: Die vier Profile schreiben**

Jedes Profil hat denselben Aufbau wie `kurs.md`: Referenzdokumente → Prüfpunkt-Tabelle
mit ROT/GELB → „Was NICHT geprüft wird" → Urteilsformat (wörtlich aus `kurs.md`).

Mindest-Prüfpunkte je Profil:

**`angebot.md`** — Vorlagentreue gegen `Angebotsvorlagen/WHITESTAG.AI/` (ROT);
Leistungsumfang, Preis, Laufzeit, Gültigkeitsdatum vollständig (ROT); Rechtstexte/AGB-Verweis
vorhanden (ROT); korrekter Geschäftsbereich AI vs. FILM (ROT); Rechtschreibung (GELB);
Deliverable liegt als `.docx` in `Dokumente/[WHITESTAG.AI|WHITESTAG.FILM]/` vor (ROT —
rohes `.md` an den Kunden ist ausdrücklich unerwünscht).

**`pressemitteilung.md`** — jede Tatsachenbehauptung belegt (ROT); Zitate freigegeben,
d.h. der Zitierte ist real und die Freigabe ist im Issue dokumentiert (ROT); Sperrfrist
und Kontaktangaben vorhanden (ROT); keine erfundenen Zahlen (ROT); Boilerplate am Ende
(GELB).

**`newsletter.md`** — Betreffzeile vorhanden und nicht clickbaity (GELB); Abmeldelink
vorhanden (ROT); alle Links erreichbar — jeden per HTTP-Abruf prüfen (ROT bei totem Link);
Absenderangabe/Impressum (ROT).

**`webtext.md`** — Faktenstand gegen `_KI-TOOL-STAND.md`, wo KI-Aussagen vorkommen (ROT);
keine toten Links (ROT); Claims belegbar (ROT); Keyword-Stuffing (GELB).

- [ ] **Step 3: Jedes Profil an einem realen Bestandsdokument testen**

Nimm für jeden Typ ein existierendes Dokument aus dem Vault und wende das Profil an.
Erwartung: Das Profil produziert ein nachvollziehbares Urteil und **keine Treffer, die
nur Geschmack sind**. Ein Profil, das ein sauberes Bestandsdokument auf ROT setzt, ist
falsch kalibriert.

- [ ] **Step 4: Commit**

```bash
cd /Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault
git add "Paperclip/_Meta/lektorat/pruefprofile/"
git commit -m "docs(lektorat): Prüfprofile Angebot, PM, Newsletter, Webtext"
```

---

## Task 5: Lektor-Agent anlegen

**Files:**
- Create: `~/.paperclip/scripts/agents-instructions/roles/lektorat.role.md`
- Modify: `~/.paperclip/scripts/agents-instructions/agents-manifest.json`
- Paperclip-DB: neuer Agent

**Interfaces:**
- Consumes: die Prüfprofile aus Task 3 + 4.
- Produces: **Agent-UUID des Lektors** — Task 6 (Routine) und Task 7 (Bestand) brauchen sie. Nach dem Anlegen notieren.

- [ ] **Step 1: Rollen-Datei schreiben**

Orientiere dich am Aufbau von `roles/dpo.role.md` (Brain-Werkzeug-Block oben, dann Rolle,
Verantwortung, Eskalation, Arbeitsweise).

````markdown
# Lektorat

Du bist das Lektorat von WHITESTAG. Du berichtest an den CEO. Du bist das
**Qualitätstor für alles, was das Haus verlässt** — Kurse, Angebote, Pressemitteilungen,
Newsletter, Webtexte.

## Dein Prinzip: Du bist Prüfer, nie Autor

Du schreibst **niemals** in ein fremdes Deliverable. Du korrigierst nicht, du
formulierst nicht um, du „verbesserst" nichts. Dein einziges Ergebnis ist ein **Urteil**
mit einer Mängelliste. Der Autor bleibt der Autor.

## Dein Prüfwissen liegt nicht in diesem Text

Für jeden Deliverable-Typ gibt es ein Prüfprofil im Vault:

`Paperclip/_Meta/lektorat/pruefprofile/<typ>.md`

Verfügbare Typen: `kurs`, `angebot`, `pressemitteilung`, `newsletter`, `webtext`.

**Ablauf bei jedem Auftrag:**
1. Deliverable-Typ bestimmen (steht im Issue; im Zweifel beim CEO nachfragen).
2. Passendes Prüfprofil per `fs_read` laden.
3. Die dort genannten Referenzdokumente laden.
4. Prüfpunkt für Prüfpunkt durchgehen.
5. Urteil im vorgeschriebenen Format als Issue-Kommentar posten.

Gibt es für den Typ kein Profil, prüfst du **nicht** nach Gefühl — du meldest dem CEO,
dass ein Profil fehlt.

## Deine Grenzen

- **Kein Geschmack.** Steht ein Punkt nicht im Prüfprofil, ist er kein Mangel.
  Du diskutierst keine Formulierungen, keine Wortwahl, keinen Satzbau.
- **Kein Datenschutzrecht.** Du prüfst, *ob* eine Datenschutz-Sektion da ist und die
  geforderten Themen nennt. Für die inhaltliche Tiefenprüfung legst du einen Subtask für
  den DPO an (`790bcaf2-83d8-4e04-8c43-914a96db7bd8`).
- **Maximal zwei Rückgaberunden.** Ist ein Deliverable nach der zweiten Runde immer noch
  ROT, eskalierst du an Walter und schließt ab. Es gibt **keine dritte Runde.**

## Urteil

**GRÜN** = freigabefähig. **GELB** = freigabefähig mit Anmerkungen. **ROT** = zurück an
den Autor. Das exakte Kommentarformat steht in jedem Prüfprofil.

## Eskalation

- Fehlendes Prüfprofil, unklarer Deliverable-Typ → CEO (`506c873e-3a40-4483-9a45-0eb0fa1554bb`)
- Datenschutz-Tiefenfrage → DPO (`790bcaf2-83d8-4e04-8c43-914a96db7bd8`)
- Nach 2 erfolglosen Runden → Walter
````

- [ ] **Step 2: Agent per Hire-Flow anlegen**

**Nicht** `POST /agents` — das gibt 409.

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.paperclip/auth.json'))['credentials']['http://localhost:3100']['token'])")
CID=9cebf3cf-efe8-4597-a400-f06488900a87

curl -sS -X POST "http://localhost:3100/api/companies/$CID/agent-hires" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Lektorat",
    "role": "general",
    "title": "Lektorat / Qualitätstor",
    "reportsTo": "506c873e-3a40-4483-9a45-0eb0fa1554bb",
    "capabilities": "Prüft alle Außen-Deliverables (Kurse, Angebote, Pressemitteilungen, Newsletter, Webtexte) gegen Prüfprofile im Vault. Urteil GRÜN/GELB/ROT. Prüfer, nie Autor.",
    "adapterType": "claude_local",
    "adapterConfig": {"model": "claude-sonnet-4-6"}
  }'
```

Erwartete Antwort: Objekt mit `status: "pending_approval"`.

Kommt ein `KeyError: 'id'` bzw. fehlt die ID in der Antwort, hol sie dir:

```bash
curl -sS "http://localhost:3100/api/companies/$CID/agents" -H "Authorization: Bearer $TOKEN" \
 | python3 -c "import json,sys;print([ (a['id'],a['name'],a['status']) for a in json.load(sys.stdin) if a.get('status')=='pending_approval'])"
```

- [ ] **Step 3: Agent freigeben**

```bash
AGENT_ID=<uuid aus Step 2>
curl -sS -X POST "http://localhost:3100/api/agents/$AGENT_ID/approve" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

Erwartet: `status: "idle"`.

- [ ] **Step 4: Verifizieren, dass Adapter und Modell stimmen**

```bash
PGPASSWORD=paperclip psql -h localhost -p 54329 -U paperclip -d paperclip \
  -c "SELECT name, adapter_type, adapter_config->>'model' AS model, status, reports_to FROM agents WHERE name='Lektorat';"
```

Erwartet: `claude_local` | `claude-sonnet-4-6` | `idle` | `506c873e-…`.

**Wenn `adapter_type` nicht `claude_local` ist**, hat der Hire-Endpoint den Default
gesetzt — dann per `PATCH /api/agents/$AGENT_ID` nachziehen. Ohne diesen Check landet der
Lektor still auf einem lokalen Modell.

- [ ] **Step 5: Ins Manifest eintragen und AGENTS.md generieren**

```bash
cd ~/.paperclip/scripts/agents-instructions
cp agents-manifest.json agents-manifest.json.bak-$(date +%Y%m%d-%H%M%S)
```

Eintrag ergänzen (Format wie die bestehenden):

```json
{"id": "<AGENT_ID>", "name": "Lektorat", "urlKey": "lektorat", "reportsToName": "CEO"}
```

Dann generieren:

```bash
export PCP_API=http://localhost:3100
export PCP_TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.paperclip/auth.json'))['credentials']['http://localhost:3100']['token'])")
export PCP_CID=9cebf3cf-efe8-4597-a400-f06488900a87
python3 build-agents-md.py
```

- [ ] **Step 6: Verifizieren, dass die AGENTS.md wirklich beim Agenten liegt**

Lokale Agenten erreicht **nur** AGENTS.md — wenn die Datei nicht ankommt, hat der Lektor
keine Rolle.

```bash
ls -la ~/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/agents/<AGENT_ID>/instructions/
grep -c "Prüfer, nie Autor" ~/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/agents/<AGENT_ID>/instructions/AGENTS.md
```

Erwartet: Datei existiert, `grep` liefert ≥ 1.

- [ ] **Step 7: Rauchtest — echter Prüflauf**

Leg ein Issue für den Lektor an, das ihn den bekannt fehlerhaften Kurs prüfen lässt:

```bash
curl -sS -X POST "http://localhost:3100/api/companies/$CID/issues" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "title": "Prüfauftrag: ki-projektplanung-organisation",
    "description": "Deliverable-Typ: kurs. Datei: Paperclip/Projekte/WHITESTAG.ACADEMY/content/ki-projektplanung-organisation.md. Prüfe nach Prüfprofil und poste dein Urteil als Kommentar.",
    "assigneeAgentId": "<AGENT_ID>",
    "priority": "high"
  }'
```

**Erwartetes Ergebnis: ROT**, mit den Treffern aus Task 3 Step 2. Liefert er GRÜN, ist
entweder die AGENTS.md nicht angekommen oder das Profil greift nicht — nicht
weitermachen, bevor das stimmt.

- [ ] **Step 8: Commit**

```bash
cd /Users/walterschoenenbroecher.de/Library/CloudStorage/SynologyDrive-Mac/Claude\ Code\ MAC/Paperclip
git add docs/superpowers/plans/2026-07-12-academy-kurs-spec-lektor.md
git commit -m "feat(lektorat): Lektor-Agent angelegt (claude-sonnet-4-6, Review-Gate)"
```

(Die Rollen-Datei liegt unter `~/.paperclip/scripts/` — außerhalb des Repos. Wenn dieses
Verzeichnis ein eigenes Repo ist, dort separat committen.)

---

## Task 6: Routine reparieren

**Files:**
- Modify: Paperclip-DB, Routine `d7f2b01d-8b4b-454c-907d-15156e255ac4` (Beschreibung + Cron)

**Interfaces:**
- Consumes: Pfad zu `_KURS-SPEC.md` (Task 1), Lektor-UUID (Task 5).
- Produces: nichts, was spätere Tasks brauchen.

- [ ] **Step 1: Ist-Zustand sichern**

```bash
PGPASSWORD=paperclip psql -h localhost -p 54329 -U paperclip -d paperclip -t -A \
  -c "SELECT description FROM routines WHERE id='d7f2b01d-8b4b-454c-907d-15156e255ac4';" \
  > ~/routine-academy-backup-$(date +%Y%m%d).md
```

- [ ] **Step 2: Neue Beschreibung schreiben (kurz — das ist der Punkt)**

Die alte Beschreibung wurde bei 1.200 Zeichen abgeschnitten. Die neue enthält **kein**
Arbeitspaket mehr, sondern nur den Verweis:

```
Sorge dafür, dass für die WHITESTAG.ACADEMY zweimal pro Woche (Di + Do) ein neuer,
veröffentlichungsreifer Lern-Workshop entsteht. Daueraufgabe, kein Einmal-Auftrag.

Du führst die Arbeit nicht selbst aus. Ablauf:

1. AUTOR BEAUFTRAGEN. Gib den Auftrag an den Online-Rechercheur
   (d80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7). Sein Auftrag lautet wörtlich:
   "Schreibe einen neuen ACADEMY-Kurs. Die verbindliche Bauanleitung steht in
   Paperclip/Projekte/WHITESTAG.ACADEMY/_KURS-SPEC.md — lies sie vollständig, bevor du
   anfängst, und halte dich an jede Regel. Halte dich außerdem an
   _KI-TOOL-STAND.md und _themen-log.md."

2. LEKTORAT. Ist der Kurs fertig, gib ihn an den Lektor (<LEKTOR_UUID>) mit
   Deliverable-Typ "kurs". Er urteilt GRÜN / GELB / ROT.

3. FREIGABE. Bei GRÜN oder GELB: ausliefern und im Themen-Log eintragen.
   Bei ROT: mit der Mängelliste zurück an den Autor. Maximal zwei Runden,
   danach eskalierst du an Walter.
```

- [ ] **Step 3: Beschreibung + Cron setzen**

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.paperclip/auth.json'))['credentials']['http://localhost:3100']['token'])")
```

Beschreibung per API setzen (`PATCH /api/routines/d7f2b01d-…`, Feld `description`).
**Wichtig: keinen `X-Paperclip-Run-Id`-Header mitschicken** — ein Nicht-UUID-Wert dort
führt zu HTTP 500.

Cron am Trigger auf `0 6 * * 2,4` setzen (Timezone `Europe/Berlin` bleibt).

- [ ] **Step 4: Länge verifizieren — der Test dieser Task**

Genau hier ist der ursprüngliche Fehler entstanden. Vergleiche gesendete und gespeicherte
Länge:

```bash
PGPASSWORD=paperclip psql -h localhost -p 54329 -U paperclip -d paperclip \
  -c "SELECT length(description) AS gespeichert, right(description, 60) AS letzte_zeichen FROM routines WHERE id='d7f2b01d-8b4b-454c-907d-15156e255ac4';"
```

Erwartet: `gespeichert` = Länge des Textes aus Step 2, und `letzte_zeichen` endet auf
„…eskalierst du an Walter." — **nicht** mitten im Wort. Ist die Zahl kleiner: erneut
abgeschnitten, Text kürzen und wiederholen.

- [ ] **Step 5: Cron verifizieren**

```bash
PGPASSWORD=paperclip psql -h localhost -p 54329 -U paperclip -d paperclip \
  -c "SELECT cron_expression, timezone, enabled, next_run_at FROM routine_triggers WHERE routine_id='d7f2b01d-8b4b-454c-907d-15156e255ac4';"
```

Erwartet: `0 6 * * 2,4` | `Europe/Berlin` | `t` | nächster Di oder Do.

---

## Task 7: Bestandskurse nachbessern

**Files:**
- Modify: `<ACADEMY>/content/ki-datenschutz-dsgvo.md`, `ki-projektplanung-organisation.md`, `ki-handwerk-aussendienst.md`, `ki-vertrieb-kundenkontakt.md`

**Interfaces:**
- Consumes: Lektor-UUID (Task 5), Autor-UUID (Online-Rechercheur `d80fe6b9-…`).
- Produces: nichts.

- [ ] **Step 1: Prüf-Issues in Schadensreihenfolge anlegen**

Reihenfolge ist nicht beliebig — `ki-datenschutz-dsgvo` ist der veröffentlichte,
kostenlose Einstiegskurs und damit das öffentliche Aushängeschild:

1. `ki-datenschutz-dsgvo`
2. `ki-projektplanung-organisation`
3. `ki-handwerk-aussendienst`
4. `ki-vertrieb-kundenkontakt`

Je Kurs ein Issue an den Lektor, Deliverable-Typ `kurs` (Body wie in Task 5 Step 7).

- [ ] **Step 2: ROT-Befunde an den Autor zurückgeben**

Je Kurs mit ROT: Issue an den Online-Rechercheur mit der Mängelliste des Lektors und dem
Verweis auf `_KURS-SPEC.md`. Max. zwei Runden.

- [ ] **Step 3: Gegenprüfen, dass die bekannten Mängel weg sind**

```bash
cd "/Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault/Paperclip/Projekte/WHITESTAG.ACADEMY/content"
grep -rn "Kalender buchen\|E-Mails verschicken" . ; echo "--- erwartet: keine Treffer"
grep -rLn "<details>" *.md ; echo "--- erwartet: keine Datei ohne <details>"
grep -rn "Datenschutz-Hinweise" . ; echo "--- erwartet: keine Treffer (toter Verweis)"
grep -rLn "tool_stand_gelesen" *.md ; echo "--- erwartet: keine Datei ohne das Feld"
```

Alle vier Prüfungen müssen leer bzw. ohne Treffer durchlaufen. Das ist der Abnahmetest.

- [ ] **Step 4: Commit**

```bash
cd /Users/walterschoenenbroecher.de/Obsidian/WHITESTAG-Vault
git add "Paperclip/Projekte/WHITESTAG.ACADEMY/content/"
git commit -m "fix(academy): vier Bestandskurse nach Kurs-Spec nachgebessert"
```

---

## Abnahme (Definition of Done)

- [ ] `_KURS-SPEC.md` und `_KI-TOOL-STAND.md` liegen im Vault und sind committet.
- [ ] Fünf Prüfprofile liegen unter `Paperclip/_Meta/lektorat/pruefprofile/`.
- [ ] Agent „Lektorat" ist `idle`, `claude_local`, `claude-sonnet-4-6`, und seine
      AGENTS.md enthält den Rollentext.
- [ ] Rauchtest: Der Lektor hat `ki-projektplanung-organisation` selbstständig auf **ROT**
      gesetzt und die bekannten Mängel benannt.
- [ ] Routinen-Beschreibung ist vollständig gespeichert (endet nicht mitten im Wort),
      Cron steht auf `0 6 * * 2,4`.
- [ ] Die vier `grep`-Gegenprüfungen aus Task 7 Step 3 laufen ohne Treffer durch.
