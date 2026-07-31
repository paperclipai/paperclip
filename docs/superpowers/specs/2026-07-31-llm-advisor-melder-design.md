# LLM-Advisor: vom Vorschlager zum Melder mit Gedächtnis

**Datum:** 2026-07-31
**Status:** freigegeben, Umsetzung ausstehend
**Auslöser:** WHI-3389 — dritte Fehlalarm-Welle in Folge
**Betroffen:** `~/.paperclip/scripts/llm-advisor/` (host-lokales Git-Repo, kein Remote),
Routine `666f3c66-e9e6-47a5-ad8a-96b86a8b21fb`, Agent LLM-Konfigurationsanalyst `efe7168d`

## Problem

Der Advisor produzierte am 31.07. drei Modellwechsel-Vorschläge. Zwei waren technisch
nicht ausführbar (`claude_local`-Agenten lassen sich nicht über den LM-Studio-Katalog
umweisen), der dritte war unbegründet (`fail_rate` 0,018; das Ziel war bereits der
eigene Fallback). Eine der genannten Fehlerzahlen war frei erfunden.

Am selben Tag strukturell behoben (Commits `d506348`, `4939e37`, `da86903`):
Ursachenklassen `adapter` und `upstream`, Schmerzschwelle `actionable`,
Klartext-Cluster `top_errors`, gerenderte Beweiszeile `evidence`.

**Was danach übrig bleibt, ist das eigentliche Problem:** Von 42 Agenten ist nach dem
Umbau genau einer modellwechsel-fähig. Ein System, das trotzdem täglich Empfehlungen
ausgeben soll, muss welche erfinden. Der Rollenzuschnitt selbst erzeugt die Fehlalarme —
wenn das einzige Werkzeug ein Modellwechsel ist, sieht jedes Problem wie ein falsches
Modell aus.

Zweitens gibt es **keine Rückkopplung**: 102 Vorschläge liegen im State, davon 20 als
`implemented` markiert. Niemand hat je gemessen, ob einer davon etwas verbessert hat.
Ohne dieses Signal kann die Qualität systematisch nicht steigen.

## Ziel

Der Advisor meldet **Befunde** statt Empfehlungen und weist bei jedem Lauf nach, was aus
den vorherigen Befunden geworden ist. Eine konkrete Änderung schlägt er nur dort vor, wo
sie deterministisch belegbar ist.

**Erfolgskriterium:** Nach drei Monaten Betrieb lässt sich die Frage „hat der Advisor je
etwas verbessert?" mit Zahlen beantworten — und die Schmerzschwelle ist mit Daten statt
mit Bauchgefühl justiert.

## Baustein 1 — Befundtypen (`advisor/findings.py`)

Die Ausgabeform ergibt sich deterministisch aus `signals.cause`. Kein neuer
Entscheidungscode: die Klassen existieren, sie bekommen je eine Form.

| `cause` | Befundform | Konkrete Aktion |
|---|---|---|
| `config` | „`maxIterations=12` zu eng für N Tool-Calls" | ja — `PATCH /api/agents/<id>` |
| `model` | Modellwechsel wie bisher | ja — `apply_proposal.py` |
| `upstream` | „Rate-Limit, N× — Kontingent bzw. Taktung" | nein, nur Befund |
| `adapter` | „Fremdprozess, dominanter Klartext: …" | nein, nur Befund |
| `none` | — | erscheint nicht im Bericht |

Ein Befund ist ein Dict:

```
{
  "agent_id":   str,
  "agent_name": str,
  "cause":      "config" | "model" | "upstream" | "adapter",
  "evidence":   str,      # wörtlich aus advisor.evidence.evidence_line
  "dominant":   str,      # top_errors[0].sample, gekürzt
  "action":     dict|None # nur bei config/model
  "first_seen": str       # ISO-Datum des Laufs
}
```

`action` ist genau dann gesetzt, wenn die Änderung ausführbar **und** belegbar ist. Bei
`upstream`/`adapter` ist sie immer `None` — das ist der Kern der neuen Rolle.

