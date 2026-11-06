import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginEntityRecord,
  type PluginPerformActionContext,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import {
  canonicalJson,
  ENTITY_TYPES,
  buildPaymentOrderMetadata,
  isCompanyId,
  isEmail,
  isRecord,
  isSecretRef,
  optionalStringField,
  parseIntakeEvent,
  parseCashfreeStatusEvent,
  parseCreatePaymentOrderInput,
  parsePaddleStatusEvent,
  parseLead,
  parseSandboxQualificationInput,
  parseSupportTicket,
  payloadSha256,
  stringField,
  verifyCashfreeSignature,
  verifyPaddleSignature,
  verifyWebhookSignature,
  type ArchLeadEntityType,
  type LeadRecord,
  type PaymentProvider,
  type PaymentReceipt,
  type SandboxQualificationInput,
  type SupportTicketRecord,
} from "./contracts.js";
import { OPERATIONS_JOBS, PLUGIN_ID } from "./manifest.js";

const PAYMENT_ORDERS_TABLE = "payment_orders";
const PAYMENT_RECEIPTS_TABLE = "payment_event_receipts";
const MAX_RECORDS = 200;
const REQUEST_STATUSES = ["open", "qualified", "proposal", "closed_won", "closed_lost"] as const;
const CLIENT_STATUSES = ["pending", "active", "paused"] as const;
const TICKET_STATUSES = ["open", "needs_human", "in_progress", "waiting_on_customer", "resolved"] as const;
const FOLLOW_UP_ORIGIN = `plugin:${PLUGIN_ID}:follow-up`;
const QUALIFICATION_ORIGIN = `plugin:${PLUGIN_ID}:sandbox-qualification`;
const JOB_BLOCKED_MESSAGE = "This ArchLead operation is a migration hook only; its business logic has not been ported.";
const qualificationLocks = new Map<string, Promise<void>>();

let activeContext: PluginContext | null = null;

class PluginRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "PluginRequestError";
  }
}

function tableName(namespace: string): string {
  return `${namespace}.${PAYMENT_RECEIPTS_TABLE}`;
}

function paymentOrdersTable(namespace: string): string {
  return `${namespace}.${PAYMENT_ORDERS_TABLE}`;
}

function headerValue(headers: Record<string, string | string[]>, name: string): string | null {
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  if (typeof value === "string") return value;
  return Array.isArray(value) && value.length === 1 ? value[0] : null;
}

