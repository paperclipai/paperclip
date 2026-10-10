import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  toolApplications,
  toolCallEvents,
  toolConnections,
  toolGovnaAuthorityOperations,
  toolInvocations,
  toolPolicies,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  GovnaAuthorityStateError,
  govnaAuthorityOperationService,
} from "../services/govna-approval-authority.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("Govna approval authority durable state", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-govna-authority-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(toolCallEvents);
    await db.delete(toolGovnaAuthorityOperations);
    await db.delete(toolInvocations);
    await db.delete(toolPolicies);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({
      name: `Govna ${randomUUID()}`,
      issuePrefix: `GV${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company!.id,
      applicationKey: `govna-${randomUUID()}`,
      name: "Govna fixture",
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company!.id,
      applicationId: application!.id,
      name: "Govna fixture",
      uid: `govna/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      config: {
        url: "https://example.invalid/mcp",
        govnaApprovalAuthority: {
          mode: "required",
          prepareEndpoint: "https://api.govna.io/approval-authority/v1/prepare",
          statusEndpoint: "https://api.govna.io/approval-authority/v1/status",
          cancelEndpoint: "https://api.govna.io/approval-authority/v1/cancel",
          approvalOrigin: "https://app.govna.io",
          resource: "https://mcp.govna.io/farmhub",
          trustId: "atr_01m4hfpth0emf9wpckns4ngbxt",
          trustRevision: 1,
          hostContextId: "farmhub-paperclip",
          localPolicyRevision: "policy-v1",
          connectionGeneration: 1,
          hostIssuer: "https://factory.farmhub.ag",
          hostProofAudience: "govna-approval-authority",
          statementIssuer: "https://api.govna.io",
          statementAudience: "farmhub-paperclip",
          hostKeyId: "farmhub-host-key-1",
          hostSigningKeySecretId: "secret-key-id",
          statementKeyId: "govna-statement-key-1",
          statementPublicKeyPem: "-----BEGIN PUBLIC KEY-----\nexample\n-----END PUBLIC KEY-----",
          tools: ["send_email"],
        },
      },
    }).returning();
    const [policy] = await db.insert(toolPolicies).values({
      companyId: company!.id,
      name: "Govna exact calls",
      policyType: "require_approval",
      selectors: { toolName: "send_email" },
      config: { govnaDelegation: "delegable_exact_call" },
    }).returning();
    const [invocation] = await db.insert(toolInvocations).values({
      companyId: company!.id,
      connectionId: connection!.id,
      toolName: "send_email",
      upstreamToolName: "send_email",
      argumentsHash: "request-hash",
      policyDecision: "require_approval",
      matchedPolicyIds: [policy!.id],
      approvalState: "pending",
      status: "awaiting_approval",
    }).returning();
    return { company: company!, connection: connection!, invocation: invocation!, policy: policy! };
  }

  function pendingInput(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      companyId: f.company.id,
      invocationId: f.invocation.id,
      connectionId: f.connection.id,
      operationId: `operation-${randomUUID()}`,
      hostContextId: `context-${randomUUID()}`,
      localPolicyRevision: "policy-v1",
      connectionGeneration: 1,
      requestHash: "request-hash",
      signedArguments: "signed-arguments",
      authorityBinding: { trust_id: "atr_test", trust_revision: 1 },
      reservationId: "arv_01m4hfpth0emf9wpckns4ngbxt",
      approvalUrl: "https://app.govna.io/authority-approval?org=org_test&reservation=arv_test",
      safeSummary: "Send one email",
      approvalExpiresAt: new Date(Date.now() + 60_000),
    };
  }

  function operationService() {
    return govnaAuthorityOperationService(db, {
      assertCurrentAuthority: async () => ({
        localPolicyRevision: "policy-v1",
        connectionGeneration: 1,
      }),
    });
  }

  it("replays an identical reservation and rejects operation-id substitution", async () => {
    const f = await fixture();
    const input = pendingInput(f);
    const service = operationService();

    const first = await service.reserve(input);
    const replay = await service.reserve(input);

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, operation: { id: first.operation.id } });
    await expect(service.reserve({ ...input, requestHash: "different" }))
      .rejects.toMatchObject({ code: "binding_mismatch" } satisfies Partial<GovnaAuthorityStateError>);
  });

  it("allows exactly one local dispatch claim and records the intent atomically", async () => {
    const f = await fixture();
    const input = pendingInput(f);
    const service = operationService();
    await service.reserve(input);
    await service.approve({
      companyId: f.company.id,
      operationId: input.operationId,
      reservationId: input.reservationId,
      requestHash: input.requestHash,
      localPolicyRevision: input.localPolicyRevision,
      connectionGeneration: input.connectionGeneration,
      ticketGeneration: 1,
    });

    const results = await Promise.allSettled([
      service.claimDispatch({
        companyId: f.company.id,
        operationId: input.operationId,
        reservationId: input.reservationId,
        requestHash: input.requestHash,
        localPolicyRevision: input.localPolicyRevision,
        connectionGeneration: input.connectionGeneration,
        ticketGeneration: 1,
        ticketExpiresAt: Math.floor(Date.now() / 1000) + 30,
      }),
      service.claimDispatch({
        companyId: f.company.id,
        operationId: input.operationId,
        reservationId: input.reservationId,
        requestHash: input.requestHash,
        localPolicyRevision: input.localPolicyRevision,
        connectionGeneration: input.connectionGeneration,
        ticketGeneration: 1,
        ticketExpiresAt: Math.floor(Date.now() / 1000) + 30,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [operation] = await db.select().from(toolGovnaAuthorityOperations);
    const events = await db.select().from(toolCallEvents);
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, f.invocation.id));
    expect(operation).toMatchObject({ state: "dispatch_claimed", localClaimId: expect.any(String) });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "call_started",
      invocationId: f.invocation.id,
      reasonCode: "govna_dispatch_claimed",
      outcome: "pending",
    });
    expect(invocation).toMatchObject({ status: "executing", approvalState: "approved" });
  });

  it("marks a claimed call outcome unknown and never makes it claimable again", async () => {
    const f = await fixture();
    const input = pendingInput(f);
    const service = operationService();
    await service.reserve(input);
    await service.approve({
      companyId: f.company.id,
      operationId: input.operationId,
      reservationId: input.reservationId,
      requestHash: input.requestHash,
      localPolicyRevision: input.localPolicyRevision,
      connectionGeneration: input.connectionGeneration,
      ticketGeneration: 1,
      ticketExpiresAt: Math.floor(Date.now() / 1000) + 30,
    });
    await service.claimDispatch({
      companyId: f.company.id,
      operationId: input.operationId,
      reservationId: input.reservationId,
      requestHash: input.requestHash,
      localPolicyRevision: input.localPolicyRevision,
      connectionGeneration: input.connectionGeneration,
      ticketGeneration: 1,
      ticketExpiresAt: Math.floor(Date.now() / 1000) + 30,
    });

    await service.markOutcomeUnknown({
      companyId: f.company.id,
      operationId: input.operationId,
      errorCode: "dispatch_receipt_missing",
    });

    await expect(service.claimDispatch({
      companyId: f.company.id,
      operationId: input.operationId,
      reservationId: input.reservationId,
      requestHash: input.requestHash,
      localPolicyRevision: input.localPolicyRevision,
      connectionGeneration: input.connectionGeneration,
      ticketGeneration: 1,
      ticketExpiresAt: Math.floor(Date.now() / 1000) + 30,
    })).rejects.toMatchObject({ code: "not_dispatchable" } satisfies Partial<GovnaAuthorityStateError>);
    const [operation] = await db.select().from(toolGovnaAuthorityOperations);
    const [invocation] = await db.select().from(toolInvocations);
    expect(operation).toMatchObject({ state: "outcome_unknown", errorCode: "dispatch_receipt_missing" });
    expect(invocation).toMatchObject({ status: "failed", errorCode: "dispatch_receipt_missing" });
  });

  it("rechecks the live connection and local policy inside the dispatch claim", async () => {
    const f = await fixture();
    const input = pendingInput(f);
    const service = operationService();
    await service.reserve(input);
    await service.approve({
      companyId: f.company.id,
      operationId: input.operationId,
      reservationId: input.reservationId,
      requestHash: input.requestHash,
      localPolicyRevision: input.localPolicyRevision,
      connectionGeneration: input.connectionGeneration,
      ticketGeneration: 1,
    });
    await db.update(toolPolicies).set({ enabled: false }).where(eq(toolPolicies.id, f.policy.id));

    await expect(service.claimDispatch({
      companyId: f.company.id,
      operationId: input.operationId,
      reservationId: input.reservationId,
      requestHash: input.requestHash,
      localPolicyRevision: input.localPolicyRevision,
      connectionGeneration: input.connectionGeneration,
      ticketGeneration: 1,
      ticketExpiresAt: Math.floor(Date.now() / 1000) + 30,
    })).rejects.toMatchObject({ code: "not_dispatchable" } satisfies Partial<GovnaAuthorityStateError>);
    const [operation] = await db.select().from(toolGovnaAuthorityOperations);
    expect(operation).toMatchObject({ state: "approved", localClaimId: null });
  });

  it("lets a newly applicable local hard deny defeat an older Govna approval", async () => {
    const f = await fixture();
    const input = pendingInput(f);
    const service = govnaAuthorityOperationService(db, {
      assertCurrentAuthority: async ({ db: transaction, invocation }) => {
        const currentPolicies = await transaction
          .select()
          .from(toolPolicies)
          .where(eq(toolPolicies.companyId, f.company.id))
          .for("update");
        if (currentPolicies.some((policy) =>
          policy.enabled &&
          policy.policyType === "block" &&
          (policy.selectors as Record<string, unknown>)?.toolName === invocation.toolName)) {
          throw new GovnaAuthorityStateError("not_dispatchable", "A current local hard deny applies");
        }
        return { localPolicyRevision: "policy-v1", connectionGeneration: 1 };
      },
    });
    await service.reserve(input);
    await service.approve({
      companyId: f.company.id,
      operationId: input.operationId,
      reservationId: input.reservationId,
      requestHash: input.requestHash,
      localPolicyRevision: input.localPolicyRevision,
      connectionGeneration: input.connectionGeneration,
      ticketGeneration: 1,
    });
    let releaseMutation!: () => void;
    let mutationLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const locked = new Promise<void>((resolve) => { mutationLocked = resolve; });
    const mutation = db.transaction(async (transaction) => {
      await transaction.insert(toolPolicies).values({
        companyId: f.company.id,
        name: "Emergency local stop",
        policyType: "block",
        selectors: { toolName: "send_email" },
        enabled: true,
      });
      mutationLocked();
      await release;
    });
    await locked;
    const claim = service.claimDispatch({
      companyId: f.company.id,
      operationId: input.operationId,
      reservationId: input.reservationId,
      requestHash: input.requestHash,
      localPolicyRevision: input.localPolicyRevision,
      connectionGeneration: input.connectionGeneration,
      ticketGeneration: 1,
      ticketExpiresAt: Math.floor(Date.now() / 1000) + 30,
    });
    expect(await Promise.race([
      claim.then(() => "settled", () => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ])).toBe("waiting");
    releaseMutation();
    await mutation;
    await expect(claim).rejects.toMatchObject({ code: "not_dispatchable" } satisfies Partial<GovnaAuthorityStateError>);
    const [operation] = await db.select().from(toolGovnaAuthorityOperations);
    expect(operation).toMatchObject({ state: "approved", localClaimId: null });
  });
});
