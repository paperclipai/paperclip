import { describe, expect, it, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// We test memory-hooks at the unit level by mocking the DB layer and the
// adapter registry. The service resolves bindings → looks up adapters →
// calls adapter.query / adapter.write, all of which we intercept.
// ---------------------------------------------------------------------------

// Mock getMemoryAdapter from memory-operations
const mockGetMemoryAdapter = vi.fn();
vi.mock("../services/memory-operations.js", () => ({
  getMemoryAdapter: (...args: unknown[]) => mockGetMemoryAdapter(...args),
  getRegisteredMemoryAdapters: () => [],
}));

// Mock logger to suppress output
vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Fake DB layer
// ---------------------------------------------------------------------------

interface FakeRow {
  [key: string]: unknown;
}

function createFakeDb(opts: {
  targets?: FakeRow[];
  bindings?: FakeRow[];
}) {
  const { targets = [], bindings = [] } = opts;

  const insertedOps: FakeRow[] = [];

  // Track which select call we're on: first = targets, second = bindings
  let selectCallCount = 0;

  const fakeDb = {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      const callNum = selectCallCount;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            // First select is for targets (has .orderBy)
            if (callNum % 2 === 1) {
              return {
                orderBy: vi.fn().mockResolvedValue(targets),
              };
            }
            // Second select is for bindings (direct resolve)
            return Promise.resolve(bindings);
          }),
        }),
      };
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: FakeRow) => {
        insertedOps.push(row);
        return Promise.resolve();
      }),
    }),
    _insertedOps: insertedOps,
  };

  return fakeDb;
}

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

function createFakeAdapter(key: string, overrides?: {
  queryResult?: unknown;
  writeResult?: unknown;
  queryError?: Error;
  writeError?: Error;
}) {
  return {
    key,
    capabilities: {
      profile: false,
      browse: true,
      correction: false,
      asyncIngestion: true,
      multimodal: false,
      providerManagedExtraction: true,
    },
    query: overrides?.queryError
      ? vi.fn().mockRejectedValue(overrides.queryError)
      : vi.fn().mockResolvedValue(overrides?.queryResult ?? {
          snippets: [
            {
              handle: { providerKey: key, providerRecordId: "rec-1" },
              text: "Some remembered context",
              score: 0.85,
              metadata: {},
            },
          ],
          profileSummary: "Agent profile from memory",
          usage: [{ provider: key, latencyMs: 42, details: {} }],
        }),
    write: overrides?.writeError
      ? vi.fn().mockRejectedValue(overrides.writeError)
      : vi.fn().mockResolvedValue(overrides?.writeResult ?? {
          records: [{ providerKey: key, providerRecordId: "new-rec-1" }],
          usage: [{ provider: key, latencyMs: 30, details: {} }],
        }),
    get: vi.fn().mockResolvedValue(null),
    forget: vi.fn().mockResolvedValue({ usage: [] }),
  };
}

// ---------------------------------------------------------------------------
// Import service under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { memoryHooksService } from "../services/memory-hooks.js";
import type { HydrateRunContextParams, CaptureRunResultParams } from "../services/memory-hooks.js";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_ID = "22222222-2222-2222-2222-222222222222";
const RUN_ID = "33333333-3333-3333-3333-333333333333";
const BINDING_ID = "44444444-4444-4444-4444-444444444444";
const BINDING_ID_2 = "55555555-5555-5555-5555-555555555555";