function parseJson(rawBody: string): Record<string, unknown> {
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

async function verifyCompanyWebhook(
  ctx: PluginContext,
  input: PluginWebhookInput,
  companyId: string,
  configKey: "intakeWebhookSecretRef" | "cashfreeWebhookSecretRef" | "paddleWebhookSecretRef",
): Promise<void> {
  const config = await ctx.config.get(companyId);
  const secretRef = config[configKey];
  if (!isSecretRef(secretRef)) throw new Error(`Company webhook secret reference is not configured: ${configKey}`);
  const secret = await ctx.secrets.resolve(secretRef, { companyId, configPath: configKey });
  const valid = verifyWebhookSignature(
    input.rawBody,
    headerValue(input.headers, "x-archlead-timestamp"),
    headerValue(input.headers, "x-archlead-signature"),
    secret,
  );
  if (!valid) throw new Error("Webhook signature is invalid or outside the allowed timestamp window");
}

async function verifyPaymentProviderWebhook(
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

function paymentEventCompanyId(value: unknown, provider: PaymentProvider): string | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const metadata = provider === "cashfree"
    ? isRecord(value.data.order) ? value.data.order.order_tags : null
    : value.data.custom_data;
  if (!isRecord(metadata) || !isCompanyId(metadata.paperclip_company_id)) return null;
  return metadata.paperclip_company_id;
}

async function createPaymentOrder(
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

async function persistPaymentStatusEvent(
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
       AND ($3 IS NULL OR provider_order_id IS NULL OR provider_order_id = $3)
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

async function acceptCashfreeStatusEvent(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  const untrusted = parseJson(input.rawBody);
  const companyId = paymentEventCompanyId(untrusted, "cashfree");
  if (!companyId) throw new Error("Cashfree webhook is missing signed Paperclip order tags");
  await verifyPaymentProviderWebhook(ctx, input, companyId, "cashfree");
  const event = parseCashfreeStatusEvent(untrusted);
  if (!event) throw new Error("Cashfree payment status event has an invalid shape or unsupported status");
  await persistPaymentStatusEvent(ctx, "cashfree", event, input.rawBody);
}

async function acceptPaddleStatusEvent(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  const untrusted = parseJson(input.rawBody);
  const companyId = paymentEventCompanyId(untrusted, "paddle");
  if (!companyId) throw new Error("Paddle webhook is missing signed Paperclip custom_data");
  await verifyPaymentProviderWebhook(ctx, input, companyId, "paddle");
  const event = parsePaddleStatusEvent(untrusted);
  if (!event) throw new Error("Paddle transaction status event has an invalid shape or unsupported status");
  await persistPaymentStatusEvent(ctx, "paddle", event, input.rawBody);
}

function scopedEntityType(value: unknown): ArchLeadEntityType | null {
  return typeof value === "string"
    && Object.values(ENTITY_TYPES).includes(value as ArchLeadEntityType)
    ? value as ArchLeadEntityType
    : null;
}

async function findEntity(
  ctx: PluginContext,
  companyId: string,
  entityType: ArchLeadEntityType,
  externalId: string,
): Promise<PluginEntityRecord | null> {
  const records = await ctx.entities.list({
    entityType,
    scopeKind: "company",
    scopeId: companyId,
    externalId,
    limit: 1,
  });
  return records[0] ?? null;
}

async function upsertEntity(
  ctx: PluginContext,
  companyId: string,
  entityType: ArchLeadEntityType,
  externalId: string,
  title: string,
  status: string,
  data: Record<string, unknown>,
): Promise<PluginEntityRecord> {
  return ctx.entities.upsert({
    entityType,
    scopeKind: "company",
    scopeId: companyId,
    externalId,
    title,
    status,
    data,
  });
}

async function logMutation(
  ctx: PluginContext,
  companyId: string,
  entityType: string,
  entityId: string,
  message: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await ctx.activity.log({
    companyId,
    entityType,
    entityId,
    message,
    metadata: { pluginId: PLUGIN_ID, ...metadata },
  });
}

async function upsertIdempotentEntity(
  ctx: PluginContext,
  input: {
    companyId: string;
    entityType: ArchLeadEntityType;
    externalId: string;
    title: string;
    status: string;
    data: Record<string, unknown>;
  },
): Promise<{ record: PluginEntityRecord; created: boolean }> {
  const existing = await findEntity(ctx, input.companyId, input.entityType, input.externalId);
  if (existing) {
    const storedDigest = existing.data.sourcePayloadSha256;
    const incomingDigest = input.data.sourcePayloadSha256;
    if (typeof storedDigest === "string" && typeof incomingDigest === "string") {
      if (storedDigest !== incomingDigest) {
        throw new Error("This external ID was already used with a different payload");
      }
    } else if (canonicalJson(existing.data) !== canonicalJson(input.data)) {
      throw new Error("This external ID was already used with different record data");
    }
    return { record: existing, created: false };
  }
  return {
    record: await upsertEntity(
      ctx,
      input.companyId,
      input.entityType,
      input.externalId,
      input.title,
      input.status,
      input.data,
    ),
    created: true,
  };
}

function requestMessage(lead: LeadRecord): string {
  if (lead.message) return lead.message;
  return [
    lead.idealBuyer ? `Ideal buyer: ${lead.idealBuyer}` : null,
    lead.regions ? `Regions: ${lead.regions}` : null,
    lead.volume ? `Volume: ${lead.volume}` : null,
  ].filter(Boolean).join(". ");
}

async function storeLead(
  ctx: PluginContext,
  companyId: string,
  externalId: string,
  lead: LeadRecord,
  digest: string,
): Promise<{ lead: PluginEntityRecord; request: PluginEntityRecord; created: boolean }> {
  const requestId = `${externalId}:request`;
  const leadData = { ...lead, sourcePayloadSha256: digest };
  const requestData = {
    business: lead.business,
    contactName: lead.name,
    email: lead.email,
    message: requestMessage(lead),
    kind: "inbound-lead",
    status: "open",
    value: 0,
    source: lead.source,
    firstTouch: lead.source,
    lastTouch: lead.source,
    attribution: lead.attribution,
    referrer: lead.referrer,
    leadExternalId: externalId,
    onboardingStatus: "not_started",
    sourcePayloadSha256: digest,
  };

  const existingLead = await findEntity(ctx, companyId, ENTITY_TYPES.lead, externalId);
  const existingRequest = await findEntity(ctx, companyId, ENTITY_TYPES.request, requestId);
  for (const [existing, incoming] of [[existingLead, leadData], [existingRequest, requestData]] as const) {
    if (existing && existing.data.sourcePayloadSha256 !== digest) {
      throw new Error("This intake event ID was already used with a different payload");
    }
    if (existing && typeof existing.data.sourcePayloadSha256 !== "string"
      && canonicalJson(existing.data) !== canonicalJson(incoming)) {
      throw new Error("This intake event ID was already used with different record data");
    }
  }

  const [{ record: leadRecord, created: leadCreated }, { record: requestRecord, created: requestCreated }] = await Promise.all([
    upsertIdempotentEntity(ctx, {
      companyId,
      entityType: ENTITY_TYPES.lead,
      externalId,
      title: lead.name,
      status: "new",
      data: leadData,
    }),
    upsertIdempotentEntity(ctx, {
      companyId,
      entityType: ENTITY_TYPES.request,
      externalId: requestId,
      title: lead.business || lead.name,
      status: "open",
      data: requestData,
    }),
  ]);
  return {
    lead: leadRecord,
    request: requestRecord,
    created: leadCreated || requestCreated,
  };
}

function supportPriority(ticket: SupportTicketRecord): "normal" | "high" {
  const urgentTerms = ["urgent", "asap", "sla", "bounce", "blocked", "failed", "dead phone", "refund", "escalate", "delivery failed"];
  const combined = `${ticket.subject} ${ticket.message} ${ticket.category}`.toLowerCase();
  return ticket.category === "sla_replacement" || urgentTerms.some((term) => combined.includes(term))
    ? "high"
    : "normal";
}

async function storeSupportTicket(
  ctx: PluginContext,
  companyId: string,
  eventId: string,
  ticket: SupportTicketRecord,
  digest: string,
): Promise<{ record: PluginEntityRecord; created: boolean }> {
  const clientRecords = await ctx.entities.list({
    entityType: ENTITY_TYPES.client,
    scopeKind: "company",
    scopeId: companyId,
    limit: MAX_RECORDS,
  });
  const client = clientRecords.find((record) => record.data.email === ticket.email);
  const data = {
    ...ticket,
    clientExternalId: client?.externalId ?? null,
    priority: supportPriority(ticket),
    status: "open",
    sourcePayloadSha256: digest,
  };
  return upsertIdempotentEntity(ctx, {
    companyId,
    entityType: ENTITY_TYPES.supportTicket,
    externalId: eventId,
    title: ticket.subject,
    status: "open",
    data,
  });
}

async function acceptIntakeEvent(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  const untrusted = parseJson(input.rawBody);
  if (!isCompanyId(untrusted.companyId)) throw new Error("Webhook companyId must be a UUID");
  await verifyCompanyWebhook(ctx, input, untrusted.companyId, "intakeWebhookSecretRef");
  const event = parseIntakeEvent(untrusted);
  if (!event) throw new Error("Intake webhook event has an invalid shape");
  const digest = payloadSha256(canonicalJson(event));

  if (event.eventType === "lead.created" && event.lead) {
    const stored = await storeLead(ctx, event.companyId, event.eventId, event.lead, digest);
    if (stored.created) {
      await logMutation(ctx, event.companyId, ENTITY_TYPES.request, stored.request.id, "Received an ArchLead lead and CRM request", {
        eventId: event.eventId,
      });
    }
    return;
  }
  if (event.eventType === "support_ticket.created" && event.ticket) {
    const stored = await storeSupportTicket(ctx, event.companyId, event.eventId, event.ticket, digest);
    if (stored.created) {
      await logMutation(ctx, event.companyId, ENTITY_TYPES.supportTicket, stored.record.id, "Received an ArchLead support ticket", {
        eventId: event.eventId,
      });
    }
    return;
  }
  throw new Error("Unsupported intake webhook event");
}

function parseLimit(value: string | string[] | undefined): number | null {
  if (value === undefined) return 50;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_RECORDS) : null;
}

function requireCompanyScope(companyId: unknown): string {
  if (!isCompanyId(companyId)) throw new Error("A valid company scope is required");
  return companyId;
}

function requireMatchingCompany(body: unknown, companyId: string): Record<string, unknown> {
  if (!isRecord(body)) throw new PluginRequestError(400, "Request body must be an object");
  if (body.companyId !== companyId) throw new PluginRequestError(403, "Request company does not match the authorized company");
  return body;
}

function createRequestData(body: Record<string, unknown>): {
  externalId: string;
  title: string;
  status: string;
  data: Record<string, unknown>;
} | null {
  const externalId = stringField(body.externalId, 200);
  const business = stringField(body.business, 240);
  const message = stringField(body.message ?? body.msg, 12_000);
  const contactName = optionalStringField(body.contactName ?? body.contact_name, 200);
  const emailValue = optionalStringField(body.email ?? body.contact_email, 320);
  const email = emailValue?.toLowerCase() ?? null;
  const kind = optionalStringField(body.kind, 100);
  const source = optionalStringField(body.source ?? body.contactSource ?? body.contact_source, 200);
  const rawStatus = body.status;
  const status = rawStatus === undefined || rawStatus === null || rawStatus === ""
    ? "open"
    : stringField(rawStatus, 40);
  const rawValue = body.value;
  const value = rawValue === undefined || rawValue === ""
    ? 0
    : typeof rawValue === "number" || (typeof rawValue === "string" && rawValue.trim().length > 0)
      ? Number(rawValue)
      : Number.NaN;
  if (!externalId || !business || !message || [contactName, emailValue, kind, source].includes(undefined)) return null;
  if (email && !isEmail(email)) return null;
  if (!status || !REQUEST_STATUSES.includes(status as typeof REQUEST_STATUSES[number])) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) return null;
  if (body.attribution !== undefined && body.attribution !== null && !isRecord(body.attribution)) return null;
  const attribution = isRecord(body.attribution) ? body.attribution : {};
  const normalizedAttribution: Record<string, string> = {};
  for (const key of ["source", "medium", "campaign", "content", "term"]) {
    const field = optionalStringField(attribution[key], 200);
    if (field === undefined) return null;
    if (field) normalizedAttribution[key] = field;
  }
  const firstTouchValue = body.firstTouch ?? body.first_touch;
  const lastTouchValue = body.lastTouch ?? body.last_touch;
  const firstTouch = firstTouchValue === undefined || firstTouchValue === null
    ? source ?? "manual"
    : stringField(firstTouchValue, 200);
  const lastTouch = lastTouchValue === undefined || lastTouchValue === null
    ? source ?? "manual"
    : stringField(lastTouchValue, 200);
  if (!firstTouch || !lastTouch) return null;
  return {
    externalId,
    title: business,
    status,
    data: {
      business,
      message,
      contactName: contactName ?? null,
      email,
      kind: kind ?? "request",
      status,
      value,
      source: source ?? "manual",
      firstTouch,
      lastTouch,
      attribution: normalizedAttribution,
      onboardingStatus: "not_started",
    },
  };
}

function createClientData(body: Record<string, unknown>): {
  externalId: string;
  title: string;
  data: Record<string, unknown>;
} | null {
  const externalId = stringField(body.externalId, 200);
  const business = stringField(body.business, 240);
  const email = stringField(body.email, 320)?.toLowerCase() ?? null;
  if (!externalId || !business || !email || !isEmail(email)) return null;
  const phone = optionalStringField(body.phone, 80);
  const city = optionalStringField(body.city, 200);
  const plan = optionalStringField(body.plan, 100);
  if ([phone, city, plan].includes(undefined)) return null;
  return {
    externalId,
    title: business,
    data: {
      business,
      email,
      phone: phone ?? null,
      city: city ?? null,
      plan: plan ?? "Standard",
      status: "pending",
      onboardingStatus: "manual_setup_required",
    },
  };
}

function updatedRecord(
  entityType: ArchLeadEntityType,
  existing: PluginEntityRecord,
  input: unknown,
): { title: string; status: string; data: Record<string, unknown> } | null {
  if (!isRecord(input)) return null;
  const allowedFields: Record<ArchLeadEntityType, readonly string[]> = {
    [ENTITY_TYPES.lead]: ["name", "email", "business", "phone", "message", "source"],
    [ENTITY_TYPES.request]: ["business", "contactName", "email", "message", "value", "status"],
    [ENTITY_TYPES.client]: ["business", "email", "phone", "city", "plan", "status"],
    [ENTITY_TYPES.supportTicket]: ["status", "priority", "assignedTo", "resolution"],
    [ENTITY_TYPES.qualificationTask]: [],
  };
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !allowedFields[entityType].includes(key))) return null;

  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (key === "status") {
      const statuses = entityType === ENTITY_TYPES.request
        ? REQUEST_STATUSES
        : entityType === ENTITY_TYPES.client
          ? CLIENT_STATUSES
          : entityType === ENTITY_TYPES.supportTicket
            ? TICKET_STATUSES
            : ["new", "contacted", "qualified", "converted", "closed_lost"];
      if (typeof value !== "string" || !statuses.includes(value as never)) return null;
      patch[key] = value;
      continue;
    }
    if (entityType === ENTITY_TYPES.supportTicket && key === "priority") {
      if (value !== "normal" && value !== "high") return null;
      patch[key] = value;
      continue;
    }
    if (entityType === ENTITY_TYPES.request && key === "value") {
      const numericValue = typeof value === "number" || (typeof value === "string" && value.trim().length > 0)
        ? Number(value)
        : Number.NaN;
      if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 1_000_000_000) return null;
      patch[key] = numericValue;
      continue;
    }
    const maxLength = key === "message" || key === "resolution" ? 12_000 : key === "email" ? 320 : 2_000;
    const normalized = value === "" && ["phone", "city", "assignedTo", "resolution"].includes(key)
      ? null
      : stringField(value, maxLength);
    if (normalized === null && value !== "" && !["phone", "city", "assignedTo", "resolution"].includes(key)) return null;
    if (key === "email" && normalized && !isEmail(normalized)) return null;
    patch[key] = key === "email" && normalized ? normalized.toLowerCase() : normalized;
  }

  const data = { ...existing.data, ...patch };
  if (entityType === ENTITY_TYPES.client && patch.status === "active") {
    data.onboardingStatus = "operator_confirmed";
  }
  if (entityType === ENTITY_TYPES.lead && (!data.name || typeof data.email !== "string" || !isEmail(data.email))) return null;
  if ((entityType === ENTITY_TYPES.request || entityType === ENTITY_TYPES.client) && !data.business) return null;
  if (entityType === ENTITY_TYPES.supportTicket && !data.status) return null;
  const title = entityType === ENTITY_TYPES.supportTicket
    ? String(existing.title ?? data.subject ?? "Support ticket")
    : String(data.business ?? data.name ?? existing.title ?? "ArchLead record");
  const status = typeof data.status === "string" ? data.status : existing.status ?? "new";
  return { title, status, data };
}

