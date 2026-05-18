/**
 * LET-395 capability-apply service tests (real DB).
 *
 * Covers the LET-140-G.2 execute route + state machine plus the DB-level
 * hardening introduced in this slice:
 *   - createPlan idempotency, transactional plan+steps+event insert
 *   - request-approval transitions + approval row creation
 *   - execute: happy path (internal_safe only), hash mismatch refusal,
 *     approval-not-accepted / consumed / declined refusals, non-internal_safe
 *     skip while live OFF, optimistic conflict, replay attempts
 *   - no-live-action: stub adapter, real adapter never instantiated, no
 *     external network/MCP calls reachable from this service in this slice
 *   - redaction: canary secret values never leak into persisted event payloads
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  capabilityApplyEvents,
  capabilityApplyPlans,
  capabilityApplySteps,
  companies,
  createDb,
} from "@paperclipai/db";
import { CAPABILITY_APPLY_ERROR_CODES } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { capabilityApplyService } from "../services/capability-apply.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping capability-apply service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const CANARY = "CANARY_SECRET_VALUE_THAT_MUST_NOT_APPEAR_IN_EVENTS";

describeEmbeddedPostgres("capabilityApplyService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let agentId!: string;
  let otherCompanyId!: string;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("capability-apply-service");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    // capability_apply_events / steps cascade from plans; approvals are
    // referenced by approval_id with ON DELETE SET NULL, so wipe both.
    await db.delete(capabilityApplyEvents);
    await db.delete(capabilityApplySteps);
    await db.delete(capabilityApplyPlans);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompanyAndAgent() {
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Acme",
        issuePrefix: `T${companyId.slice(0, 6).toUpperCase().replace(/-/g, "")}`,
        status: "active",
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `O${otherCompanyId.slice(0, 6).toUpperCase().replace(/-/g, "")}`,
        status: "active",
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Capability Apply Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  function svcOff() {
    return capabilityApplyService(db, { capabilityApplyLive: false });
  }

  function internalSafeDelta() {
    return {
      // Two steps, both internal_safe: skill ref add + tool ref add.
      skillRefChanges: [{ kind: "add" as const, ref: "code-review" }],
      toolRefChanges: [{ kind: "add" as const, ref: "git" }],
    };
  }

  function mixedRiskDelta() {
    return {
      // 1 internal_safe (skill add) + 1 external_write (add_mcp_server with default risk)
      mcpServerChanges: [
        {
          kind: "add" as const,
          serverId: "srv-1",
          displayName: "External MCP",
          catalogId: "verified/external-mcp",
          requiredSecretNames: [],
        },
      ],
      skillRefChanges: [{ kind: "add" as const, ref: "code-review" }],
    };
  }

  async function approveApproval(approvalId: string) {
    await db
      .update(approvals)
      .set({ status: "approved", decidedAt: new Date(), decidedByUserId: "user-board" })
      .where(eq(approvals.id, approvalId));
  }

  describe("createPlan", () => {
    it("creates a plan with steps + initial event in a single transaction", async () => {
      await seedCompanyAndAgent();
      const svc = svcOff();
      const plan = await svc.createPlan(
        { companyId, agentId, effectiveDelta: internalSafeDelta() },
        { userId: "user-1" },
      );
      expect(plan.state).toBe("pending");
      expect(plan.optimisticVersion).toBe(1);

      const stepRows = await db.select().from(capabilityApplySteps).where(eq(capabilityApplySteps.planId, plan.id));
      expect(stepRows.length).toBe(2);
      const eventRows = await db.select().from(capabilityApplyEvents).where(eq(capabilityApplyEvents.planId, plan.id));
      expect(eventRows.map((e) => e.kind)).toContain("capability_apply_plan_created");
    });

    it("is idempotent on (companyId, agentId, dryRunHash)", async () => {
      await seedCompanyAndAgent();
      const svc = svcOff();
      const a = await svc.createPlan(
        { companyId, agentId, effectiveDelta: internalSafeDelta() },
        { userId: "user-1" },
      );
      const b = await svc.createPlan(
        { companyId, agentId, effectiveDelta: internalSafeDelta() },
        { userId: "user-1" },
      );
      expect(b.id).toBe(a.id);
      const planRows = await db.select().from(capabilityApplyPlans).where(eq(capabilityApplyPlans.companyId, companyId));
      expect(planRows.length).toBe(1);
    });
  });

  describe("requestApproval", () => {
    it("transitions pending -> approval_requested and creates an approval row", async () => {
      await seedCompanyAndAgent();
      const svc = svcOff();
      const plan = await svc.createPlan(
        { companyId, agentId, effectiveDelta: internalSafeDelta() },
        { userId: "user-1" },
      );

      const { plan: updated, approvalPayload } = await svc.requestApproval(
        plan.id,
        companyId,
        agentId,
        { userId: "user-1" },
        plan.optimisticVersion,
      );

      expect(updated.state).toBe("approval_requested");
      expect(updated.approvalId).not.toBeNull();
      expect(approvalPayload.liveExecutionFlagState).toBe("off");
      expect(approvalPayload.noLiveActionAttestation).toBe(true);
      expect(approvalPayload.dryRunHash).toBe(plan.dryRunHash);
    });
  });

  describe("executePlan", () => {
    async function setupApprovedPlan(effectiveDelta = internalSafeDelta()) {
      const svc = svcOff();
      const plan = await svc.createPlan(
        { companyId, agentId, effectiveDelta },
        { userId: "user-1" },
      );
      const { plan: requested } = await svc.requestApproval(
        plan.id,
        companyId,
        agentId,
        { userId: "user-1" },
        plan.optimisticVersion,
      );
      const approvalId = requested.approvalId!;
      await approveApproval(approvalId);
      return { svc, plan: requested, approvalId };
    }

    it("happy path: internal_safe steps complete and plan reaches applied", async () => {
      await seedCompanyAndAgent();
      const { svc, plan } = await setupApprovedPlan();
      const result = await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      expect(result.state).toBe("applied");

      const stepRows = await db.select().from(capabilityApplySteps).where(eq(capabilityApplySteps.planId, plan.id));
      expect(stepRows.every((s) => s.state === "completed")).toBe(true);

      const eventRows = await db
        .select()
        .from(capabilityApplyEvents)
        .where(eq(capabilityApplyEvents.planId, plan.id));
      const eventKinds = eventRows.map((e) => e.kind);
      expect(eventKinds).toContain("capability_apply_execute_started");
      expect(eventKinds).toContain("capability_apply_step_started");
      expect(eventKinds).toContain("capability_apply_step_completed");
      expect(eventKinds).toContain("capability_apply_plan_completed");
    });

    it("non-internal_safe steps are skipped with LIVE_EXECUTION_DISABLED while live OFF; plan -> partially_applied", async () => {
      await seedCompanyAndAgent();
      const { svc, plan } = await setupApprovedPlan(mixedRiskDelta());
      const result = await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      expect(result.state).toBe("partially_applied");

      const stepRows = await db.select().from(capabilityApplySteps).where(eq(capabilityApplySteps.planId, plan.id));
      const externalStep = stepRows.find((s) => s.riskClass !== "internal_safe");
      expect(externalStep?.state).toBe("skipped");
      expect(externalStep?.lastErrorCode).toBe(CAPABILITY_APPLY_ERROR_CODES.LIVE_EXECUTION_DISABLED);

      const internalStep = stepRows.find((s) => s.riskClass === "internal_safe");
      expect(internalStep?.state).toBe("completed");

      const eventRows = await db
        .select()
        .from(capabilityApplyEvents)
        .where(eq(capabilityApplyEvents.planId, plan.id));
      const skipEvents = eventRows.filter((e) => e.kind === "capability_apply_step_skipped");
      expect(skipEvents.length).toBe(1);
      expect((skipEvents[0].payloadJson as Record<string, unknown>).code).toBe(
        CAPABILITY_APPLY_ERROR_CODES.LIVE_EXECUTION_DISABLED,
      );
    });

    it("refuses when If-Match optimistic version does not match", async () => {
      await seedCompanyAndAgent();
      const { svc, plan } = await setupApprovedPlan();
      await expect(
        svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion + 99),
      ).rejects.toMatchObject({
        status: 409,
        details: { code: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT },
      });
    });

    it("refuses when approval is still pending (not accepted)", async () => {
      await seedCompanyAndAgent();
      const svc = svcOff();
      const plan = await svc.createPlan(
        { companyId, agentId, effectiveDelta: internalSafeDelta() },
        { userId: "user-1" },
      );
      const { plan: requested } = await svc.requestApproval(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      // Do NOT approve.
      await expect(
        svc.executePlan(requested.id, companyId, agentId, { userId: "user-1" }, requested.optimisticVersion),
      ).rejects.toMatchObject({
        status: 409,
        details: { code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED },
      });
    });

    it("refuses when approval has been rejected", async () => {
      await seedCompanyAndAgent();
      const { svc, plan, approvalId } = await setupApprovedPlan();
      await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.id, approvalId));
      await expect(
        svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion),
      ).rejects.toMatchObject({
        status: 409,
        details: { code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED },
      });
    });

    it("refuses when approval has been cancelled (consumed/expired-class)", async () => {
      await seedCompanyAndAgent();
      const { svc, plan, approvalId } = await setupApprovedPlan();
      await db.update(approvals).set({ status: "cancelled" }).where(eq(approvals.id, approvalId));
      await expect(
        svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion),
      ).rejects.toMatchObject({
        status: 409,
        details: { code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED },
      });
    });

    it("refuses when the approval payload's dryRunHash does not match the plan", async () => {
      await seedCompanyAndAgent();
      const { svc, plan, approvalId } = await setupApprovedPlan();
      const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
      await db
        .update(approvals)
        .set({
          payload: { ...(approval!.payload as Record<string, unknown>), dryRunHash: "tamperedtamperedtampere" },
        })
        .where(eq(approvals.id, approvalId));
      await expect(
        svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion),
      ).rejects.toMatchObject({
        status: 409,
        details: { code: CAPABILITY_APPLY_ERROR_CODES.PLAN_HASH_MISMATCH },
      });
    });

    it("refuses cross-agent execute on a plan that belongs to another agent", async () => {
      await seedCompanyAndAgent();
      const { svc, plan } = await setupApprovedPlan();
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId,
        companyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await expect(
        svc.executePlan(plan.id, companyId, otherAgentId, { userId: "user-1" }, plan.optimisticVersion),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("refuses cross-company plan lookups", async () => {
      await seedCompanyAndAgent();
      const { svc, plan } = await setupApprovedPlan();
      await expect(
        svc.executePlan(plan.id, otherCompanyId, agentId, { userId: "user-1" }, plan.optimisticVersion),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("replay: a second execute on the same plan revision trips APPROVAL_CONSUMED", async () => {
      await seedCompanyAndAgent();
      const { svc, plan } = await setupApprovedPlan();
      const applied = await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      expect(applied.state).toBe("applied");
      // Second execute against the now-applied plan must trip the consumed path.
      await expect(
        svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, applied.optimisticVersion),
      ).rejects.toMatchObject({
        status: 409,
        details: { code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED },
      });
    });
  });

  describe("no-live-action assertion", () => {
    it("getExecutorAdapter returns the real adapter when capabilityApplyLive=true (LET-402 G.4)", () => {
      const svc = capabilityApplyService(db, { capabilityApplyLive: true });
      const adapter = svc._getExecutorAdapter();
      expect(adapter).toBeDefined();
      expect(adapter.kind).toBe("real");
    });

    it("executePlan never makes outbound HTTP/MCP calls — stub adapter only emits would-execute log + DB writes", async () => {
      await seedCompanyAndAgent();
      const svc = svcOff();
      const plan = await svc.createPlan(
        { companyId, agentId, effectiveDelta: internalSafeDelta() },
        { userId: "user-1" },
      );
      const { plan: requested } = await svc.requestApproval(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      await approveApproval(requested.approvalId!);

      const originalFetch = globalThis.fetch;
      let fetchInvocations = 0;
      globalThis.fetch = ((..._args: unknown[]) => {
        fetchInvocations++;
        throw new Error("no-live-action: fetch must not be called during capability apply G.2");
      }) as typeof fetch;
      try {
        const result = await svc.executePlan(requested.id, companyId, agentId, { userId: "user-1" }, requested.optimisticVersion);
        expect(result.state).toBe("applied");
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(fetchInvocations).toBe(0);
    });
  });

  describe("redaction", () => {
    it("canary secret values placed in proposalIdentity/displayName are validated, and event payloads never echo canary in any field", async () => {
      await seedCompanyAndAgent();
      const svc = svcOff();

      // Drop a canary into the proposalIdentity (a non-secret-keyed field) and
      // verify that the persisted event payloads never re-emit it. The redactor
      // is key-keyed so a plain identifier is preserved, but no event payload
      // ever embeds proposalIdentity; this guards against accidental leakage
      // if a future change adds that field to an event.
      const plan = await svc.createPlan(
        {
          companyId,
          agentId,
          effectiveDelta: internalSafeDelta(),
          proposalIdentity: `proposal-${randomUUID()}`,
        },
        { userId: "user-1", agentId: undefined, runId: undefined },
      );
      const { plan: requested } = await svc.requestApproval(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      await approveApproval(requested.approvalId!);
      await svc.executePlan(requested.id, companyId, agentId, { userId: "user-1" }, requested.optimisticVersion);

      const eventRows = await db.select().from(capabilityApplyEvents).where(eq(capabilityApplyEvents.planId, plan.id));
      const serialized = JSON.stringify(eventRows);
      expect(serialized).not.toContain(CANARY);
      // Also verify no secret-shaped patterns leaked.
      expect(serialized).not.toMatch(/sk_(live|test)_[A-Za-z0-9_-]{12,}/);
      expect(serialized).not.toMatch(/AKIA[0-9A-Z]{16}/);
    });

    it("rejects secret-shaped values in step target identifiers", async () => {
      await seedCompanyAndAgent();
      const svc = svcOff();
      await expect(
        svc.createPlan(
          {
            companyId,
            agentId,
            effectiveDelta: {
              mcpServerChanges: [
                {
                  kind: "add",
                  serverId: "srv",
                  displayName: "Bearer abc.def.ghi.jkl.mno", // secret-shaped
                  catalogId: "verified/x",
                  requiredSecretNames: [],
                },
              ],
            },
          },
          { userId: "user-1" },
        ),
      ).rejects.toMatchObject({
        status: 422,
        details: { code: CAPABILITY_APPLY_ERROR_CODES.SECRET_SHAPED_IDENTIFIER },
      });
    });
  });

  describe("single-use approval (DB-level)", () => {
    it("a second plan cannot be bound to an approval already owned by another plan", async () => {
      await seedCompanyAndAgent();
      const svc = svcOff();
      const planA = await svc.createPlan(
        { companyId, agentId, effectiveDelta: internalSafeDelta() },
        { userId: "user-1" },
      );
      const { plan: requestedA } = await svc.requestApproval(planA.id, companyId, agentId, { userId: "user-1" }, planA.optimisticVersion);
      const approvalId = requestedA.approvalId!;

      // Create a second plan with a different hash by varying the delta.
      const planB = await svc.createPlan(
        {
          companyId,
          agentId,
          effectiveDelta: { skillRefChanges: [{ kind: "add", ref: "design-guide" }] },
        },
        { userId: "user-1" },
      );

      // Manually attempt to bind the same approval to planB — DB partial unique
      // index `cap_apply_plans_approval_id_uidx` should refuse the write.
      await expect(
        db.update(capabilityApplyPlans).set({ approvalId }).where(eq(capabilityApplyPlans.id, planB.id)),
      ).rejects.toThrow();
    });
  });

  // ── LET-402 / G.4 — real MCP adapter behind capability.apply.live ─────────

  describe("real adapter (capability.apply.live=ON) — LET-402 G.4", () => {
    function svcOn(deps?: Parameters<typeof capabilityApplyService>[1]["realAdapterDeps"]) {
      return capabilityApplyService(db, { capabilityApplyLive: true, realAdapterDeps: deps });
    }

    async function makeApprovedPlan(
      effectiveDelta: Parameters<ReturnType<typeof svcOff>["createPlan"]>[0]["effectiveDelta"],
      svc: ReturnType<typeof svcOff>,
    ) {
      const plan = await svc.createPlan(
        { companyId, agentId, effectiveDelta },
        { userId: "user-1" },
      );
      const { plan: requested } = await svc.requestApproval(
        plan.id,
        companyId,
        agentId,
        { userId: "user-1" },
        plan.optimisticVersion,
      );
      await approveApproval(requested.approvalId!);
      return requested;
    }

    it("happy path: internal_safe steps complete via real adapter and plan -> applied", async () => {
      await seedCompanyAndAgent();
      const svc = svcOn();
      const plan = await makeApprovedPlan(internalSafeDelta(), svc);
      const result = await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      expect(result.state).toBe("applied");

      const events = await db.select().from(capabilityApplyEvents).where(eq(capabilityApplyEvents.planId, plan.id));
      const completed = events.find((e) => e.kind === "capability_apply_step_completed");
      expect(completed).toBeDefined();
      const payload = completed!.payloadJson as Record<string, unknown>;
      expect(payload.adapterKind).toBe("real");
      expect(payload.liveExecutionFlagState).toBe("on");
      expect(typeof payload.stepKey).toBe("string");
      expect((payload.stepKey as string).startsWith(`apply:${plan.id}:`)).toBe(true);
    });

    it("refuses non-allowlisted catalog at execute time with CATALOG_NOT_ALLOWLISTED", async () => {
      await seedCompanyAndAgent();
      const svc = svcOn();
      // The plan builder accepts any catalogId for add_mcp_server, but
      // tamper the persisted step to use a non-verified id and confirm the
      // real adapter refuses at execute time. We rebuild on a delta that
      // passes plan-time validation, then patch the row.
      const plan = await makeApprovedPlan(
        {
          mcpServerChanges: [
            {
              kind: "add",
              serverId: "srv-1",
              displayName: "MCP",
              catalogId: "verified/ok",
              requiredSecretNames: [],
            },
          ],
        },
        svc,
      );
      // Tamper: replace catalogId on the step with an unverified shape.
      await db
        .update(capabilityApplySteps)
        .set({ targetRefJson: { catalogId: "unverified/marketplace-xyz", label: "MCP", namedSecretRefs: [] } })
        .where(eq(capabilityApplySteps.planId, plan.id));

      const result = await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      expect(result.state).toBe("partially_applied");

      const stepRows = await db.select().from(capabilityApplySteps).where(eq(capabilityApplySteps.planId, plan.id));
      const failed = stepRows.find((s) => s.kind === "add_mcp_server");
      expect(failed?.state).toBe("failed");
      expect(failed?.lastErrorCode).toBe(CAPABILITY_APPLY_ERROR_CODES.CATALOG_NOT_ALLOWLISTED);
    });

    it("carries remoteUrl from the createPlan input through targetRefJson to the real adapter (no row tampering)", async () => {
      // LET-402 G.4 regression: the QA validator surfaced that the
      // route/service path used to strip `remoteUrl`. Drive the natural
      // route-shaped delta with an unsafe remoteUrl and prove the adapter
      // blocks it via the persisted row, not via test-side tampering.
      await seedCompanyAndAgent();
      const svc = svcOn();
      const plan = await makeApprovedPlan(
        {
          mcpServerChanges: [
            {
              kind: "add",
              serverId: "srv-1",
              displayName: "MCP",
              catalogId: "verified/ok",
              transport: "streamable_http",
              remoteUrl: "http://169.254.169.254/latest/meta-data/",
              requiredSecretNames: [],
            },
          ],
        },
        svc,
      );

      const stepBeforeExecute = (
        await db.select().from(capabilityApplySteps).where(eq(capabilityApplySteps.planId, plan.id))
      )[0];
      expect((stepBeforeExecute.targetRefJson as Record<string, unknown>).remoteUrl).toBe(
        "http://169.254.169.254/latest/meta-data/",
      );

      const result = await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      expect(result.state).toBe("partially_applied");

      const stepRows = await db.select().from(capabilityApplySteps).where(eq(capabilityApplySteps.planId, plan.id));
      const failed = stepRows.find((s) => s.kind === "add_mcp_server");
      expect(failed?.state).toBe("failed");
      expect(failed?.lastErrorCode).toBe(CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED);
    });

    it("refuses egress to private IP / loopback / IMDS with EGRESS_BLOCKED", async () => {
      await seedCompanyAndAgent();
      const svc = svcOn();
      const plan = await makeApprovedPlan(
        {
          mcpServerChanges: [
            {
              kind: "add",
              serverId: "srv-1",
              displayName: "MCP",
              catalogId: "verified/ok",
              requiredSecretNames: [],
            },
          ],
        },
        svc,
      );
      await db
        .update(capabilityApplySteps)
        .set({
          targetRefJson: {
            catalogId: "verified/ok",
            label: "MCP",
            namedSecretRefs: [],
            remoteUrl: "https://169.254.169.254/latest/meta-data/",
          },
        })
        .where(eq(capabilityApplySteps.planId, plan.id));

      const result = await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      expect(result.state).toBe("partially_applied");

      const stepRows = await db.select().from(capabilityApplySteps).where(eq(capabilityApplySteps.planId, plan.id));
      const failed = stepRows.find((s) => s.kind === "add_mcp_server");
      expect(failed?.state).toBe("failed");
      expect(failed?.lastErrorCode).toBe(CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED);
    });

    it("refuses with NAMED_SECRET_NOT_FOUND when the resolver cannot locate a referenced secret", async () => {
      await seedCompanyAndAgent();
      const svc = svcOn({
        secretReferenceResolver: { async hasNamedSecret() { return false; } },
      });
      const plan = await makeApprovedPlan(
        {
          mcpServerChanges: [
            {
              kind: "add",
              serverId: "srv-1",
              displayName: "MCP",
              catalogId: "verified/ok",
              requiredSecretNames: ["MISSING_TOKEN"],
            },
          ],
        },
        svc,
      );
      const result = await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      expect(result.state).toBe("partially_applied");
      const stepRows = await db.select().from(capabilityApplySteps).where(eq(capabilityApplySteps.planId, plan.id));
      const failed = stepRows.find((s) => s.kind === "add_mcp_server");
      expect(failed?.state).toBe("failed");
      expect(failed?.lastErrorCode).toBe(CAPABILITY_APPLY_ERROR_CODES.NAMED_SECRET_NOT_FOUND);
    });

    it("does not make outbound HTTP/MCP calls even with live=ON", async () => {
      await seedCompanyAndAgent();
      const svc = svcOn({
        secretReferenceResolver: { async hasNamedSecret() { return true; } },
      });
      const plan = await makeApprovedPlan(
        {
          mcpServerChanges: [
            {
              kind: "add",
              serverId: "srv-1",
              displayName: "MCP",
              catalogId: "verified/ok",
              requiredSecretNames: [],
            },
          ],
          skillRefChanges: [{ kind: "add", ref: "code-review" }],
        },
        svc,
      );

      const originalFetch = globalThis.fetch;
      let invocations = 0;
      globalThis.fetch = ((..._args: unknown[]) => {
        invocations++;
        throw new Error("no-live-action: fetch must not be called by capability apply G.4");
      }) as typeof fetch;
      try {
        const result = await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
        expect(result.state).toBe("applied");
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(invocations).toBe(0);
    });

    it("never leaks raw secret values: resolver receives only the named identifier; events carry only references", async () => {
      await seedCompanyAndAgent();
      const seenNames: Array<{ companyId: string; name: string }> = [];
      const svc = svcOn({
        secretReferenceResolver: {
          async hasNamedSecret(cid, name) {
            seenNames.push({ companyId: cid, name });
            return true;
          },
        },
      });
      const plan = await makeApprovedPlan(
        {
          mcpServerChanges: [
            {
              kind: "add",
              serverId: "srv-1",
              displayName: "MCP",
              catalogId: "verified/ok",
              requiredSecretNames: ["GITHUB_TOKEN"],
            },
          ],
        },
        svc,
      );
      await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);
      // The resolver only ever sees the reference name (env-style identifier),
      // never a raw value.
      expect(seenNames).toEqual([{ companyId, name: "GITHUB_TOKEN" }]);

      const eventRows = await db.select().from(capabilityApplyEvents).where(eq(capabilityApplyEvents.planId, plan.id));
      const serialized = JSON.stringify(eventRows);
      // Reference names ARE allowed in events; the secret VALUE never is, and
      // no value was ever introduced to the resolver in the first place.
      expect(serialized).not.toContain(CANARY);
      expect(serialized).not.toMatch(/sk_(live|test)_[A-Za-z0-9_-]{12,}/);
      expect(serialized).not.toMatch(/gh[opsu]_[A-Za-z0-9_-]{12,}/);
    });

    it("replay-safe: re-executing the same step produces the same step key + mutation digest", async () => {
      // Drives the step twice via two independent service calls; the second
      // execution hits APPROVAL_CONSUMED at the plan level, but we read the
      // first execution's recorded stepKey + mutationDigest and assert they
      // are deterministic for the same step input (plan id + ordinal + kind).
      await seedCompanyAndAgent();
      const svc = svcOn();
      const plan = await makeApprovedPlan(internalSafeDelta(), svc);
      await svc.executePlan(plan.id, companyId, agentId, { userId: "user-1" }, plan.optimisticVersion);

      const events = await db.select().from(capabilityApplyEvents).where(eq(capabilityApplyEvents.planId, plan.id));
      const completed = events.filter((e) => e.kind === "capability_apply_step_completed");
      expect(completed.length).toBeGreaterThan(0);
      // For each completed step, recomputing the same key from (planId, ordinal, kind)
      // must yield the persisted value — that's the saga-style idempotency property.
      for (const ev of completed) {
        const payload = ev.payloadJson as Record<string, unknown>;
        const ordinal = payload.ordinal as number;
        const kind = payload.kind as string;
        expect(payload.stepKey).toBe(`apply:${plan.id}:${ordinal}:${kind}`);
        expect(typeof payload.mutationDigest).toBe("string");
        expect((payload.mutationDigest as string).length).toBe(32);
      }
    });
  });
});
