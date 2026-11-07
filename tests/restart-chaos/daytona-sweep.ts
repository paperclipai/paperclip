/**
 * R6 for `--env daytona`: reconcile the Daytona sandboxes this wave created
 * against the instance's environment leases and report leaks.
 *
 * The Daytona org is shared with the live Cloud fleet, so this module NEVER
 * changes a sandbox. Its client exposes only `list`; stop, archive and delete
 * do not exist here. Cleanup goes only through Paperclip: deleting the wave's
 * own environment, which acts on the leases in the wave's isolated database.
 * Leaks are reported for a person, and expire through the environment's ttl.
 *
 * Wave ownership comes from the labels the Daytona plugin puts on every
 * sandbox it creates. Each wave's isolated instance mints a fresh company and
 * environment UUID, and a row is selected only when both labels equal them.
 */
import { setTimeout as delay } from "node:timers/promises";
import { createRemoteFixtureClient } from "../runner-e2e/remote-native-bootstrap.js";
import { deleteDaytonaEnvironment } from "../runner-e2e/live-fixtures.js";
import type { ChaosApi } from "./api.js";

export interface DaytonaSandboxRow { id: string; name?: string; state?: string; snapshot?: string; labels?: Record<string, string> }
export interface LeaseRow { id: string; status: string; providerLeaseId?: string | null; heartbeatRunId?: string | null; issueId?: string | null }

/** Lease statuses where Paperclip still owns a provider resource. */
const HELD_LEASE_STATUSES = new Set(["active", "retained", "pending_cleanup"]);
/** Sandbox states that no longer hold anything. */
const GONE_SANDBOX_STATES = new Set(["destroyed", "destroying"]);
/**
 * The Daytona plugin may archive a sandbox when it releases the lease
 * (`archiveOnRelease`, auto-deleted after 60 min) and Daytona auto-archives
 * stopped ones. An archive behind a lease Paperclip released holds no compute.
 */
const ARCHIVED_SANDBOX_STATES = new Set(["archived", "archiving"]);

export interface SandboxLeak { sandboxId: string; state: string | null; runId: string | null; leaseId: string | null; leaseStatus: string | null; reason: string }
export interface LeaseLeak { leaseId: string; status: string; providerLeaseId: string | null; runId: string | null; issueId: string | null }

export interface DaytonaSweepResult {
  companyId: string;
  environmentId: string;
  checkedAt: string;
  liveSandboxes: string[];
  /** Live sandboxes no held lease accounts for, or whose lease Paperclip already released. */
  orphanSandboxes: SandboxLeak[];
  /** Leases still `active` or `pending_cleanup` with every task at rest. */
  heldLeases: LeaseLeak[];
  /** Leases kept on purpose (`retained`), reported but not a leak. */
  retainedLeases: LeaseLeak[];
  /** Archived sandboxes behind a released lease: expected and reported; Daytona deletes them. */
  archivedSandboxes: string[];
  error: string | null;
}

/** Pure reconciliation of one listing. */
export function reconcileSandboxes(sandboxes: readonly DaytonaSandboxRow[], leases: readonly LeaseRow[]):
  Pick<DaytonaSweepResult, "liveSandboxes" | "orphanSandboxes" | "heldLeases" | "retainedLeases" | "archivedSandboxes"> {
  const live = sandboxes.filter(sandbox => !GONE_SANDBOX_STATES.has(String(sandbox.state ?? "").toLowerCase()));
  const byProviderId = new Map(leases.filter(lease => lease.providerLeaseId).map(lease => [lease.providerLeaseId!, lease]));
  const orphanSandboxes: SandboxLeak[] = [];
  const archivedSandboxes: string[] = [];
  for (const sandbox of live) {
    const lease = byProviderId.get(sandbox.id) ?? (sandbox.name ? byProviderId.get(sandbox.name) : undefined);
    if (lease && HELD_LEASE_STATUSES.has(lease.status)) continue;
    if (lease && ARCHIVED_SANDBOX_STATES.has(String(sandbox.state ?? "").toLowerCase())) { archivedSandboxes.push(sandbox.id); continue; }
    orphanSandboxes.push({ sandboxId: sandbox.id, state: sandbox.state ?? null, runId: sandbox.labels?.["paperclip-run-id"] ?? null,
      leaseId: lease?.id ?? null, leaseStatus: lease?.status ?? null,
      reason: lease ? `sandbox alive after its lease became ${lease.status}` : "no lease references this sandbox" });
  }
  const toLeak = (lease: LeaseRow): LeaseLeak => ({ leaseId: lease.id, status: lease.status, providerLeaseId: lease.providerLeaseId ?? null,
    runId: lease.heartbeatRunId ?? null, issueId: lease.issueId ?? null });
  return {
    liveSandboxes: live.map(sandbox => sandbox.id),
    orphanSandboxes,
    heldLeases: leases.filter(lease => lease.status === "active" || lease.status === "pending_cleanup").map(toLeak),
    retainedLeases: leases.filter(lease => lease.status === "retained").map(toLeak),
    archivedSandboxes,
  };
}

