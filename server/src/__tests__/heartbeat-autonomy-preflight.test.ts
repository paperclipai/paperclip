import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentRuntimeState, agentWakeupRequests, agents, autonomyEvidenceEntries, autonomyRunTransitions, companies, companySkills, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: vi.fn(),
  listAdapterModelProfiles: vi.fn(() => []),
  runningProcesses: new Map(),
}));

import { buildHeartbeatAutonomyPreflightRequest, heartbeatService, type HeartbeatEvidenceBridge } from "../services/heartbeat.ts";
import { autonomyKernelService } from "../services/autonomy-kernel/index.js";
import { getServerAdapter } from "../adapters/index.js";
import type { ExtractedEvidenceInput } from "../services/autonomy-kernel/evidence-extractors.js";
import type { EvidenceValidationResult } from "../services/autonomy-kernel/validators.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat autonomy preflight tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("heartbeat autonomy preflight helper", () => {
  it("maps wake context into kernel preflight request fields", () => {
    const request = buildHeartbeatAutonomyPreflightRequest({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_board_wakeup",
      issueId: "issue-1",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
      contextSnapshot: {
        laneKey: "build",
        governedAction: "deploy",
        projectWorkspaceId: "workspace-1",
        taskKey: "TASK-1",
      },
    });

    expect(request).toMatchObject({
      companyId: "company-1",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
      laneKey: "build",
      governedAction: "deploy",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
      requiresWorkspace: true,
    });
    expect(request.metadata).toMatchObject({
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_board_wakeup",
      laneKey: "build",
      workspaceId: "workspace-1",
      taskKey: "TASK-1",
      governedAction: "deploy",
    });
  });
});

