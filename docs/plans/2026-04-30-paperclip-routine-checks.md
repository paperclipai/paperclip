# Paperclip Routine Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate 5 paperclip-domain routine checks (workspace-drift-guard, subscription-shadow-sync, creative-lint-nightly, drive-marker-ttl, approved-freshness) from Hermes cron prompts and openclaw shell scripts into a versioned, tested module inside the paperclip server, with Hermes reduced to a Telegram-webhook delivery layer.

**Architecture:** New `services/routine-checks/` module in paperclip server with Registry → Runner → Check → Notify-Dispatcher → Hermes-Webhook → Telegram. Findings persist in `routine_check_runs` Postgres table. Hermes owns SQLite dedupe (`paperclip_notify_dedupe.db`) and Telegram delivery. Openclaw runs a heartbeat-check covering paperclip-server downtime. Big-bang cutover with 7-day pause-not-delete on Hermes for warm rollback.

**Tech Stack:**
- Paperclip: pnpm monorepo, TypeScript, drizzle-orm, Postgres, vitest
- Hermes: Python, FastAPI, sqlite3, pytest, croniter, python-telegram-bot
- Openclaw: bash, launchd, psql

**Spec:** `docs/specs/2026-04-30-paperclip-routine-checks.md`

**Repos touched:**
- `~/Code/paperclip` (bulk of work)
- `~/Code/hermes-agent` (webhook handler + dedupe)
- `~/.openclaw/workspace` (heartbeat-check + cutover cleanup)

---

## File Structure

### Paperclip (`~/Code/paperclip`)

**Create:**
- `server/src/db/migrations/<timestamp>_routine_check_runs.sql` — drizzle migration
- `server/src/db/schema/routine-check-runs.ts` — drizzle table definition
- `server/src/services/routine-checks/runner.ts` — tick driver + catch-up
- `server/src/services/routine-checks/registry.ts` — Map<name, CheckDef>
- `server/src/services/routine-checks/notify.ts` — silent/threshold/telegram dispatcher
- `server/src/services/routine-checks/types.ts` — CheckDef, CheckResult, CheckCtx
- `server/src/services/routine-checks/checks/workspace-drift-guard.ts`
- `server/src/services/routine-checks/checks/subscription-shadow-sync.ts`
- `server/src/services/routine-checks/checks/creative-lint-nightly.ts`
- `server/src/services/routine-checks/checks/drive-marker-ttl.ts`
- `server/src/services/routine-checks/checks/approved-freshness.ts`
- `server/src/services/routine-checks/__tests__/runner.test.ts`
- `server/src/services/routine-checks/__tests__/notify.test.ts`
- `server/src/services/routine-checks/__tests__/registry.test.ts`
- `server/src/services/routine-checks/__tests__/checks/*.test.ts` (5 files)
- `cli/src/commands/checks.ts` — CLI subcommand handler

**Modify:**
- `server/src/services/cron.ts` — add routine-check boot hook
- `server/src/index.ts` — wire boot hook
- `cli/src/index.ts` — register `checks` subcommand
- `server/src/db/schema/index.ts` — export new table

### Hermes (`~/Code/hermes-agent`)

**Create:**
- `gateway/paperclip_notify.py` — FastAPI router
- `gateway/paperclip_notify_dedupe.py` — SQLite dedupe layer
- `tests/gateway/test_paperclip_notify.py`

**Modify:**
- `gateway/__init__.py` (or wherever FastAPI app is composed) — mount router
- `~/.hermes/secrets/notify-token` — new file with shared token

### Openclaw (`~/.openclaw/workspace`)

**Create:**
- `scripts/paperclip-heartbeat-check.sh` — DB-query against routine_check_runs
- `~/Library/LaunchAgents/de.marcoschmid.paperclip-heartbeat.plist`

**Modify:**
- `scripts/paperclip-subscription-shadow-sync.sh` — replace body with `exec paperclip checks run subscription-shadow-sync` stub
- `scripts/nightly_workspace_consistency_audit.sh` — strip paperclip-specific checks if any (verify with grep first)

**Delete (cutover):**
- `scripts/paperclip_phase0_check.sh`
- `~/Library/LaunchAgents/de.marcoschmid.paperclip-phase0-check.plist`

### Secrets

**Create:**
- `~/.paperclip/secrets/notify-token` — 0600 perm, 32-char hex token, shared between paperclip + hermes
- `~/.hermes/secrets/notify-token` — same content (separate file for separation of concerns; both repos read their own copy)

---

## Phase 1 — Paperclip DB schema + migration

### Task 1.1: Create migration file with schema

**Files:**
- Create: `server/src/db/schema/routine-check-runs.ts`

- [ ] **Step 1: Write drizzle table definition**

```ts
// server/src/db/schema/routine-check-runs.ts
import { pgTable, uuid, text, timestamp, integer, jsonb, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';

export const routineCheckRuns = pgTable(
  'routine_check_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checkName: text('check_name').notNull(),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).notNull(),
    status: text('status').notNull(),                // ok | warn | error
    findings: integer('findings').notNull(),
    notifyChannel: text('notify_channel').notNull(), // silent | threshold | telegram
    payloadJson: jsonb('payload_json').notNull(),
    notified: boolean('notified').notNull().default(false),
    durationMs: integer('duration_ms'),
    errorText: text('error_text'),
  },
  (t) => ({
    checkScheduledUnique: uniqueIndex('routine_check_runs_check_scheduled_unq').on(t.checkName, t.scheduledFor),
    checkRunAtIdx: index('routine_check_runs_check_run_at_idx').on(t.checkName, t.runAt),
    checkStatusRunAtIdx: index('routine_check_runs_check_status_run_at_idx').on(t.checkName, t.status, t.runAt),
  }),
);

export type RoutineCheckRun = typeof routineCheckRuns.$inferSelect;
export type NewRoutineCheckRun = typeof routineCheckRuns.$inferInsert;
```

- [ ] **Step 2: Export from schema index**

Modify `server/src/db/schema/index.ts` — add line:

```ts
export * from './routine-check-runs.js';
```

- [ ] **Step 3: Generate migration**

Run: `pnpm --filter @paperclipai/db generate`
Expected: New file `server/src/db/migrations/<NNNN>_<name>.sql` containing CREATE TABLE + indexes.

- [ ] **Step 4: Apply migration to local DB**

Run: `pnpm --filter @paperclipai/db migrate`
Expected: psql output shows `routine_check_runs` table created.

- [ ] **Step 5: Verify table + indexes**

Run: `psql -h localhost -U paperclip -d paperclip -c '\d routine_check_runs'`
Expected: Table with 11 columns, 3 indexes (unique on check_name+scheduled_for, two indexes on check_name+run_at variants).

- [ ] **Step 6: Commit**

```bash
git add server/src/db/schema/routine-check-runs.ts server/src/db/schema/index.ts server/src/db/migrations/
git commit -m "feat(db): add routine_check_runs table for routine checks"
```

---

## Phase 2 — Type definitions + Registry

### Task 2.1: Define core types

**Files:**
- Create: `server/src/services/routine-checks/types.ts`

- [ ] **Step 1: Write types**

```ts
// server/src/services/routine-checks/types.ts
import type { Logger } from 'pino';
import type { Db } from '../../db/index.js';

export type NotifyChannel = 'silent' | 'threshold' | 'telegram';
export type CheckStatus = 'ok' | 'warn' | 'error';
export type ThresholdSeverity = 'warn' | 'error';

export interface CheckCtx {
  db: Db;
  logger: Logger;
  now: () => Date;
}

export interface CheckResult {
  status: CheckStatus;
  findings: number;
  payload: Record<string, unknown>;
  summary: string;
}

export interface CheckDef {
  name: string;
  schedule: string;                  // 5-field cron expr
  notify: NotifyChannel;
  thresholdSeverity?: ThresholdSeverity;
  run: (ctx: CheckCtx) => Promise<CheckResult>;
}
```

- [ ] **Step 2: Commit**

```bash
git add server/src/services/routine-checks/types.ts
git commit -m "feat(routine-checks): add core types"
```

### Task 2.2: Registry with name uniqueness

**Files:**
- Create: `server/src/services/routine-checks/registry.ts`
- Test: `server/src/services/routine-checks/__tests__/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/registry.test.ts
import { describe, it, expect } from 'vitest';
import { Registry } from '../registry.js';
import type { CheckDef } from '../types.js';

const def: CheckDef = {
  name: 'x',
  schedule: '*/5 * * * *',
  notify: 'silent',
  run: async () => ({ status: 'ok', findings: 0, payload: {}, summary: '' }),
};

describe('Registry', () => {
  it('registers a check by name', () => {
    const r = new Registry();
    r.register(def);
    expect(r.get('x')).toBe(def);
  });

  it('throws on duplicate name', () => {
    const r = new Registry();
    r.register(def);
    expect(() => r.register(def)).toThrow(/duplicate/i);
  });

  it('throws on invalid cron expression', () => {
    const r = new Registry();
    expect(() =>
      r.register({ ...def, schedule: 'not-a-cron' }),
    ).toThrow(/cron/i);
  });

  it('lists all registered checks', () => {
    const r = new Registry();
    r.register(def);
    r.register({ ...def, name: 'y' });
    expect(r.list().map((d) => d.name).sort()).toEqual(['x', 'y']);
  });
});
```

- [ ] **Step 2: Run test (should fail — Registry not exist)**

Run: `pnpm --filter @paperclipai/server vitest run services/routine-checks/__tests__/registry.test.ts`
Expected: FAIL with "Cannot find module '../registry.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/routine-checks/registry.ts
import { parseCron } from '../cron.js';
import type { CheckDef } from './types.js';

export class Registry {
  private checks = new Map<string, CheckDef>();

  register(def: CheckDef): void {
    if (this.checks.has(def.name)) {
      throw new Error(`Duplicate check name: ${def.name}`);
    }
    parseCron(def.schedule); // validates, throws on invalid
    this.checks.set(def.name, def);
  }

  get(name: string): CheckDef | undefined {
    return this.checks.get(name);
  }

  list(): CheckDef[] {
    return [...this.checks.values()];
  }
}
```

- [ ] **Step 4: Run tests (should pass)**

Run: `pnpm --filter @paperclipai/server vitest run services/routine-checks/__tests__/registry.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/registry.ts server/src/services/routine-checks/__tests__/registry.test.ts
git commit -m "feat(routine-checks): add registry with name + cron validation"
```

---

## Phase 3 — Notify Dispatcher

### Task 3.1: Notify dispatcher with state-change recovery

**Files:**
- Create: `server/src/services/routine-checks/notify.ts`
- Test: `server/src/services/routine-checks/__tests__/notify.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// __tests__/notify.test.ts
import { describe, it, expect, vi } from 'vitest';
import { shouldNotify, buildSummary, computeContentHash } from '../notify.js';