async function createLeadFromApi(
  ctx: PluginContext,
  companyId: string,
  body: Record<string, unknown>,
): Promise<{ created: boolean; lead: PluginEntityRecord; request: PluginEntityRecord }> {
  const externalId = stringField(body.externalId, 200);
  const lead = parseLead(body);
  if (!externalId || !lead) throw new PluginRequestError(422, "externalId, name, and a valid email are required");
  const normalized = { ...lead, externalId };
  return storeLead(ctx, companyId, externalId, lead, payloadSha256(canonicalJson(normalized)));
}

async function createRequest(
  ctx: PluginContext,
  companyId: string,
  body: Record<string, unknown>,
): Promise<{ created: boolean; record: PluginEntityRecord }> {
  const parsed = createRequestData(body);
  if (!parsed) throw new PluginRequestError(422, "Request business, message, email, status, or value is invalid");
  const digest = payloadSha256(canonicalJson(parsed.data));
  const { record, created } = await upsertIdempotentEntity(ctx, {
    companyId,
    entityType: ENTITY_TYPES.request,
    externalId: parsed.externalId,
    title: parsed.title,
    status: parsed.status,
    data: { ...parsed.data, sourcePayloadSha256: digest },
  });
  return { created, record };
}

async function createClient(
  ctx: PluginContext,
  companyId: string,
  body: Record<string, unknown>,
): Promise<{ created: boolean; record: PluginEntityRecord }> {
  const parsed = createClientData(body);
  if (!parsed) throw new PluginRequestError(422, "Client externalId, business, and valid email are required");
  const digest = payloadSha256(canonicalJson(parsed.data));
  const { record, created } = await upsertIdempotentEntity(ctx, {
    companyId,
    entityType: ENTITY_TYPES.client,
    externalId: parsed.externalId,
    title: parsed.title,
    status: "pending",
    data: { ...parsed.data, sourcePayloadSha256: digest },
  });
  return { created, record };
}

