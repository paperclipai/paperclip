import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS } from "../../packages/paperclip-runner/src/drivers/acpx/generated-profiles.js";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ANTIGRAVITY_JOURNEY_EXECUTION } from "./antigravity-journey-cases.js";
import { ANTIGRAVITY_JOURNEY_MODEL, antigravityConnectionConfig, type AntigravityJourneyConfig } from "./antigravity-journey-config.js";
import { ConnectionBlock, ConnectionFailure } from "./connection-config.js";
import { ConnectionApi, connectionDelay, verifyConnectionTarget } from "./connection-target.js";
import type { AntigravityJourneyEvidence, AntigravityPrimaryOwner } from "./antigravity-journey-evidence.js";
import { antigravityPrimaryOwner, reacquireAntigravityNativeFences, validAntigravityPrimaryOwner } from "./antigravity-journey-evidence.js";
import { observeRunProcesses } from "./copilot-local-fixtures.js";

type Row = Record<string, any>;
/** Work failure and retirement are separate: every finished run status still
 * needs authoritative accounting and the same physical cleanup proof. */
export function isAntigravityRunAccountingSettled(run: Row) {
  return ["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status) && run.costAccountingPending === false;
}
export interface AntigravityJourneyResources {
  version: 1; executionId: string; origin: string; companyId: string; environmentId: string; connectionId: string;
  agentName: string; agentId?: string; issueId?: string; issueIdentifier?: string; runIds: string[];
  /** Intended harness; the ordinary name-only wizard creates a held provisional draft. */
  agentCreationRequest?: { setupId: string; companyId: string; agentName: string; provider: "antigravity"; creatorUserId: string; origin: string };
  retained: boolean; setupProbe: "not_started" | "pending" | "retired" | "retirement_unconfirmed"; processes: Record<string, AntigravityProcessReceipt>;
  noLaunch?: Record<string, AntigravityNoLaunchReceipt>;
  sourceProvenance?: { head: string; trackedDiffSha256: string; untrackedSourceSha256: string; untrackedSourceFileCount: number; suiteDefinitionHash: string; dirty: boolean };
}
export interface AntigravityProcessReceipt {
  captured: boolean; identityChanged: boolean; primaryOwner?: AntigravityPrimaryOwner; journal: Array<{ pid: number; parent: number; start: string }>;
}
export interface AntigravityNoLaunchReceipt {
  kind: "cancelled-before-native-selection"; runId: string; companyId: string; agentId: string; issueId: string;
  environmentId: string; leaseId: string; leaseStatus: "released" | "expired";
  cancelRequestedAt: string; startupPreparationSettledAt: string; leaseReleasedAt: string; observedAt: string;
}

/** The server writes startupPreparationSettledAt only after preparation and
 * lease cleanup finish without native ownership. Absence of a PID alone is not proof. */
export function antigravityNoLaunchReceipt(run: Row, lease: Row, resources: AntigravityJourneyResources): AntigravityNoLaunchReceipt {
  const cancellation = run.resultJson?.startupCancellation;
  const requestedAt = cancellation?.requestedAt, settledAt = run.resultJson?.startupPreparationSettledAt;
  const environment = run.contextSnapshot?.paperclipEnvironment, profile = run.runnerProfileJson;
  const prior = resources.processes[run.id];
  const instant = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
  const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
  if (!resources.runIds.includes(run.id) || run.companyId !== resources.companyId || run.agentId !== resources.agentId
    || !resources.issueId || run.issueId !== resources.issueId || run.status !== "cancelled" || run.executionStage !== "settled"
    || run.costAccountingPending !== false || run.runtimeMode !== "legacy" || run.runtimeModeResolvedAt !== null
    || run.controllerLeaseExpiresAt !== null || cancellation?.beforeNativeSelection !== true || cancellation.errorCode !== "cancelled"
    || !instant(requestedAt) || !instant(settledAt) || Date.parse(requestedAt) > Date.parse(settledAt)
    || ["processPid", "processGroupId", "processStartedAt", "runnerInstanceId", "nativeSessionId", "driverKind", "completionContractId"].some(key => run[key] !== null)
    || !profile || Object.keys(profile).length !== 1 || !profile.adapterDispatch || Object.keys(profile.adapterDispatch).length !== 1
    || profile.adapterDispatch.adapterType !== "paperclip_runner" || prior?.captured || prior?.identityChanged || (prior?.journal.length ?? 0) > 0
    || environment?.id !== resources.environmentId || environment.driver !== "local" || !uuid(environment.leaseId)
    || lease.id !== environment.leaseId || lease.companyId !== resources.companyId || lease.heartbeatRunId !== run.id
    || lease.environmentId !== resources.environmentId || !["released", "expired"].includes(lease.status)
    || !instant(lease.releasedAt) || Date.parse(lease.releasedAt) < Date.parse(requestedAt) || Date.parse(lease.releasedAt) > Date.parse(settledAt)
    || Date.parse(settledAt) > Date.now()) throw new ConnectionFailure("cleanup_no_launch_receipt_unconfirmed");
  return { kind: "cancelled-before-native-selection", runId: run.id, companyId: resources.companyId, agentId: run.agentId,
    issueId: run.issueId, environmentId: resources.environmentId, leaseId: lease.id, leaseStatus: lease.status,
    cancelRequestedAt: requestedAt, startupPreparationSettledAt: settledAt, leaseReleasedAt: lease.releasedAt, observedAt: new Date().toISOString() };
}
export type AntigravityProcessObservers = Map<string, ReturnType<typeof observeRunProcesses>>;
export function selectAntigravityJourneyEnvironment(allowedEnvironments: Row[], environmentId: string): Row {
  const matches = allowedEnvironments.filter(environment => environment.id === environmentId && environment.driver === "local" && environment.status === "active");
  if (matches.length !== 1) throw new ConnectionBlock("blocked_target", "configured_execution_environment_unavailable");
  return matches[0]!;
}
export function observeAntigravityRun(resources: AntigravityJourneyResources, run: Row, observers: AntigravityProcessObservers) {
  if (run.companyId !== resources.companyId || run.agentId !== resources.agentId || (resources.issueId && run.issueId !== resources.issueId))
    throw new ConnectionFailure("observed_run_owner_mismatch");
  if (!resources.runIds.includes(run.id)) resources.runIds.push(run.id);
  let observer = observers.get(run.id);
  if (!observer && !run.processPid) {
    resources.processes[run.id] ??= { captured: false, identityChanged: false, journal: [] };
    return;
  }
  if (!observer) { observer = observeRunProcesses(); observers.set(run.id, observer); }
  const observation = observer.sample(run.processPid ? { pid: run.processPid, groupId: run.processGroupId, startedAt: run.processStartedAt, runId: run.id } : undefined);
  const previous = resources.processes[run.id];
  const journal = previous?.journal ?? [];
  for (const process of observation.journal) if (!journal.some(row => row.pid === process.pid && row.start === process.start)) journal.push({ pid: process.pid, parent: process.parent, start: process.start });
  // Retain accepted physical ownership before deriving a report projection.
  // The launcher's error path persists this record even if projection fails.
  const retained: AntigravityProcessReceipt = { captured: Boolean(previous?.captured || observation.captured),
    identityChanged: Boolean(previous?.identityChanged || observation.identityChanged), ...(previous?.primaryOwner ? { primaryOwner: previous.primaryOwner } : {}), journal };
  resources.processes[run.id] = retained;
  retained.primaryOwner ??= antigravityPrimaryOwner(run, observation);
}

/** Read only the same host's kernel birth identities; never signal a reported PID. */
function remainingRecordedProcesses(receipt: AntigravityProcessReceipt) {
  const table = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,lstart="], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }).split("\n").flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    return row ? [{ pid: Number(row[1]), start: row[3] }] : [];
  });
  return { live: receipt.journal.filter(process => table.some(row => row.pid === process.pid && row.start === process.start)),
    identityChanged: receipt.identityChanged || receipt.journal.some(process => table.some(row => row.pid === process.pid && row.start !== process.start)) };
}

