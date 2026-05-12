/**
 * RBAC matrix + REST authz tests for WS-4 issue custom fields.
 *
 * REST endpoint: GET /api/issues/:id/custom-fields
 *   - unauthenticated (type=none) → 401
 *   - board user in company → 200
 *   - board user NOT in company → 403
 *   - agent in company → 200
 *   - agent NOT in company → 403
 *
 * RPC host-service issueCustomFields:
 *   - set requires issue.custom-fields.write capability
 *   - unset requires issue.custom-fields.write capability
 *   - listForIssue requires issue.custom-fields.read capability
 *   - cross-plugin enumeration boundary: listForIssue only returns own-plugin fields
 */
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildHostServices } from "../services/plugin-host-services.js";
import type { PluginEventBus } from "../services/plugin-event-bus.js";

// ---------------------------------------------------------------------------
// REST authz matrix
// ---------------------------------------------------------------------------

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  addComment: vi.fn(),
  create: vi.fn(),
  findMentionedAgents: vi.fn(),
  getByIdentifier: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
}));

const mockIssueCustomFieldService = vi.hoisted(() => ({
  listAllForIssue: vi.fn(),
  set: vi.fn(),
  unset: vi.fn(),
  listForIssue: vi.fn(),
  listForIssuesBatch: vi.fn(),
}));

function registerRestMocks() {
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
  vi.doMock("../services/issue-custom-fields.js", () => ({
    issueCustomFieldService: () => mockIssueCustomFieldService,
  }));
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
    agentService: () => ({ getById: vi.fn() }),
    documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
    executionWorkspaceService: () => ({ getById: vi.fn() }),
    feedbackService: () => ({}),
    goalService: () => ({ getById: vi.fn(), getDefaultCompanyGoal: vi.fn() }),
    heartbeatService: () => ({
      wakeup: vi.fn(),
      reportRunActivity: vi.fn(async () => undefined),
    }),
    getIssueContinuationSummaryDocument: vi.fn(async () => null),
    instanceSettingsService: () => ({
      get: vi.fn(),
      listCompanyIds: vi.fn(),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueCustomFieldService: () => mockIssueCustomFieldService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({ getById: vi.fn(), listByIds: vi.fn(async () => []) }),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
  }));
}

async function createRestApp(actor: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const baseIssue = {
  id: "issue-1",
  companyId: "company-1",
  status: "todo",
  priority: "medium",
  projectId: null,
  goalId: null,
  parentId: null,
  assigneeAgentId: null,
  assigneeUserId: null,
  createdByUserId: "user-1",
  identifier: "TST-1",
  title: "Test issue",
  executionPolicy: null,
  executionState: null,
  executionWorkspaceId: null,
  hiddenAt: null,
};

describe("GET /issues/:id/custom-fields REST authz matrix", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/issue-custom-fields.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRestMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockIssueCustomFieldService.listAllForIssue.mockResolvedValue([]);
  });

  it("returns 401 for unauthenticated actor (type=none)", async () => {
    const app = await createRestApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/issues/issue-1/custom-fields");
    expect(res.status).toBe(401);
  });

  it("returns 200 for board user in company", async () => {
    const app = await createRestApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    });
    const res = await request(app).get("/api/issues/issue-1/custom-fields");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ customFields: [] });
  });

  it("returns 403 for board user NOT in company", async () => {
    const app = await createRestApp({
      type: "board",
      userId: "user-2",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-other"],
      memberships: [{ companyId: "company-other", membershipRole: "owner", status: "active" }],
    });
    const res = await request(app).get("/api/issues/issue-1/custom-fields");
    expect(res.status).toBe(403);
  });

  it("returns 200 for agent in the same company", async () => {
    const app = await createRestApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });
    const res = await request(app).get("/api/issues/issue-1/custom-fields");
    expect(res.status).toBe(200);
  });

  it("returns 403 for agent in a different company", async () => {
    const app = await createRestApp({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-other",
      source: "agent_key",
    });
    const res = await request(app).get("/api/issues/issue-1/custom-fields");
    expect(res.status).toBe(403);
  });

  it("returns 200 for local_implicit board (instance admin, no companyIds check)", async () => {
    const app = await createRestApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app).get("/api/issues/issue-1/custom-fields");
    expect(res.status).toBe(200);
  });

  it("returns 404 when issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);
    const app = await createRestApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    });
    const res = await request(app).get("/api/issues/issue-99/custom-fields");
    expect(res.status).toBe(404);
  });

  it("returns fields grouped across all plugins for board user", async () => {
    mockIssueCustomFieldService.listAllForIssue.mockResolvedValue([
      { pluginId: "plugin-a", pluginKey: "a", pluginDisplayName: "Plugin A", key: "score", type: "number", label: "Score", valueText: "42", valueNumber: 42 },
      { pluginId: "plugin-b", pluginKey: "b", pluginDisplayName: "Plugin B", key: "status", type: "text", label: "Status", valueText: "open", valueNumber: null },
    ]);
    const app = await createRestApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    });
    const res = await request(app).get("/api/issues/issue-1/custom-fields");
    expect(res.status).toBe(200);
    expect(res.body.customFields).toHaveLength(2);
    expect(res.body.customFields[0].pluginDisplayName).toBe("Plugin A");
    expect(res.body.customFields[1].pluginDisplayName).toBe("Plugin B");
  });
});

