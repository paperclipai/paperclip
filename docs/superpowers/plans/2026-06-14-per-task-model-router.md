# Per-Task Modell-Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pro Aufgabe zur Laufzeit zwischen Qwen (Reasoning, Default) und Gemma (schnell, via bestehendem `cheap`-Profil) wählen — entschieden durch einen Hybrid-Router (Regeln + optionalem Klassifikator), eingehängt im Heartbeat.

**Architecture:** Eine **pure Router-Funktion** (`routeModelProfile`) entscheidet aus gesammelten Signalen `cheap | default`. Der Heartbeat sammelt die Signale (Wake-Grund, Issue-Priorität/Herkunft, Prompt-Länge, Fehler-Historie), ruft den Router und füttert dessen Ergebnis in die **bestehende** `resolveModelProfileApplication`-Maschinerie. Default ist immer Qwen — jeder Fehler/Zweifel fällt sicher dorthin zurück.

**Tech Stack:** TypeScript, Node, Drizzle ORM (Postgres `localhost:54329`), Vitest, LM Studio (`localhost:1234`, OpenAI-kompatibel).

---

## Verifizierte Grundlagen (vor Beginn lesen)

- **Injektionsstelle:** `server/src/services/heartbeat.ts:7004` — Aufruf von `resolveModelProfileApplication(...)`. Direkt davor sind `context` (= contextSnapshot mit `wakeReason`/`issueId`), `agent` (mit `.runtimeConfig`, `.adapterType`, `.companyId`), `run` (mit `.id`) und `config` (mit `.model`) in Scope.
- **`resolveModelProfileApplication`** liegt in `heartbeat.ts:1048-1110`. Typen `ModelProfileApplication` / `ModelProfileRequestSource` in `heartbeat.ts:962-972`. `MODEL_PROFILE_KEYS = ["cheap"]` in `packages/shared/src/constants.ts:78`.
- **GOTCHA:** `listAdapterModelProfiles("lmstudio_local")` liefert `[]` (Plugin-Adapter, nicht in `server/src/adapters/registry.ts`). Daher MUSS Task 2 erlauben, dass ein nur in `agent.runtimeConfig.modelProfiles` definiertes Profil auch ohne Adapter-Registry-Eintrag angewandt wird.
- **`heartbeat_runs`** (`packages/db/src/schema/heartbeat_runs.ts`): `errorCode` (text), `companyId`, `contextSnapshot ->> 'issueId'`. Reale Error-Codes: `max_iterations`, `timeout`, `llm_error`, `adapter_failed`, `process_lost`.
- **`issues`** (`packages/db/src/schema/issues.ts`): `title`, `description`, `priority` (`low|medium|high|urgent`), `originKind` (`manual|detector|...`). **Kein** `labels`/`kind`-Feld — Regeln nutzen `priority` + `originKind`.
- **Bekannte substantielle Wake-Gründe:** `issue_assigned`, `execution_review_requested`, `execution_approval_requested`, `execution_changes_requested` (siehe `heartbeat.ts:1562-1565`).
- **Testmuster:** Vitest in `server/src/__tests__/`, Beispiel `heartbeat-model-profile.test.ts`. Tests laufen mit `cd server && npx vitest run <pfad>`.

---

## Task 1: Pure Router-Funktion (Phase-1-Regeln)