async function updateRecord(
  ctx: PluginContext,
  companyId: string,
  entityTypeValue: unknown,
  externalIdValue: unknown,
  patch: unknown,
): Promise<PluginEntityRecord> {
  const entityType = scopedEntityType(entityTypeValue);
  const externalId = stringField(externalIdValue, 200);
  if (!entityType || !externalId) throw new PluginRequestError(400, "Unsupported record type or external ID");
  const existing = await findEntity(ctx, companyId, entityType, externalId);
  if (!existing) throw new PluginRequestError(404, "ArchLead record not found");
  const updated = updatedRecord(entityType, existing, patch);
  if (!updated) throw new PluginRequestError(422, "Record update contains unsupported or invalid fields");
  return upsertEntity(ctx, companyId, entityType, externalId, updated.title, updated.status, updated.data);
}

async function convertRequestToClient(
  ctx: PluginContext,
  companyId: string,
  externalIdValue: unknown,
): Promise<{ client: PluginEntityRecord; request: PluginEntityRecord; created: boolean; linked: boolean }> {
  const requestExternalId = stringField(externalIdValue, 200);
  if (!requestExternalId) throw new PluginRequestError(400, "A request external ID is required");
  const request = await findEntity(ctx, companyId, ENTITY_TYPES.request, requestExternalId);
  if (!request) throw new PluginRequestError(404, "CRM request not found");
  if (request.status !== "closed_won") throw new PluginRequestError(409, "Only a won request can be converted into a client");
  const email = stringField(request.data.email, 320)?.toLowerCase() ?? null;
  const business = stringField(request.data.business, 240);
  if (!email || !isEmail(email) || !business) {
    throw new PluginRequestError(422, "Won request needs a business and valid contact email");
  }

  const clientExternalId = `request:${requestExternalId}`;
  const existingClient = await findEntity(ctx, companyId, ENTITY_TYPES.client, clientExternalId);
  const clientData = existingClient?.data ?? {
    business,
    email,
    phone: null,
    city: null,
    plan: "Standard",
    status: "pending",
    onboardingStatus: "manual_setup_required",
    requestExternalId,
  };
  const client = existingClient ?? await upsertEntity(
    ctx,
    companyId,
    ENTITY_TYPES.client,
    clientExternalId,
    business,
    "pending",
    clientData,
  );
  const isLinked = request.data.clientExternalId === clientExternalId;
  const updatedRequest = isLinked ? request : await upsertEntity(
    ctx,
    companyId,
    ENTITY_TYPES.request,
    requestExternalId,
    business,
    "closed_won",
    {
      ...request.data,
      onboardingStatus: "manual_setup_required",
      clientExternalId,
    },
  );
  return { client, request: updatedRequest, created: !existingClient, linked: isLinked };
}

