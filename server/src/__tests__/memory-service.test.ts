import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
  memoryBindings,
  memoryBindingTargets,
  memoryOperations,
  type MemoryBindingConfig,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { memoryService } from "../services/memory/index.ts";
import type {
  MemoryProvider,
  MemoryProviderCaptureRequest,
  MemoryProviderQueryRequest,
  MemorySnippet,
} from "../services/memory/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres memory service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function stubProvider(overrides: Partial<MemoryProvider> = {}) {
  const queryCalls: MemoryProviderQueryRequest[] = [];
  const captureCalls: MemoryProviderCaptureRequest[] = [];
  const provider: MemoryProvider = {
    key: "stub",
    isAvailable: async () => true,
    query: async (req) => {
      queryCalls.push(req);
      return { ok: true, value: { snippets: [] }, latencyMs: 5 };
    },
    capture: async (req) => {
      captureCalls.push(req);
      return { ok: true, value: { slug: req.slug }, latencyMs: 7 };
    },
    get: async (slug) => ({ ok: true, value: { slug }, latencyMs: 1 }),
    forget: async (slug) => ({ ok: true, value: { slug }, latencyMs: 1 }),
    ...overrides,
  };
  return { provider, queryCalls, captureCalls };
}

function snippetsProvider(snippets: MemorySnippet[]) {
  const queryCalls: MemoryProviderQueryRequest[] = [];
  const stub = stubProvider({
    query: async (req) => {
      queryCalls.push(req);
      return { ok: true, value: { snippets }, latencyMs: 12 };
    },
  });
  return { ...stub, queryCalls };
}

