import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_USER_ID = "owner-user";
const WEBHOOK_SECRET = { type: "secret_ref", secretId: "33333333-3333-4333-8333-333333333333", version: "latest" } as const;

function activeMember(companyId: string, userId = ACTOR_USER_ID, membershipRole = "owner") {
  return {
    id: `member-${companyId}-${userId}`,
    companyId,
    principalType: "user" as const,
    principalId: userId,
    status: "active" as const,
    membershipRole,
    grants: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function actionOptions(companyId = COMPANY_ID, userId = ACTOR_USER_ID) {
  return {
    companyId,
    actor: { type: "user" as const, userId, companyId },
  };
}

const csv = [
  "external_id,name,email,title,reports_to_external_id,capabilities,responsibilities,mattermost_username,paperclip_user_id,status",
  "exec-1,Asha Patel,asha@example.com,CEO,,strategy|budget,Set direction|Approve budget,asha,,active",
  "eng-1,Diego Ruiz,diego@example.com,Engineer,exec-1,typescript|aws,Build services|Review code,diego,user-123,active",
].join("\n");

describe("human org and work plugin", () => {
  it("declares a roster page, issue task view, and secure outbound capabilities", () => {
    expect(() => pluginManifestV1Schema.parse(manifest)).not.toThrow();
    expect(manifest.capabilities).toEqual(expect.arrayContaining([
      "issues.read",
      "issues.create",
      "issues.update",
      "http.outbound",
      "secrets.read-ref",
      "ui.page.register",
      "ui.detailTab.register",
    ]));
    expect(manifest.ui?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "page", routePath: "human-org" }),
      expect.objectContaining({ type: "taskDetailView", entityTypes: ["issue"] }),
    ]));
    expect(manifest.instanceConfigSchema).toMatchObject({
      properties: {
        mattermostWebhook: { format: "secret-ref" },
      },
    });
  });

  it("imports a validated hierarchy idempotently and exposes it as a tree", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);

    const first = await harness.performAction<{ imported: number }>("import-org-chart", {
      csv,
    }, actionOptions());
    expect(first.imported).toBe(2);

    const second = await harness.performAction<{ imported: number }>("import-org-chart", {
      csv: csv.replace("Engineer", "Senior Engineer"),
    }, actionOptions());
    expect(second.imported).toBe(2);

    const roster = await harness.getData<{
      roots: Array<{ profile: { externalId: string }; children: Array<{ profile: { title: string } }> }>;
      profiles: Array<{ externalId: string }>;
    }>("human-roster", { companyId: COMPANY_ID });

    expect(roster.profiles).toHaveLength(2);
    expect(roster.roots).toEqual([
      expect.objectContaining({
        profile: expect.objectContaining({ externalId: "exec-1" }),
        children: [expect.objectContaining({ profile: expect.objectContaining({ title: "Senior Engineer" }) })],
      }),
    ]);
  });

  it("does not leave a partial roster when atomic import persistence fails", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    const originalUpsert = harness.ctx.entities.upsert.bind(harness.ctx.entities);
    let singleUpserts = 0;
    harness.ctx.entities.upsert = async (input) => {
      singleUpserts += 1;
      if (singleUpserts === 2) throw new Error("simulated second profile failure");
      return originalUpsert(input);
    };
    (harness.ctx.entities as typeof harness.ctx.entities & {
      upsertMany: (inputs: unknown[]) => Promise<unknown[]>;
    }).upsertMany = async () => {
      throw new Error("simulated atomic batch failure");
    };

    await expect(harness.performAction("import-org-chart", {
      rows: [
        { externalId: "exec-1", name: "Asha Patel" },
        { externalId: "eng-1", name: "Diego Ruiz", reportsToExternalId: "exec-1" },
      ],
    }, actionOptions())).rejects.toThrow("failure");

    const stored = await harness.ctx.entities.list({
      entityType: "human-profile",
      scopeKind: "company",
      scopeId: COMPANY_ID,
      limit: 10,
      offset: 0,
    });
    expect(stored).toHaveLength(0);
  });

  it("keeps the maximum 5,000-profile replacement within one 10,000-record transaction", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    const existing = Array.from({ length: 5_000 }, (_, index) => ({
      externalId: `old-${index}`,
      name: `Old Human ${index}`,
    }));
    await harness.performAction("import-org-chart", { rows: existing }, actionOptions());
    const originalUpsertMany = harness.ctx.entities.upsertMany.bind(harness.ctx.entities);
    const upsertMany = vi.fn(async (inputs: Parameters<typeof originalUpsertMany>[0]) => originalUpsertMany(inputs));
    harness.ctx.entities.upsertMany = upsertMany;
    const replacement = Array.from({ length: 5_000 }, (_, index) => ({
      externalId: `new-${index}`,
      name: `New Human ${index}`,
    }));

    await expect(harness.performAction("import-org-chart", {
      rows: replacement,
      replace: true,
    }, actionOptions())).resolves.toMatchObject({ imported: 5_000, deactivated: 5_000 });
    expect(upsertMany).toHaveBeenCalledTimes(1);
    expect(upsertMany.mock.calls[0]?.[0]).toHaveLength(10_000);
  }, 20_000);

  it("validates incremental imports against the merged existing hierarchy", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel" }],
    }, actionOptions());

    await expect(harness.performAction("import-org-chart", {
      replace: false,
      rows: [{ externalId: "eng-1", name: "Diego Ruiz", reportsToExternalId: "exec-1" }],
    }, actionOptions())).resolves.toMatchObject({ imported: 1 });

    const roster = await harness.getData<{ profiles: Array<{ externalId: string }> }>("human-roster", {
      companyId: COMPANY_ID,
    });
    expect(roster.profiles.map((profile) => profile.externalId).sort()).toEqual(["eng-1", "exec-1"]);
  });

  it("rejects cycles introduced by incremental updates before persisting them", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [
        { externalId: "exec-1", name: "Asha Patel" },
        { externalId: "eng-1", name: "Diego Ruiz", reportsToExternalId: "exec-1" },
      ],
    }, actionOptions());

    await expect(harness.performAction("import-org-chart", {
      replace: false,
      rows: [{ externalId: "exec-1", name: "Asha Patel", reportsToExternalId: "eng-1" }],
    }, actionOptions())).rejects.toThrow("Reporting cycle detected");

    const roster = await harness.getData<{ profiles: Array<{ externalId: string; reportsToExternalId: string | null }> }>(
      "human-roster",
      { companyId: COMPANY_ID },
    );
    expect(roster.profiles.find((profile) => profile.externalId === "exec-1")?.reportsToExternalId).toBeNull();
  });

  it("creates a Paperclip issue, records the human assignment, and uses a linked Paperclip user when available", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      projects: [{ id: PROJECT_ID, companyId: COMPANY_ID, name: "RCM", description: null, status: "in_progress", color: "#2563eb", targetDate: null, leadAgentId: null, createdAt: new Date(), updatedAt: new Date() }],
      accessMembers: [
        activeMember(COMPANY_ID),
        activeMember(COMPANY_ID, "user-123", "member"),
      ],
    });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", { csv }, actionOptions());

    const result = await harness.performAction<{
      issue: { id: string; title: string; assigneeUserId: string | null };
      assignment: { humanExternalId: string };
    }>("create-human-task", {
      requestId: "create-linked-human",
      humanExternalId: "eng-1",
      projectId: PROJECT_ID,
      title: "Review payer integration",
      description: "Confirm field mappings.",
      priority: "high",
    }, actionOptions());

    expect(result.issue).toMatchObject({
      title: "Review payer integration",
      assigneeUserId: "user-123",
    });
    expect(result.assignment.humanExternalId).toBe("eng-1");

    const board = await harness.getData<{ columns: Record<string, Array<{ human: { externalId: string }; issue: { title: string } }>> }>(
      "human-work-board",
      { companyId: COMPANY_ID },
    );
    expect(board.columns.todo).toEqual([
      expect.objectContaining({
        human: expect.objectContaining({ externalId: "eng-1" }),
        issue: expect.objectContaining({ title: "Review payer integration" }),
      }),
    ]);
  });

  it("deduplicates retried task creation requests", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel" }],
    }, actionOptions());
    const params = {
      requestId: "request-123",
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    };

    const first = await harness.performAction<{ issue: { id: string } }>("create-human-task", params, actionOptions());
    const second = await harness.performAction<{ issue: { id: string } }>("create-human-task", params, actionOptions());
    expect(second.issue.id).toBe(first.issue.id);

    const board = await harness.getData<{ columns: Record<string, unknown[]> }>(
      "human-work-board",
      { companyId: COMPANY_ID },
    );
    expect(Object.values(board.columns).flat()).toHaveLength(1);
  });

  it("atomically deduplicates concurrent task creation requests", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        mattermostWebhook: { type: "secret_ref", secretId: "mattermost-webhook" },
        notifyMattermost: true,
      },
    });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    harness.ctx.secrets.resolve = vi.fn().mockResolvedValue("https://chat.example/hooks/secret-value");
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    harness.ctx.http.fetch = fetchSpy;
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel", mattermostUsername: "asha" }],
    }, actionOptions());
    const params = {
      requestId: "request-concurrent",
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    };

    const [first, second] = await Promise.all([
      harness.performAction<{ issue: { id: string } }>("create-human-task", params, actionOptions()),
      harness.performAction<{ issue: { id: string } }>("create-human-task", params, actionOptions()),
    ]);

    expect(second.issue.id).toBe(first.issue.id);
    const issues = await harness.ctx.issues.list({
      companyId: COMPANY_ID,
      originKind: "plugin:paperclipai.plugin-human-org",
      limit: 10,
      offset: 0,
    });
    expect(issues).toHaveLength(1);
    const board = await harness.getData<{ total: number }>("human-work-board", { companyId: COMPANY_ID });
    expect(board.total).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the insert-only assignment record to deduplicate notifications across worker processes", async () => {
    const options = {
      manifest,
      config: {
        mattermostWebhook: { type: "secret_ref" as const, secretId: "mattermost-webhook" },
        notifyMattermost: true,
      },
    };
    const firstWorker = createTestHarness(options);
    const secondWorker = createTestHarness(options);
    firstWorker.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    secondWorker.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    (secondWorker.ctx as unknown as { entities: typeof firstWorker.ctx.entities }).entities = firstWorker.ctx.entities;
    (secondWorker.ctx as unknown as { issues: typeof firstWorker.ctx.issues }).issues = firstWorker.ctx.issues;
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    firstWorker.ctx.secrets.resolve = vi.fn().mockResolvedValue("https://chat.example/hooks/secret-value");
    secondWorker.ctx.secrets.resolve = vi.fn().mockResolvedValue("https://chat.example/hooks/secret-value");
    firstWorker.ctx.http.fetch = fetchSpy;
    secondWorker.ctx.http.fetch = fetchSpy;
    await plugin.definition.setup(firstWorker.ctx);
    await plugin.definition.setup(secondWorker.ctx);
    await firstWorker.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel", mattermostUsername: "asha" }],
    }, actionOptions());
    const params = {
      requestId: "request-cross-worker",
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    };

    const [first, second] = await Promise.all([
      firstWorker.performAction<{ issue: { id: string } }>("create-human-task", params, actionOptions()),
      secondWorker.performAction<{ issue: { id: string } }>("create-human-task", params, actionOptions()),
    ]);

    expect(second.issue.id).toBe(first.issue.id);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const assignments = await firstWorker.ctx.entities.list({
      entityType: "human-assignment",
      scopeKind: "company",
      scopeId: COMPANY_ID,
      limit: 10,
      offset: 0,
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toEqual(expect.objectContaining({
      status: "active",
      data: expect.objectContaining({
        issueId: first.issue.id,
        humanExternalId: "exec-1",
        notificationState: "sent",
      }),
    }));
  });

  it("rejects concurrent reuse of one request ID across different humans", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        mattermostWebhook: { type: "secret_ref", secretId: "mattermost-webhook" },
        notifyMattermost: true,
      },
    });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    harness.ctx.secrets.resolve = vi.fn().mockResolvedValue("https://chat.example/hooks/secret-value");
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    harness.ctx.http.fetch = fetchSpy;
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [
        { externalId: "exec-1", name: "Asha Patel", mattermostUsername: "asha" },
        { externalId: "exec-2", name: "Diego Ruiz", mattermostUsername: "diego" },
      ],
    }, actionOptions());

    const results = await Promise.allSettled([
      harness.performAction("create-human-task", {
        requestId: "request-shared",
        humanExternalId: "exec-1",
        title: "Approve Q4 budget",
      }, actionOptions()),
      harness.performAction("create-human-task", {
        requestId: "request-shared",
        humanExternalId: "exec-2",
        title: "Approve Q4 budget",
      }, actionOptions()),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      reason: expect.objectContaining({
        message: "requestId was already used for a different human assignment",
      }),
    });
    const issues = await harness.ctx.issues.list({ companyId: COMPANY_ID, limit: 10, offset: 0 });
    expect(issues).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("requires a stable request ID for task creation", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel" }],
    }, actionOptions());

    await expect(harness.performAction("create-human-task", {
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    }, actionOptions())).rejects.toThrow("requestId is required");
    await expect(harness.performAction("create-human-task", {
      requestId: "oversized-task-title",
      humanExternalId: "exec-1",
      title: "x".repeat(501),
    }, actionOptions())).rejects.toThrow("title exceeds 500 characters");
  });

  it("allows only one concurrent assignment transition from the same observed state", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        mattermostWebhook: { type: "secret_ref", secretId: "mattermost-webhook" },
        notifyMattermost: true,
      },
    });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    harness.ctx.secrets.resolve = vi.fn().mockResolvedValue("https://chat.example/hooks/secret-value");
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    harness.ctx.http.fetch = fetchSpy;
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [
        { externalId: "exec-1", name: "Asha Patel", mattermostUsername: "asha" },
        { externalId: "exec-2", name: "Diego Ruiz", mattermostUsername: "diego" },
      ],
    }, actionOptions());
    const issue = await harness.ctx.issues.create({ companyId: COMPANY_ID, title: "Concurrent owner" });

    const results = await Promise.allSettled([
      harness.performAction("assign-human-task", {
        humanExternalId: "exec-1",
        issueId: issue.id,
      }, actionOptions()),
      harness.performAction("assign-human-task", {
        humanExternalId: "exec-2",
        issueId: issue.id,
      }, actionOptions()),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const assignments = await harness.ctx.entities.list({
      entityType: "human-assignment",
      scopeKind: "company",
      scopeId: COMPANY_ID,
      externalId: `${COMPANY_ID}:${issue.id}`,
      limit: 2,
      offset: 0,
    });
    expect(assignments).toHaveLength(1);
    const winner = (assignments[0]?.data as { humanExternalId?: string }).humanExternalId;
    expect(["exec-1", "exec-2"]).toContain(winner);
  });

  it("leaves the prior Paperclip assignee unchanged if the atomic assignment transition fails", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel" }],
    }, actionOptions());
    const issue = await harness.ctx.issues.create({
      companyId: COMPANY_ID,
      title: "Existing agent task",
      assigneeAgentId: "agent-1",
    });
    harness.ctx.issues.transitionAssigneeEntity = vi.fn(async () => {
      throw new Error("simulated atomic transition failure");
    });

    await expect(harness.performAction("assign-human-task", {
      humanExternalId: "exec-1",
      issueId: issue.id,
    }, actionOptions())).rejects.toThrow("simulated atomic transition failure");
    await expect(harness.ctx.issues.get(issue.id, COMPANY_ID)).resolves.toEqual(expect.objectContaining({
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    }));
  });

  it("does not notify Mattermost before a new task assignment is persisted", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        mattermostWebhook: { type: "secret_ref", secretId: "mattermost-webhook" },
        notifyMattermost: true,
      },
    });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    harness.ctx.secrets.resolve = vi.fn().mockResolvedValue("https://chat.example/hooks/secret-value");
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    harness.ctx.http.fetch = fetchSpy;
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel", mattermostUsername: "asha" }],
    }, actionOptions());
    const originalCreate = harness.ctx.entities.create.bind(harness.ctx.entities);
    const originalUpsert = harness.ctx.entities.upsert.bind(harness.ctx.entities);
    let failPendingAssignment = true;
    const maybeFailPendingAssignment = (params: { entityType: string; data: Record<string, unknown> }) => {
      if (
        failPendingAssignment
        && params.entityType === "human-assignment"
        && params.data.notificationState === "pending"
      ) {
        failPendingAssignment = false;
        throw new Error("simulated persistence failure");
      }
    };
    harness.ctx.entities.create = vi.fn(async (params) => {
      maybeFailPendingAssignment(params);
      return await originalCreate(params);
    });
    harness.ctx.entities.upsert = vi.fn(async (params) => {
      maybeFailPendingAssignment(params);
      return await originalUpsert(params);
    });

    const params = {
      requestId: "request-no-notify",
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    };
    await expect(harness.performAction("create-human-task", params, actionOptions())).rejects.toThrow("simulated persistence failure");
    expect(fetchSpy).not.toHaveBeenCalled();
    const [createdIssue] = await harness.ctx.issues.list({
      companyId: COMPANY_ID,
      originKind: "plugin:paperclipai.plugin-human-org",
      originId: "human-task:request-no-notify:exec-1",
      limit: 2,
      offset: 0,
    });
    expect(createdIssue).toBeDefined();
    const orphanedClaims = await harness.ctx.entities.list({
      entityType: "human-notification-claim",
      scopeKind: "company",
      scopeId: COMPANY_ID,
      limit: 10,
      offset: 0,
    });
    expect(orphanedClaims).toHaveLength(0);

    harness.ctx.entities.create = originalCreate;
    harness.ctx.entities.upsert = originalUpsert;
    const recovered = await harness.performAction<{
      issue: { id: string };
      assignment: { notificationState: string };
      notification: { state: string };
    }>("create-human-task", params, actionOptions());
    expect(recovered.issue.id).toBe(createdIssue?.id);
    expect(recovered.assignment.notificationState).toBe("sent");
    expect(recovered.notification.state).toBe("sent");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps a created task authoritative when Mattermost configuration lookup fails", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel", mattermostUsername: "asha" }],
    }, actionOptions());
    harness.ctx.config.get = vi.fn().mockRejectedValue(new Error("simulated config failure"));

    const result = await harness.performAction<{
      issue: { id: string };
      assignment: { issueId: string };
      notification: { state: string; reason?: string };
    }>("create-human-task", {
      requestId: "config-failure-task",
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    }, actionOptions());

    expect(result.assignment.issueId).toBe(result.issue.id);
    expect(result.notification).toEqual({ state: "failed", reason: "delivery_error" });
    const board = await harness.getData<{ total: number }>("human-work-board", { companyId: COMPANY_ID });
    expect(board.total).toBe(1);
  });

  it("does not redeliver Mattermost after delivery succeeds but the sent-state write fails", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        mattermostWebhook: { type: "secret_ref", secretId: "mattermost-webhook" },
        notifyMattermost: true,
      },
    });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    harness.ctx.secrets.resolve = vi.fn().mockResolvedValue("https://chat.example/hooks/secret-value");
    const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
    harness.ctx.http.fetch = fetchSpy;
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel", mattermostUsername: "asha" }],
    }, actionOptions());
    const originalUpsert = harness.ctx.entities.upsert;
    let failedSentWrite = false;
    harness.ctx.entities.upsert = vi.fn(async (params) => {
      if (
        params.entityType === "human-assignment"
        && params.data.notificationState === "sent"
        && !failedSentWrite
      ) {
        failedSentWrite = true;
        throw new Error("simulated sent-state persistence failure");
      }
      return await originalUpsert(params);
    });
    const params = {
      requestId: "request-ambiguous-notification",
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    };

    const first = await harness.performAction<{
      issue: { id: string };
      assignment: { notificationState: string };
      notification: { state: string; reason?: string };
    }>("create-human-task", params, actionOptions());
    expect(first.notification.state).toBe("sent");
    expect(first.assignment.notificationState).toBe("unknown");

    const retried = await harness.performAction<{
      issue: { id: string };
      assignment: { notificationState: string };
      notification: { state: string; reason?: string };
    }>("create-human-task", params, actionOptions());
    expect(retried.issue.id).toBe(first.issue.id);
    expect(retried.assignment.notificationState).toBe("unknown");
    expect(retried.notification).toEqual({ state: "unknown", reason: "duplicate_request_delivery_unknown" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects an explicitly linked Paperclip user who is not an active company member", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "eng-1", name: "Diego Ruiz", paperclipUserId: "missing-user" }],
    }, actionOptions());

    await expect(harness.performAction("create-human-task", {
      requestId: "inactive-linked-user",
      humanExternalId: "eng-1",
      title: "Review payer integration",
    }, actionOptions())).rejects.toThrow("not an active member");

    const board = await harness.getData<{ columns: Record<string, unknown[]> }>(
      "human-work-board",
      { companyId: COMPANY_ID },
    );
    expect(Object.values(board.columns).flat()).toHaveLength(0);
  });

  it("rejects board status changes after the human assignment is removed", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel" }],
    }, actionOptions());
    const created = await harness.performAction<{ issue: { id: string } }>("create-human-task", {
      requestId: "status-after-unassign",
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    }, actionOptions());
    await harness.performAction("unassign-human-task", { issueId: created.issue.id }, actionOptions());

    await expect(harness.performAction("update-human-task-status", {
      issueId: created.issue.id,
      status: "done",
    }, actionOptions())).rejects.toThrow("active human assignment");
  });

  it("allows only one concurrent unassignment from the same observed state", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel" }],
    }, actionOptions());
    const created = await harness.performAction<{ issue: { id: string } }>("create-human-task", {
      requestId: "concurrent-unassign",
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    }, actionOptions());

    const results = await Promise.allSettled([
      harness.performAction("unassign-human-task", { issueId: created.issue.id }, actionOptions()),
      harness.performAction("unassign-human-task", { issueId: created.issue.id }, actionOptions()),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const assignments = await harness.ctx.entities.list({
      entityType: "human-assignment",
      scopeKind: "company",
      scopeId: COMPANY_ID,
      externalId: `${COMPANY_ID}:${created.issue.id}`,
      limit: 2,
      offset: 0,
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.status).toBe("inactive");
  });

  it("leaves the linked core assignee unchanged when atomic assignment deactivation fails", async () => {
      const harness = createTestHarness({ manifest });
      harness.seed({ accessMembers: [
        activeMember(COMPANY_ID),
        activeMember(COMPANY_ID, "linked-user", "member"),
      ] });
      await plugin.definition.setup(harness.ctx);
      await harness.performAction("import-org-chart", {
        rows: [{ externalId: "exec-1", name: "Asha Patel", paperclipUserId: "linked-user" }],
      }, actionOptions());
      const created = await harness.performAction<{ issue: { id: string } }>("create-human-task", {
        requestId: "request-unassign-compensation",
        humanExternalId: "exec-1",
        title: "Approve Q4 budget",
      }, actionOptions());
      harness.ctx.issues.transitionAssigneeEntity = vi.fn(async () => {
        throw new Error("simulated atomic transition failure");
      });

      await expect(harness.performAction("unassign-human-task", {
        issueId: created.issue.id,
      }, actionOptions())).rejects.toThrow("simulated atomic transition failure");

      const issue = await harness.ctx.issues.get(created.issue.id, COMPANY_ID);
      expect(issue?.assigneeUserId).toBe("linked-user");
    });

    it("does not let an inactive assignment clear a later manual core assignment", async () => {
      const harness = createTestHarness({ manifest });
      harness.seed({ accessMembers: [
        activeMember(COMPANY_ID),
        activeMember(COMPANY_ID, "linked-user", "member"),
      ] });
      await plugin.definition.setup(harness.ctx);
      await harness.performAction("import-org-chart", {
        rows: [{ externalId: "exec-1", name: "Asha Patel", paperclipUserId: "linked-user" }],
      }, actionOptions());
      const created = await harness.performAction<{ issue: { id: string } }>("create-human-task", {
        requestId: "request-inactive-unassign",
        humanExternalId: "exec-1",
        title: "Approve Q4 budget",
      }, actionOptions());
      await harness.performAction("unassign-human-task", { issueId: created.issue.id }, actionOptions());
      await harness.ctx.issues.update(created.issue.id, { assigneeUserId: "linked-user" }, COMPANY_ID);

      await expect(harness.performAction("unassign-human-task", {
        issueId: created.issue.id,
      }, actionOptions())).resolves.toEqual({ unassigned: false });
      const issue = await harness.ctx.issues.get(created.issue.id, COMPANY_ID);
      expect(issue?.assigneeUserId).toBe("linked-user");
    });

    it("rejects status mutation after the core issue is reassigned outside the plugin", async () => {
      const harness = createTestHarness({ manifest });
      harness.seed({ accessMembers: [
        activeMember(COMPANY_ID),
        activeMember(COMPANY_ID, "linked-user", "member"),
        activeMember(COMPANY_ID, "other-user", "member"),
      ] });
      await plugin.definition.setup(harness.ctx);
      await harness.performAction("import-org-chart", {
        rows: [{ externalId: "exec-1", name: "Asha Patel", paperclipUserId: "linked-user" }],
      }, actionOptions());
      const created = await harness.performAction<{ issue: { id: string } }>("create-human-task", {
        requestId: "request-stale-status",
        humanExternalId: "exec-1",
        title: "Approve Q4 budget",
      }, actionOptions());
      await harness.ctx.issues.update(created.issue.id, { assigneeUserId: "other-user" }, COMPANY_ID);

      await expect(harness.performAction("update-human-task-status", {
        issueId: created.issue.id,
        status: "done",
      }, actionOptions())).rejects.toThrow("no longer owns");
      const issue = await harness.ctx.issues.get(created.issue.id, COMPANY_ID);
      expect(issue?.status).toBe("todo");
    });

    it("keeps external assignments off the core user-assignee field", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        mattermostWebhook: WEBHOOK_SECRET,
        paperclipBaseUrl: "https://paperclip.example",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    harness.ctx.secrets.resolve = vi.fn().mockResolvedValue("https://slack.quickintell.com/hooks/private-token");
    harness.ctx.http.fetch = fetchMock;
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", { csv }, actionOptions());

    const result = await harness.performAction<{ issue: { assigneeUserId: string | null } }>("create-human-task", {
      requestId: "external-human-mattermost",
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    }, actionOptions());

    expect(result.issue.assigneeUserId).toBeNull();
    expect(harness.ctx.secrets.resolve).toHaveBeenCalledWith(WEBHOOK_SECRET, {
      companyId: COMPANY_ID,
      configPath: "mattermostWebhook",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.quickintell.com/hooks/private-token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.stringify(harness.logs)).not.toContain("private-token");
  });

  it("rejects invalid hierarchy data without persisting partial rows", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction("import-org-chart", {
      rows: [
        { externalId: "a", name: "A", reportsToExternalId: "b" },
        { externalId: "b", name: "B", reportsToExternalId: "a" },
      ],
    }, actionOptions())).rejects.toThrow("Reporting cycle detected");

    const roster = await harness.getData<{ profiles: unknown[] }>("human-roster", { companyId: COMPANY_ID });
    expect(roster.profiles).toHaveLength(0);
  });

  it("keeps identical external IDs isolated between companies", async () => {
    const otherCompanyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID), activeMember(otherCompanyId)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Company A person" }],
    }, actionOptions());
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Company B person" }],
    }, actionOptions(otherCompanyId));

    const firstRoster = await harness.getData<{ profiles: Array<{ externalId: string; name: string }> }>("human-roster", {
      companyId: COMPANY_ID,
    });
    const secondRoster = await harness.getData<{ profiles: Array<{ externalId: string; name: string }> }>("human-roster", {
      companyId: otherCompanyId,
    });
    const stored = await harness.ctx.entities.list({ entityType: "human-profile", limit: 10, offset: 0 });

    expect(firstRoster.profiles).toMatchObject([{ externalId: "exec-1", name: "Company A person" }]);
    expect(secondRoster.profiles).toMatchObject([{ externalId: "exec-1", name: "Company B person" }]);
    expect(stored.map((record) => record.externalId).sort()).toEqual([
      `${COMPANY_ID}:exec-1`,
      `${otherCompanyId}:exec-1`,
    ].sort());
  });

  it("paginates the complete company roster beyond one thousand profiles", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await Promise.all(Array.from({ length: 1001 }, async (_value, index) => {
      const externalId = `person-${String(index).padStart(4, "0")}`;
      await harness.ctx.entities.upsert({
        entityType: "human-profile",
        scopeKind: "company",
        scopeId: COMPANY_ID,
        externalId: `${COMPANY_ID}:${externalId}`,
        title: externalId,
        status: "active",
        data: {
          companyId: COMPANY_ID,
          externalId,
          name: externalId,
          email: null,
          title: null,
          reportsToExternalId: null,
          capabilities: [],
          responsibilities: [],
          mattermostUsername: null,
          paperclipUserId: null,
          status: "active",
        },
      });
    }));

    const roster = await harness.getData<{ profiles: unknown[] }>("human-roster", { companyId: COMPANY_ID });
    expect(roster.profiles).toHaveLength(1001);
  });

  it("paginates issues when building the human work board", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID)] });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel" }],
    }, actionOptions());
    const created = await harness.performAction<{ issue: Record<string, unknown> }>("create-human-task", {
      requestId: "pagination-human-task",
      humanExternalId: "exec-1",
      title: "Approve Q4 budget",
    }, actionOptions());
    const decoys = Array.from({ length: 500 }, (_value, index) => ({
      ...created.issue,
      id: `decoy-${index}`,
      title: `Decoy ${index}`,
    }));
    harness.ctx.issues.list = vi.fn(async (params) => params.offset === 0 ? decoys : [created.issue as never]);

    const board = await harness.getData<{ columns: Record<string, Array<{ issue: { id: string } }>> }>(
      "human-work-board",
      { companyId: COMPANY_ID },
    );
    expect(board.columns.todo.map((card) => card.issue.id)).toContain(created.issue.id);
    expect(harness.ctx.issues.list).toHaveBeenCalledTimes(2);
  });

  it("rejects mutations from viewer memberships", async () => {
    const viewerId = "viewer-user";
    const harness = createTestHarness({ manifest });
    harness.seed({ accessMembers: [activeMember(COMPANY_ID, viewerId, "viewer")] });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction("import-org-chart", {
      rows: [{ externalId: "exec-1", name: "Asha Patel" }],
    }, actionOptions(COMPANY_ID, viewerId))).rejects.toThrow("Active member role is required");
  });
});
