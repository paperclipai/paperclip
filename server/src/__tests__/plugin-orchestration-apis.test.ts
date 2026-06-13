import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  costEvents,
  createDb,
  executionWorkspaces,
  issueComments,
  heartbeatRuns,
  issueRelations,
  issues,
  pluginManagedResources,
  plugins,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin orchestration API tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin orchestration APIs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-orchestration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(pluginManagedResources);
    await db.delete(projects);
    await db.delete(plugins);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function makeLocalRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-host-folder-"));
    tempRoots.push(root);
    return root;
  }

  it("returns plugin-safe execution workspace metadata scoped to the company", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const otherCompanyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: issuePrefix(otherCompanyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspaces",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Feature workspace",
      status: "active",
      cwd: "/tmp/paperclip-feature",
      repoUrl: "https://example.com/paperclip.git",
      baseRef: "main",
      branchName: "feature/workspace",
      providerType: "git_worktree",
      providerRef: "/tmp/paperclip-feature",
      metadata: {
        providerMetadata: { sandboxId: "sandbox-1" },
        workspaceRealizationRequest: { hiddenInternal: true },
      },
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.workspace", createEventBusStub());

    await expect(services.executionWorkspaces.get({ workspaceId, companyId })).resolves.toMatchObject({
      id: workspaceId,
      companyId,
      projectId,
      projectWorkspaceId: null,
      path: "/tmp/paperclip-feature",
      cwd: "/tmp/paperclip-feature",
      repoUrl: "https://example.com/paperclip.git",
      baseRef: "main",
      branchName: "feature/workspace",
      providerType: "git_worktree",
      providerMetadata: { sandboxId: "sandbox-1" },
    });
    await expect(services.executionWorkspaces.get({ workspaceId, companyId: otherCompanyId })).resolves.toBeNull();
  });

  it("creates plugin-origin issues with full orchestration fields and audit activity", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerIssueId = randomUUID();
    const originRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: originRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: blockerIssueId },
    });
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Blocker",
      status: "todo",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-blocker`,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const issue = await services.issues.create({
      companyId,
      title: "Plugin child issue",
      status: "todo",
      assigneeAgentId: agentId,
      billingCode: "mission:alpha",
      originId: "mission-alpha",
      originFingerprint: "mission:alpha:fingerprint",
      blockedByIssueIds: [blockerIssueId],
      actorAgentId: agentId,
      actorRunId: originRunId,
    });

    const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(stored?.originKind).toBe("plugin:paperclip.missions");
    expect(stored?.originId).toBe("mission-alpha");
    expect(stored?.originFingerprint).toBe("mission:alpha:fingerprint");
    expect(stored?.billingCode).toBe("mission:alpha");
    expect(stored?.assigneeAgentId).toBe(agentId);
    expect(stored?.createdByAgentId).toBe(agentId);
    expect(stored?.originRunId).toBe(originRunId);

    const [relation] = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.issueId, blockerIssueId), eq(issueRelations.relatedIssueId, issue.id)));
    expect(relation?.type).toBe("blocks");

    const activities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id)));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorType: "plugin",
          actorId: "plugin-record-id",
          action: "issue.created",
          agentId,
          details: expect.objectContaining({
            sourcePluginId: "plugin-record-id",
            sourcePluginKey: "paperclip.missions",
            initiatingActorType: "agent",
            initiatingActorId: agentId,
            initiatingRunId: originRunId,
          }),
        }),
      ]),
    );
  });

  it("deduplicates plugin-created alert issues by origin fingerprint", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const originRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: originRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: {},
    });
    const services = buildHostServices(db, "plugin-record-id", "paperclip.alertmanager", createEventBusStub());
    const originKind = "plugin:paperclip.alertmanager:alert";
    const originFingerprint = "alert:KubePersistentVolumeNearlyFull:namespace=paperclip:persistentvolumeclaim=postgres-data";

    const first = await services.issues.create({
      companyId,
      title: "KubePersistentVolumeNearlyFull firing for postgres-data",
      status: "todo",
      assigneeAgentId: agentId,
      originKind,
      originId: "alertmanager:receiver:gstack",
      originRunId,
      originFingerprint,
      actorAgentId: agentId,
      actorRunId: originRunId,
    });
    const duplicate = await services.issues.create({
      companyId,
      title: "KubePersistentVolumeNearlyFull still firing for postgres-data",
      status: "todo",
      assigneeAgentId: agentId,
      originKind,
      originId: "alertmanager:receiver:gstack",
      originRunId,
      originFingerprint,
      actorAgentId: agentId,
      actorRunId: originRunId,
    });

    expect(duplicate.id).toBe(first.id);
    const alertIssues = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, originKind),
      eq(issues.originFingerprint, originFingerprint),
    ));
    expect(alertIssues).toHaveLength(1);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, first.id));
    expect(comments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        body: expect.stringContaining("Alert deduplicated by origin fingerprint"),
        authorAgentId: agentId,
        createdByRunId: originRunId,
      }),
    ]));

    const activities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, first.id)));
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "issue.deduplicated",
        details: expect.objectContaining({ originKind, originFingerprint }),
      }),
    ]));
  });

  it("keeps distinct plugin-created alert issues for different resource fingerprints", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.alertmanager", createEventBusStub());
    const originKind = "plugin:paperclip.alertmanager:alert";

    const first = await services.issues.create({
      companyId,
      title: "KubePersistentVolumeNearlyFull firing for postgres-data-a",
      status: "todo",
      assigneeAgentId: agentId,
      originKind,
      originFingerprint: "alert:KubePersistentVolumeNearlyFull:pvc=postgres-data-a",
      actorAgentId: agentId,
    });
    const second = await services.issues.create({
      companyId,
      title: "KubePersistentVolumeNearlyFull firing for postgres-data-b",
      status: "todo",
      assigneeAgentId: agentId,
      originKind,
      originFingerprint: "alert:KubePersistentVolumeNearlyFull:pvc=postgres-data-b",
      actorAgentId: agentId,
    });

    expect(second.id).not.toBe(first.id);
    const alertIssues = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, originKind),
    ));
    expect(alertIssues).toHaveLength(2);
  });

  it("derives alert fingerprints from alert labels when plugins omit origin fingerprints", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.alertmanager", createEventBusStub());
    const originKind = "plugin:paperclip.alertmanager:alert";
    const description = [
      "Alert labels:",
      "- alertname: KubePersistentVolumeNearlyFull",
      "- namespace: paperclip",
      "- persistentvolumeclaim: postgres-data",
      "- severity: warning",
    ].join("\n");

    const first = await services.issues.create({
      companyId,
      title: "KubePersistentVolumeNearlyFull firing for postgres-data",
      description,
      status: "todo",
      assigneeAgentId: agentId,
      originKind,
      actorAgentId: agentId,
    });
    const duplicate = await services.issues.create({
      companyId,
      title: "KubePersistentVolumeNearlyFull still firing for postgres-data",
      description,
      status: "todo",
      assigneeAgentId: agentId,
      originKind,
      actorAgentId: agentId,
    });

    expect(duplicate.id).toBe(first.id);
    expect(first.originFingerprint).toBe("alert:kubepersistentvolumenearlyfull:namespace=paperclip:persistentvolumeclaim=postgres-data");
    const alertIssues = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, originKind),
    ));
    expect(alertIssues).toHaveLength(1);
    expect(alertIssues[0]?.originFingerprint).toBe(first.originFingerprint);
  });

  it("derives distinct alert fingerprints for different alert resources", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.alertmanager", createEventBusStub());
    const originKind = "plugin:paperclip.alertmanager:alert";

    const first = await services.issues.create({
      companyId,
      title: "KubePersistentVolumeNearlyFull firing for postgres-data-a",
      description: "alertname=KubePersistentVolumeNearlyFull namespace=paperclip persistentvolumeclaim=postgres-data-a severity=warning",
      status: "todo",
      assigneeAgentId: agentId,
      originKind,
      actorAgentId: agentId,
    });
    const second = await services.issues.create({
      companyId,
      title: "KubePersistentVolumeNearlyFull firing for postgres-data-b",
      description: "alertname=KubePersistentVolumeNearlyFull namespace=paperclip persistentvolumeclaim=postgres-data-b severity=warning",
      status: "todo",
      assigneeAgentId: agentId,
      originKind,
      actorAgentId: agentId,
    });

    expect(second.id).not.toBe(first.id);
    expect(first.originFingerprint).toBe("alert:kubepersistentvolumenearlyfull:namespace=paperclip:persistentvolumeclaim=postgres-data-a");
    expect(second.originFingerprint).toBe("alert:kubepersistentvolumenearlyfull:namespace=paperclip:persistentvolumeclaim=postgres-data-b");
    const alertIssues = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, originKind),
    ));
    expect(alertIssues).toHaveLength(2);
  });

  it("enforces plugin origin namespaces", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const featureIssue = await services.issues.create({
      companyId,
      title: "Feature issue",
      originKind: "plugin:paperclip.missions:feature",
      originId: "mission-alpha:feature-1",
    });
    expect(featureIssue.originKind).toBe("plugin:paperclip.missions:feature");

    await expect(
      services.issues.create({
        companyId,
        title: "Spoofed issue",
        originKind: "plugin:other.plugin:feature",
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.missions");

    await expect(
      services.issues.update({
        issueId: featureIssue.id,
        companyId,
        patch: { originKind: "plugin:other.plugin:feature" },
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.missions");
  });

  it("creates plugin operation issues with the generic operation origin", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const issue = await services.issues.create({
      companyId,
      title: "Background operation",
      surfaceVisibility: "plugin_operation",
      originId: "mission-alpha:operation-1",
    });

    expect(issue.originKind).toBe("plugin:paperclip.missions:operation");
    expect(issue.originId).toBe("mission-alpha:operation-1");
  });

  it("lets bootstrap-style actions initialize required local folders from an empty root", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      packageName: "@paperclipai/plugin-llm-wiki",
      version: "0.1.0",
      manifestJson: {
        id: "paperclipai.plugin-llm-wiki",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "LLM Wiki",
        description: "Local-file LLM Wiki plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        entrypoints: { worker: "./dist/worker.js" },
        localFolders: [
          {
            folderKey: "wiki-root",
            displayName: "Wiki root",
            access: "readWrite",
            requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
            requiredFiles: ["WIKI.md", "AGENTS.md"],
          },
        ],
      },
      status: "ready",
    });
    const root = await makeLocalRoot();
    const services = buildHostServices(
      db,
      pluginId,
      "paperclipai.plugin-llm-wiki",
      createEventBusStub(),
      undefined,
      {
        manifest: {
          id: "paperclipai.plugin-llm-wiki",
          apiVersion: 1,
          version: "0.1.0",
          displayName: "LLM Wiki",
          description: "Local-file LLM Wiki plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["local.folders"],
          entrypoints: { worker: "./dist/worker.js" },
          localFolders: [
            {
              folderKey: "wiki-root",
              displayName: "Wiki root",
              access: "readWrite",
              requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
              requiredFiles: ["WIKI.md", "AGENTS.md"],
            },
          ],
        },
      },
    );

    const configured = await services.localFolders.configure({
      companyId,
      folderKey: "wiki-root",
      path: root,
      access: "readWrite",
      requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
      requiredFiles: ["WIKI.md", "AGENTS.md"],
    });
    expect(configured.healthy).toBe(false);
    expect(configured.missingDirectories).toEqual([]);
    expect(configured.missingFiles).toEqual(["WIKI.md", "AGENTS.md"]);

    await fs.rm(path.join(root, "raw"), { recursive: true, force: true });
    await fs.rm(path.join(root, "wiki"), { recursive: true, force: true });
    await expect(services.localFolders.readText({ companyId, folderKey: "wiki-root", relativePath: "WIKI.md" }))
      .rejects.toThrow("Local folder is not healthy");
    await services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "wiki-root",
      relativePath: "WIKI.md",
      contents: "# Wiki\n",
    });
    await services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "wiki-root",
      relativePath: "AGENTS.md",
      contents: "# Agents\n",
    });

    const finalStatus = await services.localFolders.status({ companyId, folderKey: "wiki-root" });
    expect(finalStatus.healthy).toBe(true);
    await expect(fs.stat(path.join(root, "raw"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(root, "wiki/concepts"))).resolves.toMatchObject({});
    await expect(fs.readFile(path.join(root, "WIKI.md"), "utf8")).resolves.toBe("# Wiki\n");
  });

  it("rejects worker local-folder access for undeclared manifest keys", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.local-folders",
      packageName: "@paperclip/plugin-local-folders",
      version: "0.1.0",
      manifestJson: {
        id: "paperclip.local-folders",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Local Folders",
        description: "Local folder fixture",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        entrypoints: { worker: "./dist/worker.js" },
        localFolders: [
          {
            folderKey: "content-root",
            displayName: "Content root",
            access: "readWrite",
          },
        ],
      },
      status: "ready",
    });
    const services = buildHostServices(
      db,
      pluginId,
      "paperclip.local-folders",
      createEventBusStub(),
      undefined,
      {
        manifest: {
          id: "paperclip.local-folders",
          apiVersion: 1,
          version: "0.1.0",
          displayName: "Local Folders",
          description: "Local folder fixture",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["local.folders"],
          entrypoints: { worker: "./dist/worker.js" },
          localFolders: [
            {
              folderKey: "content-root",
              displayName: "Content root",
              access: "readWrite",
            },
          ],
        },
      },
    );
    await expect(services.localFolders.configure({
      companyId,
      folderKey: "ssh",
      path: "/tmp",
      access: "read",
    })).rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.status({ companyId, folderKey: "ssh" }))
      .rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.readText({ companyId, folderKey: "ssh", relativePath: "id_rsa" }))
      .rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "ssh",
      relativePath: "id_rsa",
      contents: "secret",
    })).rejects.toThrow("Local folder key is not declared");
  });

  it("resolves plugin-managed projects by stable key without overwriting user edits", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.missions",
      packageName: "@paperclip/plugin-missions",
      version: "0.1.0",
      apiVersion: 1,
      categories: ["automation"],
      status: "ready",
      manifestJson: {
        id: "paperclip.missions",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Missions",
        description: "Mission orchestration",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["projects.managed"],
        entrypoints: { worker: "./dist/worker.js" },
        projects: [{
          projectKey: "operations",
          displayName: "Mission Operations",
          description: "Plugin operation inspection area",
          status: "in_progress",
          color: "#14b8a6",
          settings: { surface: "operations" },
        }],
      },
    });

    const services = buildHostServices(db, pluginId, "paperclip.missions", createEventBusStub());
    const missing = await services.projects.getManaged({ companyId, projectKey: "operations" });
    expect(missing.status).toBe("missing");
    expect(missing.projectId).toBeNull();
    await expect(
      db
        .select()
        .from(pluginManagedResources)
        .where(and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, pluginId),
          eq(pluginManagedResources.resourceKind, "project"),
          eq(pluginManagedResources.resourceKey, "operations"),
        )),
    ).resolves.toHaveLength(0);

    const created = await services.projects.reconcileManaged({ companyId, projectKey: "operations" });

    expect(created.status).toBe("created");
    expect(created.projectId).toEqual(expect.any(String));
    expect(created.project?.managedByPlugin).toMatchObject({
      pluginId,
      pluginKey: "paperclip.missions",
      pluginDisplayName: "Missions",
      resourceKind: "project",
      resourceKey: "operations",
    });

    await db
      .update(projects)
      .set({ name: "Renamed by operator", description: "User-owned text", updatedAt: new Date() })
      .where(eq(projects.id, created.projectId!));
    await db
      .update(plugins)
      .set({
        manifestJson: {
          id: "paperclip.missions",
          apiVersion: 1,
          version: "0.2.0",
          displayName: "Missions",
          description: "Mission orchestration",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["projects.managed"],
          entrypoints: { worker: "./dist/worker.js" },
          projects: [{
            projectKey: "operations",
            displayName: "Upgraded Default Name",
            description: "Upgraded default description",
            status: "planned",
            color: "#f97316",
            settings: { surface: "operations", upgraded: true },
          }],
        },
        updatedAt: new Date(),
      })
      .where(eq(plugins.id, pluginId));

    const resolved = await services.projects.reconcileManaged({ companyId, projectKey: "operations" });

    expect(resolved.status).toBe("resolved");
    expect(resolved.projectId).toBe(created.projectId);
    expect(resolved.project?.name).toBe("Renamed by operator");
    expect(resolved.project?.description).toBe("User-owned text");
    expect(resolved.project?.managedByPlugin?.defaultsJson).toMatchObject({
      displayName: "Upgraded Default Name",
      settings: { upgraded: true },
    });
  });

  it("asserts checkout ownership for run-scoped plugin actions", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checked out issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    await expect(
      services.issues.assertCheckoutOwner({
        issueId,
        companyId,
        actorAgentId: agentId,
        actorRunId: runId,
      }),
    ).resolves.toMatchObject({
      issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
    });
  });

  it("refuses plugin wakeups for issues with unresolved blockers", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Unresolved blocker",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    await expect(
      services.issues.requestWakeup({
        issueId: blockedIssueId,
        companyId,
        reason: "mission_advance",
      }),
    ).rejects.toThrow("Issue is blocked by unresolved blockers");
  });

  it("narrows orchestration cost summaries by subtree and billing code", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
      {
        id: unrelatedIssueId,
        companyId,
        title: "Different mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        costCents: 100,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        costCents: 200,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        billingCode: "mission:beta",
        provider: "test",
        model: "unit",
        inputTokens: 30,
        cachedInputTokens: 3,
        outputTokens: 6,
        costCents: 300,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: unrelatedIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 40,
        cachedInputTokens: 4,
        outputTokens: 8,
        costCents: 400,
        occurredAt: new Date(),
      },
    ]);

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const summary = await services.issues.getOrchestrationSummary({
      companyId,
      issueId: rootIssueId,
      includeSubtree: true,
    });

    expect(new Set(summary.subtreeIssueIds)).toEqual(new Set([rootIssueId, childIssueId]));
    expect(summary.costs).toMatchObject({
      billingCode: "mission:alpha",
      costCents: 300,
      inputTokens: 30,
      cachedInputTokens: 3,
      outputTokens: 6,
    });
  });
});