export const sweepHasLeaks = (result: DaytonaSweepResult) => Boolean(result.error || result.orphanSandboxes.length || result.heldLeases.length);

/** Leak descriptions for one task, matched by its run ids and issue id. */
export function leaksForTask(result: DaytonaSweepResult, runIds: ReadonlySet<string>, issueId: string | null): string[] {
  return [
    ...result.orphanSandboxes.filter(leak => leak.runId && runIds.has(leak.runId)).map(leak => `orphan_sandbox=${leak.sandboxId}`),
    ...result.heldLeases.filter(lease => (lease.runId && runIds.has(lease.runId)) || (issueId && lease.issueId === issueId))
      .map(lease => `${lease.status}_lease=${lease.leaseId}`),
  ];
}

/** Leaks no task claimed (setup probes, sandboxes without a run label). */
export function unattributedLeaks(result: DaytonaSweepResult, attributed: ReadonlySet<string>): string[] {
  return [
    ...result.orphanSandboxes.map(leak => `orphan_sandbox=${leak.sandboxId}`),
    ...result.heldLeases.map(lease => `${lease.status}_lease=${lease.leaseId}`),
  ].filter(leak => !attributed.has(leak));
}


/**
 * Mirrors server/src/services/environment-cleanup-state.ts ENVIRONMENT_CLEANUP_RETRY_MS
 * (a unit test keeps them equal). A pending_cleanup lease is retried after this
 * backoff, counted from its last update, by a timed cleanup wake.
 */
export const PENDING_CLEANUP_RETRY_MS = 5 * 60_000;
/** Slack for that timed sweep to run and the provider delete to land. */
const CLEANUP_SWEEP_SLACK_MS = 90_000;
/** R6 waits this long for leases and sandboxes to settle before calling them leaks. */
export const R6_SETTLE_MS = Math.min(8 * 60_000, PENDING_CLEANUP_RETRY_MS + CLEANUP_SWEEP_SLACK_MS);

/** The only Daytona operation the harness may perform. */
export interface ReadOnlyDaytona { list(query: { labels: Record<string, string> }): AsyncIterable<DaytonaSandboxRow> }

/**
 * Wraps the SDK so nothing but a label-filtered `list` is reachable: the
 * returned object has no stop, archive, delete or label-setting method.
 */
export function readOnlyDaytona(client: { list(query?: { labels?: Record<string, string> }): AsyncIterable<DaytonaSandboxRow> }): ReadOnlyDaytona {
  // The SDK is untyped here (it lives in the plugin's own install), so check its shape at runtime.
  if (typeof client?.list !== "function") throw new Error("Daytona SDK client has no list(); the pinned SDK version changed");
  return Object.freeze({ list: (query: { labels: Record<string, string> }) => client.list(query) });
}

/** Fleet sandboxes the harness must never act on, even if their labels matched. */
export function isProtectedSandbox(sandbox: Pick<DaytonaSandboxRow, "name" | "snapshot">): boolean {
  return (sandbox.name ?? "").startsWith("paperclip-create-") || (sandbox.snapshot ?? "").startsWith("fleet-sbx-");
}

/**
 * Hard guard for any future mutating path. It refuses `paperclip-create-*`
 * names and `fleet-sbx-*` snapshots outright, and anything not carrying both
 * of the wave's UUID labels. Every plugin-created sandbox is
 * `paperclip-create-*`, so the harness can never mutate one directly.
 */
