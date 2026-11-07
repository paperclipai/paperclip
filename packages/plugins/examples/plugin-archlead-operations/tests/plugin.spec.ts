import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import {
  ENTITY_TYPES,
  buildPaymentOrderMetadata,
  verifyCashfreeSignature,
  verifyPaddleSignature,
  verifyWebhookSignature,
} from "../src/contracts.js";

const COMPANY_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_COMPANY_ID = "223e4567-e89b-42d3-a456-426614174000";
const SECRET_REF = { type: "secret_ref", secretId: "test-secret", version: "latest" } as const;
const RESOLVED_SECRET = "resolved:[object Object]";
const USER = { type: "user", userId: "operator-1" } as const;

type QualificationTaskView = {
  synthetic: boolean;
  approvalStatus: string;
  outreachStatus: string;
  externalLeadId: string;
  qualificationStatus: string;
};

function signedHeaders(rawBody: string, secret: string, timestamp: string): Record<string, string> {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return {
    "x-archlead-timestamp": timestamp,
    "x-archlead-signature": `sha256=${signature}`,
  };
}

function webhookInput(endpointKey: string, rawBody: string) {
  return {
    endpointKey,
    headers: signedHeaders(rawBody, RESOLVED_SECRET, Math.floor(Date.now() / 1000).toString()),
    rawBody,
    parsedBody: JSON.parse(rawBody),
    requestId: "webhook-test",
  };
}

function apiInput(routeKey: string, body: unknown, params: Record<string, string> = {}) {
  return {
    routeKey,
    method: "POST" as const,
    path: "/test",
    params,
    query: {},
    body,
    actor: { actorType: "user" as const, actorId: USER.userId, userId: USER.userId },
    companyId: COMPANY_ID,
    headers: {},
  };
}

async function fakeSandboxOutbound(
  task: {
    synthetic: boolean;
    approvalStatus: string;
    outreachStatus: string;
    externalLeadId: string;
  },
  fakeProvider: { simulate(externalLeadId: string): Promise<"simulated"> },
): Promise<"simulated"> {
  if (!task.synthetic || task.approvalStatus !== "approved" || task.outreachStatus !== "blocked") {
    throw new Error("Sandbox simulation requires a synthetic task, human approval, and blocked live outreach");
  }
  return fakeProvider.simulate(task.externalLeadId);
}

function paymentDatabase(harness: ReturnType<typeof createTestHarness>) {
  const orders = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  vi.spyOn(harness.ctx.db, "execute").mockImplementation(async (sql, params) => {
    const statement = sql.toLowerCase();
    if (statement.includes("insert into") && statement.includes(".payment_orders")) {
      const key = `${String(params?.[0])}:${String(params?.[1])}`;
      if (orders.has(key)) return { rowCount: 0 };
      orders.set(key, {
        company_id: params?.[0],
        external_id: params?.[1],
        provider: params?.[2],
        amount: params?.[3],
        currency: params?.[4],
        plan_id: params?.[5],
        request_sha256: params?.[6],
        status: "pending",
        provider_order_id: null,
        latest_event_at: null,
      });
      return { rowCount: 1 };
    }
    if (statement.includes("insert into") && statement.includes(".payment_event_receipts")) {
      const key = `${String(params?.[0])}:${String(params?.[1])}`;
      if (receipts.has(key)) return { rowCount: 0 };
      receipts.set(key, {
        provider: params?.[0],
        event_id: params?.[1],
        company_id: params?.[2],
        order_external_id: params?.[3],
        provider_resource_id: params?.[4],
        payment_status: params?.[5],
        occurred_at: params?.[6],
        payload_sha256: params?.[7],
      });
      return { rowCount: 1 };
    }
    if (statement.startsWith("update") && statement.includes(".payment_orders")) {
      const order = orders.get(`${String(params?.[0])}:${String(params?.[1])}`);
      if (order) {
        if (order.provider_order_id !== null && params?.[2]
          && order.provider_order_id !== params[2]) return { rowCount: 0 };
        if (order.provider_order_id === null && params?.[2]) order.provider_order_id = params[2];
        const eventTime = String(params?.[3]);
        if (order.latest_event_at === null || String(order.latest_event_at) <= eventTime) {
          order.status = params?.[4];
          order.latest_event_at = eventTime;
        }
      }
      return { rowCount: order ? 1 : 0 };
    }
    return { rowCount: 1 };
  });
  vi.spyOn(harness.ctx.db, "query").mockImplementation(async (sql, params) => {
    const statement = sql.toLowerCase();
    if (statement.includes("from") && statement.includes(".payment_orders")) {
      const order = orders.get(`${String(params?.[0])}:${String(params?.[1])}`);
      return order ? [{ ...order }] : [];
    }
    if (statement.includes("from") && statement.includes(".payment_event_receipts")) {
      const receipt = receipts.get(`${String(params?.[0])}:${String(params?.[1])}`);
      return receipt ? [{ ...receipt }] : [];
    }
    return [];
  });
  return { orders, receipts };
}

