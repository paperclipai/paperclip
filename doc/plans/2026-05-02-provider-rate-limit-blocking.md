# Plan: Per-Provider Rate-Limit Blocking mit Modell-Granularität

## Kontext

Wenn Claude oder Codex ein hartes Limit erreicht (5h-Limit, weekly-Limit), bricht der Agent-Run mit einem Fehler ab. Das aktuelle Transient-Retry-System wartet und versucht es erneut — was bei echten Limit-Hits sinnlos ist. Es gibt keine Möglichkeit, nur Codex-Agenten zu blockieren, während Claude-Agenten weiterlaufen. Es fehlt eine manuelle Freigabe und eine automatische Wiederaufnahme.

**Inspiration**: [paperless-ai #767](https://github.com/clusterzx/paperless-ai/issues/767) — keine Backoff-Strategie, kein UI-Feedback, keine automatische Wiederherstellung.

**Verwandte offene Issues** in [paperclipai/paperclip](https://github.com/paperclipai/paperclip):
- **#4876** — Pre-fire budget gate für Routinen (gleiches Muster, dort für Credit-Balance)
- **#4965** — Company-level Budget-Cap + idle-skip
- **#4752** — Fallback zu anderem Adapter wenn einer ausfällt (zukünftige Erweiterung, nicht Teil dieses Plans)

Kein bestehendes Issue zu Provider Rate-Limit-Blocking gefunden — dieses Feature ist neu.

**Abgrenzung zum Budget-System**: Budgets kontrollieren *Ausgaben* (billed_cents). Provider Rate Limits kontrollieren *Verfügbarkeit* (Token-Fenster). Beide Gates sind orthogonal.

### Modell-Granularität (Recherche-Ergebnis)

**Agenten sind in Paperclip auf Modell-Ebene konfigurierbar** — der Nutzer wählt in der UI exakt das Modell (`claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-6` etc.) über `adapterConfig.model`. Modell-granulares Blocking macht daher vollständig Sinn.

Verfügbare Claude-Modelle: `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`
Quelle: `packages/adapters/claude-local/src/index.ts`

| Provider | Quota-Fenster | `modelFamily` für Block |
|----------|--------------|------------------------|
| **Claude** `five_hour` | Global — alle Modelle | `null` |
| **Claude** `seven_day` | Global — alle Modelle | `null` |
| **Claude** `seven_day_sonnet` | Nur Sonnet | `"claude-sonnet"` |
| **Claude** `seven_day_opus` | Nur Opus | `"claude-opus"` |
| **Claude** `extra_usage` | Global — alle Modelle | `null` |
| **Codex** alle Fenster | Account-global | `null` |

**Haiku**: Kein separates `seven_day_haiku`-Fenster in der Quota-API → Haiku fällt unter `seven_day` (global). Ein Haiku-Agent wird nur geblockt, wenn das globale 5h- oder 7d-Limit erschöpft ist.

→ Wenn das Opus-Weekly-Limit voll ist: nur `claude-opus-*`-Agenten pausieren, Sonnet-/Haiku-Agenten laufen weiter.

---

## Was existiert bereits (Wiederverwendung)

| Was | Datei | Zweck |
|-----|-------|-------|
| `getQuotaWindows()` | `claude-local/src/server/quota.ts`, `codex-local/src/server/quota.ts` | Quota lesen — bereits implementiert |
| `fetchAllQuotaWindows()` | `server/src/services/quota-windows.ts` | Aggregation aller Adapter |
| `getInvocationBlock()` | `server/src/services/budgets.ts:716` | Bestehender Dispatch-Gate |
| `pauseScopeForBudget()` / `resumeScopeFromBudget()` | `server/src/services/budgets.ts:213` | Vorhandenes Pause-Muster — wir folgen exakt dem gleichen Muster |
| `PAUSE_REASONS` | `packages/shared/src/constants.ts` | Bereits "manual", "budget", "system" — wir erweitern |
| `extractClaudeRetryNotBefore()` | `claude-local/src/server/quota.ts` | Parst Reset-Zeit aus Fehlermeldung |
| `CLAUDE_TRANSIENT_UPSTREAM_RE` | `claude-local/src/server/parse.ts` | Bestehende Fehlerklassifikation |
| Transient-Retry-Delays `[2m, 10m, 30m, 2h]` | `server/src/services/heartbeat.ts:174` | Bleibt für echte Transient-Fehler |

---

## Implementierung

### Schritt 1 — DB-Schema: `provider_rate_limit_blocks`

**Neue Datei** `packages/db/src/schema/provider_rate_limit_blocks.ts`:

```ts
{
  id: uuid PK,
  companyId: uuid FK companies,
  adapterType: text,          // "claude_local" | "codex_local" | ...
  limitKind: text,            // "five_hour" | "seven_day" | "seven_day_sonnet" | "seven_day_opus" | "extra_usage" | "weekly" | "credits" | "generic"
  modelFamily: text nullable, // "claude-opus" | "claude-sonnet" | null (null = alle Modelle dieses Adapters)
  message: text nullable,     // Originale Fehlermeldung
  resetsAt: timestamptz nullable,  // null = unbekannt, sonst: automatische Freigabe
  resolvedAt: timestamptz nullable,
  resolvedBy: text nullable,  // "system" | "manual:<userId>"
  createdAt: timestamptz,
  updatedAt: timestamptz
}
```

Unique-Constraint: `(companyId, adapterType, limitKind, modelFamily)` — verhindert Duplikate.

**Migration**: `packages/db/src/migrations/` — neue SQL-Datei.

**Shared Types** `packages/shared/src/types/provider_rate_limit.ts`:
```ts
ProviderRateLimitBlock { id, companyId, adapterType, limitKind, modelFamily, message, resetsAt, resolvedAt, resolvedBy, createdAt }
```

**Konstanten** in `packages/shared/src/constants.ts`:
```ts
// Neuer Pause-Grund
export const PAUSE_REASONS = ["manual", "budget", "system", "provider_rate_limit"] as const;

// Limit-Arten
export const PROVIDER_LIMIT_KINDS = ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus", "extra_usage", "weekly", "credits", "generic"] as const;
```

---

### Schritt 2 — Fehlerklassifikation: Hard Limit vs. Transient

**Datei**: `packages/adapters/claude-local/src/server/parse.ts`

Neues Regex `CLAUDE_HARD_LIMIT_RE` (kein Retry sinnvoll, sofort als Hard-Limit behandeln):
- `out of extra usage`, `usage limit reached`, `5-hour limit reached`, `weekly limit reached`
- Diese Muster aus `CLAUDE_TRANSIENT_UPSTREAM_RE` entfernen oder explizit ausklammern

**Datei**: `packages/adapters/codex-local/src/server/parse.ts`

Analoges `CODEX_HARD_LIMIT_RE`:
- `you've hit your usage limit for` (bereits in `CODEX_USAGE_LIMIT_RE` vorhanden, nur als Hard-Limit klassifizieren)

**Neues Feld** in `ParsedRunOutput` (oder `HeartbeatRunResult`) in `packages/adapter-utils/src/types.ts`:
```ts
rateLimitBlock?: {
  limitKind: string;   // welches Fenster (aus Fehlermeldung erschlossen)
  resetsAt?: string;   // ISO timestamp aus Fehlermeldung falls vorhanden
  message: string;
}
```

---

### Schritt 3 — Block erzeugen + `modelFamily` per Quota-Probe bestimmen

**Datei**: `server/src/services/heartbeat.ts` — Run-Error-Handler

Wenn ein Hard-Limit-Fehler erkannt wird:

```ts
if (parsedError.rateLimitBlock) {
  // Quota-Probe: welches Fenster ist erschöpft? → modelFamily ableiten
  const quotaResult = await getQuotaWindowsForAdapter(agent.adapterType);
  const { limitKind, modelFamily, resetsAt } = deriveBlockScope(quotaResult, parsedError.rateLimitBlock, agent);

  const block = await upsertProviderRateLimitBlock(db, {
    companyId: agent.companyId,
    adapterType: agent.adapterType,
    limitKind,
    modelFamily,   // z.B. "claude-opus" oder null
    message: parsedError.rateLimitBlock.message,
    resetsAt,
  });

  await pauseAgentsForProviderLimit(db, agent.companyId, agent.adapterType, modelFamily);
  // KEIN Transient-Retry → Run als "failed" markieren
}
```

**`deriveBlockScope()`** in `server/src/services/provider-rate-limits.ts`:
```ts
// Prüft welche Quota-Fenster bei 100% sind und leitet modelFamily ab:
// seven_day_opus  → { modelFamily: "claude-opus", limitKind: "seven_day_opus" }
// seven_day_sonnet → { modelFamily: "claude-sonnet", limitKind: "seven_day_sonnet" }
// five_hour / seven_day / extra_usage → { modelFamily: null, limitKind: "five_hour"|... }
// Codex: immer { modelFamily: null, limitKind: "weekly"|"five_hour"|"credits" }
```

---

### Schritt 4 — Agenten pausieren (modell-granular)

**Neue Funktion** `pauseAgentsForProviderLimit()` in `server/src/services/provider-rate-limits.ts`:

```ts
async function pauseAgentsForProviderLimit(
  db, companyId: string, adapterType: string, modelFamily: string | null
): Promise<void> {
  const filter = modelFamily
    // Modell-spezifisch: nur Agenten deren konfiguriertes Modell zur Familie passt
    ? and(
        eq(agents.companyId, companyId),
        eq(agents.adapterType, adapterType),
        sql`${agents.adapterConfig}->>'model' ILIKE ${modelFamily + '%'}`,
        inArray(agents.status, ["active", "idle", "running", "error"])
      )
    // Global: alle Agenten dieses Adapters
    : and(
        eq(agents.companyId, companyId),
        eq(agents.adapterType, adapterType),
        inArray(agents.status, ["active", "idle", "running", "error"])
      );

  await db.update(agents).set({
    status: "paused",
    pauseReason: "provider_rate_limit",
    pausedAt: new Date(),
    updatedAt: new Date(),
  }).where(filter);
}
```

**Folge-Kette** (bestehende Mechanismen greifen automatisch):
```
Agent pausiert (pauseReason="provider_rate_limit")
    ↓
Nächster Heartbeat-Run → cancelled ("agent is not invokable")  [heartbeat.ts:3974]
    ↓
releaseIssueExecutionAndPromote() → recoveryAgentInvokable=false
    ↓
shouldBlockImmediately=true
    ↓
Issue status → "blocked" + automatischer Comment mit Erklärung
```

---

### Schritt 5 — Dispatch-Gate erweitern

**Datei**: `server/src/services/budgets.ts` — Funktion `getInvocationBlock()`

Nach dem bestehenden Budget-Check, vor dem Return:

```ts
// Provider Rate-Limit Check
const model = agent.adapterConfig?.model as string | undefined;
const providerBlock = await getActiveProviderBlock(db, agent.companyId, agent.adapterType, model);
if (providerBlock) {
  // Live-Probe: ist das Limit schon abgelaufen?
  const quota = await getQuotaWindowsForAdapter(agent.adapterType);
  if (isStillBlocked(quota, providerBlock.limitKind)) {
    return {
      scopeType: "provider",
      scopeId: providerBlock.id,
      scopeName: agent.adapterType,
      reason: `Provider limit (${providerBlock.limitKind})${providerBlock.resetsAt ? ` — resets at ${providerBlock.resetsAt}` : ""}`,
    };
  }
  // Limit weggefallen → sofort auflösen
  await resolveAndResumeProviderBlock(db, providerBlock, "system");
}
```

**`getActiveProviderBlock()`** filtert per `(companyId, adapterType)` + prüft ob `modelFamily` zum aktuellen Agent-Modell passt:
- Block mit `modelFamily = null` → trifft immer zu (globaler Block)
- Block mit `modelFamily = "claude-opus"` → trifft nur zu wenn `agent.adapterConfig.model ILIKE 'claude-opus%'`

---

### Schritt 6 — Automatische Freigabe (Timer + Issue-Unblock)

**Datei**: `server/src/services/heartbeat.ts` — bestehender Tick-Loop

```ts
// Expired blocks auto-resolve (resetsAt < NOW() AND resolvedAt IS NULL)
const expired = await resolveExpiredProviderBlocks(db);
for (const block of expired) {
  await resumeAndUnblockForProviderLimit(db, block);
}
```

**`resumeAndUnblockForProviderLimit()`** in `server/src/services/provider-rate-limits.ts`:

```ts
async function resumeAndUnblockForProviderLimit(db, block: ProviderRateLimitBlock): Promise<void> {
  // 1. Agenten wieder aktivieren (nur provider_rate_limit-pausierte)
  const resumedAgents = await resumeAgentsForProviderLimit(db, block.companyId, block.adapterType, block.modelFamily);

  // 2. Issues auto-unblocking:
  //    Finde issues die NACH block.createdAt auf "blocked" gesetzt wurden
  //    UND deren assigneeAgentId zu einem gerade resumierten Agenten gehört
  for (const agent of resumedAgents) {
    await db.update(issues).set({
      status: "in_progress",
      blockedByIssueIds: [],
      updatedAt: new Date(),
    }).where(and(
      eq(issues.assigneeAgentId, agent.id),
      eq(issues.status, "blocked"),
      gte(issues.updatedAt, block.createdAt)   // nur Issues die nach dem Block geblockt wurden
    ));
  }
}
```

**Resume-Funktion** (gibt Liste resumierter Agenten zurück):
```ts
async function resumeAgentsForProviderLimit(db, companyId, adapterType, modelFamily): Promise<Agent[]> {
  // Gibt die tatsächlich geänderten Agenten zurück (für Issue-Unblock)
  // filtert NUR auf pauseReason = "provider_rate_limit" → stört manual/budget-Pausen nicht
}
```

---

### Schritt 7 — Manuelle Freigabe API

Neue Datei `server/src/routes/provider-rate-limits.ts`:

```
GET  /api/companies/:companyId/provider-rate-limits
     → aktive Blocks + betroffene Agenten-Anzahl

POST /api/companies/:companyId/provider-rate-limits/:id/release
     → setzt resolvedAt, resolvedBy, ruft resumeAndUnblockForProviderLimit() auf,
       macht danach eine Quota-Probe — wenn Limit immer noch aktiv: sofort neu blocken
```

---

### Schritt 8 — UI

**Wo**: Im bestehenden Quota-Windows-Panel.

**Was anzeigen**:
- Badge "GEBLOCKT" pro Fenster-Zeile wenn aktiver Block existiert
- Countdown bis `resetsAt` (oder "unbekannt")
- Welche Agenten betroffen sind (Anzahl + Modell-Familie)
- Button "Jetzt freigeben" → POST auf release-Endpoint
- Nach manueller Freigabe: Badge wechselt zu "Checking…" bis nächster Tick

---

## Gesamtablauf (Zusammenfassung)

```
1. Agent-Run schlägt mit Hard-Limit-Fehler fehl
       ↓
2. Quota-Probe → welches Fenster ist erschöpft? → modelFamily
       ↓
3. provider_rate_limit_blocks upsert (companyId, adapterType, limitKind, modelFamily, resetsAt)
       ↓
4. Alle betroffenen Agenten → status="paused", pauseReason="provider_rate_limit"
   (bei seven_day_opus nur Opus-Agenten, bei five_hour alle Claude-Agenten)
       ↓
5. Bestehende Recovery-Kette setzt in_progress-Issues auf "blocked"
       ↓
6a. Auto-Freigabe: resetsAt erreicht → resolveExpiredProviderBlocks() → Agenten resume → Issues unblock
6b. Manuelle Freigabe: POST /release → sofort + Quota-Probe → evtl. sofort neu blocken
       ↓
7. Agenten laufen wieder, Issues gehen zurück auf "in_progress"
```

---

## Kritische Dateien

| Datei | Änderung |
|-------|----------|
| `packages/db/src/schema/provider_rate_limit_blocks.ts` | NEU |
| `packages/db/src/migrations/*.sql` | NEU |
| `packages/shared/src/types/provider_rate_limit.ts` | NEU |
| `packages/shared/src/constants.ts` | +`"provider_rate_limit"` in PAUSE_REASONS, +PROVIDER_LIMIT_KINDS |
| `packages/adapters/claude-local/src/server/parse.ts` | +`CLAUDE_HARD_LIMIT_RE` |
| `packages/adapters/codex-local/src/server/parse.ts` | +`CODEX_HARD_LIMIT_RE` |
| `packages/adapter-utils/src/types.ts` | +`rateLimitBlock` Feld in ParsedRunOutput |
| `server/src/services/provider-rate-limits.ts` | NEU — alle Service-Funktionen |
| `server/src/services/heartbeat.ts` | +Block erzeugen bei Hard-Limit + Auto-Resolve-Tick |
| `server/src/services/budgets.ts` | +`getInvocationBlock()` Provider-Check |
| `server/src/routes/provider-rate-limits.ts` | NEU — GET + POST /release |
| `client/src/...` | +UI-Badge + Release-Button im Quota-Panel |

---

## Nicht implementieren

- Kein Retry für Hard-Limit-Runs — sinnlos während Limit aktiv
- Keine neue preGate-Logik — gehört in `getInvocationBlock()`
- Kein Pausieren auf Company-Ebene — nur Agenten der betroffenen Modell-Familie

---

## Verifikation

1. **Unit**: `parse.test.ts` für Claude + Codex — Hard-Limit-Muster werden erkannt, Transient-Muster bleiben unverändert
2. **Unit**: `deriveBlockScope()` — Opus-Limit → modelFamily="claude-opus", 5h-Limit → modelFamily=null
3. **Integration**: Simulierter Hard-Limit-Fehler → Block angelegt → nur Opus-Agenten pausiert → Sonnet-Agenten laufen → nach `resetsAt`: Agenten + Issues auto-resumed
4. **Manuell**:
   - Claude Opus-Agent mit simuliertem `seven_day_opus`-Limit → nur Opus-Agenten pausieren, Sonnet läuft weiter
   - "Jetzt freigeben" → Quota-Probe → wenn noch geblockt: sofort neu geblockt (kein falsches Resumed)
   - `resetsAt` abwarten → Auto-Resolve → Agenten + geblockte Issues werden automatisch reaktiviert