// ---------------------------------------------------------------------------
// RPC capability-gating matrix (tests against buildHostServices directly)
// ---------------------------------------------------------------------------

function makeStubDb(pluginRow: {
  id: string;
  pluginKey: string;
  manifestJson: Record<string, unknown>;
} | null = null) {
  const pluginRows = pluginRow ? [pluginRow] : [];
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => pluginRows),
          then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn(pluginRows)),
        })),
        innerJoin: vi.fn(() => ({
          where: vi.fn(async () => []),
        })),
        then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn(pluginRows)),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => []),
        })),
      })),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            for: vi.fn(() => ({
              limit: vi.fn(async () => [{ id: "issue-1" }]),
            })),
          })),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => undefined),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    })),
  } as unknown as import("@paperclipai/db").Db;
}

function makeEventBus(): PluginEventBus {
  return {
    forPlugin: vi.fn(() => ({
      emit: vi.fn(),
      on: vi.fn(() => ({ unsubscribe: vi.fn() })),
      clear: vi.fn(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
    })),
    emit: vi.fn(),
    on: vi.fn(() => ({ unsubscribe: vi.fn() })),
    clearPlugin: vi.fn(),
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  } as unknown as PluginEventBus;
}

describe("RPC issueCustomFields capability gating", () => {
  const companyId = "company-1";
  const issueId = "issue-1";
  const pluginId = "plugin-a";
  const pluginKey = "paperclip.example";

  it("set() throws when plugin lacks issue.custom-fields.write capability", async () => {
    const db = makeStubDb({
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: [],
        customFields: [{ key: "score", label: "Score", type: "number" }],
      },
    });
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await expect(
      svc.issueCustomFields.set({ companyId, issueId, key: "score", value: "10" }),
    ).rejects.toThrow(/issue.custom-fields.write/);
    svc.dispose();
  });

  it("set() succeeds when plugin has issue.custom-fields.write capability", async () => {
    const db = makeStubDb({
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: ["issue.custom-fields.write"],
        customFields: [{ key: "score", label: "Score", type: "number" }],
      },
    });
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await expect(
      svc.issueCustomFields.set({ companyId, issueId, key: "score", value: "10" }),
    ).resolves.toBeUndefined();
    svc.dispose();
  });

  it("unset() throws when plugin lacks issue.custom-fields.write capability", async () => {
    const db = makeStubDb({
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: [],
        customFields: [{ key: "score", label: "Score", type: "number" }],
      },
    });
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await expect(
      svc.issueCustomFields.unset({ companyId, issueId, key: "score" }),
    ).rejects.toThrow(/issue.custom-fields.write/);
    svc.dispose();
  });

  it("unset() succeeds when plugin has issue.custom-fields.write capability", async () => {
    const db = makeStubDb({
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: ["issue.custom-fields.write"],
        customFields: [{ key: "score", label: "Score", type: "number" }],
      },
    });
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await expect(
      svc.issueCustomFields.unset({ companyId, issueId, key: "score" }),
    ).resolves.toBeUndefined();
    svc.dispose();
  });

  it("listForIssue() throws when plugin lacks issue.custom-fields.read capability", async () => {
    const db = makeStubDb({
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: [],
        customFields: [],
      },
    });
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await expect(
      svc.issueCustomFields.listForIssue({ companyId, issueId }),
    ).rejects.toThrow(/issue.custom-fields.read/);
    svc.dispose();
  });

  it("listForIssue() succeeds when plugin has issue.custom-fields.read capability", async () => {
    const db = makeStubDb({
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: ["issue.custom-fields.read"],
        customFields: [],
      },
    });
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await expect(
      svc.issueCustomFields.listForIssue({ companyId, issueId }),
    ).resolves.toBeInstanceOf(Array);
    svc.dispose();
  });

  it("listForIssue() queries the DB scoped to the calling plugin's ID (cross-plugin isolation)", async () => {
    const pluginRow = {
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: ["issue.custom-fields.read"],
        customFields: [],
      },
    };
    const dbWithSpy = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            // registry.getById: returns the pluginRow with read capability
            then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn([pluginRow])),
            // listForIssue service: returns no custom field rows
            limit: vi.fn(async () => []),
          })),
          innerJoin: vi.fn(() => ({
            where: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})),
    } as unknown as import("@paperclipai/db").Db;

    const svc = buildHostServices(dbWithSpy, pluginId, pluginKey, makeEventBus());
    const result = await svc.issueCustomFields.listForIssue({ companyId, issueId });
    // Every returned field must belong to the calling plugin
    for (const field of result) {
      expect(field.pluginKey).toBe(pluginKey);
    }
    svc.dispose();
  });

  it("plugin with only read capability cannot call set()", async () => {
    const db = makeStubDb({
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: ["issue.custom-fields.read"],
        customFields: [{ key: "score", label: "Score", type: "number" }],
      },
    });
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await expect(
      svc.issueCustomFields.set({ companyId, issueId, key: "score", value: "5" }),
    ).rejects.toThrow(/issue.custom-fields.write/);
    svc.dispose();
  });

  it("plugin with only write capability cannot call listForIssue()", async () => {
    const db = makeStubDb({
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: ["issue.custom-fields.write"],
        customFields: [],
      },
    });
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await expect(
      svc.issueCustomFields.listForIssue({ companyId, issueId }),
    ).rejects.toThrow(/issue.custom-fields.read/);
    svc.dispose();
  });
});

