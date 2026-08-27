# OpenAI/Codex Subscription-Calls als API-Token in USD bepreisen

**Datum:** 2026-06-13
**Status:** Design genehmigt

## Problem

Läuft der `codex-local`-Adapter (`provider: "openai"`) ohne `OPENAI_API_KEY`,
authentifiziert er über OAuth/Subscription. In diesem Fall:

- setzt der Adapter `billingType = "subscription"` →
  `normalizeLedgerBillingType()` mappt das auf `"subscription_included"`,
- meldet die Codex-CLI **kein** `costUsd` (`result.costUsd = null`),
- gibt `normalizeBilledCostCents()` (`server/src/services/heartbeat.ts:1713`)
  bei `subscription_included` hart `0` zurück.

Ergebnis: Es entsteht zwar ein Cost-Event mit Tokenzahlen, aber `costCents = 0`.
Die OpenAI-Nutzung taucht nicht in den USD-Summen / API-Statistiken auf, obwohl
sie reale API-äquivalente Kosten verursacht.

Zusätzlich liefert der Parser kein Modell zurück: `result.model` ist
`config.model` und bei Default-Subscription-Runs leer (`""`). Die CLI fährt dann
intern **gpt-5.5**.

## Ziel

OpenAI-Runs unter Subscription/OAuth mit echten OpenAI-API-Preisen in USD
bepreisen und als `metered_api` verbuchen, sodass sie auf der Costs-Seite wie
echte API-Calls erscheinen. Andere Provider (Claude etc.) bleiben unberührt.

## Scope-Entscheidungen

- **Nur OpenAI/Codex** (`provider === "openai"`). Claude-Subscription bleibt 0.
- **Hardcodierte Preistabelle** im Server-Code (kein ENV-Config).
- **Verbuchung als `metered_api`** (billingType wird überschrieben), damit die
  Calls in API-Statistiken und USD-Summen erscheinen.
- Greift **nur**, wenn kein positiver `costUsd` gemeldet wurde — ein vom Adapter
  echt gemeldeter Preis wird niemals überschrieben.

## Preistabelle (USD pro 1M Token, Stand OpenAI Juni 2026)

| Modell-Key                          | Input | Cached | Output |
|-------------------------------------|-------|--------|--------|
| `gpt-5.5` (Batch, = Fallback)       | 2.50  | 0.25   | 15.00  |
| `gpt-5.4`                           | 2.50  | 0.25   | 15.00  |
| `gpt-5.3-codex` / `gpt-5.2-codex`   | 2.00  | 0.20   | 14.00  |
| `gpt-5`                             | 1.25  | 0.125  | 10.00  |
| `gpt-5-mini`                        | 0.25  | 0.025  | 2.00   |
| `gpt-5-nano`                        | 0.05  | 0.005  | 0.40   |
| `o3`                                | 2.00  | 0.50   | 8.00   |
| `o4-mini` / `o3-mini`               | 1.10  | 0.275  | 4.40   |

- `gpt-5.5` nutzt den **Batch-Preis** (50 % Rabatt auf 5.00/0.50/30.00), da der
  Subscription-Default-Run als gpt-5.5 läuft.
- **Fallback** für leeres/unbekanntes OpenAI-Modell = `gpt-5.5`-Batch-Preis
  (deckt den häufigsten Subscription-Fall ab).
- Cached-Werte ohne offizielle Angabe = 10 % des Input-Preises
  (OpenAI-Standard-Cache-Rabatt).
- Werte sind als Konstante im Code jederzeit anpassbar.

## Komponenten

### 1. `server/src/services/openai-pricing.ts` (neu)

```ts
export interface TokenUsage {
  model?: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

// USD pro 1M Token
export const OPENAI_TOKEN_PRICING: Record<string, {
  input: number; cached: number; output: number;
}>;

export const OPENAI_PRICING_FALLBACK_KEY = "gpt-5.5";

// Liefert gerundete Cents oder 0, wenn keine Tokens.
export function priceOpenAiUsageCents(usage: TokenUsage): number;
```

