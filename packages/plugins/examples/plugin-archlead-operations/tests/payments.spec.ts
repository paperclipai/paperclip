import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import {
  buildPaymentOrderMetadata,
  verifyCashfreeSignature,
  verifyPaddleSignature,
} from "../src/contracts.js";

const COMPANY_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_COMPANY_ID = "223e4567-e89b-42d3-a456-426614174000";
const SECRET_REF = { type: "secret_ref", secretId: "test-secret", version: "latest" } as const;
const RESOLVED_SECRET = "resolved:[object Object]";
const USER = { type: "user", userId: "operator-1" } as const;

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

describe("ArchLead Operations payments", () => {
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
});