function cashfreeInput(body: Record<string, unknown>, secret = RESOLVED_SECRET) {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}${rawBody}`).digest("base64");
  return {
    endpointKey: "cashfree-events",
    headers: {
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": signature,
    },
    rawBody,
    parsedBody: body,
    requestId: "cashfree-webhook-test",
  };
}

function paddleInput(body: Record<string, unknown>, secret = RESOLVED_SECRET) {
  const rawBody = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}:${rawBody}`).digest("hex");
  return {
    endpointKey: "paddle-events",
    headers: { "paddle-signature": `ts=${timestamp};h1=${signature}` },
    rawBody,
    parsedBody: body,
    requestId: "paddle-webhook-test",
  };
}

async function createPaymentOrder(
  provider: "cashfree" | "paddle",
  externalId: string,
) {
  return plugin.definition.onApiRequest?.(apiInput("create-payment-order", {
    companyId: COMPANY_ID,
    externalId,
    provider,
    amount: 125.5,
    currency: "inr",
    planId: "growth",
  }));
}

describe("ArchLead Operations plugin", () => {
  it("declares company-scoped CRM APIs, plugin entities, signed intake, and manual-only hooks", () => {
    expect(pluginManifestV1Schema.parse(manifest)).toMatchObject({
      id: "paperclipai.plugin-archlead-operations",
      database: { migrationsDir: "migrations", coreReadTables: ["companies"] },
      capabilities: expect.arrayContaining(["issues.read", "issues.create", "webhooks.receive"]),
      apiRoutes: expect.arrayContaining([
        expect.objectContaining({ routeKey: "list-records", auth: "board" }),
        expect.objectContaining({ routeKey: "create-lead", auth: "board" }),
        expect.objectContaining({ routeKey: "create-request", auth: "board" }),
        expect.objectContaining({ routeKey: "create-payment-order", auth: "board" }),
        expect.objectContaining({ routeKey: "create-qualification-task", auth: "board" }),
        expect.objectContaining({ routeKey: "get-qualification-task", auth: "board" }),
        expect.objectContaining({ routeKey: "convert-request", auth: "board" }),
      ]),
      jobs: expect.arrayContaining([
        expect.objectContaining({ jobKey: "gmail-sync", schedule: undefined }),
        expect.objectContaining({ jobKey: "inbound-triage", schedule: undefined }),
      ]),
      webhooks: expect.arrayContaining([
        expect.objectContaining({ endpointKey: "intake" }),
        expect.objectContaining({ endpointKey: "cashfree-events" }),
        expect.objectContaining({ endpointKey: "paddle-events" }),
      ]),
    });
  });

  it("creates an idempotent synthetic qualification issue with native human approval and test-only fake outreach", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({
      accessMembers: [{
        id: "synthetic-board-member",
        companyId: COMPANY_ID,
        principalType: "user",
        principalId: USER.userId,
        status: "active",
        membershipRole: "owner",
        grants: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    });
    await plugin.definition.setup(harness.ctx);

    const request = {
      companyId: COMPANY_ID,
      externalLeadId: "sandbox:lead-001",
      sandbox: true,
      lead: {
        name: "Synthetic Contact",
        email: "lead@example.test",
        business: "Synthetic Example Co",
        message: "Synthetic qualification request.",
      },
    };
    const createdResponse = await plugin.definition.onApiRequest?.(
      apiInput("create-qualification-task", request),
    );
    expect(createdResponse).toMatchObject({
      status: 201,
      body: {
        issueId: expect.any(String),
        interactionId: expect.any(String),
        qualificationStatus: "pending_review",
        approvalStatus: "required",
        outreachStatus: "blocked",
        synthetic: true,
      },
    });
    const created = createdResponse as {
      body: { issueId: string; interactionId: string };
    };
    const pendingRead = await plugin.definition.onApiRequest?.({
      ...apiInput("get-qualification-task", {}, { externalLeadId: "sandbox:lead-001" }),
      method: "GET",
      query: { companyId: COMPANY_ID },
    });
    expect(pendingRead).toMatchObject({
      status: 200,
      body: {
        externalLeadId: "sandbox:lead-001",
        issueId: created.body.issueId,
        interactionId: created.body.interactionId,
        qualificationStatus: "pending_review",
        approvalStatus: "required",
        outreachStatus: "blocked",
        interactionStatus: "pending",
        synthetic: true,
      },
    });
    const issue = await harness.ctx.issues.get(created.body.issueId, COMPANY_ID);
    expect(issue).toMatchObject({
      title: "[SANDBOX] Review lead: Synthetic Contact",
      status: "todo",
      description: expect.stringContaining("externalLeadId: sandbox:lead-001"),
    });
    expect(issue?.description).toContain("qualificationStatus: pending_review");
    expect(issue?.description).toContain("approvalStatus: required");
    expect(issue?.description).toContain("outreachStatus: blocked");
    const interactions = await harness.ctx.issues.listInteractions(created.body.issueId, COMPANY_ID);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({
      id: created.body.interactionId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "none",
    });

    const retry = await plugin.definition.onApiRequest?.(
      apiInput("create-qualification-task", request),
    );
    expect(retry).toMatchObject({
      status: 200,
      body: { issueId: created.body.issueId, interactionId: created.body.interactionId },
    });
    await expect(harness.ctx.issues.list({
      companyId: COMPANY_ID,
      originKind: "plugin:paperclipai.plugin-archlead-operations:sandbox-qualification",
      originId: "sandbox:lead-001",
      limit: 10,
    })).resolves.toHaveLength(1);
    const parallelRequest = { ...request, externalLeadId: "sandbox:lead-parallel" };
    const parallelRetries = await Promise.all([
      plugin.definition.onApiRequest?.(apiInput("create-qualification-task", parallelRequest)),
      plugin.definition.onApiRequest?.(apiInput("create-qualification-task", parallelRequest)),
    ]);
    expect(parallelRetries.map((response) => response?.status).sort()).toEqual([200, 201]);
    expect(parallelRetries[0]).toMatchObject({
      body: { issueId: expect.any(String), interactionId: expect.any(String) },
    });
    expect(parallelRetries[1]).toMatchObject({
      body: {
        issueId: (parallelRetries[0] as { body: { issueId: string; interactionId: string } }).body.issueId,
        interactionId: (parallelRetries[0] as { body: { issueId: string; interactionId: string } }).body.interactionId,
      },
    });
    await expect(harness.ctx.issues.list({
      companyId: COMPANY_ID,
      originKind: "plugin:paperclipai.plugin-archlead-operations:sandbox-qualification",
      originId: "sandbox:lead-parallel",
      limit: 10,
    })).resolves.toHaveLength(1);
    const changedRetry = await plugin.definition.onApiRequest?.(
      apiInput("create-qualification-task", {
        ...request,
        lead: { ...request.lead, message: "Changed synthetic request." },
      }),
    );
    expect(changedRetry).toMatchObject({ status: 409 });
    const notSynthetic = await plugin.definition.onApiRequest?.(
      apiInput("create-qualification-task", {
        ...request,
        externalLeadId: "lead-live-001",
        sandbox: false,
        lead: { ...request.lead, email: "contact@example.com" },
      }),
    );
    expect(notSynthetic).toMatchObject({ status: 422 });

    const fakeProvider = { simulate: vi.fn(async () => "simulated" as const) };
    const pendingTask = (await harness.getData<{
      qualificationTasks: QualificationTaskView[];
    }>("overview", { companyId: COMPANY_ID })).qualificationTasks
      .find((task) => task.externalLeadId === "sandbox:lead-001")!;
    expect(pendingTask).toMatchObject({
      synthetic: true,
      qualificationStatus: "pending_review",
      approvalStatus: "required",
      outreachStatus: "blocked",
    });
    await expect(fakeSandboxOutbound(pendingTask, fakeProvider)).rejects.toThrow("human approval");
    expect(fakeProvider.simulate).not.toHaveBeenCalled();

    await harness.ctx.issues.respondInteraction(
      created.body.issueId,
      created.body.interactionId,
      { action: "accept", actorUserId: USER.userId },
      COMPANY_ID,
    );
    const approvedTask = (await harness.getData<{
      qualificationTasks: QualificationTaskView[];
    }>("overview", { companyId: COMPANY_ID })).qualificationTasks
      .find((task) => task.externalLeadId === "sandbox:lead-001")!;
    expect(approvedTask).toMatchObject({
      synthetic: true,
      qualificationStatus: "qualified",
      approvalStatus: "approved",
      outreachStatus: "blocked",
    });
    const readStatus = await plugin.definition.onApiRequest?.({
      ...apiInput("get-qualification-task", {}, { externalLeadId: "sandbox:lead-001" }),
      method: "GET",
      query: { companyId: COMPANY_ID },
    });
    expect(readStatus).toMatchObject({
      status: 200,
      body: {
        externalLeadId: "sandbox:lead-001",
        issueId: created.body.issueId,
        interactionId: created.body.interactionId,
        qualificationStatus: "qualified",
        approvalStatus: "approved",
        outreachStatus: "blocked",
        interactionStatus: "accepted",
        synthetic: true,
        issueStatus: "todo",
      },
    });
    const approvedRetry = await plugin.definition.onApiRequest?.(
      apiInput("create-qualification-task", request),
    );
    expect(approvedRetry).toMatchObject({
      status: 200,
      body: {
        issueId: created.body.issueId,
        interactionId: created.body.interactionId,
        qualificationStatus: "qualified",
        approvalStatus: "approved",
        outreachStatus: "blocked",
      },
    });
    expect(fakeProvider.simulate).not.toHaveBeenCalled();
    await expect(fakeSandboxOutbound(approvedTask, fakeProvider)).resolves.toBe("simulated");
    expect(fakeProvider.simulate).toHaveBeenCalledTimes(1);
    expect(fakeProvider.simulate).toHaveBeenCalledWith("sandbox:lead-001");

    const disqualifiedResponse = await plugin.definition.onApiRequest?.(
      apiInput("create-qualification-task", {
        ...request,
        externalLeadId: "sandbox:lead-002",
      }),
    );
    const disqualified = disqualifiedResponse as {
      body: { issueId: string; interactionId: string };
    };
    await harness.ctx.issues.respondInteraction(
      disqualified.body.issueId,
      disqualified.body.interactionId,
      { action: "reject", actorUserId: USER.userId },
      COMPANY_ID,
    );
    const disqualifiedRead = await plugin.definition.onApiRequest?.({
      ...apiInput("get-qualification-task", {}, { externalLeadId: "sandbox:lead-002" }),
      method: "GET",
      query: { companyId: COMPANY_ID },
    });
    expect(disqualifiedRead).toMatchObject({
      status: 200,
      body: {
        qualificationStatus: "disqualified",
        approvalStatus: "rejected",
        outreachStatus: "blocked",
      },
    });
    const wrongCompanyRead = await plugin.definition.onApiRequest?.({
      ...apiInput("get-qualification-task", {}, { externalLeadId: "sandbox:lead-001" }),
      method: "GET",
      companyId: OTHER_COMPANY_ID,
      query: { companyId: OTHER_COMPANY_ID },
    });
    expect(wrongCompanyRead).toMatchObject({ status: 404 });
    await expect(fakeSandboxOutbound({
      ...approvedTask,
      approvalStatus: "rejected",
      externalLeadId: "sandbox:lead-002",
    }, fakeProvider)).rejects.toThrow("human approval");
    expect(fakeProvider.simulate).toHaveBeenCalledTimes(1);
  });

  it("accepts fresh signatures and rejects changed or stale webhook messages", () => {
    const rawBody = JSON.stringify({ companyId: COMPANY_ID, eventId: "evt-1" });
    const timestamp = "1793772000";
    const signature = `sha256=${createHmac("sha256", "secret").update(`${timestamp}.${rawBody}`).digest("hex")}`;

    expect(verifyWebhookSignature(rawBody, timestamp, signature, "secret", 1_793_772_000_000)).toBe(true);
    expect(verifyWebhookSignature(`${rawBody} `, timestamp, signature, "secret", 1_793_772_000_000)).toBe(false);
    expect(verifyWebhookSignature(rawBody, timestamp, signature, "secret", 1_793_772_301_000)).toBe(false);
  });

  it("verifies provider-specific raw-body signatures and Paddle timestamp tolerance", () => {
    const rawBody = '{"data":{"value":1.00}}';
    const cashfreeTimestamp = Date.now().toString();
    const cashfreeSignature = createHmac("sha256", "secret")
      .update(`${cashfreeTimestamp}${rawBody}`)
      .digest("base64");
    expect(verifyCashfreeSignature(rawBody, cashfreeTimestamp, cashfreeSignature, "secret")).toBe(true);
    expect(verifyCashfreeSignature(`${rawBody} `, cashfreeTimestamp, cashfreeSignature, "secret")).toBe(false);
    expect(verifyCashfreeSignature(rawBody, cashfreeTimestamp, `${cashfreeSignature}x`, "secret")).toBe(false);

    const paddleTimestamp = Math.floor(Date.now() / 1000).toString();
    const paddleSignature = createHmac("sha256", "secret")
      .update(`${paddleTimestamp}:${rawBody}`)
      .digest("hex");
    expect(verifyPaddleSignature(rawBody, `ts=${paddleTimestamp};h1=${paddleSignature}`, "secret")).toBe(true);
    expect(verifyPaddleSignature(`${rawBody} `, `ts=${paddleTimestamp};h1=${paddleSignature}`, "secret")).toBe(false);
    expect(verifyPaddleSignature(rawBody, `ts=${paddleTimestamp};h1=${paddleSignature}`, "secret", Date.now() + 6_000)).toBe(false);
  });

  it("creates Cashfree order tags and accepts signed, idempotent status events", async () => {
    const harness = createTestHarness({
      manifest,
      config: { cashfreeWebhookSecretRef: SECRET_REF },
    });
    const database = paymentDatabase(harness);
    await plugin.definition.setup(harness.ctx);

    const created = await createPaymentOrder("cashfree", "cashfree-local-1");
    expect(created).toMatchObject({
      status: 201,
      body: {
        order: {
          providerMetadata: {
            order_tags: {
              paperclip_company_id: COMPANY_ID,
              paperclip_payment_order_id: "cashfree-local-1",
            },
          },
        },
      },
    });
    await expect(createPaymentOrder("cashfree", "cashfree-local-1")).resolves.toMatchObject({ status: 200 });
    await expect(plugin.definition.onApiRequest?.(apiInput("create-payment-order", {
      companyId: COMPANY_ID,
      externalId: "cashfree-local-1",
      provider: "cashfree",
      amount: 126,
      currency: "INR",
      planId: "growth",
    }))).resolves.toMatchObject({ status: 409 });
    const metadata = buildPaymentOrderMetadata("cashfree", COMPANY_ID, "cashfree-local-1").order_tags;
    const eventBody = {
      type: "PAYMENT_SUCCESS_WEBHOOK",
      event_time: "2026-11-04T10:00:00.000Z",
      data: {
        order: { order_id: "cashfree-provider-1", order_tags: metadata },
        payment: { cf_payment_id: "cashfree-payment-1", payment_status: "SUCCESS" },
      },
    };
    const firstInput = cashfreeInput(eventBody);
    await expect(plugin.definition.onWebhook?.(firstInput)).resolves.toBeUndefined();
    await expect(plugin.definition.onWebhook?.(cashfreeInput(eventBody))).resolves.toBeUndefined();
    expect(database.receipts.size).toBe(1);
    expect(database.orders.get(`${COMPANY_ID}:cashfree-local-1`)).toMatchObject({
      status: "paid",
      provider_order_id: "cashfree-provider-1",
    });

    const changedBody = {
      ...eventBody,
      event_time: "2026-11-04T10:00:01.000Z",
    };
    await expect(plugin.definition.onWebhook?.(cashfreeInput(changedBody))).rejects.toThrow(
      "already used with a different payload",
    );
    expect(database.receipts.size).toBe(1);
    const conflictingProviderOrder = {
      ...eventBody,
      data: { ...eventBody.data, order: { ...eventBody.data.order, order_id: "cashfree-provider-other" } },
    };
    await expect(plugin.definition.onWebhook?.(cashfreeInput(conflictingProviderOrder)))
      .rejects.toThrow("does not match the stored Paperclip order association");
    expect(database.receipts.size).toBe(1);
  });

  it("rejects invalid Cashfree signatures and signed order tags without a matching local order", async () => {
    const harness = createTestHarness({
      manifest,
      config: { cashfreeWebhookSecretRef: SECRET_REF },
    });
    const database = paymentDatabase(harness);
    await plugin.definition.setup(harness.ctx);
    await createPaymentOrder("cashfree", "cashfree-local-2");

    const body = {
      type: "PAYMENT_SUCCESS_WEBHOOK",
      event_time: "2026-11-04T10:00:00.000Z",
      data: {
        order: {
          order_id: "cashfree-provider-2",
          order_tags: buildPaymentOrderMetadata("cashfree", COMPANY_ID, "cashfree-local-2").order_tags,
        },
        payment: { cf_payment_id: "cashfree-payment-2", payment_status: "SUCCESS" },
      },
    };
    const invalidSignature = cashfreeInput(body);
    invalidSignature.headers["x-webhook-signature"] = `A${invalidSignature.headers["x-webhook-signature"].slice(1)}`;
    await expect(plugin.definition.onWebhook?.(invalidSignature)).rejects.toThrow("signature is invalid");
    expect(database.receipts.size).toBe(0);

    const wrongCompany = {
      ...body,
      data: {
        ...body.data,
        order: {
          ...body.data.order,
          order_tags: buildPaymentOrderMetadata("cashfree", OTHER_COMPANY_ID, "cashfree-local-2").order_tags,
        },
      },
    };
    await expect(plugin.definition.onWebhook?.(cashfreeInput(wrongCompany)))
      .rejects.toThrow("does not match a known Paperclip payment order");
    expect(database.receipts.size).toBe(0);
  });

  it("creates Paddle custom_data and accepts signed, idempotent transaction status events", async () => {
    const harness = createTestHarness({
      manifest,
      config: { paddleWebhookSecretRef: SECRET_REF },
    });
    const database = paymentDatabase(harness);
    await plugin.definition.setup(harness.ctx);
    const created = await createPaymentOrder("paddle", "paddle-local-1");
    expect(created).toMatchObject({
      status: 201,
      body: {
        order: {
          providerMetadata: {
            custom_data: {
              paperclip_company_id: COMPANY_ID,
              paperclip_payment_order_id: "paddle-local-1",
            },
          },
        },
      },
    });
    const eventBody = {
      event_id: "paddle-event-1",
      event_type: "transaction.completed",
      occurred_at: "2026-11-04T10:01:00.000Z",
      data: {
        id: "txn_synthetic_1",
        status: "completed",
        custom_data: buildPaymentOrderMetadata("paddle", COMPANY_ID, "paddle-local-1").custom_data,
      },
    };
    const invalidSignature = paddleInput(eventBody);
    invalidSignature.headers["paddle-signature"] = "ts=bad;h1=invalid";
    await expect(plugin.definition.onWebhook?.(invalidSignature)).rejects.toThrow("signature is invalid");
    expect(database.receipts.size).toBe(0);
    await expect(plugin.definition.onWebhook?.(paddleInput(eventBody))).resolves.toBeUndefined();
    await expect(plugin.definition.onWebhook?.(paddleInput(eventBody))).resolves.toBeUndefined();
    expect(database.receipts.size).toBe(1);
    expect(database.orders.get(`${COMPANY_ID}:paddle-local-1`)).toMatchObject({ status: "paid" });

    const changedBody = {
      ...eventBody,
      occurred_at: "2026-11-04T10:01:01.000Z",
    };
    await expect(plugin.definition.onWebhook?.(paddleInput(changedBody))).rejects.toThrow(
      "already used with a different payload",
    );
    expect(database.receipts.size).toBe(1);
  });

  it("stores a signed lead as a lead and CRM request, deduplicates replay, and rejects changed payloads", async () => {
    const harness = createTestHarness({
      manifest,
      config: { intakeWebhookSecretRef: SECRET_REF },
    });
    await plugin.definition.setup(harness.ctx);

    const makeInput = (message: string) => webhookInput("intake", JSON.stringify({
      companyId: COMPANY_ID,
      eventId: "lead-event-1",
      eventType: "lead.created",
      lead: {
        name: "Synthetic Contact",
        email: "contact@example.test",
        business: "Example Test Co",
        message,
        source: "website",
        attribution: { campaign: "synthetic-campaign" },
      },
    }));

    await expect(plugin.definition.onWebhook?.(makeInput("Interested in a pilot."))).resolves.toBeUndefined();
    await expect(plugin.definition.onWebhook?.(makeInput("Interested in a pilot."))).resolves.toBeUndefined();
    await expect(plugin.definition.onWebhook?.(makeInput("Changed request."))).rejects.toThrow(
      "already used with a different payload",
    );
    const leads = await harness.ctx.entities.list({
      entityType: ENTITY_TYPES.lead,
      scopeKind: "company",
      scopeId: COMPANY_ID,
      externalId: "lead-event-1",
      limit: 10,
    });
    const requests = await harness.ctx.entities.list({
      entityType: ENTITY_TYPES.request,
      scopeKind: "company",
      scopeId: COMPANY_ID,
      externalId: "lead-event-1:request",
      limit: 10,
    });
    expect(leads).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.data).toMatchObject({
      business: "Example Test Co",
      status: "open",
      firstTouch: "website",
      attribution: { campaign: "synthetic-campaign" },
    });
  });

  it("validates public support submissions and leaves one company-scoped ticket per event", async () => {
    const harness = createTestHarness({
      manifest,
      config: { intakeWebhookSecretRef: SECRET_REF },
    });
    await plugin.definition.setup(harness.ctx);

    const body = {
      companyId: COMPANY_ID,
      eventId: "support-event-1",
      eventType: "support_ticket.created",
      ticket: {
        name: "Synthetic Requester",
        email: "requester@example.test",
        subject: "Delivery help",
        message: "Please review this test delivery.",
        category: "general",
      },
    };
    const rawBody = JSON.stringify(body);
    await plugin.definition.onWebhook?.(webhookInput("intake", rawBody));
    await plugin.definition.onWebhook?.(webhookInput("intake", rawBody));

    const tickets = await harness.ctx.entities.list({
      entityType: ENTITY_TYPES.supportTicket,
      scopeKind: "company",
      scopeId: COMPANY_ID,
      externalId: "support-event-1",
      limit: 10,
    });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.data).toMatchObject({
      email: "requester@example.test",
      status: "open",
      priority: "normal",
    });

    const invalidBody = JSON.stringify({ ...body, eventId: "support-event-invalid", ticket: { ...body.ticket, email: "not-an-email" } });
    await expect(plugin.definition.onWebhook?.(webhookInput("intake", invalidBody))).rejects.toThrow(
      "invalid shape",
    );
  });

  it("supports company-authorized support triage with validated status, priority, assignee, and resolution", async () => {
    const harness = createTestHarness({
      manifest,
      config: { intakeWebhookSecretRef: SECRET_REF },
    });
    await plugin.definition.setup(harness.ctx);
    const rawBody = JSON.stringify({
      companyId: COMPANY_ID,
      eventId: "triage-ticket-1",
      eventType: "support_ticket.created",
      ticket: {
        name: "Synthetic Requester",
        email: "requester@example.test",
        subject: "Delivery help",
        message: "Please review this test delivery.",
      },
    });
    await plugin.definition.onWebhook?.(webhookInput("intake", rawBody));

    const updated = await plugin.definition.onApiRequest?.({
      ...apiInput("update-record", {
        companyId: COMPANY_ID,
        patch: { status: "in_progress", priority: "high", assignedTo: "Support operator", resolution: "Reviewing the report." },
      }, { entityType: ENTITY_TYPES.supportTicket, externalId: "triage-ticket-1" }),
      method: "PATCH",
    });
    expect(updated).toMatchObject({
      status: 200,
      body: {
        status: "in_progress",
        data: {
          status: "in_progress",
          priority: "high",
          assignedTo: "Support operator",
          resolution: "Reviewing the report.",
        },
      },
    });

    const invalid = await plugin.definition.onApiRequest?.({
      ...apiInput("update-record", {
        companyId: COMPANY_ID,
        patch: { status: "deleted" },
      }, { entityType: ENTITY_TYPES.supportTicket, externalId: "triage-ticket-1" }),
      method: "PATCH",
    });
    expect(invalid).toMatchObject({ status: 422 });
  });

  it("creates and updates CRM records only in the host-authorized company", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const create = await plugin.definition.onApiRequest?.(apiInput("create-request", {
      companyId: COMPANY_ID,
      externalId: "request-1",
      business: "Example Test Co",
      email: "contact@example.test",
      contactName: "Synthetic Contact",
      message: "A synthetic request for migration coverage.",
      value: 100,
    }));
    expect(create).toMatchObject({ status: 201 });
    const replay = await plugin.definition.onApiRequest?.(apiInput("create-request", {
      companyId: COMPANY_ID,
      externalId: "request-1",
      business: "Example Test Co",
      email: "contact@example.test",
      contactName: "Synthetic Contact",
      message: "A synthetic request for migration coverage.",
      value: 100,
    }));
    expect(replay).toMatchObject({ status: 200, body: { created: false } });
    const scopedList = await plugin.definition.onApiRequest?.({
      ...apiInput("list-records", null),
      query: {},
    });
    expect(scopedList).toMatchObject({
      status: 200,
      body: { records: [expect.objectContaining({ externalId: "request-1", scopeId: COMPANY_ID })] },
    });

    const mismatch = await plugin.definition.onApiRequest?.(apiInput("create-request", {
      companyId: OTHER_COMPANY_ID,
      externalId: "other-request",
      business: "Other",
      message: "Should not be stored",
    }));
    expect(mismatch).toMatchObject({ status: 403 });
    const crossCompany = await plugin.definition.onApiRequest?.({
      ...apiInput("list-records", null),
      query: { entityType: ENTITY_TYPES.request },
      companyId: OTHER_COMPANY_ID,
    });
    expect(crossCompany).toMatchObject({ status: 200, body: { records: [] } });
  });

  it("converts a won CRM request into a pending client without claiming provisioning", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const action = (operation: string, params: Record<string, unknown>) => harness.performAction(
      "admin-mutation",
      { ...params, operation, companyId: COMPANY_ID },
      { companyId: COMPANY_ID, actor: { ...USER, companyId: COMPANY_ID } },
    );

    await action("create-request", {
      externalId: "won-request",
      business: "Example Test Co",
      contactName: "Synthetic Contact",
      email: "contact@example.test",
      message: "Synthetic won opportunity.",
    });
    await action("update-record", {
      entityType: ENTITY_TYPES.request,
      externalId: "won-request",
      patch: { status: "closed_won" },
    });
    const converted = await action("convert-request", { externalId: "won-request" });
    expect(converted).toMatchObject({
      created: true,
      client: { status: "pending", data: { onboardingStatus: "manual_setup_required" } },
      request: { status: "closed_won", data: { onboardingStatus: "manual_setup_required" } },
    });
    const replay = await action("convert-request", { externalId: "won-request" });
    expect(replay).toMatchObject({ created: false, client: { externalId: "request:won-request" } });
  });

  it("creates or reuses a native Paperclip follow-up task for a CRM request", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await harness.performAction(
      "admin-mutation",
      {
        operation: "create-request",
        companyId: COMPANY_ID,
        externalId: "task-request",
        business: "Example Test Co",
        email: "contact@example.test",
        message: "Needs an operator follow-up.",
      },
      { companyId: COMPANY_ID, actor: { ...USER, companyId: COMPANY_ID } },
    );

    const first = await harness.performAction<{ issueId: string }>(
      "create-follow-up-issue",
      { companyId: COMPANY_ID, entityType: ENTITY_TYPES.request, externalId: "task-request" },
      { companyId: COMPANY_ID, actor: { ...USER, companyId: COMPANY_ID } },
    );
    const second = await harness.performAction<{ issueId: string }>(
      "create-follow-up-issue",
      { companyId: COMPANY_ID, entityType: ENTITY_TYPES.request, externalId: "task-request" },
      { companyId: COMPANY_ID, actor: { ...USER, companyId: COMPANY_ID } },
    );
    expect(first.issueId).toBe(second.issueId);
  });

  it("uses the supplied company scope for UI data and rejects invalid company identifiers", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.getData("overview", { companyId: "not-a-company" })).rejects.toThrow(
      "A valid company scope is required",
    );
    await expect(harness.getData("overview", { companyId: COMPANY_ID })).resolves.toMatchObject({
      pluginId: "paperclipai.plugin-archlead-operations",
      leads: [],
      requests: [],
      clients: [],
      tickets: [],
      paymentReceipts: [],
      pipelineValue: 0,
    });
  });

  it("requires a board user for UI mutations and rejects a spoofed company", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await expect(harness.performAction("admin-mutation", {
      companyId: COMPANY_ID,
      operation: "create-request",
      externalId: "blocked",
      business: "Example Test Co",
      message: "No unauthenticated write.",
    })).rejects.toThrow("authenticated Paperclip board user");
    const rebound = await harness.performAction("admin-mutation", {
      companyId: OTHER_COMPANY_ID,
      operation: "create-request",
      externalId: "host-scoped-request",
      business: "Example Test Co",
      message: "No cross-company write.",
    }, { companyId: COMPANY_ID, actor: { ...USER, companyId: COMPANY_ID } });
    expect(rebound).toMatchObject({ record: { scopeId: COMPANY_ID } });
    expect(await harness.ctx.entities.list({
      entityType: ENTITY_TYPES.request,
      scopeKind: "company",
      scopeId: OTHER_COMPANY_ID,
      limit: 10,
    })).toHaveLength(0);
  });

  it("fails scheduled-operation hooks instead of reporting unported work as successful", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    await expect(harness.runJob("gmail-sync")).rejects.toThrow("business logic has not been ported");
  });

  it("exposes totals and pagination in overview data query", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const overview = await harness.getData<{
      totals: { leads: number; requests: number; isLimited: boolean };
      pagination: { limit: number; offset: number };
    }>("overview", { companyId: COMPANY_ID });
    expect(overview.totals).toMatchObject({ leads: 0, requests: 0, isLimited: false });
    expect(overview.pagination).toMatchObject({ limit: 200, offset: 0 });
  });

  it("self-heals and recovers an unfinished sandbox qualification task on retry", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);
    const body = {
      companyId: COMPANY_ID,
      externalLeadId: "sandbox:retry-lead",
      sandbox: true,
      lead: {
        name: "Retry Lead",
        email: "retry@example.test",
        business: "Retry Co",
      },
    };
    const first = await plugin.definition.onApiRequest?.({
      ...apiInput("create-qualification-task", body),
    });
    expect(first?.status).toBe(201);

    // Calling again with the same externalLeadId recovers the task
    const second = await plugin.definition.onApiRequest?.({
      ...apiInput("create-qualification-task", body),
    });
    expect(second?.status).toBe(200);
    expect(second?.body).toMatchObject({
      issueId: (first?.body as any).issueId,
      interactionId: (first?.body as any).interactionId,
      synthetic: true,
      qualificationStatus: "pending_review",
    });
  });
});
