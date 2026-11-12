import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServerProcessWindow } from "./multi-server.js";
import type { Db } from "../../packages/db/src/index.js";

type Row = Record<string, unknown>;

export interface ControllerRow { bootId: string; epoch: number; processSpace: string; pid: number; startedAt: number; endedAt: number | null }
export interface ServingServer { pid: number; bootId: string | null; epoch: number | null; processSpace: string | null; harnessRole: string | null }

const ms = (value: unknown) => value === null || value === undefined ? null : Number(value);
const text = (value: unknown) => value === null || value === undefined ? null : String(value);

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
}

export function wakeEvidenceForIssue(issueId: string, input: WakeEvidenceInput) {
  const runs = input.runs.filter(run => run.issueId === issueId);
  const wakeIds = new Set(runs.map(run => text(run.wakeupRequestId)).filter(Boolean));
  const wakes = input.wakes.filter(wake => wake.issueId === issueId || wakeIds.has(text(wake.id)));
  const controllerByBoot = new Map(input.controllers.map(controller => [controller.bootId, controller]));
  return {
    issueId,
    runs: runs.map(run => {
      const owner = controllerByBoot.get(String(run.controllerBootId ?? ""));
      return { runId: text(run.id), status: text(run.status), invocationSource: text(run.invocationSource), triggerDetail: text(run.triggerDetail),
        wakeupRequestId: text(run.wakeupRequestId), createdAt: ms(run.createdAt), startedAt: ms(run.startedAt), finishedAt: ms(run.finishedAt),
        contextSnapshot: run.contextSnapshot ?? null,
        owner: owner ? { pid: owner.pid, bootId: owner.bootId, epoch: owner.epoch, processSpace: owner.processSpace } : null,
        servingAtCreate: servingAt(ms(run.createdAt), input.controllers, input.windows) };
    }),
    wakes: wakes.map(wake => ({ id: text(wake.id), reason: text(wake.reason), source: text(wake.source), triggerDetail: text(wake.triggerDetail),
      requestedByActorType: text(wake.requestedByActorType), requestedByActorId: text(wake.requestedByActorId), idempotencyKey: text(wake.idempotencyKey),
      status: text(wake.status), runId: text(wake.runId), payload: wake.payload ?? null, error: text(wake.error),
      createdAt: ms(wake.createdAt), requestedAt: ms(wake.requestedAt), claimedAt: ms(wake.claimedAt), finishedAt: ms(wake.finishedAt),
      servingAtCreate: servingAt(ms(wake.createdAt), input.controllers, input.windows) })),
    statusChanges: input.statusChanges.filter(change => change.issueId === issueId).map(change => ({ at: ms(change.createdAt), action: text(change.action),
      actorType: text(change.actorType), actorId: text(change.actorId), runId: text(change.runId), from: text(change.fromStatus), to: text(change.toStatus) })),
  };
}

async function readRows(db: Pick<Db, "$client">, companyId: string): Promise<Omit<WakeEvidenceInput, "windows">> {
  const client = db.$client;
  const runs = await client.unsafe(
    `select id::text as id, issue_id::text as "issueId", status, invocation_source as "invocationSource", trigger_detail as "triggerDetail",
            wakeup_request_id::text as "wakeupRequestId", context_snapshot as "contextSnapshot", controller_boot_id::text as "controllerBootId",
            floor(extract(epoch from created_at) * 1000) as "createdAt", floor(extract(epoch from started_at) * 1000) as "startedAt",
            floor(extract(epoch from finished_at) * 1000) as "finishedAt"
       from heartbeat_runs where company_id::text = $1 order by created_at`, [companyId]) as Row[];
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
       from activity_log where company_id::text = $1 and entity_type = 'issue'
        and (details ? 'status' or details->'_previous' ? 'status' or details ? 'previousStatus') order by created_at`, [companyId]) as Row[];
  const controllers = (await client.unsafe(
    `select boot_id as "bootId", epoch, process_space as "processSpace", pid, floor(extract(epoch from started_at) * 1000) as "startedAt",
            floor(extract(epoch from coalesce(stopped_at, fenced_at)) * 1000) as "endedAt" from controller_instances order by epoch`) as Row[])
    .map(row => ({ bootId: String(row.bootId), epoch: Number(row.epoch), processSpace: String(row.processSpace), pid: Number(row.pid),
      startedAt: Number(row.startedAt), endedAt: ms(row.endedAt) }));
  return { runs, wakes, statusChanges, controllers };
}

export async function captureWakeEvidence(input: { db: Pick<Db, "$client">; companyId: string; waveDir: string;
  observers: ReadonlyArray<{ plan: { taskId: string }; record: { issueId: string | null } }>; windows: readonly ServerProcessWindow[]; redact: (text: string) => string }): Promise<number> {
  const rows = await readRows(input.db, input.companyId);
  const directory = path.join(input.waveDir, "wake-evidence");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let written = 0;
  for (const observer of input.observers) {
    if (!observer.record.issueId) continue;
    const evidence = { schema: "paperclip.restart-chaos.wake-evidence/v1", taskId: observer.plan.taskId,
      ...wakeEvidenceForIssue(observer.record.issueId, { ...rows, windows: input.windows }) };
    await writeFile(path.join(directory, `${observer.plan.taskId}.json`), input.redact(`${JSON.stringify(evidence, null, 2)}\n`), { mode: 0o600 });
    written += 1;
  }
  await writeFile(path.join(directory, "servers.json"), `${JSON.stringify({ controllers: rows.controllers, harnessWindows: input.windows }, null, 2)}\n`, { mode: 0o600 });
  return written;
}