function requireActionCompany(
  params: Record<string, unknown>,
  context: PluginPerformActionContext,
): string {
  const hostCompanyId = requireCompanyScope(context.companyId ?? context.actor.companyId);
  if (params.companyId !== undefined && params.companyId !== hostCompanyId) {
    throw new Error("Action company does not match the host-authorized company");
  }
  if (context.actor.type !== "user" || !context.actor.userId) {
    throw new Error("This action requires an authenticated Paperclip board user");
  }
  return hostCompanyId;
}

async function createFollowUpIssue(
  ctx: PluginContext,
  companyId: string,
  entityTypeValue: unknown,
  externalIdValue: unknown,
): Promise<{ issueId: string; title: string; status: string }> {
  const entityType = scopedEntityType(entityTypeValue);
  const externalId = stringField(externalIdValue, 200);
  if (!entityType || !externalId
    || (entityType !== ENTITY_TYPES.request && entityType !== ENTITY_TYPES.supportTicket)) {
    throw new Error("Follow-up issues can be created only for CRM requests and support tickets");
  }
  const record = await findEntity(ctx, companyId, entityType, externalId);
  if (!record) throw new Error("ArchLead record not found");
  const linkedId = stringField(record.data.paperclipIssueId, 100);
  if (linkedId) {
    const linked = await ctx.issues.get(linkedId, companyId);
    if (linked) return { issueId: linked.id, title: linked.title, status: linked.status };
  }

  const originId = `${entityType}:${externalId}`;
  const existingIssues = await ctx.issues.list({ companyId, originKind: FOLLOW_UP_ORIGIN, originId, limit: 1 });
  const issue = existingIssues[0] ?? await ctx.issues.create({
    companyId,
    title: `${entityType === ENTITY_TYPES.request ? "CRM follow-up" : "Support follow-up"}: ${record.title ?? "ArchLead record"}`.slice(0, 240),
    description: [
      `ArchLead record type: ${entityType}`,
      `ArchLead record ID: ${externalId}`,
      `Company: ${String(record.data.business ?? record.data.email ?? "Not specified")}`,
      `Contact: ${String(record.data.contactName ?? record.data.name ?? "Not specified")}`,
      `Email: ${String(record.data.email ?? "Not specified")}`,
      "",
      String(record.data.message ?? record.data.resolution ?? "Review the linked ArchLead Operations record."),
    ].join("\n"),
    status: "todo",
    priority: entityType === ENTITY_TYPES.supportTicket && record.data.priority === "high" ? "high" : "medium",
    originKind: FOLLOW_UP_ORIGIN,
    originId,
  });

  await upsertEntity(ctx, companyId, entityType, externalId, record.title ?? "ArchLead record", record.status ?? "open", {
    ...record.data,
    paperclipIssueId: issue.id,
  });
  await logMutation(ctx, companyId, "issue", issue.id, "Created or linked an ArchLead follow-up task", {
    recordType: entityType,
    recordExternalId: externalId,
  });
  return { issueId: issue.id, title: issue.title, status: issue.status };
}

async function withQualificationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = qualificationLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  qualificationLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (qualificationLocks.get(key) === tail) qualificationLocks.delete(key);
  }
}

