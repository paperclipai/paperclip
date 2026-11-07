import type {
  PluginContext,
  PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import {
  buildPaymentOrderMetadata,
  canonicalJson,
  isCompanyId,
  isRecord,
  isSecretRef,
  parseCashfreeStatusEvent,
  parseCreatePaymentOrderInput,
  parsePaddleStatusEvent,
  payloadSha256,
  PluginRequestError,
  verifyCashfreeSignature,
  verifyPaddleSignature,
  type PaymentProvider,
} from "./contracts.js";
import { logMutation } from "./crm.js";

export const PAYMENT_ORDERS_TABLE = "payment_orders";
export const PAYMENT_RECEIPTS_TABLE = "payment_event_receipts";

export function tableName(namespace: string): string {
  return `${namespace}.${PAYMENT_RECEIPTS_TABLE}`;
}

export function paymentOrdersTable(namespace: string): string {
  return `${namespace}.${PAYMENT_ORDERS_TABLE}`;
}

export function headerValue(headers: Record<string, string | string[]>, name: string): string | null {
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (typeof value === "string") return value;
  return Array.isArray(value) && value.length === 1 ? value[0] : null;
}

export function parseJson(rawBody: string): Record<string, unknown> {
  if (Buffer.byteLength(rawBody, "utf8") > 64 * 1024) {
    throw new Error("Webhook body exceeds the 64 KiB limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new Error("Webhook body must be valid JSON");
  }
  if (!isRecord(value)) throw new Error("Webhook body must be a JSON object");
  return value;
}

export async function verifyCompanyWebhook(
  ctx: PluginContext,
  input: PluginWebhookInput,
  companyId: string,
  configKey: "intakeWebhookSecretRef" | "cashfreeWebhookSecretRef" | "paddleWebhookSecretRef",
  verifyFn: (rawBody: string, timestamp: string | null, signature: string | null, secret: string) => boolean,
  timestampHeader = "x-archlead-timestamp",
  signatureHeader = "x-archlead-signature",
): Promise<void> {
  const config = await ctx.config.get(companyId);
  const secretRef = config[configKey];
  if (!isSecretRef(secretRef)) throw new Error(`Company webhook secret reference is not configured: ${configKey}`);
  const secret = await ctx.secrets.resolve(secretRef, { companyId, configPath: configKey });
  const valid = verifyFn(
    input.rawBody,
    headerValue(input.headers, timestampHeader),
    headerValue(input.headers, signatureHeader),
    secret,
  );
  if (!valid) throw new Error("Webhook signature is invalid or outside the allowed timestamp window");
}

export async function verifyPaymentProviderWebhook(
  ctx: PluginContext,
  input: PluginWebhookInput,
  companyId: string,
  provider: PaymentProvider,
): Promise<void> {
  const configKey = provider === "cashfree" ? "cashfreeWebhookSecretRef" : "paddleWebhookSecretRef";
  const config = await ctx.config.get(companyId);
  const secretRef = config[configKey];
  if (!isSecretRef(secretRef)) throw new Error(`${provider} webhook secret reference is not configured`);
  const secret = await ctx.secrets.resolve(secretRef, { companyId, configPath: configKey });
  const verified = provider === "cashfree"
    ? verifyCashfreeSignature(
      input.rawBody,
      headerValue(input.headers, "x-webhook-timestamp"),
      headerValue(input.headers, "x-webhook-signature"),
      secret,
    )
    : verifyPaddleSignature(
      input.rawBody,
      headerValue(input.headers, "paddle-signature"),
      secret,
    );
  if (!verified) throw new Error(`${provider} webhook signature is invalid`);
}

export function paymentEventCompanyId(value: unknown, provider: PaymentProvider): string | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const metadata = provider === "cashfree"
    ? isRecord(value.data.order) ? value.data.order.order_tags : null
    : value.data.custom_data;
  if (!isRecord(metadata) || !isCompanyId(metadata.paperclip_company_id)) return null;
  return metadata.paperclip_company_id;
}

export async function createPaymentOrder(
  ctx: PluginContext,
  companyId: string,
  body: unknown,
): Promise<{ created: boolean; order: Record<string, unknown> }> {
  const input = parseCreatePaymentOrderInput(body);
  if (!input) throw new PluginRequestError(422, "Payment order provider, ID, amount, currency, or plan is invalid");
  const digest = payloadSha256(canonicalJson(input));
  const orders = paymentOrdersTable(ctx.db.namespace);
  const inserted = await ctx.db.execute(
    `INSERT INTO ${orders} (
       company_id, external_id, provider, amount, currency, plan_id, request_sha256
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company_id, external_id) DO NOTHING`,
    [companyId, input.externalId, input.provider, input.amount, input.currency, input.planId, digest],
  );
  const records = await ctx.db.query<Record<string, unknown>>(
    `SELECT company_id, external_id, provider, amount, currency, plan_id, status, request_sha256
     FROM ${orders}
     WHERE company_id = $1 AND external_id = $2
     LIMIT 1`,
    [companyId, input.externalId],
  );
  const stored = records[0];
  if (!stored) throw new Error("Payment order was not persisted");
  if (stored.request_sha256 !== digest) {
    throw new PluginRequestError(409, "Payment order ID was already used with different order details");
  }
  return {
    created: inserted.rowCount > 0,
    order: {
      externalId: input.externalId,
      provider: input.provider,
      amount: input.amount,
      currency: input.currency,
      planId: input.planId,
      status: stored.status,
      providerMetadata: buildPaymentOrderMetadata(input.provider, companyId, input.externalId),
    },
  };
}

export async function persistPaymentStatusEvent(
  ctx: PluginContext,
  provider: PaymentProvider,
  event: NonNullable<ReturnType<typeof parseCashfreeStatusEvent>>,
  rawBody: string,
): Promise<void> {
  const orders = paymentOrdersTable(ctx.db.namespace);
  const receipts = tableName(ctx.db.namespace);
  const matchingOrders = await ctx.db.query<Record<string, unknown>>(
    `SELECT company_id, external_id, provider, provider_order_id
     FROM ${orders}
     WHERE company_id = $1 AND external_id = $2
     LIMIT 1`,
    [event.companyId, event.paymentOrderId],
  );
  const order = matchingOrders[0];
  if (!order) throw new Error("Signed payment metadata does not match a known Paperclip payment order");
  if (order.provider !== provider) throw new Error("Signed payment order belongs to a different provider");
  if (event.providerOrderId && order.provider_order_id && order.provider_order_id !== event.providerOrderId) {
    throw new Error("Signed provider order ID does not match the stored Paperclip order association");
  }

  const digest = payloadSha256(rawBody);
  const receiptInsert = await ctx.db.execute(
    `INSERT INTO ${receipts} (
       provider, event_id, company_id, order_external_id, provider_resource_id,
       payment_status, occurred_at, payload_sha256
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (provider, event_id) DO NOTHING`,
    [
      provider,
      event.eventId,
      event.companyId,
      event.paymentOrderId,
      event.providerResourceId,
      event.status,
      event.occurredAt,
      digest,
    ],
  );
  const storedEvents = await ctx.db.query<Record<string, unknown>>(
    `SELECT company_id, order_external_id, provider_resource_id, payment_status, occurred_at, payload_sha256
     FROM ${receipts}
     WHERE provider = $1 AND event_id = $2
     LIMIT 1`,
    [provider, event.eventId],
  );
  const storedEvent = storedEvents[0];
  if (!storedEvent) throw new Error("Signed payment status receipt was not persisted");
  if (storedEvent.company_id !== event.companyId
    || storedEvent.order_external_id !== event.paymentOrderId
    || storedEvent.provider_resource_id !== event.providerResourceId
    || storedEvent.payment_status !== event.status
    || storedEvent.payload_sha256 !== digest) {
    throw new Error("Payment event ID was already used with a different payload or order association");
  }

  const statusUpdate = await ctx.db.execute(
    `UPDATE ${orders}
     SET provider_order_id = COALESCE(provider_order_id, $3),
         status = $5,
         latest_event_at = $4,
         updated_at = now()
     WHERE company_id = $1 AND external_id = $2
       AND ($3::text IS NULL OR provider_order_id IS NULL OR provider_order_id = $3)
       AND (latest_event_at IS NULL OR latest_event_at <= $4)`,
    [event.companyId, event.paymentOrderId, event.providerOrderId, event.occurredAt, event.status],
  );
  if (statusUpdate.rowCount === 0 && event.providerOrderId) {
    const currentOrders = await ctx.db.query<Record<string, unknown>>(
      `SELECT provider_order_id
       FROM ${orders}
       WHERE company_id = $1 AND external_id = $2
       LIMIT 1`,
      [event.companyId, event.paymentOrderId],
    );
    if (currentOrders[0]?.provider_order_id
      && currentOrders[0].provider_order_id !== event.providerOrderId) {
      throw new Error("Signed provider order ID does not match the stored Paperclip order association");
    }
  }
  if (receiptInsert.rowCount > 0) {
    await logMutation(ctx, event.companyId, "archlead-payment-order", event.paymentOrderId, "Received a verified payment status event", {
      provider,
      eventId: event.eventId,
      status: event.status,
    });
  }
}

export async function acceptCashfreeStatusEvent(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  const untrusted = parseJson(input.rawBody);
  const companyId = paymentEventCompanyId(untrusted, "cashfree");
  if (!companyId) throw new Error("Cashfree webhook is missing signed Paperclip order tags");
  await verifyPaymentProviderWebhook(ctx, input, companyId, "cashfree");
  const event = parseCashfreeStatusEvent(untrusted);
  if (!event) throw new Error("Cashfree payment status event has an invalid shape or unsupported status");
  await persistPaymentStatusEvent(ctx, "cashfree", event, input.rawBody);
}

export async function acceptPaddleStatusEvent(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  const untrusted = parseJson(input.rawBody);
  const companyId = paymentEventCompanyId(untrusted, "paddle");
  if (!companyId) throw new Error("Paddle webhook is missing signed Paperclip custom_data");
  await verifyPaymentProviderWebhook(ctx, input, companyId, "paddle");
  const event = parsePaddleStatusEvent(untrusted);
  if (!event) throw new Error("Paddle transaction status event has an invalid shape or unsupported status");
  await persistPaymentStatusEvent(ctx, "paddle", event, input.rawBody);
}
