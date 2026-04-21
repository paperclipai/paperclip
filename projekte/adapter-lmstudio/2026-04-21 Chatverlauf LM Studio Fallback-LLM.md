# Chatverlauf — LM Studio Fallback-LLM

**Datum:** 2026-04-21
**Thema:** Optionaler Fallback-Endpoint im LM-Studio-Adapter für Paperclip

## Ausgangslage

Walter betreibt LM Studio primär auf dem Windows-PC (stärkere Modelle, z.B. Gemma 4 31b). Wenn der Windows-PC aus ist (Reboot, Feierabend, Stromausfall), können Paperclip-Agenten keine Heartbeats mehr ausführen. Auf dem Mac läuft eine zweite LM-Studio-Instanz mit kleineren Modellen, die bis jetzt nicht als Fallback eingebunden war.

## Was wurde gemacht

### 1. Design-Phase (Brainstorming)
Durch 5 Klärungsfragen iterativ das Design entwickelt:

- **Richtung:** Fallback im Adapter (pro Agent), nicht Reverse-Proxy oder zentraler Pool.
- **Trigger:** Netzwerk-Fehler + Modell-Fehler + Call-Timeout.
- **Switch-back:** Sticky pro Heartbeat — einmal auf Fallback, bleibt dort bis Heartbeat-Ende. Nächster Heartbeat probiert wieder Primary.
- **Config:** Primary-URL/Model + optional Fallback-URL/Model + separater Probe-Timeout.
- **Sichtbarkeit:** Meta-Event im Run-Transcript beim tatsächlichen Wechsel.
- **Timeout:** Schnelle Primary-Probe (2s) vor jedem Heartbeat, damit toter Primary den Run nicht blockt.

**Spec:** [docs/superpowers/specs/2026-04-20-lmstudio-fallback-design.md](docs/superpowers/specs/2026-04-20-lmstudio-fallback-design.md)

### 2. Implementation-Plan
7 Tasks mit TDD-Ansatz:

1. Config-Schema erweitern
2. Typisierte Errors (`LlmClientError` mit `kind: network|model|timeout|unknown`)
3. `probeEndpoint()` Health-Probe-Funktion
4. `endpoint-resolver.ts` Entscheidungs-Modul
5. Fallback in `execute.ts` integrieren (Heartbeat-Start-Probe + Mid-Call-Switch)
6. README-Dokumentation
7. Manuelle Verifikation (Walter)

**Plan:** [docs/superpowers/plans/2026-04-20-lmstudio-fallback.md](docs/superpowers/plans/2026-04-20-lmstudio-fallback.md)

### 3. Umsetzung (Subagent-Driven im Worktree)
Isolierter Worktree unter `.worktrees/lmstudio-fallback/`, Branch `feature/lmstudio-fallback`. Jeder Task wurde von einem frischen Implementer-Subagent umgesetzt, danach Spec-Compliance-Review + Code-Quality-Review.

**Review-Iterationen:**
- Task 2: Code-Quality fand 2 Important-Issues (regex-ordering + 404-heuristic zu generös) → gefixt.
- Task 5: Implementer fand Plan/Test-Widerspruch → resolved durch Plan-Originalversion wiederhergestellt (Probe vor Mid-Call-Switch erhalten). Zusätzlich 2 Important-Issues im Code-Quality-Review gefixt (model/usage in error-returns + retry-timeout-cap gegen Double-Timeout).

**Final-Review:** „Ready for manual verification."

### 4. Merge + Build auf master
Branch per `git merge --no-ff` auf master integriert. Adapter neu gebaut.

## Geänderte/Neue Dateien

### Neu angelegt
- `paperclip-adapter-lmstudio/src/server/endpoint-resolver.ts`
- `paperclip-adapter-lmstudio/tests/endpoint-resolver.test.ts`
- `paperclip-adapter-lmstudio/tests/fallback.test.ts` (9 Tests)
- `paperclip-adapter-lmstudio/tests/llm-client-errors.test.ts` (6 Tests)
- `paperclip-adapter-lmstudio/tests/probe.test.ts` (5 Tests)
- `docs/superpowers/specs/2026-04-20-lmstudio-fallback-design.md`
- `docs/superpowers/plans/2026-04-20-lmstudio-fallback.md`

