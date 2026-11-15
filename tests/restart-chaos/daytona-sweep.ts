/**
 * R6 for `--env daytona`: reconcile the Daytona sandboxes this wave created
 * against the instance's environment leases and report leaks.
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
export interface LeaseRow { id: string; status: string; leasePolicy?: string | null; providerLeaseId?: string | null; heartbeatRunId?: string | null; issueId?: string | null }

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
  /** Leases kept on purpose (`retained`, a released reusable lease whose sandbox is stopped for reuse, or a released retain-on-failure restore source whose sandbox is stopped), reported but not a leak. */
  retainedLeases: LeaseLeak[];
  /** Archived sandboxes behind a released lease: expected and reported; Daytona deletes them. */
  archivedSandboxes: string[];
  error: string | null;
}

/**
 * A stopped sandbox Paperclip keeps on purpose behind a released lease:
 * - `reuse_by_environment`: a later run on the same workspace resumes it;
 * - `retain_on_failure`: a failed run's workspace copy kept for file recovery
 *   (restore recovery owns it; environment deletion destroys it).
 * Only a stopped one counts: a running sandbox, or one with no lease (for
 * example after its environment was deleted), is still a leak.
 */
function keptForReuse(lease: LeaseRow, sandbox: DaytonaSandboxRow): boolean {
  return lease.status === "released"
    && (lease.leasePolicy === "reuse_by_environment" || lease.leasePolicy === "retain_on_failure")
    && String(sandbox.state ?? "").toLowerCase() === "stopped";
}

