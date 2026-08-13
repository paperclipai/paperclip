// Regression: the tool review queue must not cancel an ask-first action request
// that the gateway has created but not signed yet.
//
// The gateway builds a require-approval action request in two steps: it first
// inserts the row with a null signature, then signs the row a moment later. A
// review-queue read (listActionRequests) that lands inside that window must hide
// the unsigned row from the queue, but must leave it pending. If the read
// cancels the row, the following approve call fails with action_not_pending.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  toolApplications,
  toolActionRequests,
  toolCatalogEntries,
  toolConnections,
  toolInvocations,
} from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { canonicalToolArguments, signToolArguments } from "../services/tool-content-guards.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const signingSecret = "review-queue-regression-secret";

describeEmbeddedPostgres("tool review queue vs unsigned ask-first request", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-queue-unsigned-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("hides an unsigned pending request from the queue, keeps it pending, and lets approve succeed once it is signed", async () => {
    vi.stubEnv("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", signingSecret);
    const [company] = await db.insert(companies).values({
      name: `Review Queue ${randomUUID()}`,
      issuePrefix: `RQ${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId: company.id,
      name: `Review Queue app ${randomUUID()}`,
      type: "mcp_http",
      status: "active",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: `Review Queue connection ${randomUUID()}`,
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      config: { url: "https://fixture.example/mcp" },
    }).returning();
    const [catalogEntry] = await db.insert(toolCatalogEntries).values({
      companyId: company.id,
      applicationId: application.id,
      connectionId: connection.id,
      name: "sheets:update_cell",
      toolName: "sheets:update_cell",
      title: "Update sheet cell",
      riskLevel: "write",
      isWrite: true,
      status: "active",
      versionHash: "v1",
      schemaHash: "s1",
    }).returning();

    const parameters = { cell: "B1", value: "first" };
    const canonicalArguments = canonicalToolArguments(parameters);

    // A test-origin ask-first invocation, exactly as recordInvocation records it.
    const [invocation] = await db.insert(toolInvocations).values({
      companyId: company.id,
      actorType: "user",
      actorId: "board",
      agentId: null,
      runId: null,
      issueId: null,
      applicationId: application.id,
      connectionId: connection.id,
      catalogEntryId: catalogEntry.id,
      toolName: "sheets:update_cell",
      argumentsHash: "args-hash",
      argumentsSummary: { summary: canonicalArguments, sha256: "args-hash", sizeBytes: canonicalArguments.length },
      policyDecision: "require_approval",
      approvalState: "pending",
      status: "awaiting_approval",
    }).returning();

    // Step one of the two-step create: the row exists, pending, not yet signed.
    const [actionRequest] = await db.insert(toolActionRequests).values({
      companyId: company.id,
      invocationId: invocation.id,
      status: "pending",
      canonicalArgumentsHash: "args-hash",
      canonicalArgumentsSummary: { summary: canonicalArguments, sha256: "args-hash", sizeBytes: canonicalArguments.length },
      signedArguments: null,
    }).returning();

    // A concurrent review-queue read lands inside the create window.
    const listedDuringCreate = await toolAccessService(db).listActionRequests(company.id, "pending");
    expect(listedDuringCreate.map((item) => item.request.id)).not.toContain(actionRequest.id);

    const [afterRead] = await db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.id, actionRequest.id));
    expect(afterRead.status).toBe("pending");

    // Step two of the create: the gateway signs the row.
    const signedArguments = signToolArguments({
      invocationId: invocation.id,
      toolName: invocation.toolName,
      canonicalArguments,
      executionOnApprove: true,
      signingSecret,
    });
    await db
      .update(toolActionRequests)
      .set({ signedArguments, updatedAt: new Date() })
      .where(eq(toolActionRequests.id, actionRequest.id));

    // The queue now shows the signed request.
    const listedAfterSign = await toolAccessService(db).listActionRequests(company.id, "pending");
    expect(listedAfterSign.map((item) => item.request.id)).toContain(actionRequest.id);

    // Approve no longer races a cancelled row.
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: signingSecret });
    await expect(
      gateway.approveActionRequest({
        companyId: company.id,
        actionRequestId: actionRequest.id,
        actor: { userId: "board" },
      }),
    ).resolves.toBeTruthy();

    const [afterApprove] = await db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.id, actionRequest.id));
    expect(["approved", "executed", "failed"]).toContain(afterApprove.status);
  });
});