**Files:**
- Create: `server/src/services/model-router.ts`
- Test: `server/src/__tests__/model-router.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/model-router.test.ts
import { describe, expect, it } from "vitest";
import { routeModelProfile, type ModelRouterSignals } from "../services/model-router.ts";

const base: ModelRouterSignals = {
  wakeReason: null,
  issuePriority: null,
  issueOriginKind: null,
  promptChars: 50,
  hasBlockingErrorHistory: false,
  classifierVerdict: null,
};

describe("routeModelProfile (Phase 1 rules)", () => {
  it("forces Qwen (default) when the issue has blocking error history (anti-loop)", () => {
    const d = routeModelProfile({ ...base, hasBlockingErrorHistory: true, promptChars: 10 });
    expect(d.profile).toBeNull();
    expect(d.reason).toBe("error_history");
    expect(d.needsClassifier).toBe(false);
  });

  it("keeps Qwen for substantive wake reasons", () => {
    const d = routeModelProfile({ ...base, wakeReason: "issue_assigned", promptChars: 10 });
    expect(d.profile).toBeNull();
    expect(d.reason).toBe("substantive_wake_reason");
  });

  it("keeps Qwen for high/urgent priority", () => {
    expect(routeModelProfile({ ...base, issuePriority: "urgent", promptChars: 10 }).profile).toBeNull();
    expect(routeModelProfile({ ...base, issuePriority: "high", promptChars: 10 }).profile).toBeNull();
  });

  it("downgrades to cheap for a short non-substantive task", () => {
    const d = routeModelProfile({ ...base, wakeReason: "routine_tick", promptChars: 80 });
    expect(d.profile).toBe("cheap");
    expect(d.reason).toBe("short_non_substantive");
    expect(d.needsClassifier).toBe(false);
  });

  it("downgrades short detector-origin notifications to cheap", () => {
    const d = routeModelProfile({ ...base, issueOriginKind: "detector", promptChars: 120 });
    expect(d.profile).toBe("cheap");
  });

  it("flags long ambiguous tasks for the classifier and stays on Qwen meanwhile", () => {
    const d = routeModelProfile({ ...base, wakeReason: "issue_comment_mentioned", promptChars: 4000 });
    expect(d.profile).toBeNull();
    expect(d.needsClassifier).toBe(true);
    expect(d.reason).toBe("inconclusive");
  });

  it("uses a provided classifier verdict over needsClassifier", () => {
    expect(routeModelProfile({ ...base, promptChars: 4000, classifierVerdict: "fast" }).profile).toBe("cheap");
    expect(routeModelProfile({ ...base, promptChars: 4000, classifierVerdict: "reasoning" }).profile).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/model-router.test.ts`
Expected: FAIL — `Cannot find module '../services/model-router.ts'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/services/model-router.ts
import type { ModelProfileKey } from "@paperclipai/shared";

/** Signals gathered at dispatch time. Pure data — no DB/IO here. */
export interface ModelRouterSignals {
  /** contextSnapshot.wakeReason, or null. */
  wakeReason: string | null;
  /** issues.priority: low|medium|high|urgent, or null. */
  issuePriority: string | null;
  /** issues.originKind: manual|detector|..., or null. */
  issueOriginKind: string | null;
  /** Length proxy = title + description characters. */
  promptChars: number;
  /** True if this issue already hit a blocking error (anti-loop). */
  hasBlockingErrorHistory: boolean;
  /** Phase-2 classifier verdict, or null when rules run alone. */
  classifierVerdict?: "reasoning" | "fast" | null;
}

export interface ModelRouterDecision {
  /** "cheap" => Gemma; null => keep the agent default (Qwen). */
  profile: ModelProfileKey | null;
  /** Machine-readable reason, surfaced in run metadata. */
  reason: string;
  /** True when rules are inconclusive and a classifier should decide (Phase 2). */
  needsClassifier: boolean;
}

/** Wake reasons that always indicate substantive, multi-step work. */
const SUBSTANTIVE_WAKE_REASONS = new Set([
  "issue_assigned",
  "execution_review_requested",
  "execution_approval_requested",
  "execution_changes_requested",
]);

/** Below this many chars a non-substantive task is confidently trivial. */
const PROMPT_SHORT_THRESHOLD = 600;

function isHighPriority(priority: string | null): boolean {
  return priority === "high" || priority === "urgent";
}

/**
 * Decide which model profile a task should use. Default is Qwen (profile=null);
 * only confidently-trivial tasks are downgraded to the "cheap" (Gemma) profile.
 * Pure and synchronous so it is fully unit-testable.
 */
export function routeModelProfile(signals: ModelRouterSignals): ModelRouterDecision {
  // 1. Anti-loop: never downgrade an issue that already failed hard.
  if (signals.hasBlockingErrorHistory) {
    return { profile: null, reason: "error_history", needsClassifier: false };
  }

  // 2. Substantive wake reason => reasoning model.
  if (signals.wakeReason && SUBSTANTIVE_WAKE_REASONS.has(signals.wakeReason)) {
    return { profile: null, reason: "substantive_wake_reason", needsClassifier: false };
  }

  // 3. High/urgent priority => reasoning model.
  if (isHighPriority(signals.issuePriority)) {
    return { profile: null, reason: "high_priority", needsClassifier: false };
  }

  // 4. An explicit classifier verdict (Phase 2) wins for everything below.
  if (signals.classifierVerdict === "fast") {
    return { profile: "cheap", reason: "classifier_fast", needsClassifier: false };
  }
  if (signals.classifierVerdict === "reasoning") {
    return { profile: null, reason: "classifier_reasoning", needsClassifier: false };
  }

  // 5. Confidently trivial: short prompt + non-substantive wake reason.
  if (signals.promptChars <= PROMPT_SHORT_THRESHOLD) {
    return { profile: "cheap", reason: "short_non_substantive", needsClassifier: false };
  }

  // 6. Long & ambiguous: stay on Qwen, but flag for the classifier (Phase 2).
  return { profile: null, reason: "inconclusive", needsClassifier: true };
}
```