/** Pure reconciliation of one listing. */
export function reconcileSandboxes(sandboxes: readonly DaytonaSandboxRow[], leases: readonly LeaseRow[]):
  Pick<DaytonaSweepResult, "liveSandboxes" | "orphanSandboxes" | "heldLeases" | "retainedLeases" | "archivedSandboxes"> {
  const live = sandboxes.filter(sandbox => !GONE_SANDBOX_STATES.has(String(sandbox.state ?? "").toLowerCase()));
  const rank = (lease: LeaseRow) => HELD_LEASE_STATUSES.has(lease.status) ? 2 : lease.status === "released" ? 1 : 0;
  const byProviderId = new Map<string, LeaseRow>();
  for (const lease of leases) {
    if (!lease.providerLeaseId) continue;
    const current = byProviderId.get(lease.providerLeaseId);
    if (!current || rank(lease) > rank(current)) byProviderId.set(lease.providerLeaseId, lease);
  }
  const orphanSandboxes: SandboxLeak[] = [];
  const keptReusable: LeaseRow[] = [];
  const archivedSandboxes: string[] = [];
  for (const sandbox of live) {
    const lease = byProviderId.get(sandbox.id) ?? (sandbox.name ? byProviderId.get(sandbox.name) : undefined);
    if (lease && HELD_LEASE_STATUSES.has(lease.status)) continue;
    if (lease && keptForReuse(lease, sandbox)) { keptReusable.push(lease); continue; }
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
    retainedLeases: [...leases.filter(lease => lease.status === "retained"), ...keptReusable].map(toLeak),
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

export function isProtectedSandbox(sandbox: Pick<DaytonaSandboxRow, "name" | "snapshot">): boolean {
  return (sandbox.snapshot ?? "").startsWith("fleet-sbx-");
}

export function assertHarnessMayMutate(sandbox: DaytonaSandboxRow, wave: { companyId: string; environmentId: string }): void {
  if (isProtectedSandbox(sandbox)) throw new Error(`Refusing to change protected Daytona sandbox ${sandbox.id} (${sandbox.name ?? sandbox.snapshot})`);
  if (selectWaveSandboxes([sandbox], wave).length !== 1) throw new Error(`Refusing to change Daytona sandbox ${sandbox.id}: it is not labelled for this wave`);
}

export type SandboxRemove = (sandboxId: string, signal: AbortSignal) => Promise<void>;
export type WaveSandboxDelete = (sandbox: DaytonaSandboxRow, signal: AbortSignal) => Promise<void>;

export const SANDBOX_DELETE_MIN_TIMEOUT_MS = 5_000;

export function waveSandboxDeleter(wave: { companyId: string; environmentId: string }, remove: SandboxRemove): WaveSandboxDelete {
  return Object.freeze(async (sandbox: DaytonaSandboxRow, signal: AbortSignal) => {
    assertHarnessMayMutate(sandbox, wave);
    await remove(sandbox.id, signal);
  });
}

export function daytonaRestDelete(apiKey: string, apiUrl = "https://app.daytona.io/api", request: typeof fetch = fetch): SandboxRemove {
  return async (sandboxId, signal) => {
    const response = await request(`${apiUrl}/sandbox/${encodeURIComponent(sandboxId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` }, signal });
    if (!response.ok && response.status !== 404) throw new Error(`DELETE sandbox ${sandboxId} returned ${response.status}`);
  };
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
  private readonly deleteSandbox: WaveSandboxDelete;
  constructor(private readonly input: { apiKey: string; companyId: string; environmentId: string; api: ChaosApi;
    removeSandbox?: SandboxRemove }) {
    this.deleteSandbox = waveSandboxDeleter({ companyId: input.companyId, environmentId: input.environmentId },
      input.removeSandbox ?? daytonaRestDelete(input.apiKey));
  }

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

  async cleanUp(settleMs = 90_000, deleteWindowMs = R6_SETTLE_MS): Promise<WaveCleanup> {
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
    let archivedSandboxes: string[] = [];
    // Provider teardown is asynchronous; give it a bounded settle before reporting.
    const deadline = Date.now() + settleMs;
    for (;;) {
      try {
        const listed = await this.listWaveSandboxes();
        const state = (sandbox: DaytonaSandboxRow) => String(sandbox.state ?? "").toLowerCase();
        remainingSandboxes = listed.filter(sandbox => !GONE_SANDBOX_STATES.has(state(sandbox)) && !ARCHIVED_SANDBOX_STATES.has(state(sandbox)))
          .map(sandbox => `${sandbox.id}:${sandbox.state}`);
        archivedSandboxes = listed.filter(sandbox => ARCHIVED_SANDBOX_STATES.has(state(sandbox))).map(sandbox => `${sandbox.id}:${sandbox.state}`);
      } catch (error) {
        errors.push(`sandbox listing: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      if (!remainingSandboxes.length || Date.now() >= deadline) break;
      await delay(10_000);
    }
    const removal = await this.deleteWaveSandboxes(settleMs, errors);
    return { environmentDeleted, environmentDeleteBlocked, remainingSandboxes, archivedSandboxes, ...removal, errors };
  }

  private async deleteWaveSandboxes(settleMs: number, errors: string[]): Promise<Pick<WaveCleanup, "deletedSandboxes" | "undeletedSandboxes">> {
    const deleted = new Set<string>();
    const failures = new Map<string, string>();
    let undeleted: DaytonaSandboxRow[] = [];
    const deadline = Date.now() + settleMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        undeleted = (await this.listWaveSandboxes()).filter(sandbox => !GONE_SANDBOX_STATES.has(String(sandbox.state ?? "").toLowerCase()));
      } catch (error) {
        errors.push(`sandbox listing for deletion: ${error instanceof Error ? error.message : String(error)}`);
        return { deletedSandboxes: [...deleted], undeletedSandboxes: ["unlisted"] };
      }
      if (!undeleted.length || (attempt > 0 && Date.now() >= deadline)) break;
      const pass = AbortSignal.timeout(Math.max(SANDBOX_DELETE_MIN_TIMEOUT_MS, deadline - Date.now()));
      for (const sandbox of undeleted) {
        try {
          await this.deleteSandbox(sandbox, pass);
          deleted.add(`${sandbox.id}:${sandbox.state}`);
          failures.delete(sandbox.id);
        } catch (error) {
          failures.set(sandbox.id, error instanceof Error ? error.message : String(error));
        }
      }
      await delay(Math.min(10_000, Math.max(0, deadline - Date.now())));
    }
    for (const [id, message] of failures) if (undeleted.some(sandbox => sandbox.id === id)) errors.push(`sandbox delete ${id}: ${message}`);
    return { deletedSandboxes: [...deleted], undeletedSandboxes: undeleted.map(sandbox => `${sandbox.id}:${sandbox.state}`) };
  }
}

export type WaveCleanup = {
  environmentDeleted: boolean;
  environmentDeleteBlocked: string | null;
  remainingSandboxes: string[];
  archivedSandboxes: string[];
  deletedSandboxes: string[];
  undeletedSandboxes: string[];
  errors: string[];
};
