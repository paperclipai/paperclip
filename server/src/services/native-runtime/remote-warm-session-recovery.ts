import { and, eq } from "drizzle-orm";
import { agents, companies, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { parseNativeExecutionInput, type NativeExecutionInput, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { currentNativeControllerIdentity, evaluateNativeControllerTakeover } from "./native-restart-recovery.js";

export type RemoteWarmSessionRecovery = {
  identity: Record<string, string>;
  checkpoint: PersistedNativeSession;
  previousExecution: NativeExecutionInput;
  reuseProcess: boolean;
  remote: { providerLeaseId: string; remoteCwd: string };
  revalidate: (leaseOwner: string) => Promise<void>;
};

export async function inspectRemoteWarmSessionRecovery(input: {
  db: Db;
  execution: NativeExecutionInput;
  target: Extract<AdapterExecutionTarget, { kind: "remote" }>;
  identity: Record<string, unknown>;
  readControlState: () => Record<string, unknown>;
  matchesExecution: (previous: NativeExecutionInput) => boolean;
  loadCheckpoint: (previous: NativeExecutionInput) => PersistedNativeSession | null;
  canReuseProcess: (previous: NativeExecutionInput) => boolean;
}): Promise<RemoteWarmSessionRecovery> {
  const deny = (): never => { throw new Error("runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate"); };
  const { binding } = input.execution;
  const { target } = input;
  const identity: Record<string, string> = {};
  for (const key of ["runId", "normalizedSessionId", "runnerInstanceId", "environmentLeaseId", "turnId", "itemId"]) {
    const value = input.identity[key];
    if (typeof value !== "string" || !value) return deny();
    identity[key] = value;
  }
  if (target.transport !== "sandbox" || !target.leaseId || !target.environmentId ||
      !target.providerKey || !target.sandboxLeaseAcquisition || target.sandboxLeaseAcquisition.outcome !== "resumed" ||
      identity.runId === binding.runId) return deny();
  const providerLeaseId = target.sandboxLeaseAcquisition.providerLeaseId;
  const [prior] = await input.db.select({ run: heartbeatRuns, owner: nativeRunFinalizations })
    .from(heartbeatRuns).innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .where(and(eq(heartbeatRuns.id, identity.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId)));
  if (!prior || prior.run.status !== "succeeded" || prior.owner.phase !== "committed" ||
      !prior.owner.resultId || prior.owner.leaseOwner || !prior.owner.controllerPid ||
      !prior.owner.controllerProcessStartedAt || !prior.owner.controllerBootId) return deny();
  const previous = parseNativeExecutionInput(prior.run.runnerProfileJson?.nativeExecutionInput);
  if (previous.binding.runId !== identity.runId || !input.matchesExecution(previous)) return deny();
  const checkpoint = input.loadCheckpoint(previous);
  if (!checkpoint || checkpoint.identity.runId !== identity.runId ||
      checkpoint.identity.companyId !== binding.companyId || checkpoint.identity.issueId !== binding.issueId ||
      checkpoint.identity.agentId !== binding.agentId || checkpoint.identity.sessionId !== identity.normalizedSessionId ||
      checkpoint.driverKind !== previous.session.driverKind || !checkpoint.providerSessionId ||
      checkpoint.activeTurnId !== null || checkpoint.pendingRuntimeRequests?.length !== 0) return deny();
  const control = input.readControlState();
  const commands = control.commands;
  const events = control.committedEvents;
  const terminal = Array.isArray(events) ? events.at(-1) : undefined;
  if (!Array.isArray(commands) || commands.some(command => command.status !== "completed") ||
      terminal?.eventType !== "run.terminal" || terminal?.envelope?.runId !== identity.runId ||
      terminal?.envelope?.normalizedSessionId !== identity.normalizedSessionId ||
      Object.entries(identity).some(([key, value]) => (control.identity as Record<string, unknown>)?.[key] !== value)) return deny();
  const assertPriorStopped = async () => {
    const stopped = await evaluateNativeControllerTakeover({ owner: prior.owner, now: new Date(), requireStoppedController: true });
    if (!stopped.allowed) return deny();
  };
  await assertPriorStopped();
  const priorLeases = await input.db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, binding.companyId), eq(environmentLeases.heartbeatRunId, identity.runId),
    eq(environmentLeases.issueId, binding.issueId), eq(environmentLeases.environmentId, target.environmentId),
    eq(environmentLeases.provider, target.providerKey), eq(environmentLeases.providerLeaseId, providerLeaseId),
  ));
  if (priorLeases.length !== 1 || priorLeases[0].metadata?.remoteCwd !== target.remoteCwd ||
      !["released", "expired", "active"].includes(priorLeases[0].status)) return deny();
  return {
    identity, checkpoint, previousExecution: previous, reuseProcess: input.canReuseProcess(previous),
    remote: { providerLeaseId, remoteCwd: target.remoteCwd },
    revalidate: async leaseOwner => {
      await assertPriorStopped();
      const controller = await currentNativeControllerIdentity();
      const [current] = await input.db.select({ run: heartbeatRuns, owner: nativeRunFinalizations, issue: issues, agent: agents, company: companies })
        .from(heartbeatRuns).innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
        .innerJoin(issues, eq(issues.id, heartbeatRuns.nativeIssueId))
        .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
        .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
        .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
          eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId)));
      const [lease] = await input.db.select().from(environmentLeases).where(and(
        eq(environmentLeases.id, target.leaseId!), eq(environmentLeases.companyId, binding.companyId),
        eq(environmentLeases.heartbeatRunId, binding.runId), eq(environmentLeases.issueId, binding.issueId),
      ));
      const [priorOwner] = await input.db.select().from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.runId, identity.runId), eq(nativeRunFinalizations.companyId, binding.companyId),
        eq(nativeRunFinalizations.issueId, binding.issueId),
      ));
      if (!current || current.run.status !== "running" || current.run.resultJson?.nativeCancellation ||
          current.company.status !== "active" || current.agent.lifecycleState !== "ready" ||
          ["paused", "terminated", "pending_approval"].includes(current.agent.status) ||
          !priorOwner || priorOwner.leaseOwner || priorOwner.phase !== "committed" ||
          priorOwner.resultId !== prior.owner.resultId || priorOwner.controllerBootId !== prior.owner.controllerBootId ||
          current.owner.leaseOwner !== leaseOwner || !current.owner.leaseExpiresAt ||
          current.owner.leaseExpiresAt <= new Date() || current.owner.resultId ||
          current.owner.controllerBootId !== controller.bootId || current.owner.controllerPid !== controller.pid ||
          current.issue.executionRunId !== binding.runId || current.issue.assigneeAgentId !== binding.agentId ||
          current.issue.status !== "in_progress" || !lease || lease.status !== "active" ||
          lease.environmentId !== target.environmentId || lease.provider !== target.providerKey ||
          lease.providerLeaseId !== providerLeaseId || lease.metadata?.remoteCwd !== target.remoteCwd) return deny();
    },
  };
}