**Regel:** Ein Befund ohne `evidence` wird nicht ausgegeben. `evidence` stammt wörtlich
aus `evidence_line()`; `verify_error_counts()` prüft den fertigen Berichtstext gegen die
Telemetrie, bevor er die Mail verlässt.

## Baustein 2 — Wirksamkeitsmessung (`advisor/outcomes.py`)

Der Kern der Änderung. Für jeden früheren Befund beantwortet das System zwei Fragen
selbst, ohne Rückmeldung von außen.

### Datenquellen

- **`agent_config_revisions`** — 680 Einträge seit 2026-04-15, mit `before_config`,
  `after_config`, `changed_keys`, `source`, `created_at`. Damit ist erkennbar, *ob*,
  *wann* und *was* an einem Agenten geändert wurde.
- **`heartbeat_runs`** — 31.122 Läufe seit 2026-04-15. Es gibt **keine
  Retention-Löschung** (nur Kaskaden beim Löschen von Agent oder Company), die Historie
  ist also vollständig.
- **`state/llm-advisor-state.json`** — 102 Vorschläge, Zeitraum 2026-06-14 bis
  2026-07-31, 99 davon mit `first_seen`.

### Messgröße

Absolute Fehlerzahlen sind unbrauchbar, weil die Zahl der Läufe je Fenster schwankt.
Gemessen wird die **Klassenrate**:

```
klassenrate(agent, ursachenklasse, fenster) =
    Fehlläufe mit Code aus dieser Klasse im Fenster
    ────────────────────────────────────────────────
    alle Läufe des Agenten im Fenster
```

Verglichen wird die Klassenrate **14 Tage vor** dem Stichtag mit **14 Tage nach** dem
Stichtag. Stichtag ist die Konfigurationsänderung, falls eine erfolgte — sonst das
Befunddatum. 14 Tage, weil die Telemetriefenster des Advisors 7 Tage betragen und ein
Vergleich mindestens zwei volle Fenster abdecken muss.

Ein Rückgang gilt als Verbesserung, wenn sich die Klassenrate **mindestens halbiert**.
Diese Grenze ist bewusst grob: Sie soll Wirkung von Rauschen trennen, nicht Feinheiten
auflösen. Fenster mit weniger als 10 Läufen gelten als nicht auswertbar (`unklar`) —
dieselbe Datenbasis-Anforderung wie bei der Schmerzschwelle.

### Ergebnisklassen

| Ergebnis | Änderung erfolgt? | Klassenrate | Bedeutung |
|---|---|---|---|
| `behoben` | ja | halbiert oder besser | Diagnose war richtig, Maßnahme wirkte |
| `wirkungslos` | ja | unverändert oder schlechter | **Diagnose war falsch** |
| `ignoriert` | nein | unverändert | Befund blieb liegen |
| `rauschen` | nein | von selbst zurückgegangen | **Befund hätte nie kommen dürfen** |
| `unklar` | — | zu wenige Läufe | keine Aussage |

`wirkungslos` und `rauschen` sind die eigentlichen Lernsignale. Häufen sich
`rauschen`-Fälle, sitzt die Schwelle (`MIN_CODED_ERRORS=10`, `MIN_FAIL_RATE=0.10`) zu
niedrig und lässt sich mit Daten nachziehen. Häufen sich `wirkungslos`-Fälle, ist die
Ursachenzuordnung in `signals.py` falsch.

### Modulschnitt

`outcomes.py` enthält nur reine Funktionen — dasselbe Muster wie `telemetry.py`, wo
`fetch_rows()` vom testbaren `aggregate_runs()` getrennt ist:

```
fetch_config_revisions(days)        -> rows          # DB, ungetestet
find_config_change(revisions, agent_id, since)
                                    -> revision|None
class_rate(runs, codes)             -> float|None    # None = zu wenige Läufe
classify_outcome(before, after, changed) -> str
evaluate(findings, runs, revisions) -> [{finding, outcome, before, after}]
```

Kein DB-Zugriff im Kern; alle Funktionen nehmen Listen und Dicts und sind mit
Fixtures testbar.

