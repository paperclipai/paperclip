import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServerProcessWindow } from "./multi-server.js";
import { unshiftJson, unshiftMs, type AgingShift } from "./time-faults.js";
import { ISSUE_STATUSES } from "../../packages/shared/src/constants.js";
import type { CompletionEvidence } from "./staging-mix.js";
import { laterAnswers, type DeliveryRun, type DeliveryWake } from "./follow-up-delivery.js";
import { AGENT_SLOTS_FILE, agentSlotsFromRows } from "./agent-slots.js";
import { agents, createDb, type Db } from "../../packages/db/src/index.js";
import { maxConcurrentRunsSql } from "../../server/src/services/heartbeat/timer-policy.js";

type Row = Record<string, unknown>;

export interface ControllerRow { bootId: string; epoch: number; processSpace: string; pid: number; startedAt: number; endedAt: number | null }
export interface ServingServer { pid: number; bootId: string | null; epoch: number | null; processSpace: string | null; harnessRole: string | null }

const ms = (value: unknown) => value === null || value === undefined ? null : Number(value);
const text = (value: unknown) => value === null || value === undefined ? null : String(value);

export const PROCESS_MATCH_SLACK_MS = 60_000;

const STATUSES: ReadonlySet<string> = new Set(ISSUE_STATUSES);

export function isIssueStatusTransition(row: Row): boolean {
  return String(row.action ?? "").startsWith("issue.") && STATUSES.has(String(row.toStatus ?? "")) && (row.fromStatus == null || STATUSES.has(String(row.fromStatus)));
}

export function boundByProcessExit(controllers: readonly ControllerRow[], windows: readonly ServerProcessWindow[]): ControllerRow[] {
  return controllers.map(controller => {
    const window = windows.filter(candidate => candidate.pid === controller.pid && candidate.spawnedAt <= controller.startedAt + PROCESS_MATCH_SLACK_MS
      && (candidate.exitedAt === null || candidate.exitedAt >= controller.startedAt - PROCESS_MATCH_SLACK_MS))
      .sort((a, b) => b.spawnedAt - a.spawnedAt)[0];
    if (!window || window.exitedAt === null) return controller;
    return { ...controller, endedAt: controller.endedAt === null ? window.exitedAt : Math.min(controller.endedAt, window.exitedAt) };
  });
}

export function unshiftRows(rows: readonly Row[], timeKeys: readonly string[], jsonKeys: readonly string[], shifts: readonly AgingShift[]): Row[] {
  if (!shifts.length) return [...rows];
  return rows.map(row => {
    const copy: Row = { ...row };
    for (const key of timeKeys) if (copy[key] !== null && copy[key] !== undefined) copy[key] = unshiftMs(Number(copy[key]), shifts);
    for (const key of jsonKeys) if (copy[key] !== null && copy[key] !== undefined) copy[key] = unshiftJson(copy[key], shifts);
    return copy;
  });
}

export function servingAt(at: number | null, controllers: readonly ControllerRow[], windows: readonly ServerProcessWindow[]): ServingServer[] {
  if (at === null) return [];
  const alive = controllers.filter(controller => controller.startedAt <= at && (controller.endedAt === null || controller.endedAt >= at));
  const fromDb = alive.map(controller => ({ pid: controller.pid, bootId: controller.bootId, epoch: controller.epoch, processSpace: controller.processSpace,
    harnessRole: windows.find(window => window.pid === controller.pid && window.spawnedAt <= at && (window.exitedAt === null || window.exitedAt >= at))?.role ?? null }));
  const known = new Set(fromDb.map(server => server.pid));
  const fromHarness = windows.filter(window => !known.has(window.pid) && window.spawnedAt <= at && (window.exitedAt === null || window.exitedAt >= at))
    .map(window => ({ pid: window.pid, bootId: null, epoch: null, processSpace: null, harnessRole: window.role }));
  return [...fromDb, ...fromHarness];
}

export interface WakeEvidenceInput {
  runs: readonly Row[];
  wakes: readonly Row[];
  statusChanges: readonly Row[];
  controllers: readonly ControllerRow[];
  windows: readonly ServerProcessWindow[];
  issues?: readonly Row[];
  agents?: readonly Row[];
}

