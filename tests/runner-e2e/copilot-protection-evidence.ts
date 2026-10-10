import { withoutProvenBootstrapReads, bootstrapReadExecutionId, type BootstrapReadProof } from "./native-bootstrap-read-proof.js";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readCopilotToolEvidence, type CopilotToolNotice } from "./copilot-evidence.js";

/** A tool origin exists regardless of the first status emitted by the provider. */
export function countCopilotToolOrigins(notices: readonly CopilotToolNotice[]): number {
  return new Set(notices.filter(n => n.stage === "tool").map(n => JSON.stringify([n.runId, n.sessionId, n.turnId, n.toolCallId]))).size;
}

export interface CopilotCommandMatch {
  algorithm: "leading-ascii-horizontal-v1";
  canonicalCommandSha256: string;
  nativeCommandSha256: string;
  leadingWhitespace: string;
}
const commandDigest = (command: string) => `sha256:${createHash("sha256").update(command).digest("hex")}`;

/** Only the fixture-owned command plus at most eight leading SPACE/TAB bytes.
 * Never trim native evidence or canonicalize shell tokens, quotes or content. */
export function matchCopilotFixtureCommand(command: string, nativeCommandSha256: string): CopilotCommandMatch | null {
  if (!command || /^[ \t\r\n]/u.test(command) || !/^sha256:[a-f0-9]{64}$/u.test(nativeCommandSha256)) return null;
  let prefixes = [""];
  for (let length = 0; length <= 8; length++) {
    for (const leadingWhitespace of prefixes) {
      if (commandDigest(leadingWhitespace + command) === nativeCommandSha256) return {
        algorithm: "leading-ascii-horizontal-v1", canonicalCommandSha256: commandDigest(command), nativeCommandSha256, leadingWhitespace,
      };
    }
    prefixes = prefixes.flatMap(prefix => [prefix + " ", prefix + "\t"]);
  }
  return null;
}

/** Bind the relation to one complete native execution, including retry checks. */
export function findCopilotFixtureCommand(notices: readonly CopilotToolNotice[], command: string): { call: CopilotToolNotice; match: CopilotCommandMatch } | null {
  const tools = notices.filter(n => n.stage === "tool");
  const key = (n: CopilotToolNotice) => JSON.stringify([n.runId, n.sessionId, n.turnId, n.toolCallId]);
  const executions = tools.filter(n => n.operation === "execute" || n.commandSha256 !== undefined);
  if (new Set(executions.map(key)).size !== 1) return null;
  const first = executions[0]!;
  if (![first.runId, first.sessionId, first.turnId, first.toolCallId].every(Boolean)) return null;
  const group = tools.filter(n => key(n) === key(first));
  const pending = group.filter(n => n.status === "pending"), terminal = group.filter(n => n.status === "completed" || n.status === "failed");
  if (pending.length !== 1 || terminal.length !== 1 || terminal[0]!.status !== "completed"
    || group.some(n => n.seq < pending[0]!.seq || n.seq > terminal[0]!.seq)
    || pending[0]!.seq >= terminal[0]!.seq) return null;
  const call = pending[0]!, match = matchCopilotFixtureCommand(command, call.commandSha256 ?? "");
  if (!match || call.operation !== "execute" || call.mode !== "async" || call.detach !== false
    || group.some(n => (n.commandSha256 !== undefined && n.commandSha256 !== call.commandSha256)
      || (n.operation !== undefined && n.operation !== "execute") || (n.mode !== undefined && n.mode !== "async")
      || (n.detach !== undefined && n.detach !== false))) return null;
  return { call, match };
}

/** Capture independent evidence before a failed command match can abort grading. */
export async function observeCopilotFixtureCommand<T>(notices: readonly CopilotToolNotice[], command: string, local?: {
  fixture: { snapshot(): T; marker: string; close(): Promise<void> }; markerPath: string;
}) {
  const external = local?.fixture.snapshot();
  const markerMatches = local ? await readCopilotMarkerAfterCleanup(async () => {}, local.markerPath, local.fixture.marker) : undefined;
  const afterCleanupMarkerMatches = local ? await readCopilotMarkerAfterCleanup(() => local.fixture.close(), local.markerPath, local.fixture.marker) : undefined;
  return { external, markerMatches, afterCleanupMarkerMatches, matched: findCopilotFixtureCommand(notices, command) };
}

