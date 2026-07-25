# academy-auto — Kommunikationskette (Design)

**Datum:** 2026-07-25
**Status:** Entwurf, freigegeben zur Planung
**Kontext:** [[project_academy_auto_autonomous_coding]]

## Problem

academy-auto arbeitet nachts autonom an WHITESTAG.ACADEMY (`whitestagai/ki-kompass`)
und schickt **am Ende des 02:00-Laufs** einen einzelnen Telegram-Digest über den
Jarvis-Bot (`voice-echo-bot`). Zwei Mängel machen das ineffizient:

1. **Nacht-Ping:** Die Nachricht landet gegen 02:00 im Chat — mitten im Schlaf.
   Walter kann nicht reagieren, und die Nachricht ist morgens nur noch alte Historie.
2. **Einbahnstraße:** Es gibt keinen Rückweg. Walter kann weder freigeben
   („übernehmen") noch Richtung vorgeben, ohne selbst ins Repo/Terminal zu gehen.
   Heute steckt deshalb alles im Trockenlauf fest.

Ziel: eine Kette, in der Walter **schnell und mit minimalem Aufwand** reagiert —
in der Anfangsphase täglich informiert, später nur bei Milestones —, ohne selbst
Teil des nächtlichen Ablaufs zu sein.

## Anforderungen (aus dem Brainstorming festgelegt)

- **Zustellung Anfangsphase:** jeden Morgen **08:00** eine Zusammenfassung.
- **Zustellung später:** nur noch bei **Milestones** (umschaltbar per Config).
- **Reaktion:** Walter gibt **Richtung vor** *und* erteilt **Freigaben** (beides).
- **Freigabe-Aktion:** „Ja" öffnet einen **GitHub-Pull-Request** in `whitestagai/ki-kompass`
  (kein Auto-Merge — der Merge-Klick bleibt bei Walter).
- **Interaktion:** **Buttons** für Freigabe/Verwerfen (ein Tipp), **Freitext** für Richtung.
- **Betriebsregel:** kein zweiter Telegram-Poller. `voice-echo-bot` ist die einzige
  Instanz, die Updates dieses Bots liest ([[project_telegram_two_bots]]).

## Nicht-Ziele (YAGNI)

Keine Web-UI, keine Verlaufs-/Statistikansicht, kein Auto-Merge, keine mehreren
Vorschläge pro Nacht (bleibt bei 1 Task/Lauf, 800-Zeilen-Diff-Cap).

## Architektur

```
NACHT 02:00   academy-auto (bestehend) arbeitet
              → schreibt Ergebnis in pending.json   (KEINE Telegram-Nachricht)
                        │
MORGEN 08:00  Zustell-Job (neu, launchd) liest pending.json
              → baut Digest (mit Buttons, falls has_change)
              → sendet via notify.py (bestehend)
                        │
DU            antwortest im Jarvis-Chat
              → voice-echo-bot handle_update() erkennt Academy-Nachricht
              → schreibt intent.json               (sonst: normale Bot-Logik)
                        │
AKTION        academy-auto-Executor liest intent.json:
              approve   → öffnet PR in ki-kompass
              reject    → Branch-Reset (git reset --hard main + clean -fd)
              direction → legt GitHub-Issue als Nachtaufgabe an
              → intent.json wird nach Ausführung gelöscht
```

Outbound (Parken + Zustellung) und Executor leben **in academy-auto**. Der einzige
Eingriff in `voice-echo-bot` ist ein schmaler Erkenner in `handle_update()`.

## Bausteine & Zuständigkeiten

| Baustein | Ort | Aufgabe |
|---|---|---|
| Nachtlauf | academy-auto (bestehend) | arbeitet 02:00; **statt zu senden** schreibt es `pending.json` |
| Zustell-Job | academy-auto, neuer launchd 08:00 | liest `pending.json`, baut Digest, sendet via `notify.py` |
| Bot-Erkenner | `voice-echo-bot` `handle_update()` | erkennt Button-Callback + Freitext-Richtung → schreibt `intent.json`; sonst unverändert |
| Executor | academy-auto (neu) | verarbeitet `intent.json`: approve→PR, reject→Reset, direction→Issue |
| Milestone-Klassifikator | academy-auto (neu) | entscheidet im Modus `milestone`, ob gesendet wird |

## Datenverträge

Beide Nahtstellen sind kleine JSON-Dateien unter `~/.paperclip/academy-auto/`.
Dadurch bleiben Nacht/Morgen und Bot/Executor entkoppelt und einzeln testbar.

### `pending.json` (Nacht → Morgen)

```json
{
  "run_ts": "2026-07-25T02:00:03",
  "outcome": "dry_run | committed | nothing_to_do | error | scope_violation | cap_exceeded | impl_failed",
  "task": "Configure Jest type definitions ...",
  "reason": "Single root cause, 17× impact ...",
  "gate_note": "Delta grün (Fehler 658→12)",
  "branch_sha": "<sha auf agents/academy-auto>",
  "has_change": true,
  "quarantined": ["tsc:tests/...:100:TS2593"]
}
```

Der Nachtlauf schreibt (überschreibt) diese Datei am Ende. `has_change` = es liegt
ein freigabebereiter Commit auf `agents/academy-auto` vor, für den ein PR entstehen kann.

### `intent.json` (Bot → Executor)

```json
{
  "ts": "2026-07-25T08:03:11",
  "kind": "approve | reject | direction",
  "text": "<nur bei direction: Walters Freitext>",
  "ref_run_ts": "2026-07-25T02:00:03"
}
```

`ref_run_ts` korreliert die Antwort mit dem Digest, auf den sie sich bezieht.
Der Bot füllt es aus dem Callback-Payload (Buttons) bzw. dem letzten gesendeten Digest.

## Benachrichtigungs-Modi

Config-Schalter `notify_mode`:

- **`daily`** (Anfangsphase): Zustell-Job sendet **jeden Morgen 08:00**, auch bei
  `nothing_to_do` (kurzer „heute nichts Umsetzbares"-Hinweis).
- **`milestone`** (später): Zustell-Job sendet **nur**, wenn der Milestone-Klassifikator
  zustimmt. Umschalten = ein Config-Wert, kein Umbau.

**Milestone-Definition** (ein Lauf ist Milestone, wenn *eines* zutrifft):
1. `has_change == true` — ein Change liegt freigabebereit (PR-fähig).
2. `outcome == error` — ein Fehler/Absturz trat auf.
3. „großer Test": Gate-Delta überschreitet Schwelle (`milestone_delta_threshold`,
   Default 50 behobene/neue tsc-Fehler).

Reine „nichts zu tun"-Nächte schweigen im `milestone`-Modus.

## Interaktion (Telegram)

Der 08:00-Digest enthält bei `has_change` eine **Inline-Tastatur**:

- `✅ PR öffnen` → callback_data `academy:approve:<run_ts>`
- `❌ Verwerfen` → callback_data `academy:reject:<run_ts>`
- `✍️ Richtung geben` → informativer Hinweis; Walter antwortet danach per **Freitext**
  (z.B. „mach als nächstes den Login-Screen responsive"). Der Bot erkennt die
  Freitext-Richtung anhand des Reply-Kontexts bzw. eines Präfixes.

Buttons erzeugen `intent.json` mit `kind=approve|reject`; Freitext-Richtung mit
`kind=direction, text=…`.

## Fehlerbehandlung & Kanten

- **Fail-soft ist Gesetz:** kein Baustein darf Nachtlauf oder Bot crashen.
  Telegram nicht erreichbar → `pending.json` bleibt liegen, nächster 08:00-Job
  versucht erneut.
- **Späte/überholte Antwort:** Executor vergleicht `ref_run_ts` mit aktuellem
  `pending.json`/Branch-Stand; passt es nicht → Rückmeldung „dieser Vorschlag ist
  überholt", **keine** Aktion.
- **PR-Öffnen scheitert** (gh/Netz): `intent.json` bleibt stehen, Fehler wird im
  nächsten Digest gemeldet, nichts geht verloren.
- **Doppelter Button-Tipp:** idempotent — bereits verarbeiteter Intent
  (gelöschte Datei / bereits offener PR) führt zu freundlichem Hinweis, nicht zu
  Doppel-PR.
- **Bot-Erkenner darf normale Jarvis-Nutzung nicht stören:** nur Nachrichten mit
  Academy-Callback-Präfix oder Academy-Reply-Kontext werden abgezweigt, alles
  andere fließt unverändert durch `handle_update()`.

## Test & Absicherung (TDD)

Jeder Baustein isoliert:

- Pending-Writer/Reader (Roundtrip, fehlende Datei → fail-soft).
- Intent-Writer/Reader (Roundtrip, Löschung nach Ausführung).
- Digest-Builder: mit/ohne Buttons, Modi `daily` und `milestone`.
- Milestone-Klassifikator: alle drei Kriterien + „schweigt bei nothing_to_do".
- Executor: `approve` (gemocktes `gh`), `reject` (gemocktes git), `direction`
  (gemocktes Issue-Anlegen); überholter `ref_run_ts` → keine Aktion.
- Bot-Erkenner: „ist Academy-Nachricht / ist es nicht" — normale Updates bleiben
  unberührt.

## Offene Punkte für die Planung

- Genaue Erkennungsregel für Freitext-Richtung im Bot (Reply-auf-Digest vs. Präfix)
  — in der Planung festzurren.
- `gh`-Verfügbarkeit/Auth im launchd-Kontext prüfen (analog SynologyDrive-Gotcha:
  academy-auto liegt bereits unter `~/Developer/…`).
- launchd-plist für den 08:00-Zustell-Job (getrennt vom bestehenden 02:00-Lauf).