describeEmbeddedPostgres("memoryService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-memory-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(memoryOperations);
    await db.delete(memoryBindingTargets);
    await db.delete(memoryBindings);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(issuePrefix?: string) {
    const companyId = randomUUID();
    const prefix = issuePrefix ?? `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return { companyId, prefix };
  }

  async function seedAgent(companyId: string, name = "Memory Coder") {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId });
    return runId;
  }

  async function seedIssue(companyId: string, identifier: string, title = "Fix recovery stalls") {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title, identifier });
    return issueId;
  }

  async function seedBinding(
    companyId: string,
    config: MemoryBindingConfig = {},
    target: { targetType: "company" | "agent"; targetId: string } = {
      targetType: "company",
      targetId: companyId,
    },
    key = "default",
  ) {
    const bindingId = randomUUID();
    await db.insert(memoryBindings).values({
      id: bindingId,
      companyId,
      key,
      provider: "gbrain",
      config,
      enabled: true,
    });
    await db.insert(memoryBindingTargets).values({
      companyId,
      targetType: target.targetType,
      targetId: target.targetId,
      bindingId,
    });
    return bindingId;
  }

  describe("resolveBinding", () => {
    it("auto-bootstraps a company default binding when the provider is available", async () => {
      const { companyId } = await seedCompany();
      const { provider } = stubProvider();
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      const binding = await svc.resolveBinding(companyId);

      expect(binding).toMatchObject({
        companyId,
        key: "default",
        provider: "gbrain",
        enabled: true,
      });
      const targets = await db
        .select()
        .from(memoryBindingTargets)
        .where(eq(memoryBindingTargets.companyId, companyId));
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ targetType: "company", targetId: companyId });

      const activity = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.companyId, companyId));
      expect(activity.filter((row) => row.action === "memory.binding_created")).toHaveLength(1);

      const again = await svc.resolveBinding(companyId);
      expect(again?.id).toBe(binding?.id);
      const activityAfter = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.companyId, companyId));
      expect(activityAfter.filter((row) => row.action === "memory.binding_created")).toHaveLength(1);
    });

    it("does not auto-bootstrap an injected provider unless explicitly enabled", async () => {
      const { companyId } = await seedCompany();
      const { provider } = stubProvider();
      const svc = memoryService(db, { providerFactory: () => provider });

      expect(await svc.resolveBinding(companyId)).toBeNull();
      expect(await db.select().from(memoryBindings).where(eq(memoryBindings.companyId, companyId))).toHaveLength(0);
    });

    it("returns null when no binding exists and the provider is unavailable", async () => {
      const { companyId } = await seedCompany();
      const { provider } = stubProvider({ isAvailable: async () => false });
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      expect(await svc.resolveBinding(companyId)).toBeNull();
      expect(await db.select().from(memoryBindings).where(eq(memoryBindings.companyId, companyId))).toHaveLength(0);
    });

    it("prefers an agent-target binding over the company default", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const companyBindingId = await seedBinding(companyId);
      const agentBindingId = await seedBinding(
        companyId,
        {},
        { targetType: "agent", targetId: agentId },
        "agent-override",
      );
      const { provider } = stubProvider();
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      expect((await svc.resolveBinding(companyId, agentId))?.id).toBe(agentBindingId);
      expect((await svc.resolveBinding(companyId))?.id).toBe(companyBindingId);
    });
  });

  describe("hydrateForRun", () => {
    it("formats an advisory markdown bundle and records a succeeded operation", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId);
      const issueId = await seedIssue(companyId, `MEM-${randomUUID().slice(0, 8)}`);
      const { provider, queryCalls } = snippetsProvider([
        { slug: "projects/alpha", text: "Alpha project context", score: 0.87 },
        { slug: "notes/beta", text: "Beta\n  notes", score: null },
      ]);
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      const markdown = await svc.hydrateForRun({
        companyId,
        agentId,
        runId,
        issue: {
          id: issueId,
          identifier: "MEM-1",
          title: "Fix recovery stalls",
          description: "Long description of the stall",
        },
        wakeReason: "issue_assigned",
        wakeCommentBody: "Please pick this up",
      });

      expect(markdown).toContain("## Remembered context (advisory)");
      expect(markdown).toContain("possibly stale");
      expect(markdown).toContain("- [projects/alpha] (0.87) — Alpha project context");
      expect(markdown).toContain("- [notes/beta] — Beta notes");

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].query).toContain("MEM-1");
      expect(queryCalls[0].query).toContain("Fix recovery stalls");
      expect(queryCalls[0].query).toContain("issue_assigned");
      expect(queryCalls[0].companyId).toBe(companyId);
      expect(queryCalls[0].topK).toBe(5);
      expect(queryCalls[0].timeoutMs).toBe(4000);

      const ops = await db
        .select()
        .from(memoryOperations)
        .where(eq(memoryOperations.companyId, companyId));
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        operation: "query",
        hookKind: "pre_run_hydrate",
        intent: "agent_preamble",
        status: "succeeded",
        agentId,
        issueId,
        heartbeatRunId: runId,
      });
      expect(ops[0].resultJson).toMatchObject({
        count: 2,
        snippets: [
          { slug: "projects/alpha", score: 0.87 },
          { slug: "notes/beta", score: null },
        ],
      });
      // operation log stores slugs/scores, never chunk text
      expect(JSON.stringify(ops[0].resultJson)).not.toContain("Alpha project context");
      expect(ops[0].usageJson).toMatchObject({ latencyMs: 12, attributionMode: "included_in_run" });
      expect((ops[0].requestJson as { topK: number }).topK).toBe(5);
    });

    it("returns null but records a succeeded operation when no snippets match", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId);
      const { provider } = stubProvider();
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      const markdown = await svc.hydrateForRun({
        companyId,
        agentId,
        runId,
        issue: { id: null, identifier: null, title: "Anything", description: null },
      });

      expect(markdown).toBeNull();
      const ops = await db
        .select()
        .from(memoryOperations)
        .where(eq(memoryOperations.companyId, companyId));
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ status: "succeeded", hookKind: "pre_run_hydrate" });
      expect(ops[0].resultJson).toMatchObject({ count: 0 });
    });

    it("applies snippet and bundle character caps from the binding config", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId);
      await seedBinding(companyId, { maxSnippetChars: 20, maxBundleChars: 320 });
      const longText = "x".repeat(100);
      const { provider } = snippetsProvider(
        ["s1", "s2", "s3", "s4", "s5"].map((slug) => ({ slug, text: longText })),
      );
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      const markdown = await svc.hydrateForRun({
        companyId,
        agentId,
        runId,
        issue: { id: null, identifier: null, title: "Caps", description: null },
      });

      expect(markdown).toBeTruthy();
      expect(markdown).toContain(`- [s1] — ${"x".repeat(20)}…`);
      expect(markdown).toContain("[s4]");
      expect(markdown).not.toContain("[s5]");
      expect((markdown ?? "").length).toBeLessThanOrEqual(320);
    });

    it("returns null without querying when hydrate is disabled", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId);
      await seedBinding(companyId, { hydrateEnabled: false });
      const { provider, queryCalls } = stubProvider();
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      const markdown = await svc.hydrateForRun({
        companyId,
        agentId,
        runId,
        issue: { id: null, identifier: null, title: "Disabled", description: null },
      });

      expect(markdown).toBeNull();
      expect(queryCalls).toHaveLength(0);
      expect(await db.select().from(memoryOperations).where(eq(memoryOperations.companyId, companyId))).toHaveLength(0);
    });

    it("swallows provider failures and records a failed operation", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId);
      const { provider } = stubProvider({
        query: async () => ({
          ok: false,
          errorCode: "timeout",
          errorMessage: "gbrain call timed out (SIGTERM)",
          latencyMs: 4000,
        }),
      });
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      const markdown = await svc.hydrateForRun({
        companyId,
        agentId,
        runId,
        issue: { id: null, identifier: null, title: "Timeout", description: null },
      });

      expect(markdown).toBeNull();
      const ops = await db
        .select()
        .from(memoryOperations)
        .where(eq(memoryOperations.companyId, companyId));
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        status: "failed",
        hookKind: "pre_run_hydrate",
        errorMessage: "gbrain call timed out (SIGTERM)",
      });
      expect(ops[0].usageJson).toMatchObject({ latencyMs: 4000, attributionMode: "included_in_run" });
    });

    it("never throws when the provider throws", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId);
      const { provider } = stubProvider({
        query: async () => {
          throw new Error("unexpected provider crash");
        },
      });
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      const markdown = await svc.hydrateForRun({
        companyId,
        agentId,
        runId,
        issue: { id: null, identifier: null, title: "Crash", description: null },
      });

      expect(markdown).toBeNull();
      const ops = await db
        .select()
        .from(memoryOperations)
        .where(eq(memoryOperations.companyId, companyId));
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ status: "failed" });
      expect(ops[0].errorMessage).toContain("unexpected provider crash");
    });
  });

  describe("captureRunCompletion", () => {
    it("writes a namespaced page with company/agent tags and records the operation", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId, "Memory Coder");
      const runId = await seedRun(companyId, agentId);
      const identifier = `MEM-${randomUUID().slice(0, 8)}`;
      const issueId = await seedIssue(companyId, identifier, "Ship memory plane");
      const { provider, captureCalls } = stubProvider();
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      await svc.captureRunCompletion({
        run: {
          id: runId,
          companyId,
          startedAt: new Date("2026-06-10T01:00:00.000Z"),
          finishedAt: new Date("2026-06-10T01:05:00.000Z"),
        },
        agent: { id: agentId, name: "Memory Coder" },
        issueRef: { id: issueId, identifier, title: "Ship memory plane" },
        outcome: "succeeded",
        status: "completed",
        resultJson: { summary: "Implemented the memory control plane" },
      });

      expect(captureCalls).toHaveLength(1);
      const capture = captureCalls[0];
      expect(capture.companyId).toBe(companyId);
      expect(capture.slug).toBe(`paperclip/companies/${companyId}/runs/${runId}`);
      expect(capture.tags).toEqual([
        "paperclip",
        `company:${companyId}`,
        "agent:memory-coder",
        "kind:run-capture",
      ]);
      expect(capture.content).toContain("Implemented the memory control plane");
      expect(capture.content).toContain("- Outcome: succeeded");
      expect(capture.content).toContain(identifier);
      expect(capture.content).toContain("- Started: 2026-06-10T01:00:00.000Z");
      expect(capture.timeoutMs).toBe(15000);

      const ops = await db
        .select()
        .from(memoryOperations)
        .where(eq(memoryOperations.companyId, companyId));
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        operation: "capture",
        hookKind: "post_run_capture",
        status: "succeeded",
        agentId,
        issueId,
        heartbeatRunId: runId,
      });
      expect(ops[0].requestJson).toMatchObject({ slug: capture.slug });
      expect(ops[0].resultJson).toMatchObject({ slug: capture.slug });
      expect(ops[0].usageJson).toMatchObject({ latencyMs: 7, attributionMode: "included_in_run" });
    });

    it("skips capture when captureRunsEnabled is false", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId);
      await seedBinding(companyId, { captureRunsEnabled: false });
      const { provider, captureCalls } = stubProvider();
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      await svc.captureRunCompletion({
        run: { id: runId, companyId },
        agent: { id: agentId, name: "Memory Coder" },
        outcome: "succeeded",
        status: "completed",
        resultJson: { summary: "should not be captured" },
      });

      expect(captureCalls).toHaveLength(0);
      expect(await db.select().from(memoryOperations).where(eq(memoryOperations.companyId, companyId))).toHaveLength(0);
    });

    it("records a failed operation when the provider write fails", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId);
      const { provider } = stubProvider({
        capture: async () => ({
          ok: false,
          errorCode: "exec_failed",
          errorMessage: "embeddings model missing",
          latencyMs: 12,
        }),
      });
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      await svc.captureRunCompletion({
        run: { id: runId, companyId },
        agent: { id: agentId, name: "Memory Coder" },
        outcome: "failed",
        status: "failed",
        resultJson: { error: "adapter exploded" },
      });

      const ops = await db
        .select()
        .from(memoryOperations)
        .where(eq(memoryOperations.companyId, companyId));
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        operation: "capture",
        hookKind: "post_run_capture",
        status: "failed",
        errorMessage: "embeddings model missing",
      });
    });

    it("records a failed operation when the provider is unavailable", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId);
      await seedBinding(companyId);
      const { provider, captureCalls } = stubProvider({ isAvailable: async () => false });
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      await svc.captureRunCompletion({
        run: { id: runId, companyId },
        agent: { id: agentId, name: "Memory Coder" },
        outcome: "failed",
        status: "failed",
        resultJson: { error: "adapter exploded" },
      });

      expect(captureCalls).toHaveLength(0);
      const ops = await db
        .select()
        .from(memoryOperations)
        .where(eq(memoryOperations.companyId, companyId));
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        operation: "capture",
        hookKind: "post_run_capture",
        status: "failed",
        errorMessage: "memory_provider_unavailable",
      });
      expect(ops[0].usageJson).toMatchObject({ latencyMs: 0, attributionMode: "included_in_run" });
    });
  });

  describe("getOverview", () => {
    it("reports binding, provider availability, and 24h stats", async () => {
      const { companyId } = await seedCompany();
      const agentId = await seedAgent(companyId);
      const runId = await seedRun(companyId, agentId);
      const bindingId = await seedBinding(companyId);
      const now = Date.now();
      await db.insert(memoryOperations).values([
        {
          companyId,
          bindingId,
          operation: "query",
          hookKind: "pre_run_hydrate",
          intent: "agent_preamble",
          status: "succeeded",
          agentId,
          heartbeatRunId: runId,
          createdAt: new Date(now - 60_000),
        },
        {
          companyId,
          bindingId,
          operation: "capture",
          hookKind: "post_run_capture",
          status: "succeeded",
          agentId,
          heartbeatRunId: runId,
          createdAt: new Date(now - 30_000),
        },
        {
          companyId,
          bindingId,
          operation: "query",
          intent: "browse",
          status: "failed",
          errorMessage: "boom",
          createdAt: new Date(now - 10_000),
        },
        {
          companyId,
          bindingId,
          operation: "query",
          hookKind: "pre_run_hydrate",
          status: "failed",
          createdAt: new Date(now - 48 * 60 * 60 * 1000),
        },
      ]);
      const { provider } = stubProvider();
      const svc = memoryService(db, { providerFactory: () => provider, autoBootstrap: true });

      const overview = await svc.getOverview(companyId);

      expect(overview.binding?.id).toBe(bindingId);
      expect(overview.providerAvailable).toBe(true);
      expect(overview.stats.opsLast24h).toBe(3);
      expect(overview.stats.failuresLast24h).toBe(1);
      expect(overview.stats.lastHydrateAt?.getTime()).toBe(new Date(now - 60_000).getTime());
      expect(overview.stats.lastCaptureAt?.getTime()).toBe(new Date(now - 30_000).getTime());
    });
  });

  describe("updateBinding", () => {
    it("creates the default binding and company target when none exists", async () => {
      const { companyId } = await seedCompany();
      const { provider } = stubProvider({ isAvailable: async () => false });
      const svc = memoryService(db, { providerFactory: () => provider });

      const binding = await svc.updateBinding(
        companyId,
        { enabled: false, config: { topK: 7 } },
        { actorUserId: "operator-1" },
      );

      expect(binding).toMatchObject({
        companyId,
        key: "default",
        provider: "gbrain",
        enabled: false,
        config: { topK: 7 },
      });
      const targets = await db
        .select()
        .from(memoryBindingTargets)
        .where(eq(memoryBindingTargets.companyId, companyId));
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        targetType: "company",
        targetId: companyId,
        bindingId: binding?.id,
      });
      const activity = await db
        .select()
        .from(activityLog)
        .where(eq(activityLog.companyId, companyId));
      expect(activity.map((row) => row.action)).toContain("memory.binding_created");
    });
  });
});
