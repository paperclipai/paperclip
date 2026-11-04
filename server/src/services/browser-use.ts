import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type Db,
  browserUseSessions as sessions,
  browserUseRuns as runs,
  browserUseBrowsers as browsers,
  browserUseSettings as settings,
  connectionGrants,
  connectionGrantMembers,
  companyMemberships,
  companySecrets,
  toolInvocations,
  toolConnections,
  issues,
  heartbeatRuns,
  agents,
  companies,
  toolCatalogEntries,
} from "@paperclipai/db";
import {
  BROWSER_USE_IDLE_MS,
  type BrowserUseControl,
  type BrowserUseSettings,
  type BrowserUseViewportRequest,
  type TaskBrowser,
  centsToUnits,
  unitsToCents,
  centsToUsd,
  usdToUnits,
} from "@paperclipai/shared";
import {
  browserUseClient,
  BrowserUseError,
  browserUseTerminal,
  browserUseViewerUrl,
  isBrowserUseConnection,
  sanitizeBrowserUse,
  type BrowserUseRequest,
} from "./browser-use-client.js";
import { secretService } from "./secrets.js";
import { budgetService, budgetServiceInTransaction, type BudgetServiceHooks } from "./budgets.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { accessService } from "./access.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import { createCostEventInTransaction } from "./costs.js";
import { createFinanceEventInTransaction } from "./finance.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { logActivity, type ActivityPublication } from "./activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { browserUseViewports } from "./browser-use-viewport.js";
import { withBudgetSpan } from "./budget-tracing.js";
import { forbidden, notFound, conflict } from "../errors.js";

type Session = typeof sessions.$inferSelect;
type Binding = {
  companyId: string;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
  approvedInvocationId?: string;
  gatewayId?: string | null;
};
type Grant = typeof connectionGrants.$inferSelect;
const argsSchema = z
  .object({
    task: z.string().min(1).max(30000).optional(),
    sessionId: z.string().uuid().optional(),
    profileId: z.string().uuid().optional(),
    maxCostUsd: z.number().positive().finite().optional(),
  })
  .strict();
const terminalSessions = ["closed", "failed"];
const liveSessions = ["starting", "running", "idle", "stopping"];
const requestMarker = (invocationId: string) => `\n\n[Paperclip request: ${invocationId}]`;
type BrowserBudgetHold = { invocationId: string; amountCents: string; projectId: string | null;
  state: "held" | "released" | "settled"; uncapped?: boolean;
  dispatchCommittedAt?: string; accountedCentsExact?: string; billingUnknown?: boolean };
const resultObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const budgetHold = (value: unknown) => resultObject(value).paperclipBudgetHold as BrowserBudgetHold | undefined;
function publicResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { paperclipBudgetHold: _internal, ...visible } = resultObject(value);
  return Object.keys(visible).length ? visible : null;
}