describe('shouldNotify', () => {
  it('silent + stable ok → no notify', () => {
    expect(shouldNotify({ channel: 'silent', currentStatus: 'ok', previousStatus: 'ok', findings: 0 })).toBe(false);
  });

  it('silent + first-run warn → no notify (no recovery context)', () => {
    expect(shouldNotify({ channel: 'silent', currentStatus: 'warn', previousStatus: null, findings: 1 })).toBe(false);
  });

  it('silent + state-change error→ok → notify (recovery)', () => {
    expect(shouldNotify({ channel: 'silent', currentStatus: 'ok', previousStatus: 'error', findings: 0 })).toBe(true);
  });

  it('silent + state-change ok→warn → no notify (silent channel)', () => {
    // silent only notifies on recovery FROM warn/error TO ok
    expect(shouldNotify({ channel: 'silent', currentStatus: 'warn', previousStatus: 'ok', findings: 1 })).toBe(false);
  });

  it('threshold (severity=warn) + warn → notify', () => {
    expect(shouldNotify({ channel: 'threshold', thresholdSeverity: 'warn', currentStatus: 'warn', previousStatus: 'ok', findings: 1 })).toBe(true);
  });

  it('threshold (severity=warn) + ok with no state-change → no notify', () => {
    expect(shouldNotify({ channel: 'threshold', thresholdSeverity: 'warn', currentStatus: 'ok', previousStatus: 'ok', findings: 0 })).toBe(false);
  });

  it('threshold + state-change warn→ok → notify (recovery)', () => {
    expect(shouldNotify({ channel: 'threshold', thresholdSeverity: 'warn', currentStatus: 'ok', previousStatus: 'warn', findings: 0 })).toBe(true);
  });

  it('telegram + findings=0 stable → no notify', () => {
    expect(shouldNotify({ channel: 'telegram', currentStatus: 'ok', previousStatus: 'ok', findings: 0 })).toBe(false);
  });

  it('telegram + findings=5 → notify', () => {
    expect(shouldNotify({ channel: 'telegram', currentStatus: 'warn', previousStatus: 'warn', findings: 5 })).toBe(true);
  });
});

describe('buildSummary', () => {
  it('prefixes recovery on warn→ok', () => {
    expect(buildSummary({ original: 'all clean', previousStatus: 'warn', currentStatus: 'ok' })).toBe('✅ recovery — all clean');
  });

  it('prefixes recovery on error→ok', () => {
    expect(buildSummary({ original: 'restored', previousStatus: 'error', currentStatus: 'ok' })).toBe('✅ recovery — restored');
  });

  it('passes through on stable warn', () => {
    expect(buildSummary({ original: '3 drift', previousStatus: 'warn', currentStatus: 'warn' })).toBe('3 drift');
  });

  it('passes through on first-run', () => {
    expect(buildSummary({ original: 'hello', previousStatus: null, currentStatus: 'ok' })).toBe('hello');
  });
});

