# Per-Task Modell-Router — Design

- **Datum:** 2026-06-14
- **Status:** Spec, genehmigt zur Planung
- **Andockpunkt:** Heartbeat (`server/src/services/heartbeat.ts`), bestehende
  `modelProfile`-Maschinerie (`resolveModelProfileApplication`)
- **Scope:** `lmstudio_local`-Agenten mit Qwen-Default über alle drei Companies

## Zweck

Pro Aufgabe zur Laufzeit das passende lokale Modell wählen: das schnelle
**Gemma** (`gemma-4-31b-it-mlx`) für triviale Tasks, das Reasoning-**Qwen**
(`qwen3.6-35b-a3b-mlx`) wenn die Aufgabe es braucht. Ziel ist **echtes Routing**
— Qualität *und* Durchsatz/RAM zugleich optimieren — ohne neuen
Schaltmechanismus zu erfinden.

Abgrenzung zum **Nightly LLM Advisor** (`2026-06-14-nightly-llm-advisor-design.md`):
Der Advisor entscheidet *langsam, nachts, mit Walter im Loop* über die **feste**
Modellzuweisung pro Agent. Dieser Router entscheidet *zur Laufzeit, pro Aufgabe*,
ob das Default-Modell oder das `cheap`-Profil läuft. Die beiden ergänzen sich.

## Architektur

Der Router wird im Heartbeat eingehängt, dort wo der Wake-Context gebaut und
`resolveModelProfileApplication` aufgerufen wird (heartbeat.ts ~Zeile 7004). Er
**erfindet keinen neuen Schaltmechanismus** — er füttert nur das schon
existierende `cheap`-Modellprofil mit einer automatischen Entscheidung. Umschalten,
Fallback und Run-Metadaten existieren bereits.

```
Heartbeat baut Wake-Context für Agent X
   │
   ├─ Hat das Issue schon manuell ein modelProfile?  ──ja──▶ respektieren, Router aus
   │                                                  nein
   ├─▶ [Router] Phase-1-Regeln  (Rolle · Issue-Label · Wake-Grund · Prompt-Länge)
   │      ├─ sicher TRIVIAL  ──▶ modelProfile = "cheap" (Gemma)
   │      ├─ sicher HART     ──▶ default (Qwen)
   │      └─ unklar ──▶ [Phase-2] Mini-Klassifikator (warmes Gemma) ──▶ cheap | default
   │
   ├─▶ resolveModelProfileApplication(requested=router-Ergebnis, requestedBy="auto_router")
   │      → bestehende Maschinerie wendet Gemma-Config an ODER bleibt bei Qwen
   │
   └─▶ Run-Metadata: { requested, applied, requestedBy:"auto_router", routerReason }
```

### Voraussetzung — `cheap`-Profil pro Agent (einmalige DB-Maßnahme)

Jeder Qwen-Default-`lmstudio_local`-Agent bekommt in `agents.adapter_config` ein:

```json
"modelProfiles": { "cheap": { "enabled": true,
  "adapterConfig": { "model": "gemma-4-31b-it-mlx" } } }
```

Der Default-`model` bleibt Qwen. `readAgentRuntimeModelProfile` liest genau dieses
`runtimeConfig.modelProfiles`, daher reicht die Per-Agent-Config (kein
Adapter-Registry-Eintrag nötig — der lmstudio-Adapter ist Plugin-basiert und steht
nicht in `server/src/adapters/registry.ts`). Sweep analog zu früheren
Fleet-Durchläufen, über **alle drei Companies**.

**Scope-Gate:** Nur Agenten mit Qwen-Default. Gemma-/Coder-Default-Agenten
(kreativ/PR/Coding) sind schon schnell und bleiben unangetastet.

### Modell-Budget

Beide Zielmodelle sind in LM Studio bereits **gleichzeitig resident**
(Gemma 33,8 GB + Qwen 37,7 GB, plus qwen-coder-14b 15,7 GB + Embedding,
zusammen ~88 GB unter dem 110-GB-Limit). **Modellwechsel = null Ladezeit**, nur
ein anderer `model`-String beim Dispatch.

## Komponenten

### Phase-1-Regeln (deterministisch, null Latenz)

Entscheiden „runter auf Gemma?" aus Signalen, die beim Dispatch schon vorliegen.
Liefern `cheap` / `default` / `unklar`; nur **eindeutige** Fälle entscheiden hier.

