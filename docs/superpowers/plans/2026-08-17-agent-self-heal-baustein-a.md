# Agent-Selbstheilung — Baustein A (Wächter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kein Agent bleibt nach einer transienten LLM-Störung dauerhaft in `status='error'` liegen — ein Wächter im 30-s-Scheduler klassifiziert, prüft die Endpoint-Gesundheit und belebt wieder oder eskaliert ursachengerecht.

**Architecture:** Reine Entscheidungsfunktionen (Klassifikation, Politik, Eskalationsziel) getrennt von einem dünnen IO-Runner — dem Muster von `successful-run-handoff.ts` folgend, das im Recovery-Bereich etabliert ist. Ein Versuchs-Ledger in Postgres verhindert Wiederbelebungsstürme. Der Runner hängt im bestehenden `setInterval` in `server/src/index.ts:722`.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres (embedded, Port 54329), vitest.

**Spec:** `docs/superpowers/specs/2026-07-24-agent-self-heal-design.md`

## Global Constraints

- **Klassifikation primär über `heartbeat_runs.error_code`**, nicht über Regex auf `last_error`. Das Feld ist strukturiert und gepflegt; Textabgleich nur als Rückfall, wenn `error_code` null ist. (Abweichung von §3.2 der Spec — begründet in „Abweichungen" unten.)
- Der Wächter rührt **ausschliesslich** Agenten mit `status='error'` an. Niemals gesunde, niemals `paused`/`terminated`/`pending_approval`.
- Wiederbelebung läuft über `agentService.resume(id)` (`server/src/services/agents.ts:459`) und `heartbeat.wakeup(agentId, opts)` — **niemals** ein direkter `UPDATE agents SET status`. Roh-Inserts in `agent_wakeup_requests` werden nicht eingesammelt (`enqueueWakeup` verarbeitet beim Einfügen).
- Jede Aktion nach `activity_log` mit `action: "agent.self_heal.<verb>"`.
- Not-Aus: `AGENT_SELF_HEAL_ENABLED=false` + `launchctl kickstart -k gui/501/ing.paperclip.dev`.
- **Watch-Baum-Regel:** jede Änderung an `server/src/**` startet den launchd-Dienst neu und tötet laufende Agentenläufe. Vor jedem Commit prüfen: `select count(*) from heartbeat_runs where status='running'` muss 0 sein.
- Migrationsnummer fortlaufend; höchste vorhandene ist `0083`.

## Abweichungen von der Spec (24 Tage alt, Fehlerlage hat sich verschoben)

Gemessen am 17.08. über 7 Tage (`heartbeat_runs`, `failed`/`timed_out`):

| `error_code` | Anzahl | Klasse |
|---|---:|---|
| `claude_transient_upstream` | 182 | `infra_transient` |
| `llm_unreachable` | 83 | `infra_transient` |
| `max_iterations` | 44 | `convergence` |
| `adapter_failed` | 29 | `unknown` |
| `llm_error` | 16 | `infra_transient` |
| `timeout` | 13 | `infra_transient` |
| `process_lost` | 7 | `infra_transient` |
| `claude_auth_required` | 4 | `deterministic` |

1. **`claude_transient_upstream` ist der häufigste Ausfall und fehlt in der Spec vollständig.** Anthropic drosselt (`Server is temporarily limiting requests`). Gehört nach `infra_transient`, braucht aber ein **anderes Health-Gate** als LM Studio: kein `/v1/models`-Listing möglich, also Zeit-Cooldown statt Endpoint-Ping.
2. **Die PII-`400`/`blocked`-Klasse (148× in der Spec) ist auf 0 gefallen.** Kein eigener Zweig nötig; der `deterministic`-Pfad deckt sie ab, falls sie zurückkommt.
3. **`max_iterations` von 171 auf 44 gefallen** — bleibt relevant, ist aber nicht mehr die Hauptlast.
4. **`process_lost` neu aufgenommen** (Dienst-Neustart tötet laufende Läufe) — eindeutig transient, sofort wiederbelebbar.

## File Structure

| Datei | Verantwortung |
|---|---|
| `packages/db/src/schema/agent_self_heal_ledger.ts` | Drizzle-Tabelle für das Versuchs-Ledger |
| `packages/db/src/migrations/0084_*.sql` | generierte Migration |
| `server/src/services/recovery/agent-self-heal-classify.ts` | **rein:** `error_code`/Text → Fehlerklasse |
| `server/src/services/recovery/agent-self-heal-classify.test.ts` | Tests dazu |
| `server/src/services/recovery/agent-self-heal-policy.ts` | **rein:** Klasse + Ledger + Health → Aktion; Cooldown; Eskalationsziel mit Manager-tot-Schutz |
| `server/src/services/recovery/agent-self-heal-policy.test.ts` | Tests dazu |
| `server/src/services/recovery/agent-self-heal.ts` | IO-Runner: Scan, Health-Probe, Ledger schreiben, resume/wakeup, activity_log |
| `server/src/services/recovery/agent-self-heal.test.ts` | Integrationstest mit gemockten Seams |
| `server/src/config.ts` | vier neue Flags |
| `server/src/index.ts` | Einhängen in den 30-s-Tick |

---

### Task 1: Fehlerklassifikation (rein)

**Files:**
- Create: `server/src/services/recovery/agent-self-heal-classify.ts`
- Test: `server/src/services/recovery/agent-self-heal-classify.test.ts`

**Interfaces:**
- Consumes: nichts.
- Produces: `type SelfHealErrorClass = "infra_transient" | "convergence" | "deterministic" | "unknown"` und `classifySelfHealError(input: { errorCode: string | null; errorText: string | null }): SelfHealErrorClass`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { classifySelfHealError } from "./agent-self-heal-classify.js";

describe("classifySelfHealError — nach error_code", () => {
  it.each([
    ["claude_transient_upstream", "infra_transient"],
    ["llm_unreachable", "infra_transient"],
    ["timeout", "infra_transient"],
    ["process_lost", "infra_transient"],
    ["llm_error", "infra_transient"],
    ["max_iterations", "convergence"],
    ["claude_auth_required", "deterministic"],
    ["adapter_failed", "unknown"],
  ])("ordnet %s als %s ein", (code, expected) => {
    expect(classifySelfHealError({ errorCode: code, errorText: null })).toBe(expected);
  });

  it("bevorzugt error_code gegenueber widersprechendem Text", () => {
    expect(
      classifySelfHealError({ errorCode: "max_iterations", errorText: "fetch failed" }),
    ).toBe("convergence");
  });
});

describe("classifySelfHealError — Rueckfall auf den Fehlertext", () => {
  it.each([
    ["LLM network error: ECONNREFUSED (fetch failed)", "infra_transient"],
    ["LLM call timed out: The operation was aborted due to timeout", "infra_transient"],
    ["Failed to load model: insufficient system resources", "infra_transient"],
    ["Max iterations (8) reached without final answer", "convergence"],
    ["400 Bad Request: content was blocked", "deterministic"],
    ["Expecting value: line 1 column 1 (parse error)", "deterministic"],
    ["could not authenticate", "deterministic"],
  ])("ordnet %j als %s ein", (text, expected) => {
    expect(classifySelfHealError({ errorCode: null, errorText: text })).toBe(expected);
  });

  it("faellt bei voelliger Unkenntnis auf unknown zurueck", () => {
    expect(classifySelfHealError({ errorCode: null, errorText: "irgendwas neues" })).toBe("unknown");
    expect(classifySelfHealError({ errorCode: null, errorText: null })).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal-classify.test.ts`
Expected: FAIL — `Cannot find module './agent-self-heal-classify.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * Ordnet den Ausgang eines gescheiterten Heartbeat-Runs einer Fehlerklasse zu.
 *
 * Primaerquelle ist `heartbeat_runs.error_code` — ein gepflegtes, strukturiertes
 * Feld. Der Textabgleich ist nur der Rueckfall fuer Laeufe ohne Code (aeltere
 * Zeilen, Fremdadapter).
 */
export type SelfHealErrorClass =
  | "infra_transient"
  | "convergence"
  | "deterministic"
  | "unknown";

/** Gemessene Verteilung siehe Plan-Abschnitt „Abweichungen von der Spec". */
const CLASS_BY_ERROR_CODE: Record<string, SelfHealErrorClass> = {
  claude_transient_upstream: "infra_transient",
  llm_unreachable: "infra_transient",
  llm_error: "infra_transient",
  timeout: "infra_transient",
  process_lost: "infra_transient",
  max_iterations: "convergence",
  claude_auth_required: "deterministic",
  // adapter_failed bleibt bewusst ungenannt: der Code deckt sowohl transiente
  // als auch deterministische Ursachen ab, also konservativ als unknown
  // behandeln (eskalieren statt blind wiederholen).
};

const INFRA_TEXT = /fetch failed|timed?\s*out|timeout|insufficient (system )?resources|econnreset|econnrefused|socket hang up|temporarily limiting/i;
const CONVERGENCE_TEXT = /max iterations/i;
const DETERMINISTIC_TEXT = /\b400\b|blocked|parse|authenticate/i;

export function classifySelfHealError(input: {
  errorCode: string | null;
  errorText: string | null;
}): SelfHealErrorClass {
  if (input.errorCode) {
    return CLASS_BY_ERROR_CODE[input.errorCode] ?? "unknown";
  }
  const text = input.errorText ?? "";
  if (!text) return "unknown";
  if (CONVERGENCE_TEXT.test(text)) return "convergence";
  if (INFRA_TEXT.test(text)) return "infra_transient";
  if (DETERMINISTIC_TEXT.test(text)) return "deterministic";
  return "unknown";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal-classify.test.ts`
Expected: PASS (13 Tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/recovery/agent-self-heal-classify.ts server/src/services/recovery/agent-self-heal-classify.test.ts
git commit -m "feat(self-heal): Fehlerklassifikation ueber error_code"
```

---

### Task 2: Versuchs-Ledger (Tabelle + Migration)

**Files:**
- Create: `packages/db/src/schema/agent_self_heal_ledger.ts`
- Modify: `packages/db/src/schema/index.ts` (Export ergänzen)
- Create: `packages/db/src/migrations/0084_*.sql` (generiert)

**Interfaces:**
- Consumes: `SelfHealErrorClass` aus Task 1 (nur als Wertebereich der Spalte, kein Import — die Spalte ist `text`).
- Produces: `agentSelfHealLedger` mit den Feldern `id, agentId, companyId, errorClass, errorFingerprint, attemptCount, lastAction, nextEligibleAt, resolvedAt, createdAt, updatedAt`.

- [ ] **Step 1: Schema-Datei schreiben**

```typescript
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * Versuchs-Ledger der Agenten-Selbstheilung.
 *
 * Eine offene Zeile pro (Agent, Fehler-Fingerprint) haelt fest, wie oft schon
 * wiederbelebt oder eskaliert wurde und ab wann der naechste Versuch erlaubt
 * ist. Ohne dieses Gate wuerde der 30-s-Tick einen Wiederbelebungssturm
 * erzeugen.
 */
export const agentSelfHealLedger = pgTable(
  "agent_self_heal_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    errorClass: text("error_class").notNull(),
    errorFingerprint: text("error_fingerprint").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAction: text("last_action"),
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentOpenIdx: index("agent_self_heal_ledger_agent_open_idx").on(table.agentId, table.resolvedAt),
    // Genau eine OFFENE Zeile je Agent und Stoerung; abgeschlossene Zeilen
    // bleiben als Historie liegen.
    openFingerprintIdx: uniqueIndex("agent_self_heal_ledger_open_fingerprint_idx")
      .on(table.agentId, table.errorFingerprint)
      .where(sql`resolved_at is null`),
  }),
);
```

- [ ] **Step 2: `sql`-Import ergänzen und Export eintragen**

In der Schema-Datei oben `import { sql } from "drizzle-orm";` hinzufügen (für die partielle Unique-Bedingung). Dann in `packages/db/src/schema/index.ts` die Zeile einfügen, alphabetisch bei den `agent_*`-Exporten:

```typescript
export * from "./agent_self_heal_ledger.js";
```

- [ ] **Step 3: Migration generieren**

Run: `pnpm --filter @paperclipai/db generate`
Expected: neue Datei `packages/db/src/migrations/0084_<name>.sql` mit `CREATE TABLE "agent_self_heal_ledger"` und dem partiellen Unique-Index.

- [ ] **Step 4: Migration prüfen und einspielen**

Run: `pnpm --filter @paperclipai/db migrate`
Dann verifizieren:

```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -c "\d agent_self_heal_ledger"
```

Expected: Tabelle existiert, `agent_self_heal_ledger_open_fingerprint_idx` ist als partieller Unique-Index sichtbar (`WHERE (resolved_at IS NULL)`).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/agent_self_heal_ledger.ts packages/db/src/schema/index.ts packages/db/src/migrations/
git commit -m "feat(self-heal): Versuchs-Ledger als Tabelle"
```

---

### Task 3: Fingerprint und Cooldown (rein)

**Files:**
- Create: `server/src/services/recovery/agent-self-heal-policy.ts`
- Test: `server/src/services/recovery/agent-self-heal-policy.test.ts`

**Interfaces:**
- Consumes: `SelfHealErrorClass` aus Task 1.
- Produces: `buildErrorFingerprint(input: { errorCode: string | null; errorText: string | null }): string` und `computeNextEligibleAt(attemptCount: number, now: Date, baseCooldownMs: number): Date`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { buildErrorFingerprint, computeNextEligibleAt } from "./agent-self-heal-policy.js";

describe("buildErrorFingerprint", () => {
  it("nimmt den error_code, wenn vorhanden", () => {
    expect(buildErrorFingerprint({ errorCode: "llm_unreachable", errorText: "egal" }))
      .toBe("code:llm_unreachable");
  });

  it("normalisiert wechselnde Zahlen und Zeitangaben im Text weg", () => {
    const a = buildErrorFingerprint({ errorCode: null, errorText: "Max iterations (8) reached after 12.4s" });
    const b = buildErrorFingerprint({ errorCode: null, errorText: "Max iterations (12) reached after 91.7s" });
    expect(a).toBe(b);
  });

  it("unterscheidet verschiedene Stoerungen", () => {
    const a = buildErrorFingerprint({ errorCode: null, errorText: "fetch failed" });
    const b = buildErrorFingerprint({ errorCode: null, errorText: "could not authenticate" });
    expect(a).not.toBe(b);
  });

  it("liefert einen stabilen Wert ohne jede Information", () => {
    expect(buildErrorFingerprint({ errorCode: null, errorText: null })).toBe("unknown");
  });
});

describe("computeNextEligibleAt — exponentiell 5/15/60 min", () => {
  const now = new Date("2026-08-17T12:00:00.000Z");
  const base = 300_000;

  it.each([
    [0, "2026-08-17T12:05:00.000Z"],
    [1, "2026-08-17T12:15:00.000Z"],
    [2, "2026-08-17T13:00:00.000Z"],
  ])("Versuch %i wartet bis %s", (attempts, expected) => {
    expect(computeNextEligibleAt(attempts, now, base).toISOString()).toBe(expected);
  });

  it("deckelt den Backoff bei 60 Minuten", () => {
    expect(computeNextEligibleAt(9, now, base).toISOString()).toBe("2026-08-17T13:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal-policy.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { SelfHealErrorClass } from "./agent-self-heal-classify.js";

/** Backoff-Stufen in Vielfachen des Basis-Cooldowns: 5 min → 15 min → 60 min. */
const BACKOFF_MULTIPLIERS = [1, 3, 12] as const;

/**
 * Stabiler Schluessel je Stoerung. Zweck: dieselbe Stoerung darf das Ledger
 * nicht mit neuen Zeilen fluten, nur weil eine Iterationszahl oder Laufzeit im
 * Fehlertext wechselt.
 */
export function buildErrorFingerprint(input: {
  errorCode: string | null;
  errorText: string | null;
}): string {
  if (input.errorCode) return `code:${input.errorCode}`;
  const text = input.errorText;
  if (!text) return "unknown";
  const normalized = text
    .toLowerCase()
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return `text:${normalized}`;
}

/** Wann der naechste Versuch fuer diese Stoerung erlaubt ist. */
export function computeNextEligibleAt(
  attemptCount: number,
  now: Date,
  baseCooldownMs: number,
): Date {
  const index = Math.min(Math.max(attemptCount, 0), BACKOFF_MULTIPLIERS.length - 1);
  return new Date(now.getTime() + baseCooldownMs * BACKOFF_MULTIPLIERS[index]);
}

export type { SelfHealErrorClass };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal-policy.test.ts`
Expected: PASS (8 Tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/recovery/agent-self-heal-policy.ts server/src/services/recovery/agent-self-heal-policy.test.ts
git commit -m "feat(self-heal): Fingerprint und exponentieller Cooldown"
```

---

### Task 4: Entscheidungsfunktion (rein)

**Files:**
- Modify: `server/src/services/recovery/agent-self-heal-policy.ts`
- Modify: `server/src/services/recovery/agent-self-heal-policy.test.ts`

**Interfaces:**
- Consumes: `SelfHealErrorClass`, `computeNextEligibleAt`.
- Produces:
  ```typescript
  type SelfHealAction =
    | { kind: "revive" }
    | { kind: "wait_endpoint_down" }
    | { kind: "wait_cooldown" }
    | { kind: "escalate_manager" }
    | { kind: "escalate_human"; reason: string }
    | { kind: "skip"; reason: string };

  function decideSelfHeal(input: {
    errorClass: SelfHealErrorClass;
    agentStatus: string;
    endpointHealthy: boolean | null;   // null = nicht pruefbar (claude_local)
    attemptCount: number;
    nextEligibleAt: Date | null;
    now: Date;
    maxInfraRevives: number;
  }): SelfHealAction;
  ```

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { decideSelfHeal } from "./agent-self-heal-policy.js";

const base = {
  errorClass: "infra_transient" as const,
  agentStatus: "error",
  endpointHealthy: true as boolean | null,
  attemptCount: 0,
  nextEligibleAt: null as Date | null,
  now: new Date("2026-08-17T12:00:00.000Z"),
  maxInfraRevives: 3,
};

describe("decideSelfHeal — Schutzgitter", () => {
  it.each(["idle", "running", "paused", "terminated", "pending_approval"])(
    "ruehrt einen Agenten in %s nicht an",
    (status) => {
      expect(decideSelfHeal({ ...base, agentStatus: status }).kind).toBe("skip");
    },
  );

  it("wartet, solange der Cooldown laeuft", () => {
    const action = decideSelfHeal({
      ...base,
      nextEligibleAt: new Date("2026-08-17T12:05:00.000Z"),
    });
    expect(action.kind).toBe("wait_cooldown");
  });

  it("handelt, sobald der Cooldown abgelaufen ist", () => {
    const action = decideSelfHeal({
      ...base,
      nextEligibleAt: new Date("2026-08-17T11:59:00.000Z"),
    });
    expect(action.kind).toBe("revive");
  });
});

describe("decideSelfHeal — infra_transient", () => {
  it("belebt wieder, wenn das Endpoint gesund ist", () => {
    expect(decideSelfHeal(base).kind).toBe("revive");
  });

  it("wartet, wenn das Endpoint down ist", () => {
    expect(decideSelfHeal({ ...base, endpointHealthy: false }).kind).toBe("wait_endpoint_down");
  });

  it("belebt auch, wenn die Gesundheit nicht pruefbar ist (claude_local)", () => {
    expect(decideSelfHeal({ ...base, endpointHealthy: null }).kind).toBe("revive");
  });

  it("gibt nach MAX_INFRA_REVIVES an den Menschen ab", () => {
    const action = decideSelfHeal({ ...base, attemptCount: 3 });
    expect(action).toEqual({ kind: "escalate_human", reason: "max_infra_revives_exhausted" });
  });
});

describe("decideSelfHeal — uebrige Klassen", () => {
  it("eskaliert convergence an den Vorgesetzten, ohne Neustart", () => {
    expect(decideSelfHeal({ ...base, errorClass: "convergence" }).kind).toBe("escalate_manager");
  });

  it("eskaliert convergence nach einem Versuch an den Menschen", () => {
    const action = decideSelfHeal({ ...base, errorClass: "convergence", attemptCount: 1 });
    expect(action).toEqual({ kind: "escalate_human", reason: "convergence_manager_exhausted" });
  });

  it.each(["deterministic", "unknown"] as const)(
    "eskaliert %s sofort an den Menschen, ohne Auto-Retry",
    (errorClass) => {
      const action = decideSelfHeal({ ...base, errorClass });
      expect(action.kind).toBe("escalate_human");
    },
  );

  it("eskaliert deterministic auch bei gesundem Endpoint nicht in ein revive", () => {
    const action = decideSelfHeal({ ...base, errorClass: "deterministic", endpointHealthy: true });
    expect(action.kind).not.toBe("revive");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal-policy.test.ts`
Expected: FAIL — `decideSelfHeal is not a function`

- [ ] **Step 3: Write minimal implementation**

An `agent-self-heal-policy.ts` anfügen:

```typescript
export type SelfHealAction =
  | { kind: "revive" }
  | { kind: "wait_endpoint_down" }
  | { kind: "wait_cooldown" }
  | { kind: "escalate_manager" }
  | { kind: "escalate_human"; reason: string }
  | { kind: "skip"; reason: string };

/**
 * Politik der Selbstheilung — bewusst frei von IO, damit jeder Zweig ohne
 * Datenbank und ohne Netz pruefbar ist.
 *
 * `endpointHealthy === null` heisst „nicht pruefbar" (claude_local hat kein
 * Modell-Listing). Das wird als gesund gewertet; gegen Stuerme schuetzt dort
 * allein der Cooldown.
 */
export function decideSelfHeal(input: {
  errorClass: SelfHealErrorClass;
  agentStatus: string;
  endpointHealthy: boolean | null;
  attemptCount: number;
  nextEligibleAt: Date | null;
  now: Date;
  maxInfraRevives: number;
}): SelfHealAction {
  if (input.agentStatus !== "error") {
    return { kind: "skip", reason: `agent_status_${input.agentStatus}` };
  }
  if (input.nextEligibleAt && input.nextEligibleAt.getTime() > input.now.getTime()) {
    return { kind: "wait_cooldown" };
  }

  switch (input.errorClass) {
    case "infra_transient":
      if (input.attemptCount >= input.maxInfraRevives) {
        return { kind: "escalate_human", reason: "max_infra_revives_exhausted" };
      }
      if (input.endpointHealthy === false) {
        return { kind: "wait_endpoint_down" };
      }
      return { kind: "revive" };

    case "convergence":
      if (input.attemptCount >= 1) {
        return { kind: "escalate_human", reason: "convergence_manager_exhausted" };
      }
      return { kind: "escalate_manager" };

    case "deterministic":
      return { kind: "escalate_human", reason: "deterministic_error" };

    case "unknown":
      return { kind: "escalate_human", reason: "unclassified_error" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal-policy.test.ts`
Expected: PASS (alle Tests aus Task 3 und 4)

- [ ] **Step 5: Commit**

```bash
git add server/src/services/recovery/agent-self-heal-policy.ts server/src/services/recovery/agent-self-heal-policy.test.ts
git commit -m "feat(self-heal): Entscheidungspolitik je Fehlerklasse"
```

---

### Task 5: Eskalationsziel mit Manager-tot-Schutz (rein)

**Files:**
- Modify: `server/src/services/recovery/agent-self-heal-policy.ts`
- Modify: `server/src/services/recovery/agent-self-heal-policy.test.ts`

**Interfaces:**
- Produces: `resolveEscalationTarget(input: { agentId: string; agents: Array<{ id: string; reportsTo: string | null; status: string }> }): { kind: "agent"; agentId: string } | { kind: "human"; reason: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { resolveEscalationTarget } from "./agent-self-heal-policy.js";

const fleet = [
  { id: "spezialist", reportsTo: "cto", status: "error" },
  { id: "cto", reportsTo: "ceo", status: "idle" },
  { id: "ceo", reportsTo: null, status: "idle" },
];

describe("resolveEscalationTarget", () => {
  it("nimmt den direkten Vorgesetzten, wenn er lebt", () => {
    expect(resolveEscalationTarget({ agentId: "spezialist", agents: fleet }))
      .toEqual({ kind: "agent", agentId: "cto" });
  });

  it("ueberspringt einen toten Vorgesetzten", () => {
    const withDeadCto = fleet.map((a) => (a.id === "cto" ? { ...a, status: "error" } : a));
    expect(resolveEscalationTarget({ agentId: "spezialist", agents: withDeadCto }))
      .toEqual({ kind: "agent", agentId: "ceo" });
  });

  it.each(["error", "terminated", "paused"])("wertet Status %s als nicht tragfaehig", (status) => {
    const broken = fleet.map((a) => (a.id === "cto" ? { ...a, status } : a));
    expect(resolveEscalationTarget({ agentId: "spezialist", agents: broken }))
      .toEqual({ kind: "agent", agentId: "ceo" });
  });

  it("gibt an den Menschen ab, wenn die ganze Kette tot ist", () => {
    const allDead = fleet.map((a) => (a.id === "spezialist" ? a : { ...a, status: "error" }));
    expect(resolveEscalationTarget({ agentId: "spezialist", agents: allDead }))
      .toEqual({ kind: "human", reason: "chain_exhausted" });
  });

  it("gibt an den Menschen ab, wenn es keinen Vorgesetzten gibt", () => {
    expect(resolveEscalationTarget({ agentId: "ceo", agents: fleet }))
      .toEqual({ kind: "human", reason: "no_manager" });
  });

  it("laeuft bei einem Zyklus in der Kette nicht endlos", () => {
    const cyclic = [
      { id: "a", reportsTo: "b", status: "error" },
      { id: "b", reportsTo: "a", status: "error" },
    ];
    expect(resolveEscalationTarget({ agentId: "a", agents: cyclic }))
      .toEqual({ kind: "human", reason: "chain_exhausted" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal-policy.test.ts`
Expected: FAIL — `resolveEscalationTarget is not a function`

- [ ] **Step 3: Write minimal implementation**

```typescript
/** Statuswerte, in denen ein Agent keine Eskalation mehr annehmen kann. */
const UNRELIABLE_STATUSES = new Set(["error", "terminated", "paused", "pending_approval"]);

/**
 * Sucht den naechsten tragfaehigen Vorgesetzten in der Berichtskette.
 *
 * Manager-tot-Schutz: der haeufigste Eskalationsempfaenger (CTO) ist selbst ein
 * haeufiges max_iterations-Opfer — ohne dieses Ueberspringen stirbt die Rettung
 * mit dem Retter. Der Zyklusschutz ueber `seen` ist Pflicht, weil `reports_to`
 * nicht garantiert azyklisch ist.
 */
export function resolveEscalationTarget(input: {
  agentId: string;
  agents: Array<{ id: string; reportsTo: string | null; status: string }>;
}): { kind: "agent"; agentId: string } | { kind: "human"; reason: string } {
  const byId = new Map(input.agents.map((a) => [a.id, a]));
  const start = byId.get(input.agentId);
  if (!start?.reportsTo) return { kind: "human", reason: "no_manager" };

  const seen = new Set<string>([input.agentId]);
  let cursor = start.reportsTo;

  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const candidate = byId.get(cursor);
    if (!candidate) break;
    if (!UNRELIABLE_STATUSES.has(candidate.status)) {
      return { kind: "agent", agentId: candidate.id };
    }
    cursor = candidate.reportsTo ?? "";
  }

  return { kind: "human", reason: "chain_exhausted" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal-policy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/recovery/agent-self-heal-policy.ts server/src/services/recovery/agent-self-heal-policy.test.ts
git commit -m "feat(self-heal): Eskalationsziel mit Manager-tot-Schutz"
```

---

### Task 6: Konfiguration

**Files:**
- Modify: `server/src/config.ts`

**Interfaces:**
- Produces: `config.agentSelfHeal` mit `{ enabled: boolean; maxInfraRevives: number; cooldownMs: number; endpointDownAlertMs: number; maxConcurrentRevives: number }`.

- [ ] **Step 1: Vorhandenes Muster ansehen**

Run: `grep -n "heartbeatSchedulerEnabled" server/src/config.ts`
Das ist die Vorlage: `process.env.X !== "false"` für Default-an-Flags, `Math.max(...) || default` für Zahlen.

- [ ] **Step 2: Block einfügen**

Direkt hinter `heartbeatSchedulerIntervalMs` (derzeit Zeile 333) einfügen:

```typescript
    agentSelfHeal: {
      // Default an — der Waechter ruehrt ausschliesslich error-Agenten an.
      enabled: process.env.AGENT_SELF_HEAL_ENABLED !== "false",
      maxInfraRevives: Math.max(1, Number(process.env.AGENT_SELF_HEAL_MAX_INFRA_REVIVES) || 3),
      cooldownMs: Math.max(60_000, Number(process.env.AGENT_SELF_HEAL_COOLDOWN_MS) || 300_000),
      endpointDownAlertMs: Math.max(
        60_000,
        Number(process.env.AGENT_SELF_HEAL_ENDPOINT_DOWN_ALERT_MS) || 1_800_000,
      ),
      // Deckel pro Tick: verhindert, dass ein Endpoint-Ausfall mit 40 toten
      // Agenten in einem Schlag 40 Runs erzeugt.
      maxConcurrentRevives: Math.max(1, Number(process.env.AGENT_SELF_HEAL_MAX_CONCURRENT_REVIVES) || 5),
    },
```

- [ ] **Step 3: Typprüfung**

Run: `cd server && npx tsc --noEmit`
Expected: keine Ausgabe. Schlägt es fehl, weil der Config-Typ explizit deklariert ist, das Feld auch im Interface ergänzen.

- [ ] **Step 4: Commit**

```bash
git add server/src/config.ts
git commit -m "feat(self-heal): Konfigurationsflags"
```

---

### Task 7: Runner mit gemockten Seams

**Files:**
- Create: `server/src/services/recovery/agent-self-heal.ts`
- Test: `server/src/services/recovery/agent-self-heal.test.ts`

**Interfaces:**
- Consumes: `classifySelfHealError`, `decideSelfHeal`, `resolveEscalationTarget`, `buildErrorFingerprint`, `computeNextEligibleAt`.
- Produces:
  ```typescript
  interface SelfHealDeps {
    loadErroredAgents(): Promise<Array<{
      id: string; companyId: string; name: string; status: string;
      reportsTo: string | null; adapterType: string;
      adapterConfig: Record<string, unknown>;
      lastErrorCode: string | null; lastErrorText: string | null;
    }>>;
    loadFleet(): Promise<Array<{ id: string; reportsTo: string | null; status: string }>>;
    loadLedger(agentId: string, fingerprint: string): Promise<{ attemptCount: number; nextEligibleAt: Date | null } | null>;
    saveLedger(input: { agentId: string; companyId: string; errorClass: string; fingerprint: string; attemptCount: number; lastAction: string; nextEligibleAt: Date | null }): Promise<void>;
    probeEndpoint(agent: { adapterType: string; adapterConfig: Record<string, unknown> }): Promise<boolean | null>;
    reviveAgent(agentId: string): Promise<void>;
    wakeAgent(agentId: string, reason: string): Promise<void>;
    escalateToManager(input: { agentId: string; managerAgentId: string; reason: string }): Promise<void>;
    escalateToHuman(input: { agentId: string; reason: string }): Promise<void>;
    logAction(input: { companyId: string; agentId: string; action: string; detail: Record<string, unknown> }): Promise<void>;
    now(): Date;
  }

  function runAgentSelfHeal(deps: SelfHealDeps, options: { maxInfraRevives: number; cooldownMs: number; maxConcurrentRevives: number }): Promise<{ scanned: number; revived: number; escalatedManager: number; escalatedHuman: number; waited: number; skipped: number }>;
  ```

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { runAgentSelfHeal } from "./agent-self-heal.js";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const OPTS = { maxInfraRevives: 3, cooldownMs: 300_000, maxConcurrentRevives: 5 };

function makeDeps(overrides: Partial<Parameters<typeof runAgentSelfHeal>[0]> = {}) {
  const deps = {
    loadErroredAgents: vi.fn().mockResolvedValue([]),
    loadFleet: vi.fn().mockResolvedValue([]),
    loadLedger: vi.fn().mockResolvedValue(null),
    saveLedger: vi.fn().mockResolvedValue(undefined),
    probeEndpoint: vi.fn().mockResolvedValue(true),
    reviveAgent: vi.fn().mockResolvedValue(undefined),
    wakeAgent: vi.fn().mockResolvedValue(undefined),
    escalateToManager: vi.fn().mockResolvedValue(undefined),
    escalateToHuman: vi.fn().mockResolvedValue(undefined),
    logAction: vi.fn().mockResolvedValue(undefined),
    now: () => NOW,
    ...overrides,
  };
  return deps as Parameters<typeof runAgentSelfHeal>[0] & typeof deps;
}

const erroredAgent = (over: Record<string, unknown> = {}) => ({
  id: "agent-1",
  companyId: "company-1",
  name: "SEO/GEO",
  status: "error",
  reportsTo: "cto",
  adapterType: "lmstudio_local",
  adapterConfig: { url: "http://localhost:1234", model: "qwen3.6-35b-a3b-mlx" },
  lastErrorCode: "llm_unreachable",
  lastErrorText: null,
  ...over,
});

describe("runAgentSelfHeal", () => {
  it("tut nichts, wenn kein Agent in error steht", async () => {
    const deps = makeDeps();
    const result = await runAgentSelfHeal(deps, OPTS);
    expect(result).toMatchObject({ scanned: 0, revived: 0 });
    expect(deps.reviveAgent).not.toHaveBeenCalled();
  });

  it("belebt einen infra_transient-Agenten bei gesundem Endpoint und weckt ihn", async () => {
    const deps = makeDeps({ loadErroredAgents: vi.fn().mockResolvedValue([erroredAgent()]) });
    const result = await runAgentSelfHeal(deps, OPTS);

    expect(deps.reviveAgent).toHaveBeenCalledWith("agent-1");
    expect(deps.wakeAgent).toHaveBeenCalledWith("agent-1", expect.stringContaining("self_heal"));
    expect(result.revived).toBe(1);
  });

  it("belebt NICHT, wenn das Endpoint down ist", async () => {
    const deps = makeDeps({
      loadErroredAgents: vi.fn().mockResolvedValue([erroredAgent()]),
      probeEndpoint: vi.fn().mockResolvedValue(false),
    });
    const result = await runAgentSelfHeal(deps, OPTS);

    expect(deps.reviveAgent).not.toHaveBeenCalled();
    expect(result.waited).toBe(1);
  });

  it("respektiert den Cooldown aus dem Ledger", async () => {
    const deps = makeDeps({
      loadErroredAgents: vi.fn().mockResolvedValue([erroredAgent()]),
      loadLedger: vi.fn().mockResolvedValue({
        attemptCount: 1,
        nextEligibleAt: new Date("2026-08-17T12:10:00.000Z"),
      }),
    });
    const result = await runAgentSelfHeal(deps, OPTS);

    expect(deps.reviveAgent).not.toHaveBeenCalled();
    expect(result.waited).toBe(1);
  });

  it("eskaliert max_iterations an den lebenden Vorgesetzten", async () => {
    const deps = makeDeps({
      loadErroredAgents: vi.fn().mockResolvedValue([
        erroredAgent({ lastErrorCode: "max_iterations" }),
      ]),
      loadFleet: vi.fn().mockResolvedValue([
        { id: "agent-1", reportsTo: "cto", status: "error" },
        { id: "cto", reportsTo: null, status: "idle" },
      ]),
    });
    const result = await runAgentSelfHeal(deps, OPTS);

    expect(deps.escalateToManager).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", managerAgentId: "cto" }),
    );
    expect(deps.reviveAgent).not.toHaveBeenCalled();
    expect(result.escalatedManager).toBe(1);
  });

  it("gibt an den Menschen ab, wenn der Vorgesetzte selbst tot ist", async () => {
    const deps = makeDeps({
      loadErroredAgents: vi.fn().mockResolvedValue([
        erroredAgent({ lastErrorCode: "max_iterations" }),
      ]),
      loadFleet: vi.fn().mockResolvedValue([
        { id: "agent-1", reportsTo: "cto", status: "error" },
        { id: "cto", reportsTo: null, status: "error" },
      ]),
    });
    const result = await runAgentSelfHeal(deps, OPTS);

    expect(deps.escalateToHuman).toHaveBeenCalled();
    expect(result.escalatedHuman).toBe(1);
  });

  it("eskaliert deterministische Fehler ohne jeden Retry", async () => {
    const deps = makeDeps({
      loadErroredAgents: vi.fn().mockResolvedValue([
        erroredAgent({ lastErrorCode: "claude_auth_required" }),
      ]),
    });
    await runAgentSelfHeal(deps, OPTS);

    expect(deps.reviveAgent).not.toHaveBeenCalled();
    expect(deps.probeEndpoint).not.toHaveBeenCalled();
    expect(deps.escalateToHuman).toHaveBeenCalled();
  });

  it("deckelt die Wiederbelebungen pro Tick", async () => {
    const many = Array.from({ length: 9 }, (_, i) => erroredAgent({ id: `agent-${i}` }));
    const deps = makeDeps({ loadErroredAgents: vi.fn().mockResolvedValue(many) });

    const result = await runAgentSelfHeal(deps, { ...OPTS, maxConcurrentRevives: 2 });

    expect(deps.reviveAgent).toHaveBeenCalledTimes(2);
    expect(result.revived).toBe(2);
  });

  it("schreibt jede Aktion ins Ledger und ins Protokoll", async () => {
    const deps = makeDeps({ loadErroredAgents: vi.fn().mockResolvedValue([erroredAgent()]) });
    await runAgentSelfHeal(deps, OPTS);

    expect(deps.saveLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        errorClass: "infra_transient",
        fingerprint: "code:llm_unreachable",
        attemptCount: 1,
        lastAction: "revived",
      }),
    );
    expect(deps.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.self_heal.revived" }),
    );
  });

  it("laesst ein Scheitern an einem Agenten die uebrigen nicht mitreissen", async () => {
    const deps = makeDeps({
      loadErroredAgents: vi.fn().mockResolvedValue([
        erroredAgent({ id: "agent-kaputt" }),
        erroredAgent({ id: "agent-ok" }),
      ]),
      reviveAgent: vi.fn().mockImplementation(async (id: string) => {
        if (id === "agent-kaputt") throw new Error("resume schlug fehl");
      }),
    });

    const result = await runAgentSelfHeal(deps, OPTS);

    expect(result.revived).toBe(1);
    expect(deps.wakeAgent).toHaveBeenCalledWith("agent-ok", expect.any(String));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal.test.ts`
Expected: FAIL — Modul nicht gefunden

- [ ] **Step 3: Write minimal implementation**

```typescript
import { logger } from "../../telemetry.js";
import { classifySelfHealError } from "./agent-self-heal-classify.js";
import {
  buildErrorFingerprint,
  computeNextEligibleAt,
  decideSelfHeal,
  resolveEscalationTarget,
} from "./agent-self-heal-policy.js";

export interface SelfHealAgentRow {
  id: string;
  companyId: string;
  name: string;
  status: string;
  reportsTo: string | null;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  lastErrorCode: string | null;
  lastErrorText: string | null;
}

export interface SelfHealDeps {
  loadErroredAgents(): Promise<SelfHealAgentRow[]>;
  loadFleet(): Promise<Array<{ id: string; reportsTo: string | null; status: string }>>;
  loadLedger(
    agentId: string,
    fingerprint: string,
  ): Promise<{ attemptCount: number; nextEligibleAt: Date | null } | null>;
  saveLedger(input: {
    agentId: string;
    companyId: string;
    errorClass: string;
    fingerprint: string;
    attemptCount: number;
    lastAction: string;
    nextEligibleAt: Date | null;
  }): Promise<void>;
  probeEndpoint(agent: {
    adapterType: string;
    adapterConfig: Record<string, unknown>;
  }): Promise<boolean | null>;
  reviveAgent(agentId: string): Promise<void>;
  wakeAgent(agentId: string, reason: string): Promise<void>;
  escalateToManager(input: {
    agentId: string;
    managerAgentId: string;
    reason: string;
  }): Promise<void>;
  escalateToHuman(input: { agentId: string; reason: string }): Promise<void>;
  logAction(input: {
    companyId: string;
    agentId: string;
    action: string;
    detail: Record<string, unknown>;
  }): Promise<void>;
  now(): Date;
}

export interface SelfHealResult {
  scanned: number;
  revived: number;
  escalatedManager: number;
  escalatedHuman: number;
  waited: number;
  skipped: number;
}

/**
 * Ein Durchlauf der Selbstheilung.
 *
 * Alle Seiteneffekte laufen ueber `deps`, damit jeder Zweig ohne Datenbank und
 * ohne Netz pruefbar ist. Ein Fehler an einem Agenten wird protokolliert und
 * uebersprungen — er darf die uebrigen nicht mitreissen.
 */
export async function runAgentSelfHeal(
  deps: SelfHealDeps,
  options: { maxInfraRevives: number; cooldownMs: number; maxConcurrentRevives: number },
): Promise<SelfHealResult> {
  const log = logger.child({ service: "agent-self-heal" });
  const agents = await deps.loadErroredAgents();
  const result: SelfHealResult = {
    scanned: agents.length,
    revived: 0,
    escalatedManager: 0,
    escalatedHuman: 0,
    waited: 0,
    skipped: 0,
  };
  if (agents.length === 0) return result;

  const now = deps.now();
  let fleet: Array<{ id: string; reportsTo: string | null; status: string }> | null = null;

  for (const agent of agents) {
    try {
      const errorInput = { errorCode: agent.lastErrorCode, errorText: agent.lastErrorText };
      const errorClass = classifySelfHealError(errorInput);
      const fingerprint = buildErrorFingerprint(errorInput);
      const ledger = await deps.loadLedger(agent.id, fingerprint);
      const attemptCount = ledger?.attemptCount ?? 0;

      // Das Endpoint nur pruefen, wenn die Entscheidung davon abhaengen kann —
      // deterministische Faelle sollen keinen Netzverkehr ausloesen.
      const endpointHealthy =
        errorClass === "infra_transient" && attemptCount < options.maxInfraRevives
          ? await deps.probeEndpoint(agent)
          : null;

      const capReached = result.revived >= options.maxConcurrentRevives;
      const action = decideSelfHeal({
        errorClass,
        agentStatus: agent.status,
        endpointHealthy,
        attemptCount,
        nextEligibleAt: ledger?.nextEligibleAt ?? null,
        now,
        maxInfraRevives: options.maxInfraRevives,
      });

      if (action.kind === "revive" && capReached) {
        result.waited += 1;
        continue;
      }

      const persist = async (lastAction: string, bumpAttempt: boolean) => {
        await deps.saveLedger({
          agentId: agent.id,
          companyId: agent.companyId,
          errorClass,
          fingerprint,
          attemptCount: bumpAttempt ? attemptCount + 1 : attemptCount,
          lastAction,
          nextEligibleAt: computeNextEligibleAt(attemptCount, now, options.cooldownMs),
        });
        await deps.logAction({
          companyId: agent.companyId,
          agentId: agent.id,
          action: `agent.self_heal.${lastAction}`,
          detail: { errorClass, fingerprint, attemptCount, endpointHealthy, agentName: agent.name },
        });
      };

      switch (action.kind) {
        case "revive": {
          await deps.reviveAgent(agent.id);
          await deps.wakeAgent(agent.id, `self_heal:${errorClass}`);
          result.revived += 1;
          await persist("revived", true);
          break;
        }
        case "wait_endpoint_down":
        case "wait_cooldown": {
          result.waited += 1;
          break;
        }
        case "escalate_manager": {
          fleet ??= await deps.loadFleet();
          const target = resolveEscalationTarget({ agentId: agent.id, agents: fleet });
          if (target.kind === "agent") {
            await deps.escalateToManager({
              agentId: agent.id,
              managerAgentId: target.agentId,
              reason: errorClass,
            });
            result.escalatedManager += 1;
            await persist("escalated_manager", true);
          } else {
            await deps.escalateToHuman({ agentId: agent.id, reason: target.reason });
            result.escalatedHuman += 1;
            await persist("escalated_human", true);
          }
          break;
        }
        case "escalate_human": {
          await deps.escalateToHuman({ agentId: agent.id, reason: action.reason });
          result.escalatedHuman += 1;
          await persist("escalated_human", true);
          break;
        }
        case "skip": {
          result.skipped += 1;
          break;
        }
      }
    } catch (err) {
      log.error({ err, agentId: agent.id }, "self-heal fuer einen Agenten fehlgeschlagen");
      result.skipped += 1;
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal.test.ts`
Expected: PASS (10 Tests)

- [ ] **Step 5: Regression im Recovery-Bereich**

Run: `cd server && npx vitest run --exclude "**/_paperclip.STALE-DISABLED-*/**" src/services/recovery/`
Expected: alle grün. **Wichtig:** der `--exclude` ist Pflicht — ohne ihn sammelt der Glob den stillgelegten Klon `server/_paperclip.STALE-DISABLED-20260614/` ein und produziert vorbestehende Fehlschläge, die nichts mit dieser Arbeit zu tun haben.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/recovery/agent-self-heal.ts server/src/services/recovery/agent-self-heal.test.ts
git commit -m "feat(self-heal): Runner mit gemockten Seams"
```

---

### Task 8: Verdrahtung in den Scheduler

**Files:**
- Modify: `server/src/services/recovery/agent-self-heal.ts` (echte Deps-Fabrik ergänzen)
- Modify: `server/src/index.ts:722` (Tick)

**Interfaces:**
- Consumes: `runAgentSelfHeal`, `config.agentSelfHeal`, `heartbeat.wakeup`, `agentService.resume`.
- Produces: `createSelfHealDeps(db, { heartbeat, agentService }): SelfHealDeps` und `tickAgentSelfHeal(...)` mit internem Cooldown, damit nicht jeder 30-s-Tick scannt.

- [ ] **Step 1: Deps-Fabrik anfügen**

In `agent-self-heal.ts`:

```typescript
import { and, desc, eq, isNull, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentSelfHealLedger, heartbeatRuns, activityLog } from "@paperclipai/db";

/**
 * Verdrahtet den Runner mit der Datenbank und den Diensten.
 *
 * `probeEndpoint` liefert absichtlich `null` fuer alles, was kein LM Studio ist:
 * fuer claude_local gibt es kein Modell-Listing, dort schuetzt der Cooldown.
 */
export function createSelfHealDeps(
  db: Db,
  svc: {
    heartbeat: { wakeup(agentId: string, opts: Record<string, unknown>): Promise<unknown> };
    agentService: { resume(id: string): Promise<unknown> };
  },
): SelfHealDeps {
  return {
    async loadErroredAgents() {
      const rows = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          status: agents.status,
          reportsTo: agents.reportsTo,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(eq(agents.status, "error"));

      return Promise.all(
        rows.map(async (row) => {
          const [lastRun] = await db
            .select({ errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.agentId, row.id))
            .orderBy(desc(heartbeatRuns.createdAt))
            .limit(1);
          return {
            ...row,
            adapterConfig: (row.adapterConfig ?? {}) as Record<string, unknown>,
            lastErrorCode: lastRun?.errorCode ?? null,
            lastErrorText: lastRun?.error ?? null,
          };
        }),
      );
    },

    async loadFleet() {
      return db
        .select({ id: agents.id, reportsTo: agents.reportsTo, status: agents.status })
        .from(agents);
    },

    async loadLedger(agentId, fingerprint) {
      const [row] = await db
        .select({
          attemptCount: agentSelfHealLedger.attemptCount,
          nextEligibleAt: agentSelfHealLedger.nextEligibleAt,
        })
        .from(agentSelfHealLedger)
        .where(
          and(
            eq(agentSelfHealLedger.agentId, agentId),
            eq(agentSelfHealLedger.errorFingerprint, fingerprint),
            isNull(agentSelfHealLedger.resolvedAt),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async saveLedger(input) {
      await db
        .insert(agentSelfHealLedger)
        .values({
          agentId: input.agentId,
          companyId: input.companyId,
          errorClass: input.errorClass,
          errorFingerprint: input.fingerprint,
          attemptCount: input.attemptCount,
          lastAction: input.lastAction,
          nextEligibleAt: input.nextEligibleAt,
        })
        .onConflictDoUpdate({
          target: [agentSelfHealLedger.agentId, agentSelfHealLedger.errorFingerprint],
          targetWhere: isNull(agentSelfHealLedger.resolvedAt),
          set: {
            attemptCount: input.attemptCount,
            lastAction: input.lastAction,
            nextEligibleAt: input.nextEligibleAt,
            updatedAt: new Date(),
          },
        });
    },

    async probeEndpoint(agent) {
      if (agent.adapterType !== "lmstudio_local") return null;
      const base = typeof agent.adapterConfig.url === "string" ? agent.adapterConfig.url : "http://localhost:1234";
      const wanted = typeof agent.adapterConfig.model === "string" ? agent.adapterConfig.model : null;
      const fallback = typeof agent.adapterConfig.fallbackModel === "string" ? agent.adapterConfig.fallbackModel : null;
      try {
        const res = await fetch(`${base.replace(/\/+$/, "")}/v1/models`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { data?: Array<{ id?: string }> };
        const ids = new Set((body.data ?? []).map((m) => m.id).filter(Boolean) as string[]);
        // Erreichbar genuegt nicht — das konfigurierte Modell (oder der
        // Fallback) muss auch geladen sein, sonst scheitert der Run erneut.
        if (!wanted && !fallback) return ids.size > 0;
        return (wanted !== null && ids.has(wanted)) || (fallback !== null && ids.has(fallback));
      } catch {
        return false;
      }
    },

    async reviveAgent(agentId) {
      // resume() setzt status=idle und raeumt pauseReason auf — nie direkt patchen.
      await svc.agentService.resume(agentId);
    },

    async wakeAgent(agentId, reason) {
      await svc.heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason,
        requestedByActorType: "system",
        requestedByActorId: "agent-self-heal",
      });
    },

    async escalateToManager({ agentId, managerAgentId, reason }) {
      await svc.heartbeat.wakeup(managerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: `self_heal_escalation:${reason}`,
        payload: { strandedAgentId: agentId, cause: reason },
        requestedByActorType: "system",
        requestedByActorId: "agent-self-heal",
      });
    },

    async escalateToHuman({ agentId, reason }) {
      // Bewusst nur protokollieren: die Mail-/Board-Strecke haengt an
      // send-walter-deliverable und ist eigene Arbeit. Der activity_log-Eintrag
      // ist die Spur, an der ein Mensch es findet.
      logger.child({ service: "agent-self-heal" }).warn(
        { agentId, reason },
        "self-heal braucht einen Menschen",
      );
    },

    async logAction({ companyId, agentId, action, detail }) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "agent-self-heal",
        action,
        entityType: "agent",
        entityId: agentId,
        metadata: detail,
      });
    },

    now: () => new Date(),
  };
}
```

- [ ] **Step 2: Spalten- und Feldnamen gegen das echte Schema prüfen**

Run:
```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -c "\d activity_log"
grep -n "errorCode\|error:" packages/db/src/schema/heartbeat_runs.ts | head
```
`activityLog`-Feldnamen (`metadata` vs. `detail`) und die Drizzle-Namen in `heartbeatRuns` übernehmen, falls sie abweichen. **Nicht raten** — die Migration schlägt sonst erst zur Laufzeit fehl.

- [ ] **Step 3: Tick mit internem Cooldown anfügen**

In `agent-self-heal.ts`:

```typescript
let lastTickAt = 0;

/**
 * Scheduler-Einstieg. Der 30-s-Tick ruft das oft; gescannt wird nur, wenn der
 * eigene Mindestabstand abgelaufen ist.
 */
export async function tickAgentSelfHeal(
  deps: SelfHealDeps,
  options: {
    enabled: boolean;
    minIntervalMs: number;
    maxInfraRevives: number;
    cooldownMs: number;
    maxConcurrentRevives: number;
  },
): Promise<SelfHealResult | null> {
  if (!options.enabled) return null;
  const now = deps.now().getTime();
  if (now - lastTickAt < options.minIntervalMs) return null;
  lastTickAt = now;
  return runAgentSelfHeal(deps, options);
}
```

- [ ] **Step 4: In `server/src/index.ts` einhängen**

Innerhalb des `setInterval`-Blocks bei Zeile 722, hinter dem `routines.tickScheduledTriggers`-Aufruf:

```typescript
      void tickAgentSelfHeal(selfHealDeps, {
        enabled: config.agentSelfHeal.enabled,
        minIntervalMs: 120_000,
        maxInfraRevives: config.agentSelfHeal.maxInfraRevives,
        cooldownMs: config.agentSelfHeal.cooldownMs,
        maxConcurrentRevives: config.agentSelfHeal.maxConcurrentRevives,
      })
        .then((result) => {
          if (result && (result.revived > 0 || result.escalatedManager > 0 || result.escalatedHuman > 0)) {
            logger.warn({ ...result }, "agent self-heal handelte");
          }
        })
        .catch((err) => {
          logger.error({ err }, "agent self-heal tick failed");
        });
```

`selfHealDeps` einmalig vor dem `setInterval` erzeugen:

```typescript
    const selfHealDeps = createSelfHealDeps(db, { heartbeat, agentService: agents });
```

Den echten Namen des Agenten-Service in `index.ts` per `grep -n "agentsService\|agentService\|agents =" server/src/index.ts` bestimmen und einsetzen.

- [ ] **Step 5: Typprüfung und volle Server-Suite**

Run:
```bash
cd server && npx tsc --noEmit
npx vitest run --exclude "**/_paperclip.STALE-DISABLED-*/**" src/services/recovery/ src/__tests__/
```
Expected: keine Typfehler, alle Tests grün.

- [ ] **Step 6: Commit — vorher das Neustartfenster prüfen**

```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At \
  -c "select count(*) from heartbeat_runs where status='running'"
```
Muss `0` sein. Sonst warten — der Commit startet den Watch-Dienst neu und tötet laufende Läufe.

```bash
git add server/src/services/recovery/agent-self-heal.ts server/src/index.ts
git commit -m "feat(self-heal): Waechter in den Scheduler eingehaengt"
```

---

### Task 9: Live-Verifikation

**Files:** keine — reine Beobachtung.

- [ ] **Step 1: Dienst neu starten und Flag prüfen**

```bash
launchctl kickstart -k gui/501/ing.paperclip.dev
until curl -s -o /dev/null --max-time 5 http://127.0.0.1:3100/; do sleep 3; done
```

- [ ] **Step 2: Künstlichen Fall erzeugen**

Einen unkritischen Agenten (`Blender`, Heartbeat ohnehin aus) auf `error` setzen und einen transienten Fehlercode unterlegen:

```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -c \
  "update agents set status='error' where name='Blender'"
```

- [ ] **Step 3: Beobachten, dass der Wächter greift**

Innerhalb von zwei Minuten:

```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At -F' | ' -c \
  "select a.name, a.status from agents a where a.name='Blender'"
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At -F' | ' -c \
  "select action, metadata->>'errorClass', metadata->>'attemptCount', created_at::timestamp(0)
   from activity_log where action like 'agent.self_heal.%' order by created_at desc limit 5"
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At -F' | ' -c \
  "select error_class, attempt_count, last_action, next_eligible_at::timestamp(0) from agent_self_heal_ledger"
```

Expected: `Blender` steht wieder auf `idle`; ein `agent.self_heal.revived`-Eintrag; eine Ledger-Zeile mit `attempt_count=1` und gesetztem `next_eligible_at`.

- [ ] **Step 4: Sturmfreiheit belegen**

Nochmals auf `error` setzen und prüfen, dass der Wächter beim nächsten Tick **nicht** sofort erneut wiederbelebt (Cooldown greift, `attempt_count` bleibt stehen oder steigt auf 2 mit längerem `next_eligible_at`). Danach `Blender` per `resume` sauber zurückstellen.

- [ ] **Step 5: Not-Aus prüfen**

`AGENT_SELF_HEAL_ENABLED=false` in die plist, kickstart, erneut einen `error`-Agenten erzeugen und belegen, dass **nichts** passiert. Danach Flag zurücknehmen.

- [ ] **Step 6: Commit der Beobachtung**

Ergebnisse als Abschnitt „Live-Verifikation" an die Spec anfügen und committen.

---

### Task 10: Ledger-Zeile schliessen, sobald der Agent wieder liefert

**Files:**
- Modify: `server/src/services/recovery/agent-self-heal.ts` (Funktion ergänzen)
- Modify: `server/src/services/heartbeat.ts:6152-6171` (`finalizeAgentStatus`, Erfolgszweig)
- Test: `server/src/services/recovery/agent-self-heal-resolve.test.ts`

**Interfaces:**
- Produces: `resolveSelfHealLedgerForAgent(db: Db, agentId: string, now: Date): Promise<number>` — schliesst alle offenen Zeilen des Agenten und gibt die Anzahl zurück.

**Warum:** Ohne dieses Schliessen bleibt die Zeile mit ihrem Cooldown fuer immer offen. Faellt der Agent Wochen spaeter mit derselben Signatur erneut aus, sieht der Waechter `attempt_count=3` und eskaliert sofort an den Menschen, statt es einmal zu versuchen. Der Zaehler muss sich also auf eine *Stoerung* beziehen, nicht auf die Lebenszeit des Agenten.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { decideLedgerResolution } from "./agent-self-heal.js";

describe("decideLedgerResolution", () => {
  it("schliesst offene Zeilen bei succeeded", () => {
    expect(decideLedgerResolution("succeeded")).toBe(true);
  });

  it("schliesst offene Zeilen bei cancelled", () => {
    expect(decideLedgerResolution("cancelled")).toBe(true);
  });

  it.each(["failed", "timed_out"] as const)("laesst die Zeile bei %s offen", (outcome) => {
    expect(decideLedgerResolution(outcome)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal-resolve.test.ts`
Expected: FAIL — `decideLedgerResolution is not a function`

- [ ] **Step 3: Write minimal implementation**

In `agent-self-heal.ts`:

```typescript
/**
 * Ein erfolgreicher (oder abgebrochener) Run beendet die Stoerung — die offene
 * Ledger-Zeile wird geschlossen, damit ein spaeterer Ausfall wieder bei
 * attempt_count 0 anfaengt. `cancelled` zaehlt mit, weil `finalizeAgentStatus`
 * es genauso wie `succeeded` als „nicht kaputt" behandelt.
 */
export function decideLedgerResolution(
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
): boolean {
  return outcome === "succeeded" || outcome === "cancelled";
}

/** Schliesst alle offenen Ledger-Zeilen eines Agenten. Gibt die Anzahl zurueck. */
export async function resolveSelfHealLedgerForAgent(
  db: Db,
  agentId: string,
  now: Date,
): Promise<number> {
  const rows = await db
    .update(agentSelfHealLedger)
    .set({ resolvedAt: now, updatedAt: now })
    .where(
      and(
        eq(agentSelfHealLedger.agentId, agentId),
        isNull(agentSelfHealLedger.resolvedAt),
      ),
    )
    .returning({ id: agentSelfHealLedger.id });
  return rows.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/services/recovery/agent-self-heal-resolve.test.ts`
Expected: PASS (4 Tests)

- [ ] **Step 5: In `finalizeAgentStatus` einhängen**

In `server/src/services/heartbeat.ts`, direkt hinter dem `db.update(agents)`-Block (derzeit endend bei ~Zeile 6181), vor dem Rest der Funktion:

```typescript
    // Selbstheilung: eine ueberstandene Stoerung schliesst ihre Ledger-Zeile,
    // damit der Versuchszaehler nicht ueber Wochen mitwaechst.
    if (decideLedgerResolution(outcome)) {
      try {
        await resolveSelfHealLedgerForAgent(db, agentId, new Date());
      } catch (err) {
        logger.warn({ err, agentId }, "self-heal ledger konnte nicht geschlossen werden");
      }
    }
```

Der `try`/`catch` ist Absicht: das Schliessen des Ledgers darf `finalizeAgentStatus` nie zum Scheitern bringen — sonst haengt der Agenten-Status an einer Nebensache.

Import oben in `heartbeat.ts` ergänzen:

```typescript
import { decideLedgerResolution, resolveSelfHealLedgerForAgent } from "./recovery/agent-self-heal.js";
```

- [ ] **Step 6: Typprüfung und Regression**

Run:
```bash
cd server && npx tsc --noEmit
npx vitest run --exclude "**/_paperclip.STALE-DISABLED-*/**" src/services/recovery/ src/__tests__/
```
Expected: keine Typfehler, alles grün. Auf Import-Zyklen achten: `heartbeat.ts` importiert nun aus `recovery/agent-self-heal.ts`, das seinerseits **nicht** aus `heartbeat.ts` importieren darf (der Runner bekommt `heartbeat.wakeup` per Deps-Injektion, genau deshalb).

- [ ] **Step 7: Live belegen**

Blender auf `error` setzen, Wächter abwarten (belebt + Ledger-Zeile mit `attempt_count=1`), dann einen erfolgreichen Lauf auslösen:

```bash
set -a; source ~/.paperclip/instances/default/agent-learning.secret; set +a
ID=$(PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At \
  -c "select id from agents where name='Blender'")
curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_BOARD_API_KEY" \
  -H "Content-Type: application/json" -d '{"reason":"Ledger-Probe","prompt":"Antworte nur mit OK."}' \
  "http://127.0.0.1:3100/api/agents/$ID/wakeup" > /dev/null
```

Danach:
```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At -F' | ' -c \
  "select error_class, attempt_count, last_action, resolved_at::timestamp(0) from agent_self_heal_ledger order by created_at desc limit 3"
```
Expected: die Zeile hat ein gesetztes `resolved_at`.

- [ ] **Step 8: Commit — Neustartfenster prüfen**

```bash
PGPASSWORD=paperclip psql -h 127.0.0.1 -p 54329 -U paperclip -d paperclip -At \
  -c "select count(*) from heartbeat_runs where status='running'"
```
Muss `0` sein.

```bash
git add server/src/services/recovery/agent-self-heal.ts server/src/services/recovery/agent-self-heal-resolve.test.ts server/src/services/heartbeat.ts
git commit -m "feat(self-heal): Ledger-Zeile bei erfolgreichem Lauf schliessen"
```

---

## Nicht in diesem Plan (bewusst)

- **Baustein B (Adapter-Härtung)** — Completion-Retry und weiches `max_iterations` im Repo `paperclip-adapter-lmstudio`. Eigener Plan, weil eigenes Repo und eigener Deploy-Weg. Senkt die *Auslöser*; dieser Plan fängt die *Folgen*.
- **`escalateToHuman` als Mail/Board-Approval.** Hier nur `activity_log` + Warn-Log. Die Mailstrecke hängt an `send-walter-deliverable.sh` und ist eigene Arbeit.
- **Plugins.** Sie haben nachweislich dasselbe Problem (`error` ist Endzustand, 17 Tage Ausfall am 29.07.), brauchen aber einen eigenen Wächter — andere Tabelle, andere Lifecycle-API. Als Folgearbeit vormerken.
- **WHI-3876** (`claude_local`: ein einzelner 429 beendet den Run, die Continuation setzt `scheduled_retry_attempt` auf 0 → Endlosschleife). Betrifft denselben Fehlercode `claude_transient_upstream`, ist aber ein Fehler im Retry-Zähler und keine Selbstheilungsfrage.

## Selbstprüfung gegen die Spec

| Spec-Abschnitt | Umsetzung |
|---|---|
| §3 A.1 Scan | Task 7 `loadErroredAgents`, Task 8 Deps-Fabrik |
| §3 A.2 Klassifikation | Task 1 — **auf `error_code` umgestellt**, Text als Rückfall |
| §3 A.3 Endpoint-Health-Gate | Task 8 `probeEndpoint` (Modell-geladen-Prüfung inklusive), `null` für claude_local |
| §3 A.4 Wiederbelebungs-Politik | Task 4 `decideSelfHeal`, Task 3 Cooldown 5/15/60 |
| §3 A.4 Manager-tot-Schutz | Task 5 `resolveEscalationTarget` inkl. Zyklusschutz |
| §3 A.5 Protokollierung | Task 7 `logAction`, `agent.self_heal.*` |
| §3 A Anti-Sturm | Task 4 (nur `error`), Task 3 (Cooldown), Task 7 (`maxConcurrentRevives`), Task 2 (partieller Unique-Index) |
| §3 A Weck-Kanal | Task 8 — `heartbeat.wakeup`, kein Roh-Insert |
| §4 Ledger | Task 2 |
| §5 Konfiguration | Task 6 |
| §6 Testing | Tasks 1, 3, 4, 5, 7 |
| §7 Deploy | Task 8 Step 6, Task 9 |
| §3 B Adapter-Härtung | **nicht hier** — eigener Plan |
| `resolved_at` bei Folgeerfolg | Task 10 |