> Note: the detector-origin test passes via rule 5 (120 chars ≤ 600). `originKind` is kept in the signal set for the classifier prompt and future rules; no separate branch needed yet.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/model-router.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/model-router.ts server/src/__tests__/model-router.test.ts
git commit -m "feat(model-router): pure Phase-1 routing rules (Qwen default, Gemma for trivial)"
```

---

## Task 2: `resolveModelProfileApplication` — Router-Quelle + runtime-only Profile

**Files:**
- Modify: `server/src/services/heartbeat.ts:962` (type `ModelProfileRequestSource`)
- Modify: `server/src/services/heartbeat.ts:965-972` (interface `ModelProfileApplication`)
- Modify: `server/src/services/heartbeat.ts:1048-1110` (`resolveModelProfileApplication`)
- Modify: `server/src/services/heartbeat.ts:1124-1135` (`modelProfileRunMetadata`)
- Test: `server/src/__tests__/heartbeat-model-profile.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to existing describe block)**

```typescript
// append inside server/src/__tests__/heartbeat-model-profile.test.ts
it("applies an agent-runtime-only cheap profile when the adapter declares none (lmstudio)", () => {
  const modelProfile = resolveModelProfileApplication({
    adapterModelProfiles: [], // plugin adapter => no registry profiles
    agentRuntimeConfig: {
      modelProfiles: { cheap: { enabled: true, adapterConfig: { model: "gemma-4-31b-it-mlx" } } },
    },
    issueModelProfile: null,
    contextSnapshot: {},
    routerModelProfile: "cheap",
    routerReason: "short_non_substantive",
  });
  expect(modelProfile.applied).toBe("cheap");
  expect(modelProfile.requestedBy).toBe("auto_router");
  expect(modelProfile.routerReason).toBe("short_non_substantive");
  expect(modelProfile.configSource).toBe("agent_runtime");
  expect(modelProfile.adapterConfig).toMatchObject({ model: "gemma-4-31b-it-mlx" });
});

it("lets an explicit issue override win over the router decision", () => {
  const modelProfile = resolveModelProfileApplication({
    adapterModelProfiles: [],
    agentRuntimeConfig: {
      modelProfiles: { cheap: { enabled: true, adapterConfig: { model: "gemma-4-31b-it-mlx" } } },
    },
    issueModelProfile: "cheap",
    contextSnapshot: {},
    routerModelProfile: null,
    routerReason: null,
  });
  expect(modelProfile.requestedBy).toBe("issue_override");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/heartbeat-model-profile.test.ts`
Expected: FAIL — `routerModelProfile` not accepted / `requestedBy` is not `"auto_router"`.

- [ ] **Step 3a: Extend the source type (heartbeat.ts:962)**

```typescript
type ModelProfileRequestSource = "issue_override" | "wake_context" | "auto_router";
```