function qualificationDescription(input: SandboxQualificationInput): string {
  const field = (value: string | null, fallback: string) =>
    (value ? value.replace(/[\r\n\t]+/g, " ").trim() : fallback).slice(0, 2_000);
  return [
    "Sandbox-only synthetic lead qualification task. No email, payment, or external provider action is enabled.",
    `externalLeadId: ${input.externalLeadId}`,
    "qualificationStatus: pending_review",
    "approvalStatus: required",
    "outreachStatus: blocked",
    "",
    `Synthetic lead: ${field(input.lead.name, "Not provided")}`,
    `Email: ${field(input.lead.email, "Not provided")}`,
    `Business: ${field(input.lead.business, "Not provided")}`,
    `Source: ${field(input.lead.source, "Not provided")}`,
    `Summary: ${field(input.lead.message, "Not provided")}`,
  ].join("\n");
}

function qualificationLifecycle(interactionStatus: string | null | undefined): {
  qualificationStatus: "pending_review" | "qualified" | "disqualified";
  approvalStatus: "required" | "approved" | "rejected";
  outreachStatus: "blocked";
} {
  if (interactionStatus === "accepted") {
    return { qualificationStatus: "qualified", approvalStatus: "approved", outreachStatus: "blocked" };
  }
  if (interactionStatus === "rejected") {
    return { qualificationStatus: "disqualified", approvalStatus: "rejected", outreachStatus: "blocked" };
  }
  return { qualificationStatus: "pending_review", approvalStatus: "required", outreachStatus: "blocked" };
}

async function qualificationTaskStatus(
  ctx: PluginContext,
  companyId: string,
  record: PluginEntityRecord,
) {
  const externalLeadId = stringField(record.externalId, 200);
  if (!externalLeadId) throw new Error("Stored sandbox qualification task is missing its external lead ID");
  const issueId = stringField(record.data.issueId, 100);
  const interactionId = stringField(record.data.interactionId, 100);
  const [issue, interactions] = issueId
    ? await Promise.all([
      ctx.issues.get(issueId, companyId),
      ctx.issues.listInteractions(issueId, companyId),
    ])
    : [null, []];
  const interaction = interactionId ? interactions.find((item) => item.id === interactionId) : null;
  return {
    externalLeadId,
    issueId,
    interactionId,
    issueTitle: issue?.title ?? null,
    issueStatus: issue?.status ?? null,
    interactionStatus: interaction?.status ?? null,
    synthetic: record.data.synthetic === true,
    ...qualificationLifecycle(interaction?.status),
  };
}

async function createSandboxQualificationTask(
  ctx: PluginContext,
  companyId: string,
  body: unknown,
): Promise<{
  created: boolean;
  issueId: string;
  interactionId: string;
  qualificationStatus: "pending_review" | "qualified" | "disqualified";
  approvalStatus: "required" | "approved" | "rejected";
  outreachStatus: "blocked";
  synthetic: true;
}> {
  const input = parseSandboxQualificationInput(body);
  if (!input) {
    throw new PluginRequestError(
      422,
      "Sandbox qualification requires sandbox:true, a sandbox: externalLeadId, and an @example.test email",
    );
  }
  const key = `${companyId}:${input.externalLeadId}`;
  return withQualificationLock(key, async () => {
    const digest = payloadSha256(canonicalJson(input));
    const existing = await findEntity(ctx, companyId, ENTITY_TYPES.qualificationTask, input.externalLeadId);
    if (existing && existing.data.sourcePayloadSha256 !== digest) {
      throw new PluginRequestError(409, "This synthetic lead ID was already used with different lead data");
    }

    const stored = await upsertIdempotentEntity(ctx, {
      companyId,
      entityType: ENTITY_TYPES.qualificationTask,
      externalId: input.externalLeadId,
      title: `[SANDBOX] Review lead: ${input.lead.name.replace(/[\r\n\t]+/g, " ").slice(0, 200)}`,
      status: "pending_review",
      data: {
        externalLeadId: input.externalLeadId,
        ...input.lead,
        synthetic: true,
        qualificationStatus: "pending_review",
        approvalStatus: "required",
        outreachStatus: "blocked",
        sourcePayloadSha256: digest,
      },
    });

    const originId = input.externalLeadId;
    const existingIssues = await ctx.issues.list({
      companyId,
      originKind: QUALIFICATION_ORIGIN,
      originId,
      limit: 1,
    });
    const issue = existingIssues[0] ?? await ctx.issues.create({
      companyId,
      title: `[SANDBOX] Review lead: ${input.lead.name.replace(/[\r\n\t]+/g, " ").slice(0, 200)}`,
      description: qualificationDescription(input),
      status: "todo",
      priority: "medium",
      originKind: QUALIFICATION_ORIGIN,
      originId,
    });
    const idempotencyKey = `${PLUGIN_ID}:qualification:${digest}`;
    const interactions = await ctx.issues.listInteractions(issue.id, companyId);
    const existingInteraction = interactions.find((interaction) => interaction.idempotencyKey === idempotencyKey);
    const interaction = existingInteraction ?? await ctx.issues.requestConfirmation(
      issue.id,
      {
        idempotencyKey,
        continuationPolicy: "none",
        title: "Sandbox lead qualification approval",
        summary: "Approve qualification only; external outreach remains blocked.",
        payload: {
          version: 1,
          prompt: "Does this synthetic lead qualify for the sandbox simulation?",
          acceptLabel: "Qualify synthetic lead",
          rejectLabel: "Disqualify synthetic lead",
          rejectRequiresReason: false,
          detailsMarkdown: [
            `**Synthetic lead:** ${input.lead.name.replace(/[\r\n\t]+/g, " ").slice(0, 200)}`,
            `**Email:** ${input.lead.email.replace(/[\r\n\t]+/g, " ").slice(0, 320)}`,
            `**Business:** ${(input.lead.business || "Not provided").replace(/[\r\n\t]+/g, " ").slice(0, 240)}`,
            "",
            "This decision does not send email, initiate payment, or contact a provider.",
          ].join("\n"),
        },
      },
      companyId,
    );
    const lifecycle = qualificationLifecycle(interaction.status);

    await upsertEntity(ctx, companyId, ENTITY_TYPES.qualificationTask, input.externalLeadId, issue.title, lifecycle.qualificationStatus, {
      externalLeadId: input.externalLeadId,
      ...input.lead,
      synthetic: true,
      issueId: issue.id,
      interactionId: interaction.id,
      ...lifecycle,
      sourcePayloadSha256: digest,
    });
    if (!existing && stored.created) {
      await logMutation(ctx, companyId, ENTITY_TYPES.qualificationTask, input.externalLeadId, "Created a synthetic lead qualification task", {
        issueId: issue.id,
        interactionId: interaction.id,
      });
    }
    return {
      created: !existing,
      issueId: issue.id,
      interactionId: interaction.id,
      ...lifecycle,
      synthetic: true,
    };
  });
}