/** Permission requests may carry the target omitted by native tool updates. */
export function countCopilotEditOriginsForTarget(notices: readonly CopilotToolNotice[], target: string): number {
  const origins = new Map<string, CopilotToolNotice[]>();
  for (const notice of notices) {
    const key = JSON.stringify([notice.runId, notice.sessionId, notice.turnId, notice.toolCallId]);
    const group = origins.get(key) ?? [];
    group.push(notice); origins.set(key, group);
  }
  let count = 0;
  for (const group of origins.values()) {
    if (!group.some(n => n.target === target)) continue;
    if (group.some(n => (n.target !== undefined && n.target !== target) || (n.operation !== undefined && n.operation !== "edit"))) {
      throw new Error("Conflicting Copilot denied-target origin evidence");
    }
    const permissions = group.filter(n => n.stage !== "tool");
    const requestIds = new Set(permissions.map(n => n.requestId));
    if (requestIds.has(undefined) || requestIds.size > 1
      || permissions.filter(n => n.stage === "permission_requested").length > 1
      || permissions.filter(n => n.stage === "permission_delivered").length > 1) {
      throw new Error("Repeated or unbound Copilot denied-target permission");
    }
    const tools = group.filter(n => n.stage === "tool");
    const terminal = tools.filter(n => n.status === "completed" || n.status === "failed");
    if (terminal.length > 1 || tools.filter(n => n.status === "pending").length > 1
      || (terminal[0] && tools.some(n => n.seq > terminal[0]!.seq))) {
      throw new Error("Repeated Copilot denied-target tool lifecycle");
    }
    // A permission notice alone never proves that a native tool was attempted.
    if (tools.some(n => n.operation === "edit")) count++;
  }
  return count;
}