### Modifiziert
- `paperclip-adapter-lmstudio/src/index.ts` (agentConfigurationDoc erweitert)
- `paperclip-adapter-lmstudio/src/server/index.ts` (Config-Schema um 3 Felder)
- `paperclip-adapter-lmstudio/src/server/execute.ts` (Heartbeat-Integration, +140 Zeilen)
- `paperclip-adapter-lmstudio/src/server/llm-client.ts` (typisierte Errors + probeEndpoint)
- `paperclip-adapter-lmstudio/tests/execute.test.ts` (Probe-Mocks für bestehende Tests)
- `paperclip-adapter-lmstudio/README.md` (Fallback-Abschnitt + Troubleshooting)

## Tests

**77/77 grün**, Build clean. Neu hinzugekommen:
- `llm-client-errors.test.ts` (6 Tests) — Fehler-Klassifikation
- `probe.test.ts` (5 Tests) — Health-Probe
- `endpoint-resolver.test.ts` (6 Tests) — Entscheidungs-Logik
- `fallback.test.ts` (9 Tests) — End-to-End State-Machine

## Commits auf master (nach Merge)

```
 Merge branch 'feature/lmstudio-fallback'
 docs(adapter-lmstudio): document fallback endpoint configuration
 refactor(adapter-lmstudio): preserve token usage and cap retry timeout
 refactor(adapter-lmstudio): re-add fallback probe in mid-call switch for fail-fast
 feat(adapter-lmstudio): primary/fallback endpoint with health-probe + sticky switch
 feat(adapter-lmstudio): endpoint-resolver decides primary vs fallback
 feat(adapter-lmstudio): add probeEndpoint() for fallback health checks
 refactor(adapter-lmstudio): tighten error classification heuristics
 feat(adapter-lmstudio): typed LlmClientError (network/model/timeout/unknown)
 feat(adapter-lmstudio): add fallback config fields
```

## Offene Punkte

### Noch zu tun
- **Paperclip-Server neu starten** (z.B. via `~/Desktop/n8n.sh`), damit der neue Adapter-Code geladen wird.
- **Manuelle Verifikation (Task 7)** mit echtem LM Studio durch Walter:
  1. Agent mit `fallbackUrl`/`fallbackModel` konfigurieren
  2. Windows aus → Run über Mac, Meta-Event im Transcript sichtbar
  3. Windows an → Run über Windows, kein Meta-Event
  4. Beide aus → Run failed mit `errorCode: "llm_unreachable"`
  5. Windows während Run abstürzen → Mid-Call-Switch, Meta-Event
- **Worktree aufräumen:** `.worktrees/lmstudio-fallback/` kann nach erfolgreicher manueller Verifikation per `git worktree remove .worktrees/lmstudio-fallback && git branch -d feature/lmstudio-fallback` entfernt werden.

### Bekannte Follow-ups (aus Final-Review, nicht blockierend)
- **Stream-Pfad ohne Fallback-Hook:** Der finale `streamChatCompletion`-Call (Repeat der Antwort) hat keinen Mid-Call-Switch. Fällt Primary zwischen Loop-Ende und Stream aus, greift stillschweigend die nicht-gestreamte Version als Fallback — funktional ok, nur kein Meta-Event.
- **Doku-Lücken (pre-existing):** `maxRunSeconds`, `allowedWriteRoots`, `instructionsFilePath` fehlen in der README-Tabelle und in `agentConfigurationDoc`. Nicht durch dieses Feature verursacht.

## Konfiguration für Walter

Beispiel-Agent-Config:

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

- `fallbackUrl` leer → kein Fallback (Backward-Compatibility: bestehende Agenten laufen unverändert).
- `fallbackModel` leer → Fallback nutzt denselben Namen wie Primary-Modell.
