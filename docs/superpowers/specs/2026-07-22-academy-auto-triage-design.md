# Design: Self-directed Triage für academy-auto

**Datum:** 2026-07-22
**Status:** Design (genehmigt, Spec zur Review)
**Ziel:** Das academy-auto-System findet **selbst** heraus, was als Nächstes an der WHITESTAG.ACADEMY-App zu tun ist — ohne dass ein schwaches lokales Modell das Repo lesen muss und ohne bei jedem Lauf teure Tokens zu verbrennen.

## Kontext

academy-auto (siehe `2026-07-22-academy-autonome-agenten-design.md`) lässt Claude Code headless im isolierten Worktree an der Academy-App arbeiten. Phase A + Sicherheits-Härtung sind fertig (28 Tests grün): Green-Gate, Diff-Cap, case-insensitiver Scope-Zaun. In Phase A wird der Auftrag **manuell** übergeben. Dieses Design ergänzt die **self-directed Triage** — eines von drei Automatik-Teilprojekten (die anderen: FS-Isolation, launchd — jeweils eigener Zyklus).

## Entscheidungen (aus dem Brainstorming)

| Frage | Entscheidung |
|---|---|
| Triage-Motor | **Deterministischer Scan + LLM rankt**: Python liest den Code mechanisch, ein einziger LLM-Call wählt/priorisiert |
| Kandidaten-Quellen | Alle vier: TODO/FIXME · übersprungene Tests · tsc+Lint · offene GitHub-Issues (`whitestagai/ki-kompass`) |
| Ranker | **Claude haiku** (kleiner Call, gute Urteilskraft für „gut geschnittene Aufgabe") |
| Anti-Oszillation | State-Datei + Quarantäne nach 2 Fehlversuchen |
| Gate-Wechselwirkung | Baseline-Snapshot; Delta-Gate nur wenn Baseline rot |

## Architektur — wo die Triage sitzt

Neuer Phase-1-Schritt in `run_once`, ersetzt den manuell übergebenen Auftrag:

```
run_once: Pause → Worktree → [Triage → Aufgabe wählen] → Impl → Gate → Scope → Diff-Cap → Commit → Digest
```

- Wird per CLI ein `task_prompt` übergeben, hat er Vorrang (manueller Override bleibt erhalten).
- Findet die Triage keinen Kandidaten → Status `nothing_to_do`, Digest „nichts zu tun", sauberer Abbruch (kein Commit, kein Fehler).

## Komponenten

Neues Unterpaket `tools/academy-auto/academy_auto/triage/`:

1. **`scan.py`** — reines Python, kein Modell. Liest den Worktree und erzeugt `Candidate(source, key, file, line, text, raw_priority)` aus vier Quellen:

   | Quelle | Erkennung | stabiler `key` |
   |---|---|---|
   | TODO/FIXME | grep `TODO\|FIXME\|@todo` unter `src/` (node_modules, ios/Pods, android/build ausgeschlossen) | `todo:<file>:<zeile>` |
   | Übersprungene Tests | grep `test.skip`, `xit(`, `it.todo`, `describe.skip`, `.skip(` in Test-Dateien | `skip:<file>:<zeile>` |
   | tsc-Typfehler | `npx tsc --noEmit` parsen (`file(line,col): error TSxxxx: msg`) | `tsc:<file>:<zeile>:<code>` |
   | Lint | `expo lint --format json` (eslint-JSON) parsen | `lint:<file>:<zeile>:<rule>` |
   | GitHub-Issues | `gh issue list --repo whitestagai/ki-kompass --state open --json number,title,labels,body` | `issue:<nr>` |

   `raw_priority` ist eine grobe deterministische Vorsortierung (z.B. tsc/lint-Fehler > übersprungene Tests > Issues > TODO), nur um die Liste für den Ranker auf die Top ~30 zu deckeln. Der `key` ist die Identität über Läufe (Dedup).

2. **`state.py`** — Anti-Oszillation. JSON `~/.paperclip/academy-auto/triage-state.json`: pro `key` → `{attempts, last_status, last_run}`.
   - `last_status == "committed"` → Kandidat fällt raus (erledigt), bis sein `key` sich ändert (verschwindet + taucht neu auf).
   - `attempts >= 2` bei `last_status in {"discarded","impl_failed"}` → **quarantäniert**: aus der Ranker-Liste ausgeschlossen, im Digest für Walter gelistet.
   - Funktionen: `load_state(path)`, `filter_candidates(state, candidates) -> list[Candidate]` (entfernt erledigte + quarantänierte), `record_outcome(state, key, status)`, `save_state(path, state)`, `quarantined_keys(state) -> list[str]`.

3. **`rank.py`** — der haiku-Ranker. `rank(cfg, candidates, baseline_red, ranker=<callable>) -> Pick | None`. Baut aus den (gefilterten, gedeckelten) Kandidaten einen kompakten Prompt, ruft `ranker` (Default = haiku-Call, injizierbar), erhält validiert `Pick(chosen_key, task_prompt, reason)`. `chosen_key` muss in der Kandidatenmenge liegen, sonst `None`. Bei roter Baseline wird der Ranker angewiesen, gate-greening zu bevorzugen.

4. **`__init__.py` / Orchestrator-Anbindung** — `triage_and_pick(cfg, cwd, deps) -> Pick | None` verdrahtet scan → filter → rank. `run_once` ruft es, wenn kein CLI-`task_prompt` gesetzt ist; nach dem Lauf `record_outcome(state, pick.chosen_key, report.status)`.

## Die Gate-Wechselwirkung (Baseline-Delta)

Das Green-Gate verlangt sauberes `tsc`+`lint`; die Triage schlägt aber genau solche Fehler als Aufgaben vor. Ist die Baseline schon rot, könnte keine Aufgabe je das Gate bestehen (Henne-Ei).

Auflösung:
- Triage macht zu Beginn einen **Baseline-Gate-Snapshot** (Fehlerzahl je Gate-Schritt).
- Baseline **grün** (Normalfall) → absolutes Gate unverändert.
- Baseline **rot** → höchste Priorität „Gate grün machen"; für diese Läufe gilt ein **Delta-Gate**: Erfolg = weniger Fehler als Baseline UND keine neuen. So arbeitet sich das System aus rotem Zustand heraus, ohne die Sicherheit im Normalbetrieb aufzuweichen.

## Datenfluss

```
scan(worktree) ──► candidates[]
                      │
state ──► filter_candidates ──► übrige Kandidaten (Top ~30)
                      │
baseline_gate_snapshot ─┐
                        ▼
                    rank(haiku) ──► Pick{chosen_key, task_prompt, reason}  (oder None → nothing_to_do)
                        │
             run_once nutzt task_prompt ──► Impl → (Delta-)Gate → Scope → Cap → Commit
                        │
             record_outcome(chosen_key, status) ──► state
                        │
                    Digest: gewählte Aufgabe + reason + Quarantäne-Liste
```

## Fehlerbehandlung

- `gh` nicht verfügbar / kein Netz → Issue-Quelle liefert leer (fail-soft), andere Quellen laufen weiter.
- `npx tsc` / `expo lint` brechen ab → betroffene Quelle leer, im Digest vermerkt; kein harter Abbruch der Triage.
- Ranker liefert ungültigen/nicht-existenten `chosen_key` oder leere Antwort → `None` (nothing_to_do), im Digest vermerkt.
- State-Datei korrupt/fehlt → als leerer State behandeln (alle Kandidaten frisch), nie werfen.

## Testing

- **scan.py:** je Quelle ein Fixture (TODO-Datei, `test.skip`-Datei, simulierte tsc/lint-JSON-Ausgabe gemockt, gemockte `gh`-JSON) → korrekte Candidates + stabile keys.
- **state.py:** Übergänge — frischer key, committed → gefiltert, 2× discarded → quarantäniert; korrupte Datei → leerer State.
- **rank.py:** Ranker gemockt; gültiger Pick durchgereicht, ungültiger `chosen_key` → None; baseline_red steuert Prompt-Hinweis.
- **Integration:** `triage_and_pick` liefert Auftrag / `None`; `run_once` ohne CLI-Prompt nutzt Triage; `nothing_to_do`-Pfad; `record_outcome` schreibt State.
- **Delta-Gate:** roter Baseline-Fall (Fehler sinkt → grün / Fehler gleich → discarded) + grüner Normalfall (absolut).

## Phasing (YAGNI)

- **T-Phase 1:** `scan.py` (4 Quellen) + `state.py` (Quarantäne) — reines Python, voll testbar, ohne LLM.
- **T-Phase 2:** `rank.py` (haiku) + Orchestrator-Integration (Triage liefert Auftrag) + Digest-Erweiterung.
- **T-Phase 3:** Baseline-Delta-Gate.

## Bewusst außerhalb dieses Designs

FS-Isolation (Dateisystem-Sandbox) und launchd-Automatik bleiben eigene Teilprojekte. Diese Triage läuft weiterhin **manuell/überwacht** angestoßen — sie macht das System selbststeuernd beim *Was*, nicht unbeaufsichtigt.

## Offene Punkte für die Umsetzung

- Exakte `expo lint --format json`-Ausgabe gegen das echte Academy-Repo verifizieren (Fallback: Text-Parsing).
- Deckel-Größe (Top-N Kandidaten) und `raw_priority`-Reihenfolge final festlegen.
- Delta-Gate: ob Fehler pro Schritt gezählt oder nur pass/fail je Schritt verglichen wird.
