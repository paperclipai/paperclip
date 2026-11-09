import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { inspectDurablePrpCheckpointHeader, type DurablePrpCheckpoint } from "../../packages/paperclip-runner/src/control-plane/durable-prp-control-plane.js";
import { parseNativeExecutionInput } from "../../packages/paperclip-runner/src/contracts/native-execution.js";
import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";
import type { KimiContextPublication } from "./kimi-context-rendezvous.js";

type Row = Record<string, any>;
const rec = (x: unknown): Row => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Row : {};
const bytes = (x: string) => createHash("sha256").update(x).digest("hex");
const hash = (x: unknown) => `sha256:${bytes(canonicalJson(x))}`;
const demand = (x: unknown): void => { if (!x) throw new Error("Kimi context checkpoint: exact bound result delivery unavailable"); };
export interface KimiContextAuthority {
  schema: "paperclip.e2e.kimi-context-authority.v2";
  companyId: string; issueId: string; agentId: string; environmentId: string; runId: string;
  sessionId: string; sourceInstanceId: string; turnId: string;
  observerLeaseId: string; executionWorkspaceId: string; controllerTurnId: string; controllerItemId: string; requestId: string; toolCallId: string;
  requestCreatedSourceSeq: number; requestResolvedSourceSeq: number; requestCreatedSha256: string; requestResolvedSha256: string; turnStartSha256: string; resolutionCommandSha256: string;
  actionSha256: string; callId: string; inputSourceSeq: number; inputSourceEventId: string;
  inputSha256: string; inputEventSha256: string; resultSha256: string; correlationSha256: string;
  commandId: string; controllerSeq: number; commandSha256: string; deliverySha256: string;
  checkpointIdentitySha256: string; authenticatedConnectionCount: number; highestRecordedSourceSeq: number;
}
export function projectKimiContextCheckpoint(checkpoint: DurablePrpCheckpoint, p: KimiContextPublication, executionWorkspaceId: string): KimiContextAuthority | undefined {
  demand(typeof p.observerLeaseId === "string" && p.observerLeaseId.length > 0 && checkpoint.runId === p.runId && checkpoint.records.size <= 20_000);
  const identity = inspectDurablePrpCheckpointHeader(checkpoint.records.get("header") ?? "null"), evidence = checkpoint.recoveryEvidence;
  demand(identity && identity.runId === p.runId && identity.normalizedSessionId === p.sessionId && identity.runnerInstanceId === p.sourceInstanceId
    && typeof executionWorkspaceId === "string" && executionWorkspaceId.length > 0 && identity.environmentLeaseId === executionWorkspaceId && evidence.runnerInstanceId === p.sourceInstanceId && evidence.normalizedSessionId === p.sessionId
    && Number.isSafeInteger(evidence.authenticatedConnectionCount) && evidence.authenticatedConnectionCount > 0
    && Number.isSafeInteger(evidence.highestRecordedSourceSeq) && evidence.highestRecordedSourceSeq > 0);
  const events: Row[] = [], commands: Row[] = [], requests: Row[] = [], turnStarts: Row[] = [], resolutions: Row[] = []; let total = 0;
  for (const [key, value] of checkpoint.records) {
    if (!/^(event|command):[0-9]+$/.test(key)) continue;
    total += Buffer.byteLength(value); demand(total <= 32 * 1024 * 1024);
    const row = rec(JSON.parse(value));
    if (key.startsWith("event:") && row.eventType === "semantic_tool.input") events.push(row);
    if (key.startsWith("command:") && row.type === "semantic_tool.result") commands.push(row);
    if (key.startsWith("event:") && ["runtime_request.created", "runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(row.eventType)
      && (rec(rec(rec(row.envelope).payload).payload).requestId === p.requestId || rec(rec(rec(rec(row.envelope).payload).payload).request).requestId === p.requestId)) requests.push(row);
    if (key.startsWith("command:") && row.type === "turn.start") turnStarts.push(row);
    if (key.startsWith("command:") && row.type === "request.resolve" && rec(row.payload).requestId === p.requestId) resolutions.push(row);
  }
  const controllerEvent = (saved: Row) => {
    const envelope = rec(saved.envelope), event = rec(envelope.payload);
    demand(envelope.protocol === "paperclip.runner" && envelope.kind === "event" && envelope.runId === p.runId
      && envelope.normalizedSessionId === p.sessionId && envelope.runnerInstanceId === p.sourceInstanceId && envelope.turnId === identity!.turnId
      && envelope.itemId === identity!.itemId && envelope.environmentLeaseId === executionWorkspaceId
      && event.schema === "paperclip.prp.event.v1" && event.schemaVersion === 1 && event.sourceKind === "runner"
      && event.runId === p.runId && event.normalizedSessionId === p.sessionId && event.sourceInstanceId === p.sourceInstanceId
      && event.turnId === identity!.turnId && event.itemId === identity!.itemId && saved.sourceSeq === event.sourceSeq
      && saved.sourceEventId === event.sourceEventId && saved.eventType === event.eventType && saved.logicalEffectCount === 1
      && Number.isSafeInteger(event.sourceSeq) && event.sourceSeq > 0 && event.sourceSeq <= evidence.highestRecordedSourceSeq);
    return event;
  };
  const completed = (command: Row, status: string) => {
    const result = rec(command.result);
    demand(command.schema === "paperclip.prp.command.v1" && command.status === "completed" && Number.isSafeInteger(command.controllerSeq) && command.controllerSeq > 0
      && result.commandId === command.commandId && result.controllerSeq === command.controllerSeq && result.commandType === command.type
      && result.status === "completed" && result.result?.status === status);
    return rec(result.result);
  };
  demand(turnStarts.length <= 1 && resolutions.length <= 1 && requests.length <= 2);
  if (!turnStarts.length || requests.length < 2 || !resolutions.length) return undefined;
  const turnStart = turnStarts[0]!, accepted = completed(turnStart, "accepted");
  demand(turnStart.payload?.turnId === p.turnId && accepted.providerTurnId === p.turnId);
  const created = requests.find(x => x.eventType === "runtime_request.created"), resolved = requests.find(x => x.eventType === "runtime_request.resolved");
  demand(created && resolved);
  const request = rec(rec(controllerEvent(created!).payload).request), resolution = rec(controllerEvent(resolved!).payload);
  demand(request.schema === "paperclip.runtime_request.v2" && request.requestKind === "permission_approval" && request.type === "permission" && request.status === "pending"
    && request.requestId === p.requestId && request.turnId === identity!.turnId && request.itemId === identity!.itemId
    && request.prompt === "mcp__paperclip__get_task_context" && hasAcpxNativeOrigin(request.origin, "kimi", "session/request_permission")
    && request.details?.toolCallId === p.toolCallId && resolution.requestId === p.requestId && resolution.requestKind === "permission_approval"
    && resolution.action === "accept" && resolution.turnId === identity!.turnId && resolution.itemId === identity!.itemId && created!.sourceSeq < resolved!.sourceSeq);
  const resolutionCommand = resolutions[0]!, resolvedDelivery = completed(resolutionCommand, "delivered");
  demand(resolutionCommand.payload?.turnId === identity!.turnId && resolutionCommand.payload?.resolution?.action === "accept"
    && resolvedDelivery.requestId === p.requestId && turnStart.controllerSeq < resolutionCommand.controllerSeq);
  demand(events.length <= 1 && commands.length <= 1);
  if (!events.length) return undefined;
  const saved = events[0]!, envelope = rec(saved.envelope), event = rec(envelope.payload), tool = rec(rec(event.payload).semantic_tool), correlation = rec(tool.correlation);
  demand(envelope.protocol === "paperclip.runner" && envelope.kind === "event" && envelope.runId === p.runId
    && envelope.normalizedSessionId === p.sessionId && envelope.runnerInstanceId === p.sourceInstanceId && envelope.turnId === identity!.turnId
    && envelope.environmentLeaseId === identity!.environmentLeaseId && envelope.itemId === identity!.itemId
    && event.schema === "paperclip.prp.event.v1" && event.schemaVersion === 1 && event.eventType === "semantic_tool.input" && event.sourceKind === "runner"
    && event.runId === p.runId && event.normalizedSessionId === p.sessionId && event.sourceInstanceId === p.sourceInstanceId && event.turnId === identity!.turnId && event.itemId === identity!.itemId
    && event.sourceSeq > resolved!.sourceSeq && saved.sourceSeq === event.sourceSeq && saved.sourceEventId === event.sourceEventId && saved.logicalEffectCount === 1
    && Number.isSafeInteger(event.sourceSeq) && event.sourceSeq > 0 && event.sourceSeq <= evidence.highestRecordedSourceSeq
    && tool.schema === "paperclip.prp.semantic_tool.v1" && tool.schemaVersion === 1 && tool.phase === "input" && tool.operationId === "get_task_context"
    && typeof tool.callId === "string" && tool.callId.length > 0 && tool.idempotencyKey === null && canonicalJson(tool.input) === "{}" && tool.content?.digest === hash({})
    && canonicalJson(correlation) === canonicalJson({ runId: p.runId, normalizedSessionId: p.sessionId, turnId: identity!.turnId, itemId: identity!.itemId }));
  if (!commands.length) return undefined;
  const command = commands[0]!, body = rec(command.payload), delivered = rec(command.result);
  demand(command.schema === "paperclip.prp.command.v1" && command.commandId === `command_tool_${bytes(`${p.runId}\0${tool.callId}`).slice(0, 32)}`
    && Number.isSafeInteger(command.controllerSeq) && command.controllerSeq > resolutionCommand.controllerSeq && body.callId === tool.callId && body.operationId === "get_task_context"
    && body.sourceEventId === event.sourceEventId && body.sourceEventType === event.eventType && body.inputDigest === bytes("{}")
    && (body.input === undefined || canonicalJson(body.input) === "{}") && canonicalJson(body.correlation) === canonicalJson(correlation) && body.isError === false);
  if (command.status === "pending") return undefined;
  demand(command.status === "completed" && delivered.commandId === command.commandId && delivered.controllerSeq === command.controllerSeq
    && delivered.commandType === command.type && delivered.status === "completed" && delivered.result?.status === "delivered" && delivered.result?.callId === tool.callId);
  const value = rec(body.result);
  demand(value.company?.id === p.companyId && value.actor?.id === p.agentId && value.activeTask?.id === p.issueId
    && typeof value.activeTask.description === "string" && `sha256:${bytes(value.activeTask.description)}` === p.actionSha256);
  return { schema: "paperclip.e2e.kimi-context-authority.v2", companyId: p.companyId, issueId: p.issueId, agentId: p.agentId, environmentId: p.environmentId, runId: p.runId,
    sessionId: p.sessionId, sourceInstanceId: p.sourceInstanceId, turnId: p.turnId, observerLeaseId: p.observerLeaseId, executionWorkspaceId, controllerTurnId: identity!.turnId, controllerItemId: identity!.itemId, requestId: p.requestId, toolCallId: p.toolCallId,
    requestCreatedSourceSeq: created!.sourceSeq, requestResolvedSourceSeq: resolved!.sourceSeq, requestCreatedSha256: hash(created), requestResolvedSha256: hash(resolved), turnStartSha256: hash(turnStart), resolutionCommandSha256: hash(resolutionCommand), actionSha256: p.actionSha256, callId: tool.callId,
    inputSourceSeq: event.sourceSeq, inputSourceEventId: event.sourceEventId, inputSha256: hash({}), inputEventSha256: hash(saved), resultSha256: hash(value), correlationSha256: hash(correlation),
    commandId: command.commandId, controllerSeq: command.controllerSeq, commandSha256: hash(command), deliverySha256: hash(delivered),
    checkpointIdentitySha256: hash(identity), authenticatedConnectionCount: evidence.authenticatedConnectionCount, highestRecordedSourceSeq: evidence.highestRecordedSourceSeq };
}
export async function assertKimiContextObserverConfig(env: NodeJS.ProcessEnv) {
  const temporary = env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT, config = env.PAPERCLIP_CONFIG, home = env.PAPERCLIP_HOME, instance = env.PAPERCLIP_INSTANCE_ID;
  demand(temporary && config && home && instance && path.isAbsolute(temporary) && path.isAbsolute(config) && path.isAbsolute(home) && /^[A-Za-z0-9_-]+$/.test(instance));
  const [root, actualConfig, actualHome] = await Promise.all([realpath(temporary!), realpath(config!), realpath(home!)]);
  demand(actualHome === path.join(root, "paperclip-home") && actualConfig === path.join(actualHome, "instances", instance!, "config.json"));
  const { assertEmbeddedDatabaseIsolation } = await import("./instance-isolation.js");
  await assertEmbeddedDatabaseIsolation(actualConfig, root);
  return actualConfig;
}
export async function createKimiContextCheckpointObserver(p: KimiContextPublication) {
  const configPath = await assertKimiContextObserverConfig(process.env);
  const [{ createDb }, { paperclipConfigSchema }, { loadNativeRunnerCheckpoint }, { createRequire }] = await Promise.all([
    import("../../packages/db/src/index.js"), import("../../packages/shared/src/config-schema.js"), import("../../server/src/services/native-runtime/native-runner-checkpoint.js"), import("node:module"),
  ]);
  const { sql } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("drizzle-orm");
  const config = paperclipConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const url = config.database.mode === "postgres" ? config.database.connectionString : `postgres://paperclip:paperclip@127.0.0.1:${config.database.embeddedPostgresPort}/paperclip`;
  demand(url); const db = createDb(url!, { maxConnections: 1, connectTimeoutSeconds: 5 }); let closed = false;
  return {
    read: async () => {
      demand(!closed);
      return db.transaction(async tx => {
        await tx.execute(sql`set local statement_timeout = '5000ms'`);
        const [owned] = await tx.execute(sql`select l.execution_workspace_id as "executionWorkspaceId", r.runner_profile_json as profile from heartbeat_runs r join issues i on i.id = r.native_issue_id and i.company_id = r.company_id
          join environment_leases l on l.heartbeat_run_id = r.id and l.company_id = r.company_id and l.issue_id = i.id
          join execution_workspaces w on w.id = l.execution_workspace_id and w.id = i.execution_workspace_id and w.company_id = r.company_id and w.source_issue_id = i.id and w.status = 'active'
          where l.id = ${p.observerLeaseId} and l.environment_id = ${p.environmentId} and l.status = 'active' and r.id = ${p.runId} and r.company_id = ${p.companyId} and r.agent_id = ${p.agentId} and r.native_issue_id = ${p.issueId}
          and r.native_session_id = ${p.sessionId} and r.runner_instance_id = ${p.sourceInstanceId} and r.runtime_mode = 'native' and r.status = 'running'
          and i.execution_run_id = r.id and i.assignee_agent_id = r.agent_id and i.status = 'in_progress'`);
        demand(owned);
        const execution = parseNativeExecutionInput(rec(owned.profile).nativeExecutionInput), binding = execution.binding;
        demand(binding.companyId === p.companyId && binding.issueId === p.issueId && binding.agentId === p.agentId && binding.runId === p.runId
          && binding.executionWorkspaceId === owned.executionWorkspaceId && execution.session.normalizedSessionId === p.sessionId);
        const checkpoint = await loadNativeRunnerCheckpoint(tx as any, { companyId: p.companyId, issueId: p.issueId, runId: p.runId });
        return checkpoint ? projectKimiContextCheckpoint(checkpoint, p, owned.executionWorkspaceId as string) : undefined;
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
    },
    close: async () => { if (closed) return; closed = true; await db.$client.end({ timeout: 5 }); },
  };
}
