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
  costEvents,
} from "@paperclipai/db";
import {
  BROWSER_USE_IDLE_MS,
  type BrowserUseControl,
  type BrowserUseSettings,
  type BrowserUseViewportRequest,
  type TaskBrowser,
} from "@paperclipai/shared";
import {
  browserUseClient,
  browserUseCostCap,
  BrowserUseError,
  browserUseTerminal,
  browserUseViewerUrl,
  isBrowserUseConnection,
  sanitizeBrowserUse,
  type BrowserUseRequest,
} from "./browser-use-client.js";
import { secretService } from "./secrets.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { accessService } from "./access.js";
import { createCostEventInTransaction } from "./costs.js";
import { createFinanceEventInTransaction } from "./finance.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { logActivity } from "./activity-log.js";
import { browserUseViewports } from "./browser-use-viewport.js";
import { forbidden, notFound, conflict } from "../errors.js";

type Session = typeof sessions.$inferSelect;
type Binding = {
  companyId: string;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
  approvedInvocationId?: string;
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
const requestMarker = (invocationId: string) => `\n\n[Paperclip request: ${invocationId}]`;

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
      result: run?.result ?? null,
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
    const { client } = await credentials(scope);
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
    const issue = await assertBinding(binding, approved);
    const { policies } = await budgets.overview(binding.companyId);
    const caps = policies
      .filter(
        (p) =>
          p.isActive &&
          p.hardStopEnabled &&
          p.metric === "billed_cents" &&
          p.amount > 0 &&
          (p.scopeType === "company" ||
            (p.scopeType === "agent" && p.scopeId === binding.agentId) ||
            (p.scopeType === "project" && p.scopeId === issue.projectId)),
      )
      .map((p) => p.remainingAmount / 100);
    const maxCostUsd = browserUseCostCap(
      config.maxCostUsd,
      args.maxCostUsd,
      ...caps,
    );
    const sid = args.sessionId;
    const s = await db.transaction(async (tx) => {
      let row: Session;
      if (sid) {
        await owned(binding, grant, sid);
        const [updated] = await tx
          .update(sessions)
          .set({
            status: "starting",
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
      await tx.insert(runs).values({
        companyId: binding.companyId,
        sessionId: row.id,
        heartbeatRunId: binding.runId!,
        invocationId,
        detachedUntil: approved
          ? new Date(Date.now() + BROWSER_USE_IDLE_MS)
          : null,
      });
      return row;
    });
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
      });
      await db.transaction(async (tx) => {
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
      const rejected = error instanceof BrowserUseError && error.requestRejected;
      const message = rejected ? error.message :
        "Browser run creation could not be confirmed. Paperclip is locating and stopping possible provider work. Do not start another run yet.";
      await db.transaction(async tx => {
        const [current] = await tx.select().from(sessions).where(eq(sessions.id, s.id)).for("update");
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
      await db
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
    const cents = Math.max(0, Math.round(Number(summary.totalCostUsd) * 100));
    if (!Number.isSafeInteger(cents))
      throw new BrowserUseError(502, "Browser Use returned invalid usage.");
    const event = await withAccountingTransaction(db, s.companyId, async (tx, publications) => {
      const [issue] = await tx
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, s.issueId), eq(issues.companyId, s.companyId)));
      const [current] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, run.id))
        .for("update");
      if (cents <= current.accountedCents) return null;
      const e = await createCostEventInTransaction(tx, s.companyId, {
        agentId: s.agentId,
        issueId: s.issueId,
        projectId: issue?.projectId,
        heartbeatRunId: run.heartbeatRunId,
        provider: "browser-use-cloud",
        biller: "browser-use-cloud",
        billingType: "metered_api",
        model: summary.model,
        costCents: cents - current.accountedCents,
        occurredAt: new Date(),
        billingCode: `browser-use-cloud:${run.id}`,
        idempotencyKey: `browser-use-cloud:${run.id}:${cents}`,
      }, publications);
      await createFinanceEventInTransaction(tx, publications, s.companyId, {
        agentId: e.agentId,
        issueId: e.issueId,
        projectId: e.projectId,
        heartbeatRunId: e.heartbeatRunId,
        costEventId: e.id,
        billingCode: e.billingCode,
        eventKind: "inference_charge",
        direction: "debit",
        biller: "browser-use-cloud",
        provider: "browser-use-cloud",
        model: e.model,
        amountCents: e.costCents,
        currency: "USD",
        description: "Browser Use agent run",
        occurredAt: e.occurredAt,
      });
      await tx
        .update(runs)
        .set({ accountedCents: cents })
        .where(eq(runs.id, run.id));
      return e;
    });
    // Re-evaluate on retries too: accounting may have committed immediately
    // before a crash interrupted budget enforcement.
    const lastEvent =
      event ??
      (
        await db
          .select()
          .from(costEvents)
          .where(
            and(
              eq(costEvents.companyId, s.companyId),
              eq(costEvents.billingCode, `browser-use-cloud:${run.id}`),
            ),
          )
          .orderBy(desc(costEvents.createdAt))
          .limit(1)
      )[0];
    if (lastEvent) await budgets.evaluateCostEvent(lastEvent);
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
        await db
          .update(runs)
          .set({
            result: sanitizeBrowserUse({
              result: summary.result,
              output: summary.output,
            }),
            eventsDrained: 1,
          })
          .where(eq(runs.id, run.id));
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
  let sweeping = false;
  async function sweep(connectionId?: string) {
    if (sweeping) return;
    sweeping = true;
    try {
      const due = await db
        .select()
        .from(sessions)
        .where(
          and(
            connectionId ? eq(sessions.connectionId, connectionId) : undefined,
            inArray(sessions.status, [
              "starting",
              "running",
              "idle",
              "stopping",
            ]),
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
          await db
            .update(sessions)
            .set({
              leaseToken: null,
              leaseUntil: null,
              nextPollAt: new Date(
                Date.now() + delay + Math.floor(Math.random() * 500),
              ),
            })
            .where(and(eq(sessions.id, s.id), eq(sessions.leaseToken, token)));
        }
      }
    } finally {
      sweeping = false;
    }
  }
  return {
    execute,
    sweep,
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
        inArray(sessions.status, ["starting", "running", "idle", "stopping"]),
      );
      await db
        .update(sessions)
        .set({
          stopRequested: "end",
          nextPollAt: new Date(),
          updatedAt: new Date(),
        })
        .where(scope);
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
