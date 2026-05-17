import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import type { MemoryListRecordsQuery } from "@paperclipai/shared";
import { memoryService } from "../services/memory.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function createQueuedSelectDb(selectResults: unknown[][]) {
  const calls: Array<{ kind: string }> = [];
  const makeThenable = () => ({
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((resolve: (rows: unknown[]) => unknown) => {
      calls.push({ kind: "select" });
      return Promise.resolve(resolve(selectResults.shift() ?? []));
    }),
  });

  return {
    calls,
    db: {
      select: vi.fn(() => makeThenable()),
    } as any,
  };
}

function makeBinding(id: string, key: string, providerKey = "local_basic") {
  const now = new Date("2026-04-01T00:00:00.000Z");
  return {
    id,
    companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    key,
    name: key,
    providerKey,
    config: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function makeMemoryRecordRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-04-01T00:00:00.000Z");
  return {
    id: "44444444-4444-4444-8444-444444444444",
    companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    providerKey: "local_basic",
    scopeAgentId: null,
    scopeProjectId: null,
    scopeIssueId: "55555555-5555-4555-8555-555555555555",
    scopeRunId: null,
    scopeSubjectId: null,
    scopeType: "org",
    scopeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    scopeWorkspaceId: null,
    scopeTeamId: null,
    sourceKind: "issue_comment",
    sourceIssueId: "55555555-5555-4555-8555-555555555555",
    sourceCommentId: "66666666-6666-4666-8666-666666666666",
    sourceDocumentKey: null,
    sourceRunId: null,
    sourceActivityId: null,
    sourceExternalRef: null,
    ownerType: "user",
    ownerId: "board-user",
    createdByActorType: "user",
    createdByActorId: "board-user",
    sensitivityLabel: "internal",
    retentionPolicy: null,
    expiresAt: null,
    retentionState: "active",
    reviewState: "accepted",
    reviewedAt: null,
    reviewedByActorType: null,
    reviewedByActorId: null,
    reviewNote: null,
    citationJson: null,
    supersedesRecordId: null,
    supersededByRecordId: null,
    revokedAt: null,
    revokedByActorType: null,
    revokedByActorId: null,
    revocationReason: null,
    title: "Issue comment",
    content: "Remember that the launch checklist lives in the issue document.",
    summary: "Remember that the launch checklist lives in the issue document.",
    metadata: {},
    createdByOperationId: "77777777-7777-4777-8777-777777777777",
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeOperationRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-04-01T00:00:00.000Z");
  return {
    id: "77777777-7777-4777-8777-777777777777",
    companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    providerKey: "local_basic",
    operationType: "upsert",
    triggerKind: "hook",
    hookKind: "issue_comment_capture",
    status: "succeeded",
    actorType: "user",
    actorId: "board-user",
    agentId: null,
    userId: "board-user",
    scopeAgentId: null,
    scopeProjectId: null,
    scopeIssueId: "55555555-5555-4555-8555-555555555555",
    scopeRunId: null,
    scopeSubjectId: null,
    scopeType: "org",
    scopeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    scopeWorkspaceId: null,
    scopeTeamId: null,
    maxSensitivityLabel: null,
    sourceKind: "issue_comment",
    sourceIssueId: "55555555-5555-4555-8555-555555555555",
    sourceCommentId: "66666666-6666-4666-8666-666666666666",
    sourceDocumentKey: null,
    sourceRunId: null,
    sourceActivityId: null,
    sourceExternalRef: null,
    queryText: null,
    recordCount: 1,
    requestJson: null,
    resultJson: null,
    policyDecisionJson: null,
    revocationSelectorJson: null,
    retentionActionJson: null,
    usageJson: [],
    error: null,
    costEventId: null,
    financeEventId: null,
    occurredAt: now,
    createdAt: now,
    ...overrides,
  };
}

function makeExtractionJobRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-04-01T00:00:00.000Z");
  return {
    id: "88888888-8888-4888-8888-888888888888",
    companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    providerKey: "local_basic",
    operationId: null,
    status: "running",
    providerJobId: null,
    sourceKind: "issue_comment",
    sourceIssueId: "55555555-5555-4555-8555-555555555555",
    sourceCommentId: "66666666-6666-4666-8666-666666666666",
    sourceDocumentKey: null,
    sourceRunId: null,
    sourceActivityId: null,
    sourceExternalRef: null,
    resultJson: null,
    error: null,
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("memoryService.forget", () => {
  it("rejects record sets that span multiple bindings", async () => {
    const rows = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        bindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        bindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    ];

    const where = vi.fn().mockResolvedValue(rows);
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      }),
      update: vi.fn(),
    } as any;

    await expect(
      memoryService(db).forget(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        {
          recordIds: rows.map((row) => row.id),
          scope: {},
        },
        {
          actorType: "user",
          actorId: "board-user",
          agentId: null,
          userId: "board-user",
          runId: null,
        },
      ),
    ).rejects.toThrow("Memory records must belong to the same binding");

    expect(where).toHaveBeenCalledOnce();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("memoryService providers", () => {
  it("exposes config metadata with field-level defaults for built-in providers", async () => {
    const providers = await memoryService({} as any).providers();
    const local = providers.find((provider) => provider.key === "local_basic");

    expect(local?.configMetadata?.suggestedConfig).toMatchObject({
      enablePreRunHydrate: true,
      enablePostRunCapture: true,
      maxHydrateSnippets: 5,
    });
    expect(local?.configMetadata?.fields.map((field) => field.key)).toContain("maxHydrateSnippets");
    expect(local?.configMetadata?.healthChecks?.[0]).toMatchObject({
      key: "postgres",
      status: "ok",
    });
  });
});

describe("memoryService.resolveBinding", () => {
  it("prefers an agent override before project and company bindings", async () => {
    const agentBinding = makeBinding("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "agent");
    const { db } = createQueuedSelectDb([
      [{ companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      [{ companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      [
        {
          target: {
            id: "target-agent",
            companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            bindingId: agentBinding.id,
            targetType: "agent",
            targetId: "11111111-1111-4111-8111-111111111111",
            createdAt: agentBinding.createdAt,
            updatedAt: agentBinding.updatedAt,
          },
          binding: agentBinding,
        },
      ],
    ]);

    const resolved = await memoryService(db).resolveBinding(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      {
        agentId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
      },
    );

    expect(resolved.source).toBe("agent_override");
    expect(resolved.checkedTargetTypes).toEqual(["agent"]);
    expect(resolved.binding?.id).toBe(agentBinding.id);
  });

  it("falls back from project override to company default", async () => {
    const companyBinding = makeBinding("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "company");
    const { db } = createQueuedSelectDb([
      [{ companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      [],
      [
        {
          target: {
            id: "target-company",
            companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            bindingId: companyBinding.id,
            targetType: "company",
            targetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            createdAt: companyBinding.createdAt,
            updatedAt: companyBinding.updatedAt,
          },
          binding: companyBinding,
        },
      ],
    ]);

    const resolved = await memoryService(db).resolveBinding(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      { projectId: "22222222-2222-4222-8222-222222222222" },
    );

    expect(resolved.source).toBe("company_default");
    expect(resolved.checkedTargetTypes).toEqual(["project", "company"]);
    expect(resolved.binding?.id).toBe(companyBinding.id);
  });

  it("rejects project scopes outside the company before resolving defaults", async () => {
    const { db } = createQueuedSelectDb([
      [{ companyId: "99999999-9999-4999-8999-999999999999" }],
    ]);

    await expect(
      memoryService(db).resolveBinding(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        { projectId: "22222222-2222-4222-8222-222222222222" },
      ),
    ).rejects.toThrow("Memory scope project does not belong to company");
  });
});

describe("memoryService hook policies", () => {
  it("runs issue comment capture through an extraction job when policy requests Paperclip-managed extraction", async () => {
    const binding = {
      ...makeBinding("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "company"),
      config: {
        enableIssueCommentCapture: true,
        hookPolicies: {
          issue_comment_capture: {
            enabled: true,
            extractionMode: "paperclip_managed",
            runMode: "sync",
            harness: "server_worker",
            sensitivityLabel: "internal",
            reviewState: "accepted",
          },
        },
      },
    };
    const target = {
      id: "target-company",
      companyId: binding.companyId,
      bindingId: binding.id,
      targetType: "company",
      targetId: binding.companyId,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    };
    const selectResults = [
      [{ target, binding }],
      [{ target, binding }],
    ];
    const insertResults = [
      [makeExtractionJobRow()],
      [makeMemoryRecordRow()],
      [makeOperationRow()],
    ];
    const updateResults = [
      [
        makeExtractionJobRow({
          status: "succeeded",
          operationId: "77777777-7777-4777-8777-777777777777",
          completedAt: new Date("2026-04-01T00:00:01.000Z"),
        }),
      ],
    ];
    const insertedValues: unknown[] = [];
    const updatedValues: unknown[] = [];
    const selectThenable = () => ({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(selectResults.shift() ?? []))),
    });
    const db = {
      select: vi.fn(() => selectThenable()),
      insert: vi.fn(() => ({
        values: vi.fn((value: unknown) => {
          insertedValues.push(value);
          return {
            returning: vi.fn().mockResolvedValue(insertResults.shift() ?? []),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value: unknown) => {
          updatedValues.push(value);
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockImplementation(() => Promise.resolve(updateResults.shift() ?? [])),
            }),
          };
        }),
      })),
    } as any;

    const result = await memoryService(db).captureIssueComment({
      companyId: binding.companyId,
      issueId: "55555555-5555-4555-8555-555555555555",
      commentId: "66666666-6666-4666-8666-666666666666",
      body: "Remember that the launch checklist lives in the issue document.",
      actor: {
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        userId: "board-user",
        runId: null,
      },
    });

    expect(result?.operation.hookKind).toBe("issue_comment_capture");
    expect(db.insert).toHaveBeenCalledTimes(3);
    expect(insertedValues[0]).toMatchObject({
      companyId: binding.companyId,
      bindingId: binding.id,
      status: "running",
      sourceKind: "issue_comment",
      resultJson: {
        hookKind: "issue_comment_capture",
        policy: {
          extractionMode: "paperclip_managed",
          harness: "server_worker",
        },
      },
    });
    expect(insertedValues[1]).toMatchObject({
      reviewState: "accepted",
      createdByOperationId: null,
      metadata: {
        extraction: {
          mode: "paperclip_managed",
          harness: "server_worker",
          jobId: "88888888-8888-4888-8888-888888888888",
        },
      },
    });
    expect(updatedValues).toContainEqual(
      expect.objectContaining({
        createdByOperationId: "77777777-7777-4777-8777-777777777777",
      }),
    );
    expect(updatedValues.find((value) => (value as { status?: string }).status === "succeeded")).toMatchObject({
      status: "succeeded",
      operationId: "77777777-7777-4777-8777-777777777777",
      resultJson: {
        hookKind: "issue_comment_capture",
        recordIds: ["44444444-4444-4444-8444-444444444444"],
      },
    });
  });
});

describe("memoryService supersedence protection", () => {
  const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const actor = {
    actorType: "user" as const,
    actorId: "board-user",
    agentId: null,
    userId: "board-user",
    runId: null,
  };

  it("correct throws 409 when the record has already been superseded", async () => {
    const row = makeMemoryRecordRow({
      supersededByRecordId: "99999999-9999-4999-8999-999999999999",
    });
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([row]))),
        }),
      })),
    } as any;

    await expect(
      memoryService(db).correct(
        companyId,
        row.id,
        { content: "corrected content", reason: "outdated" },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409, message: "Memory record has already been corrected" });
  });

  it("promote throws 409 when the record is already superseded inside the transaction", async () => {
    const row = makeMemoryRecordRow({
      supersededByRecordId: "99999999-9999-4999-8999-999999999999",
    });
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        for: vi.fn().mockReturnThis(),
        then: vi.fn((resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([row]))),
      })),
    };
    const db = {
      transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
      select: vi.fn(),
    } as any;

    await expect(
      memoryService(db).promote(
        companyId,
        row.id,
        { targetScope: { scopeType: "org" }, reason: "widen scope" },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409, message: "Memory record was already superseded" });
  });

  it("promote throws 409 when a concurrent operation claims supersedence first (race-safe update returns 0 rows)", async () => {
    const originalRow = makeMemoryRecordRow({ scopeType: "run", scopeId: "run-scope-id", supersededByRecordId: null });
    const promotedRow = makeMemoryRecordRow({ id: "promoted-row-id", supersedesRecordId: originalRow.id });
    const bindingRow = makeBinding(originalRow.bindingId, "company");

    const tx = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        for: vi.fn().mockReturnThis(),
        then: vi.fn((resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([originalRow]))),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([promotedRow]),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        then: vi.fn((resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([bindingRow]))),
      })),
      transaction: vi.fn(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
    } as any;

    await expect(
      memoryService(db).promote(
        companyId,
        originalRow.id,
        { targetScope: { scopeType: "org" }, reason: "widen scope" },
        actor,
      ),
    ).rejects.toMatchObject({ status: 409, message: "Memory record was already superseded" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("memoryService local basic persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("captures records with a valid operation id and counts explicit revoked filters", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Memory Test",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const service = memoryService(db);
    const actor = {
      actorType: "user" as const,
      actorId: "board-user",
      agentId: null,
      userId: "board-user",
      runId: null,
    };
    const binding = await service.createBinding(companyId, {
      key: "local-test",
      name: "Local test",
      providerKey: "local_basic",
      config: {},
      enabled: true,
    });
    await service.setCompanyDefault(companyId, binding.id);

    const captured = await service.capture(
      companyId,
      {
        bindingKey: "local-test",
        scope: { scopeType: "org", scopeId: companyId },
        scopeType: "org",
        scopeId: companyId,
        source: { kind: "manual_note", externalRef: "memory-service-test" },
        title: "Revoked filter regression",
        content: "A memory record that will be revoked for count filter coverage.",
        reviewState: "pending",
      },
      actor,
    );

    expect(captured.records).toHaveLength(1);
    expect(captured.records[0].createdByOperationId).toBe(captured.operation.id);

    await service.revoke(
      companyId,
      {
        selector: { recordIds: [captured.records[0].id] },
        reason: "Verify revoked filters can see explicit revoked retention state",
      },
      actor,
    );

    const revokedFilters: MemoryListRecordsQuery = {
      retentionState: "revoked",
      includeDeleted: false,
      includeRevoked: true,
      includeExpired: false,
      includeSuperseded: false,
      limit: 50,
    };

    await expect(service.countRecords(companyId, revokedFilters, actor)).resolves.toEqual({ count: 1 });

    const revokedRecords = await service.listRecords(companyId, revokedFilters, actor);
    expect(revokedRecords.map((record) => record.id)).toEqual([captured.records[0].id]);
  });

  // AUR-964: canonical promotion-sensitivity invariant. Promotion may keep
  // sensitivity equal or strictly raise it; lowering is rejected as 422 to
  // prevent declassification while widening audience.
  it("rejects sensitivity-lowering promotion and accepts equal/raise", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Promote Sensitivity Test",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const service = memoryService(db);
    const actor = {
      actorType: "user" as const,
      actorId: "board-user",
      agentId: null,
      userId: "board-user",
      runId: null,
    };

    const binding = await service.createBinding(companyId, {
      key: "local-promote-sensitivity",
      name: "Local promote sensitivity",
      providerKey: "local_basic",
      config: {},
      enabled: true,
    });
    await service.setCompanyDefault(companyId, binding.id);

    const agentScopeId = randomUUID();

    const captureConfidential = async () =>
      service.capture(
        companyId,
        {
          bindingKey: "local-promote-sensitivity",
          scope: { scopeType: "agent", scopeId: agentScopeId },
          scopeType: "agent",
          scopeId: agentScopeId,
          source: { kind: "manual_note", externalRef: "promote-sensitivity-test" },
          title: "Sensitive fact",
          content: "Agent-scope confidential fact used for promotion sensitivity tests.",
          sensitivityLabel: "confidential",
          reviewState: "accepted",
        },
        actor,
      );

    // Case 1: lowering sensitivity on promotion (confidential -> internal) must 422.
    const lowering = await captureConfidential();
    await expect(
      service.promote(
        companyId,
        lowering.records[0].id,
        {
          targetScope: { scopeType: "org" },
          reason: "Attempt to declassify while widening audience",
          sensitivityLabel: "internal",
        },
        actor,
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: "Promotion cannot lower sensitivityLabel below the original record",
    });

    // Case 2: equal sensitivity (confidential -> confidential) accepted.
    const equal = await captureConfidential();
    const equalResult = await service.promote(
      companyId,
      equal.records[0].id,
      {
        targetScope: { scopeType: "org" },
        reason: "Promote agent fact to org without changing sensitivity",
        sensitivityLabel: "confidential",
      },
      actor,
    );
    expect(equalResult.promotedRecord.sensitivityLabel).toBe("confidential");
    expect(equalResult.promotedRecord.scope.scopeType).toBe("org");
    expect(equalResult.originalRecord.supersededByRecordId).toBe(equalResult.promotedRecord.id);

    // Case 3: raising sensitivity (confidential -> restricted) accepted.
    const raising = await captureConfidential();
    const raisingResult = await service.promote(
      companyId,
      raising.records[0].id,
      {
        targetScope: { scopeType: "org" },
        reason: "Promote and tighten governance for wider audience",
        sensitivityLabel: "restricted",
      },
      actor,
    );
    expect(raisingResult.promotedRecord.sensitivityLabel).toBe("restricted");
    expect(raisingResult.promotedRecord.scope.scopeType).toBe("org");

    // Case 4: omitting sensitivityLabel keeps the origin label.
    const omitted = await captureConfidential();
    const omittedResult = await service.promote(
      companyId,
      omitted.records[0].id,
      {
        targetScope: { scopeType: "org" },
        reason: "Promote and inherit origin sensitivity",
      },
      actor,
    );
    expect(omittedResult.promotedRecord.sensitivityLabel).toBe("confidential");
  });

  // AUR-965: pinned error-code matrix for promote (404 / 409 / 422) and
  // race coverage for correct vs promote on the same origin record.
  it("pins promote error codes for missing, narrowing, cross-company, and race-against-correct cases", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip Promote Errors",
        issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Paperclip Promote Errors Other",
        issuePrefix: `R${otherCompanyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    const service = memoryService(db);
    const actor = {
      actorType: "user" as const,
      actorId: "board-user",
      agentId: null,
      userId: "board-user",
      runId: null,
    };
    const binding = await service.createBinding(companyId, {
      key: "local-promote-errors",
      name: "Local promote errors",
      providerKey: "local_basic",
      config: {},
      enabled: true,
    });
    await service.setCompanyDefault(companyId, binding.id);

    // 404: promote a record id that does not exist
    await expect(
      service.promote(
        companyId,
        randomUUID(),
        { targetScope: { scopeType: "org" }, reason: "missing" },
        actor,
      ),
    ).rejects.toMatchObject({ status: 404, message: "Memory record not found" });

    // 422: same-rank / narrowing — promote an org record to org
    const orgRecord = await service.capture(
      companyId,
      {
        bindingKey: "local-promote-errors",
        scope: { scopeType: "org", scopeId: companyId },
        scopeType: "org",
        scopeId: companyId,
        source: { kind: "manual_note", externalRef: "promote-rank-test" },
        title: "Already org-wide",
        content: "Already at the org scope; promotion target must strictly widen.",
        reviewState: "accepted",
      },
      actor,
    );
    await expect(
      service.promote(
        companyId,
        orgRecord.records[0].id,
        { targetScope: { scopeType: "org" }, reason: "narrowing" },
        actor,
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("must strictly widen"),
    });

    // 422: cross-company project scopeId — target a project that does not belong here
    const agentScopeId = randomUUID();
    const agentRecord = await service.capture(
      companyId,
      {
        bindingKey: "local-promote-errors",
        scope: { scopeType: "agent", scopeId: agentScopeId },
        scopeType: "agent",
        scopeId: agentScopeId,
        source: { kind: "manual_note", externalRef: "promote-xcompany-test" },
        title: "Cross-company target test",
        content: "Record used for cross-company target validation.",
        reviewState: "accepted",
      },
      actor,
    );
    await expect(
      service.promote(
        companyId,
        agentRecord.records[0].id,
        {
          targetScope: { scopeType: "project", scopeId: randomUUID() },
          reason: "cross-company target",
        },
        actor,
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("references a project outside this company"),
    });

    // Race coverage: correct + promote against the same origin record run
    // concurrently — exactly one must succeed; the other must fail with 409
    // and not corrupt the supersedence chain.
    const raceRecord = await service.capture(
      companyId,
      {
        bindingKey: "local-promote-errors",
        scope: { scopeType: "agent", scopeId: agentScopeId },
        scopeType: "agent",
        scopeId: agentScopeId,
        source: { kind: "manual_note", externalRef: "promote-race-test" },
        title: "Race target",
        content: "Origin record for the correct-vs-promote race assertion.",
        reviewState: "accepted",
      },
      actor,
    );
    const originId = raceRecord.records[0].id;

    const results = await Promise.allSettled([
      service.promote(
        companyId,
        originId,
        { targetScope: { scopeType: "org" }, reason: "race-promote" },
        actor,
      ),
      service.correct(
        companyId,
        originId,
        { content: "corrected content during race", reason: "race-correct" },
        actor,
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    // Reload origin and ensure it points to exactly one successor — the winner's new record id.
    const records = await service.listRecords(
      companyId,
      { includeSuperseded: true, limit: 100 },
      actor,
    );
    const origin = records.find((r) => r.id === originId);
    expect(origin).toBeDefined();
    expect(origin!.supersededByRecordId).toBeTruthy();
    const winner = records.find((r) => r.supersedesRecordId === originId);
    expect(winner).toBeDefined();
    expect(origin!.supersededByRecordId).toBe(winner!.id);
  });
});