### Rückwirkender Erstlauf

Erster Umsetzungsschritt, weil er sofort Erkenntnis liefert und zugleich prüft, ob die
Messung trägt: die 102 Altvorschläge gegen `evaluate()` laufen lassen. Die 20 als
`implemented` markierten sind der eigentliche Datensatz — sie beantworten zum ersten Mal,
ob der Advisor in seiner Laufzeit etwas verbessert hat.

**Einschränkung, die im Ergebnis zu nennen ist:** Altvorschläge tragen kein `cause`-Feld
(die Klassen gibt es erst seit dem 30./31.07.) und nur 21 von 102 eine `agent_id`. Für
die übrigen wird über `agent` (Name) auf `agents.name` gejoint; Namensdubletten und
gelöschte Agenten fallen als `unklar` heraus. Bei Altvorschlägen wird die Klassenrate
über **alle** Fehlercodes gerechnet statt über eine Klasse.

## Baustein 3 — Bericht und Taktung

**Aufbau:** Der Bericht beginnt mit „Was aus den letzten Befunden wurde" (Baustein 2),
danach folgen neue Befunde. Ohne Befunde und ohne Ergebnisse gibt es **keine Mail**. Ein
stiller Lauf ist ein gutes Ergebnis, kein erfolgloser — das ist im `routine-brief.md`
ausdrücklich festzuhalten, damit der Agent keinen Druck verspürt, etwas zu finden.

**Taktung:** wöchentlich statt täglich, **Montag 07:00** (Europe/Berlin). Zwei Gründe:
Modelllandschaft und Agentenkonfiguration ändern sich nicht täglich; und der Lauf
verschwindet aus dem 10–12-Uhr-Fenster, in dem 44 der 116 Rate-Limit-Fehlläufe der
letzten 14 Tage auftraten (WHI-3401). 07:00 liegt vor den 09/10/11-Uhr-Routinen und nach
dem Nacht-Auth-Fenster, das 2026-07-07 zur Verlegung von 04:30 auf 11:00 führte.

Umzustellen über `PATCH /api/routine-triggers/946965d8-1cb1-422c-b3f2-29e67fd8eda6` auf
`cronExpression: "0 7 * * 1"` (aktuell `0 11 * * *`, Zeitzone Europe/Berlin bleibt).

**Mitzuziehen:** Die Routine heißt `LLM-Advisor (täglich 11:00)` — die Taktung steht im
Titel und erscheint so in jedem erzeugten Issue. Titel auf
`LLM-Advisor (wöchentlich, Mo 07:00)` ändern, sonst widerspricht der Name dem Verhalten.
Ebenso die Kopfzeile in `routine-brief.md` und die Beschreibung im `README.md` des
Advisor-Repos, die beide „täglich 11:00" nennen.

## Baustein 4 — `claude-opus-5` fehlt in der Adapter-Modellliste

**Korrigierte Fassung (bei der Umsetzung überprüft).** Der ursprüngliche Verdacht war,
der Agent liefe wegen dieser Lücke tatsächlich auf einem anderen Modell. Das trägt
nicht:

- `models` in `packages/adapters/claude-local/src/index.ts` wird **nirgends zur
  Validierung oder als Fallback** benutzt — sie speist nur die Modellauswahl in der UI.
- `execute.ts:663` reicht ein gesetztes `model` unverändert als `--model` an die CLI
  durch. `claude-sonnet-4-6` in Zeile 23 ist das `cheap`-Profil, kein Default.
- Die Telemetrie stützt die Drift-These nicht: Der **frische** Session-Start des
  Advisors am 31.07. um 11:00 lief mit `claude-opus-5`. Nur Resume-Läufe
  (`freshSession=false`) zeigen überwiegend `claude-sonnet-4-6` — und auch das nicht
  durchgängig (14:01 und 14:08 sind Opus 5 trotz Resume).

