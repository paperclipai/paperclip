import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { hostname } from "node:os";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import {
  PAPERCLIP_SEMANTIC_ACTION_CATALOG, proveClosedReadOnlyCodexThread, readStoppedCodexThread,
  validatePrpEvent,
} from "../../vendor/paperclip-runner/index.js";
import { RUNNER_BRIDGE_READ_OPERATIONS } from "./runner-bridge-tools.js";
import { RUNNERD_CONTROL_PLANE_STATE_SCHEMAS } from "./native-bootstrap-proof.js";
import { nativeSha256 } from "./canonical.js";
import { stopReadOnlyWindowsOrphans } from "./native-windows-orphan-stop.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const READS: ReadonlySet<string> = new Set([
  ...PAPERCLIP_SEMANTIC_ACTION_CATALOG.filter(action => action.effect === "read").map(action => action.operationId),
  ...RUNNER_BRIDGE_READ_OPERATIONS,
]);
const PROCESS_EVENTS = ["native.process_start_requested", "native.process_identity_recorded", "native.local_process_stopped"];
const absent = (value: unknown): value is number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 1) return false;
  try { process.kill(Number(value), 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 1 && Number(value) < 2 ** 31;
type Snapshot = { fingerprint: string; control: Record<string, unknown>; runner: Record<string, unknown>; provider: Record<string, unknown> };
type Owner = { id: string; companyId: string; agentId: string; nativeSessionId: string | null; runnerInstanceId: string | null; finishedAt: Date | null };
type ReaderResult = Awaited<ReturnType<typeof readStoppedCodexThread>>;
const historyCache = new Map<string, ReaderResult>();

/** Windows has no negative-PID process-group proof. A closed Codex thread with
 * only declared reads supplies the missing no-native-tool-authority evidence.
 * This deliberately refuses shell, file, MCP, child-agent and unknown items. */
export async function proveStoppedWindowsReadOnlySession(input: {
  db: Db; owner: Owner; root: string; cwd: string; snapshot: Snapshot;
  unchanged: () => boolean;
  cleanup?: boolean;
  readThread?: typeof readStoppedCodexThread;
}): Promise<{ evidence: Record<string, unknown>; unchanged: () => boolean } | null> {
  const { db, owner, snapshot } = input;
  const identity = record(snapshot.control.identity);
  if (!owner.runnerInstanceId || !owner.nativeSessionId || !RUNNERD_CONTROL_PLANE_STATE_SCHEMAS.has(String(snapshot.control.schema)) ||
      snapshot.runner.schema !== "paperclip.runner.durable.state.v1" || snapshot.provider.schema !== "paperclip.runner.codex-provider-state.v1" ||
      snapshot.provider.startupAttempt != null || record(snapshot.provider.goal).status === "active" ||
      record(snapshot.provider.goal).workingNow === true || identity.runId !== owner.id ||
      identity.normalizedSessionId !== owner.nativeSessionId || identity.runnerInstanceId !== owner.runnerInstanceId ||
      !["runnerInstanceId", "environmentLeaseId", "runId", "normalizedSessionId", "turnId", "itemId"].every(key =>
        typeof identity[key] === "string" && identity[key] && snapshot.runner[key] === identity[key]) ||
      !Array.isArray(snapshot.control.committedEvents)) return null;
  const [latest, previous] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload,
    agentId: heartbeatRunEvents.agentId, seq: heartbeatRunEvents.seq }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, owner.companyId), eq(heartbeatRunEvents.runId, owner.id),
    isNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType, PROCESS_EVENTS),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(2);
  const launch = latest?.eventType === "native.local_process_stopped" ? previous : latest;
  const process = record(launch?.payload), stop = record(latest?.payload);
  if (!latest || !launch) return null;
  if (launch?.eventType !== "native.process_identity_recorded" || launch.agentId !== owner.agentId || latest.agentId !== owner.agentId ||
      process.targetKind !== "local" || process.hostname !== hostname() || process.processGroupId != null ||
      typeof process.processStartedAt !== "string" || !Number.isFinite(Date.parse(process.processStartedAt)) ||
      !absent(process.processPid) || latest.eventType === "native.local_process_stopped" &&
        (stop.processPid !== process.processPid || stop.processGroupId != null || stop.processStartedAt !== process.processStartedAt)) return null;
  const pids = new Set<number>([process.processPid]);
  const events = snapshot.control.committedEvents.map(entry => record(record(record(entry).envelope).payload));
  const receipts = await db.select({ payload: heartbeatRunEvents.payload, sourceSeq: heartbeatRunEvents.sourceSeq,
    sourcePayloadSha256: heartbeatRunEvents.sourcePayloadSha256, sourceEventId: heartbeatRunEvents.sourceEventId }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, owner.companyId), eq(heartbeatRunEvents.runId, owner.id),
    eq(heartbeatRunEvents.sourceInstanceId, owner.runnerInstanceId),
    inArray(heartbeatRunEvents.eventType, ["session.started", "session.resumed", "session.reconciled"]),
  ));
  const sessionEvents = events.filter(event => ["session.started", "session.resumed", "session.reconciled"].includes(String(event.eventType)));
  receipts.sort((left, right) => Number(left.sourceSeq) - Number(right.sourceSeq));
  if (sessionEvents.length !== receipts.length) return null;
  let opened = false;
  for (const event of sessionEvents) {
    const payload = record(event.payload);
    const receipt = receipts[sessionEvents.indexOf(event)];
    const durable = record(record(receipt?.payload).prpEvent), durableProvider = record(durable.payload);
    if (!validatePrpEvent(event).ok || event.sourceKind !== "runner" || event.runId !== owner.id ||
        event.normalizedSessionId !== owner.nativeSessionId || event.sourceInstanceId !== owner.runnerInstanceId ||
        event.turnId !== identity.turnId || event.itemId !== identity.itemId ||
        !pid(payload.processId) || !receipt || !validatePrpEvent(durable).ok ||
        durable.runId !== owner.id || durable.normalizedSessionId !== owner.nativeSessionId ||
        durable.sourceInstanceId !== owner.runnerInstanceId || durable.eventType !== event.eventType ||
        durable.sourceSeq !== receipt.sourceSeq || receipt.sourcePayloadSha256 !== nativeSha256(durable) ||
        receipt.sourceEventId !== `${owner.runnerInstanceId}:${owner.id}:${durable.sourceSeq}` ||
        durable.sourceEventId !== receipt.sourceEventId ||
        (durableProvider.processId !== undefined && durableProvider.processId !== payload.processId) ||
        (durableProvider.driverSessionId ?? durableProvider.providerSessionId) !== payload.providerSessionId ||
        payload.providerSessionId !== snapshot.provider.threadId) return null;
    pids.add(payload.processId); opened = true;
  }
  if (!opened) return null;
  const pending = [...events, ...[snapshot.provider.pendingEvents, snapshot.provider.queuedEvents, snapshot.runner.outbox]
    .flatMap(values => Array.isArray(values) ? values : []).map(value => {
      const event = record(value); return record(record(event.envelope).payload).eventType
        ? record(record(event.envelope).payload) : event;
    })];
  for (const event of pending) {
    const payload = record(event.payload);
    if (!events.includes(event) && ["session.started", "session.resumed", "session.reconciled"].includes(String(event.eventType))) return null;
    if (event.eventType === "tool.execution.started" &&
        (payload.transport !== "dynamic" || typeof payload.name !== "string" || !READS.has(payload.name))) return null;
    if (event.eventType === "semantic_tool.input") {
      const operation = record(payload.semantic_tool).operationId;
      if (typeof operation !== "string" || !READS.has(operation)) return null;
    }
  }
  const collect = (value: unknown, depth = 0): boolean => {
    if (depth > 3) return true;
    const object = record(value);
    for (const [key, value] of Object.entries(object)) {
      if (["pid", "processId", "process_id", "processGroupId", "providerPid", "codexPid", "sidecarPid", "agentPid", "previousProcessId"].includes(key) && value != null) {
        if (!pid(value)) return false; pids.add(Number(value));
      } else if (value && typeof value === "object" && !collect(value, depth + 1)) return false;
    }
    return true;
  };
  for (const event of pending) if (event.eventType === "harness.diagnostic" && !collect(event.payload)) return null;
  for (const descriptor of [snapshot.provider, record(snapshot.provider.identity), record(snapshot.provider.descriptor)])
    for (const key of ["processId", "process_id", "providerPid", "codexPid", "agentPid", "agentProcessId", "sidecarPid"])
      if (descriptor[key] != null) { if (!pid(descriptor[key])) return null; pids.add(Number(descriptor[key])); }
  if (!input.cleanup && [...pids].some(value => !absent(value))) return null;
  const threadId = snapshot.provider.threadId, turnId = snapshot.provider.activeProviderTurnId;
  if (typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) return null;
  const key = `${input.root}\0${snapshot.fingerprint}\0${launch.seq}`;
  let history = historyCache.get(key);
  if (!history?.sourceIsCurrent()) {
    try { history = await (input.readThread ?? readStoppedCodexThread)({ sourceHome: path.join(input.root, "codex-home"), threadId }); }
    catch { return null; }
    if (historyCache.size >= 128) historyCache.delete(historyCache.keys().next().value!);
    historyCache.set(key, history);
  }
  // A preserved instance-home junction may give the same workspace two paths.
  // Require filesystem identity instead of trusting a saved path rewrite.
  const thread = record(history.thread);
  if (typeof thread.cwd !== "string") return null;
  let cwd: string, threadCwd: string;
  try { [cwd, threadCwd] = await Promise.all([realpath(input.cwd), realpath(thread.cwd)]); }
  catch { return null; }
  const proof = proveClosedReadOnlyCodexThread({ ...thread, cwd: threadCwd }, { threadId, turnId, cwd }, READS);
  if (!proof || !input.unchanged() || !history.sourceIsCurrent()) return null;
  const live = [...pids].filter(value => !absent(value));
  if (live.length) {
    const command = record(snapshot.provider.config).command;
    if (!input.cleanup || !owner.finishedAt || typeof command !== "string" || typeof history.runtimeCommand !== "string" ||
        path.win32.resolve(command).toLowerCase() !== path.win32.resolve(history.runtimeCommand).toLowerCase()) return null;
    const stopped = await stopReadOnlyWindowsOrphans({ pids: live, parentPid: process.processPid,
      executable: history.runtimeCommand, codexHome: path.join(input.root, "codex-home"),
      notBefore: process.processStartedAt, notAfter: owner.finishedAt.toISOString() });
    if (!stopped || [...pids].some(value => !absent(value))) return null;
    if (stopped.length) await appendHeartbeatRunEvent(db, { companyId: owner.companyId, runId: owner.id, agentId: owner.agentId,
      eventType: "native.windows_read_only_provider_stopped", stream: "system", level: "info",
      message: "Stopped the exact orphan provider after verifying its closed read-only conversation.",
      payload: { processPid: process.processPid, stopped, threadId, providerTurnId: turnId } });
  }
  // Match fs.promises.realpath, which expands 8.3 short names; the JS
  // realpathSync keeps them, so a short TEMP path never compared equal.
  const unchanged = () => {
    try { return input.unchanged() && history!.sourceIsCurrent() && [...pids].every(absent) &&
      realpathSync.native(input.cwd) === cwd && realpathSync.native(thread.cwd as string) === threadCwd; }
    catch { return false; }
  };
  if (!unchanged()) return null;
  const [current] = await db.select({ seq: heartbeatRunEvents.seq }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, owner.companyId), eq(heartbeatRunEvents.runId, owner.id),
    isNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType, PROCESS_EVENTS),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  if (current?.seq !== latest.seq) return null;
  return { evidence: { schema: "paperclip.stopped_windows_read_only_conversation.v1", runId: owner.id,
    runnerInstanceId: owner.runnerInstanceId, nativeSessionId: owner.nativeSessionId, processPid: process.processPid,
    processStartedAt: process.processStartedAt, providerPids: [...pids].filter(pid => pid !== process.processPid),
    threadId, providerTurnId: turnId, readOperations: proof.readOperations,
    readToolCalls: proof.readCalls.map(call => ({ executionId: call.id, name: call.tool })), stateFingerprint: snapshot.fingerprint }, unchanged };
}
