# LM-Studio-Adapter: Fallback-LLM

**Datum:** 2026-04-20
**Status:** Design approved, bereit für Implementation-Plan
**Scope:** `paperclip-adapter-lmstudio`

## Problem

Walter betreibt LM Studio primär auf einem Windows-PC (starke Modelle, z.B. Gemma 4 31b). Wenn der Windows-PC aus ist (Reboot, Stromausfall, Feierabend), können Paperclip-Agenten, die diesen Adapter nutzen, keine Heartbeats mehr ausführen. Auf dem Mac läuft eine zweite LM-Studio-Instanz mit kleineren Modellen, die aktuell nicht als Fallback eingebunden ist.

Der Adapter soll so erweitert werden, dass ein optionaler Fallback-Endpoint konfiguriert werden kann. Fällt der Primary aus, wechselt der Adapter automatisch auf den Fallback — transparent, sichtbar und ohne manuelles Eingreifen.

## Nicht-Ziele

- Kein Load-Balancing zwischen mehreren Endpoints
- Kein Multi-Fallback (mehr als eine Fallback-Ebene)
- Kein zentraler Pool im Paperclip-Server — Fallback bleibt Adapter-intern
- Kein Retry auf demselben Endpoint (Paperclip startet eh den nächsten Heartbeat neu)

## Konfiguration (pro Agent)

Bestehende Felder bleiben als „Primary". Bestehende Agenten laufen unverändert weiter, weil alle neuen Felder optional sind.

| Feld | Typ | Default | Beschreibung |
|------|-----|---------|--------------|
| `url` | text | `http://localhost:1234` | Primary LM-Studio-URL |
| `defaultModel` | select | — | Primary-Modellname |
| `fallbackUrl` | text | leer | Fallback LM-Studio-URL. Leer = kein Fallback |
| `fallbackModel` | text | leer | Fallback-Modellname. Leer = identisch mit `defaultModel` |
| `probeTimeoutMs` | number | `2000` | Timeout für Health-Probe vor jedem Heartbeat |
| `timeoutMs` | number | `120000` | Voller Call-Timeout (unverändert) |
| `streamingEnabled` | boolean | `true` | unverändert |
| `maxIterations` | number | `25` | unverändert |

Beispiel-Config für Walter:

```json
{
  "url": "http://192.168.1.50:1234",
  "defaultModel": "gemma-4-31b-it",
  "fallbackUrl": "http://localhost:1234",
  "fallbackModel": "gemma-4-27b-it",
  "probeTimeoutMs": 2000,
  "timeoutMs": 120000
}
```

## Fallback-Verhalten

### Trigger-Bedingungen

Der Adapter wechselt auf den Fallback, wenn:

1. **Health-Probe schlägt fehl** — Vor dem ersten Call im Heartbeat pingt der Adapter `GET {primaryUrl}/v1/models` mit `probeTimeoutMs`. Connection refused, DNS-Fehler, Timeout → Fallback.
2. **Modell-Fehler während des Calls** — HTTP 404 oder „model not found" von LM Studio während eines Tool-Iterations-Calls.
3. **Call-Timeout** — Der eigentliche Chat-Completion-Call überschreitet `timeoutMs` (z.B. Windows-PC friert gerade ein).

### State-Machine (pro Heartbeat)

```
Heartbeat startet
   │
   ▼
[Probe Primary]  ── GET /v1/models mit probeTimeoutMs
   │
   ├── OK ─────► Primary aktiv für diesen Heartbeat
   │                 │
   │                 ▼
   │              Calls laufen normal. Bei hartem Fehler
   │              (Connection lost / Timeout / Model-404)
   │              → einmaliger Wechsel auf Fallback + Meta-Event
   │              → Rest des Heartbeats auf Fallback
   │
   └── FAIL ────► Probe Fallback
                     │
                     ├── OK ──► Fallback aktiv, Meta-Event posten
                     │
                     └── FAIL ► Run schlägt fehl mit Error-Message
```

### Sticky pro Heartbeat

- Einmal innerhalb eines Heartbeats auf Fallback gewechselt, bleibt der Adapter dort bis zum Heartbeat-Ende.
- Der nächste Heartbeat beginnt wieder mit Primary-Probe. Ist Windows wieder da, läuft alles über Primary.
- Kein Meta-Event beim „still on fallback"-Heartbeat (nur beim tatsächlichen Wechsel-Event).

### Probe-Frequenz