/** Re-read independently after cleanup; a pre-cleanup value is not evidence. */
export async function readCopilotMarkerAfterCleanup(close: () => Promise<void>, path: string, expected: string): Promise<boolean> {
  await close();
  try { return await readFile(path, "utf8") === expected; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export interface CopilotRemoteBinding {
  companyId: string; environmentId: string; runId: string; leaseId: string; sandboxId: string; image: string; remoteCwd: string;
}
export interface CopilotRemoteSnapshot {
  binding: CopilotRemoteBinding; observedAtMs: number; receivedAtMs: number; observedMonotonicNs: string; complete: boolean;
  workspace: Record<string, string>;
  targets: Record<string, { absent: boolean; sha256: string | null; parent: { dev: string; ino: string }; mutationCount: number; complete: boolean }>;
  watcher: { complete: boolean; targetMutationCount: number; workspaceMutationCount: number };
  processes: { captured: boolean; root: { pid: number; startTicks: string; bootId: string } | null; journal: Array<{ pid: number; ppid: number; startTicks: string; bootId: string }>; live: number[] };
  setup: { path: string; sha256: string | null; published: boolean };
  attached: { connections: number; failure: string | null; commandExit: { code: number; observedAtMs: number; observedMonotonicNs: string } | null;
    markerWrittenAtMs: number | null; markerWrittenMonotonicNs: string | null; clientExitedAtMs: number | null; clientExitedMonotonicNs: string | null } | null;
}
export interface CopilotRemoteFixture {
  binding: CopilotRemoteBinding; remoteCwd: string; actionFile: string;
  snapshot(label: string): Promise<CopilotRemoteSnapshot>;
  setupAttachedCommand(input: { marker: string; markerText: string; delayMs: number }): Promise<{ command: string; commandSha256: string }>;
  finish(): Promise<CopilotRemoteSnapshot>; readFile(relative: string): Promise<Buffer>; close(): Promise<void>;
}
export interface CopilotRemoteBootstrap {
  prompt(nonce: string): string;
  bindAndRelease(input: { issueId: string; runId: string; targets: readonly string[];
    actionPrompt(fixture: CopilotRemoteFixture): Promise<string> | string }): Promise<CopilotRemoteFixture>;
}
export function assertCopilotRemoteSnapshot(s: CopilotRemoteSnapshot, binding: CopilotRemoteBinding): void {
  const keys: Array<keyof CopilotRemoteBinding> = ["companyId", "environmentId", "runId", "leaseId", "sandboxId", "image", "remoteCwd"];
  if (!s.complete || !s.watcher.complete || !keys.every(k => typeof binding[k] === "string" && binding[k].length > 0 && s.binding[k] === binding[k])
    || !/^.+@sha256:[a-f0-9]{64}$/u.test(binding.image) || !binding.remoteCwd.startsWith("/") || binding.remoteCwd.split("/").some(p => p === ".." || p === ".")
    || !Number.isSafeInteger(s.observedAtMs) || s.observedAtMs < 0 || !Number.isSafeInteger(s.receivedAtMs) || !/^\d+$/u.test(s.observedMonotonicNs)
    || ![s.watcher.targetMutationCount, s.watcher.workspaceMutationCount].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Incomplete Copilot remote lease/watch receipt");
}
export function assertCopilotRemoteRetirement(s: CopilotRemoteSnapshot, baseline: CopilotRemoteSnapshot): void {
  assertCopilotRemoteSnapshot(s, baseline.binding);
  const root = s.processes.root, original = baseline.processes.root;
  if (!root || !original || !baseline.processes.captured || !s.processes.captured || s.processes.live.length !== 0
    || root.pid !== original.pid || root.startTicks !== original.startTicks || root.bootId !== original.bootId
    || !Number.isSafeInteger(root.pid) || root.pid < 2 || !/^\d+$/u.test(root.startTicks) || !/^[a-f0-9-]{36}$/iu.test(root.bootId)
    || !s.processes.journal.some(p => p.pid === root.pid && p.startTicks === root.startTicks && p.bootId === root.bootId)
    || !s.processes.journal.every(p => p.bootId === root.bootId && /^\d+$/u.test(p.startTicks) && Number.isSafeInteger(p.pid) && p.pid > 1)
    || !s.setup.published || s.setup.path !== baseline.setup.path || !/^sha256:[a-f0-9]{64}$/u.test(s.setup.sha256 ?? "")
    || BigInt(s.observedMonotonicNs) < BigInt(baseline.observedMonotonicNs)) throw new Error("Copilot remote retirement is unproven");
}
export function copilotRemoteDeniedSample(s: CopilotRemoteSnapshot, baseline: CopilotRemoteSnapshot, target: string, phase: "before-request" | "pending" | "after-decision" | "terminal" | "after-cleanup") {
  assertCopilotRemoteSnapshot(s, baseline.binding);
  const t = s.targets[target], before = baseline.targets[target];
  if (!t?.complete || !before?.complete || !/^\d+$/u.test(t.parent.dev) || !/^\d+$/u.test(t.parent.ino)
    || t.parent.dev !== before.parent.dev || t.parent.ino !== before.parent.ino || t.mutationCount !== 0
    || s.watcher.targetMutationCount !== 0 || s.watcher.workspaceMutationCount !== baseline.watcher.workspaceMutationCount
    || JSON.stringify(Object.entries(s.workspace).sort()) !== JSON.stringify(Object.entries(baseline.workspace).sort())) throw new Error("Copilot remote denied target changed or observation was incomplete");
  return { phase, observedAtMs: s.observedAtMs, exists: t.absent !== true || t.sha256 !== null };
}
/** Only typed reads before the tested operation can be bootstrap work. */
export function copilotActionNotices(notices: readonly CopilotToolNotice[], origin: CopilotToolNotice, proof?: BootstrapReadProof): CopilotToolNotice[] {
  return withoutProvenBootstrapReads(notices, origin, proof);
}
export function assertCopilotRemoteAttached(s: CopilotRemoteSnapshot, baseline: CopilotRemoteSnapshot, terminalAt: number) {
  assertCopilotRemoteRetirement(s, baseline);
  const a = s.attached;
  if (!a || a.failure !== null || a.connections !== 1 || a.commandExit?.code !== 0 || a.markerWrittenAtMs === null || a.clientExitedAtMs === null
    || !/^\d+$/u.test(a.commandExit.observedMonotonicNs) || !/^\d+$/u.test(a.markerWrittenMonotonicNs ?? "") || !/^\d+$/u.test(a.clientExitedMonotonicNs ?? "")
    || BigInt(a.commandExit.observedMonotonicNs) > BigInt(a.markerWrittenMonotonicNs!) || BigInt(a.markerWrittenMonotonicNs!) > BigInt(a.clientExitedMonotonicNs!)
    || BigInt(a.clientExitedMonotonicNs!) > BigInt(s.observedMonotonicNs)
    || ![terminalAt, a.commandExit.observedAtMs, a.markerWrittenAtMs, a.clientExitedAtMs].every(n => Number.isSafeInteger(n) && n >= 0)
    || BigInt(a.commandExit.observedMonotonicNs) < BigInt(baseline.observedMonotonicNs)
    || a.commandExit.observedAtMs >= terminalAt || a.markerWrittenAtMs >= terminalAt || a.clientExitedAtMs >= terminalAt) throw new Error("Copilot remote attached command did not settle before terminal");
  return a;
}

/** Await baseline and exact command construction before the bootstrap can publish. */
export async function prepareCopilotRemoteAction(input: {
  fixture: CopilotRemoteFixture; companyId: string; environmentId: string; runId: string;
  target: string; prompt: string; markerText?: string;
}) {
  const f = input.fixture;
  if (f.binding.companyId !== input.companyId || f.binding.environmentId !== input.environmentId || f.binding.runId !== input.runId || f.remoteCwd !== f.binding.remoteCwd) throw new Error("Foreign Copilot remote bootstrap binding");
  const command = input.markerText === undefined ? undefined : await f.setupAttachedCommand({ marker: input.target, markerText: input.markerText, delayMs: 4000 });
  const baseline = await f.snapshot("before-action-publication"); assertCopilotRemoteSnapshot(baseline, f.binding);
  if (baseline.setup.published || baseline.setup.path !== f.actionFile || !baseline.processes.captured || baseline.processes.live.length === 0) throw new Error("Copilot action was not held behind the remote observer");
  const target = baseline.targets[input.target];
  if (!target?.complete || !target.absent || target.sha256 !== null || target.mutationCount !== 0) throw new Error("Copilot remote target was present or unobserved before action");
  return { baseline, command, prompt: `${input.prompt}\nThe admitted remote workspace is ${f.remoteCwd}.${command ? `\nThe exact supplied command is:\n${command.command}\nDo not inspect or modify fixture code, fabricate its marker, or launch a substitute command.` : ""}` };
}

/** finish drains the pre-armed receipt channel; readFile then reads retained
 * bytes locally. Never snapshot or issue a sandbox RPC after lease retirement. */
export async function readCopilotRemoteMarkerAfterRetirement(fixture: CopilotRemoteFixture, baseline: CopilotRemoteSnapshot, target: string, expected: string): Promise<boolean> {
  const receipt = await fixture.finish(); assertCopilotRemoteRetirement(receipt, baseline);
  const bytes = await fixture.readFile(target);
  return bytes.toString("utf8") === expected && receipt.targets[target]?.sha256 === `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface CopilotDenialSettlement {
  schema: "paperclip.e2e.copilot-denial-settlement.v3";
  branch: "provider_cancelled_or_interrupted" | "provider_completed_observed_before_stop";
  /** A cancelled terminal alone does not prove Stop reached active work. */
  providerCancellationTerminalObserved: boolean;
  runId: string; sessionId: string; turnId: string; toolCallId: string; requestId: string;
  preStop: CopilotPreStopObservation;
  stopDispatchMonotonicNs: string;
  providerTerminal: {
    eventType: "turn.completed" | "turn.cancelled" | "turn.interrupted";
    normalizedSessionId: string; sourceInstanceId: string;
    requestSourceSeq: number; resolvedSourceSeq: number; deliveredSourceSeq: number; failedNoticeSourceSeq: number;
    failedToolSourceSeq: number; failedToolRowCreatedAtMs: number; sourceSeq: number;
    emittedAtMs: number; rowCreatedAtMs: number; rowSha256: string; failedToolRowSha256: string;
  };
  runStop: {
    companyId: string; issueId: string; scope: "run"; status: "cancelled"; issueStatus: "in_progress";
    intentId: string; intentAuditId: string; acknowledgementAuditId: string;
    requestedAtMs: number; recordedAtMs: number; acknowledgedAtMs: number; finishedAtMs: number;
  };
}
const settlementRecord = (v: unknown): Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const settlementId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v) && !v.includes("[REDACTED]");
const settlementTime = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const settlementDate = (v: unknown): number => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/u.test(v) ? Date.parse(v) : NaN;

export function validCopilotDenialSettlement(s: CopilotDenialSettlement): boolean {
  if (!s || s.schema !== "paperclip.e2e.copilot-denial-settlement.v3") return false;
  const t = s.providerTerminal, c = s.runStop;
  if (!t || !c || ![s.runId, s.sessionId, s.turnId, s.toolCallId, s.requestId, t.normalizedSessionId, t.sourceInstanceId,
    c.companyId, c.issueId, c.intentId, c.intentAuditId, c.acknowledgementAuditId].every(settlementId)
    || c.scope !== "run" || c.status !== "cancelled" || c.issueStatus !== "in_progress" || c.intentAuditId === c.acknowledgementAuditId
    || ![t.failedToolRowCreatedAtMs, t.emittedAtMs, t.rowCreatedAtMs, c.requestedAtMs, c.recordedAtMs, c.acknowledgedAtMs, c.finishedAtMs].every(settlementTime)
    || ![t.requestSourceSeq, t.resolvedSourceSeq, t.deliveredSourceSeq, t.failedNoticeSourceSeq].every(n => Number.isSafeInteger(n) && n > 0)
    || !(t.requestSourceSeq < t.resolvedSourceSeq && t.resolvedSourceSeq < t.deliveredSourceSeq && t.deliveredSourceSeq < t.failedNoticeSourceSeq && t.failedNoticeSourceSeq < t.failedToolSourceSeq)
    || !Number.isSafeInteger(t.failedToolSourceSeq) || t.failedToolSourceSeq <= 0 || !Number.isSafeInteger(t.sourceSeq) || t.sourceSeq <= t.failedToolSourceSeq
    || c.requestedAtMs > c.recordedAtMs || c.recordedAtMs > c.acknowledgedAtMs || c.acknowledgedAtMs > c.finishedAtMs) return false;
  const before = s.preStop;
  if (!before || before.schema !== "paperclip.e2e.copilot-pre-stop-observation.v2"
    || !["runId", "sessionId", "turnId", "toolCallId", "requestId"].every(k => before[k as keyof CopilotPreStopObservation] === s[k as keyof CopilotDenialSettlement])
    || typeof before.cancellationRequestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(before.cancellationRequestId)
    || c.intentId !== `native-cancellation:${before.cancellationRequestId}`
    || before.companyId !== c.companyId || before.normalizedSessionId !== t.normalizedSessionId || before.sourceInstanceId !== t.sourceInstanceId
    || before.failedToolSourceSeq !== t.failedToolSourceSeq || before.failedToolRowSha256 !== t.failedToolRowSha256
    || ![t.rowSha256, t.failedToolRowSha256].every(v => /^sha256:[a-f0-9]{64}$/u.test(v))
    || typeof before.apiReadCompletedMonotonicNs !== "string" || typeof s.stopDispatchMonotonicNs !== "string"
    || !/^[1-9][0-9]{0,29}$/u.test(before.apiReadCompletedMonotonicNs) || !/^[1-9][0-9]{0,29}$/u.test(s.stopDispatchMonotonicNs)
    || BigInt(before.apiReadCompletedMonotonicNs) >= BigInt(s.stopDispatchMonotonicNs)) return false;
  if (before.terminal !== null && (!before.terminal || before.terminal.eventType !== t.eventType || before.terminal.sourceSeq !== t.sourceSeq || before.terminal.rowSha256 !== t.rowSha256)) return false;
  if (s.branch === "provider_completed_observed_before_stop") return t.eventType === "turn.completed"
    && s.providerCancellationTerminalObserved === false && before.terminal?.eventType === "turn.completed";
  return s.branch === "provider_cancelled_or_interrupted" && s.providerCancellationTerminalObserved === true
    && ["turn.cancelled", "turn.interrupted"].includes(t.eventType);
}

/** Same failed-edit proof used before Stop and during final settlement. A native
 * failed notice alone does not prove its canonical execution row is durable. */
export function readCopilotDeniedEdit(input: { events: readonly unknown[]; request: CopilotToolNotice; companyId: string }) {
  const { events, request, companyId } = input;
  const invalid = () => new Error("Copilot denial settlement lacks a persisted correlated failed edit");
  if (events.length > 20_000 || !settlementId(companyId)) throw invalid();
  const notices = readCopilotToolEvidence(events, request.runId);
  const same = (n: CopilotToolNotice) => ["runId", "sessionId", "turnId", "toolCallId"].every(k => n[k as keyof CopilotToolNotice] === request[k as keyof CopilotToolNotice]);
  const requested = notices.filter(n => n.stage === "permission_requested" && same(n));
  const delivered = notices.filter(n => n.stage === "permission_delivered" && same(n));
  const failed = notices.filter(n => n.stage === "tool" && same(n) && ["failed", "completed"].includes(n.status ?? ""));
  if (requested.length !== 1 || requested[0]!.seq !== request.seq || requested[0]!.requestId !== request.requestId || request.operation !== "edit"
    || delivered.length !== 1 || delivered[0]!.requestId !== request.requestId || delivered[0]!.outcome !== "reject_once"
    || failed.length !== 1 || failed[0]!.status !== "failed" || requested[0]!.seq >= delivered[0]!.seq || delivered[0]!.seq >= failed[0]!.seq) throw invalid();
  const rows = events.map(settlementRecord);
  const get = (row: Record<string, any>) => {
    const f = settlementRecord(settlementRecord(row.payload).prpEvent);
    if (row.runId !== request.runId || row.companyId !== companyId || !Number.isSafeInteger(row.seq) || row.seq <= 0
      || f.schema !== "paperclip.prp.event.v1" || f.sourceKind !== "runner" || f.eventType !== row.eventType || f.runId !== request.runId || f.turnId !== request.turnId
      || !settlementId(f.normalizedSessionId) || !settlementId(f.sourceInstanceId) || !Number.isSafeInteger(f.sourceSeq) || f.sourceSeq <= 0
      || f.sourceEventId !== `${f.sourceInstanceId}:${request.runId}:${f.sourceSeq}` || !settlementTime(settlementDate(row.createdAt)) || !settlementTime(settlementDate(f.emittedAt))) throw invalid();
    return f;
  };
  const at = (seq: number) => { const found = rows.filter(r => r.seq === seq); if (found.length !== 1) throw invalid(); return get(found[0]!); };
  const origin = at(request.seq), delivery = at(delivered[0]!.seq), failure = at(failed[0]!.seq);
  const stream = (f: Record<string, any>) => f.normalizedSessionId === origin.normalizedSessionId && f.sourceInstanceId === origin.sourceInstanceId;
  if (![delivery, failure].every(stream) || origin.sourceSeq >= delivery.sourceSeq || delivery.sourceSeq >= failure.sourceSeq) throw invalid();
  const resolutions = rows.filter(r => ["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(r.eventType)
    && settlementRecord(settlementRecord(settlementRecord(r.payload).prpEvent).payload).requestId === request.requestId);
  if (resolutions.length !== 1) throw invalid();
  const resolution = get(resolutions[0]!), resolved = settlementRecord(resolution.payload);
  if (!stream(resolution) || resolution.eventType !== "runtime_request.resolved" || resolved.requestKind !== "permission_approval"
    || resolved.turnId !== request.turnId || resolved.action !== "decline" || resolution.sourceSeq <= origin.sourceSeq
    || resolution.sourceSeq >= delivery.sourceSeq || resolutions[0]!.seq <= request.seq || resolutions[0]!.seq >= delivered[0]!.seq) throw invalid();
  const toolRows = rows.filter(r => r.eventType === "tool.execution.completed"
    && settlementRecord(settlementRecord(settlementRecord(r.payload).prpEvent).payload).executionId === bootstrapReadExecutionId(request.toolCallId));
  if (toolRows.length !== 1) throw invalid();
  const tool = get(toolRows[0]!), toolPayload = settlementRecord(tool.payload);
  if (!stream(tool) || tool.sourceSeq <= failure.sourceSeq || toolRows[0]!.seq <= failed[0]!.seq
    || toolPayload.schema !== "paperclip.tool.execution.v1" || toolPayload.status !== "failed" || toolPayload.operation !== "edit") throw invalid();
  return { rows, get, stream, origin, delivery, failure, resolution, tool, toolRows, failed };
}

export interface CopilotPreStopObservation {
  schema: "paperclip.e2e.copilot-pre-stop-observation.v2";
  companyId: string; runId: string; sessionId: string; turnId: string; toolCallId: string; requestId: string;
  normalizedSessionId: string; sourceInstanceId: string;
  failedToolSourceSeq: number; failedToolRowSha256: string;
  terminal: { eventType: "turn.completed" | "turn.cancelled" | "turn.interrupted"; sourceSeq: number; rowSha256: string } | null;
  /** Fixture-process monotonic clock, never provider or database wall time. */
  apiReadCompletedMonotonicNs: string;
  /** Fresh caller UUID reserved atomically by the board cancel API. */
  cancellationRequestId: string;
}
const denialRowSha = (row: unknown) => `sha256:${createHash("sha256").update(canonicalJson(row)).digest("hex")}`;
function readDeniedTerminal(proof: ReturnType<typeof readCopilotDeniedEdit>) {
  const { rows, get, stream, tool, failed } = proof;
  const invalid = () => new Error("Copilot denial lacks exact provider settlement");
  // Ignore legacy unwrapped log summaries, never use them as provider evidence.
  const terminalRows = rows.filter(r => ["turn.completed", "turn.cancelled", "turn.interrupted", "turn.failed"].includes(r.eventType)
    && settlementRecord(r.payload).prpEvent !== undefined);
  if (terminalRows.length === 0) return null;
  if (terminalRows.length !== 1) throw invalid();
  const row = terminalRows[0]!, terminal = get(row), p = settlementRecord(terminal.payload);
  if (!stream(terminal) || terminal.sourceSeq <= tool.sourceSeq || row.seq <= failed[0]!.seq
    || !["turn.completed", "turn.cancelled", "turn.interrupted"].includes(row.eventType)
    || p.status !== row.eventType.slice(5) || p.error != null) throw invalid();
  return { row, terminal };
}
/** Call only on rows returned by the current operator API read. Retain this
 * receipt before dispatching Stop; historical rows cannot recreate that fact. */
export function observeCopilotPreStop(input: { events: readonly unknown[]; request: CopilotToolNotice; companyId: string; cancellationRequestId: string }): CopilotPreStopObservation {
  const proof = readCopilotDeniedEdit(input), observed = readDeniedTerminal(proof), r = input.request;
  return { schema: "paperclip.e2e.copilot-pre-stop-observation.v2", companyId: input.companyId,
    runId: r.runId, sessionId: r.sessionId, turnId: r.turnId, toolCallId: r.toolCallId, requestId: r.requestId!,
    normalizedSessionId: proof.origin.normalizedSessionId, sourceInstanceId: proof.origin.sourceInstanceId,
    failedToolSourceSeq: proof.tool.sourceSeq, failedToolRowSha256: denialRowSha(proof.toolRows[0]),
    terminal: observed ? { eventType: observed.terminal.eventType, sourceSeq: observed.terminal.sourceSeq, rowSha256: denialRowSha(observed.row) } : null,
    apiReadCompletedMonotonicNs: process.hrtime.bigint().toString(), cancellationRequestId: input.cancellationRequestId };
}

/** Denial closes one permission, not necessarily the provider prompt. Match the
 * single canonical terminal to the same source stream, then independently bind
 * the audited controller Stop. Database createdAt is transaction-start metadata, not a commit boundary. */
export function readCopilotDenialSettlement(input: {
  events: readonly unknown[]; request: CopilotToolNotice; run: unknown; issue: unknown;
  preStop: CopilotPreStopObservation; stopDispatchMonotonicNs: string;
}): CopilotDenialSettlement {
  const invalid = () => new Error("Copilot denial lacks exact provider settlement and audited run Stop");
  const { request, events } = input, run = settlementRecord(input.run), issue = settlementRecord(input.issue);
  const stop = settlementRecord(settlementRecord(run.resultJson).nativeCancellation);
  if (events.length > 20_000 || run.id !== request.runId || issue.id !== run.nativeIssueId
    || !settlementId(issue.companyId) || run.companyId !== issue.companyId || issue.status !== "in_progress" || run.status !== "cancelled"
    || stop.schema !== "paperclip.native-cancellation.v1" || stop.runId !== run.id || stop.companyId !== issue.companyId || stop.issueId !== issue.id
    || stop.intentId !== `native-cancellation:${input.preStop?.cancellationRequestId}`
    || settlementRecord(settlementRecord(run.resultJson).startupCancellation).cancellationRequestId !== input.preStop?.cancellationRequestId
    || stop.scope !== "run" || stop.dispatched !== true || stop.dispatchState !== "acknowledged" || stop.reasonCode !== "cancellation_run_only"
    || !Array.isArray(stop.effects) || stop.effects.length !== 1 || stop.effects[0] !== "release_run_resources") throw invalid();
  const { rows, get, stream, origin, delivery, failure, resolution, tool, toolRows, failed } = readCopilotDeniedEdit({ events, request, companyId: issue.companyId });
  const observed = readDeniedTerminal({ rows, get, stream, origin, delivery, failure, resolution, tool, toolRows, failed });
  if (!observed) throw invalid();
  const { row, terminal } = observed;
  const result: CopilotDenialSettlement = {
    schema: "paperclip.e2e.copilot-denial-settlement.v3",
    branch: row.eventType === "turn.completed" ? "provider_completed_observed_before_stop" : "provider_cancelled_or_interrupted",
    providerCancellationTerminalObserved: row.eventType !== "turn.completed",
    runId: run.id, sessionId: request.sessionId, turnId: request.turnId, toolCallId: request.toolCallId, requestId: request.requestId!,
    preStop: input.preStop, stopDispatchMonotonicNs: input.stopDispatchMonotonicNs,
    providerTerminal: { eventType: row.eventType, rowSha256: denialRowSha(row), failedToolRowSha256: denialRowSha(toolRows[0]), normalizedSessionId: terminal.normalizedSessionId, sourceInstanceId: terminal.sourceInstanceId,
      requestSourceSeq: origin.sourceSeq, resolvedSourceSeq: resolution.sourceSeq, deliveredSourceSeq: delivery.sourceSeq, failedNoticeSourceSeq: failure.sourceSeq,
      failedToolSourceSeq: tool.sourceSeq, failedToolRowCreatedAtMs: settlementDate(toolRows[0]!.createdAt), sourceSeq: terminal.sourceSeq, emittedAtMs: settlementDate(terminal.emittedAt), rowCreatedAtMs: settlementDate(row.createdAt) },
    runStop: { companyId: issue.companyId, issueId: issue.id, scope: stop.scope, status: run.status, issueStatus: issue.status,
      intentId: stop.intentId, intentAuditId: stop.intentAuditId, acknowledgementAuditId: stop.acknowledgementAuditId,
      requestedAtMs: settlementDate(settlementRecord(settlementRecord(run.resultJson).startupCancellation).requestedAt),
      recordedAtMs: settlementDate(stop.recordedAt), acknowledgedAtMs: settlementDate(stop.acknowledgedAt), finishedAtMs: settlementDate(run.finishedAt) },
  };
  if (!validCopilotDenialSettlement(result)) throw invalid();
  return result;
}

export interface CopilotDenialSampleCursor {
  runId: string; turnId: string; normalizedSessionId: string; sourceInstanceId: string; sourceSeq: number;
}
/** Read boundary for a sample checkpoint, not a clock conversion. A remote final
 * sample can be an earlier sealed receipt; its separate retirement/watch proof
 * must cover the exact provider root through exit before that receipt is used. */
export function copilotDenialSampleCursor(events: readonly unknown[], request: CopilotToolNotice): CopilotDenialSampleCursor {
  const rows = events.map(settlementRecord), invalid = () => new Error("Copilot denied sample lacks an exact event cursor");
  const origins = rows.filter(r => r.seq === request.seq);
  if (origins.length !== 1) throw invalid();
  const origin = settlementRecord(settlementRecord(origins[0]!.payload).prpEvent);
  const frames = rows.map(r => ({ row: r, f: settlementRecord(settlementRecord(r.payload).prpEvent) }))
    .filter(({ f }) => f.turnId === request.turnId);
  if (events.length > 20_000 || frames.length === 0 || origin.runId !== request.runId
    || ![origin.normalizedSessionId, origin.sourceInstanceId].every(settlementId)) throw invalid();
  const seen = new Set<number>();
  for (const { row, f } of frames) {
    if (row.runId !== request.runId || f.runId !== request.runId || f.schema !== "paperclip.prp.event.v1" || f.sourceKind !== "runner"
      || row.eventType !== f.eventType || f.normalizedSessionId !== origin.normalizedSessionId || f.sourceInstanceId !== origin.sourceInstanceId
      || !Number.isSafeInteger(f.sourceSeq) || f.sourceSeq <= 0 || seen.has(f.sourceSeq)
      || f.sourceEventId !== `${f.sourceInstanceId}:${f.runId}:${f.sourceSeq}`) throw invalid();
    seen.add(f.sourceSeq);
  }
  return { runId: request.runId, turnId: request.turnId, normalizedSessionId: origin.normalizedSessionId,
    sourceInstanceId: origin.sourceInstanceId, sourceSeq: Math.max(...seen) };
}