// ---------------------------------------------------------------------------
// Registry lookup deduplication — set() and listForIssue() must call
// registry.getById exactly once (not once in ensurePluginCapability + again
// for manifest/displayName lookup).
// ---------------------------------------------------------------------------

describe("issueCustomFields registry.getById deduplication", () => {
  const companyId = "company-1";
  const issueId = "issue-1";
  const pluginId = "plugin-a";
  const pluginKey = "paperclip.example";

  function makeSpyDb() {
    let selectCallCount = 0;
    const pluginRow = {
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: ["issue.custom-fields.write", "issue.custom-fields.read"],
        customFields: [{ key: "score", label: "Score", type: "number" }],
      },
    };
    const db = {
      select: vi.fn(() => {
        selectCallCount++;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [pluginRow]),
              then: (fn: (rows: unknown[]) => unknown) => Promise.resolve(fn([pluginRow])),
            })),
            innerJoin: vi.fn(() => ({
              where: vi.fn(async () => []),
            })),
          })),
        };
      }),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              for: vi.fn(() => ({
                limit: vi.fn(async () => [{ id: issueId }]),
              })),
            })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(async () => undefined),
          })),
        })),
        insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      })),
    } as unknown as import("@paperclipai/db").Db;
    return { db, getSelectCallCount: () => selectCallCount };
  }

  it("set() calls registry.getById exactly once (not twice)", async () => {
    const { db, getSelectCallCount } = makeSpyDb();
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await svc.issueCustomFields.set({ companyId, issueId, key: "score", value: "10" });
    // ensurePluginCapability fetches row once; set() must reuse it, not call again
    expect(getSelectCallCount()).toBe(1);
    svc.dispose();
  });

  it("listForIssue() calls registry.getById exactly once (not twice)", async () => {
    const { db, getSelectCallCount } = makeSpyDb();
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await svc.issueCustomFields.listForIssue({ companyId, issueId });
    // ensurePluginCapability fetches row once (select #1); listForIssue data query is select #2.
    // Before fix: 3 selects (cap check + manifest lookup + data). After fix: 2.
    expect(getSelectCallCount()).toBe(2);
    svc.dispose();
  });
});

// ---------------------------------------------------------------------------
// Activity-log suppression on no-op unset
// ---------------------------------------------------------------------------

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

describe("issueCustomFields.unset() activity-log suppression", () => {
  const companyId = "company-1";
  const issueId = "issue-1";
  const pluginId = "plugin-a";
  const pluginKey = "paperclip.example";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT emit activity log when unset is a no-op (field does not exist)", async () => {
    const db = makeStubDb({
      id: pluginId,
      pluginKey,
      manifestJson: {
        id: pluginKey,
        displayName: "Example",
        capabilities: ["issue.custom-fields.write"],
        customFields: [],
      },
    });
    const svc = buildHostServices(db, pluginId, pluginKey, makeEventBus());
    await svc.issueCustomFields.unset({ companyId, issueId, key: "nonexistent" });
    // logActivity must not have been called
    expect(mockLogActivity).not.toHaveBeenCalled();
    svc.dispose();
  });
});