- **Einmal pro Heartbeat** am Anfang. Nicht vor jedem Tool-Iterations-Call (zu viel Overhead).
- Probe-Call ist leichtgewichtig (`GET /v1/models`, kein Body).

## Sichtbarkeit — Meta-Event im Transcript

Beim tatsächlichen Wechsel auf den Fallback postet der Adapter ein Meta-Event ins Run-Transcript. Dadurch sieht Walter im Paperclip-UI direkt, dass der Fallback aktiv war.

Event-Typ orientiert sich am bestehenden Transcript-Meta-Event-Pattern. Inhalt:

```
⚠️ Primary LLM nicht erreichbar ({primaryUrl}).
Fallback aktiv: {fallbackUrl} / {fallbackModel}
Grund: {reason}
```

Wird nur beim Wechsel gepostet, nicht wiederholt innerhalb eines Heartbeats.

## Fehler-Handling bei Totalausfall

Wenn sowohl Primary als auch Fallback nicht erreichbar sind:

- Probe-Fallback läuft mit demselben `probeTimeoutMs`.
- Beide fehlgeschlagen → Adapter wirft einen klaren Error:

  ```
  LM Studio nicht erreichbar:
    primary = <url> (<reason>)
    fallback = <url> (<reason>)
  ```

- Error geht ins Run-Transcript und ins Server-Log.
- Paperclip markiert den Run als „failed" wie bei jedem anderen Adapter-Fehler.
- Kein automatischer Retry — der nächste Heartbeat-Schedule versucht ohnehin wieder ab Probe.

Wenn `fallbackUrl` leer ist und Primary down → Fehler nur über Primary, Verhalten identisch zu heute (Regressions-Schutz).

## Implementation-Überblick

Betroffene Dateien (primär):

- [paperclip-adapter-lmstudio/src/server/llm-client.ts](paperclip-adapter-lmstudio/src/server/llm-client.ts) — Neue `probeEndpoint()`-Funktion, bestehende Call-Funktionen bekommen structured errors (network/model/timeout)
- [paperclip-adapter-lmstudio/src/server/execute.ts](paperclip-adapter-lmstudio/src/server/execute.ts) — Probe-Logik am Heartbeat-Start, Sticky-State, Fallback-Switch bei Fehlern, Meta-Event posten
- [paperclip-adapter-lmstudio/src/server/index.ts](paperclip-adapter-lmstudio/src/server/index.ts) — Config-Schema um neue Felder erweitern
- [paperclip-adapter-lmstudio/src/index.ts](paperclip-adapter-lmstudio/src/index.ts) — UI-Config-Schema (Formular-Felder für Agent-Config)

Neue Abhängigkeiten: keine.

## Testing-Strategie

### Unit-Tests (`tests/fallback.test.ts`, mocked fetch)

1. Probe-Primary OK → Call geht an Primary, kein Meta-Event, kein Fallback-Aufruf
2. Probe-Primary Timeout → Probe-Fallback OK → Call geht an Fallback, Meta-Event gepostet
3. Probe-Primary Connection-refused → Fallback aktiv, Meta-Event gepostet
4. Probe-Primary OK, aber Model-404 während Call → Wechsel auf Fallback mit Meta-Event
5. Probe-Primary Timeout + Probe-Fallback Timeout → Run schlägt fehl mit klarem Error
6. `fallbackUrl` leer + Primary down → Fehler wie heute (Regressions-Schutz)
7. `fallbackModel` leer → Fallback nutzt `defaultModel`-Namen
8. Sticky-Verhalten: Einmal auf Fallback gewechselt, bleibt der Rest des Heartbeats dort

### Integration-Test (opt-in via ENV, live LM Studio)

- Setup: LM Studio auf Mac läuft, `primaryUrl` zeigt bewusst auf nicht-existenten Host
- Erwartung: Probe schlägt fehl, Fallback läuft, Tool-Call funktioniert

### Manuelle Verifikation vor „done"

- Windows-PC aus, Heartbeat auslösen → Run läuft über Mac, Meta-Event im UI sichtbar
- Windows-PC wieder an, nächster Heartbeat → Probe OK, läuft wieder über Windows (kein Meta-Event)

## Rollout

- Kein Breaking Change. Bestehende Agent-Configs funktionieren unverändert.
- Walter aktiviert Fallback pro Agent, wenn gewünscht.
- Implementation läuft in eigenem Worktree `.worktrees/lmstudio-fallback/`, parallel zur laufenden DSGVO-Agent-Arbeit in `.worktrees/dpo-agent/`.
