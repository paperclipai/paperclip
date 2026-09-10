import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues, projects, projectWorkspaces, activityLog, issueComments, assets, goals, approvals, documents, issueRelations, issueThreadInteractions, connectionIntentDeliveries, toolApplications, toolConnections, toolConnectionInstalls, connectionGrants, toolCatalogEntries, toolProfiles, toolProfileBindings } from "@paperclipai/db";
import { documentService } from "../../services/documents.js";
import { connectionIntentService } from "../../services/connection-intents.js";
import { initializeRunIdentity } from "../../services/run-identity.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { createApp } from "../../app.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { setupRunnerPrpWebSocketServer, runnerPrpWebSocketInternals } from "../../realtime/runner-prp-ws.js";
import { PaperclipRunnerToolAuthority } from "../../services/native-runtime/paperclip-runner-tool-authority.js";

export type RunnerConnectionScenario = "fresh" | "pending" | "declined" | "custom" | "foreign" | "stale_owner" | "ready";
const CONNECTION_SCENARIOS: readonly RunnerConnectionScenario[] = ["fresh", "pending", "declined", "custom", "foreign", "stale_owner", "ready"];

/** Disposable real routes, database and storage. A fresh company isolates each attempt. */
export async function startRunnerApiTestServer() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-api-eval-"));
  const temporary = await startEmbeddedPostgresTestDatabase("paperclip-api-eval-db-");
  const db = createDb(temporary.connectionString);
  const storage = createStorageService(createLocalDiskStorageProvider(join(root, "storage")));
  const app = await createApp(db, {
    uiMode: "none", serverPort: 0, storageService: storage,
    deploymentMode: "authenticated", deploymentExposure: "private",
    allowedHostnames: ["127.0.0.1"], bindHost: "127.0.0.1", authReady: true,
    companyDeletionEnabled: false, instanceId: `eval-${randomUUID()}`,
    localPluginDir: join(root, "plugins"), managedPluginAutoInstall: [],
    decisionServiceOptions: { wakeOriginAgent: async () => undefined },
  });
  const http = createServer(app);
  const sockets = new Set<import("node:net").Socket>();
  http.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing eval listener");
  const apiUrl = `http://127.0.0.1:${address.port}`;
  setupRunnerPrpWebSocketServer(http, { apiUrl });
  return {
    db, root, apiUrl, storage,
    async fixture(options: { mode?: "standard" | "ask" | "planning"; apiToolsEnabled?: boolean; reset?: boolean; connectionScenario?: RunnerConnectionScenario } = {}) {
      if (options.connectionScenario !== undefined && !CONNECTION_SCENARIOS.includes(options.connectionScenario)) throw new Error(`Unknown connection eval scenario: ${String(options.connectionScenario)}`);
      // This DB is created inside this helper, never supplied by a caller. Paid
      // paired runs reset it between attempts so modeled IDs and data match.
      if (options.reset) await db.execute(sql`TRUNCATE companies CASCADE`);
      const id = (key: string) => {
        if (!options.reset) return randomUUID();
        const hex = createHash("sha256").update(`runner-api-fixture:${key}`).digest("hex");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      };
      const companyId = id("company"), agentId = id("agent"), issueId = id("issue"), runId = id("run"), projectId = id("project");
      const foreignCompanyId = id("foreign-company"), foreignProjectId = id("foreign-project");
      const projectWorkspaceId = id("workspace"), artifactId = id("artifact"), binaryArtifactId = id("binary-artifact"), goalId = id("goal");
      const blockerId = id("blocker"), approvalId = id("approval");
      const responsibleUserId = options.connectionScenario ? id("responsible-user") : null;
      const workspace = await mkdtemp(join(root, "workspace-"));
      await writeFile(join(workspace, "sample.txt"), "API escape hatch fixture\n");
      await db.insert(companies).values([
        { id: companyId, name: "API eval", issueCounter: 2, issuePrefix: "E" + companyId.replaceAll("-", "").slice(0, 8) },
        { id: foreignCompanyId, name: "Isolated foreign company", issuePrefix: "O" + foreignCompanyId.replaceAll("-", "").slice(0, 8) },
      ]);
      if (responsibleUserId) {
        await db.insert(authUsers).values({ id: responsibleUserId, name: "Eval responsible user", email: `${responsibleUserId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
        await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: responsibleUserId, status: "active", membershipRole: "member" });
      }
      await db.insert(agents).values({ id: agentId, companyId, name: "API eval agent", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", cwd: workspace }, runtimeConfig: { heartbeat: { enabled: false } }, status: "active" });
      await db.insert(projects).values([
        { id: projectId, companyId, name: "Aurora", description: "The project verification code is violet-otter.", status: "in_progress" },
        { id: foreignProjectId, companyId: foreignCompanyId, name: "Private project", description: "foreign-data-must-not-leak" },
      ]);
      await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Fixture workspace", cwd: workspace, isPrimary: true });
      await db.insert(goals).values({ id: goalId, companyId, title: "Ship Aurora", level: "company", status: "active" });
      for (const [id, body, contentType, filename] of [[artifactId, Buffer.from("API escape hatch fixture\n"), "text/plain", "sample.txt"], [binaryArtifactId, Buffer.alloc(32_000, 65), "application/octet-stream", "large.bin"]] as const) {
        const saved = await storage.putFile({ companyId, namespace: "eval", originalFilename: filename, contentType, body });
        await db.insert(assets).values({ id, companyId, ...saved, createdByAgentId: agentId });
      }
      await db.insert(issues).values({ id: issueId, companyId, projectId, projectWorkspaceId, issueNumber: 1, identifier: "E" + companyId.replaceAll("-", "").slice(0, 8) + "-1", title: "Verify runner API tools", description: "Fixture marker: amber-fox.", status: "in_progress", workMode: options.mode ?? "standard", assigneeAgentId: agentId });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId, runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      if (responsibleUserId) await initializeRunIdentity(db, { companyId, runId, issueId, responsibleUserId, cause: "instruction" });
      await db.insert(issues).values({ id: blockerId, companyId, projectId, issueNumber: 2, identifier: "E" + companyId.replaceAll("-", "").slice(0, 8) + "-2", title: "Dependency gate", description: "Complete before shipping.", status: "todo", assigneeAgentId: agentId });
      await db.insert(approvals).values({ id: approvalId, companyId, type: "runner_review", status: "pending", requestedByAgentId: agentId, payload: { title: "Launch review" } });
      await documentService(db).upsertIssueDocument({ issueId, key: "notes", title: "Fixture notes", format: "markdown", body: "Document verification code: silver-wren.", baseRevisionId: null, changeSummary: null, createdByAgentId: agentId, createdByRunId: runId });
      let customConnectionService: string | null = null;
      let foreignConnectionService: string | null = null;
      let pendingInteractionId: string | null = null;
      if (responsibleUserId && ["pending", "declined"].includes(options.connectionScenario!)) {
        // Explicit prior-run state, not a model-generated interaction. Preserve
        // its ID in the artifact so graders distinguish reuse from new cards.
        const previousRunId = id("previous-run");
        await db.insert(heartbeatRuns).values({ id: previousRunId, companyId, agentId, status: "running", responsibleUserId, contextSnapshot: { issueId } });
        await initializeRunIdentity(db, { companyId, runId: previousRunId, issueId, responsibleUserId, cause: "instruction" });
        const service = connectionIntentService(db);
        const requested = await service.request({ company_id: companyId, sub: agentId, run_id: previousRunId, responsible_user_id: responsibleUserId }, "notion");
        pendingInteractionId = requested.interactionId!;
        if (options.connectionScenario === "declined") {
          await service.decline(pendingInteractionId, responsibleUserId);
          await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, interactionId: pendingInteractionId, interactionKind: "connection_intent", interactionStatus: "rejected" } }).where(eq(heartbeatRuns.id, runId));
        }
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, previousRunId));
      }
      if (responsibleUserId && ["custom", "foreign", "ready"].includes(options.connectionScenario!)) {
        const foreign = options.connectionScenario === "foreign";
        const ready = options.connectionScenario === "ready";
        const targetCompanyId = foreign ? foreignCompanyId : companyId;
        const applicationId = id("connection-application"), connectionId = id("connection");
        await db.insert(toolApplications).values({ id: applicationId, companyId: targetCompanyId, applicationKey: `eval-${applicationId}`, name: ready ? "Notion" : "Research archive", type: "mcp_http", status: "active", metadata: ready ? { sourceTemplateKey: "notion" } : {} });
        await db.insert(toolConnections).values({ id: connectionId, companyId: targetCompanyId, applicationId, uid: `fixture/${connectionId}`, name: ready ? "Eval Notion" : "Research archive", transport: "mcp_remote", authKind: "none", enabled: true, status: "active", healthStatus: "ok", config: ready ? { sourceTemplateKey: "notion" } : {}, transportConfig: { url: "http://127.0.0.1:1/fixture-mcp" } });
        await db.insert(connectionGrants).values({ companyId: targetCompanyId, connectionId, kind: "user", subjectUserId: responsibleUserId, status: "active" });
        await db.insert(toolCatalogEntries).values({ companyId: targetCompanyId, connectionId, toolName: ready ? "notion_read" : "archive_read", name: ready ? "Read Notion page" : "Archive read", description: foreign ? "foreign-data-must-not-leak heliotrope archive" : "Read the unique heliotrope launch decision", versionHash: "fixture-v1", status: "active", entryKind: "tool" });
        if (foreign) foreignConnectionService = `connection:${connectionId}`;
        else customConnectionService = `connection:${connectionId}`;
        if (ready) {
          await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: "agent", targetId: agentId, createdByUserId: responsibleUserId });
          const profileId = id("connection-profile");
          await db.insert(toolProfiles).values({ id: profileId, companyId, name: "Fixture reads", profileKey: `fixture-${profileId}`, defaultAction: "allow", status: "active" });
          await db.insert(toolProfileBindings).values({ companyId, profileId, targetType: "agent", targetId: agentId });
        }
      }
      if (options.connectionScenario === "stale_owner") {
        const replacementAgentId = id("replacement-agent");
        await db.insert(agents).values({ id: replacementAgentId, companyId, name: "New task owner", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, runtimeConfig: { heartbeat: { enabled: false } }, status: "active" });
        await db.update(issues).set({ assigneeAgentId: replacementAgentId }).where(eq(issues.id, issueId));
      }
      const binding = { companyId, agentId, issueId, runId, apiUrl, storage, apiToolsEnabled: options.apiToolsEnabled ?? true };
      return {
        ...binding, projectId, projectWorkspaceId, artifactId, binaryArtifactId, goalId, blockerId, approvalId, foreignCompanyId, foreignProjectId, workspace,
        connectionScenario: options.connectionScenario ?? null, responsibleUserId, userId: responsibleUserId, sourceRunId: runId,
        customConnectionService, foreignConnectionService, pendingInteractionId,
        initialInteractionIds: pendingInteractionId ? [pendingInteractionId] : [],
        authority: new PaperclipRunnerToolAuthority(db, binding),
        async snapshot() {
          return {
            issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
            projects: await db.select().from(projects).where(eq(projects.companyId, companyId)),
            activity: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
            comments: await db.select().from(issueComments).where(eq(issueComments.companyId, companyId)),
            assets: await db.select().from(assets).where(eq(assets.companyId, companyId)),
            goals: await db.select().from(goals).where(eq(goals.companyId, companyId)),
            approvals: await db.select().from(approvals).where(eq(approvals.companyId, companyId)),
            documents: await db.select().from(documents).where(eq(documents.companyId, companyId)),
            issueRelations: await db.select().from(issueRelations).where(eq(issueRelations.companyId, companyId)),
            connectionInteractions: await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId)),
            connectionIntentDeliveries: await db.select({ interactionId: connectionIntentDeliveries.interactionId, companyId: connectionIntentDeliveries.companyId, deliveredAt: connectionIntentDeliveries.deliveredAt }).from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.companyId, companyId)),
            connections: await db.select({ id: toolConnections.id, companyId: toolConnections.companyId, name: toolConnections.name, transport: toolConnections.transport, authKind: toolConnections.authKind, enabled: toolConnections.enabled, status: toolConnections.status, healthStatus: toolConnections.healthStatus }).from(toolConnections).where(eq(toolConnections.companyId, companyId)),
            installs: await db.select({ connectionId: toolConnectionInstalls.connectionId, targetType: toolConnectionInstalls.targetType, targetId: toolConnectionInstalls.targetId }).from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId)),
            grants: await db.select({ connectionId: connectionGrants.connectionId, kind: connectionGrants.kind, subjectUserId: connectionGrants.subjectUserId, subjectAgentId: connectionGrants.subjectAgentId, status: connectionGrants.status }).from(connectionGrants).where(eq(connectionGrants.companyId, companyId)),
          };
        },
      };
    },
    async close() {
      runnerPrpWebSocketInternals.resetForTests();
      await app.locals.paperclipShutdown();
      for (const socket of sockets) socket.destroy();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await temporary.cleanup();
      await rm(root, { recursive: true, force: true });
    },
  };
}
