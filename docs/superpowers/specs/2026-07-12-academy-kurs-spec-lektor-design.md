# Design: WHITESTAG.ACADEMY Kurs-Spec + Lektor-Agent

**Datum:** 2026-07-12
**Status:** Entwurf zur Abnahme
**Betrifft:** Paperclip-Routine `d7f2b01d-8b4b-454c-907d-15156e255ac4` („Täglicher WHITESTAG.ACADEMY Workshop"), WHITESTAG-Company, WHITESTAG-Vault

---

## 1. Ausgangslage

Die ACADEMY-Routine erzeugt seit dem 06.07.2026 täglich um 06:00 einen Kurs. Der CEO
delegiert an den **Online-Rechercheur** (`claude_local` / `claude-sonnet-4-6`) — also
bereits an den stärksten verfügbaren Agenten. Vier Kurse liegen vor:

| Kurs | Wörter | Status |
|---|---|---|
| `ki-datenschutz-dsgvo` | 3.803 | veröffentlicht, kostenlos |
| `ki-vertrieb-kundenkontakt` | 3.859 | fertig |
| `ki-handwerk-aussendienst` | 4.713 | fertig |
| `ki-projektplanung-organisation` | 5.080 | fertig |

Eine pädagogisch-inhaltliche Prüfung von `ki-projektplanung-organisation` ergab drei
schwerwiegende Mängel:

1. **Sachlich falsch.** Lektion 1: *„Was KI nicht kann: … E-Mails verschicken, Kalender
   buchen oder auf deine internen Systeme zugreifen."* Das ist seit den Connectoren und
   Agenten-Fähigkeiten von ChatGPT/Claude/Gemini überholt. In einem Bezahlkurs eines
   KI-Unternehmens ist das rufschädigend.
2. **Datenschutz fehlt.** Der Kurs empfiehlt Meeting-Mitschnitte, Verarbeitung von
   Mitarbeiter-Kompetenzprofilen und Auslastungsanalysen und nennt Arbeitszeiterfassung
   als Beispielprojekt — dazu gibt es einen Halbsatz mit Verweis auf „die
   Datenschutz-Hinweise", die im Kurs nicht existieren (toter Verweis). Mitbestimmung des
   Betriebsrats bei Leistungs-/Verhaltenskontrolle wird nirgends erwähnt.
3. **Der Wissens-Check prüft nichts.** Frage und Antwort stehen unmittelbar untereinander;
   der Testing-Effekt entfällt. Zudem verspricht das Lernziel „beherrschen" (Anwendung),
   abgefragt wird Reproduktion — Bruch des Constructive Alignment.

Nebenbefunde: sieben Personas in sieben Lektionen ohne durchgehenden Fall; unrealistische
Zeitangabe („8–12 Min." bei ~725 Wörtern Lesetext plus 20–30 Min. Übung); Werbe-Duktus
(„in 30 Sekunden fertig"); schiefe Kausalität in L3 („KI-Zeitpläne sind optimistisch —
das ist menschliche Natur"); Tippfehler („Eventagentür").

## 2. Ursache

**Die Routinen-Beschreibung ist bei exakt 1.200 Zeichen mitten im Wort abgeschnitten.**
Sie endet mit `2. **Beauftragen.** Gib dem gewä` — der Abschnitt „Arbeitspaket", auf den
der Text ausdrücklich verweist („Das vollständige Arbeitspaket … steht weiter unten"),
existiert nicht. Ein Schema-Limit ist das nicht (die Routine „Nightly LLM Advisor" hat
4.222 Zeichen); der Text wurde beim Anlegen abgeschnitten.

Folge: Der CEO erhält seit Wochen einen Auftrag ohne Spezifikation. Die Agenten leiten
Format und Inhalt aus den **bereits existierenden Kursdateien** ab — und vererben damit
die Fehler des ersten Kurses (offener Wissens-Check, veralteter Fähigkeits-Stand) von
Kurs zu Kurs weiter.

Die Mängel sind also **keine Modellmängel, sondern Briefing-Mängel**. Ein anderes oder
größeres Modell würde dieselben Fehler produzieren.

**Konsequenz für das Design:** Die Spezifikation darf nicht in der Routinen-Beschreibung
leben. Sie gehört als Datei in den Vault; die Routine verweist nur darauf.

## 3. Entscheidungen

| Frage | Entscheidung |
|---|---|
| Lektor-Zuschnitt | Alle Kunden-/Außen-Deliverables (nicht nur ACADEMY) |
| Lektor-Macht | Blockierendes Tor mit Rückgabe an den Autor, max. 2 Runden, dann Eskalation |
| Taktung | Von täglich auf 2×/Woche (Di + Do) |
| Bestand | Die vier bestehenden Kurse werden nachgebessert |

## 4. Architektur

Vier Bausteine. Sie sind unabhängig voneinander nutzbar: Die Spec wirkt auch ohne den
Lektor, der Lektor auch ohne die Spec (dann nur mit den Checklisten anderer
Deliverable-Typen).

```
Routine (Di+Do 06:00)
   │  verweist auf
   ▼
_KURS-SPEC.md ──────────┐
_KI-TOOL-STAND.md ──────┤ gelesen von
                        ▼
              Autor-Agent (Online-Rechercheur, claude-sonnet-4-6)
                        │ schreibt content/<slug>.md
                        ▼
              Lektor-Agent  ◄── pruefprofile/kurs.md
                        │       (+ angebot.md, pressemitteilung.md, …)
                        │ GRÜN / GELB / ROT + Mängelliste als Issue-Kommentar
              ┌─────────┴─────────┐
           ROT│                   │GRÜN
   zurück an Autor            CEO gibt frei, liefert aus
   (max. 2 Runden)
```

### 4.1 Baustein A — Kurs-Spec im Vault

**Datei:** `WHITESTAG-Vault/Paperclip/Projekte/WHITESTAG.ACADEMY/_KURS-SPEC.md`

Die verbindliche Bauanleitung. Beliebig lang, weil sie per `fs_read` gelesen und nicht
in ein Feld gepresst wird. Sie regelt:

- **Durchgehendes Fallbeispiel.** Ein Betrieb, eine Person, alle sieben Lektionen. Keine
  neue Persona pro Lektion.
- **Wissens-Check-Format.** Frage sichtbar, Antwort in einem `<details>`-Block verborgen.
  Anwendungs- statt Reproduktionsfrage („Hier ist ein Plan mit drei Fehlern — finde sie"),
  damit Lernziel und Prüfung auf derselben Taxonomie-Stufe liegen.
- **Pflicht-Datenschutz-Sektion.** In jedem Kurs. Bei personenbezogenen Themen
  (Mitschnitte, Mitarbeiterdaten, Zeiterfassung, Leistungsdaten) verbindlich mit:
  Auftragsverarbeitung, Einwilligung bei Aufnahmen, Mitbestimmung des Betriebsrats bei
  Leistungs- und Verhaltenskontrolle. Querverweis auf `ki-datenschutz-dsgvo`.
- **Querverweis-Regel.** Ein Verweis darf nur auf existierende Kurse/Abschnitte zeigen.
  Keine Verweise auf Dokumente, die der Kurs nicht enthält.
- **Zeitangaben.** Lesezeit und Übungszeit getrennt ausweisen, mit Rechengrundlage
  (200 Wörter/Min.).
- **Ton.** Verbot des Werbe-Duktus („in 30 Sekunden", „auf Knopfdruck"). Keine
  Zeitversprechen, die der Kurs nicht belegen kann.
- **Format-Gerüst.** Frontmatter-Felder, Lektionsaufbau, Prompt-Übung mit Feedback-Fokus
  (das funktioniert heute schon gut und wird ausdrücklich festgeschrieben).

### 4.2 Baustein B — Faktenstand-Datei

**Datei:** `WHITESTAG.ACADEMY/_KI-TOOL-STAND.md`

Was ChatGPT, Claude und Gemini **heute tatsächlich** können: Connectoren (Mail, Kalender,
Drive), Agenten-/Tool-Use-Fähigkeiten, kostenlos vs. kostenpflichtig, EU-Hosting.
Der Autor-Agent **muss** sie lesen, bevor er über Fähigkeiten und Grenzen von KI schreibt;
er darf dazu nicht aus dem Modellgedächtnis schreiben.

Gepflegt wird sie manuell bzw. perspektivisch durch den bestehenden Nightly LLM Advisor.
Sie trägt ein `stand:`-Datum im Frontmatter; ist es älter als 90 Tage, meldet der Lektor
GELB.

### 4.3 Baustein C — Lektor-Agent

**Agent:** `Lektorat`, Company WHITESTAG, `reports_to` = CEO,
`adapter_type = claude_local`, `model = claude-sonnet-4-6` (läuft damit über den
PII-Proxy auf `:4711`, wie alle claude_local-Agenten).

**Prinzip: Prüfer, nie Autor.** Er schreibt nie in ein fremdes Deliverable. Sein Output
ist ausschließlich ein Urteil.

**Prüfwissen liegt außerhalb des Agenten**, in
`WHITESTAG-Vault/Paperclip/_Meta/lektorat/pruefprofile/<typ>.md`:

| Profil | prüft |
|---|---|
| `kurs.md` | Compliance mit `_KURS-SPEC.md`, Faktenstand gegen `_KI-TOOL-STAND.md`, Lernziel/Prüfungs-Alignment |
| `angebot.md` | Vorlagentreue, Preis-/Leistungs-Vollständigkeit, Rechtstexte |
| `pressemitteilung.md` | Faktenbelege, Zitatfreigabe, Sperrfrist |
| `newsletter.md` | Betreff, Abmeldelink, Linkziele erreichbar |
| `webtext.md` | Faktenstand, tote Links, Claim-Belegbarkeit |

Neue Deliverable-Typen kommen als neue Profildatei dazu — der Agent selbst wird nicht
angefasst. Die Rollen-Datei `roles/lektorat.role.md` speist wie üblich den
`agents-instructions`-Generator (nur AGENTS.md erreicht lokale Agenten; für den
claude_local-Lektor gilt dasselbe Verfahren, damit die Flotte konsistent bleibt).

**Urteil (immer dasselbe Format, als Issue-Kommentar):**

- **GRÜN** — freigabefähig.
- **GELB** — freigabefähig mit Anmerkungen (z.B. Faktenstand-Datei älter als 90 Tage).
  Der CEO darf freigeben, die Anmerkungen gehen ins Themen-Log.
- **ROT** — nicht freigabefähig. Nummerierte Mängelliste, je Mangel: Fundstelle
  (Lektion/Zeile), Kategorie, konkreter Änderungsvorschlag.

**Was er NICHT prüft:** Stil und Geschmack. Nur harte Kriterien — Faktenstand,
Struktur-Compliance, Lernziel/Prüfungs-Alignment, tote Verweise, Rechtschreibung,
Vollständigkeit der Pflichtsektionen. Ein Prüfer, der über Formulierungen diskutiert,
blockiert nur.

**Abgrenzung zum DPO.** Der Lektor prüft, *ob* die Datenschutz-Sektion existiert und
plausibel ist. Für die inhaltliche Tiefenprüfung zieht er den bestehenden DPO-Agenten
hinzu (Subtask). Er ersetzt ihn nicht.

**Schleifen-Sicherung.** Bei ROT geht das Deliverable an den Autor-Agenten zurück.
**Maximal zwei Rückgaberunden.** Danach eskaliert der CEO an Walter — ohne diese Grenze
droht genau die Recovery-Kaskade, die die Flotte aus dem `maxIterations`-Problem kennt.

**Einstellung:** über `/agent-hires` + `/approve` (nicht `POST /agents` — das schlägt bei
`requireBoardApprovalForNewAgents=true` mit 409 fehl).

### 4.4 Baustein D — Routine-Reparatur

- **Beschreibung neu schreiben.** Kurz, vollständig, ohne Abschneiden. Sie verweist auf
  `_KURS-SPEC.md` statt ein Arbeitspaket zu enthalten. Nach dem Schreiben wird die
  gespeicherte Länge gegen die gesendete verifiziert — der Abschneide-Fehler darf sich
  nicht wiederholen.
- **Cron:** `0 6 * * *` → `0 6 * * 2,4` (Di + Do, Europe/Berlin).
- **Ablauf:** Autor schreibt → Lektor prüft → CEO gibt erst bei GRÜN/GELB frei und
  liefert aus.

### 4.5 Baustein E — Bestandsnachbesserung

Einmalige Issues für die vier bestehenden Kurse, Reihenfolge nach Schadenspotenzial:

1. `ki-datenschutz-dsgvo` — veröffentlicht und kostenlos, also das öffentliche Aushängeschild.
2. `ki-projektplanung-organisation` — enthält die falsche Fähigkeits-Passage nachweislich.
3. `ki-handwerk-aussendienst`
4. `ki-vertrieb-kundenkontakt`

Jeder Kurs läuft durch den Lektor; die ROT-Mängel gehen an den Autor-Agenten zurück.

## 5. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Lektor blockiert dauerhaft (Endlosschleife) | Max. 2 Rückgaberunden, dann Eskalation an Walter |
| Lektor zu streng kalibriert → nichts geht durch | Bewusst enger Kriterienkatalog; kein Stil/Geschmack |
| Verdoppelte Claude-Last pro Kurs | Halbierte Taktung (2×/Woche) fängt das über. Netto weniger Kosten als heute |
| Routinen-Beschreibung wird erneut abgeschnitten | Beschreibung kurz halten; Länge nach dem Schreiben verifizieren |
| Faktenstand-Datei veraltet unbemerkt | `stand:`-Datum im Frontmatter; > 90 Tage → Lektor meldet GELB |

## 6. Nicht im Scope

- Interne Deliverables (Protokolle, Recherche-Reports) — der Lektor prüft nur, was das
  Haus verlässt.
- Video-/Interaktiv-Produktion der Kurse. Es geht um die Textquelle.
- Umbau des Kurs-Publishing-Wegs in die ACADEMY-Plattform.