describe('computeContentHash', () => {
  it('returns deterministic sha256 prefix', () => {
    const a = computeContentHash({ summary: 'x', findings: 1, examples: ['a', 'b', 'c'] });
    const b = computeContentHash({ summary: 'x', findings: 1, examples: ['a', 'b', 'c'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256-[0-9a-f]{16,}$/);
  });

  it('changes when examples change', () => {
    const a = computeContentHash({ summary: 'x', findings: 1, examples: ['a'] });
    const b = computeContentHash({ summary: 'x', findings: 1, examples: ['b'] });
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run tests (should fail)**

Run: `pnpm --filter @paperclipai/server vitest run services/routine-checks/__tests__/notify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

```ts
// server/src/services/routine-checks/notify.ts
import { createHash } from 'node:crypto';
import type { CheckStatus, NotifyChannel, ThresholdSeverity } from './types.js';

const SEVERITY_RANK: Record<CheckStatus, number> = { ok: 0, warn: 1, error: 2 };

export interface ShouldNotifyArgs {
  channel: NotifyChannel;
  thresholdSeverity?: ThresholdSeverity;
  currentStatus: CheckStatus;
  previousStatus: CheckStatus | null;
  findings: number;
}

export function shouldNotify(a: ShouldNotifyArgs): boolean {
  const stateChange = a.previousStatus !== null && a.previousStatus !== a.currentStatus;
  const recoveryFromBad = stateChange &&
    a.previousStatus !== null &&
    SEVERITY_RANK[a.previousStatus] > 0 &&
    a.currentStatus === 'ok';

  switch (a.channel) {
    case 'silent':
      return recoveryFromBad;
    case 'threshold': {
      const meetsThreshold =
        a.thresholdSeverity !== undefined &&
        SEVERITY_RANK[a.currentStatus] >= SEVERITY_RANK[a.thresholdSeverity];
      return meetsThreshold || stateChange;
    }
    case 'telegram':
      return a.findings > 0 || stateChange;
  }
}

export interface BuildSummaryArgs {
  original: string;
  previousStatus: CheckStatus | null;
  currentStatus: CheckStatus;
}

export function buildSummary(a: BuildSummaryArgs): string {
  const recovery =
    a.previousStatus !== null &&
    SEVERITY_RANK[a.previousStatus] > 0 &&
    a.currentStatus === 'ok';
  return recovery ? `✅ recovery — ${a.original}` : a.original;
}

export interface ContentHashInput {
  summary: string;
  findings: number;
  examples: string[];
}

export function computeContentHash(i: ContentHashInput): string {
  const top3 = i.examples.slice(0, 3).join('|');
  const raw = `${i.summary} ${i.findings} ${top3}`;
  return `sha256-${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;
}
```

- [ ] **Step 4: Run tests (should pass)**

Run: `pnpm --filter @paperclipai/server vitest run services/routine-checks/__tests__/notify.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/notify.ts server/src/services/routine-checks/__tests__/notify.test.ts
git commit -m "feat(routine-checks): add notify dispatcher with state-change recovery"
```

### Task 3.2: HTTP webhook poster

**Files:**
- Modify: `server/src/services/routine-checks/notify.ts`
- Test: same file's test

- [ ] **Step 1: Add failing test for webhook poster**

Append to `__tests__/notify.test.ts`:

```ts
import { postWebhook } from '../notify.js';

describe('postWebhook', () => {
  it('POSTs payload with bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    };
    const ok = await postWebhook({
      url: 'http://localhost:9999/paperclip/notify',
      token: 'secret',
      payload: { check: 'x', status: 'ok', summary: 'y' } as any,
      fetcher,
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as any).Authorization).toBe('Bearer secret');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ check: 'x', status: 'ok', summary: 'y' });
  });

  it('returns false on non-2xx', async () => {
    const fetcher = async () => new Response('nope', { status: 401 });
    const ok = await postWebhook({
      url: 'http://x',
      token: 't',
      payload: {} as any,
      fetcher,
    });
    expect(ok).toBe(false);
  });

  it('returns false on network error', async () => {
    const fetcher = async () => { throw new Error('connect refused'); };
    const ok = await postWebhook({
      url: 'http://x',
      token: 't',
      payload: {} as any,
      fetcher,
    });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (FAIL — postWebhook not exported)**

Run: `pnpm --filter @paperclipai/server vitest run services/routine-checks/__tests__/notify.test.ts -t postWebhook`

- [ ] **Step 3: Implement postWebhook**

Append to `server/src/services/routine-checks/notify.ts`:

```ts
export interface WebhookPayload {
  check: string;
  status: CheckStatus;
  previous_status: CheckStatus | null;
  findings: number;
  summary: string;
  content_hash: string;
  scheduled_for: string;        // ISO 8601
  details_hint: string;
}

export interface PostWebhookArgs {
  url: string;
  token: string;
  payload: WebhookPayload;
  fetcher?: typeof fetch;
}

export async function postWebhook(a: PostWebhookArgs): Promise<boolean> {
  const f = a.fetcher ?? fetch;
  try {
    const res = await f(a.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${a.token}`,
      },
      body: JSON.stringify(a.payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: same command. Expected: all 3 webhook tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/notify.ts server/src/services/routine-checks/__tests__/notify.test.ts
git commit -m "feat(routine-checks): add webhook poster with bearer auth"
```

---

## Phase 4 — Runner with catch-up + race protection

### Task 4.1: Compute previousStatus

**Files:**
- Create: `server/src/services/routine-checks/runner.ts`
- Test: `server/src/services/routine-checks/__tests__/runner.test.ts`

- [ ] **Step 1: Failing test for previousStatus query**

```ts
// __tests__/runner.test.ts (start)
import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from '../../../__tests__/helpers/db.js'; // existing helper if available, otherwise create per integration-test pattern in repo
import { computePreviousStatus, insertOrSkipRun } from '../runner.js';
import { routineCheckRuns } from '../../../db/schema/index.js';

describe('computePreviousStatus', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;

  beforeEach(async () => {
    db = await setupTestDb();
  });

  it('returns null when no prior run', async () => {
    const r = await computePreviousStatus({ db, checkName: 'x', currentId: '00000000-0000-0000-0000-000000000000' });
    expect(r).toBeNull();
  });

  it('returns latest status by scheduled_for, excluding current id', async () => {
    await db.insert(routineCheckRuns).values([
      { checkName: 'x', scheduledFor: new Date('2026-04-30T08:00:00Z'), runAt: new Date(), status: 'warn', findings: 1, notifyChannel: 'silent', payloadJson: {} },
      { checkName: 'x', scheduledFor: new Date('2026-04-30T09:00:00Z'), runAt: new Date(), status: 'ok',   findings: 0, notifyChannel: 'silent', payloadJson: {} },
    ]);
    const cur = await db.insert(routineCheckRuns).values({
      checkName: 'x', scheduledFor: new Date('2026-04-30T10:00:00Z'), runAt: new Date(), status: 'ok', findings: 0, notifyChannel: 'silent', payloadJson: {},
    }).returning();
    const r = await computePreviousStatus({ db, checkName: 'x', currentId: cur[0]!.id });
    expect(r).toBe('ok');
  });
});
```

- [ ] **Step 2: Run test (FAIL — module missing)**

Run: `pnpm --filter @paperclipai/server vitest run services/routine-checks/__tests__/runner.test.ts -t computePreviousStatus`

- [ ] **Step 3: Implement**

```ts
// server/src/services/routine-checks/runner.ts (start)
import { eq, and, ne, desc } from 'drizzle-orm';
import { routineCheckRuns } from '../../db/schema/index.js';
import type { CheckStatus } from './types.js';
import type { Db } from '../../db/index.js';

export async function computePreviousStatus(args: {
  db: Db;
  checkName: string;
  currentId: string;
}): Promise<CheckStatus | null> {
  const rows = await args.db
    .select({ status: routineCheckRuns.status })
    .from(routineCheckRuns)
    .where(and(eq(routineCheckRuns.checkName, args.checkName), ne(routineCheckRuns.id, args.currentId)))
    .orderBy(desc(routineCheckRuns.scheduledFor))
    .limit(1);
  return rows[0] ? (rows[0].status as CheckStatus) : null;
}
```

- [ ] **Step 4: Run test (PASS)**

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/runner.ts server/src/services/routine-checks/__tests__/runner.test.ts
git commit -m "feat(routine-checks): add previousStatus query"
```

### Task 4.2: Insert-or-skip with ON CONFLICT

**Files:**
- Modify: `server/src/services/routine-checks/runner.ts`

- [ ] **Step 1: Failing test**

Append to `runner.test.ts`:

```ts
describe('insertOrSkipRun', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  beforeEach(async () => { db = await setupTestDb(); });

  it('inserts new row and returns id', async () => {
    const id = await insertOrSkipRun({
      db,
      checkName: 'x',
      scheduledFor: new Date('2026-04-30T09:00:00Z'),
      notifyChannel: 'silent',
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);
  });

  it('returns null when row already exists for same (check, scheduled_for)', async () => {
    const args = {
      db,
      checkName: 'x',
      scheduledFor: new Date('2026-04-30T09:00:00Z'),
      notifyChannel: 'silent' as const,
    };
    const first = await insertOrSkipRun(args);
    const second = await insertOrSkipRun(args);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

- [ ] **Step 3: Implement using `onConflictDoNothing`**

Append to `runner.ts`:

```ts
import { sql } from 'drizzle-orm';
import type { NotifyChannel } from './types.js';

export async function insertOrSkipRun(args: {
  db: Db;
  checkName: string;
  scheduledFor: Date;
  notifyChannel: NotifyChannel;
}): Promise<string | null> {
  const rows = await args.db
    .insert(routineCheckRuns)
    .values({
      checkName: args.checkName,
      scheduledFor: args.scheduledFor,
      runAt: new Date(),
      status: 'ok',                  // placeholder, updated when check completes
      findings: 0,
      notifyChannel: args.notifyChannel,
      payloadJson: { _state: 'running' },
    })
    .onConflictDoNothing({ target: [routineCheckRuns.checkName, routineCheckRuns.scheduledFor] })
    .returning({ id: routineCheckRuns.id });
  return rows[0]?.id ?? null;
}
```

- [ ] **Step 4: Run tests (PASS)**

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/runner.ts server/src/services/routine-checks/__tests__/runner.test.ts
git commit -m "feat(routine-checks): add insert-or-skip race protection"
```

### Task 4.3: Tick — full execute pipeline for one slot

**Files:**
- Modify: `server/src/services/routine-checks/runner.ts`

- [ ] **Step 1: Failing test for `runOne` end-to-end**

Append to `runner.test.ts`:

```ts
import { runOne } from '../runner.js';
import type { CheckDef } from '../types.js';

describe('runOne', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  beforeEach(async () => { db = await setupTestDb(); });

  it('executes check, persists row, dispatches notify when shouldNotify=true', async () => {
    const def: CheckDef = {
      name: 'demo',
      schedule: '*/5 * * * *',
      notify: 'telegram',
      run: async () => ({ status: 'warn', findings: 3, payload: { foo: 1 }, summary: '3 drift' }),
    };
    const posts: any[] = [];
    const result = await runOne({
      db,
      def,
      scheduledFor: new Date('2026-04-30T09:00:00Z'),
      logger: { info: () => {}, error: () => {}, warn: () => {} } as any,
      now: () => new Date(),
      webhook: { url: 'http://localhost', token: 't', fetcher: async (_url, init) => { posts.push(JSON.parse((init!.body as string)!)); return new Response('{}', { status: 200 }); } },
    });

    expect(result.skipped).toBe(false);
    expect(result.notified).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0].check).toBe('demo');
    expect(posts[0].findings).toBe(3);
    expect(posts[0].previous_status).toBeNull();

    const rows = await db.select().from(routineCheckRuns);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('warn');
    expect(rows[0]!.findings).toBe(3);
    expect(rows[0]!.notified).toBe(true);
  });

  it('skips when slot already has a row (lost race)', async () => {
    const def: CheckDef = { name: 'demo', schedule: '*/5 * * * *', notify: 'silent', run: async () => ({ status: 'ok', findings: 0, payload: {}, summary: '' }) };
    const slot = new Date('2026-04-30T09:00:00Z');
    const r1 = await runOne({ db, def, scheduledFor: slot, logger: { info(){}, error(){}, warn(){} } as any, now: () => new Date(), webhook: undefined });
    const r2 = await runOne({ db, def, scheduledFor: slot, logger: { info(){}, error(){}, warn(){} } as any, now: () => new Date(), webhook: undefined });
    expect(r1.skipped).toBe(false);
    expect(r2.skipped).toBe(true);
  });

  it('records error when check throws', async () => {
    const def: CheckDef = { name: 'broken', schedule: '*/5 * * * *', notify: 'threshold', thresholdSeverity: 'error', run: async () => { throw new Error('boom'); } };
    const result = await runOne({ db, def, scheduledFor: new Date('2026-04-30T09:00:00Z'), logger: { info(){}, error(){}, warn(){} } as any, now: () => new Date(), webhook: undefined });
    expect(result.skipped).toBe(false);
    const rows = await db.select().from(routineCheckRuns);
    expect(rows[0]!.status).toBe('error');
    expect(rows[0]!.errorText).toContain('boom');
  });
});
```

- [ ] **Step 2: Run tests (FAIL — runOne not implemented)**

- [ ] **Step 3: Implement runOne**

Append to `runner.ts`:

```ts
import { computeContentHash, postWebhook, shouldNotify, buildSummary } from './notify.js';
import type { CheckDef, CheckResult } from './types.js';
import type { Logger } from 'pino';

export interface WebhookCfg {
  url: string;
  token: string;
  fetcher?: typeof fetch;
}

export interface RunOneArgs {
  db: Db;
  def: CheckDef;
  scheduledFor: Date;
  logger: Logger;
  now: () => Date;
  webhook: WebhookCfg | undefined;
}

export interface RunOneResult {
  skipped: boolean;
  notified: boolean;
  status: CheckStatus | null;
}

export async function runOne(args: RunOneArgs): Promise<RunOneResult> {
  const id = await insertOrSkipRun({
    db: args.db,
    checkName: args.def.name,
    scheduledFor: args.scheduledFor,
    notifyChannel: args.def.notify,
  });
  if (id === null) {
    return { skipped: true, notified: false, status: null };
  }

  const start = args.now().getTime();
  let result: CheckResult;
  let errorText: string | null = null;

  try {
    result = await args.def.run({ db: args.db, logger: args.logger, now: args.now });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errorText = msg;
    result = { status: 'error', findings: 0, payload: { error: msg }, summary: `error: ${msg}` };
  }

  const previousStatus = await computePreviousStatus({ db: args.db, checkName: args.def.name, currentId: id });
  const willNotify = shouldNotify({
    channel: args.def.notify,
    thresholdSeverity: args.def.thresholdSeverity,
    currentStatus: result.status,
    previousStatus,
    findings: result.findings,
  });

  let notified = false;
  if (willNotify && args.webhook) {
    const summary = buildSummary({ original: result.summary, previousStatus, currentStatus: result.status });
    const examples = Array.isArray((result.payload as any).examples) ? (result.payload as any).examples : [];
    const hash = computeContentHash({ summary, findings: result.findings, examples });
    notified = await postWebhook({
      url: args.webhook.url,
      token: args.webhook.token,
      fetcher: args.webhook.fetcher,
      payload: {
        check: args.def.name,
        status: result.status,
        previous_status: previousStatus,
        findings: result.findings,
        summary,
        content_hash: hash,
        scheduled_for: args.scheduledFor.toISOString(),
        details_hint: `paperclip checks history ${args.def.name} --limit 1`,
      },
    });
  }

  await args.db
    .update(routineCheckRuns)
    .set({
      status: result.status,
      findings: result.findings,
      payloadJson: result.payload,
      durationMs: args.now().getTime() - start,
      errorText,
      notified,
    })
    .where(eq(routineCheckRuns.id, id));

  return { skipped: false, notified, status: result.status };
}
```

- [ ] **Step 4: Run tests (PASS)**

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/runner.ts server/src/services/routine-checks/__tests__/runner.test.ts
git commit -m "feat(routine-checks): add runOne with insert/run/notify/update pipeline"
```

### Task 4.4: Tick all + catch-up

**Files:**
- Modify: `server/src/services/routine-checks/runner.ts`

- [ ] **Step 1: Failing test for catch-up**

Append to `runner.test.ts`:

```ts
import { catchUpAll, tickAll } from '../runner.js';
import { Registry } from '../registry.js';

describe('catchUpAll', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  beforeEach(async () => { db = await setupTestDb(); });

  it('runs the most recent missed slot when no prior runs', async () => {
    const reg = new Registry();
    let called = 0;
    reg.register({
      name: 'demo',
      schedule: '0 * * * *',  // every hour at :00
      notify: 'silent',
      run: async () => { called++; return { status: 'ok', findings: 0, payload: {}, summary: '' }; },
    });
    const fakeNow = new Date('2026-04-30T09:30:00Z');
    await catchUpAll({ db, registry: reg, now: () => fakeNow, logger: { info(){}, error(){}, warn(){} } as any, webhook: undefined });
    expect(called).toBe(1);
    const rows = await db.select().from(routineCheckRuns);
    expect(rows[0]!.scheduledFor.toISOString()).toBe('2026-04-30T09:00:00.000Z');
  });

  it('does not re-run if last scheduled_for matches most recent past slot', async () => {
    const reg = new Registry();
    let called = 0;
    reg.register({
      name: 'demo',
      schedule: '0 * * * *',
      notify: 'silent',
      run: async () => { called++; return { status: 'ok', findings: 0, payload: {}, summary: '' }; },
    });
    const fakeNow = new Date('2026-04-30T09:30:00Z');
    await db.insert(routineCheckRuns).values({
      checkName: 'demo', scheduledFor: new Date('2026-04-30T09:00:00Z'), runAt: new Date(), status: 'ok', findings: 0, notifyChannel: 'silent', payloadJson: {},
    });
    await catchUpAll({ db, registry: reg, now: () => fakeNow, logger: { info(){}, error(){}, warn(){} } as any, webhook: undefined });
    expect(called).toBe(0);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

- [ ] **Step 3: Implement catchUpAll + tickAll**

Append to `runner.ts`:

```ts
import { mostRecentPastSlot, parseCron, nextSlotAfter } from '../cron.js';
import type { Registry } from './registry.js';
import { max as drizzleMax } from 'drizzle-orm';

export async function catchUpAll(args: {
  db: Db;
  registry: Registry;
  now: () => Date;
  logger: Logger;
  webhook: WebhookCfg | undefined;
}): Promise<void> {
  for (const def of args.registry.list()) {
    const cron = parseCron(def.schedule);
    const lastSlot = mostRecentPastSlot(cron, args.now());
    if (!lastSlot) continue;

    const rows = await args.db
      .select({ scheduled: routineCheckRuns.scheduledFor })
      .from(routineCheckRuns)
      .where(eq(routineCheckRuns.checkName, def.name))
      .orderBy(desc(routineCheckRuns.scheduledFor))
      .limit(1);
    const lastRecorded = rows[0]?.scheduled?.getTime() ?? 0;

    if (lastSlot.getTime() > lastRecorded) {
      args.logger.info({ check: def.name, slot: lastSlot.toISOString() }, 'catch-up running missed slot');
      await runOne({ db: args.db, def, scheduledFor: lastSlot, logger: args.logger, now: args.now, webhook: args.webhook });
    }
  }
}

export async function tickAll(args: {
  db: Db;
  registry: Registry;
  now: () => Date;
  logger: Logger;
  webhook: WebhookCfg | undefined;
}): Promise<void> {
  for (const def of args.registry.list()) {
    const cron = parseCron(def.schedule);
    const slot = mostRecentPastSlot(cron, args.now());
    if (!slot) continue;
    // only run if "due now" — i.e., within last minute window
    const ageMs = args.now().getTime() - slot.getTime();
    if (ageMs > 60_000) continue;
    await runOne({ db: args.db, def, scheduledFor: slot, logger: args.logger, now: args.now, webhook: args.webhook });
  }
}
```

If `mostRecentPastSlot` and `nextSlotAfter` do not exist in `services/cron.ts`, add them in this same task:

```ts
// server/src/services/cron.ts (additions)
export function mostRecentPastSlot(cron: ParsedCron, ref: Date): Date | null {
  // walk back minute-by-minute up to 7 days; for each minute, check if it matches all 5 fields
  const start = new Date(ref);
  start.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 7; i++) {
    const t = new Date(start.getTime() - i * 60_000);
    if (matchesCron(cron, t)) return t;
  }
  return null;
}

function matchesCron(c: ParsedCron, t: Date): boolean {
  return (
    c.minutes.includes(t.getMinutes()) &&
    c.hours.includes(t.getHours()) &&
    c.daysOfMonth.includes(t.getDate()) &&
    c.months.includes(t.getMonth() + 1) &&
    c.daysOfWeek.includes(t.getDay())
  );
}

export function nextSlotAfter(cron: ParsedCron, ref: Date): Date | null {
  const start = new Date(ref);
  start.setSeconds(0, 0);
  for (let i = 1; i <= 60 * 24 * 7; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    if (matchesCron(cron, t)) return t;
  }
  return null;
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `pnpm --filter @paperclipai/server vitest run services/routine-checks`
Expected: all runner tests + previous tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/runner.ts server/src/services/routine-checks/__tests__/runner.test.ts server/src/services/cron.ts
git commit -m "feat(routine-checks): add catchUpAll + tickAll with cron slot helpers"
```

---

## Phase 5 — Check #1 workspace-drift-guard

### Task 5.1: Implement workspace-drift-guard

**Files:**
- Create: `server/src/services/routine-checks/checks/workspace-drift-guard.ts`
- Test: `server/src/services/routine-checks/__tests__/checks/workspace-drift-guard.test.ts`

- [ ] **Step 1: Read source SQL**

Read `~/.hermes/cron/jobs.json` job `d2c9532bbc77` prompt. Extract the 4 indicators:
- `local_agent_cwd_outside`
- `active_exec_ws_outside`
- `open_issues_without_project_workspace`
- `run_event_context_cwd_outside_24h`

Soll-Prefix: `/Users/marco/.openclaw/workspace`. Companies: HAPPYGANG, Casa Marco.

- [ ] **Step 2: Failing test with fixtures**

```ts
// __tests__/checks/workspace-drift-guard.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { workspaceDriftGuard } from '../../checks/workspace-drift-guard.js';
import { setupTestDb } from '../../../../__tests__/helpers/db.js';
import { companies, agents, executionWorkspaces, issues, heartbeatRunEvents } from '../../../../db/schema/index.js';

describe('workspace-drift-guard', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  beforeEach(async () => { db = await setupTestDb(); });

  it('reports zero drift when all cwd inside prefix', async () => {
    await db.insert(companies).values([{ id: 'c1', name: 'HAPPYGANG' }]);
    await db.insert(agents).values([{ id: 'a1', companyId: 'c1', adapterType: 'claude_local', adapterConfig: { cwd: '/Users/marco/.openclaw/workspace/projects/x' } }]);
    const r = await workspaceDriftGuard.run({ db, logger: console as any, now: () => new Date() });
    expect(r.status).toBe('ok');
    expect(r.findings).toBe(0);
  });

  it('reports drift when an agent cwd is outside prefix', async () => {
    await db.insert(companies).values([{ id: 'c1', name: 'HAPPYGANG' }]);
    await db.insert(agents).values([{ id: 'a1', companyId: 'c1', adapterType: 'claude_local', adapterConfig: { cwd: '/tmp/somewhere' } }]);
    const r = await workspaceDriftGuard.run({ db, logger: console as any, now: () => new Date() });
    expect(r.status).toBe('warn');
    expect(r.findings).toBeGreaterThanOrEqual(1);
    expect(r.payload).toHaveProperty('companies');
  });
});
```

(Note: real schema column names may differ — verify with `pnpm --filter @paperclipai/db ts-node ...` or by reading `server/src/db/schema/`. Adjust test fixtures accordingly.)

- [ ] **Step 3: Run test (FAIL)**

- [ ] **Step 4: Implement check**

```ts
// server/src/services/routine-checks/checks/workspace-drift-guard.ts
import { sql } from 'drizzle-orm';
import type { CheckDef, CheckCtx, CheckResult } from '../types.js';

const PREFIX = '/Users/marco/.openclaw/workspace';
const LOCAL_ADAPTERS = ['claude_local', 'codex_local', 'hermes_local'];

interface CompanyDrift {
  name: string;
  local_agent_cwd_outside: number;
  active_exec_ws_outside: number;
  open_issues_without_project_workspace: number;
  run_event_context_cwd_outside_24h: number;
}

async function run(ctx: CheckCtx): Promise<CheckResult> {
  const companies = await ctx.db.execute(sql`SELECT id, name FROM companies WHERE name IN ('HAPPYGANG', 'Casa Marco')`);

  const result: CompanyDrift[] = [];
  const examples: string[] = [];

  for (const c of companies.rows as Array<{ id: string; name: string }>) {
    const a = await ctx.db.execute(sql`
      SELECT count(*) AS n
        FROM agents
       WHERE company_id = ${c.id}
         AND adapter_type = ANY(${LOCAL_ADAPTERS})
         AND COALESCE(adapter_config->>'cwd', '') <> ''
         AND COALESCE(adapter_config->>'cwd', '') NOT LIKE ${PREFIX + '%'}
    `);
    const ews = await ctx.db.execute(sql`
      SELECT count(*) AS n
        FROM execution_workspaces
       WHERE company_id = ${c.id}
         AND status = 'active'
         AND COALESCE(provider_ref, cwd, '') <> ''
         AND COALESCE(provider_ref, cwd, '') NOT LIKE ${PREFIX + '%'}
    `);
    const iss = await ctx.db.execute(sql`
      SELECT count(*) AS n
        FROM issues i
        LEFT JOIN project_workspaces pw ON pw.project_id = i.project_id
       WHERE i.company_id = ${c.id}
         AND i.status NOT IN ('done','cancelled')
         AND pw.id IS NULL
    `);
    const re = await ctx.db.execute(sql`
      SELECT count(*) AS n
        FROM heartbeat_run_events
       WHERE company_id = ${c.id}
         AND created_at > NOW() - INTERVAL '24 hours'
         AND COALESCE(payload->'context'->'paperclipWorkspace'->>'cwd', '') <> ''
         AND COALESCE(payload->'context'->'paperclipWorkspace'->>'cwd', '') NOT LIKE ${PREFIX + '%'}
    `);
    const ex = await ctx.db.execute(sql`
      SELECT DISTINCT COALESCE(provider_ref, cwd) AS path
        FROM execution_workspaces
       WHERE company_id = ${c.id}
         AND COALESCE(provider_ref, cwd, '') NOT LIKE ${PREFIX + '%'}
       LIMIT 3
    `);

    const drift: CompanyDrift = {
      name: c.name,
      local_agent_cwd_outside: Number((a.rows[0] as any).n),
      active_exec_ws_outside: Number((ews.rows[0] as any).n),
      open_issues_without_project_workspace: Number((iss.rows[0] as any).n),
      run_event_context_cwd_outside_24h: Number((re.rows[0] as any).n),
    };
    result.push(drift);
    for (const r of ex.rows as Array<{ path: string }>) examples.push(`${c.name}:${r.path}`);
  }

  const findings = result.reduce(
    (acc, c) =>
      acc + c.local_agent_cwd_outside + c.active_exec_ws_outside + c.open_issues_without_project_workspace + c.run_event_context_cwd_outside_24h,
    0,
  );

  const status = findings > 0 ? 'warn' : 'ok';
  const summary = result.map((c) => `${c.name}: ${c.local_agent_cwd_outside}/${c.active_exec_ws_outside}/${c.open_issues_without_project_workspace}/${c.run_event_context_cwd_outside_24h}`).join(', ');

  return {
    status,
    findings,
    payload: { companies: result, examples },
    summary: findings > 0 ? `Drift: ${summary}` : 'no drift',
  };
}

export const workspaceDriftGuard: CheckDef = {
  name: 'workspace-drift-guard',
  schedule: '0 9,18,22 * * *',
  notify: 'threshold',
  thresholdSeverity: 'warn',
  run,
};
```

(Note: actual SQL must match real schema column names — verify against `server/src/db/schema/` before committing.)

- [ ] **Step 5: Run tests (PASS, may need to align fixtures with real columns)**

- [ ] **Step 6: Smoke against real DB**

Run: `pnpm --filter @paperclipai/server tsx -e "import('./services/routine-checks/checks/workspace-drift-guard.js').then(m => m.workspaceDriftGuard.run({db: <get db>, logger: console, now: () => new Date()})).then(console.log)"`
Compare output to last Hermes-run from `~/.hermes/cron/output/d2c9532bbc77/`.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/routine-checks/checks/workspace-drift-guard.ts server/src/services/routine-checks/__tests__/checks/workspace-drift-guard.test.ts
git commit -m "feat(routine-checks): add workspace-drift-guard"
```

---

## Phase 6 — Check #2 subscription-shadow-sync

### Task 6.1: Port shell script to TS

**Files:**
- Create: `server/src/services/routine-checks/checks/subscription-shadow-sync.ts`
- Test: `server/src/services/routine-checks/__tests__/checks/subscription-shadow-sync.test.ts`

- [ ] **Step 1: Read original script**

`cat ~/.openclaw/workspace/scripts/paperclip-subscription-shadow-sync.sh` — capture exact SQL/logic.

- [ ] **Step 2: Failing test**

```ts
// __tests__/checks/subscription-shadow-sync.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { subscriptionShadowSync } from '../../checks/subscription-shadow-sync.js';
import { setupTestDb } from '../../../../__tests__/helpers/db.js';

describe('subscription-shadow-sync', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  beforeEach(async () => { db = await setupTestDb(); });

  it('returns ok with 0 inserted when no new shadow events', async () => {
    const r = await subscriptionShadowSync.run({ db, logger: console as any, now: () => new Date() });
    expect(r.status).toBe('ok');
    expect((r.payload as any).inserted_shadow_events).toBe(0);
  });

  it('returns warn=spike when inserted_shadow_events exceeds P95*3', async () => {
    process.env.PAPERCLIP_SHADOW_SYNC_P95 = '5';
    // seed fixtures producing >15 inserts via shadow logic
    // ...
    const r = await subscriptionShadowSync.run({ db, logger: console as any, now: () => new Date() });
    expect(r.status).toBe('warn');
    expect((r.payload as any).spike).toBe(true);
  });

  it('returns error on SQL failure', async () => {
    // simulate by passing a db that rejects
    const brokenDb = { execute: async () => { throw new Error('boom'); } } as any;
    const r = await subscriptionShadowSync.run({ db: brokenDb, logger: console as any, now: () => new Date() });
    expect(r.status).toBe('error');
  });
});
```

- [ ] **Step 3: Run (FAIL)**

- [ ] **Step 4: Implement**

```ts
// server/src/services/routine-checks/checks/subscription-shadow-sync.ts
import { sql } from 'drizzle-orm';
import type { CheckDef, CheckCtx, CheckResult } from '../types.js';

async function run(ctx: CheckCtx): Promise<CheckResult> {
  try {
    // 1) insert shadow events for newly observed subscription state
    const inserted = await ctx.db.execute(sql`
      INSERT INTO subscription_shadow_events (company_id, subscription_id, observed_at, snapshot_json)
      SELECT company_id, id, NOW(), to_jsonb(s)
        FROM subscriptions s
       WHERE NOT EXISTS (
         SELECT 1 FROM subscription_shadow_events e
          WHERE e.subscription_id = s.id
            AND e.observed_at > NOW() - INTERVAL '30 minutes'
       )
      RETURNING id
    `);
    const insertedCount = inserted.rows.length;

    // 2) per-company utilization
    const utilization = await ctx.db.execute(sql`
      SELECT c.name AS company,
             SUM(s.used_units)::int AS used,
             SUM(s.limit_units)::int AS limit
        FROM subscriptions s
        JOIN companies c ON c.id = s.company_id
       WHERE c.name IN ('HAPPYGANG', 'TechOps Marco')
       GROUP BY c.name
    `);

    const p95 = parseInt(process.env.PAPERCLIP_SHADOW_SYNC_P95 ?? '50', 10);
    const spike = insertedCount > p95 * 3;
    const status = spike ? 'warn' : 'ok';

    return {
      status,
      findings: spike ? insertedCount : 0,
      payload: {
        inserted_shadow_events: insertedCount,
        utilization: utilization.rows,
        spike,
      },
      summary: spike
        ? `shadow-sync SPIKE: ${insertedCount} inserts (P95×3=${p95 * 3})`
        : `shadow-sync ok: ${insertedCount} inserts`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 'error',
      findings: 0,
      payload: { error: msg },
      summary: `shadow-sync ERROR: ${msg}`,
    };
  }
}

export const subscriptionShadowSync: CheckDef = {
  name: 'subscription-shadow-sync',
  schedule: '*/30 * * * *',
  notify: 'silent', // silent for normal; recovery still fires on error→ok per dispatcher logic
  run,
};
```

- [ ] **Step 5: Run tests (PASS)**

- [ ] **Step 6: Commit**

```bash
git add server/src/services/routine-checks/checks/subscription-shadow-sync.ts server/src/services/routine-checks/__tests__/checks/subscription-shadow-sync.test.ts
git commit -m "feat(routine-checks): add subscription-shadow-sync (silent + spike-threshold)"
```

---

## Phase 7 — Check #3 creative-lint-nightly

### Task 7.1: Implement check that shells out to lint.mjs

**Files:**
- Create: `server/src/services/routine-checks/checks/creative-lint-nightly.ts`
- Test: corresponding `.test.ts`

- [ ] **Step 1: Failing test using mocked execFile + tmpdir**

```ts
// __tests__/checks/creative-lint-nightly.test.ts
import { describe, it, expect, vi } from 'vitest';
import { creativeLintNightly } from '../../checks/creative-lint-nightly.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('creative-lint-nightly', () => {
  it('returns ok when no projects exist', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-test-'));
    process.env.PAPERCLIP_CREATIVE_ROOT = tmp;
    const r = await creativeLintNightly.run({ db: {} as any, logger: console as any, now: () => new Date() });
    expect(r.status).toBe('ok');
    expect(r.findings).toBe(0);
  });

  it('aggregates violations across multiple projects', async () => {
    // create 2 fake project dirs + stub lint.mjs to return non-zero exit
    // ... (uses execFile mock or real lint.mjs against fixtures)
  });
});
```

- [ ] **Step 2: Implement**

```ts
// server/src/services/routine-checks/checks/creative-lint-nightly.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CheckDef, CheckCtx, CheckResult } from '../types.js';

const execFileP = promisify(execFile);

async function run(ctx: CheckCtx): Promise<CheckResult> {
  const root = process.env.PAPERCLIP_CREATIVE_ROOT
    ?? join(homedir(), '.openclaw/workspace/projects/happygang');
  const lintScript = join(homedir(), 'Code/paperclip/scripts/creative-workspace/lint.mjs');

  let projects: string[] = [];
  try {
    projects = await readdir(root);
  } catch (e) {
    return { status: 'error', findings: 0, payload: { error: `cannot read ${root}` }, summary: 'creative root missing' };
  }

  const results: Array<{ slug: string; exit: number; errors: number; warnings: number }> = [];

  for (const slug of projects) {
    const projectDir = join(root, slug);
    try {
      const { stdout } = await execFileP('node', [lintScript, projectDir, '--json']);
      const parsed = JSON.parse(stdout) as { errors: number; warnings: number };
      results.push({ slug, exit: 0, errors: parsed.errors, warnings: parsed.warnings });
    } catch (e: any) {
      // lint.mjs exits non-zero on violations; parse stdout if JSON present
      const exit = typeof e?.code === 'number' ? e.code : 1;
      let errors = 0;
      let warnings = 0;
      if (e?.stdout) {
        try { const p = JSON.parse(e.stdout); errors = p.errors ?? 0; warnings = p.warnings ?? 0; } catch {}
      }
      results.push({ slug, exit, errors, warnings });
    }
  }

  const findings = results.reduce((s, r) => s + r.errors, 0);
  const status = findings > 0 ? 'warn' : 'ok';
  return {
    status,
    findings,
    payload: { projects: results },
    summary: `creative-lint: ${results.length} projects, ${findings} violations`,
  };
}

export const creativeLintNightly: CheckDef = {
  name: 'creative-lint-nightly',
  schedule: '30 2 * * *',
  notify: 'silent',
  run,
};
```

(Note: requires that `lint.mjs` supports `--json` flag. If not, add it as a separate task in phase 7.)

- [ ] **Step 3: Verify lint.mjs supports `--json`**

Run: `node ~/Code/paperclip/scripts/creative-workspace/lint.mjs --help` (or read source)
If `--json` not supported: add a pre-task to extend `lint.mjs` with JSON output mode (errors+warnings counts), commit separately.

- [ ] **Step 4: Run tests (PASS)**

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/checks/creative-lint-nightly.ts server/src/services/routine-checks/__tests__/checks/creative-lint-nightly.test.ts
git commit -m "feat(routine-checks): add creative-lint-nightly"
```

---

## Phase 8 — Check #4 drive-marker-ttl

### Task 8.1: Implement TTL cleanup

**Files:**
- Create: `server/src/services/routine-checks/checks/drive-marker-ttl.ts`
- Test: corresponding `.test.ts`

- [ ] **Step 1: Failing test**

```ts
// __tests__/checks/drive-marker-ttl.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { driveMarkerTtl } from '../../checks/drive-marker-ttl.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('drive-marker-ttl', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drive-ttl-'));
    process.env.PAPERCLIP_CREATIVE_ROOT = tmp;
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('removes markers older than 60min', async () => {
    const projectDir = path.join(tmp, 'project1');
    await fs.mkdir(projectDir, { recursive: true });
    const oldMarker = path.join(projectDir, '.drive-approved-20260430-0900');
    const newMarker = path.join(projectDir, '.drive-approved-20260430-1000');
    await fs.writeFile(oldMarker, '');
    await fs.writeFile(newMarker, '');
    const oldTime = new Date(Date.now() - 90 * 60 * 1000);
    await fs.utimes(oldMarker, oldTime, oldTime);

    const r = await driveMarkerTtl.run({ db: {} as any, logger: console as any, now: () => new Date() });
    expect((r.payload as any).removed).toContain(oldMarker);
    expect((r.payload as any).removed).not.toContain(newMarker);
    expect(r.findings).toBe(1);
  });

  it('returns ok with 0 findings when no stale markers', async () => {
    const r = await driveMarkerTtl.run({ db: {} as any, logger: console as any, now: () => new Date() });
    expect(r.status).toBe('ok');
    expect(r.findings).toBe(0);
  });
});
```

- [ ] **Step 2: Run (FAIL)**

- [ ] **Step 3: Implement**

```ts
// server/src/services/routine-checks/checks/drive-marker-ttl.ts
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CheckDef, CheckCtx, CheckResult } from '../types.js';

const TTL_MS = 60 * 60 * 1000;

async function* walkMarkers(dir: string): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkMarkers(full);
    } else if (e.name.startsWith('.drive-approved-')) {
      yield full;
    }
  }
}

async function run(ctx: CheckCtx): Promise<CheckResult> {
  const root = process.env.PAPERCLIP_CREATIVE_ROOT
    ?? join(homedir(), '.openclaw/workspace/projects/happygang');
  const cutoff = ctx.now().getTime() - TTL_MS;
  const removed: string[] = [];
  for await (const path of walkMarkers(root)) {
    try {
      const st = await stat(path);
      if (st.mtimeMs < cutoff) {
        await unlink(path);
        removed.push(path);
      }
    } catch (e) {
      ctx.logger.warn({ path, err: String(e) }, 'drive-marker-ttl unlink failed');
    }
  }
  return {
    status: 'ok',
    findings: removed.length,
    payload: { removed },
    summary: `removed ${removed.length} stale drive markers`,
  };
}

export const driveMarkerTtl: CheckDef = {
  name: 'drive-marker-ttl',
  schedule: '*/15 * * * *',
  notify: 'silent',
  run,
};
```

- [ ] **Step 4: Run tests (PASS)**

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/checks/drive-marker-ttl.ts server/src/services/routine-checks/__tests__/checks/drive-marker-ttl.test.ts
git commit -m "feat(routine-checks): add drive-marker-ttl"
```

---

## Phase 9 — Check #5 approved-freshness

### Task 9.1: Implement freshness check

**Files:**
- Create: `server/src/services/routine-checks/checks/approved-freshness.ts`
- Test: corresponding `.test.ts`

- [ ] **Step 1: Failing test**

```ts
// __tests__/checks/approved-freshness.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { approvedFreshness } from '../../checks/approved-freshness.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('approved-freshness', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'freshness-'));
    process.env.PAPERCLIP_CREATIVE_ROOT = tmp;
  });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('finds stale items >14 days', async () => {
    const dir = path.join(tmp, 'projA/assets/k1/04-approved/item1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'APPROVAL.md'),
      'Header\n\n✅ sign-off marco 2026-04-10 12:00\n',
    );
    const r = await approvedFreshness.run({ db: {} as any, logger: console as any, now: () => new Date('2026-04-30T00:00:00Z') });
    expect(r.findings).toBe(1);
    expect((r.payload as any).stale_items[0].age_days).toBe(20);
  });

  it('skips items signed within last 14 days', async () => {
    const dir = path.join(tmp, 'projA/assets/k1/04-approved/item1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'APPROVAL.md'),
      '✅ sign-off marco 2026-04-25 10:00',
    );
    const r = await approvedFreshness.run({ db: {} as any, logger: console as any, now: () => new Date('2026-04-30T00:00:00Z') });
    expect(r.findings).toBe(0);
  });
});
```

- [ ] **Step 2: Run (FAIL)**

- [ ] **Step 3: Implement**

```ts
// server/src/services/routine-checks/checks/approved-freshness.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CheckDef, CheckCtx, CheckResult } from '../types.js';

const SIGNOFF_RE = /✅\s+sign-off\s+\S+\s+(\d{4}-\d{2}-\d{2})/;
const STALE_DAYS = 14;

async function findApprovedItems(root: string): Promise<string[]> {
  const result: string[] = [];
  let projects: import('node:fs').Dirent[];
  try { projects = await readdir(root, { withFileTypes: true }); } catch { return result; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const assetsDir = join(root, p.name, 'assets');
    let kampagnen: import('node:fs').Dirent[];
    try { kampagnen = await readdir(assetsDir, { withFileTypes: true }); } catch { continue; }
    for (const k of kampagnen) {
      if (!k.isDirectory()) continue;
      const approvedDir = join(assetsDir, k.name, '04-approved');
      let items: import('node:fs').Dirent[];
      try { items = await readdir(approvedDir, { withFileTypes: true }); } catch { continue; }
      for (const it of items) {
        if (!it.isDirectory()) continue;
        result.push(join(approvedDir, it.name));
      }
    }
  }
  return result;
}

async function run(ctx: CheckCtx): Promise<CheckResult> {
  const root = process.env.PAPERCLIP_CREATIVE_ROOT
    ?? join(homedir(), '.openclaw/workspace/projects/happygang');
  const items = await findApprovedItems(root);
  const stale: Array<{ project: string; item: string; age_days: number }> = [];

  for (const itemPath of items) {
    const approvalPath = join(itemPath, 'APPROVAL.md');
    let body: string;
    try { body = await readFile(approvalPath, 'utf8'); } catch { continue; }
    const m = body.match(SIGNOFF_RE);
    if (!m) {
      stale.push({ project: itemPath, item: itemPath.split('/').pop()!, age_days: 9999 });
      continue;
    }
    const signedAt = new Date(m[1]!);
    const ageDays = Math.floor((ctx.now().getTime() - signedAt.getTime()) / 86400000);
    if (ageDays > STALE_DAYS) {
      stale.push({ project: itemPath, item: itemPath.split('/').pop()!, age_days: ageDays });
    }
  }

  return {
    status: stale.length > 0 ? 'warn' : 'ok',
    findings: stale.length,
    payload: { stale_items: stale },
    summary: stale.length > 0 ? `${stale.length} stale approved items (>14d)` : 'all approved items fresh',
  };
}

export const approvedFreshness: CheckDef = {
  name: 'approved-freshness',
  schedule: '0 7 * * 1',
  notify: 'threshold',
  thresholdSeverity: 'warn',
  run,
};
```

- [ ] **Step 4: Run tests (PASS)**

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/checks/approved-freshness.ts server/src/services/routine-checks/__tests__/checks/approved-freshness.test.ts
git commit -m "feat(routine-checks): add approved-freshness"
```

---

## Phase 10 — Wiring: Boot hook + ENV flag

### Task 10.1: Register all 5 checks + boot

**Files:**
- Modify: `server/src/services/cron.ts` (or equivalent boot module)
- Create: `server/src/services/routine-checks/boot.ts`

- [ ] **Step 1: Create boot module**

```ts
// server/src/services/routine-checks/boot.ts
import { Registry } from './registry.js';
import { catchUpAll, tickAll, type WebhookCfg } from './runner.js';
import { workspaceDriftGuard } from './checks/workspace-drift-guard.js';
import { subscriptionShadowSync } from './checks/subscription-shadow-sync.js';
import { creativeLintNightly } from './checks/creative-lint-nightly.js';
import { driveMarkerTtl } from './checks/drive-marker-ttl.js';
import { approvedFreshness } from './checks/approved-freshness.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../../db/index.js';
import type { Logger } from 'pino';

export function buildRegistry(): Registry {
  const r = new Registry();
  r.register(workspaceDriftGuard);
  r.register(subscriptionShadowSync);
  r.register(creativeLintNightly);
  r.register(driveMarkerTtl);
  r.register(approvedFreshness);
  return r;
}

async function readToken(): Promise<string | null> {
  try {
    const path = join(homedir(), '.paperclip/secrets/notify-token');
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function startRoutineChecks(args: { db: Db; logger: Logger }): Promise<{ stop: () => void } | null> {
  if (process.env.PAPERCLIP_ROUTINE_CHECKS !== '1') {
    args.logger.info('routine-checks: disabled (PAPERCLIP_ROUTINE_CHECKS != 1)');
    return null;
  }

  const registry = buildRegistry();
  const token = await readToken();
  const webhook: WebhookCfg | undefined = token
    ? { url: process.env.HERMES_NOTIFY_URL ?? 'http://127.0.0.1:8765/paperclip/notify', token }
    : undefined;

  if (!webhook) args.logger.warn('routine-checks: no notify-token, running silent-only');

  await catchUpAll({ db: args.db, registry, now: () => new Date(), logger: args.logger, webhook });

  const interval = setInterval(() => {
    tickAll({ db: args.db, registry, now: () => new Date(), logger: args.logger, webhook }).catch((e) =>
      args.logger.error({ err: String(e) }, 'routine-checks tick failed'),
    );
  }, 60_000);

  return { stop: () => clearInterval(interval) };
}
```

- [ ] **Step 2: Wire into server boot**

Modify `server/src/index.ts` — after DB initialization, before HTTP listen:

```ts
import { startRoutineChecks } from './services/routine-checks/boot.js';

const routineChecks = await startRoutineChecks({ db, logger });
process.on('SIGTERM', () => { routineChecks?.stop(); });
```

- [ ] **Step 3: Add boot smoke test**

```ts
// __tests__/boot.test.ts
import { describe, it, expect } from 'vitest';
import { buildRegistry } from '../boot.js';

describe('buildRegistry', () => {
  it('registers exactly 5 checks', () => {
    const r = buildRegistry();
    const names = r.list().map((c) => c.name).sort();
    expect(names).toEqual([
      'approved-freshness',
      'creative-lint-nightly',
      'drive-marker-ttl',
      'subscription-shadow-sync',
      'workspace-drift-guard',
    ]);
  });
});
```

- [ ] **Step 4: Run tests, then build**

```bash
pnpm --filter @paperclipai/server vitest run services/routine-checks
pnpm --filter @paperclipai/server build
```

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routine-checks/boot.ts server/src/services/routine-checks/__tests__/boot.test.ts server/src/index.ts
git commit -m "feat(routine-checks): wire boot hook + ENV flag"
```

---

## Phase 11 — Paperclip CLI `checks` subcommand

### Task 11.1: list / run / history

**Files:**
- Create: `cli/src/commands/checks.ts`
- Modify: `cli/src/index.ts`

- [ ] **Step 1: Implement subcommand**

```ts
// cli/src/commands/checks.ts
import { buildRegistry } from '../../../server/src/services/routine-checks/boot.js';
import { runOne } from '../../../server/src/services/routine-checks/runner.js';
import { db } from '../../../server/src/db/index.js'; // or however CLI gets db
import { routineCheckRuns } from '../../../server/src/db/schema/index.js';
import { eq, desc } from 'drizzle-orm';
import pino from 'pino';

const logger = pino({ level: 'info' });

export async function listCmd(): Promise<void> {
  const r = buildRegistry();
  for (const def of r.list()) {
    console.log(`${def.name}\t${def.schedule}\t${def.notify}`);
  }
}

export async function runCmd(name: string): Promise<void> {
  const r = buildRegistry();
  const def = r.get(name);
  if (!def) { console.error(`unknown check: ${name}`); process.exit(2); }
  const result = await runOne({
    db, def, scheduledFor: new Date(), logger, now: () => new Date(), webhook: undefined,
  });
  console.log(JSON.stringify(result, null, 2));
}

export async function historyCmd(name: string, limit = 20): Promise<void> {
  const rows = await db
    .select()
    .from(routineCheckRuns)
    .where(eq(routineCheckRuns.checkName, name))
    .orderBy(desc(routineCheckRuns.runAt))
    .limit(limit);
  for (const r of rows) {
    console.log(`${r.runAt.toISOString()}\t${r.status}\tfindings=${r.findings}\t${r.errorText ?? ''}`);
  }
}
```

- [ ] **Step 2: Register in CLI dispatcher**

In `cli/src/index.ts` add a new case:

```ts
case 'checks': {
  const sub = args[1];
  if (sub === 'list') await listCmd();
  else if (sub === 'run') await runCmd(args[2]);
  else if (sub === 'history') await historyCmd(args[2], args[3] ? parseInt(args[3], 10) : 20);
  else { console.error('usage: paperclip checks {list|run|history} ...'); process.exit(2); }
  break;
}
```

(Adapt to actual CLI framework used in the repo.)

- [ ] **Step 3: Smoke test**

```bash
pnpm paperclipai checks list
# Expected: 5 lines, name<TAB>schedule<TAB>notify
```

- [ ] **Step 4: Commit**

```bash
git add cli/src/commands/checks.ts cli/src/index.ts
git commit -m "feat(cli): add paperclip checks {list|run|history}"
```

---

## Phase 12 — Hermes webhook handler

### Task 12.1: SQLite dedupe layer

**Files:**
- Create: `gateway/paperclip_notify_dedupe.py`
- Test: `tests/gateway/test_paperclip_notify_dedupe.py`

- [ ] **Step 1: Failing test**

```python
# tests/gateway/test_paperclip_notify_dedupe.py
import os, tempfile
import pytest
from gateway.paperclip_notify_dedupe import Dedupe

@pytest.fixture
def db_path(tmp_path):
    return str(tmp_path / "dedupe.db")

def test_first_call_returns_send(db_path):
    d = Dedupe(db_path)
    assert d.should_send("check1", "hash1", "ok", "ok") is True

def test_second_call_same_hash_returns_skip(db_path):
    d = Dedupe(db_path)
    d.should_send("check1", "hash1", "ok", "ok")
    d.record("check1", "hash1")
    assert d.should_send("check1", "hash1", "ok", "ok") is False

def test_state_change_overrides_dedupe(db_path):
    d = Dedupe(db_path)
    d.record("check1", "hash1")
    # previous_status != current_status → must send
    assert d.should_send("check1", "hash1", "ok", "warn") is True

def test_corruption_fallback_returns_send(db_path, monkeypatch):
    d = Dedupe(db_path)
    # simulate corrupt by overriding cursor
    def boom(*a, **k): raise __import__("sqlite3").DatabaseError("disk image malformed")
    monkeypatch.setattr(d._conn, "execute", boom)
    assert d.should_send("check1", "hash1", "ok", "ok") is True
```

- [ ] **Step 2: Run (FAIL)**

`pytest tests/gateway/test_paperclip_notify_dedupe.py -v`

- [ ] **Step 3: Implement**

```python
# gateway/paperclip_notify_dedupe.py
import sqlite3
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS paperclip_notify_dedupe (
    check_name TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    last_sent_at TIMESTAMP NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (check_name, content_hash)
);
"""

class Dedupe:
    def __init__(self, db_path: str) -> None:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute(SCHEMA)
        self._conn.commit()

    def should_send(self, check: str, content_hash: str, previous_status: Optional[str], current_status: str) -> bool:
        if previous_status is not None and previous_status != current_status:
            return True
        try:
            cur = self._conn.execute(
                "SELECT 1 FROM paperclip_notify_dedupe WHERE check_name=? AND content_hash=?",
                (check, content_hash),
            )
            row = cur.fetchone()
            return row is None
        except sqlite3.DatabaseError as e:
            logger.error("dedupe DB error: %s — fallback to send", e)
            return True

    def record(self, check: str, content_hash: str) -> None:
        try:
            self._conn.execute(
                "INSERT OR REPLACE INTO paperclip_notify_dedupe (check_name, content_hash, last_sent_at) "
                "VALUES (?, ?, datetime('now'))",
                (check, content_hash),
            )
            self._conn.commit()
        except sqlite3.DatabaseError as e:
            logger.error("dedupe write error: %s — continuing", e)
```

- [ ] **Step 4: Run tests (PASS)**

- [ ] **Step 5: Commit**

```bash
git add gateway/paperclip_notify_dedupe.py tests/gateway/test_paperclip_notify_dedupe.py
git commit -m "feat(hermes): add SQLite dedupe layer for paperclip notify webhook"
```

### Task 12.2: FastAPI router with auth

**Files:**
- Create: `gateway/paperclip_notify.py`
- Test: `tests/gateway/test_paperclip_notify.py`

- [ ] **Step 1: Failing tests**

```python
# tests/gateway/test_paperclip_notify.py
import os
import pytest
from fastapi.testclient import TestClient
from gateway.paperclip_notify import build_router

@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("PAPERCLIP_NOTIFY_TOKEN", "secret123")
    monkeypatch.setenv("PAPERCLIP_NOTIFY_DB", str(tmp_path / "d.db"))
    sent = []
    def telegram_send(message: str) -> None:
        sent.append(message)
    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(build_router(telegram_send=telegram_send))
    c = TestClient(app)
    c.sent = sent
    return c

def payload(**overrides):
    p = {
      "check": "drift", "status": "warn", "previous_status": "ok",
      "findings": 3, "summary": "x", "content_hash": "h1",
      "scheduled_for": "2026-04-30T09:00:00+00:00",
      "details_hint": "paperclip checks history drift --limit 1",
    }
    p.update(overrides)
    return p

def test_no_token_returns_401(client):
    r = client.post("/paperclip/notify", json=payload())
    assert r.status_code == 401
    assert client.sent == []

def test_wrong_token_returns_401(client):
    r = client.post("/paperclip/notify", json=payload(), headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401

def test_valid_token_sends_telegram(client):
    r = client.post("/paperclip/notify", json=payload(), headers={"Authorization": "Bearer secret123"})
    assert r.status_code == 200
    assert len(client.sent) == 1

def test_dedupe_second_call_no_send(client):
    h = {"Authorization": "Bearer secret123"}
    r1 = client.post("/paperclip/notify", json=payload(), headers=h)
    r2 = client.post("/paperclip/notify", json=payload(), headers=h)
    assert r1.status_code == 200 and r2.status_code == 200
    assert len(client.sent) == 1

def test_state_change_overrides_dedupe(client):
    h = {"Authorization": "Bearer secret123"}
    client.post("/paperclip/notify", json=payload(previous_status="warn", status="warn"), headers=h)
    client.post("/paperclip/notify", json=payload(previous_status="warn", status="ok"), headers=h)
    assert len(client.sent) == 2

def test_recovery_prefix_in_telegram(client):
    h = {"Authorization": "Bearer secret123"}
    client.post("/paperclip/notify", json=payload(previous_status="warn", status="ok", summary="all clean"), headers=h)
    # paperclip already prefixes, hermes passes through
    assert any("all clean" in m for m in client.sent)
```

- [ ] **Step 2: Run (FAIL)**

- [ ] **Step 3: Implement**

```python
# gateway/paperclip_notify.py
import os
from pathlib import Path
from typing import Callable, Optional
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from .paperclip_notify_dedupe import Dedupe

class NotifyPayload(BaseModel):
    check: str
    status: str
    previous_status: Optional[str] = None
    findings: int
    summary: str
    content_hash: str
    scheduled_for: str
    details_hint: str

def _read_token() -> Optional[str]:
    env = os.environ.get("PAPERCLIP_NOTIFY_TOKEN")
    if env:
        return env
    p = Path.home() / ".hermes/secrets/notify-token"
    try:
        return p.read_text().strip()
    except FileNotFoundError:
        return None

def build_router(telegram_send: Callable[[str], None]) -> APIRouter:
    router = APIRouter()
    db_path = os.environ.get("PAPERCLIP_NOTIFY_DB",
                             str(Path.home() / ".hermes/cron/paperclip_notify_dedupe.db"))
    dedupe = Dedupe(db_path)

    @router.post("/paperclip/notify", status_code=200)
    async def notify(payload: NotifyPayload, authorization: Optional[str] = Header(None)):
        expected = _read_token()
        provided = authorization.split(" ", 1)[1] if authorization and authorization.startswith("Bearer ") else None
        if not expected or provided != expected:
            raise HTTPException(status_code=401, detail="unauthorized")

        if dedupe.should_send(payload.check, payload.content_hash, payload.previous_status, payload.status):
            telegram_send(f"[paperclip] {payload.check} ({payload.status}): {payload.summary}\n→ {payload.details_hint}")
            dedupe.record(payload.check, payload.content_hash)
            return {"sent": True}
        return {"sent": False, "deduped": True}

    return router
```

- [ ] **Step 4: Run tests (PASS)**

- [ ] **Step 5: Mount router in app**

Find the existing FastAPI app composition (likely in `gateway/__init__.py` or `gateway/app.py`):

```python
from .paperclip_notify import build_router
from .telegram import send_message  # or however hermes sends Telegram
app.include_router(build_router(telegram_send=send_message))
```

- [ ] **Step 6: Commit**

```bash
git add gateway/paperclip_notify.py tests/gateway/test_paperclip_notify.py gateway/__init__.py
git commit -m "feat(hermes): add /paperclip/notify webhook with bearer auth + dedupe"
```

---

## Phase 13 — Openclaw heartbeat-check + LaunchAgent

### Task 13.1: Heartbeat shell script

**Files:**
- Create: `~/.openclaw/workspace/scripts/paperclip-heartbeat-check.sh`

- [ ] **Step 1: Write script**

```bash
#!/usr/bin/env bash
# paperclip-heartbeat-check — alerts when paperclip routine-checks stop running
# Trigger via LaunchAgent every 30 minutes
set -euo pipefail

WORKSPACE="${HOME}/.openclaw/workspace"
TELEGRAM="${WORKSPACE}/scripts/safe_telegram_send.sh"
LOG="${HOME}/.openclaw/logs/paperclip_heartbeat.log"
mkdir -p "$(dirname "$LOG")"

ts() { date '+%F %T'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

PGPASSWORD=paperclip psql -h localhost -U paperclip -d paperclip -tAc \
  "SELECT EXTRACT(EPOCH FROM NOW() - max(scheduled_for))::int FROM routine_check_runs WHERE check_name = 'subscription-shadow-sync'" \
  > /tmp/paperclip_heartbeat.out 2>/tmp/paperclip_heartbeat.err

if [[ ! -s /tmp/paperclip_heartbeat.out ]]; then
  MSG="paperclip-heartbeat ALARM — DB query failed: $(cat /tmp/paperclip_heartbeat.err 2>/dev/null | head -c 200)"
  log "$MSG"
  bash "$TELEGRAM" --context "paperclip-heartbeat" --dedupe-key "paperclip-heartbeat-fail-$(date +%F-%H)" --dedupe-window 3600 --message "$MSG" || true
  exit 0
fi

AGE_SECONDS=$(cat /tmp/paperclip_heartbeat.out)
log "subscription-shadow-sync max(scheduled_for) age = ${AGE_SECONDS}s"

if (( AGE_SECONDS > 5400 )); then  # 90min
  MSG="paperclip-heartbeat STUCK — subscription-shadow-sync hat seit ${AGE_SECONDS}s keinen scheduled-Run. paperclip-Server prüfen."
  log "$MSG"
  bash "$TELEGRAM" --context "paperclip-heartbeat" --dedupe-key "paperclip-heartbeat-stuck-$(date +%F-%H)" --dedupe-window 3600 --message "$MSG" || true
fi
```

- [ ] **Step 2: Make executable**

```bash
chmod +x ~/.openclaw/workspace/scripts/paperclip-heartbeat-check.sh
```

- [ ] **Step 3: Smoke run**

```bash
~/.openclaw/workspace/scripts/paperclip-heartbeat-check.sh
cat ~/.openclaw/logs/paperclip_heartbeat.log
```

Expected: log shows `age = N`s where N < 1800 if shadow-sync recently ran (post-cutover); otherwise script gracefully alarms.

- [ ] **Step 4: Commit**

```bash
cd ~/.openclaw/workspace
git add scripts/paperclip-heartbeat-check.sh
git commit -m "feat(scripts): add paperclip-heartbeat-check"
```

### Task 13.2: LaunchAgent plist

**Files:**
- Create: `~/Library/LaunchAgents/de.marcoschmid.paperclip-heartbeat.plist`

- [ ] **Step 1: Write plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>de.marcoschmid.paperclip-heartbeat</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/marco/.openclaw/workspace/scripts/paperclip-heartbeat-check.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>1800</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/marco/.openclaw/logs/paperclip_heartbeat.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/marco/.openclaw/logs/paperclip_heartbeat.stderr.log</string>
</dict>
</plist>
```

- [ ] **Step 2: Load**

```bash
launchctl load ~/Library/LaunchAgents/de.marcoschmid.paperclip-heartbeat.plist
launchctl list | grep paperclip-heartbeat
```

Expected: Output line contains the label.

- [ ] **Step 3: Commit (workspace repo)**

If openclaw tracks plist files, commit. Otherwise just document in README.

---

## Phase 14 — Pre-Cutover: secrets + snapshots + smoke

### Task 14.1: Generate shared notify-token

- [ ] **Step 1: Generate token**

```bash
openssl rand -hex 32 > /tmp/paperclip-notify-token
mkdir -p ~/.paperclip/secrets ~/.hermes/secrets
cp /tmp/paperclip-notify-token ~/.paperclip/secrets/notify-token
cp /tmp/paperclip-notify-token ~/.hermes/secrets/notify-token
chmod 600 ~/.paperclip/secrets/notify-token ~/.hermes/secrets/notify-token
shred -u /tmp/paperclip-notify-token 2>/dev/null || rm /tmp/paperclip-notify-token
```

- [ ] **Step 2: Verify both files have identical content + 0600 perm**

```bash
diff ~/.paperclip/secrets/notify-token ~/.hermes/secrets/notify-token
stat -f '%Sp' ~/.paperclip/secrets/notify-token
stat -f '%Sp' ~/.hermes/secrets/notify-token
```

Expected: identical content, perms `-rw-------`.

### Task 14.2: Verify paperclip-server LaunchAgent

- [ ] **Step 1: Check existence**

```bash
ls ~/Library/LaunchAgents/ | grep paperclip-server
plutil -p ~/Library/LaunchAgents/de.marcoschmid.paperclip-server.plist 2>/dev/null
```

If not present: BLOCKER for cutover — create separate plist (not in scope of this plan, but pre-requisite). Document in cutover checklist.

- [ ] **Step 2: Verify KeepAlive=true, RunAtLoad=true**

```bash
plutil -p ~/Library/LaunchAgents/de.marcoschmid.paperclip-server.plist | grep -E 'KeepAlive|RunAtLoad'
```

If missing: edit plist, reload via `launchctl unload && load`.

### Task 14.3: Snapshots

- [ ] **Step 1: Snapshot Hermes jobs.json**

```bash
cp ~/.hermes/cron/jobs.json ~/.hermes/cron/jobs.json.pre-paperclip-migration
```

- [ ] **Step 2: Tag both repos**

```bash
git -C ~/Code/paperclip tag pre-paperclip-routine-migration
git -C ~/Code/hermes-agent tag pre-paperclip-routine-migration
```

- [ ] **Step 3: Verify**

```bash
ls -la ~/.hermes/cron/jobs.json.pre-paperclip-migration
git -C ~/Code/paperclip tag | grep pre-paperclip
```

### Task 14.4: Smoke checks (paperclip-server NOT yet enabled in production)

- [ ] **Step 1: Run all 5 checks via CLI without notify**

```bash
cd ~/Code/paperclip
PAPERCLIP_ROUTINE_CHECKS=0 pnpm paperclipai checks run workspace-drift-guard
pnpm paperclipai checks run subscription-shadow-sync
pnpm paperclipai checks run creative-lint-nightly
pnpm paperclipai checks run drive-marker-ttl
pnpm paperclipai checks run approved-freshness
```

Expected: each emits JSON with status + findings, no Telegram (webhook not enabled), no DB row created (CLI uses `webhook: undefined` and runs detached from runner).

- [ ] **Step 2: Compare workspace-drift-guard output vs Hermes last run**

```bash
ls -t ~/.hermes/cron/output/d2c9532bbc77/ | head -1
# read latest file, compare findings count to CLI run output
```

Expected: findings count matches ±0.

- [ ] **Step 3: Test webhook end-to-end**

Start hermes locally with new `/paperclip/notify` route loaded.

```bash
curl -i -X POST http://127.0.0.1:8765/paperclip/notify -d '{}'
# Expected: 401
```

```bash
TOKEN=$(cat ~/.hermes/secrets/notify-token)
curl -i -X POST http://127.0.0.1:8765/paperclip/notify \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"check":"smoke","status":"warn","previous_status":"ok","findings":1,"summary":"smoke","content_hash":"h_smoke","scheduled_for":"2026-04-30T09:00:00Z","details_hint":""}'
# Expected: 200, Telegram message arrives
```

```bash
curl -i -X POST http://127.0.0.1:8765/paperclip/notify \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"check":"smoke","status":"warn","previous_status":"warn","findings":1,"summary":"smoke","content_hash":"h_smoke","scheduled_for":"2026-04-30T09:00:00Z","details_hint":""}'
# Expected: 200 with deduped:true, NO Telegram
```

---

## Phase 15 — Cutover (atomic ~5 min)

### Task 15.1: Enable paperclip routine-checks

- [ ] **Step 1: Edit paperclip-server plist**

Add to `EnvironmentVariables` dict in `~/Library/LaunchAgents/de.marcoschmid.paperclip-server.plist`:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>PAPERCLIP_ROUTINE_CHECKS</key>
  <string>1</string>
  <key>HERMES_NOTIFY_URL</key>
  <string>http://127.0.0.1:8765/paperclip/notify</string>
</dict>
```

- [ ] **Step 2: Reload paperclip-server**

```bash
launchctl unload ~/Library/LaunchAgents/de.marcoschmid.paperclip-server.plist
launchctl load   ~/Library/LaunchAgents/de.marcoschmid.paperclip-server.plist
sleep 5
launchctl list | grep paperclip-server
```

Expected: server running, log shows `routine-checks: enabled` + `catch-up running missed slot` for each check whose first slot was missed during boot transition.

### Task 15.2: Pause Hermes paperclip jobs

- [ ] **Step 1: Pause both jobs**

```bash
hermes cron pause d2c9532bbc77 --reason "migrated-to-paperclip-2026-04-30"
hermes cron pause 673c5760a64a --reason "migrated-to-paperclip-2026-04-30"
hermes cron list | grep -E 'd2c9532bbc77|673c5760a64a'
```

Expected: both jobs `state=paused` with the reason string.

### Task 15.3: Replace openclaw shadow-sync script with stub

- [ ] **Step 1: Backup + replace**

```bash
cp ~/.openclaw/workspace/scripts/paperclip-subscription-shadow-sync.sh \
   ~/.openclaw/workspace/scripts/paperclip-subscription-shadow-sync.sh.pre-migration
cat > ~/.openclaw/workspace/scripts/paperclip-subscription-shadow-sync.sh <<'EOF'
#!/usr/bin/env bash
# Migrated to paperclip-server routine-checks (2026-04-30).
# This stub remains for backwards compatibility with any external trigger.
# After 2026-05-07 this file may be deleted.
exec /Users/marco/Code/paperclip/cli/node_modules/tsx/dist/cli.mjs \
     /Users/marco/Code/paperclip/cli/src/index.ts checks run subscription-shadow-sync
EOF
chmod +x ~/.openclaw/workspace/scripts/paperclip-subscription-shadow-sync.sh
```

- [ ] **Step 2: Smoke**

```bash
~/.openclaw/workspace/scripts/paperclip-subscription-shadow-sync.sh
```

Expected: emits JSON output with `inserted_shadow_events`.

### Task 15.4: Delete obsolete openclaw paperclip-phase0-check

- [ ] **Step 1: Unload + remove plist**

```bash
launchctl unload ~/Library/LaunchAgents/de.marcoschmid.paperclip-phase0-check.plist 2>/dev/null || true
rm ~/Library/LaunchAgents/de.marcoschmid.paperclip-phase0-check.plist
rm ~/.openclaw/workspace/scripts/paperclip_phase0_check.sh
rm -f ~/.openclaw/state/paperclip_phase0_check_done.flag
```

- [ ] **Step 2: Verify**

```bash
ls ~/.openclaw/workspace/scripts/ | grep -i paperclip_phase0 || echo "OK: gone"
launchctl list | grep paperclip-phase0 || echo "OK: not loaded"
```

### Task 15.5: Strip paperclip-specific logic from nightly_workspace_consistency_audit.sh (if any)

- [ ] **Step 1: Search**

```bash
grep -n -i 'paperclip\|drive-approved' ~/.openclaw/workspace/scripts/nightly_workspace_consistency_audit.sh
```

If matches: edit out those blocks. If empty: skip.

- [ ] **Step 2: Test audit still passes**

```bash
~/.openclaw/workspace/scripts/nightly_workspace_consistency_audit.sh
```

Expected: exit 0 or exit 1 with non-paperclip findings.

### Task 15.6: Cutover post-checks (immediate)

- [ ] **Step 1: Verify paperclip is running checks**

```bash
PGPASSWORD=paperclip psql -h localhost -U paperclip -d paperclip -c \
  "SELECT check_name, max(run_at) FROM routine_check_runs GROUP BY 1 ORDER BY 1"
```

Expected: 5 rows with recent timestamps (within last few minutes for those whose first slot just passed).

- [ ] **Step 2: `paperclip checks list`**

```bash
pnpm paperclipai checks list
```

Expected: 5 lines.

- [ ] **Step 3: Verify Hermes-side**

```bash
hermes cron list | grep paperclip
```

Expected: both jobs paused with the migration reason.

- [ ] **Step 4: Commit cutover changes (in respective repos)**

```bash
cd ~/.openclaw/workspace
git add scripts/paperclip-subscription-shadow-sync.sh
git rm scripts/paperclip_phase0_check.sh 2>/dev/null || true
git commit -m "chore(scripts): migrate paperclip routine checks to paperclip-server"
```

---

## Phase 16 — Verification (1h, 24h, 7d windows)

### Task 16.1: 1h verification

- [ ] **Step 1: Check shadow-sync ran**

```bash
sleep 1800  # 30 min after cutover, then again
PGPASSWORD=paperclip psql -h localhost -U paperclip -d paperclip -tAc \
  "SELECT count(*) FROM routine_check_runs WHERE check_name='subscription-shadow-sync' AND run_at > NOW() - INTERVAL '1 hour'"
```

Expected: at least 1 row.

- [ ] **Step 2: Check heartbeat is healthy**

```bash
~/.openclaw/workspace/scripts/paperclip-heartbeat-check.sh
tail ~/.openclaw/logs/paperclip_heartbeat.log
```

Expected: log shows age < 1800s, no Telegram sent.

### Task 16.2: 24h verification

- [ ] **Step 1: Drift-guard ran 3× in last 24h**

```bash
PGPASSWORD=paperclip psql -h localhost -U paperclip -d paperclip -c \
  "SELECT scheduled_for, status, findings FROM routine_check_runs WHERE check_name='workspace-drift-guard' AND run_at > NOW() - INTERVAL '24 hours' ORDER BY scheduled_for"
```

Expected: 3 rows at 09:00/18:00/22:00 local-time (or UTC equivalents).

- [ ] **Step 2: Compare drift findings to last Hermes run pre-migration**

```bash
ls -t ~/.hermes/cron/output/d2c9532bbc77/ | head -1
# diff manually
```

Expected: drift counts match ±1 (small variance OK if executor cwd changed naturally).

- [ ] **Step 3: Telegram inbox check**

Verify drift alerts arrive at expected times if drift > 0; recovery messages on warn→ok transitions.

### Task 16.3: 7d cleanup

After 7 days of stable operation:

- [ ] **Step 1: Delete paused Hermes jobs**

```bash
hermes cron rm d2c9532bbc77
hermes cron rm 673c5760a64a
hermes cron list | grep paperclip || echo "OK: gone"
```

- [ ] **Step 2: Delete openclaw shadow-sync stub**

```bash
rm ~/.openclaw/workspace/scripts/paperclip-subscription-shadow-sync.sh
rm ~/.openclaw/workspace/scripts/paperclip-subscription-shadow-sync.sh.pre-migration
cd ~/.openclaw/workspace
git add -A scripts/
git commit -m "chore: remove paperclip-subscription-shadow-sync stub after migration soak"
```

- [ ] **Step 3: Final verification**

```bash
jq '.jobs[].name' ~/.hermes/cron/jobs.json | grep paperclip || echo "OK: no paperclip- jobs"
```

---

## Rollback Procedures

### Warm rollback (during 7-day pause window)

- [ ] Disable paperclip routine-checks: edit plist, remove `PAPERCLIP_ROUTINE_CHECKS=1`, `launchctl unload && load`
- [ ] Resume Hermes jobs: `hermes cron resume d2c9532bbc77 && hermes cron resume 673c5760a64a`
- [ ] Verify: `hermes cron list` shows both `state=scheduled`
- [ ] Verify: paperclip log shows `routine-checks: disabled`
- [ ] Recovery time: ~2 minutes

### Cold rollback (after 7-day cleanup)

- [ ] Disable paperclip routine-checks (as above)
- [ ] Restore Hermes snapshot: `cp ~/.hermes/cron/jobs.json.pre-paperclip-migration ~/.hermes/cron/jobs.json`
- [ ] Hermes service reload
- [ ] Verify: `hermes cron list` shows both jobs
- [ ] Recovery time: ~5 minutes

---

## Acceptance Checklist (before declaring complete)

- [ ] All 5 checks have ≥1 successful run in DB within their expected schedule window
- [ ] `paperclip checks list` shows 5 entries
- [ ] `workspace-drift-guard` findings match last Hermes-run ±0 at cutover
- [ ] `subscription-shadow-sync` `inserted_shadow_events` matches last Hermes-run ±1
- [ ] Webhook returns 401 without bearer
- [ ] Webhook 2nd POST with same content_hash returns 200 noop, no Telegram
- [ ] State-change `previous_status=warn → status=ok` produces `✅ recovery —` Telegram even with same hash
- [ ] Hermes jobs `d2c9532bbc77` + `673c5760a64a` show `state=paused` with migration reason (warm) OR are gone after 7d (cold)
- [ ] Openclaw `paperclip_phase0_check.sh` + LaunchAgent are deleted
- [ ] Openclaw `paperclip-heartbeat-check.sh` runs every 30 min via LaunchAgent
- [ ] paperclip-server LaunchAgent has KeepAlive=true, RunAtLoad=true
- [ ] Catch-up: `launchctl unload paperclip-server`, sleep 35m, `launchctl load`, verify exactly 1 catch-up row exists for each check whose slot fell within the downtime
- [ ] `nightly_workspace_consistency_audit.sh` no longer references paperclip
- [ ] All unit tests pass: `pnpm --filter @paperclipai/server test`
- [ ] Hermes pytest passes: `pytest tests/gateway/test_paperclip_notify*.py`

---

## Self-Review Notes

- Spec coverage: every section of the design spec maps to at least one task above (DB → Phase 1; Runner → Phase 4; 5 checks → Phases 5–9; CLI → Phase 11; Webhook+Dedupe → Phase 12; Heartbeat → Phase 13; Cutover/Rollback → Phases 15–16).
- Recovery semantics: `notify.ts` `shouldNotify` test cases lock in spec rules including silent first-run.
- Race-protection: `insertOrSkipRun` test covers double-fire; acceptance criterion covers catch-up + tick race.
- All file paths absolute or repo-relative, no `TBD`/`TODO` placeholders.