/** Read-only fixture readiness. No credential read, refresh, model discovery,
 * setup Test, admission override or measured-agent provisioning occurs here. */
export async function prepareAntigravityJourney(api: ConnectionApi, config: AntigravityJourneyConfig) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || new URL(api.origin).hostname !== "127.0.0.1")
    throw new ConnectionBlock("blocked_target", "same_host_darwin_arm64_required");
  const identity = await verifyConnectionTarget(api.origin, antigravityConnectionConfig(config), api.request);
  if (config.candidate.profileDigest !== QUALIFIED_ACPX_PROFILES.antigravity.commandDigest
    || config.candidate.nativeClosureDigest !== `sha256:${ANTIGRAVITY_DISTRIBUTION_PINS["darwin-arm64"].closureSha256}`)
    throw new ConnectionBlock("blocked_target", "candidate_pin_mismatch");
  const distribution = JSON.parse(await readFile(new URL("../../packages/paperclip-runner/antigravity-distributions.json", import.meta.url), "utf8"));
  if (distribution.platforms?.["darwin-arm64"]?.patchVersion !== config.candidate.nativeVersion)
    throw new ConnectionBlock("blocked_target", "candidate_native_version_mismatch");
  const session = await api.get<Row>("/api/auth/get-session");
  const company = await api.get<Row>(`/api/companies/${config.target.companyId}`);
  // Environments are instance-scoped. This company-filtered list establishes
  // permission; a fabricated environment.companyId would reject valid locals.
  const environment = selectAntigravityJourneyEnvironment(await api.get<Row[]>(`/api/companies/${company.id}/environments`), config.target.environmentId);
  const connections = await api.get<Row>(`/api/companies/${company.id}/ai-connections`);
  const connection = connections.connections.find((row: Row) => row.id === config.savedConnection.id);
  if (session.user?.id !== config.savedConnection.ownerUserId || connections.currentUserId !== session.user.id
    || company.id !== config.target.companyId || environment.id !== config.target.environmentId
    || environment.driver !== "local" || environment.status !== "active")
    throw new ConnectionBlock("blocked_target", "configured_actor_or_environment_unavailable");
  if (!connection || connection.companyId !== company.id || connection.name !== config.savedConnection.name
    || connection.provider !== "google" || connection.method !== "subscription" || connection.ownership !== "personal"
    || connection.ownerUserId !== session.user.id || connection.status !== "connected" || connection.isDefault !== true || !connection.grantId)
    throw new ConnectionBlock("missing_credential", "same_user_saved_google_default_required");
  const agents = await api.get<Row[]>(`/api/companies/${company.id}/agents`);
  if (!agents.some(agent => agent.status !== "terminated")) throw new ConnectionBlock("blocked_target", "additional_agent_requires_existing_roster");
  const budgets = await api.get<Row>(`/api/companies/${company.id}/budgets/overview`);
  const companyPolicies = budgets.policies.filter((policy: Row) => policy.scopeType === "company" && policy.scopeId === company.id && policy.isActive);
  if (company.status !== "active" || companyPolicies.some((policy: Row) => policy.hardStopEnabled && (policy.status === "hard_stop"
    || policy.remainingAmount <= 0 || policy.pendingRunCount > 0 || (policy.unpricedUsagePolicy !== "allow" && policy.unpricedEventCount > 0))))
    throw new ConnectionBlock("blocked_target", "company_budget_admission_blocked");
  const adapters = await api.get<Row[]>(`/api/adapters?${new URLSearchParams({ companyId: company.id, environmentId: environment.id })}`);
  const runner = adapters.find(adapter => adapter.type === "paperclip_runner");
  if (!runner?.loaded || runner.disabled || !runner.candidateHarnesses?.some((candidate: Row) => candidate.agent === "antigravity" && candidate.model === ANTIGRAVITY_JOURNEY_MODEL))
    throw new ConnectionBlock("blocked_target", "trusted_antigravity_candidate_admission_required");
  const accounting = companyPolicies.map((policy: Row) => ({ scopeType: "company", amount: policy.amount, remainingAmount: policy.remainingAmount,
    hardStopEnabled: policy.hardStopEnabled, unpricedUsagePolicy: policy.unpricedUsagePolicy, pendingRunCount: policy.pendingRunCount, unpricedEventCount: policy.unpricedEventCount }));
  return { company, environment, connection, identity, accounting };
}