function makeBinding(id: string, key: string, providerKey: string, hooks: Record<string, unknown>) {
  return {
    id,
    companyId: COMPANY_ID,
    key,
    providerKey,
    pluginId: null,
    config: { hooks },
    capabilities: {},
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeTarget(bindingId: string, targetType: string, targetId: string, priority: number) {
  return {
    bindingId,
    targetType,
    targetId,
    priority,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memoryHooksService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── resolveBindingsForAgent ──────────────────────────────────────

  describe("resolveBindingsForAgent", () => {
    it("returns empty when no targets match", async () => {
      const db = createFakeDb({ targets: [], bindings: [] });
      const svc = memoryHooksService(db as any);
      const result = await svc.resolveBindingsForAgent(COMPANY_ID, AGENT_ID);
      expect(result).toEqual([]);
    });

    it("resolves agent-targeted bindings with registered adapters", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockImplementation((key: string) =>
        key === "mempalace" ? adapter : undefined,
      );

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            preRunHydrate: { enabled: true },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      const result = await svc.resolveBindingsForAgent(COMPANY_ID, AGENT_ID);

      expect(result).toHaveLength(1);
      expect(result[0].bindingKey).toBe("default");
      expect(result[0].providerKey).toBe("mempalace");
      expect(result[0].hooks.preRunHydrate?.enabled).toBe(true);
    });

    it("skips bindings with no registered adapter", async () => {
      mockGetMemoryAdapter.mockReturnValue(undefined);

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "unregistered-provider", {}),
        ],
      });

      const svc = memoryHooksService(db as any);
      const result = await svc.resolveBindingsForAgent(COMPANY_ID, AGENT_ID);

      expect(result).toEqual([]);
    });

    it("deduplicates bindings when both agent and company targets match", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockReturnValue(adapter);

      const db = createFakeDb({
        targets: [
          makeTarget(BINDING_ID, "agent", AGENT_ID, 0),
          makeTarget(BINDING_ID, "company", COMPANY_ID, 10),
        ],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {}),
        ],
      });

      const svc = memoryHooksService(db as any);
      const result = await svc.resolveBindingsForAgent(COMPANY_ID, AGENT_ID);

      expect(result).toHaveLength(1);
    });
  });

  // ── hydrateRunContext ────────────────────────────────────────────

  describe("hydrateRunContext", () => {
    const baseParams: HydrateRunContextParams = {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      taskSummary: "Fix the login bug",
    };

    it("returns empty when no bindings have hydrate enabled", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockReturnValue(adapter);

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            postRunCapture: { enabled: true },
            // preRunHydrate not set
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      const result = await svc.hydrateRunContext(baseParams);

      expect(result.bindingsQueried).toBe(0);
      expect(result.snippets).toEqual([]);
      expect(adapter.query).not.toHaveBeenCalled();
    });

    it("queries adapter with task summary and returns snippets", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockReturnValue(adapter);

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            preRunHydrate: { enabled: true, topK: 3 },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      const result = await svc.hydrateRunContext(baseParams);

      expect(result.bindingsQueried).toBe(1);
      expect(result.snippets).toHaveLength(1);
      expect(result.snippets[0].text).toBe("Some remembered context");
      expect(result.profileSummary).toBe("Agent profile from memory");

      // Verify the adapter was called with correct params
      expect(adapter.query).toHaveBeenCalledWith(
        expect.objectContaining({
          bindingKey: "default",
          scope: expect.objectContaining({
            companyId: COMPANY_ID,
            agentId: AGENT_ID,
            runId: RUN_ID,
          }),
          query: "Fix the login bug",
          topK: 3,
        }),
      );
    });

    it("uses default topK of 5 when not configured", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockReturnValue(adapter);

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            preRunHydrate: { enabled: true },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      await svc.hydrateRunContext(baseParams);

      expect(adapter.query).toHaveBeenCalledWith(
        expect.objectContaining({ topK: 5 }),
      );
    });

    it("aggregates snippets from multiple bindings", async () => {
      const adapter1 = createFakeAdapter("mempalace", {
        queryResult: {
          snippets: [
            { handle: { providerKey: "mempalace", providerRecordId: "r1" }, text: "Snippet 1", score: 0.9 },
          ],
          usage: [{ provider: "mempalace", latencyMs: 10 }],
        },
      });
      const adapter2 = createFakeAdapter("pinecone", {
        queryResult: {
          snippets: [
            { handle: { providerKey: "pinecone", providerRecordId: "r2" }, text: "Snippet 2", score: 0.8 },
          ],
          profileSummary: "From pinecone",
          usage: [{ provider: "pinecone", latencyMs: 20 }],
        },
      });

      mockGetMemoryAdapter.mockImplementation((key: string) => {
        if (key === "mempalace") return adapter1;
        if (key === "pinecone") return adapter2;
        return undefined;
      });

      const db = createFakeDb({
        targets: [
          makeTarget(BINDING_ID, "agent", AGENT_ID, 0),
          makeTarget(BINDING_ID_2, "agent", AGENT_ID, 1),
        ],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            preRunHydrate: { enabled: true },
          }),
          makeBinding(BINDING_ID_2, "secondary", "pinecone", {
            preRunHydrate: { enabled: true },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      const result = await svc.hydrateRunContext(baseParams);

      expect(result.bindingsQueried).toBe(2);
      expect(result.snippets).toHaveLength(2);
      expect(result.snippets[0].text).toBe("Snippet 1");
      expect(result.snippets[1].text).toBe("Snippet 2");
      expect(result.usage).toHaveLength(2);
    });

    it("continues with remaining bindings when one fails", async () => {
      const failingAdapter = createFakeAdapter("mempalace", {
        queryError: new Error("Connection refused"),
      });
      const workingAdapter = createFakeAdapter("pinecone");

      mockGetMemoryAdapter.mockImplementation((key: string) => {
        if (key === "mempalace") return failingAdapter;
        if (key === "pinecone") return workingAdapter;
        return undefined;
      });

      const db = createFakeDb({
        targets: [
          makeTarget(BINDING_ID, "agent", AGENT_ID, 0),
          makeTarget(BINDING_ID_2, "agent", AGENT_ID, 1),
        ],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            preRunHydrate: { enabled: true },
          }),
          makeBinding(BINDING_ID_2, "secondary", "pinecone", {
            preRunHydrate: { enabled: true },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      const result = await svc.hydrateRunContext(baseParams);

      // First binding failed, second succeeded
      expect(result.bindingsQueried).toBe(1);
      expect(result.snippets).toHaveLength(1);
      expect(result.snippets[0].handle.providerKey).toBe("pinecone");
    });

    it("uses 'agent context' as fallback query when no taskSummary", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockReturnValue(adapter);

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            preRunHydrate: { enabled: true },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      await svc.hydrateRunContext({ ...baseParams, taskSummary: undefined });

      expect(adapter.query).toHaveBeenCalledWith(
        expect.objectContaining({ query: "agent context" }),
      );
    });
  });

  // ── captureRunResult ────────────────────────────────────────────

  describe("captureRunResult", () => {
    const baseParams: CaptureRunResultParams = {
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      outcome: "succeeded",
      taskSummary: "Fix the login bug",
      agentName: "CTO",
    };

    it("returns empty when no bindings have capture enabled", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockReturnValue(adapter);

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            preRunHydrate: { enabled: true },
            // postRunCapture not set
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      const result = await svc.captureRunResult(baseParams);

      expect(result.bindingsCaptured).toBe(0);
      expect(adapter.write).not.toHaveBeenCalled();
    });

    it("writes summary content to adapter with correct source ref", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockReturnValue(adapter);

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            postRunCapture: { enabled: true },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      const result = await svc.captureRunResult(baseParams);

      expect(result.bindingsCaptured).toBe(1);
      expect(adapter.write).toHaveBeenCalledWith(
        expect.objectContaining({
          bindingKey: "default",
          scope: expect.objectContaining({
            companyId: COMPANY_ID,
            agentId: AGENT_ID,
            runId: RUN_ID,
          }),
          source: expect.objectContaining({
            kind: "run",
            companyId: COMPANY_ID,
            runId: RUN_ID,
          }),
          mode: "append",
        }),
      );

      // Content should include summary
      const callArgs = (adapter.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.content).toContain("Run succeeded");
      expect(callArgs.content).toContain("Agent: CTO");
      expect(callArgs.content).toContain("Fix the login bug");
    });

    it("includes resultJson in full capture depth", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockReturnValue(adapter);

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            postRunCapture: { enabled: true, captureDepth: "full" },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      await svc.captureRunResult({
        ...baseParams,
        resultJson: { filesChanged: 3, testsRun: 12 },
      });

      const callArgs = (adapter.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.content).toContain("### Result");
      expect(callArgs.content).toContain("filesChanged");
    });

    it("excludes resultJson in summary capture depth (default)", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockReturnValue(adapter);

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            postRunCapture: { enabled: true },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      await svc.captureRunResult({
        ...baseParams,
        resultJson: { filesChanged: 3 },
      });

      const callArgs = (adapter.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.content).not.toContain("### Result");
      expect(callArgs.content).not.toContain("filesChanged");
    });

    it("continues with remaining bindings when one write fails", async () => {
      const failingAdapter = createFakeAdapter("mempalace", {
        writeError: new Error("Write failed"),
      });
      const workingAdapter = createFakeAdapter("pinecone");

      mockGetMemoryAdapter.mockImplementation((key: string) => {
        if (key === "mempalace") return failingAdapter;
        if (key === "pinecone") return workingAdapter;
        return undefined;
      });

      const db = createFakeDb({
        targets: [
          makeTarget(BINDING_ID, "agent", AGENT_ID, 0),
          makeTarget(BINDING_ID_2, "agent", AGENT_ID, 1),
        ],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            postRunCapture: { enabled: true },
          }),
          makeBinding(BINDING_ID_2, "secondary", "pinecone", {
            postRunCapture: { enabled: true },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      const result = await svc.captureRunResult(baseParams);

      expect(result.bindingsCaptured).toBe(1);
      expect(failingAdapter.write).toHaveBeenCalled();
      expect(workingAdapter.write).toHaveBeenCalled();
    });

    it("captures failed runs", async () => {
      const adapter = createFakeAdapter("mempalace");
      mockGetMemoryAdapter.mockReturnValue(adapter);

      const db = createFakeDb({
        targets: [makeTarget(BINDING_ID, "agent", AGENT_ID, 0)],
        bindings: [
          makeBinding(BINDING_ID, "default", "mempalace", {
            postRunCapture: { enabled: true },
          }),
        ],
      });

      const svc = memoryHooksService(db as any);
      await svc.captureRunResult({ ...baseParams, outcome: "failed" });

      const callArgs = (adapter.write as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.content).toContain("Run failed");
      expect(callArgs.content).toContain("Outcome: failed");
    });
  });

  // ── No bindings at all ──────────────────────────────────────────

  describe("no-op when no bindings exist", () => {
    it("hydrate returns empty without DB errors", async () => {
      const db = createFakeDb({ targets: [], bindings: [] });
      const svc = memoryHooksService(db as any);
      const result = await svc.hydrateRunContext({
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
      });
      expect(result.bindingsQueried).toBe(0);
      expect(result.snippets).toEqual([]);
    });

    it("capture returns empty without DB errors", async () => {
      const db = createFakeDb({ targets: [], bindings: [] });
      const svc = memoryHooksService(db as any);
      const result = await svc.captureRunResult({
        companyId: COMPANY_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        outcome: "succeeded",
      });
      expect(result.bindingsCaptured).toBe(0);
    });
  });
});
