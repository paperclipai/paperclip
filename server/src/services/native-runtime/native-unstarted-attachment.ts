import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, nativeRunResults, toolInvocations, type Db } from "@paperclipai/db";
import { parseNativeExecutionInput, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { NATIVE_SESSION_ROOT_LAUNCH_ENTRIES } from "./native-session-root-entries.js";
import { RUNNERD_CONTROL_PLANE_STATE_SCHEMAS } from "./native-bootstrap-proof.js";
import { hasPendingRunCleanup } from "../execution-blocker.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { PRIOR_OWNER_FENCE_REFUSED } from "../native-local-process-stop.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const identityKeys = ["runId", "runnerInstanceId", "normalizedSessionId", "environmentLeaseId", "turnId", "itemId"];
const originKeys = identityKeys.filter(key => key !== "environmentLeaseId");
const lifecycle = new Set(["runner.drain", "runner.suspend", "runner.shutdown"]);
const directory = (path: string) => { const stat = lstatSync(path, { throwIfNoEntry: false }); return !!stat?.isDirectory() && !stat.isSymbolicLink(); };
const absent = (pid: unknown): pid is number => {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1 || Number(pid) >= 2 ** 31) return false;
  try { process.kill(Number(pid), 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};

function readSnapshot(root: string) {
  if (!directory(root) || !directory(join(root, "runner")) || !directory(join(root, "control-plane"))) throw Error("attachment_state_unsafe");
  const files = ["control-plane/control-plane-state.json", "runner/runner-state.json", "runner/codex-provider-state.json"];
  const bytes = files.map(name => {
    const path = join(root, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Error("attachment_state_unreadable");
    return readFileSync(path);
  });
  const [control, runner, provider] = bytes.map(value => record(JSON.parse(value.toString("utf8"))));
  return { control: control!, runner: runner!, provider: provider!, fingerprint: createHash("sha256").update(JSON.stringify(bytes.map(b => createHash("sha256").update(b).digest("hex")))).digest("hex") };
}

/** A run.attach journal is written before its effect. With no turn command,
 * no emitted PRP event and an unauthenticated startup, it granted no new tool
 * authority. Physical absence is still required for every recorded process. */
export async function proveUnstartedAttachmentQuarantine(input: {
  db: Db; root: string; execution: NativeExecutionInput;
  sameScope: (source: NativeExecutionInput) => boolean;
}): Promise<{ evidence: Record<string, unknown>; unchanged: () => boolean } | null> {
  try {
    if (input.execution.provider.kind !== "codex" || input.execution.session.lifecyclePolicy.mode !== "per_turn" || !directory(input.root)) return null;
    const inventory = () => readdirSync(input.root).sort().join("\0");
    const names = readdirSync(input.root), originalInventory = inventory();
    const allowed = new Set([...NATIVE_SESSION_ROOT_LAUNCH_ENTRIES, "control-plane", "runner", "codex-home", "authority-epochs", "continuity-breaks"]);
    if (names.length > 32 || names.some(name => !allowed.has(name))) return null;
    let source = input.root, archives: string[] | undefined;
    if (!names.includes("control-plane") && !names.includes("runner")) {
      const parent = join(input.root, "continuity-breaks");
      if (!directory(parent)) return null;
      archives = readdirSync(parent);
      if (archives.length !== 1 || !directory(join(parent, archives[0]!))) return null;
      source = join(parent, archives[0]!);
    }
    const snapshot = readSnapshot(source), { control, runner, provider } = snapshot;
    const identity = record(control.identity), startup = record(provider.startupAttempt);
    if (!RUNNERD_CONTROL_PLANE_STATE_SCHEMAS.has(String(control.schema)) || runner.schema !== "paperclip.runner.durable.state.v1" ||
      provider.schema !== "paperclip.runner.codex-provider-state.v1" ||
      !identityKeys.every(key => typeof identity[key] === "string" && identity[key] && runner[key] === identity[key]) ||
      !originKeys.every(key => record(startup.origin)[key] === identity[key]) ||
      identity.runId === input.execution.binding.runId || identity.normalizedSessionId !== input.execution.session.normalizedSessionId ||
      control.warmTransition != null || control.completedWarmTransition != null || control.stagedRunAttachment != null ||
      record(control.bootstrapHistory).adopted === true || !Number.isSafeInteger(control.connectionCount) || Number(control.connectionCount) < 1 ||
      control.ackedSourceSeq !== 0 || !Array.isArray(control.committedEvents) || control.committedEvents.length !== 0 ||
      !Array.isArray(control.commands) || runner.lifecycle !== "ready" || runner.nextSourceSeq !== 1 || runner.ackedSourceSeq !== 0 ||
      !Array.isArray(runner.outbox) || runner.outbox.length !== 0 || runner.pendingTerminalDelivery != null || runner.warmTransition != null ||
      provider.lifecycle !== "prepared" || provider.activeProviderTurnId != null ||
      provider.ambiguousTurnStartPending != null && provider.ambiguousTurnStartPending !== false ||
      provider.receiptLimitInterruptPending === true || Array.isArray(provider.descendantThreadIds) && provider.descendantThreadIds.length > 0 ||
      record(provider.goal).status === "active" || record(provider.goal).workingNow === true ||
      startup.schema !== "paperclip.provider_startup.v1" || !["spawned", "initialization_failed"].includes(String(startup.phase)) ||
      startup.authenticatedThreadId != null) return null;
    const commands = control.commands.map(record), attaches = commands.filter(c => c.type === "run.attach");
    if (attaches.length !== 1 || !["pending", "failed"].includes(String(attaches[0]!.status)) ||
      !commands.every(c => c === attaches[0] || lifecycle.has(String(c.type)))) return null;
    const attach = attaches[0]!, startupCommand = record(startup.command);
    if (typeof attach.commandId !== "string" || startupCommand.commandId !== attach.commandId ||
      startupCommand.controllerSeq !== attach.controllerSeq || startupCommand.commandType !== "run.attach") return null;
    const processed = Object.values(record(runner.processedCommands)).map(record);
    if (processed.length === 0 || !processed.every(c => lifecycle.has(String(c.commandType)) ||
      c.commandType === "run.attach" && c.commandId === attach.commandId && c.controllerSeq === attach.controllerSeq && c.status === "pending")) return null;
    const pids = new Set<number>();
    const addStartup = (value: Record<string, unknown>) => {
      if (value.schema !== startup.schema || record(value.command).commandId !== attach.commandId || value.authenticatedThreadId != null ||
        !originKeys.every(key => record(value.origin)[key] === identity[key])) return false;
      if (value.processId != null) { if (!absent(value.processId)) return false; pids.add(value.processId); }
      if (value.processGroupId != null && (process.platform === "win32" ? !absent(value.processGroupId) : (() => {
        if (!Number.isSafeInteger(value.processGroupId) || Number(value.processGroupId) <= 1) return true;
        try { process.kill(-Number(value.processGroupId), 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
      })())) return false;
      return true;
    };
    if (!addStartup(startup) || pids.size === 0) return null;
    if (!Array.isArray(provider.pendingEvents) || !Array.isArray(provider.queuedEvents)) return null;
    for (const value of [...provider.pendingEvents, ...provider.queuedEvents]) {
      const event = record(value), payload = record(event.payload);
      if (event.eventType === "session.goal.cleared" && payload.workingNow !== true && record(payload.goal).status !== "active") continue;
      if (event.eventType !== "harness.diagnostic") return null;
      if (payload.code === "provider_startup_ownership") { if (!addStartup(record(payload.startup))) return null; }
      else if (payload.code !== "codex_resume_usage_snapshot") return null;
    }
    const ownerId = String(identity.runId), { db } = input;
    const [owner] = await db.select({ run: {
      id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt,
      runtimeMode: heartbeatRuns.runtimeMode, nativeSessionId: heartbeatRuns.nativeSessionId, runnerInstanceId: heartbeatRuns.runnerInstanceId,
      runnerProfileJson: heartbeatRuns.runnerProfileJson, resultJson: heartbeatRuns.resultJson,
    }, coordinator: { phase: nativeRunFinalizations.phase, resultId: nativeRunFinalizations.resultId,
      leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt } }).from(heartbeatRuns)
      .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id)).where(and(
        eq(heartbeatRuns.id, ownerId), eq(heartbeatRuns.companyId, input.execution.binding.companyId),
        eq(heartbeatRuns.agentId, input.execution.binding.agentId), eq(heartbeatRuns.nativeIssueId, input.execution.binding.issueId!),
        eq(nativeRunFinalizations.companyId, input.execution.binding.companyId))).limit(1);
    if (!owner || owner.run.status !== "failed" || !owner.run.finishedAt || owner.run.runtimeMode !== "native" ||
      owner.run.nativeSessionId !== identity.normalizedSessionId || owner.run.runnerInstanceId !== identity.runnerInstanceId ||
      owner.coordinator.phase !== "terminal_failure" || owner.coordinator.resultId || owner.coordinator.leaseOwner ||
      owner.coordinator.leaseExpiresAt && owner.coordinator.leaseExpiresAt > new Date() ||
      record(owner.run.resultJson).cancellation || record(owner.run.resultJson).nativeCancellation) return null;
    const original = parseNativeExecutionInput(record(owner.run.runnerProfileJson).nativeExecutionInput);
    if (original.binding.runId !== ownerId || original.binding.companyId !== input.execution.binding.companyId ||
      original.binding.agentId !== input.execution.binding.agentId || original.binding.issueId !== input.execution.binding.issueId ||
      !input.sameScope(original) || record(record(owner.run.runnerProfileJson).sessionCheckpoint).activeTurnId != null) return null;
    const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, owner.run.companyId), eq(environmentLeases.heartbeatRunId, ownerId)));
    if (!leases.length || leases.some(l => l.provider !== "local" || !l.releasedAt) || await hasPendingRunCleanup(db, owner.run.companyId, ownerId)) return null;
    const [effect] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, owner.run.companyId),
      eq(heartbeatRunEvents.runId, ownerId), or(sql`${heartbeatRunEvents.sourceEventId} is not null`, sql`${heartbeatRunEvents.eventType} ~ '^(session|turn|item|tool|semantic_tool|run[.]result)[.]'`))).limit(1);
    const [tool] = await db.select({ id: toolInvocations.id }).from(toolInvocations).where(and(eq(toolInvocations.companyId, owner.run.companyId), eq(toolInvocations.runId, ownerId))).limit(1);
    const [result] = await db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(eq(nativeRunResults.companyId, owner.run.companyId), eq(nativeRunResults.runId, ownerId))).limit(1);
    if (effect || tool || result) return null;
    const events = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, owner.run.companyId), eq(heartbeatRunEvents.runId, ownerId), isNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["native.process_start_requested", "native.process_identity_recorded", "native.local_process_stopped"])))
      .orderBy(desc(heartbeatRunEvents.seq)).limit(2);
    const launch = events[0]?.eventType === "native.local_process_stopped" ? events[1] : events[0], processIdentity = record(launch?.payload);
    if (launch?.eventType !== "native.process_identity_recorded" || processIdentity.targetKind !== "local" || processIdentity.hostname !== hostname() ||
      typeof processIdentity.processStartedAt !== "string" || !Number.isFinite(Date.parse(processIdentity.processStartedAt)) || !absent(processIdentity.processPid)) return null;
    const runnerGroupGone = () => {
      const group = processIdentity.processGroupId;
      if (group == null) return true;
      if (process.platform === "win32" || !Number.isSafeInteger(group) || Number(group) <= 1) return false;
      try { process.kill(-Number(group), 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    };
    if (!runnerGroupGone()) return null;
    pids.add(processIdentity.processPid);
    const unchanged = () => {
      try { return directory(input.root) && inventory() === originalInventory && readSnapshot(source).fingerprint === snapshot.fingerprint &&
        (!archives || readdirSync(join(input.root, "continuity-breaks")).join("\0") === archives.join("\0")) && [...pids].every(absent) && runnerGroupGone(); }
      catch { return false; }
    };
    return unchanged() ? { evidence: { schema: "paperclip.unstarted_attachment_recovery.v1", ownerRunId: ownerId,
      nativeSessionId: identity.normalizedSessionId, runnerInstanceId: identity.runnerInstanceId, stateFingerprint: snapshot.fingerprint }, unchanged } : null;
  } catch { return null; }
}