- [ ] **Step 3b: Add `routerReason` to the application interface (heartbeat.ts:965-972)**

```typescript
export interface ModelProfileApplication {
  requested: ModelProfileKey | null;
  requestedBy: ModelProfileRequestSource | null;
  applied: ModelProfileKey | null;
  configSource: AppliedModelProfileConfigSource | null;
  fallbackReason: string | null;
  adapterConfig: Record<string, unknown> | null;
  routerReason: string | null;
}
```

- [ ] **Step 3c: Rewrite `resolveModelProfileApplication` (heartbeat.ts:1048-1110)**

```typescript
export function resolveModelProfileApplication(input: {
  adapterModelProfiles: AdapterModelProfileDefinition[];
  agentRuntimeConfig: unknown;
  issueModelProfile: ModelProfileKey | null | undefined;
  contextSnapshot: Record<string, unknown> | null | undefined;
  routerModelProfile?: ModelProfileKey | null;
  routerReason?: string | null;
  profileResolutionFallbackReason?: string | null;
}): ModelProfileApplication {
  const issueModelProfile = input.issueModelProfile ?? null;
  const contextModelProfile = readContextModelProfile(input.contextSnapshot);
  const routerModelProfile = input.routerModelProfile ?? null;
  const requested = issueModelProfile ?? contextModelProfile ?? routerModelProfile;
  const requestedBy: ModelProfileRequestSource | null = issueModelProfile
    ? "issue_override"
    : contextModelProfile
      ? "wake_context"
      : routerModelProfile
        ? "auto_router"
        : null;
  const routerReason = requestedBy === "auto_router" ? input.routerReason ?? null : null;

  const empty = {
    requested: null,
    requestedBy: null,
    applied: null,
    configSource: null,
    fallbackReason: null,
    adapterConfig: null,
    routerReason: null,
  } satisfies ModelProfileApplication;

  if (!requested) return empty;

  const runtimeProfile = readAgentRuntimeModelProfile(input.agentRuntimeConfig, requested);
  const adapterProfile = input.adapterModelProfiles.find((profile) => profile.key === requested) ?? null;

  // Neither the adapter registry nor the agent runtime defines this profile.
  if (!adapterProfile && !runtimeProfile.configured) {
    return {
      ...empty,
      requested,
      requestedBy,
      routerReason,
      fallbackReason: input.profileResolutionFallbackReason ?? "adapter_profile_not_supported",
    };
  }

  if (!runtimeProfile.enabled) {
    return {
      ...empty,
      requested,
      requestedBy,
      routerReason,
      fallbackReason: "agent_runtime_profile_disabled",
    };
  }

  return {
    requested,
    requestedBy,
    applied: requested,
    configSource: runtimeProfile.configured ? "agent_runtime" : "adapter_default",
    fallbackReason: null,
    routerReason,
    adapterConfig: {
      ...parseObject(adapterProfile?.adapterConfig),
      ...runtimeProfile.adapterConfig,
    },
  };
}
```

- [ ] **Step 3d: Surface `routerReason` in metadata (heartbeat.ts:1124-1135)**

```typescript
function modelProfileRunMetadata(
  modelProfile: ModelProfileApplication,
): Record<string, unknown> | null {
  if (!modelProfile.requested) return null;
  return {
    requested: modelProfile.requested,
    requestedBy: modelProfile.requestedBy,
    applied: modelProfile.applied,
    configSource: modelProfile.configSource,
    fallbackReason: modelProfile.fallbackReason,
    ...(modelProfile.routerReason ? { routerReason: modelProfile.routerReason } : {}),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/__tests__/heartbeat-model-profile.test.ts`
Expected: PASS (existing tests + 2 new). If a pre-existing test constructs `ModelProfileApplication` literals, add `routerReason: null` to them.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/heartbeat.ts server/src/__tests__/heartbeat-model-profile.test.ts
git commit -m "feat(heartbeat): model-profile auto_router source + runtime-only profiles"
```

---

## Task 3: Signal-Sammler (DB) + Kill-Switch

**Files:**
- Create: `server/src/services/model-router-signals.ts`
- Test: `server/src/__tests__/model-router-signals.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/__tests__/model-router-signals.test.ts
import { describe, expect, it } from "vitest";
import { isModelRouterEnabled } from "../services/model-router-signals.ts";