export function assertHarnessMayMutate(sandbox: DaytonaSandboxRow, wave: { companyId: string; environmentId: string }): void {
  if (isProtectedSandbox(sandbox)) throw new Error(`Refusing to change protected Daytona sandbox ${sandbox.id} (${sandbox.name ?? sandbox.snapshot})`);
  if (selectWaveSandboxes([sandbox], wave).length !== 1) throw new Error(`Refusing to change Daytona sandbox ${sandbox.id}: it is not labelled for this wave`);
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Keeps only rows whose company AND environment labels equal this wave's UUIDs. */
export function selectWaveSandboxes(rows: readonly DaytonaSandboxRow[], wave: { companyId: string; environmentId: string }): DaytonaSandboxRow[] {
  if (!UUID.test(wave.companyId) || !UUID.test(wave.environmentId)) throw new Error("Wave sandbox selection needs the wave's company and environment UUIDs");
  return rows.filter(row => row.labels?.["paperclip-company-id"] === wave.companyId
    && row.labels?.["paperclip-environment-id"] === wave.environmentId);
}

export class DaytonaWaveSweeper {
  private client: ReadOnlyDaytona | null = null;
  constructor(private readonly input: { apiKey: string; companyId: string; environmentId: string; api: ChaosApi }) {}

  private async daytona(): Promise<ReadOnlyDaytona> {
    this.client ??= readOnlyDaytona(await createRemoteFixtureClient(this.input.apiKey) as unknown as Parameters<typeof readOnlyDaytona>[0]);
    return this.client;
  }

  /** Server-side label filter, then the same check again on every row. */
  async listWaveSandboxes(): Promise<DaytonaSandboxRow[]> {
    const wave = { companyId: this.input.companyId, environmentId: this.input.environmentId };
    const rows: DaytonaSandboxRow[] = [];
    for await (const sandbox of (await this.daytona()).list({ labels: {
      "paperclip-company-id": wave.companyId, "paperclip-environment-id": wave.environmentId } })) rows.push(sandbox);
    return selectWaveSandboxes(rows, wave);
  }

  /** Reconcile, retrying for `settleMs` so normal per-turn and pending-cleanup teardown can finish. */
  async sweep(settleMs = R6_SETTLE_MS): Promise<DaytonaSweepResult> {
    const deadline = Date.now() + settleMs;
    for (;;) {
      const result: DaytonaSweepResult = { companyId: this.input.companyId, environmentId: this.input.environmentId,
        checkedAt: new Date().toISOString(), liveSandboxes: [], orphanSandboxes: [], heldLeases: [], retainedLeases: [], archivedSandboxes: [], error: null };
      try {
        const [sandboxes, leases] = await Promise.all([
          this.listWaveSandboxes(),
          this.input.api.get<LeaseRow[]>(`/api/environments/${this.input.environmentId}/leases`),
        ]);
        Object.assign(result, reconcileSandboxes(sandboxes, leases));
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
      }
      if (!sweepHasLeaks(result) || Date.now() >= deadline) return result;
      await delay(10_000);
    }
  }

  /**
   * Cleanup through Paperclip only: delete the wave's own environment (with its
   * reusable leases). Then list, read-only, what is still not destroyed or
   * archived, for the report. No sandbox is changed by the harness itself.
   */
  async cleanUp(settleMs = 90_000, deleteWindowMs = R6_SETTLE_MS): Promise<{ environmentDeleted: boolean; environmentDeleteBlocked: string | null;
    remainingSandboxes: string[]; errors: string[] }> {
    const errors: string[] = [];
    let environmentDeleted = false;
    let environmentDeleteBlocked: string | null = null;
    try {
      // 409 while a sandbox cleanup is pending is correct product behaviour:
      // deleteDaytonaEnvironment keeps retrying until the window closes.
      await deleteDaytonaEnvironment(this.input.api, this.input.environmentId, Date.now() + deleteWindowMs);
      environmentDeleted = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/returned 409\b/.test(message)) environmentDeleteBlocked = message;
      else errors.push(`environment delete: ${message}`);
    }
    let remainingSandboxes: string[] = [];
    // Provider teardown is asynchronous; give it a bounded settle before reporting.
    const deadline = Date.now() + settleMs;
    for (;;) {
      try {
        remainingSandboxes = (await this.listWaveSandboxes())
          .filter(sandbox => !GONE_SANDBOX_STATES.has(String(sandbox.state ?? "").toLowerCase())
            && !ARCHIVED_SANDBOX_STATES.has(String(sandbox.state ?? "").toLowerCase()))
          .map(sandbox => `${sandbox.id}:${sandbox.state}`);
      } catch (error) {
        errors.push(`sandbox listing: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      if (!remainingSandboxes.length || Date.now() >= deadline) break;
      await delay(10_000);
    }
    return { environmentDeleted, environmentDeleteBlocked, remainingSandboxes, errors };
  }
}
