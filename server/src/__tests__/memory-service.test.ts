import { describe, expect, it, vi } from "vitest";
import { memoryService } from "../services/memory.js";

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
              returning: vi.fn().mockResolvedValue(updateResults.shift() ?? []),
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
      metadata: {
        extraction: {
          mode: "paperclip_managed",
          harness: "server_worker",
          jobId: "88888888-8888-4888-8888-888888888888",
        },
      },
    });
    expect(updatedValues[0]).toMatchObject({
      status: "succeeded",
      operationId: "77777777-7777-4777-8777-777777777777",
      resultJson: {
        hookKind: "issue_comment_capture",
        recordIds: ["44444444-4444-4444-8444-444444444444"],
      },
    });
  });
});