describe("isModelRouterEnabled", () => {
  it("is disabled by default (opt-in rollout)", () => {
    expect(isModelRouterEnabled({})).toBe(false);
  });
  it("enables when PAPERCLIP_MODEL_ROUTER=on", () => {
    expect(isModelRouterEnabled({ PAPERCLIP_MODEL_ROUTER: "on" })).toBe(true);
  });
  it("stays disabled for any other value", () => {
    expect(isModelRouterEnabled({ PAPERCLIP_MODEL_ROUTER: "off" })).toBe(false);
    expect(isModelRouterEnabled({ PAPERCLIP_MODEL_ROUTER: "1" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/model-router-signals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```typescript
// server/src/services/model-router-signals.ts
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";

/** Kill-switch: router is opt-in. Default OFF for safe rollout. */
export function isModelRouterEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env.PAPERCLIP_MODEL_ROUTER === "on";
}

/** Error codes that mean "this issue spun / failed hard" — never downgrade it. */
const BLOCKING_ERROR_CODES = ["max_iterations", "timeout", "adapter_failed"];

/**
 * True if this issue produced a blocking error in the recent past. Drives the
 * anti-loop rule: a struggling issue must stay on the strong model.
 */
export async function hasBlockingErrorHistoryForIssue(input: {
  db: Db;
  companyId: string;
  issueId: string;
  sinceDaysAgo?: number;
}): Promise<boolean> {
  const days = input.sinceDaysAgo ?? 7;
  const rows = await input.db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        inArray(heartbeatRuns.errorCode, BLOCKING_ERROR_CODES),
        gt(heartbeatRuns.createdAt, sql`now() - (${days} || ' days')::interval`),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/model-router-signals.test.ts`
Expected: PASS (3 tests).

> The `hasBlockingErrorHistoryForIssue` query is exercised end-to-end in Task 4's manual verification (it needs a live DB); the unit test covers the pure kill-switch.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/model-router-signals.ts server/src/__tests__/model-router-signals.test.ts
git commit -m "feat(model-router): kill-switch + anti-loop error-history signal"
```

---

## Task 4: Wiring im Heartbeat (Phase 1 live)

**Files:**
- Modify: `server/src/services/heartbeat.ts` (imports near top; dispatch block at `:6987-7014`)

- [ ] **Step 1: Add imports (top of heartbeat.ts, with the other service imports)**

```typescript
import { routeModelProfile, type ModelRouterDecision } from "./model-router.js";
import { hasBlockingErrorHistoryForIssue, isModelRouterEnabled } from "./model-router-signals.js";
```

- [ ] **Step 2: Compute the router decision before the resolve call (insert just before `:7004`, after the `adapterModelProfiles` try/catch at `:7003`)**

```typescript
    // --- Per-task model router (Phase 1: rules only). Opt-in via env. ---
    let routerDecision: ModelRouterDecision = { profile: null, reason: "router_disabled", needsClassifier: false };
    const cheapProfileConfigured =
      readAgentRuntimeModelProfile(agent.runtimeConfig, "cheap").configured;
    const routerApplies =
      isModelRouterEnabled(process.env) &&
      agent.adapterType === "lmstudio_local" &&
      cheapProfileConfigured &&
      !(issueAssigneeOverrides?.modelProfile); // manual override wins, skip router
    if (routerApplies) {
      const routerIssueId = readNonEmptyString(context.issueId);
      const hasBlockingErrorHistory = routerIssueId
        ? await hasBlockingErrorHistoryForIssue({
            db,
            companyId: agent.companyId,
            issueId: routerIssueId,
          })
        : false;
      const promptChars =
        (readNonEmptyString(context.issueTitle)?.length ?? 0) +
        (readNonEmptyString(context.issueDescription)?.length ?? 0);
      routerDecision = routeModelProfile({
        wakeReason: readNonEmptyString(context.wakeReason),
        issuePriority: readNonEmptyString(context.issuePriority),
        issueOriginKind: readNonEmptyString(context.issueOriginKind),
        promptChars,
        hasBlockingErrorHistory,
        classifierVerdict: null, // Phase 2 fills this in (Task 6)
      });
    }
```

> If `context.issueTitle`/`issueDescription`/`issuePriority`/`issueOriginKind` are not already populated in the contextSnapshot at this point, load them once from the `issues` row by `routerIssueId` (pattern: `heartbeat.ts:1293`) and read from that row instead. Verify which fields exist in `context` during Step 4 and adjust the reads accordingly — do not invent fields.

- [ ] **Step 3: Pass the decision into `resolveModelProfileApplication` (`:7004-7010`)**

```typescript
    const modelProfileApplication = resolveModelProfileApplication({
      adapterModelProfiles,
      agentRuntimeConfig: agent.runtimeConfig,
      issueModelProfile: issueAssigneeOverrides?.modelProfile ?? null,
      contextSnapshot: context,
      routerModelProfile: routerDecision.profile,
      routerReason: routerDecision.reason,
      profileResolutionFallbackReason,
    });
```

- [ ] **Step 4: Typecheck + run the full heartbeat test suite**

Run: `cd server && npx tsc --noEmit && npx vitest run src/__tests__/heartbeat-model-profile.test.ts src/__tests__/model-router.test.ts src/__tests__/model-router-signals.test.ts`
Expected: PASS, no type errors. Fix any `context.*` field names that don't exist (see Step 2 note).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/heartbeat.ts
git commit -m "feat(heartbeat): wire per-task model router (Phase 1, opt-in)"
```

---

## Task 5: `cheap`-Profil-Sweep für Qwen-Default-Agenten

**Files:**
- Create: `scripts/seed-cheap-model-profile.mjs`

- [ ] **Step 1: Write the idempotent seed script**

```javascript
// scripts/seed-cheap-model-profile.mjs
// Sets adapter_config.modelProfiles.cheap.adapterConfig.model = gemma for every
// lmstudio_local agent whose DEFAULT model is a Qwen reasoning model, across all
// companies. Idempotent: re-running makes no change once seeded.
import pg from "pg";

const CHEAP_MODEL = "gemma-4-31b-it-mlx";
const client = new pg.Client({ connectionString: "postgres://paperclip:paperclip@localhost:54329/paperclip" });

function isQwenDefault(model) {
  return typeof model === "string" && model.toLowerCase().startsWith("qwen3");
}

await client.connect();
const { rows } = await client.query(
  `SELECT id, name, company_id, adapter_config FROM agents WHERE adapter_type = 'lmstudio_local'`,
);

let changed = 0;
for (const row of rows) {
  const cfg = row.adapter_config ?? {};
  if (!isQwenDefault(cfg.model)) continue;
  const existing = cfg.modelProfiles?.cheap?.adapterConfig?.model;
  if (existing === CHEAP_MODEL) continue;
  const next = {
    ...cfg,
    modelProfiles: {
      ...(cfg.modelProfiles ?? {}),
      cheap: { enabled: true, adapterConfig: { model: CHEAP_MODEL } },
    },
  };
  await client.query(`UPDATE agents SET adapter_config = $1 WHERE id = $2`, [next, row.id]);
  console.log(`seeded cheap profile: ${row.name} (${row.company_id})`);
  changed += 1;
}
console.log(`done. ${changed} agent(s) updated, ${rows.length} lmstudio_local agent(s) scanned.`);
await client.end();
```

- [ ] **Step 2: Dry-check the candidate set first (read-only)**

Run:
```bash
psql postgres://paperclip:paperclip@localhost:54329/paperclip -c \
"SELECT name, company_id, adapter_config->>'model' AS model, adapter_config->'modelProfiles'->'cheap'->'adapterConfig'->>'model' AS cheap FROM agents WHERE adapter_type='lmstudio_local' ORDER BY company_id;"
```
Expected: lists all lmstudio_local agents with their default model and current cheap profile (mostly NULL before seeding). Confirm the Qwen-default ones are the intended targets.

- [ ] **Step 3: Run the seed script**

Run: `node scripts/seed-cheap-model-profile.mjs`
Expected: prints one line per seeded agent, then a summary. Running it a second time prints `0 agent(s) updated` (idempotent).

- [ ] **Step 4: Verify**

Run the same `psql` query from Step 2.
Expected: every Qwen-default lmstudio_local agent now shows `cheap = gemma-4-31b-it-mlx`.

- [ ] **Step 5: Commit**

```bash
git add scripts/seed-cheap-model-profile.mjs
git commit -m "chore(model-router): idempotent seed of cheap (Gemma) profile for Qwen agents"
```

---

## Task 6 (Phase 2): Mini-Klassifikator für unklare Tasks

> Defer until Phase 1 has run in production for a few days. Implements the `needsClassifier` branch.

**Files:**
- Create: `server/src/services/model-router-classifier.ts`
- Test: `server/src/__tests__/model-router-classifier.test.ts`
- Modify: `server/src/services/heartbeat.ts` (Task 4 Step 2 block)

- [ ] **Step 1: Write the failing test (parsing + cache, with injected fetch)**

```typescript
// server/src/__tests__/model-router-classifier.test.ts
import { describe, expect, it, vi } from "vitest";
import { classifyTaskComplexity, __resetClassifierCache } from "../services/model-router-classifier.ts";

function fakeFetch(content: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }),
  );
}

describe("classifyTaskComplexity", () => {
  it("maps a FAST verdict and caches it per issueId", async () => {
    __resetClassifierCache();
    const fetchImpl = fakeFetch("FAST");
    const args = { issueId: "i1", title: "Send digest", description: "", baseUrl: "http://x", model: "gemma", fetchImpl };
    expect(await classifyTaskComplexity(args)).toBe("fast");
    expect(await classifyTaskComplexity(args)).toBe("fast"); // cached
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps a REASONING verdict", async () => {
    __resetClassifierCache();
    const r = await classifyTaskComplexity({ issueId: "i2", title: "Debug race", description: "", baseUrl: "http://x", model: "gemma", fetchImpl: fakeFetch("REASONING") });
    expect(r).toBe("reasoning");
  });

  it("defaults to reasoning (safe) on unparseable output", async () => {
    __resetClassifierCache();
    const r = await classifyTaskComplexity({ issueId: "i3", title: "x", description: "", baseUrl: "http://x", model: "gemma", fetchImpl: fakeFetch("¯\\_(ツ)_/¯") });
    expect(r).toBe("reasoning");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/__tests__/model-router-classifier.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```typescript
// server/src/services/model-router-classifier.ts
const cache = new Map<string, "reasoning" | "fast">();

/** Test-only: clear the per-issue verdict cache. */
export function __resetClassifierCache(): void {
  cache.clear();
}

const PROMPT = (title: string, description: string) =>
  `Classify the task. Answer with exactly one word: REASONING if it needs multi-step reasoning, planning, coding or debugging; FAST if it is simple retrieval, formatting, summarizing or classification.\n\nTitle: ${title}\nDetails: ${description}`.slice(0, 4000);

/**
 * Ask a small warm model whether a task needs reasoning. Fails safe to
 * "reasoning" on any error/ambiguity. Cached per issueId.
 */
export async function classifyTaskComplexity(input: {
  issueId: string;
  title: string;
  description: string;
  baseUrl: string; // e.g. http://localhost:1234/v1
  model: string;   // e.g. gemma-4-31b-it-mlx
  fetchImpl?: typeof fetch;
}): Promise<"reasoning" | "fast"> {
  const cached = cache.get(input.issueId);
  if (cached) return cached;

  const doFetch = input.fetchImpl ?? fetch;
  let verdict: "reasoning" | "fast" = "reasoning"; // safe default
  try {
    const res = await doFetch(`${input.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        max_tokens: 4,
        messages: [{ role: "user", content: PROMPT(input.title, input.description) }],
      }),
    });
    if (res.ok) {
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const word = (json.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
      if (word.startsWith("FAST")) verdict = "fast";
      else if (word.startsWith("REASONING")) verdict = "reasoning";
    }
  } catch {
    verdict = "reasoning";
  }
  cache.set(input.issueId, verdict);
  return verdict;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/__tests__/model-router-classifier.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into heartbeat (replace the `classifierVerdict: null` line in Task 4 Step 2)**

```typescript
      let classifierVerdict: "reasoning" | "fast" | null = null;
      const ruleOnly = routeModelProfile({
        wakeReason: readNonEmptyString(context.wakeReason),
        issuePriority: readNonEmptyString(context.issuePriority),
        issueOriginKind: readNonEmptyString(context.issueOriginKind),
        promptChars,
        hasBlockingErrorHistory,
        classifierVerdict: null,
      });
      if (ruleOnly.needsClassifier && routerIssueId) {
        const cheapCfg = readAgentRuntimeModelProfile(agent.runtimeConfig, "cheap").adapterConfig;
        const classifierModel = typeof cheapCfg.model === "string" ? cheapCfg.model : "gemma-4-31b-it-mlx";
        const baseUrl = `${String(config.url ?? "http://localhost:1234").replace(/\/+$/, "")}/v1`;
        classifierVerdict = await classifyTaskComplexity({
          issueId: routerIssueId,
          title: readNonEmptyString(context.issueTitle) ?? "",
          description: readNonEmptyString(context.issueDescription) ?? "",
          baseUrl,
          model: classifierModel,
        });
      }
      routerDecision = routeModelProfile({
        wakeReason: readNonEmptyString(context.wakeReason),
        issuePriority: readNonEmptyString(context.issuePriority),
        issueOriginKind: readNonEmptyString(context.issueOriginKind),
        promptChars,
        hasBlockingErrorHistory,
        classifierVerdict,
      });
```

Add the import: `import { classifyTaskComplexity } from "./model-router-classifier.js";`

- [ ] **Step 6: Typecheck + commit**

Run: `cd server && npx tsc --noEmit && npx vitest run src/__tests__/model-router-classifier.test.ts`
Expected: PASS, no type errors.

```bash
git add server/src/services/model-router-classifier.ts server/src/__tests__/model-router-classifier.test.ts server/src/services/heartbeat.ts
git commit -m "feat(model-router): Phase 2 classifier for ambiguous tasks (fail-safe to reasoning)"
```

---

## Rollout & Verifikation (nach Phase 1)

1. Seed-Skript laufen lassen (Task 5), Kandidaten prüfen.
2. `PAPERCLIP_MODEL_ROUTER=on` in der Server-Umgebung setzen (launchd `ing.paperclip.dev` Env / `.zshrc`-Quelle), Server neu starten (`launchctl kickstart -k`).
3. Einen Tag laufen lassen, dann in `heartbeat_runs.result_json -> 'modelProfile'` prüfen, wie oft `requestedBy='auto_router'` mit `applied='cheap'` vs. `null` auftritt und ob `routerReason` plausibel ist.
4. Kill-Switch testen: `PAPERCLIP_MODEL_ROUTER=off` → alle Runs zurück auf Qwen-Default.

---

## Self-Review-Notiz (vom Plan-Autor)

- **Spec-Abdeckung:** Architektur/Datenfluss → Task 4; Phase-1-Regeln → Task 1; Phase-2-Klassifikator → Task 6; `cheap`-Profil-Voraussetzung → Task 5 (+ Task 2 macht runtime-only Profile überhaupt anwendbar); Kill-Switch/Anti-Loop/Fail-safe/Scope-Gate → Tasks 1+3+4; Observability (`requestedBy:auto_router`, `routerReason`) → Task 2.
- **Offener Verifikationspunkt für den Implementierer:** Welche `issue*`-Felder bereits in `context` (contextSnapshot) liegen vs. aus der `issues`-Zeile nachzuladen sind (Task 4, Step 2 Note). Nicht raten — beim Verdrahten prüfen.