export function wakeEvidenceForIssue(issueId: string, input: WakeEvidenceInput) {
  const runs = input.runs.filter(run => run.issueId === issueId);
  const wakeIds = new Set(runs.map(run => text(run.wakeupRequestId)).filter(Boolean));
  const wakes = input.wakes.filter(wake => wake.issueId === issueId || wakeIds.has(text(wake.id)));
  const controllers = boundByProcessExit(input.controllers, input.windows);
  const controllerByBoot = new Map(controllers.map(controller => [controller.bootId, controller]));
  return {
    issueId,
    completedAt: ms(input.issues?.find(issue => issue.id === issueId)?.completedAt),
    runs: runs.map(run => {
      const owner = controllerByBoot.get(String(run.controllerBootId ?? ""));
      return { runId: text(run.id), status: text(run.status), invocationSource: text(run.invocationSource), triggerDetail: text(run.triggerDetail),
        wakeupRequestId: text(run.wakeupRequestId), createdAt: ms(run.createdAt), startedAt: ms(run.startedAt), finishedAt: ms(run.finishedAt),
        acceptedDisposition: text(run.acceptedDisposition), acceptedAt: ms(run.acceptedAt), contextSnapshot: run.contextSnapshot ?? null,        owner: owner ? { pid: owner.pid, bootId: owner.bootId, epoch: owner.epoch, processSpace: owner.processSpace } : null,
        servingAtCreate: servingAt(ms(run.createdAt), controllers, input.windows) };
    }),
    wakes: wakes.map(wake => ({ id: text(wake.id), reason: text(wake.reason), source: text(wake.source), triggerDetail: text(wake.triggerDetail),
      requestedByActorType: text(wake.requestedByActorType), requestedByActorId: text(wake.requestedByActorId), idempotencyKey: text(wake.idempotencyKey),
      status: text(wake.status), runId: text(wake.runId), payload: wake.payload ?? null, error: text(wake.error),
      createdAt: ms(wake.createdAt), requestedAt: ms(wake.requestedAt), claimedAt: ms(wake.claimedAt), finishedAt: ms(wake.finishedAt),
      servingAtCreate: servingAt(ms(wake.createdAt), controllers, input.windows) })),
    statusChanges: input.statusChanges.filter(change => change.issueId === issueId && isIssueStatusTransition(change)).map(change => ({ at: ms(change.createdAt), action: text(change.action),
      actorType: text(change.actorType), actorId: text(change.actorId), runId: text(change.runId), from: text(change.fromStatus), to: text(change.toStatus) })),
  };
}

async function readRows(db: Pick<Db, "$client" | "select">, companyId: string, shifts: readonly AgingShift[]): Promise<Omit<WakeEvidenceInput, "windows">> {
  const client = db.$client;
  const runs = await client.unsafe(
    `select r.id::text as id, r.agent_id::text as "agentId", r.issue_id::text as "issueId", r.status, r.invocation_source as "invocationSource", r.trigger_detail as "triggerDetail",
            r.wakeup_request_id::text as "wakeupRequestId", r.context_snapshot as "contextSnapshot", r.controller_boot_id::text as "controllerBootId",
            floor(extract(epoch from r.created_at) * 1000) as "createdAt", floor(extract(epoch from r.started_at) * 1000) as "startedAt",
            floor(extract(epoch from r.finished_at) * 1000) as "finishedAt", accepted.disposition as "acceptedDisposition",
            floor(extract(epoch from accepted.accepted_at) * 1000) as "acceptedAt"
       from heartbeat_runs r
       left join lateral (select coalesce(e.payload->'prpEvent'->'payload'->'result'->>'reportedWorkDisposition', e.payload->'result'->>'reportedWorkDisposition') as disposition, e.created_at as accepted_at
                            from heartbeat_run_events e where e.run_id = r.id and e.event_type = 'run.result.accepted'
                           order by e.seq desc limit 1) accepted on true
      where r.company_id::text = $1 order by r.created_at`, [companyId]) as Row[];
  const issues = await client.unsafe(
    `select id::text as id, floor(extract(epoch from completed_at) * 1000) as "completedAt" from issues where company_id::text = $1`, [companyId]) as Row[];
  const wakes = await client.unsafe(
    `select id::text as id, payload->>'issueId' as "issueId", source, trigger_detail as "triggerDetail", reason, payload, status,
            requested_by_actor_type as "requestedByActorType", requested_by_actor_id as "requestedByActorId", idempotency_key as "idempotencyKey",
            run_id::text as "runId", error, floor(extract(epoch from created_at) * 1000) as "createdAt",
            floor(extract(epoch from requested_at) * 1000) as "requestedAt", floor(extract(epoch from claimed_at) * 1000) as "claimedAt",
            floor(extract(epoch from finished_at) * 1000) as "finishedAt"
       from agent_wakeup_requests where company_id::text = $1 order by created_at`, [companyId]) as Row[];
  const statusChanges = await client.unsafe(
    `select entity_id as "issueId", action, actor_type as "actorType", actor_id as "actorId", run_id::text as "runId",
            coalesce(details->'_previous'->>'status', details->>'previousStatus') as "fromStatus", details->>'status' as "toStatus",
            floor(extract(epoch from created_at) * 1000) as "createdAt"
       from activity_log where company_id::text = $1 and entity_type = 'issue' and action like 'issue.%'
        and details ? 'status' order by created_at`, [companyId]) as Row[];
  const agentRows = (await db.select({ id: agents.id, companyId: agents.companyId, maxConcurrentRuns: maxConcurrentRunsSql() }).from(agents))
    .filter(agent => agent.companyId === companyId) as Row[];
  const controllers = (await client.unsafe(
    `select boot_id as "bootId", epoch, process_space as "processSpace", pid, floor(extract(epoch from started_at) * 1000) as "startedAt",
            floor(extract(epoch from coalesce(stopped_at, fenced_at)) * 1000) as "endedAt" from controller_instances order by epoch`) as Row[])
    .map(row => ({ bootId: String(row.bootId), epoch: Number(row.epoch), processSpace: String(row.processSpace), pid: Number(row.pid),
      startedAt: Number(row.startedAt), endedAt: ms(row.endedAt) }));
  return {
    runs: unshiftRows(runs, ["createdAt", "startedAt", "finishedAt", "acceptedAt"], ["contextSnapshot"], shifts),
    issues: unshiftRows(issues, ["completedAt"], [], shifts),
    agents: agentRows,
    wakes: unshiftRows(wakes, ["createdAt", "requestedAt", "claimedAt", "finishedAt"], ["payload"], shifts),
    statusChanges: unshiftRows(statusChanges, ["createdAt"], [], shifts),
    controllers: controllers.map(controller => ({ ...controller, startedAt: unshiftMs(controller.startedAt, shifts),
      endedAt: controller.endedAt === null ? null : unshiftMs(controller.endedAt, shifts) })),
  };
}