/** Recovery accepts only the current attempt's persisted exact identities. */
export function parseAntigravityOwnedResources(input: unknown, config: AntigravityJourneyConfig): AntigravityJourneyResources {
  const v = input as Partial<AntigravityJourneyResources> | null;
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const allowed = ["version", "executionId", "origin", "companyId", "environmentId", "connectionId", "agentName", "agentId", "agentCreationRequest", "issueId", "issueIdentifier", "runIds", "retained", "setupProbe", "processes", "noLaunch", "sourceProvenance"];
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(key => !allowed.includes(key)) || v.version !== 1 || v.executionId !== ANTIGRAVITY_JOURNEY_EXECUTION
    || v.origin !== config.target.baseURL || v.companyId !== config.target.companyId || v.environmentId !== config.target.environmentId
    || v.connectionId !== config.savedConnection.id || !/^Antigravity QA [a-f0-9]{12}$/.test(v.agentName ?? "")
    || (v.agentId !== undefined && !uuid.test(v.agentId)) || (v.issueId !== undefined && !uuid.test(v.issueId))
    || !Array.isArray(v.runIds) || v.runIds.length > 100 || new Set(v.runIds).size !== v.runIds.length || v.runIds.some(id => typeof id !== "string" || !uuid.test(id)) || typeof v.retained !== "boolean"
    || !["not_started", "pending", "retired", "retirement_unconfirmed"].includes(v.setupProbe ?? "")
    || !v.processes || typeof v.processes !== "object" || Array.isArray(v.processes)
    || Object.entries(v.processes).some(([runId, receipt]) => !uuid.test(runId) || typeof receipt?.captured !== "boolean" || typeof receipt.identityChanged !== "boolean"
      || (receipt.primaryOwner !== undefined && (!validAntigravityPrimaryOwner(receipt.primaryOwner) || receipt.primaryOwner.runId !== runId))
      || !Array.isArray(receipt.journal) || receipt.journal.length > 1000 || receipt.journal.some(process => !Number.isSafeInteger(process.pid)
        || process.pid <= 1 || !Number.isSafeInteger(process.parent) || process.parent < 0 || typeof process.start !== "string" || !Number.isFinite(Date.parse(process.start)))))
    throw new ConnectionFailure("invalid_antigravity_owned_resources");
  const creation = v.agentCreationRequest;
  if (creation !== undefined && (!creation || typeof creation !== "object" || Array.isArray(creation)
    || Object.keys(creation).length !== 6 || Object.keys(creation).some(key => !["setupId", "companyId", "agentName", "provider", "creatorUserId", "origin"].includes(key))
    || typeof creation.setupId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(creation.setupId) || (v.agentId !== undefined && v.agentId !== creation.setupId)
    || creation.companyId !== v.companyId || creation.agentName !== v.agentName || creation.provider !== "antigravity"
    || creation.creatorUserId !== config.savedConnection.ownerUserId || creation.origin !== v.origin))
    throw new ConnectionFailure("invalid_antigravity_owned_resources");
  if (v.noLaunch !== undefined && (!v.noLaunch || typeof v.noLaunch !== "object" || Array.isArray(v.noLaunch)
    || Object.entries(v.noLaunch).some(([runId, receipt]) => !v.runIds!.includes(runId) || !receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || Object.keys(receipt).length !== 12 || Object.keys(receipt).some(key => !["kind", "runId", "companyId", "agentId", "issueId", "environmentId", "leaseId", "leaseStatus", "cancelRequestedAt", "startupPreparationSettledAt", "leaseReleasedAt", "observedAt"].includes(key))
      || receipt.kind !== "cancelled-before-native-selection" || receipt.runId !== runId || receipt.companyId !== v.companyId
      || receipt.agentId !== v.agentId || receipt.issueId !== v.issueId || receipt.environmentId !== v.environmentId || !uuid.test(receipt.leaseId)
      || !["released", "expired"].includes(receipt.leaseStatus)
      || [receipt.cancelRequestedAt, receipt.startupPreparationSettledAt, receipt.leaseReleasedAt, receipt.observedAt].some(value => typeof value !== "string" || !Number.isFinite(Date.parse(value)))
      || Date.parse(receipt.cancelRequestedAt) > Date.parse(receipt.leaseReleasedAt) || Date.parse(receipt.leaseReleasedAt) > Date.parse(receipt.startupPreparationSettledAt)
      || Date.parse(receipt.startupPreparationSettledAt) > Date.parse(receipt.observedAt)))) throw new ConnectionFailure("invalid_antigravity_owned_resources");
  if (v.sourceProvenance && (Object.keys(v.sourceProvenance).some(key => !["head", "trackedDiffSha256", "untrackedSourceSha256", "untrackedSourceFileCount", "suiteDefinitionHash", "dirty"].includes(key))
    || !/^[a-f0-9]{40}$/.test(v.sourceProvenance.head) || [v.sourceProvenance.trackedDiffSha256, v.sourceProvenance.untrackedSourceSha256, v.sourceProvenance.suiteDefinitionHash].some(value => !/^[a-f0-9]{64}$/.test(value))
    || !Number.isSafeInteger(v.sourceProvenance.untrackedSourceFileCount) || v.sourceProvenance.untrackedSourceFileCount < 0 || typeof v.sourceProvenance.dirty !== "boolean"))
    throw new ConnectionFailure("invalid_antigravity_owned_resources");
  return v as AntigravityJourneyResources;
}

