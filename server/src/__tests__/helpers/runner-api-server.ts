import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, projects, projectWorkspaces, activityLog, issueComments, assets, goals, approvals, documents, issueRelations } from "@paperclipai/db";
import { documentService } from "../../services/documents.js";
import { startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";
import { createApp } from "../../app.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { createStorageService } from "../../storage/service.js";
import { setupRunnerPrpWebSocketServer, runnerPrpWebSocketInternals } from "../../realtime/runner-prp-ws.js";
import { PaperclipRunnerToolAuthority } from "../../services/native-runtime/paperclip-runner-tool-authority.js";

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
    async fixture(options: { mode?: "standard" | "ask" | "planning"; apiToolsEnabled?: boolean; reset?: boolean } = {}) {
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
      const workspace = await mkdtemp(join(root, "workspace-"));
      await writeFile(join(workspace, "sample.txt"), "API escape hatch fixture\n");
      await db.insert(companies).values([
        { id: companyId, name: "API eval", issueCounter: 2, issuePrefix: "E" + companyId.replaceAll("-", "").slice(0, 8) },
        { id: foreignCompanyId, name: "Isolated foreign company", issuePrefix: "O" + foreignCompanyId.replaceAll("-", "").slice(0, 8) },
      ]);
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
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
      await db.insert(issues).values({ id: blockerId, companyId, projectId, issueNumber: 2, identifier: "E" + companyId.replaceAll("-", "").slice(0, 8) + "-2", title: "Dependency gate", description: "Complete before shipping.", status: "todo", assigneeAgentId: agentId });
      await db.insert(approvals).values({ id: approvalId, companyId, type: "runner_review", status: "pending", requestedByAgentId: agentId, payload: { title: "Launch review" } });
      await documentService(db).upsertIssueDocument({ issueId, key: "notes", title: "Fixture notes", format: "markdown", body: "Document verification code: silver-wren.", baseRevisionId: null, changeSummary: null, createdByAgentId: agentId, createdByRunId: runId });
      const binding = { companyId, agentId, issueId, runId, apiUrl, storage, apiToolsEnabled: options.apiToolsEnabled ?? true };
      return {
        ...binding, projectId, projectWorkspaceId, artifactId, binaryArtifactId, goalId, blockerId, approvalId, foreignCompanyId, foreignProjectId, workspace,
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