describeEmbeddedPostgres("heartbeat autonomy preflight integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-autonomy-preflight-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(autonomyEvidenceEntries);
    await db.delete(autonomyRunTransitions);
    await db.delete(activityLog);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      try {
        await db.delete(heartbeatRuns);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
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
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  function buildKernelWithAllowedPreflight() {
    const kernel = autonomyKernelService(db);
    return {
      ...kernel,
      preflightRun: vi.fn().mockResolvedValue({
        status: "allow" as const,
        reason: null,
        incidentIds: [],
        approvalGateIds: [],
      }),
      recordTransition: vi.fn(async (input) => {
        const now = input.transitionedAt ?? new Date();
        const [transition] = await db.insert(autonomyRunTransitions).values({
          id: randomUUID(),
          companyId: input.companyId,
          runId: input.runId,
          issueId: input.issueId ?? null,
          agentId: input.agentId ?? null,
          laneKey: input.laneKey ?? null,
          fromState: input.fromState,
          toState: input.toState,
          terminalClassification: input.terminalClassification ?? null,
          reason: input.reason ?? null,
          actorType: input.actorType ?? "kernel",
          actorId: input.actorId ?? null,
          evidenceEntryIds: input.evidenceEntryIds ?? [],
          incidentIds: input.incidentIds ?? [],
          metadata: input.metadata ?? null,
          transitionedAt: now,
          createdAt: now,
        }).returning();
        return {
          ...transition,
          transitionedAt: now.toISOString(),
          createdAt: now.toISOString(),
        };
      }),
    };
  }

  function mockSuccessfulAdapter(summary: string) {
    vi.mocked(getServerAdapter).mockReturnValue({
      execute: vi.fn(async (ctx) => {
        await ctx.onLog?.("stdout", `${summary}\n`);
        return {
          exitCode: 0,
          summary,
          resultJson: { summary },
        };
      }),
    } as never);
  }

  function evidenceCandidate(overrides: Partial<ExtractedEvidenceInput> = {}): ExtractedEvidenceInput {
    return {
      companyId: overrides.companyId ?? randomUUID(),
      runId: overrides.runId ?? null,
      issueId: overrides.issueId ?? null,
      agentId: overrides.agentId ?? null,
      laneKey: overrides.laneKey ?? "build",
      type: overrides.type ?? "test_run",
      title: overrides.title ?? "Candidate test run: pnpm test",
      summary: overrides.summary ?? null,
      uri: overrides.uri ?? null,
      sourceType: overrides.sourceType ?? "heartbeat_run_event",
      sourceId: overrides.sourceId ?? overrides.runId ?? null,
      payload: overrides.payload ?? { command: "pnpm test", trustedExitCode: 0, resultText: "passed" },
    };
  }

  function evidenceBridgeFor(input: {
    candidates: ExtractedEvidenceInput[];
    verdict: EvidenceValidationResult;
  }): HeartbeatEvidenceBridge {
    return {
      extractEvidenceCandidates: vi.fn((source) => source.sourceKind === "run"
        ? input.candidates.map((candidate) => ({
          ...candidate,
          companyId: source.companyId,
          runId: source.runId,
          issueId: source.issueId ?? null,
          agentId: source.agentId ?? null,
          laneKey: source.laneKey ?? null,
          sourceId: source.sourceId ?? source.runId,
        }))
        : []),
      validateEvidenceCandidate: vi.fn().mockResolvedValue(input.verdict),
    };
  }

  async function runHeartbeatToTerminal(input: { evidenceBridge?: HeartbeatEvidenceBridge; summary?: string }) {
    const { companyId, agentId } = await seedCompanyAndAgent();
    mockSuccessfulAdapter(input.summary ?? "pnpm test passed");
    const heartbeat = heartbeatService(db, {
      autonomyKernel: buildKernelWithAllowedPreflight(),
      evidenceBridge: input.evidenceBridge,
    });
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_board_wakeup",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
      contextSnapshot: { laneKey: "build" },
    });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const transitions = await db.select().from(autonomyRunTransitions).where(eq(autonomyRunTransitions.runId, run!.id));
      expect(transitions.some((transition) => transition.toState === "terminal")).toBe(true);
    }, { timeout: 5_000 });
    const transitions = await db.select().from(autonomyRunTransitions).where(eq(autonomyRunTransitions.runId, run!.id));
    const terminal = transitions.find((transition) => transition.toState === "terminal");
    expect(terminal).toBeTruthy();
    return { companyId, agentId, run: run!, terminal: terminal! };
  }

  it("skips wakeup and does not create a run when kernel preflight blocks", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });

    const preflightRun = vi.fn().mockResolvedValue({
      status: "blocked" as const,
      reason: "lane stopped",
      incidentIds: ["incident-1"],
      approvalGateIds: [],
    });
    const heartbeat = heartbeatService(db, { autonomyKernel: { preflightRun } });

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_board_wakeup",
      requestedByActorType: "user",
      requestedByActorId: "user-1",
      contextSnapshot: { laneKey: "build" },
    });

    expect(run).toBeNull();
    expect(preflightRun).toHaveBeenCalledWith(expect.objectContaining({
      companyId,
      agentId,
      laneKey: "build",
    }));

    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(0);

    const requests = await db.select().from(agentWakeupRequests);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "manual",
      status: "skipped",
      reason: "autonomy_preflight.blocked",
    });
    expect(requests[0]?.payload).toMatchObject({
      autonomyPreflight: {
        status: "blocked",
        reason: "lane stopped",
        incidentIds: ["incident-1"],
        approvalGateIds: [],
      },
    });
  });

  it("records succeeded_with_evidence when heartbeat success has accepted evidence", async () => {
    const bridge = evidenceBridgeFor({
      candidates: [evidenceCandidate()],
      verdict: {
        verdict: "accepted",
        reason: "trusted test evidence accepted",
        validatorName: "test-validator",
        validatorVersion: "test.v1",
        validatorPayload: { trusted: true },
      },
    });

    const { terminal, run } = await runHeartbeatToTerminal({ evidenceBridge: bridge });

    expect(terminal.terminalClassification).toBe("succeeded_with_evidence");
    expect(terminal.evidenceEntryIds).toHaveLength(1);
    const entries = await db.select().from(autonomyEvidenceEntries).where(eq(autonomyEvidenceEntries.runId, run.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "accepted", verdict: "accepted", validatorName: "test-validator" });
  });

  it("records failed_no_evidence when heartbeat success has no evidence candidates", async () => {
    const bridge = evidenceBridgeFor({
      candidates: [],
      verdict: {
        verdict: "accepted",
        reason: "unused",
        validatorName: "unused",
        validatorVersion: "unused",
      },
    });

    const { terminal, run } = await runHeartbeatToTerminal({ evidenceBridge: bridge, summary: "clean heartbeat success" });

    expect(terminal.terminalClassification).toBe("failed_no_evidence");
    expect(terminal.evidenceEntryIds).toEqual([]);
    const entries = await db.select().from(autonomyEvidenceEntries).where(eq(autonomyEvidenceEntries.runId, run.id));
    expect(entries).toHaveLength(0);
  });

  it("records failed_invalid_evidence when heartbeat success only has rejected evidence", async () => {
    const bridge = evidenceBridgeFor({
      candidates: [evidenceCandidate({ payload: { command: "pnpm test", trustedExitCode: 1, resultText: "failed" } })],
      verdict: {
        verdict: "rejected",
        reason: "trusted metadata did not indicate success",
        validatorName: "test-validator",
        validatorVersion: "test.v1",
      },
    });

    const { terminal, run } = await runHeartbeatToTerminal({ evidenceBridge: bridge });

    expect(terminal.terminalClassification).toBe("failed_invalid_evidence");
    expect(terminal.evidenceEntryIds).toHaveLength(1);
    const entries = await db.select().from(autonomyEvidenceEntries).where(eq(autonomyEvidenceEntries.runId, run.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "rejected", verdict: "rejected", validatorName: "test-validator" });
  });
});