export async function cleanupAntigravityJourney(input: {
  api: ConnectionApi; config: AntigravityJourneyConfig; resources: AntigravityJourneyResources;
  cleanup: AntigravityJourneyEvidence["cleanup"]; persistResources(): Promise<void>;
  /** Save public usage while these exact owned rows still exist. No launch or admission checks. */
  captureRun(run: Row): Promise<void>;
  observers?: AntigravityProcessObservers;
}) {
  const { api, config, resources, cleanup } = input;
  cleanup.connectionPreserved = false;
  let pendingDraft: Row | undefined;
  if (!resources.agentId && resources.agentCreationRequest) {
    cleanup.agent = false;
    const creation = resources.agentCreationRequest;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(creation.setupId)
      || creation.companyId !== resources.companyId || creation.agentName !== resources.agentName || creation.origin !== resources.origin
      || creation.creatorUserId !== config.savedConnection.ownerUserId || creation.provider !== "antigravity")
      throw new ConnectionFailure("cleanup_agent_owner_mismatch");
    let draft: Row;
    try { draft = await api.get<Row>(`/api/agents/${creation.setupId}?companyId=${resources.companyId}`); }
    catch (error) {
      if (error instanceof ConnectionFailure && error.message === "api_status_404")
        throw new ConnectionFailure("cleanup_agent_creation_unconfirmed");
      throw error;
    }
    if (!draft || draft.id !== creation.setupId || draft.companyId !== resources.companyId || draft.name !== resources.agentName
      || draft.createdByUserId !== creation.creatorUserId)
      throw new ConnectionFailure("cleanup_agent_owner_mismatch");
    pendingDraft = draft;
  }
  if (resources.agentId) cleanup.agent = false;
  if (resources.runIds.length) cleanup.runs = false;
  const agents = await api.get<Row[]>(`/api/companies/${resources.companyId}/agents`);
  const named = agents.filter(agent => agent.name === resources.agentName);
  if (pendingDraft) {
    if (named.length !== 1 || named[0]!.id !== pendingDraft.id || named[0]!.companyId !== resources.companyId)
      throw new ConnectionFailure("cleanup_agent_owner_mismatch");
    resources.agentId = pendingDraft.id;
    await input.persistResources();
  }
  if (!resources.agentId && named.length) throw new ConnectionFailure("cleanup_requires_agent_creation_receipt");
  const agent = agents.find(agent => agent.id === resources.agentId);
  if (agent && (agent.companyId !== resources.companyId || agent.name !== resources.agentName || named.length !== 1))
    throw new ConnectionFailure("cleanup_agent_owner_mismatch");
  if (agent && agents.some(row => row.reportsTo === agent.id)) throw new ConnectionFailure("cleanup_agent_has_unowned_reports");
  if (agent) {
    cleanup.agent = false; cleanup.runs = false;
    const requestedStops = new Map<string, string | null>();
    const assertRunOwner = (run: Row, runId: string) => {
      if (run.id !== runId || run.companyId !== resources.companyId || run.agentId !== agent.id
        || (resources.issueId && run.issueId !== resources.issueId))
        throw new ConnectionFailure("cleanup_run_owner_mismatch");
    };
    const nativeStop = (run: Row): { requestId?: string; intent?: Row } | undefined => {
      if (run.runtimeMode !== "native") return;
      const requestId = run.resultJson?.startupCancellation?.cancellationRequestId;
      const intent = run.resultJson?.nativeCancellation;
      if (requestId == null && intent == null) return;
      if (typeof run.issueId !== "string" || !run.issueId || (resources.issueId && run.issueId !== resources.issueId)
        || (requestId != null && (typeof requestId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(requestId))))
        throw new ConnectionFailure("cleanup_native_stop_identity_mismatch");
      if (intent != null && (intent.schema !== "paperclip.native-cancellation.v1" || typeof intent.intentId !== "string" || !intent.intentId
        || intent.runId !== run.id || intent.companyId !== resources.companyId || intent.issueId !== run.issueId
        || intent.scope !== "run" || intent.reasonCode !== "cancellation_run_only" || typeof intent.dispatched !== "boolean"
        || !["pending", "acknowledged"].includes(intent.dispatchState) || typeof intent.intentAuditId !== "string" || !intent.intentAuditId
        || (requestId != null && intent.intentId !== `native-cancellation:${requestId}`)
        || (intent.dispatchState === "acknowledged" && (typeof intent.acknowledgementAuditId !== "string" || !intent.acknowledgementAuditId
          || intent.acknowledgementAuditId === intent.intentAuditId))))
        throw new ConnectionFailure("cleanup_native_stop_identity_mismatch");
      return { ...(requestId == null ? {} : { requestId }), ...(intent == null ? {} : { intent }) };
    };
    const stopOwnedRun = async (run: Row) => {
      const stop = nativeStop(run);
      const retryOwner = run.runtimeMode === "native" && run.status === "failed" && run.nativePhase === "retryable_failure";
      // A prior Stop advances the coordinator before its acknowledgement. Its
      // public correlation is durable; recovery must replay the same request.
      const resumeStop = run.runtimeMode === "native" && run.status === "failed" && stop?.intent != null;
      // A UUID reservation alone is not retry authority. A terminal row with
      // no durable native intent remains unconfirmed instead of issuing Stop.
      if (!["queued", "running", "scheduled_retry"].includes(run.status) && !retryOwner && !resumeStop) return;
      if (resources.issueId && run.issueId !== resources.issueId) throw new ConnectionFailure("cleanup_run_owner_mismatch");
      if (requestedStops.has(run.id)) return;
      if (run.runtimeMode === "native") {
        if (typeof run.issueId !== "string" || !run.issueId || (stop?.intent && !stop.requestId))
          throw new ConnectionFailure("cleanup_native_stop_identity_mismatch");
        const requestId = stop?.requestId ?? randomUUID();
        await api.post(`/api/heartbeat-runs/${run.id}/cancel`, { cancellationRequestId: requestId });
        requestedStops.set(run.id, requestId);
      } else {
        await api.post(`/api/heartbeat-runs/${run.id}/cancel`);
        requestedStops.set(run.id, null);
      }
    };
    const nativeStopAcknowledged = (run: Row) => {
      const stop = nativeStop(run), requested = requestedStops.get(run.id);
      if (requested == null && !stop) return true;
      return run.status === "cancelled" && stop?.intent?.dispatchState === "acknowledged"
        && (requested == null || stop.requestId === requested);
    };
    await api.patch(`/api/agents/${agent.id}`, { status: "paused" });
    const runs = await api.get<Row[]>(`/api/companies/${resources.companyId}/heartbeat-runs?agentId=${agent.id}&limit=100`);
    for (const run of runs) {
      if (run.agentId !== agent.id || run.companyId !== resources.companyId) throw new ConnectionFailure("cleanup_run_owner_mismatch");
      if (!resources.runIds.includes(run.id)) resources.runIds.push(run.id);
      const observed = await api.get<Row>(`/api/heartbeat-runs/${run.id}`);
      assertRunOwner(observed, run.id);
      await input.captureRun(observed);
      observeAntigravityRun(resources, observed, input.observers ?? new Map());
      await input.persistResources();
      await stopOwnedRun(observed);
    }
    await input.persistResources();
    const deadline = Date.now() + 60_000;
    while (true) {
      const latest = await api.get<Row[]>(`/api/companies/${resources.companyId}/heartbeat-runs?agentId=${agent.id}&limit=100`);
      for (const run of latest) {
        if (run.companyId !== resources.companyId || run.agentId !== agent.id) throw new ConnectionFailure("cleanup_run_owner_mismatch");
        if (resources.runIds.includes(run.id)) continue;
        resources.runIds.push(run.id);
        const observed = await api.get<Row>(`/api/heartbeat-runs/${run.id}`);
        assertRunOwner(observed, run.id);
        await input.captureRun(observed);
        observeAntigravityRun(resources, observed, input.observers ?? new Map());
        await input.persistResources();
        await stopOwnedRun(observed);
      }
      let retired = !latest.some(run => run.agentId === agent.id && ["queued", "running", "scheduled_retry"].includes(run.status));
      for (const runId of resources.runIds) {
        const run = await api.get<Row>(`/api/heartbeat-runs/${runId}`);
        assertRunOwner(run, runId);
        await input.captureRun(run);
        await stopOwnedRun(run);
        if (!nativeStopAcknowledged(run)) { retired = false; continue; }
        if (!isAntigravityRunAccountingSettled(run)) retired = false;
        const receipt = resources.processes[runId];
        if ((!receipt?.captured || receipt.journal.length < 2) && run.resultJson?.startupCancellation?.beforeNativeSelection === true) {
          const cancellation = run.resultJson.startupCancellation, settledAt = run.resultJson.startupPreparationSettledAt;
          const environment = run.contextSnapshot?.paperclipEnvironment, profile = run.runnerProfileJson;
          const instant = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
          // Cancellation may return while its original preparation owner is
          // still settling. Only missing progress receipts may wait; ownership
          // contradictions and malformed evidence must not become a timeout.
          if (run.issueId !== resources.issueId || run.status !== "cancelled" || run.runtimeMode !== "legacy" || run.runtimeModeResolvedAt !== null
            || !["preparing", "settled"].includes(run.executionStage) || typeof run.costAccountingPending !== "boolean"
            || cancellation.errorCode !== "cancelled" || !instant(cancellation.requestedAt) || (settledAt != null && !instant(settledAt))
            || (run.controllerLeaseExpiresAt !== null && !instant(run.controllerLeaseExpiresAt))
            || ["processPid", "processGroupId", "processStartedAt", "runnerInstanceId", "nativeSessionId", "driverKind", "completionContractId"].some(key => run[key] !== null)
            || !profile || Object.keys(profile).length !== 1 || !profile.adapterDispatch || Object.keys(profile.adapterDispatch).length !== 1
            || profile.adapterDispatch.adapterType !== "paperclip_runner" || receipt?.captured || receipt?.identityChanged || (receipt?.journal.length ?? 0) > 0
            || environment?.id !== resources.environmentId || environment.driver !== "local") throw new ConnectionFailure("cleanup_no_launch_receipt_unconfirmed");
          const leaseId = environment.leaseId;
          if (typeof leaseId !== "string") throw new ConnectionFailure("cleanup_lease_identity_missing");
          const lease = await api.get<Row>(`/api/environment-leases/${leaseId}`);
          if (lease.id !== leaseId || lease.companyId !== resources.companyId || lease.heartbeatRunId !== runId || lease.environmentId !== resources.environmentId)
            throw new ConnectionFailure("cleanup_lease_owner_mismatch");
          if (!["active", "released", "expired", "failed", "retained", "pending_cleanup"].includes(lease.status)
            || (lease.releasedAt != null && !instant(lease.releasedAt))
            || (settledAt != null && Date.parse(settledAt) < Date.parse(cancellation.requestedAt))
            || (lease.releasedAt != null && (Date.parse(lease.releasedAt) < Date.parse(cancellation.requestedAt)
              || (settledAt != null && Date.parse(lease.releasedAt) > Date.parse(settledAt))))) throw new ConnectionFailure("cleanup_no_launch_receipt_unconfirmed");
          if (run.executionStage !== "settled" || settledAt == null || run.costAccountingPending || run.controllerLeaseExpiresAt !== null
            || !["released", "expired"].includes(lease.status) || lease.releasedAt == null) { retired = false; continue; }
          const noLaunch = antigravityNoLaunchReceipt(run, lease, resources);
          (resources.noLaunch ??= {})[runId] = noLaunch;
          await input.persistResources();
          continue;
        }
        if (!receipt?.captured || receipt.journal.length < 2) throw new ConnectionFailure("cleanup_physical_owner_not_captured");
        const observed = remainingRecordedProcesses(receipt);
        if (observed.identityChanged) throw new ConnectionFailure("cleanup_physical_identity_changed");
        if (observed.live.length) { retired = false; continue; }
        const leaseId = run.contextSnapshot?.paperclipEnvironment?.leaseId;
        if (typeof leaseId !== "string") throw new ConnectionFailure("cleanup_lease_identity_missing");
        const lease = await api.get<Row>(`/api/environment-leases/${leaseId}`);
        if (lease.companyId !== resources.companyId || lease.heartbeatRunId !== runId || lease.environmentId !== resources.environmentId)
          throw new ConnectionFailure("cleanup_lease_owner_mismatch");
        if (lease.status !== "released") { retired = false; continue; }
        try { await reacquireAntigravityNativeFences(run.runnerProfileJson?.sessionCheckpoint?.providerIdentity?.providerLifetimeFenceCandidates); }
        catch { throw new ConnectionFailure("cleanup_native_fences_unconfirmed"); }
      }
      if (retired) break;
      if (Date.now() > deadline) throw new ConnectionFailure("cleanup_run_retirement_unconfirmed");
      await connectionDelay(250);
    }
    cleanup.runs = true;
    if (resources.issueId) {
      const issue = await api.get<Row>(`/api/issues/${resources.issueId}`);
      if (issue.companyId !== resources.companyId || issue.assigneeAgentId !== agent.id) throw new ConnectionFailure("cleanup_issue_owner_mismatch");
      if (!["done", "cancelled"].includes(issue.status)) await api.patch(`/api/issues/${issue.id}`, { status: "cancelled" });
    }
    if (["pending", "retirement_unconfirmed"].includes(resources.setupProbe)) throw new ConnectionFailure("setup_probe_retirement_unconfirmed");
    if (!config.retainAgent) {
      // Purge is allowed only after the ordinary lifecycle owner completes termination.
      await api.post(`/api/agents/${agent.id}/terminate`);
      const terminateDeadline = Date.now() + 30_000;
      while (true) {
        const current = await api.get<Row>(`/api/agents/${agent.id}`);
        if (current.companyId !== resources.companyId || current.name !== resources.agentName) throw new ConnectionFailure("cleanup_agent_owner_mismatch");
        if (["terminated", "rejected"].includes(current.lifecycleState)) break;
        if (Date.now() >= terminateDeadline) throw new ConnectionFailure("cleanup_agent_termination_unconfirmed");
        await connectionDelay(250);
      }
      await api.delete(`/api/agents/${agent.id}`);
    } else {
      const retained = await api.get<Row>(`/api/agents/${agent.id}`);
      if (retained.id !== agent.id || retained.companyId !== resources.companyId || retained.name !== resources.agentName || retained.status !== "paused")
        throw new ConnectionFailure("cleanup_retained_agent_pause_unconfirmed");
    }
    resources.retained = config.retainAgent;
    cleanup.agent = true;
  } else {
    if (resources.runIds.length) throw new ConnectionFailure("cleanup_agent_removed_before_retirement_verification");
    cleanup.agent = true; cleanup.runs = true;
  }
  if (["pending", "retirement_unconfirmed"].includes(resources.setupProbe)) throw new ConnectionFailure("setup_probe_retirement_unconfirmed");
  const accounts = await api.get<Row>(`/api/companies/${resources.companyId}/ai-connections`);
  const connection = accounts.connections.find((row: Row) => row.id === config.savedConnection.id);
  cleanup.connectionPreserved = Boolean(connection && connection.provider === "google" && connection.method === "subscription"
    && connection.ownerUserId === config.savedConnection.ownerUserId && connection.isDefault === true && connection.status === "connected");
  if (!cleanup.connectionPreserved) throw new ConnectionFailure("existing_connection_not_preserved");
  await input.persistResources();
}