Berechnung:
- Modell-Match per **Longest-Prefix** über die Keys (sortiert nach Länge
  absteigend), damit `gpt-5.3-codex-spark` → `gpt-5.3-codex` greift.
- Leeres/unbekanntes Modell → Fallback-Key.
- `uncachedInput = max(0, inputTokens − cachedInputTokens)`.
- `usd = uncachedInput/1e6·input + cachedInputTokens/1e6·cached
        + outputTokens/1e6·output`.
- `cents = max(0, round(usd · 100))`.

### 2. `server/src/services/heartbeat.ts` (Eingriff)

Neuer Helper:

```ts
function resolveOpenAiSubscriptionBilling(
  result: AdapterExecutionResult,
  usage: UsageTotals | null,
  billingType: BillingType,
  baseCostCents: number,
): { costCents: number; billingType: BillingType; biller: string } | null
```

Greift nur, wenn:
- `result.provider === "openai"`,
- `billingType` ∈ `{subscription_included, subscription_overage}`,
- `baseCostCents <= 0` (kein echt gemeldeter Preis),
- berechnete Cents `> 0`.

Dann: `{ costCents, billingType: "metered_api", biller: "openai" }`, sonst `null`.

Eingebaut in `updateRuntimeState` — den **einzigen** Cost-Event-Pfad
(`costs.createEvent`). Dort werden `additionalCostCents`, `billingType` und
`biller` aus dem Override gesetzt, sodass auch `agentRuntimeState.totalCostCents`
die korrigierten Cents nutzt und das Cost-Event als `metered_api` gebucht wird.

Hinweis: Der `usageJson`-Block der `heartbeatRuns`-Zeile (~9186) ist reine
Anzeige-Metadaten des Runs (nicht der Cost-Event) und bleibt bewusst beim echten
Auth-Billing-Type (`subscription_included`) — das beschreibt korrekt, wie der Run
authentifiziert war.

## Datenfluss

```
codex-local (OAuth, kein OPENAI_API_KEY)
  → result { provider: "openai", billingType: "subscription",
             costUsd: null, model: "" | "gpt-5.x", usage }
  → heartbeat.updateRuntimeState
      billingType = subscription_included
      baseCostCents = normalizeBilledCostCents(null, ...) = 0
      override = resolveOpenAiSubscriptionBilling(...)
        → priceOpenAiUsageCents(usage) > 0
        → { costCents, billingType: metered_api, biller: openai }
  → costs.createEvent({ billingType: metered_api, costCents, ... })
  → Costs-Seite zählt USD + API-Call
```

## Fehlerbehandlung / Edge Cases

- Keine Tokens → `priceOpenAiUsageCents` = 0 → kein Override, Verhalten wie bisher.
- Adapter meldet echten `costUsd` → `baseCostCents > 0` → kein Override.
- Nicht-OpenAI-Provider → kein Override.
- `metered_api`-Run (API-Key gesetzt) → Subscription-Bedingung greift nicht.

## Tests (TDD)

`server/src/__tests__/openai-pricing.test.ts`:
- exaktes Modell-Match (gpt-5.5, gpt-5, gpt-5-mini, o3, o4-mini).
- Prefix-Match (`gpt-5.3-codex-spark` → codex-Preis).
- Fallback bei leerem/unbekanntem Modell = gpt-5.5-Batch.
- Cached-Token-Abzug korrekt (input − cached).
- 0 Tokens → 0 Cents.
- Rundung auf Cents.

`server/src/__tests__/costs-service.test.ts` (oder heartbeat-Test):
- OpenAI + subscription_included + costUsd=null → metered_api + Cents>0.
- OpenAI + metered_api → unverändert.
- OpenAI + subscription + echtem costUsd → kein Override.
- Claude + subscription → unverändert (0).

## Nicht im Scope

- ENV-konfigurierbare Preise.
- Anthropic/andere Provider.
- UI-Änderungen (Costs-Seite zeigt metered_api bereits korrekt an).
- Rückwirkende Neuberechnung bestehender Cost-Events.