async function runMutation(
  ctx: PluginContext,
  companyId: string,
  operationValue: unknown,
  rawInput: unknown,
): Promise<unknown> {
  if (!isRecord(rawInput)) throw new Error("Mutation input must be an object");
  const input = requireMatchingCompany({ ...rawInput, companyId: rawInput.companyId ?? companyId }, companyId);
  const operation = stringField(operationValue, 80);
  if (!operation) throw new PluginRequestError(400, "Mutation operation is required");

  if (operation === "create-lead") {
    const result = await createLeadFromApi(ctx, companyId, input);
    if (result.created) {
      await logMutation(ctx, companyId, ENTITY_TYPES.request, result.request.id, "Created an ArchLead lead and CRM request");
    }
    return result;
  }
  if (operation === "create-request") {
    const result = await createRequest(ctx, companyId, input);
    if (result.created) await logMutation(ctx, companyId, ENTITY_TYPES.request, result.record.id, "Created an ArchLead CRM request");
    return result;
  }
  if (operation === "create-client") {
    const result = await createClient(ctx, companyId, input);
    if (result.created) await logMutation(ctx, companyId, ENTITY_TYPES.client, result.record.id, "Created an ArchLead client record");
    return result;
  }
  if (operation === "create-payment-order") {
    const result = await createPaymentOrder(ctx, companyId, input);
    if (result.created) {
      await logMutation(ctx, companyId, "archlead-payment-order", String(result.order.externalId), "Created a pending provider payment order");
    }
    return result;
  }
  if (operation === "create-sandbox-qualification") {
    return createSandboxQualificationTask(ctx, companyId, input);
  }
  if (operation === "update-record") {
    const record = await updateRecord(ctx, companyId, input.entityType, input.externalId, input.patch);
    await logMutation(ctx, companyId, record.entityType, record.id, "Updated an ArchLead Operations record", {
      externalId: record.externalId,
    });
    return record;
  }
  if (operation === "convert-request") {
    const result = await convertRequestToClient(ctx, companyId, input.externalId);
    if (result.created || !result.linked) {
      await logMutation(ctx, companyId, ENTITY_TYPES.client, result.client.id, "Converted a won CRM request to a pending client", {
        requestExternalId: result.request.externalId,
      });
    }
    return result;
  }
  throw new PluginRequestError(400, "Unsupported ArchLead Operations mutation");
}