export function browserUseService(
  db: Db,
  request?: BrowserUseRequest,
  budgetHooks: BudgetServiceHooks = {},
  authorizeSession?: (
    session: Session,
    run: typeof runs.$inferSelect,
  ) => Promise<boolean>,
) {
  const budgets = budgetService(db, budgetHooks);
  const secrets = secretService(db);
  async function credentials(
    s: Pick<Session, "companyId" | "connectionId" | "grantId">,
    cleanup = false,
  ) {
    const [row] = await db
      .select({ grant: connectionGrants, connection: toolConnections })
      .from(connectionGrants)
      .innerJoin(
        toolConnections,
        eq(toolConnections.id, connectionGrants.connectionId),
      )
      .where(
        and(
          eq(connectionGrants.id, s.grantId),
          eq(connectionGrants.companyId, s.companyId),
          eq(toolConnections.companyId, s.companyId),
          eq(toolConnections.id, s.connectionId),
        ),
      )
      .limit(1);
    if (!row || !isBrowserUseConnection(row.connection))
      throw forbidden("Browser connection is unavailable.");
    if (
      !cleanup &&
      (row.grant.status !== "active" ||
        row.connection.status !== "active" ||
        !row.connection.enabled)
    )
      throw forbidden("Browser access was revoked.");
    const ref = row.grant.credentialSecretRefs.find(
      (r) =>
        r.configPath === "credentials.apiKey" ||
        r.configPath.toLowerCase() === "headers.x-browser-use-api-key",
    );
    if (!ref) throw forbidden("Reconnect Browser Use to restore its API key.");
    const [credentialSnapshot] = await db.select().from(companySecrets).where(and(
      eq(companySecrets.companyId, s.companyId), eq(companySecrets.id, ref.secretId)));
    if (!credentialSnapshot || (!cleanup && credentialSnapshot.status !== "active"))
      throw forbidden("Browser credential is unavailable.");
    if (row.grant.kind === "user") {
      const [secret] = await db
        .select()
        .from(companySecrets)
        .where(
          and(
            eq(companySecrets.id, ref.secretId),
            eq(companySecrets.companyId, s.companyId),
          ),
        )
        .limit(1);
      if (
        !row.grant.subjectUserId ||
        secret?.scope !== "user" ||
        secret.ownerUserId !== row.grant.subjectUserId ||
        !secret.userSecretDefinitionId
      ) {
        throw forbidden("Personal browser credential ownership is invalid.");
      }
    }
    const key = await secrets.resolveSecretValue(
      s.companyId,
      ref.secretId,
      ref.versionSelector ?? "latest",
      {
        // The exact persisted grant is the authority, as in the gateway's
        // grant resolver. Cleanup must survive removal of runtime bindings.
        allowUserSecretScope: row.grant.kind === "user",
        accessContext: {
          consumerType: "tool_connection",
          consumerId: s.connectionId,
          configPath: ref.configPath,
          responsibleUserId: row.grant.subjectUserId,
          actorType: "system",
          actorId: cleanup ? "browser-use-cloud-cleanup" : "browser-use-cloud",
        },
      },
    );
    return {
      ...row,
      credentialSnapshot,
      client: browserUseClient(
        { "X-Browser-Use-API-Key": key },
        request,
        s.connectionId,
      ),
    };
  }
  async function owned(binding: Binding, grant: Grant, id: string) {
    const [s] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.companyId, binding.companyId),
          eq(sessions.issueId, binding.issueId!),
          eq(sessions.agentId, binding.agentId!),
          eq(sessions.grantId, grant.id),
          eq(sessions.connectionId, grant.connectionId),
        ),
      )
      .limit(1);
    if (!s)
      throw notFound(
        "Browser conversation not found for this task and credential.",
      );
    return s;
  }
  async function assertBinding(binding: Binding, approved = false) {
    if (!binding.issueId || !binding.agentId || !binding.runId)
      throw forbidden(
        "Browser tasks require an active Paperclip task and agent run. Use browser_profiles for a connection test.",
      );
    const [issue] = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.id, binding.issueId),
          eq(issues.companyId, binding.companyId),
        ),
      )
      .limit(1);
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, binding.runId),
          eq(heartbeatRuns.companyId, binding.companyId),
          eq(heartbeatRuns.agentId, binding.agentId),
        ),
      )
      .limit(1);
    if (
      !issue ||
      issue.assigneeAgentId !== binding.agentId ||
      !run ||
      (!approved && run.status !== "running")
    )
      throw forbidden(
        "The browser's owning task or agent run is no longer active.",
      );
    if (
      await issueTreeControlService(db).getActivePauseHoldGate(
        binding.companyId,
        issue.id,
      )
    )
      throw forbidden("This task is paused.");
    const blocked = await budgets.getInvocationBlock(
      binding.companyId,
      binding.agentId,
      { issueId: issue.id, projectId: issue.projectId },
    );
    if (blocked) throw forbidden(blocked.reason);
    return issue;
  }
  async function getSettings(
    companyId: string,
    grantId: string,
  ): Promise<BrowserUseSettings> {
    const [s] = await db
      .select()
      .from(settings)
      .where(
        and(eq(settings.grantId, grantId), eq(settings.companyId, companyId)),
      )
      .limit(1);
    return {
      allowedProfileIds: s?.allowedProfileIds ?? [],
      maxCostUsd: s?.maxCostUsd ? Number(s.maxCostUsd) : null,
    };
  }
  async function latest(s: Session) {
    return (
      await db
        .select()
        .from(runs)
        .where(and(eq(runs.companyId, s.companyId), eq(runs.sessionId, s.id)))
        .orderBy(desc(runs.createdAt))
        .limit(1)
    )[0];
  }
  async function snapshot(s: Session) {
    const run = await latest(s);
    const ownedBrowsers = await db
      .select({ id: browsers.id, status: browsers.status })
      .from(browsers)
      .where(
        and(eq(browsers.companyId, s.companyId), eq(browsers.sessionId, s.id)),
      );
    return {
      sessionId: s.id,
      status: s.status,
      runStatus: run?.status ?? null,
      progress: run?.progress ?? null,
      result: publicResult(run?.result ?? null),
      costCents: run?.accountedCents ?? 0,
      browsers: ownedBrowsers,
      error: s.error,
    };
  }
  async function signal(
    s: Session,
    action: string,
    actorId = "browser-use-cloud",
    actorType: "system" | "user" = "system",
  ) {
    await logActivity(db, {
      companyId: s.companyId,
      actorType,
      actorId,
      action,
      entityType: "issue",
      entityId: s.issueId,
      details: { browserSessionId: s.id },
    });
  }
  async function execute(
    binding: Binding,
    grant: Grant,
    invocationId: string,
    name: string,
    value: unknown,
  ) {
    const args = argsSchema.parse(value ?? {});
    const config = await getSettings(binding.companyId, grant.id);
    const scope = {
      companyId: binding.companyId,
      connectionId: grant.connectionId,
      grantId: grant.id,
    };
    const selected = await credentials(scope);
    const { client } = selected;
    if (name === "browser_profiles") {
      // A safe Test action that creates no paid work and exposes no unapproved profile.
      if (!config.allowedProfileIds.length) return { profiles: [] };
      const profiles: Array<{ id: string; name?: string | null }> = [];
      for (let page = 1; page <= 100; page++) {
        const list = await client.profiles(page);
        profiles.push(
          ...list.items.filter((p) => config.allowedProfileIds.includes(p.id)),
        );
        if (page * 100 >= list.totalItems) break;
      }
      return { profiles: sanitizeBrowserUse(profiles) };
    }
    let approved = false;
    if (binding.approvedInvocationId === invocationId) {
      const [invocation] = await db
        .select()
        .from(toolInvocations)
        .where(
          and(
            eq(toolInvocations.id, invocationId),
            eq(toolInvocations.companyId, binding.companyId),
            eq(toolInvocations.agentId, binding.agentId!),
            eq(toolInvocations.runId, binding.runId!),
            eq(toolInvocations.issueId, binding.issueId!),
            eq(toolInvocations.connectionId, grant.connectionId),
            eq(toolInvocations.status, "executing"),
            eq(toolInvocations.approvalState, "approved"),
          ),
        );
      approved = Boolean(invocation);
    }
    await assertBinding(binding, approved);
    if (name === "browser_sessions") {
      const rows = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.companyId, binding.companyId),
            eq(sessions.issueId, binding.issueId!),
            eq(sessions.agentId, binding.agentId!),
            eq(sessions.grantId, grant.id),
          ),
        );
      return { sessions: await Promise.all(rows.map(snapshot)) };
    }
    if (name !== "browser_start") {
      if (!args.sessionId)
        throw conflict("Choose a browser conversation from this task.");
      const s = await owned(binding, grant, args.sessionId);
      if (name === "browser_status") {
        // The signed approval dispatch owns the run until the resumed task
        // observes it. Thereafter normal parent-run cancellation applies.
        if (!approved)
          await db
            .update(runs)
            .set({ heartbeatRunId: binding.runId!, detachedUntil: null })
            .where(
              and(
                eq(runs.sessionId, s.id),
                eq(runs.companyId, s.companyId),
                sql`${runs.detachedUntil} is not null`,
              ),
            );
        return snapshot(s);
      }
      if (name === "browser_cancel" || name === "browser_end") {
        await control(s, name === "browser_cancel" ? "cancel" : "end");
        return snapshot(
          (await db.select().from(sessions).where(eq(sessions.id, s.id)))[0],
        );
      }
      if (name !== "browser_continue")
        throw notFound("Unknown Browser Use action.");
    }
    if (!args.task) throw conflict("A browser task is required.");
    if (
      args.profileId &&
      (!config.allowedProfileIds.includes(args.profileId) ||
        name !== "browser_start")
    )
      throw forbidden("This profile is not allowed for this credential.");
    const existing = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.companyId, binding.companyId),
          eq(runs.invocationId, invocationId),
        ),
      )
      .limit(1);
    if (existing[0])
      return snapshot(await owned(binding, grant, existing[0].sessionId));
    const admissionCheck = async (tx: Db, publications: ActivityPublication[], hold?: BrowserBudgetHold) => {
      const [parent] = await tx.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, binding.runId!), eq(heartbeatRuns.companyId, binding.companyId),
        eq(heartbeatRuns.agentId, binding.agentId!))).for("update");
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, binding.issueId!), eq(issues.companyId, binding.companyId)));
      const [currentAgent] = await tx.select().from(agents).where(and(eq(agents.id, binding.agentId!), eq(agents.companyId, binding.companyId)));
      const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, binding.companyId));
      if (!parent || (!approved && parent.status !== "running") || parent.resultJson?.cancellation || parent.resultJson?.startupCancellation
        || !issue || issue.assigneeAgentId !== binding.agentId || issue.status === "cancelled"
        || !currentAgent || currentAgent.lifecycleState !== "ready" || ["paused", "terminated", "pending_approval"].includes(currentAgent.status)
        || company?.status !== "active") return { reason: "The browser's owning task, company or agent run is no longer active." };
      const [invocation] = await tx.select().from(toolInvocations).where(and(
        eq(toolInvocations.id, invocationId), eq(toolInvocations.companyId, binding.companyId)));
      if (invocation && (invocation.agentId !== binding.agentId || invocation.runId !== binding.runId
        || invocation.issueId !== binding.issueId || invocation.connectionId !== grant.connectionId
        || invocation.status !== "executing" || !["agent", "user", "system", "plugin"].includes(invocation.actorType)))
        return { reason: "The browser invocation is no longer authorized." };
      if (approved && invocation?.approvalState !== "approved") return { reason: "The browser approval is no longer authorized." };
      if (await issueTreeControlService(tx).getActivePauseHoldGate(binding.companyId, issue.id)) return { reason: "This task is paused." };
      const [current] = await tx.select({ grant: connectionGrants, connection: toolConnections }).from(connectionGrants)
        .innerJoin(toolConnections, eq(toolConnections.id, connectionGrants.connectionId)).where(and(
          eq(connectionGrants.id, grant.id), eq(connectionGrants.companyId, binding.companyId),
          eq(toolConnections.id, grant.connectionId), eq(toolConnections.companyId, binding.companyId))).for("share");
      const [secret] = await tx.select().from(companySecrets).where(and(eq(companySecrets.id, selected.credentialSnapshot.id),
        eq(companySecrets.companyId, binding.companyId))).for("share");
      // Reuse the gateway's policy evaluator, including profile precedence,
      // exclusions and explicit denies. REST gallery tools do not need MCP
      // installation rows, and a matching binding alone is not authorization.
      const [entry] = await tx.select().from(toolCatalogEntries).where(and(
        eq(toolCatalogEntries.companyId, binding.companyId), eq(toolCatalogEntries.connectionId, grant.connectionId),
        eq(toolCatalogEntries.toolName, name))).limit(1);
      if (!entry || (invocation?.catalogEntryId && invocation.catalogEntryId !== entry.id)
        || (invocation?.upstreamToolName && invocation.upstreamToolName !== name))
        return { reason: "Browser tool is no longer available." };
      const access = await toolAccessPolicyService(tx).decide({
        companyId: binding.companyId, actor: { actorType: (invocation?.actorType ?? "agent") as "agent" | "user" | "system" | "plugin",
          actorId: invocation?.actorId ?? binding.agentId!, agentId: binding.agentId },
        runContext: { heartbeatRunId: binding.runId, issueId: issue.id, projectId: issue.projectId, gatewayId: binding.gatewayId ?? invocation?.gatewayId },
        request: { applicationId: entry.applicationId, connectionId: grant.connectionId, catalogEntryId: entry.id,
          toolName: invocation?.toolName ?? entry.name, upstreamToolName: name, riskLevel: entry.riskLevel,
          applicationKey: invocation?.applicationKey, providerType: invocation?.providerType ?? "rest_api", arguments: value, sideEffecting: true },
        consumeRateLimit: false, writeAuditEvent: false,
      }, { admittedInvocationId: invocation?.id });
      if (!access.allowed && !(approved && access.decision === "require_approval")) return { reason: access.explanation };
      if (!current || current.grant.status !== "active" || current.connection.status !== "active" || !current.connection.enabled
        || !isBrowserUseConnection(current.connection)
        || current.grant.updatedAt.getTime() !== selected.grant.updatedAt.getTime()
        || current.connection.updatedAt.getTime() !== selected.connection.updatedAt.getTime()
        || JSON.stringify(current.grant.credentialSecretRefs) !== JSON.stringify(selected.grant.credentialSecretRefs)
        || !secret || secret.status !== "active" || secret.latestVersion !== selected.credentialSnapshot.latestVersion)
        return { reason: "Browser access or its credential changed before dispatch." };
      const admission = await budgetServiceInTransaction(tx, publications).evaluateAdmission(binding.companyId, binding.agentId, { projectId: issue.projectId });
      if (admission.block) return { reason: admission.block.reason };
      if (hold && centsToUnits(hold.amountCents) === 0n && admission.policies.length)
        return { reason: "Browser budget changed before dispatch; try again with a bounded cost cap." };
      const [currentConfig] = await tx.select().from(settings).where(and(eq(settings.companyId, binding.companyId), eq(settings.grantId, grant.id)));
      if (args.profileId && !currentConfig?.allowedProfileIds.includes(args.profileId)) return { reason: "This profile is not allowed for this credential." };
      let amount: bigint | undefined;
      for (const cap of [currentConfig?.maxCostUsd, args.maxCostUsd]) {
        if (cap === null || cap === undefined) continue;
        const value = usdToUnits(cap);
        amount = amount === undefined || value < amount ? value : amount;
      }
      for (const [index, policy] of admission.policies.entries()) {
        const observed = admission.observations[index];
        const committed = centsToUnits(observed.ledgerCents) + centsToUnits(observed.effectiveHeldCents);
        const available = centsToUnits(policy.amount) - committed;
        if (hold ? available < 0n || (centsToUnits(hold.amountCents) === 0n && available === 0n) : available <= 0n)
          return { reason: "No browser budget remains; available capacity is reserved by unfinished work." };
        if (!hold) amount = amount === undefined || available < amount ? available : amount;
      }
      if (amount !== undefined && amount <= 0n) return { reason: "No browser budget remains." };
      if (hold && amount !== undefined && (centsToUnits(hold.amountCents) === 0n || amount < centsToUnits(hold.amountCents)))
        return { reason: "Browser cost settings changed before dispatch; try again." };
      if (hold && issue.projectId !== hold.projectId) return { reason: "The browser task's project changed before dispatch." };
      return { amountCents: unitsToCents(amount ?? 0n), maxCostUsd: amount === undefined ? undefined : Number(centsToUsd(unitsToCents(amount))), projectId: issue.projectId };
    };
    const sid = args.sessionId;
    const admitted = await withAccountingTransaction(db, binding.companyId, async (tx, publications) => {
      const [duplicate] = await tx.select().from(runs).where(and(eq(runs.companyId, binding.companyId), eq(runs.invocationId, invocationId)));
      if (duplicate) return { existing: duplicate.sessionId };
      const check = await admissionCheck(tx, publications);
      if (check.reason) return { reason: check.reason };
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.browser);
      let row: Session;
      if (sid) {
        await owned(binding, grant, sid);
        const [updated] = await tx
          .update(sessions)
          .set({
            status: "starting",
            nextPollAt: new Date(),
            idleDeadline: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(sessions.id, sid),
              eq(sessions.companyId, binding.companyId),
              eq(sessions.status, "idle"),
              isNull(sessions.stopRequested),
              or(
                isNull(sessions.leaseUntil),
                lte(sessions.leaseUntil, new Date()),
              ),
            ),
          )
          .returning();
        if (!updated)
          throw conflict("This browser conversation is busy or has ended.");
        row = updated;
      } else {
        [row] = await tx
          .insert(sessions)
          .values({
            ...scope,
            issueId: binding.issueId!,
            agentId: binding.agentId!,
            status: "starting",
          })
          .returning();
      }
      const hold: BrowserBudgetHold = { invocationId, amountCents: check.amountCents!, projectId: check.projectId!,
        state: "held", uncapped: check.maxCostUsd === undefined };
      await tx.insert(runs).values({
        result: { paperclipBudgetHold: hold },
        companyId: binding.companyId,
        sessionId: row.id,
        heartbeatRunId: binding.runId!,
        invocationId,
        detachedUntil: approved
          ? new Date(Date.now() + BROWSER_USE_IDLE_MS)
          : null,
      });
      return { session: row, hold, maxCostUsd: check.maxCostUsd };
    });
    if (admitted.reason) throw forbidden(admitted.reason);
    if (admitted.existing) return snapshot(await owned(binding, grant, admitted.existing));
    const s = admitted.session!;
    const maxCostUsd = admitted.maxCostUsd;
    let providerAttempted = false;
    let result: Awaited<ReturnType<typeof client.start>>;
    try {
      result = await client.start({
        // The v4 API has no create idempotency key. An opaque marker lets a
        // read-only recovery scan identify this exact request after a lost reply.
        task: args.task + requestMarker(invocationId),
        ...(s.providerSessionId ? { sessionId: s.providerSessionId } : {}),
        browserSettings: {
          record: false,
          // Live-verified v4 option; currently omitted from provider OpenAPI.
          allowResizing: true,
          ...(args.profileId ? { profileId: args.profileId } : {}),
        },
        ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
      }, async () => {
        const reason = await withAccountingTransaction(db, binding.companyId, async (tx, publications) => {
          const [current] = await tx.select().from(runs).where(and(eq(runs.invocationId, invocationId), eq(runs.companyId, binding.companyId))).for("update");
          const [currentSession] = await tx.select().from(sessions).where(and(eq(sessions.id, s.id), eq(sessions.companyId, binding.companyId))).for("update");
          const hold = budgetHold(current?.result);
          if (!currentSession || currentSession.status !== "starting" || currentSession.stopRequested) return "Browser session was stopped before dispatch.";
          if (!current || current.status !== "creating" || current.providerRunId || hold?.state !== "held" || hold.dispatchCommittedAt)
            return "Browser provider dispatch no longer owns this invocation.";
          const check = await admissionCheck(tx, publications, hold);
          if (check.reason) return check.reason;
          await tx.update(runs).set({ result: { ...resultObject(current.result), paperclipBudgetHold: { ...hold, dispatchCommittedAt: new Date().toISOString() } } }).where(eq(runs.id, current.id));
          return null;
        });
        if (reason) throw new BrowserUseError(403, reason, 0, true);
        providerAttempted = true;
      });
      await db.transaction(async (tx) => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.browser);
        await tx
          .update(runs)
          .set({ providerRunId: result.id, status: result.status })
          .where(eq(runs.invocationId, invocationId));
        await tx
          .update(sessions)
          .set({
            providerSessionId: result.sessionId,
            status: "running",
            error: null,
            nextPollAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(sessions.id, s.id));
      });
    } catch (error) {
      // A lost create response can mean paid work exists. Never submit it again.
      const rejected = !providerAttempted || (error instanceof BrowserUseError && error.requestRejected);
      const message = rejected ? (error instanceof Error ? error.message : "Browser dispatch was rejected.") :
        "Browser run creation could not be confirmed. Paperclip is locating and stopping possible provider work. Do not start another run yet.";
      await withAccountingTransaction(db, binding.companyId, async (tx, publications) => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.browser);
        const [current] = await tx.select().from(sessions).where(eq(sessions.id, s.id)).for("update");
        if (rejected) {
          await tx.update(runs).set({ result: sql`jsonb_set(${runs.result}, '{paperclipBudgetHold,state}', '"released"'::jsonb)` }).where(eq(runs.invocationId, invocationId));
          await budgetServiceInTransaction(tx, publications).evaluateAffectedScopes(binding.companyId, binding.agentId, admitted.hold!.projectId);
        } else {
          await tx.update(runs).set({ result: sql`jsonb_set(${runs.result}, '{paperclipBudgetHold,billingUnknown}', 'true'::jsonb)` }).where(eq(runs.invocationId, invocationId));
          await budgetServiceInTransaction(tx, publications).evaluateAffectedScopes(binding.companyId, binding.agentId, admitted.hold!.projectId);
        }
        // A restart must not leave a drained rejection attached to a starting
        // session: that combination has neither recovery work nor an idle timer.
        await tx.update(runs)
          .set({ status: rejected ? "failed" : "unknown", eventsDrained: rejected ? 1 : 0 })
          .where(eq(runs.invocationId, invocationId));
        const stopping = !rejected || current.stopRequested === "end";
        await tx.update(sessions).set({
          status: stopping ? "stopping" : (s.providerSessionId ? "idle" : "failed"),
          stopRequested: stopping ? "end" : null,
          idleDeadline: rejected && s.providerSessionId ? new Date(Date.now() + BROWSER_USE_IDLE_MS) : null,
          error: message,
          nextPollAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(sessions.id, s.id));
      });
      throw new BrowserUseError(
        error instanceof BrowserUseError ? error.status : 502,
        message,
      );
    }
    // An audit failure must not overwrite a successfully persisted paid run.
    await signal(s, "browser.started");
    return {
      sessionId: s.id,
      status: result.status,
      instruction:
        "Poll browser_status until terminal. The human's Browser tab opens when the browser is ready.",
    };
  }
  async function control(
    s: Session,
    action: BrowserUseControl,
    userId?: string,
  ) {
    if (action === "keep_open") {
      const updated = await db
        .update(sessions)
        .set({
          idleDeadline: new Date(Date.now() + BROWSER_USE_IDLE_MS),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sessions.id, s.id),
            eq(sessions.companyId, s.companyId),
            eq(sessions.status, "idle"),
            isNull(sessions.stopRequested),
            or(
              isNull(sessions.leaseUntil),
              lte(sessions.leaseUntil, new Date()),
            ),
          ),
        )
        .returning();
      if (!updated.length)
        throw conflict("Only an idle browser can be kept open.");
    } else {
      if (terminalSessions.includes(s.status)) return;
      await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.browser);
        await tx
          .update(sessions)
          .set({
            stopRequested: action,
            ...(action === "end" ? { status: "stopping" } : {}),
            nextPollAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(sessions.id, s.id),
              action === "cancel"
                ? or(
                    isNull(sessions.stopRequested),
                    ne(sessions.stopRequested, "end"),
                  )
                : undefined,
            ),
          );
      });
    }
    await signal(
      s,
      `browser.${action}_requested`,
      userId,
      userId ? "user" : "system",
    );
  }
  async function humanGrant(
    companyId: string,
    grantId: string,
    userId: string,
    cleanup = false,
  ) {
    const [grant] = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.id, grantId),
          eq(connectionGrants.companyId, companyId),
        ),
      )
      .limit(1);
    if (!grant || (!cleanup && grant.status !== "active"))
      throw forbidden("Browser credential access is unavailable.");
    const [membership] = await db
      .select({
        id: companyMemberships.id,
        role: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .limit(1);
    if ((!membership || membership.role === "viewer") && userId !== "board")
      throw forbidden("Company membership is no longer active.");
    if (grant.kind === "agent" && grant.createdByUserId === userId)
      return grant;
    if (grant.kind === "user" && grant.subjectUserId === userId) return grant;
    if (grant.kind !== "organization")
      throw forbidden("This browser belongs to another credential.");
    const members = await db
      .select()
      .from(connectionGrantMembers)
      .where(
        and(
          eq(connectionGrantMembers.companyId, companyId),
          eq(connectionGrantMembers.grantId, grantId),
        ),
      );
    if (
      members.length &&
      !members.some((m) => m.subjectType === "user" && m.subjectId === userId)
    )
      throw forbidden("This browser credential is not shared with you.");
    return grant;
  }
  async function list(
    companyId: string,
    issueId: string,
    userId: string,
  ): Promise<TaskBrowser[]> {
    const rows = await db
      .select({ s: sessions, b: browsers })
      .from(sessions)
      .leftJoin(browsers, eq(browsers.sessionId, sessions.id))
      .where(
        and(eq(sessions.companyId, companyId), eq(sessions.issueId, issueId)),
      )
      .orderBy(sessions.createdAt);
    const out: TaskBrowser[] = [];
    for (const { s, b } of rows) {
      try {
        await humanGrant(companyId, s.grantId, userId);
      } catch {
        continue;
      }
      const run = await latest(s);
      out.push({
        id: b?.id ?? s.id,
        sessionId: s.id,
        issueId,
        status:
          b?.status === "stopped"
            ? "closed"
            : !b && !terminalSessions.includes(s.status) && s.status !== "stopping"
              ? "starting"
              : (s.status as TaskBrowser["status"]),
        runStatus: run?.status ?? null,
        progress: run?.progress ?? null,
        costCents: run?.accountedCents ?? 0,
        idleDeadline: s.idleDeadline?.toISOString() ?? null,
        expiresAt: b?.expiresAt?.toISOString() ?? null,
        error: s.error,
        createdAt: (b?.createdAt ?? s.createdAt).toISOString(),
      });
    }
    return out;
  }
  async function humanSession(
    companyId: string,
    issueId: string,
    browserId: string,
    userId: string,
  ) {
    const [b] = await db
      .select()
      .from(browsers)
      .where(and(eq(browsers.id, browserId), eq(browsers.companyId, companyId)))
      .limit(1);
    const [s] = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.id, b?.sessionId ?? browserId),
          eq(sessions.companyId, companyId),
          eq(sessions.issueId, issueId),
        ),
      )
      .limit(1);
    if (!s) throw notFound("Browser not found.");
    await humanGrant(companyId, s.grantId, userId);
    return { s, b };
  }
  async function viewer(
    companyId: string,
    issueId: string,
    browserId: string,
    userId: string,
    viewerId?: string,
  ) {
    const { s, b } = await humanSession(companyId, issueId, browserId, userId);
    if (
      !b ||
      b.status !== "active" ||
      terminalSessions.includes(s.status) ||
      s.stopRequested === "end"
    )
      throw conflict("This browser is not available. It may have expired.");
    const { client } = await credentials(s);
    const result = await client.browser(b.providerBrowserId);
    if (
      result.status !== "active" ||
      result.agentSessionId !== s.providerSessionId
    )
      throw conflict("This browser is no longer active.");
    const viewportState = await browserUseViewports.current(
      b.providerBrowserId,
      `${userId}:${viewerId ?? ""}`,
    );
    return {
      url: browserUseViewerUrl(result.liveUrl),
      viewport: viewportState.preset,
      viewportState,
    };
  }
  async function presence(
    companyId: string,
    issueId: string,
    browserId: string,
    userId: string,
  ) {
    const { s, b } = await humanSession(companyId, issueId, browserId, userId);
    if (
      !b ||
      b.status !== "active" ||
      !["running", "idle"].includes(s.status) ||
      s.stopRequested === "end"
    )
      throw conflict("This browser is no longer active.");
    // Presence only renews existing idle browsers. It never starts paid work,
    // overrides a stop/revocation, or extends the provider's absolute lifetime.
    if (s.status !== "idle") return { accepted: true };
    const now = Date.now();
    const deadline = new Date(
      Math.min(now + BROWSER_USE_IDLE_MS, b.expiresAt?.getTime() ?? Infinity),
    );
    if (
      s.idleDeadline &&
      s.idleDeadline.getTime() >= deadline.getTime() - 60_000
    )
      return { accepted: true };
    const updated = await db
      .update(sessions)
      .set({ idleDeadline: deadline, updatedAt: new Date(now) })
      .where(
        and(
          eq(sessions.id, s.id),
          eq(sessions.companyId, companyId),
          eq(sessions.status, "idle"),
          isNull(sessions.stopRequested),
          // The reconciler holds this lease while deciding whether to close.
          or(
            isNull(sessions.leaseUntil),
            lte(sessions.leaseUntil, new Date(now)),
          ),
        ),
      )
      .returning();
    if (updated.length) await signal(s, "browser.viewing", userId, "user");
    return { accepted: updated.length > 0 };
  }
  async function resize(
    companyId: string,
    issueId: string,
    browserId: string,
    userId: string,
    request: BrowserUseViewportRequest,
  ) {
    const { s, b } = await humanSession(companyId, issueId, browserId, userId);
    if (
      !b ||
      b.status !== "active" ||
      !["running", "idle"].includes(s.status) ||
      s.stopRequested === "end"
    )
      throw conflict("This browser is not available. It may have expired.");
    const { client } = await credentials(s);
    const detail = await client.browser(b.providerBrowserId);
    if (
      detail.status !== "active" ||
      detail.agentSessionId !== s.providerSessionId
    )
      throw conflict("This browser is no longer active.");
    if (!detail.cdpUrl)
      throw conflict(
        "Browser resizing is unavailable. Reconnect the view and try again.",
      );
    const result = await browserUseViewports.resize(
      b.providerBrowserId,
      detail.cdpUrl,
      request,
      detail.timeoutAt,
      `${userId}:${request.viewerId ?? ""}`,
    );
    if (result.applied)
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "browser.resized",
        entityType: "issue",
        entityId: issueId,
        details: {
          browserSessionId: s.id,
          browserId,
          preset: result.preset,
          width: result.width,
          height: result.height,
        },
      });
    return result;
  }
  async function releaseViewport(
    companyId: string,
    issueId: string,
    browserId: string,
    userId: string,
    viewerId: string,
  ) {
    const { b } = await humanSession(companyId, issueId, browserId, userId);
    if (b)
      await browserUseViewports.releaseLease(
        b.providerBrowserId,
        `${userId}:${viewerId}`,
      );
    return { accepted: true };
  }
  async function discoverBrowsers(
    s: Session,
    client: ReturnType<typeof browserUseClient>,
  ) {
    if (!s.providerSessionId) return;
    for (let page = 1; page <= 100; page++) {
      const result = await client.browsers(s.providerSessionId, page);
      for (const item of result.items) {
        // List is scoped by session server-side. Check full detail too before
        // registering an instance; never infer ownership from an event URL.
        const detail = await client.browser(item.id);
        if (detail.agentSessionId !== s.providerSessionId) continue;
        if (detail.status === "stopped")
          await browserUseViewports.release(item.id);
        const rows = await db
          .insert(browsers)
          .values({
            companyId: s.companyId,
            sessionId: s.id,
            providerBrowserId: item.id,
            status: detail.status,
            expiresAt: detail.timeoutAt ? new Date(detail.timeoutAt) : null,
          })
          .onConflictDoNothing()
          .returning();
        if (rows.length) await signal(s, "browser.ready");
        await db
          .update(browsers)
          .set({ status: detail.status })
          .where(
            and(
              eq(browsers.companyId, s.companyId),
              eq(browsers.sessionId, s.id),
              eq(browsers.providerBrowserId, item.id),
            ),
          );
      }
      if (page * 100 >= result.totalItems) break;
    }
  }
  async function account(
    s: Session,
    run: typeof runs.$inferSelect,
    summary: Awaited<
      ReturnType<ReturnType<typeof browserUseClient>["summary"]>
    >,
  ) {
    let amount: bigint;
    try { amount = usdToUnits(summary.totalCostUsd); }
    catch { throw new BrowserUseError(502, "Browser Use returned invalid usage."); }
    if (amount < 0n || !browserUseTerminal(summary.status))
      throw new BrowserUseError(502, "Browser Use returned invalid terminal usage.");
    const cents = unitsToCents(amount);
    await withBudgetSpan("budget.accounting.settlement", () => withAccountingTransaction(db, s.companyId, async (tx, publications) => {
      const [current] = await tx.select().from(runs).where(and(eq(runs.id, run.id), eq(runs.companyId, s.companyId))).for("update");
      const hold = budgetHold(current.result);
      const previous = centsToUnits(hold?.accountedCentsExact ?? current.accountedCents);
      const [issue] = await tx.select({ projectId: issues.projectId }).from(issues)
        .where(and(eq(issues.id, s.issueId), eq(issues.companyId, s.companyId)));
      const projectId = hold ? hold.projectId : issue?.projectId ?? null;
      // Replace the separate browser hold with its ledger charge atomically.
      // Provider output never gets to overwrite the private accounting state.
      const settled: BrowserBudgetHold = { ...(hold ?? { invocationId: current.invocationId, amountCents: "0.0000000", projectId }), state: "settled",
        accountedCentsExact: unitsToCents(amount > previous ? amount : previous) };
      await tx.update(runs).set({
        result: { ...resultObject(sanitizeBrowserUse({ result: summary.result, output: summary.output })),
          paperclipBudgetHold: settled },
        eventsDrained: 1,
        accountedCents: Math.min(2_147_483_647, Math.round(Number(unitsToCents(amount > previous ? amount : previous)))),
      }).where(eq(runs.id, current.id));
      if (amount <= previous) {
        if (hold?.state === "held") await budgetServiceInTransaction(tx, publications).evaluateAffectedScopes(s.companyId, s.agentId, projectId);
        return;
      }
      const e = await createCostEventInTransaction(tx, s.companyId, {
        agentId: s.agentId, issueId: s.issueId, projectId,
        heartbeatRunId: run.heartbeatRunId,
        provider: "browser-use-cloud", biller: "browser-use-cloud", billingType: "metered_api", model: summary.model,
        costCents: unitsToCents(amount - previous), occurredAt: new Date(),
        billingCode: `browser-use-cloud:${run.id}`, idempotencyKey: `browser-use-cloud:${run.id}:${cents}`,
      }, publications);
      await createFinanceEventInTransaction(tx, publications, s.companyId, {
        agentId: e.agentId, issueId: e.issueId, projectId: e.projectId, heartbeatRunId: e.heartbeatRunId,
        costEventId: e.id, billingCode: e.billingCode, eventKind: "inference_charge", direction: "debit",
        biller: "browser-use-cloud", provider: "browser-use-cloud", model: e.model,
        amountCents: e.costCentsExact, currency: "USD", description: "Browser Use agent run", occurredAt: e.occurredAt,
      });
    }));
  }
  async function reconcile(s: Session) {
    const { grant, connection, client } = await credentials(s, true);
    let end =
      s.stopRequested === "end" ||
      grant.status !== "active" ||
      !connection.enabled ||
      connection.status !== "active" ||
      (s.idleDeadline !== null && s.idleDeadline.getTime() <= Date.now());
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, s.issueId), eq(issues.companyId, s.companyId)));
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, s.agentId), eq(agents.companyId, s.companyId)));
    if (
      !issue ||
      issue.assigneeAgentId !== s.agentId ||
      issue.status === "cancelled" ||
      agent?.status === "paused" ||
      agent?.status === "terminated"
    )
      end = true;
    if (
      await issueTreeControlService(db).getActivePauseHoldGate(
        s.companyId,
        s.issueId,
      )
    )
      end = true;
    if (
      await budgets.getInvocationBlock(s.companyId, s.agentId, {
        issueId: s.issueId,
        projectId: issue?.projectId,
      })
    )
      end = true;
    const allRuns = await db
      .select()
      .from(runs)
      .where(and(eq(runs.sessionId, s.id), eq(runs.companyId, s.companyId)))
      .orderBy(desc(runs.createdAt));
    if (
      allRuns[0] &&
      authorizeSession &&
      !(await authorizeSession(s, allRuns[0]))
    )
      end = true;
    let active = false;
    let pendingAccounting = false;
    let discovered = false;
    for (const run of allRuns) {
      if (!run.providerRunId) {
        if (run.eventsDrained) continue; // A definitive rejection made no paid run.
        if (run.status === "creating" && Date.now() - run.createdAt.getTime() <= 60_000) {
          active = true;
          continue;
        }
        if (budgetHold(run.result)?.state === "held" && !budgetHold(run.result)?.dispatchCommittedAt) {
          const repaired = await withAccountingTransaction(db, s.companyId, async (tx, publications) => {
            const [current] = await tx.select().from(runs).where(and(eq(runs.id, run.id), eq(runs.companyId, s.companyId))).for("update");
            const hold = budgetHold(current?.result);
            if (!current || current.providerRunId || current.status !== "creating" || hold?.state !== "held" || hold.dispatchCommittedAt
              || Date.now() - current.createdAt.getTime() <= 60_000) return null;
            await notifyDeliveryWork(tx, DELIVERY_QUEUES.browser);
            await tx.update(runs).set({ status: "failed", eventsDrained: 1,
              result: { ...resultObject(current.result), paperclipBudgetHold: { ...hold, state: "released" } } }).where(eq(runs.id, run.id));
            const [session] = await tx.select().from(sessions).where(eq(sessions.id, s.id)).for("update");
            const stopping = session.stopRequested === "end";
            const [updated] = await tx.update(sessions).set({
              status: stopping ? "stopping" : session.providerSessionId ? "idle" : "failed",
              idleDeadline: !stopping && session.providerSessionId ? new Date(Date.now() + BROWSER_USE_IDLE_MS) : null,
              updatedAt: new Date(),
            }).where(eq(sessions.id, s.id)).returning();
            await budgetServiceInTransaction(tx, publications).evaluateAffectedScopes(s.companyId, s.agentId, hold.projectId);
            return updated;
          });
          if (repaired) {
            Object.assign(s, repaired);
            run.eventsDrained = 1;
            run.status = "failed";
            if (terminalSessions.includes(s.status)) return;
            continue;
          }
        }
        end = true;
        await db.update(sessions).set({ status: "stopping", stopRequested: "end" })
          .where(eq(sessions.id, s.id));
        let cursor = run.recoveryCursor;
        for (let page = 0; page < 5 && !run.providerRunId; page++) {
          const listed = await client.listRuns(s.providerSessionId, cursor);
          const matches = listed.runs.filter(candidate =>
            candidate.task.endsWith(requestMarker(run.invocationId)) &&
            (!s.providerSessionId || candidate.sessionId === s.providerSessionId));
          if (matches.length > 1) throw new BrowserUseError(502, "Browser recovery found ambiguous provider work.");
          const found = matches[0];
          if (found) {
            await db.transaction(async tx => {
              await tx.update(runs).set({ providerRunId: found.id, status: found.status, recoveryCursor: null })
                .where(eq(runs.id, run.id));
              await tx.update(sessions).set({ providerSessionId: found.sessionId })
                .where(eq(sessions.id, s.id));
            });
            run.providerRunId = found.id;
            run.status = found.status;
            s.providerSessionId = found.sessionId;
            break;
          }
          if (listed.hasMore && (!listed.nextCursor || listed.nextCursor === cursor))
            throw new BrowserUseError(502, "Browser recovery cursor did not advance.");
          cursor = listed.hasMore ? listed.nextCursor! : null;
          await db.update(runs).set({ status: "unknown", recoveryCursor: cursor }).where(eq(runs.id, run.id));
          if (!listed.hasMore) break;
        }
        if (!run.providerRunId) {
          // Absence from a list cannot prove a timed-out POST was rejected.
          // Keep cleanup pending and retain its credential for later discovery.
          active = true;
          continue;
        }
      }
      const [parent] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.heartbeatRunId));
      if (
        run.id === allRuns[0].id &&
        parent &&
        ["failed", "cancelled", "timed_out"].includes(parent.status)
      )
        end = true;
      if (browserUseTerminal(run.status) && run.eventsDrained) continue;
      let state = await client.status(run.providerRunId);
      if (
        run.id === allRuns[0].id &&
        !browserUseTerminal(state.status) &&
        (issue?.status === "done" ||
          (parent?.status !== "running" &&
            (!run.detachedUntil || run.detachedUntil.getTime() <= Date.now())))
      )
        end = true;
      if (
        (end || s.stopRequested === "cancel") &&
        !browserUseTerminal(state.status)
      ) {
        await client.cancel(run.providerRunId);
        state = await client.status(run.providerRunId);
      }
      active ||= !browserUseTerminal(state.status);
      let after = run.eventCursor;
      let drained = false;
      // Bounded pages yield fairly across sessions. Cursor commits on every page.
      for (let page = 0; page < 5; page++) {
        const events = await client.events(run.providerRunId, after);
        const fresh = events.events.filter((e) => e.id > after);
        if (!discovered && fresh.some((e) => e.type === "browser.ready")) {
          await discoverBrowsers(s, client);
          discovered = true;
        }
        const cursor = Math.max(
          after,
          events.nextAfter ?? 0,
          ...fresh.map((e) => e.id),
        );
        const progress = fresh.at(-1)?.type ?? run.progress;
        await db
          .update(runs)
          .set({
            eventCursor: cursor,
            progress: progress
              ? String(sanitizeBrowserUse(progress)).slice(0, 200)
              : null,
          })
          .where(eq(runs.id, run.id));
        if (!events.hasMore) {
          drained = true;
          break;
        }
        if (cursor <= after)
          throw new BrowserUseError(
            502,
            "Browser Use event cursor did not advance.",
          );
        after = cursor;
      }
      await db
        .update(runs)
        .set({ status: state.status })
        .where(eq(runs.id, run.id));
      pendingAccounting ||= browserUseTerminal(state.status) && !drained;
      if (browserUseTerminal(state.status) && drained) {
        const summary = await client.summary(run.providerRunId);
        await account(s, run, summary);
        await signal(s, "browser.run_finished");
      }
    }
    if (!discovered) await discoverBrowsers(s, client);
    if (end) {
      await db
        .update(sessions)
        .set({ status: "stopping", stopRequested: "end" })
        .where(eq(sessions.id, s.id));
      const live = await db
        .select()
        .from(browsers)
        .where(
          and(eq(browsers.sessionId, s.id), eq(browsers.status, "active")),
        );
      for (const b of live) {
        await client.stop(b.providerBrowserId);
        const confirmed = await client.browser(b.providerBrowserId);
        if (confirmed.status !== "stopped")
          throw new BrowserUseError(
            502,
            "Browser shutdown is not confirmed. Paperclip will retry.",
          );
        await db
          .update(browsers)
          .set({ status: "stopped" })
          .where(eq(browsers.id, b.id));
      }
      // A cancelling run can spawn another browser before exiting; keep sweeping.
      if (!active && !pendingAccounting) {
        await db
          .update(sessions)
          .set({ status: "closed", error: null, stopRequested: null })
          .where(eq(sessions.id, s.id));
        await signal(s, "browser.closed");
      }
    } else if (
      !active &&
      allRuns.length &&
      allRuns.every((r) => r.providerRunId || r.eventsDrained)
    ) {
      await db
        .update(sessions)
        .set({
          status: "idle",
          idleDeadline:
            s.idleDeadline ?? new Date(Date.now() + BROWSER_USE_IDLE_MS),
          stopRequested: null,
          error: null,
        })
        .where(
          and(
            eq(sessions.id, s.id),
            ne(sessions.status, "starting"),
            or(
              isNull(sessions.stopRequested),
              eq(sessions.stopRequested, "cancel"),
            ),
            eq(sessions.updatedAt, s.updatedAt),
          ),
        );
    }
  }
  // Wait for a concurrent sweep rather than reporting completion while its
  // lease is still held. A filtered cleanup must still inspect its own scope.
  let sweeping: Promise<void> | null = null;
  async function sweep(connectionId?: string): Promise<void> {
    if (sweeping) {
      await sweeping;
      return sweep(connectionId);
    }
    sweeping = reconcileDue(connectionId);
    try { await sweeping; } finally { sweeping = null; }
  }
  async function reconcileDue(connectionId?: string) {
    const due = await db
      .select()
      .from(sessions)
      .where(
        and(
          connectionId ? eq(sessions.connectionId, connectionId) : undefined,
          inArray(sessions.status, liveSessions),
          lte(sessions.nextPollAt, new Date()),
          or(
            isNull(sessions.leaseUntil),
            lte(sessions.leaseUntil, new Date()),
          ),
        ),
      )
      .limit(30);
    for (const s of due) {
      const token = randomUUID();
      const lease = await db
        .update(sessions)
        .set({
          leaseToken: token,
          leaseUntil: new Date(Date.now() + 180_000),
        })
        .where(
          and(
            eq(sessions.id, s.id),
            or(
              isNull(sessions.leaseUntil),
              lte(sessions.leaseUntil, new Date()),
            ),
          ),
        )
        .returning();
      if (!lease.length) continue;
      // Renew while paginating provider events or stopping multiple browsers.
      const renewal = setInterval(() => {
        void db
          .update(sessions)
          .set({ leaseUntil: new Date(Date.now() + 180_000) })
          .where(and(eq(sessions.id, s.id), eq(sessions.leaseToken, token)))
          .catch(() => {});
      }, 30_000);
      renewal.unref?.();
      let delay = s.status === "idle" ? 15000 : 3000;
      try {
        await reconcile(s);
      } catch (e) {
        delay = Math.max(
          10000,
          e instanceof BrowserUseError ? e.retryAfterMs : 0,
        );
        await db
          .update(sessions)
          .set({
            error:
              s.stopRequested === "end"
                ? "Browser shutdown is not confirmed. Paperclip will retry."
                : "Browser synchronization failed. Paperclip will retry.",
          })
          .where(eq(sessions.id, s.id));
      } finally {
        clearInterval(renewal);
        const release = (tx: Pick<Db, "update">) => tx.update(sessions).set({
          leaseToken: null,
          leaseUntil: null,
          nextPollAt: new Date(Date.now() + delay + Math.floor(Math.random() * 500)),
        }).where(and(eq(sessions.id, s.id), eq(sessions.leaseToken, token)));
        if (connectionId) {
          // Credential-removal sweeps can race the app worker. Wake it when
          // their lease ends so it does not wait for the old lease expiry.
          await db.transaction(async tx => {
            await notifyDeliveryWork(tx, DELIVERY_QUEUES.browser);
            await release(tx);
          });
        } else {
          await release(db);
        }
      }
    }
  }
  async function nextSweepAt(): Promise<number | null> {
    const [row] = await db.select({
      // An overdue row owned by another sweep cannot run before its lease ends.
      at: sql<string | null>`min(greatest(${sessions.nextPollAt}, ${sessions.leaseUntil}))`,
    }).from(sessions).where(inArray(sessions.status, liveSessions));
    return row?.at == null ? null : new Date(row.at).getTime();
  }
  return {
    execute,
    sweep,
    nextSweepAt,
    list,
    viewer,
    resize,
    humanGrant,
    humanSession,
    releaseViewport,
    presence,
    control,
    getSettings,
    async stopBeforeCredentialRemoval(companyId: string, connectionId: string) {
      const scope = and(
        eq(sessions.companyId, companyId),
        eq(sessions.connectionId, connectionId),
        inArray(sessions.status, liveSessions),
      );
      await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.browser);
        await tx
          .update(sessions)
          .set({
            stopRequested: "end",
            nextPollAt: new Date(),
            updatedAt: new Date(),
          })
          .where(scope);
      });
      await sweep(connectionId);
      const [pending] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(scope)
        .limit(1);
      if (pending)
        throw conflict(
          "Browser access is disabled. Shutdown is still pending; retry removal after the browsers stop. Paperclip retains the key only for cleanup until then.",
        );
    },
    async availableProfiles(
      companyId: string,
      grantId: string,
      userId: string,
    ) {
      const grant = await humanGrant(companyId, grantId, userId);
      const { client } = await credentials({
        companyId,
        grantId,
        connectionId: grant.connectionId,
      });
      const profiles: Array<{ id: string; name: string | null }> = [];
      for (let page = 1; page <= 100; page++) {
        const result = await client.profiles(page);
        profiles.push(
          ...result.items.map((p) => ({
            id: p.id,
            name: p.name ? String(sanitizeBrowserUse(p.name)) : null,
          })),
        );
        if (page * 100 >= result.totalItems) break;
      }
      return profiles;
    },
    async saveSettings(
      companyId: string,
      grantId: string,
      userId: string,
      value: BrowserUseSettings,
    ) {
      const grant = await humanGrant(companyId, grantId, userId);
      const managesShared =
        grant.kind === "organization" &&
        (userId === "board" ||
          (await accessService(db).hasPermission(
            companyId,
            "user",
            userId,
            "tools:manage_connections",
          )));
      if (
        !managesShared &&
        grant.createdByUserId !== userId &&
        grant.subjectUserId !== userId
      )
        throw forbidden(
          "Only the credential owner or a shared connection manager can change browser settings.",
        );
      const { client } = await credentials({
        companyId,
        grantId,
        connectionId: grant.connectionId,
      });
      if (value.allowedProfileIds.length) {
        const available = new Set<string>();
        for (let page = 1; page <= 100; page++) {
          const list = await client.profiles(page);
          for (const p of list.items) available.add(p.id);
          if (page * 100 >= list.totalItems) break;
        }
        if (value.allowedProfileIds.some((id) => !available.has(id)))
          throw forbidden(
            "A selected profile is not available to this credential.",
          );
      }
      const row = {
        companyId,
        grantId,
        allowedProfileIds: value.allowedProfileIds,
        maxCostUsd: value.maxCostUsd?.toString() ?? null,
      };
      await db
        .insert(settings)
        .values(row)
        .onConflictDoUpdate({ target: settings.grantId, set: row });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: userId,
        action: "browser.settings_updated",
        entityType: "tool_connection",
        entityId: grant.connectionId,
        details: { grantId },
      });
      return value;
    },
  };
}