export async function captureWakeEvidence(input: { db: Pick<Db, "$client" | "select">; companyId: string; waveDir: string;
  observers: ReadonlyArray<EvidenceObserver> | null; windows: readonly ServerProcessWindow[];
  shifts?: readonly AgingShift[]; redact: (text: string) => string }): Promise<number> {
  const rows = await readRows(input.db, input.companyId, input.shifts ?? []);
  const observers: readonly EvidenceObserver[] = input.observers ?? [...new Set(rows.runs.map(run => text(run.issueId)).filter((id): id is string => id !== null))]
    .map(issueId => ({ plan: { taskId: `issue-${issueId}` }, record: { issueId } }));
  const directory = path.join(input.waveDir, "wake-evidence");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let written = 0;
  for (const observer of observers) {
    if (!observer.record.issueId) continue;
    const evidence = { schema: "paperclip.restart-chaos.wake-evidence/v1", taskId: observer.plan.taskId,
      ...wakeEvidenceForIssue(observer.record.issueId, { ...rows, windows: input.windows }) };
    if (observer.plan.stagingMix) (observer.record.stagingMix ??= {}).completion = completionEvidence(evidence);
    await writeFile(path.join(directory, `${observer.plan.taskId}.json`), input.redact(`${JSON.stringify(evidence, null, 2)}\n`), { mode: 0o600 });
    written += 1;
  }
  await writeFile(path.join(directory, "servers.json"), `${JSON.stringify({ controllers: rows.controllers, harnessWindows: input.windows }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(path.join(directory, AGENT_SLOTS_FILE), `${JSON.stringify(agentSlotsFromRows(rows.agents ?? [], rows.runs), null, 2)}\n`, { mode: 0o600 });
  return written;
}

export interface EvidenceObserver {
  plan: { taskId: string; stagingMix?: unknown };
  record: { issueId: string | null; stagingMix?: { completion?: CompletionEvidence } };
}

export function completionEvidence(evidence: { completedAt: number | null; wakes?: readonly DeliveryWake[];
  runs: ReadonlyArray<DeliveryRun & { acceptedDisposition: string | null; acceptedAt: number | null }> }): CompletionEvidence {
  const answers = laterAnswers(evidence);
  return { completedAt: evidence.completedAt, runs: evidence.runs.map(run => ({ runId: run.runId, startedAt: run.startedAt ?? null,
    acceptedDisposition: run.acceptedDisposition, acceptedAt: run.acceptedAt, answersFollowUp: Boolean(run.runId && answers.has(run.runId)) })) };
}

export function wakeEvidenceOnce(input: { databaseUrl: () => string; companyId: string; waveDir: string;
  observers: () => ReadonlyArray<EvidenceObserver>; windows: readonly ServerProcessWindow[];
  shifts: readonly AgingShift[]; redact: (text: string) => string; note: (kind: string, data: Record<string, unknown>) => void;
  open?: (url: string) => Pick<Db, "$client" | "select"> }): () => Promise<void> {
  let done: Promise<void> | null = null;
  return () => done ??= (async () => {
    let observers: ReturnType<typeof input.observers> | null = null;
    try { observers = input.observers(); } catch { observers = null; }
    const db = (input.open ?? createDb)(input.databaseUrl());
    try {
      const written = await captureWakeEvidence({ db, companyId: input.companyId, waveDir: input.waveDir, observers, windows: input.windows,
        shifts: input.shifts, redact: input.redact });
      input.note("wake_evidence_captured", { written, byTask: observers !== null });
    } catch (error) {
      input.note("wake_evidence_failed", { error: String(error) });
    } finally {
      await db.$client.end({ timeout: 5 }).catch(() => undefined);
    }
  })();
}