| Signal | → Gemma (cheap) | → Qwen (default) |
|---|---|---|
| **Wake-Grund** | leerer Heartbeat / Status-Check / Routine-Tick | neues substantielles Issue |
| **Issue-Label/Typ** | `digest`, `summarize`, `classify`, `notify`, `format` | `design`, `debug`, `plan`, `code`, `recovery` |
| **Prompt-Länge** | sehr kurz (< Schwelle) | lang / viele Kontext-Dokumente |
| **Fehler-Historie des Issues** | — | hatte schon `max_iterations`/Timeout → **nie** cheap (Anti-Loop) |

### Phase-2-Klassifikator (nur bei „unklar")

Ein-Wort-Prompt gegen das warme Gemma (oder optional ein gepinntes Mini-Modell
1–3B als RAM-günstigere Alternative):

> „Braucht diese Aufgabe mehrschrittiges Reasoning/Coding (REASONING) oder ist sie
> einfache Abfrage/Formatierung/Klassifikation (FAST)?"

Ergebnis **pro Issue-ID gecacht**, damit nicht jeder Heartbeat neu klassifiziert.

## Sicherheit

1. **Kill-Switch:** Env-Flag / Company-Setting → Router komplett aus, alles fällt
   auf Default-Qwen zurück.
2. **Anti-Loop:** Issues mit Fehler-Historie (`max_iterations`/Timeout) werden nie
   heruntergeroutet.
3. **Fail-safe Richtung:** Default ist immer Qwen — jeder Router-Fehler/Timeout
   landet auf dem stärkeren Modell, nie umgekehrt.
4. **Scope-Gate:** Nur Qwen-Default-Agenten; Gemma-/Coder-Default-Agenten
   unangetastet.

## Observability

Run-Metadata trägt schon `modelProfile{requested, applied, requestedBy,
fallbackReason}`. Ergänzung: `requestedBy:"auto_router"` + `routerReason`. Walter
sieht pro Run, **warum** welches Modell lief. Optional: eine Zeile im bestehenden
Nightly-Digest mit der Cheap/Default-Verteilung.

## Phasen

- **Phase 1:** Regeln + `cheap`-Profil-Sweep + Kill-Switch + Metadaten.
  Sofort nutzbar.
- **Phase 2:** Mini-Klassifikator für die „unklar"-Fälle.
- **Phase 3 (optional, später):** Self-Escalation — ein cheap-Run, der
  `max_iterations`/Fehler trifft, wird automatisch auf Qwen neu dispatcht; ggf.
  dritter Pfad „Coding → qwen-coder-14b".

## Nicht-Ziele (v1)

- Keine neuen `MODEL_PROFILE_KEYS` außer `cheap` (binär Qwen↔Gemma).
- Keine automatische Modell-Installation oder Adapter-Änderung.
- Kein Routing für Cloud-/`claude_local`-Agenten.
- Keine Self-Escalation in v1 (Phase 3).

## Verifizierte Fakten (Planungsgrundlage)

- **Hook-Override:** `BeforeAdapterExecuteResult.runtimeConfig` wird vor
  `adapter.execute` shallow-gemerged — Modell-Override technisch möglich (Ansatz A).
  Gewählt wurde dennoch der Heartbeat-Weg (Ansatz B), weil dort der Aufgabentext
  schon vorliegt und die `modelProfile`-Observability frei mitkommt.
- **modelProfiles:** `MODEL_PROFILE_KEYS = ["cheap"]`
  (`packages/shared/src/constants.ts`); `resolveModelProfileApplication` /
  `readAgentRuntimeModelProfile` / Run-Metadata in `heartbeat.ts` existieren und
  werden wiederverwendet.
- **Modelle resident:** `lms ps` zeigt Gemma + Qwen + qwen-coder-14b gleichzeitig
  geladen (~88 GB < 110 GB).
- **Modell-Zuweisung:** `agents.adapter_config->>'model'` (Default) +
  `adapter_config.modelProfiles.cheap.adapterConfig.model` (Gemma).

## Offene Punkte für die Planung

- Konkrete Schwellwerte (Prompt-Länge) und die finale Label→Klasse-Tabelle als
  Fixtures im Plan.
- Wahl Klassifikator-Modell: warmes Gemma vs. gepinntes Mini-Modell (Budget vs.
  Latenz) — im Plan entscheiden.
- Cache-Ort für Klassifikator-Ergebnisse pro Issue-ID.
