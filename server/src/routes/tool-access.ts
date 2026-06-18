import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  TOOL_APP_GALLERY,
  TOOL_ACTION_REQUEST_STATUSES,
  type DeploymentExposure,
  type DeploymentMode,
  type PermissionKey,
  connectToolAppSchema,
  createToolStdioCommandTemplateSchema,
  createToolApplicationSchema,
  createToolConnectionSchema,
  createToolPolicySchema,
  createToolProfileBindingForProfileSchema,
  createToolProfileEntryForProfileSchema,
  createToolProfileWithEntriesSchema,
  deleteToolProfileSchema,
  duplicateToolPolicySchema,
  disableToolStdioCommandTemplateSchema,
  duplicateToolProfileSchema,
  finishToolAppSchema,
  reconnectToolAppSchema,
  reviewToolProfileNewToolsSchema,
  createToolTrustRuleFromActionRequestSchema,
  importMcpJsonSchema,
  revokeToolTrustRuleSchema,
  reorderToolPoliciesSchema,
  toolPolicyTestRequestSchema,
  toolConnectionTestCallSchema,
  unbindToolProfileBindingSchema,
  updateToolApplicationSchema,
  updateToolConnectionSchema,
  updateToolPolicySchema,
  updateToolProfileEntrySchema,
  updateToolProfileWithEntriesSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { getActorInfo, assertBoard, assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";
import { accessService, googleSheetsRobotEmailFromEnv, logActivity, toolAccessPolicyService, toolAccessService } from "../services/index.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";

/** Allowlist (e.g. Google Sheets allowed spreadsheet ids) lives in connection config. */
function allowlistIds(config: Record<string, unknown> | null | undefined): string[] {
  const raw = config?.allowedSpreadsheetIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

/**
 * Classify a connection PATCH into operator-visible lifecycle events so the
 * per-app Activity tab can humanize them (PAP-11284). A single update may
 * touch more than one thing (e.g. pause + allowlist), so this returns a list.
 */
function classifyConnectionUpdate(
  before: { enabled: boolean; config?: Record<string, unknown> | null },
  after: { enabled: boolean; config?: Record<string, unknown> | null },
): Array<{ lifecycle: "paused" | "resumed" | "allowlist_changed"; details: Record<string, unknown> }> {
  const events: Array<{ lifecycle: "paused" | "resumed" | "allowlist_changed"; details: Record<string, unknown> }> = [];
  if (before.enabled !== after.enabled) {
    events.push({ lifecycle: after.enabled ? "resumed" : "paused", details: { enabled: after.enabled } });
  }
  const beforeIds = allowlistIds(before.config);
  const afterIds = allowlistIds(after.config);
  const beforeSet = new Set(beforeIds);
  const afterSet = new Set(afterIds);
  const added = afterIds.filter((id) => !beforeSet.has(id)).length;
  const removed = beforeIds.filter((id) => !afterSet.has(id)).length;
  if (added > 0 || removed > 0) {
    events.push({ lifecycle: "allowlist_changed", details: { added, removed, total: afterIds.length } });
  }
  return events;
}

export function toolAccessRoutes(
  db: Db,
  options: {
    deploymentMode?: DeploymentMode;
    deploymentExposure?: DeploymentExposure;
    trustedLocalStdioRuntimeHost?: string | null;
    toolGateway?: ToolGatewayService;
  } = {},
) {
  const router = Router();
  const svc = toolAccessService(db, options);
  const policySvc = toolAccessPolicyService(db);

  function requestBaseUrl(req: Request) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
    const proto = forwardedProto || req.protocol;
    const host = forwardedHost || req.get("host");
    return `${proto}://${host}`;
  }

  function oauthRedirectUri(req: Request) {
    return new URL("/api/tools/oauth/callback", requestBaseUrl(req)).toString();
  }
  const access = accessService(db);

  async function assertBoardToolPermission(req: Request, companyId: string, permissionKey: PermissionKey) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (userId && await access.hasPermission(companyId, "user", userId, permissionKey)) return;
    throw forbidden(`Missing permission: ${permissionKey}`);
  }

  async function assertBoardAnyToolPermission(req: Request, companyId: string, permissionKeys: PermissionKey[]) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (userId) {
      for (const permissionKey of permissionKeys) {
        if (await access.hasPermission(companyId, "user", userId, permissionKey)) return;
      }
    }
    throw forbidden(`Missing one of permissions: ${permissionKeys.join(", ")}`);
  }

  async function assertCanTestAsAgent(req: Request, companyId: string, agentId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId,
        issueId: null,
        projectId: null,
        parentIssueId: null,
        assigneeAgentId: agentId,
        assigneeUserId: null,
      },
      scope: {
        assigneeAgentId: agentId,
        assigneeUserId: null,
      },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation);
  }

  function sendToolGatewayError(res: import("express").Response, error: unknown) {
    if (error instanceof ToolGatewayHttpError) {
      res.status(error.status).json({ error: error.message, reasonCode: error.reasonCode, ...error.details });
      return true;
    }
    return false;
  }

  async function assertToolsAdmin(req: Request, companyId: string) {
    await assertBoardToolPermission(req, companyId, "tools:admin");
  }

  async function assertToolsRuntimeManage(req: Request, companyId: string) {
    await assertBoardToolPermission(req, companyId, "tools:manage_runtime");
  }

  function assertToolAppMutationAccess(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const membership = Array.isArray(req.actor.memberships)
      ? req.actor.memberships.find((item) => item.companyId === companyId)
      : null;
    if (!membership || membership.status !== "active") {
      throw forbidden("User does not have active company access");
    }
    if (!membership.membershipRole || membership.membershipRole === "viewer") {
      throw forbidden("Viewer access is read-only");
    }
  }

  router.get("/companies/:companyId/tools/gallery", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const googleSheetsAvailability = googleSheetsRobotEmailFromEnv();
    res.json({
      apps: TOOL_APP_GALLERY.map((entry) =>
        entry.key === "google-sheets"
          ? {
              ...entry,
              availability: googleSheetsAvailability.available
                ? { available: true, robotEmail: googleSheetsAvailability.robotEmail }
                : { available: false, reason: googleSheetsAvailability.reason },
            }
          : entry,
      ),
    });
  });

  router.post("/companies/:companyId/tools/apps/connect", validate(connectToolAppSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    try {
      const result = await svc.connectGalleryApp(companyId, req.body, getActorInfo(req));
      if (result.auth?.kind === "oauth") {
        const start = await svc.startOAuth(companyId, result.connectionId, {
          redirectUri: oauthRedirectUri(req),
          actor: getActorInfo(req),
        });
        result.auth.startUrl = start.authorizationUrl;
      }
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_app.connected",
        entityType: "tool_connection",
        entityId: result.connectionId,
        details: {
          galleryKey: req.body.galleryKey ?? null,
          link: req.body.link ?? null,
          applicationId: result.application.id,
          catalogEntryCount: result.catalog.length,
          readOnlyActionCount: result.actions.readOnly.length,
          canMakeChangesActionCount: result.actions.canMakeChanges.length,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.post("/tools/oauth/:connectionId/start", async (req, res) => {
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertToolAppMutationAccess(req, existing.companyId);
    const result = await svc.startOAuth(existing.companyId, existing.id, {
      redirectUri: oauthRedirectUri(req),
      actor: getActorInfo(req),
    });
    res.json(result);
  });

  router.get("/tools/oauth/callback", async (req, res) => {
    assertBoard(req);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const error = typeof req.query.error === "string" ? req.query.error : null;
    const errorDescription = typeof req.query.error_description === "string" ? req.query.error_description : null;
    const pendingState = state ? await svc.peekOAuthState(state) : null;
    if (pendingState) {
      assertToolAppMutationAccess(req, pendingState.companyId);
    }
    const result = await svc.completeOAuthCallback({
      state,
      code,
      error,
      errorDescription,
      redirectUri: oauthRedirectUri(req),
      actor: getActorInfo(req),
    });
    await logActivity(db, {
      companyId: result.connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_app.oauth_connected",
      entityType: "tool_connection",
      entityId: result.connection.id,
      details: {
        applicationId: result.application.id,
        catalogEntryCount: result.catalog.length,
      },
    });
    res.json(result);
  });

  router.post("/companies/:companyId/tools/apps/:connectionId/finish", validate(finishToolAppSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertToolAppMutationAccess(req, companyId);
    const existing = await svc.getConnection(req.params.connectionId as string, companyId);
    const result = await svc.finishGalleryAppConnection(companyId, existing.id, req.body, getActorInfo(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_app.finished",
      entityType: "tool_connection",
      entityId: result.connection.id,
      details: {
        profileId: result.profile.id,
        profileEntryCount: result.profileEntries.length,
        profileBindingCount: result.profileBindings.length,
        askFirstPolicyCount: result.policies.length,
        access: req.body.access,
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/tools/examples", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ examples: await svc.listExamples(companyId) });
  });

  router.get("/companies/:companyId/tools/apps/attention", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listAppsNeedingAttention(companyId));
  });

  router.get("/companies/:companyId/tools/action-requests", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const statusRaw = typeof req.query.status === "string" ? req.query.status : "pending";
    const status = (TOOL_ACTION_REQUEST_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as (typeof TOOL_ACTION_REQUEST_STATUSES)[number])
      : "pending";
    res.json({ actionRequests: await svc.listActionRequests(companyId, status) });
  });

  router.post("/companies/:companyId/tools/examples/:id/install", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.installExample(companyId, req.params.id as string, getActorInfo(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_example.installed",
      entityType: "tool_example",
      entityId: result.example.id,
      details: {
        created: result.created,
        applicationId: result.application.id,
        connectionId: result.connection.id,
        profileId: result.profile.id,
        profileEntryCount: result.profileEntries.length,
      },
    });
    res.status(result.created ? 201 : 200).json(result);
  });

  router.post("/companies/:companyId/tools/examples/:id/smoke", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.smokeExample(companyId, req.params.id as string, getActorInfo(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_example.smoke_run",
      entityType: "tool_example",
      entityId: result.exampleId,
      details: {
        ok: result.ok,
        actor: result.actor,
        connectionId: result.connection.id,
        profileId: result.profile.id,
        checks: result.checks.map((check) => ({
          name: check.name,
          ok: check.ok,
          toolName: check.toolName ?? null,
          decision: check.decision ?? null,
          reasonCode: check.reasonCode ?? null,
        })),
      },
    });
    res.json(result);
  });

  router.get("/companies/:companyId/tools/applications", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ applications: await svc.listApplications(companyId) });
  });

  router.post("/companies/:companyId/tools/applications", validate(createToolApplicationSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const application = await svc.createApplication(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_application.created",
        entityType: "tool_application",
        entityId: application.id,
        details: { type: application.type, name: application.name },
      });
      res.status(201).json(application);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.patch("/tool-applications/:applicationId", validate(updateToolApplicationSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getApplication(req.params.applicationId as string);
    assertCompanyAccess(req, existing.companyId);
    try {
      const application = await svc.updateApplication(existing.id, req.body);
      await logActivity(db, {
        companyId: application.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_application.updated",
        entityType: "tool_application",
        entityId: application.id,
        details: { status: application.status, name: application.name },
      });
      res.json(application);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.delete("/tool-applications/:applicationId", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getApplication(req.params.applicationId as string);
    assertCompanyAccess(req, existing.companyId);
    const application = await svc.deleteApplication(existing.id);
    await logActivity(db, {
      companyId: application.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_application.deleted",
      entityType: "tool_application",
      entityId: application.id,
      details: { type: application.type, name: application.name },
    });
    res.json(application);
  });

  router.get("/companies/:companyId/tools/connections", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ connections: await svc.listConnections(companyId) });
  });

  router.post("/companies/:companyId/tools/connections", validate(createToolConnectionSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const connection = await svc.createConnection(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_connection.created",
        entityType: "tool_connection",
        entityId: connection.id,
        details: {
          transport: connection.transport,
          status: connection.status,
          enabled: connection.enabled,
          credentialRefCount: (connection.credentialRefs ?? []).length + connection.credentialSecretRefs.length,
        },
      });
      res.status(201).json(connection);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.get("/tool-connections/:connectionId", async (req, res) => {
    assertBoard(req);
    const connection = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, connection.companyId);
    res.json(connection);
  });

  router.get("/tool-connections/:connectionId/test-agents", async (req, res) => {
    assertBoard(req);
    if (!options.toolGateway) {
      res.status(501).json({ error: "Tool gateway service is not configured" });
      return;
    }
    const connection = await svc.getConnection(req.params.connectionId as string);
    await assertBoardAnyToolPermission(req, connection.companyId, ["tools:use", "tools:manage_connections"]);
    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, connection.companyId));
    const candidates = [];
    for (const agent of rows) {
      try {
        await assertCanTestAsAgent(req, connection.companyId, agent.id);
      } catch {
        continue;
      }
      candidates.push({
        ...agent,
        effectiveAccess: await options.toolGateway.summarizeConnectionAccessForAgent({
          companyId: connection.companyId,
          connectionId: connection.id,
          agentId: agent.id,
        }),
      });
    }
    res.json({ agents: candidates });
  });

  router.post("/tool-connections/:connectionId/test-calls", validate(toolConnectionTestCallSchema), async (req, res) => {
    assertBoard(req);
    if (!options.toolGateway) {
      res.status(501).json({ error: "Tool gateway service is not configured" });
      return;
    }
    const connection = await svc.getConnection(req.params.connectionId as string);
    await assertBoardAnyToolPermission(req, connection.companyId, ["tools:use", "tools:manage_connections"]);
    await assertCanTestAsAgent(req, connection.companyId, req.body.agentId);
    try {
      const result = await options.toolGateway.executeTestCall({
        companyId: connection.companyId,
        connectionId: connection.id,
        agentId: req.body.agentId,
        userId: req.actor.userId ?? "board",
        toolName: req.body.toolName,
        parameters: req.body.parameters ?? {},
      });
      res.json(result);
    } catch (error) {
      if (!sendToolGatewayError(res, error)) throw error;
    }
  });

  router.get("/tool-connections/:connectionId/test-calls/:actionRequestId", async (req, res) => {
    assertBoard(req);
    if (!options.toolGateway) {
      res.status(501).json({ error: "Tool gateway service is not configured" });
      return;
    }
    const connection = await svc.getConnection(req.params.connectionId as string);
    await assertBoardAnyToolPermission(req, connection.companyId, ["tools:use", "tools:manage_connections"]);
    try {
      const status = await options.toolGateway.getTestCallStatus({
        companyId: connection.companyId,
        connectionId: connection.id,
        actionRequestId: req.params.actionRequestId as string,
      });
      res.json(status);
    } catch (error) {
      if (!sendToolGatewayError(res, error)) throw error;
    }
  });

  router.patch("/tool-connections/:connectionId", validate(updateToolConnectionSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    const connection = await svc.updateConnection(existing.id, req.body);
    const lifecycleChanges = classifyConnectionUpdate(
      { enabled: existing.enabled, config: existing.config },
      { enabled: connection.enabled, config: connection.config },
    );
    const baseLog = {
      companyId: connection.companyId,
      actorType: "user" as const,
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.updated",
      entityType: "tool_connection",
      entityId: connection.id,
    };
    if (lifecycleChanges.length === 0) {
      await logActivity(db, {
        ...baseLog,
        details: {
          status: connection.status,
          enabled: connection.enabled,
          credentialRefCount: (connection.credentialRefs ?? []).length + connection.credentialSecretRefs.length,
        },
      });
    } else {
      // One activity row per lifecycle change so the Activity tab renders one
      // humanized row each (PAP-11284), e.g. a combined pause + allowlist edit.
      for (const change of lifecycleChanges) {
        await logActivity(db, {
          ...baseLog,
          details: {
            status: connection.status,
            enabled: connection.enabled,
            lifecycle: change.lifecycle,
            ...change.details,
          },
        });
      }
    }
    res.json(connection);
  });

  router.delete("/tool-connections/:connectionId", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    const applicationBefore = await svc.getApplication(existing.applicationId);
    const connection = await svc.archiveConnection(existing.id);
    const applicationAfter = await svc.getApplication(existing.applicationId);
    await logActivity(db, {
      companyId: connection.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.archived",
      entityType: "tool_connection",
      entityId: connection.id,
      details: { transport: connection.transport },
    });
    if (applicationBefore.status !== "archived" && applicationAfter.status === "archived") {
      await logActivity(db, {
        companyId: applicationAfter.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_application.archived",
        entityType: "tool_application",
        entityId: applicationAfter.id,
        details: { type: applicationAfter.type, name: applicationAfter.name, reason: "last_connection_removed" },
      });
    }
    res.json(connection);
  });

  router.post("/tool-connections/:connectionId/health-check", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    res.json(await svc.checkHealth(existing.id, getActorInfo(req)));
  });

  router.post(
    "/tool-connections/:connectionId/reconnect",
    validate(reconnectToolAppSchema),
    async (req, res) => {
      assertBoard(req);
      const existing = await svc.getConnection(req.params.connectionId as string);
      assertCompanyAccess(req, existing.companyId);
      const result = await svc.reconnectGalleryApp(
        existing.id,
        existing.companyId,
        req.body,
        getActorInfo(req),
      );
      await logActivity(db, {
        companyId: existing.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_app.reconnected",
        entityType: "tool_connection",
        entityId: existing.id,
        details: { healthStatus: result.connection.healthStatus },
      });
      res.json(result);
    },
  );

  router.post("/tool-connections/:connectionId/catalog/refresh", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    res.json(await svc.refreshCatalog(existing.id, getActorInfo(req)));
  });

  router.get("/tool-connections/:connectionId/catalog", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    res.json({ catalog: await svc.listCatalog(existing.id, existing.companyId) });
  });

  router.get("/tool-connections/:connectionId/activity", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getConnection(req.params.connectionId as string);
    assertCompanyAccess(req, existing.companyId);
    const limitRaw = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 20;
    res.json(await svc.listConnectionActivity(existing.id, existing.companyId, limit));
  });

  router.get("/companies/:companyId/tools/profiles", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ profiles: await svc.listProfiles(companyId) });
  });

  router.get("/tool-profiles/:profileId/new-tools", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfile(req.params.profileId as string);
    assertCompanyAccess(req, existing.companyId);
    res.json(await svc.listProfileNewTools(existing.id, existing.companyId));
  });

  router.post("/companies/:companyId/tools/profiles", validate(createToolProfileWithEntriesSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const profile = await svc.createProfile(companyId, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile.created",
        entityType: "tool_profile",
        entityId: profile.id,
        details: { name: profile.name, entryCount: profile.entries.length },
      });
      res.status(201).json(profile);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.get("/companies/:companyId/tools/profiles/effective/agents/:agentId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getEffectiveProfilesForAgent(companyId, req.params.agentId as string));
  });

  router.patch("/tool-profiles/:profileId", validate(updateToolProfileWithEntriesSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfile(req.params.profileId as string);
    assertCompanyAccess(req, existing.companyId);
    try {
      const profile = await svc.updateProfile(existing.id, req.body);
      await logActivity(db, {
        companyId: profile.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile.updated",
        entityType: "tool_profile",
        entityId: profile.id,
        details: { status: profile.status, entryCount: profile.entries.length },
      });
      res.json(profile);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.post("/tool-profiles/:profileId/duplicate", validate(duplicateToolProfileSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfile(req.params.profileId as string);
    assertCompanyAccess(req, existing.companyId);
    try {
      const profile = await svc.duplicateProfile(existing.id, req.body);
      await logActivity(db, {
        companyId: profile.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile.duplicated",
        entityType: "tool_profile",
        entityId: profile.id,
        details: {
          sourceProfileId: existing.id,
          name: profile.name,
          entryCount: profile.entries.length,
          assignmentCount: profile.summary.assignmentCount,
        },
      });
      res.status(201).json(profile);
    } catch (error) {
      svc.ensureNoDuplicateNameError(error);
    }
  });

  router.delete("/tool-profiles/:profileId", validate(deleteToolProfileSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfile(req.params.profileId as string);
    assertCompanyAccess(req, existing.companyId);
    const result = await svc.deleteProfile(existing.id, req.body);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile.deleted",
      entityType: "tool_profile",
      entityId: existing.id,
      details: {
        name: existing.name,
        summary: result.summary,
        reassignedToProfileId: result.reassignedToProfileId,
        reassignedBindingCount: result.reassignedBindingCount,
      },
    });
    res.json(result);
  });

  router.post("/tool-profiles/:profileId/new-tools/review", validate(reviewToolProfileNewToolsSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfile(req.params.profileId as string);
    assertCompanyAccess(req, existing.companyId);
    const result = await svc.reviewProfileNewTools(existing.id, req.body, getActorInfo(req));
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile.new_tools_reviewed",
      entityType: "tool_profile",
      entityId: existing.id,
      details: {
        allowedCount: result.allowedCount,
        keptBlockedCount: result.keptBlockedCount,
        reviewedCatalogEntryIds: result.reviewedCatalogEntryIds,
      },
    });
    res.json(result);
  });

  router.post("/tool-profiles/:profileId/entries", validate(createToolProfileEntryForProfileSchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfile(req.params.profileId as string);
    assertCompanyAccess(req, existing.companyId);
    const entry = await svc.addProfileEntry(existing.id, req.body);
    await logActivity(db, {
      companyId: entry.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile_entry.created",
      entityType: "tool_profile_entry",
      entityId: entry.id,
      details: { profileId: entry.profileId, selectorType: entry.selectorType, effect: entry.effect },
    });
    res.status(201).json(entry);
  });

  router.patch("/tool-profile-entries/:entryId", validate(updateToolProfileEntrySchema), async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfileEntry(req.params.entryId as string);
    assertCompanyAccess(req, existing.companyId);
    const entry = await svc.updateProfileEntry(existing.id, req.body);
    await logActivity(db, {
      companyId: entry.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile_entry.updated",
      entityType: "tool_profile_entry",
      entityId: entry.id,
      details: { profileId: entry.profileId, selectorType: entry.selectorType, effect: entry.effect },
    });
    res.json(entry);
  });

  router.delete("/tool-profile-entries/:entryId", async (req, res) => {
    assertBoard(req);
    const existing = await svc.getProfileEntry(req.params.entryId as string);
    assertCompanyAccess(req, existing.companyId);
    const entry = await svc.deleteProfileEntry(existing.id);
    await logActivity(db, {
      companyId: entry.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_profile_entry.deleted",
      entityType: "tool_profile_entry",
      entityId: entry.id,
      details: { profileId: entry.profileId },
    });
    res.json(entry);
  });

  router.post(
    "/companies/:companyId/tools/profiles/:profileId/bind",
    validate(createToolProfileBindingForProfileSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const existing = await svc.getProfile(req.params.profileId as string, companyId);
      try {
        const binding = await svc.bindProfile(existing.id, req.body, getActorInfo(req));
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action: "tool_profile_binding.created",
          entityType: "tool_profile_binding",
          entityId: binding.id,
          details: { profileId: binding.profileId, targetType: binding.targetType, targetId: binding.targetId },
        });
        res.status(201).json(binding);
      } catch (error) {
        svc.ensureNoDuplicateNameError(error);
      }
    },
  );

  router.post(
    "/companies/:companyId/tools/profiles/:profileId/unbind",
    validate(unbindToolProfileBindingSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const existing = await svc.getProfile(req.params.profileId as string, companyId);
      const result = await svc.unbindProfile(existing.id, req.body);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_profile_binding.deleted",
        entityType: "tool_profile",
        entityId: existing.id,
        details: { targetType: req.body.targetType, targetId: req.body.targetId, unbound: result.unbound },
      });
      res.json(result);
    },
  );

  router.get("/companies/:companyId/tools/runtime-slots", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertToolsRuntimeManage(req, companyId);
    res.json({ runtimeSlots: await svc.listRuntimeSlots(companyId) });
  });

  router.post("/companies/:companyId/tools/runtime-slots/:id/stop", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertToolsRuntimeManage(req, companyId);
    res.json(await svc.stopRuntimeSlot(companyId, req.params.id as string, getActorInfo(req)));
  });

  router.post("/companies/:companyId/tools/runtime-slots/:id/restart", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertToolsRuntimeManage(req, companyId);
    res.json(await svc.restartRuntimeSlot(companyId, req.params.id as string, getActorInfo(req)));
  });

  router.get("/companies/:companyId/tools/runtime-health", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getRuntimeHealth(companyId));
  });

  router.get("/companies/:companyId/tools/runs/:runId/decisions", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getRunDecisionLookup(companyId, req.params.runId as string));
  });

  router.get("/companies/:companyId/tools/trust-rules", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ trustRules: await policySvc.listTrustRules(companyId) });
  });

  router.get("/companies/:companyId/tools/policies", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json({ policies: await policySvc.listPolicies(companyId) });
  });

  // Rules UI sentence slots map exactly onto policy selectors:
  // capability -> riskLevel, app -> applicationId, actions -> toolNames.
  router.post("/companies/:companyId/tools/policies/reorder", validate(reorderToolPoliciesSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const policies = await policySvc.reorderPolicies(companyId, req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_policy.reordered",
      entityType: "tool_policy",
      entityId: companyId,
      details: {
        policyIds: req.body.policyIds,
        priorityStep: 100,
      },
    });
    res.json({ policies });
  });

  router.post("/companies/:companyId/tools/policies", validate(createToolPolicySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const policy = await policySvc.createPolicy(companyId, req.body, { userId: req.actor.userId ?? null });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_policy.created",
        entityType: "tool_policy",
        entityId: policy.id,
        details: { name: policy.name, policyType: policy.policyType, priority: policy.priority },
      });
      res.status(201).json(policy);
    } catch (error) {
      policySvc.ensureNoDuplicatePolicyNameError(error);
    }
  });

  router.post("/companies/:companyId/tools/policies/:policyId/duplicate", validate(duplicateToolPolicySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const policy = await policySvc.duplicatePolicy({
        companyId,
        policyId: req.params.policyId as string,
        body: req.body,
        actor: { userId: req.actor.userId ?? null },
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_policy.duplicated",
        entityType: "tool_policy",
        entityId: policy.id,
        details: {
          sourcePolicyId: req.params.policyId,
          name: policy.name,
          enabled: policy.enabled,
          priority: policy.priority,
        },
      });
      res.status(201).json(policy);
    } catch (error) {
      policySvc.ensureNoDuplicatePolicyNameError(error);
    }
  });

  router.patch("/companies/:companyId/tools/policies/:policyId", validate(updateToolPolicySchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const policy = await policySvc.updatePolicy({
        companyId,
        policyId: req.params.policyId as string,
        body: req.body,
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_policy.updated",
        entityType: "tool_policy",
        entityId: policy.id,
        details: { name: policy.name, policyType: policy.policyType, enabled: policy.enabled, priority: policy.priority },
      });
      res.json(policy);
    } catch (error) {
      policySvc.ensureNoDuplicatePolicyNameError(error);
    }
  });

  router.delete("/companies/:companyId/tools/policies/:policyId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const policy = await policySvc.deletePolicy({
      companyId,
      policyId: req.params.policyId as string,
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_policy.deleted",
      entityType: "tool_policy",
      entityId: policy.id,
      details: { name: policy.name, policyType: policy.policyType },
    });
    res.json(policy);
  });

  router.post(
    "/companies/:companyId/tools/action-requests/:actionRequestId/trust-rule",
    validate(createToolTrustRuleFromActionRequestSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const policy = await policySvc.createTrustRuleFromActionRequest({
        companyId,
        actionRequestId: req.params.actionRequestId as string,
        body: req.body,
        actor: { userId: req.actor.userId ?? null },
      });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_trust_rule.created",
        entityType: "tool_policy",
        entityId: policy.id,
        details: {
          name: policy.name,
          selectors: policy.selectors,
          sourceActionRequestId: req.params.actionRequestId,
        },
      });
      res.status(201).json(policy);
    },
  );

  router.post("/companies/:companyId/tools/trust-rules/:policyId/revoke", validate(revokeToolTrustRuleSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const policy = await policySvc.revokeTrustRule({
      companyId,
      policyId: req.params.policyId as string,
      body: req.body,
      actor: { userId: req.actor.userId ?? null },
    });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_trust_rule.revoked",
      entityType: "tool_policy",
      entityId: policy.id,
      details: { reason: req.body.reason ?? null },
    });
    res.json(policy);
  });

  router.get("/companies/:companyId/tools/stdio-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertToolsAdmin(req, companyId);
    res.json({ templates: await svc.approvedStdioTemplates(companyId) });
  });

  router.post("/companies/:companyId/tools/stdio-templates", validate(createToolStdioCommandTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertToolsAdmin(req, companyId);
    const template = await svc.createStdioCommandTemplate(companyId, req.body, getActorInfo(req));
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_stdio_command_template.created",
      entityType: "tool_stdio_command_template",
      entityId: template.id ?? template.templateId,
      details: {
        templateId: template.templateId,
        command: template.command,
        argCount: template.args.length,
        envKeyCount: template.envKeys.length,
        toolCount: template.tools.length,
      },
    });
    res.status(201).json(template);
  });

  router.post(
    "/companies/:companyId/tools/stdio-templates/:templateId/disable",
    validate(disableToolStdioCommandTemplateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertToolsAdmin(req, companyId);
      const template = await svc.disableStdioCommandTemplate(companyId, req.params.templateId as string);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "tool_stdio_command_template.disabled",
        entityType: "tool_stdio_command_template",
        entityId: template.id ?? template.templateId,
        details: { templateId: template.templateId, reason: req.body.reason ?? null },
      });
      res.json(template);
    },
  );

  router.post("/companies/:companyId/tools/mcp/import-json", validate(importMcpJsonSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const preview = await svc.previewMcpJsonImport(req.body);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "tool_connection.import_mcp_json_previewed",
      entityType: "tool_connection_import",
      entityId: companyId,
      details: { draftCount: preview.drafts.length },
    });
    res.json(preview);
  });

  router.post("/companies/:companyId/tools/policy/test", validate(toolPolicyTestRequestSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const input = { ...req.body, companyId };
    const decision = await policySvc.decide(input);
    let auditEvent = null;
    if (input.writeAuditEvent === true) {
      auditEvent = await policySvc.writeAudit(input, decision);
    }
    res.json({ decision, auditEvent });
  });

  return router;
}