export async function refuseUnverifiedNativeContinuity(input: {
  db: Db; execution: NativeExecutionInput; reason: "quarantine_owner_unverified" | "quarantine_candidates_ambiguous" | "recovery_evidence_changed";
}): Promise<never> {
  const { db, execution } = input;
  if (execution.binding.issueId) {
    const [current] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, execution.binding.runId), eq(heartbeatRuns.companyId, execution.binding.companyId),
      eq(heartbeatRuns.agentId, execution.binding.agentId), eq(heartbeatRuns.nativeIssueId, execution.binding.issueId),
    )).limit(1);
    if (current) {
      const [started] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.companyId, execution.binding.companyId), eq(heartbeatRunEvents.runId, execution.binding.runId),
        or(sql`${heartbeatRunEvents.sourceEventId} is not null`, inArray(heartbeatRunEvents.eventType,
          ["native.process_start_requested", "native.process_identity_recorded", "adapter.invoke"])),
      )).limit(1);
      if (!started) {
        await appendHeartbeatRunEvent(db, { companyId: execution.binding.companyId, agentId: execution.binding.agentId,
          runId: execution.binding.runId, eventType: PRIOR_OWNER_FENCE_REFUSED, stream: "system", level: "warn",
          message: "Saved session verification refused this run before it requested a runner launch.",
          payload: { reason: input.reason } });
        await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: "native_session_continuity_unverified", updatedAt: new Date() }).where(and(
          eq(nativeRunFinalizations.companyId, execution.binding.companyId), eq(nativeRunFinalizations.runId, execution.binding.runId),
          eq(nativeRunFinalizations.phase, "observed"), isNull(nativeRunFinalizations.leaseOwner), isNull(nativeRunFinalizations.controllerBootId),
          isNull(nativeRunFinalizations.resultId), isNull(nativeRunFinalizations.assessmentId), isNull(nativeRunFinalizations.decisionId),
        ));
      }
      const { issueRecoveryActionService } = await import("../issue-recovery-actions.js");
      await issueRecoveryActionService(db).upsertSourceScoped({ companyId: execution.binding.companyId,
        sourceIssueId: execution.binding.issueId, kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: execution.binding.agentId,
        cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuity:${execution.session.normalizedSessionId}`,
        evidence: { runId: execution.binding.runId, reason: input.reason, nativeContinuityRefusal: true,
          automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
        nextAction: "The saved session could not be verified. Reconcile its retained work before continuing.",
        wakePolicy: null, maxAttempts: 3 });
    }
  }
  const { unprocessable } = await import("../../errors.js");
  throw unprocessable(`runner_state_identity_mismatch: ${input.reason}`, { code: "native_session_continuity_unverified" });
}