**Deutung:** `usage_json.model` gibt den Abrechnungsschwerpunkt eines Session-Deltas
wieder, nicht das Hauptmodell des Laufs. Claude Code nutzt intern Sonnet für
Nebenaufgaben (Kompaktierung, kleine Tool-Zyklen); bei Resume-Läufen mit wenig
Hauptarbeit dominiert das die Abrechnung. **`usage_json.model` ist daher kein
verlässlicher Beleg dafür, mit welchem Modell ein Agent arbeitet.**

**Maßnahme bleibt, mit anderer Begründung:** `claude-opus-5` in die Modellliste
aufnehmen, damit es in der UI wählbar ist und nicht versehentlich überschrieben wird.
Das ist eine Vollständigkeitslücke, kein Laufzeitfehler — und deshalb auch kein
dringender Punkt.

Betrifft das Paperclip-Hauptrepo, nicht das Advisor-Repo.

## Testplan

Alle neuen Funktionen test-first, im vorhandenen Harness (`tests/`, aktuell 73 Tests):

- **`class_rate`** — Rate bei 0 Läufen ist `None`, nicht 0; unter 10 Läufen `None`.
- **`find_config_change`** — findet die Änderung nach dem Stichtag, ignoriert frühere;
  ignoriert Änderungen an anderen Agenten.
- **`classify_outcome`** — je ein Test pro Ergebnisklasse, plus die Grenze „genau
  halbiert" (gilt als behoben).
- **`evaluate`** — ein Befund ohne verwertbare Telemetrie wird `unklar`, nicht `ignoriert`.
- **`findings`** — `upstream` und `adapter` erzeugen **nie** ein `action`-Feld; `config`
  und `model` immer eines.
- **Berichtstext** — durchläuft `verify_error_counts()` ohne Beanstandung.

Zusätzlich ein Realitäts-Check gegen die Live-DB nach jedem Baustein, wie bei der
Umsetzung am 31.07.: Ergebnis am echten Snapshot prüfen, nicht nur an Fixtures. Genau so
fiel dort auf, dass `claude_transient_upstream` gar nicht gezählt wurde.

## Nicht-Ziele

- **Keine automatische Schwellen-Anpassung.** Die Messung liefert die Zahlen; die
  Entscheidung, `MIN_CODED_ERRORS` oder `MIN_FAIL_RATE` zu ändern, bleibt bei Walter.
- **Keine Erweiterung der Web-Recherche.** Sie bleibt wie sie ist.
- **Kein Umbau der Mail-Pipeline.** `send_advisor_mail.sh` bleibt unverändert; nur der
  Inhalt und die Bedingung „nur bei Befund" ändern sich.
- **Keine Automatik.** Der Advisor ändert weiterhin nie selbst eine Zuweisung.

## Risiken

- **Der Stichtag ist unscharf**, wenn zwischen Befund und Änderung mehrere Wochen liegen
  oder mehrere Änderungen erfolgten. Behandlung: Es zählt die **erste** Änderung nach dem
  Befund; spätere werden im Ergebnis als Hinweis genannt, nicht verrechnet.
- **Nebenläufige Ursachen.** Eine Fehlerrate kann aus Gründen sinken, die nichts mit der
  Maßnahme zu tun haben (siehe `llm_error`-Sturm des CMO, der am 22.07. von selbst
  endete). Die Messung kann das nicht trennen; sie ist ein Indiz, kein Beweis. Deshalb
  die grobe Halbierungs-Grenze statt Feinauswertung.
- **Dünne Datenbasis am Anfang.** Vor der rückwirkenden Auswertung ist unklar, wie viele
  der 20 `implemented`-Fälle überhaupt auswertbar sind. Fällt der Erstlauf weitgehend
  `unklar` aus, ist das selbst das Ergebnis: Dann trägt die Messung erst ab jetzt
  vorwärts, und der Aufwand für den rückwirkenden Teil ist gedeckelt.

## Bezüge

- Fixes vom 31.07.: `d506348`, `4939e37`, `da86903` (Advisor-Repo)
- `WHI-3389` — der Lauf, der den Umbau auslöste
- `WHI-3401` — Account-Rate-Limit; die Taktungsänderung zahlt darauf ein
- `WHI-3348` / `WHI-3362` — der Config-Strukturfix vom 30.07.