async function listOverview(ctx: PluginContext, companyId: string) {
  const [leads, requests, clients, tickets, qualificationRecords, paymentReceipts] = await Promise.all([
    ctx.entities.list({ entityType: ENTITY_TYPES.lead, scopeKind: "company", scopeId: companyId, limit: MAX_RECORDS }),
    ctx.entities.list({ entityType: ENTITY_TYPES.request, scopeKind: "company", scopeId: companyId, limit: MAX_RECORDS }),
    ctx.entities.list({ entityType: ENTITY_TYPES.client, scopeKind: "company", scopeId: companyId, limit: MAX_RECORDS }),
    ctx.entities.list({ entityType: ENTITY_TYPES.supportTicket, scopeKind: "company", scopeId: companyId, limit: MAX_RECORDS }),
    ctx.entities.list({ entityType: ENTITY_TYPES.qualificationTask, scopeKind: "company", scopeId: companyId, limit: 50 }),
    ctx.db.query<PaymentReceipt>(
      `SELECT event_id, provider, provider_resource_id AS resource_id, payment_status, received_at
       FROM ${tableName(ctx.db.namespace)}
       WHERE company_id = $1
       ORDER BY received_at DESC
       LIMIT 20`,
      [companyId],
    ),
  ]);
  const qualificationTasks = await Promise.all(qualificationRecords.map(async (record) => ({
    ...record,
    ...await qualificationTaskStatus(ctx, companyId, record),
  })));
  const pipelineValue = requests.reduce((sum, record) => {
    const value = typeof record.data.value === "number" && Number.isFinite(record.data.value)
      ? record.data.value
      : 0;
    return sum + value;
  }, 0);
  const attribution: Record<string, number> = {};
  for (const request of requests) {
    const source = stringField(request.data.lastTouch ?? request.data.last_touch, 200) ?? "Unknown";
    attribution[source] = (attribution[source] ?? 0) + 1;
  }
  return {
    pluginId: PLUGIN_ID,
    leads,
    requests,
    clients,
    tickets,
    qualificationTasks,
    pipelineValue,
    attribution,
    paymentReceipts,
    manualOnlyJobs: OPERATIONS_JOBS.map(({ jobKey, displayName }) => ({ jobKey, displayName })),
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    activeContext = ctx;
    for (const { jobKey } of OPERATIONS_JOBS) {
      ctx.jobs.register(jobKey, async () => {
        throw new Error(`${JOB_BLOCKED_MESSAGE} Job: ${jobKey}`);
      });
    }

    ctx.data.register("overview", async (params) => {
      const companyId = requireCompanyScope(params.companyId);
      return listOverview(ctx, companyId);
    });

    ctx.actions.register("admin-mutation", async (params, actionContext) => {
      const companyId = requireActionCompany(params, actionContext);
      return runMutation(ctx, companyId, params.operation, params);
    });

    ctx.actions.register("create-follow-up-issue", async (params, actionContext) => {
      const companyId = requireActionCompany(params, actionContext);
      return createFollowUpIssue(ctx, companyId, params.entityType, params.externalId);
    });
  },

  async onApiRequest(input: PluginApiRequestInput) {
    const ctx = activeContext;
    if (!ctx) throw new Error("ArchLead Operations worker is not initialized");
    let companyId: string;
    try {
      companyId = requireCompanyScope(input.companyId);
    } catch (error) {
      return { status: 400, body: { error: error instanceof Error ? error.message : "Invalid company scope" } };
    }

    if (input.routeKey === "list-records") {
      const entityType = input.query.entityType === undefined ? null : scopedEntityType(input.query.entityType);
      if (input.query.entityType !== undefined && !entityType) {
        return { status: 400, body: { error: "Unsupported entityType" } };
      }
      const limit = parseLimit(input.query.limit);
      if (limit === null) return { status: 400, body: { error: "limit must be a positive integer" } };
      const records = entityType
        ? await ctx.entities.list({ entityType, scopeKind: "company", scopeId: companyId, limit })
        : (await Promise.all(Object.values(ENTITY_TYPES).map((type) =>
          ctx.entities.list({ entityType: type, scopeKind: "company", scopeId: companyId, limit }),
        ))).flat();
      return { status: 200, body: { records } };
    }

    if (input.routeKey === "get-qualification-task") {
      const externalLeadId = stringField(input.params.externalLeadId, 200);
      if (!externalLeadId) return { status: 400, body: { error: "externalLeadId is required" } };
      const record = await findEntity(ctx, companyId, ENTITY_TYPES.qualificationTask, externalLeadId);
      if (!record) return { status: 404, body: { error: "Sandbox qualification task not found" } };
      return { status: 200, body: await qualificationTaskStatus(ctx, companyId, record) };
    }

    const body = isRecord(input.body) ? input.body : null;
    if (!body) return { status: 400, body: { error: "Request body must be an object" } };
    if (body.companyId !== companyId) {
      return { status: 403, body: { error: "Request company does not match the authorized company" } };
    }

    try {
      if (input.routeKey === "create-lead") {
        const result = await runMutation(ctx, companyId, "create-lead", body);
        return { status: (result as { created: boolean }).created ? 201 : 200, body: result };
      }
      if (input.routeKey === "create-request") {
        const result = await runMutation(ctx, companyId, "create-request", body);
        return { status: (result as { created: boolean }).created ? 201 : 200, body: result };
      }
      if (input.routeKey === "create-client") {
        const result = await runMutation(ctx, companyId, "create-client", body);
        return { status: (result as { created: boolean }).created ? 201 : 200, body: result };
      }
      if (input.routeKey === "create-payment-order") {
        const result = await runMutation(ctx, companyId, "create-payment-order", body);
        return { status: (result as { created: boolean }).created ? 201 : 200, body: result };
      }
      if (input.routeKey === "create-qualification-task") {
        const result = await createSandboxQualificationTask(ctx, companyId, body);
        const { created, ...response } = result;
        return { status: created ? 201 : 200, body: response };
      }
      if (input.routeKey === "update-record") {
        const result = await runMutation(ctx, companyId, "update-record", {
          ...body,
          entityType: input.params.entityType,
          externalId: input.params.externalId,
        });
        return { status: 200, body: result };
      }
      if (input.routeKey === "convert-request") {
        const result = await runMutation(ctx, companyId, "convert-request", {
          ...body,
          externalId: input.params.externalId,
        });
        return { status: 200, body: result };
      }
      return { status: 404, body: { error: "Unknown ArchLead Operations route" } };
    } catch (error) {
      if (error instanceof PluginRequestError) {
        return { status: error.status, body: { error: error.message } };
      }
      throw error;
    }
  },

  async onWebhook(input) {
    const ctx = activeContext;
    if (!ctx) throw new Error("ArchLead Operations worker is not initialized");
    if (input.endpointKey === "intake") {
      await acceptIntakeEvent(ctx, input);
      return;
    }
    if (input.endpointKey === "cashfree-events") {
      await acceptCashfreeStatusEvent(ctx, input);
      return;
    }
    if (input.endpointKey === "paddle-events") {
      await acceptPaddleStatusEvent(ctx, input);
      return;
    }
    throw new Error(`Unsupported ArchLead Operations webhook endpoint: ${input.endpointKey}`);
  },
});

runWorker(plugin, import.meta.url);
