import type {
  PluginContext,
  PluginEntityRecord,
  PluginPerformActionContext,
  PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import {
  canonicalJson,
  ENTITY_TYPES,
  isCompanyId,
  isEmail,
  isRecord,
  optionalStringField,
  parseIntakeEvent,
  parseLead,
  payloadSha256,
  PluginRequestError,
  stringField,
  verifyWebhookSignature,
  type ArchLeadEntityType,
  type LeadRecord,
  type PaymentReceipt,
  type SupportTicketRecord,
} from "./contracts.js";
import { OPERATIONS_JOBS, PLUGIN_ID } from "./manifest.js";
import { headerValue, parseJson, tableName, verifyCompanyWebhook } from "./payments.js";
import { qualificationTaskStatus } from "./qualification.js";

export const MAX_RECORDS = 200;
export const REQUEST_STATUSES = ["open", "qualified", "proposal", "closed_won", "closed_lost"] as const;
export const CLIENT_STATUSES = ["pending", "active", "paused"] as const;
export const TICKET_STATUSES = ["open", "needs_human", "in_progress", "waiting_on_customer", "resolved"] as const;
export const FOLLOW_UP_ORIGIN = `plugin:${PLUGIN_ID}:follow-up`;

export function scopedEntityType(value: unknown): ArchLeadEntityType | null {
  return typeof value === "string"
    && Object.values(ENTITY_TYPES).includes(value as ArchLeadEntityType)
    ? value as ArchLeadEntityType
    : null;
}

export async function findEntity(
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
  const record = records[0];
  if (!record) return null;
  // Defense-in-depth tenant boundary check
  if (record.scopeKind === "company" && record.scopeId && record.scopeId !== companyId) {
    return null;
  }
  return record;
}

export async function upsertEntity(
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

export async function logMutation(
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

const entityLocks = new Map<string, Promise<void>>();

export async function withEntityLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = entityLocks.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  entityLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (entityLocks.get(key) === tail) {
      entityLocks.delete(key);
    }
  }
}

export async function upsertIdempotentEntity(
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
  const lockKey = `${input.companyId}:${input.entityType}:${input.externalId}`;
  return withEntityLock(lockKey, async () => {
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
    const record = await upsertEntity(
      ctx,
      input.companyId,
      input.entityType,
      input.externalId,
      input.title,
      input.status,
      input.data,
    );
    return {
      record,
      created: true,
    };
  });
}

export function requestMessage(lead: LeadRecord): string {
  if (lead.message) return lead.message;
  return [
    lead.idealBuyer ? `Ideal buyer: ${lead.idealBuyer}` : null,
    lead.regions ? `Regions: ${lead.regions}` : null,
    lead.volume ? `Volume: ${lead.volume}` : null,
  ].filter(Boolean).join(". ");
}

export async function storeLead(
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

export function supportPriority(ticket: SupportTicketRecord): "normal" | "high" {
  const urgentTerms = ["urgent", "asap", "sla", "bounce", "blocked", "failed", "dead phone", "refund", "escalate", "delivery failed"];
  const combined = `${ticket.subject} ${ticket.message} ${ticket.category}`.toLowerCase();
  return ticket.category === "sla_replacement" || urgentTerms.some((term) => combined.includes(term))
    ? "high"
    : "normal";
}

export async function storeSupportTicket(
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
  const client = clientRecords.find((record) => record.data.email === ticket.email && record.scopeId === companyId);
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

export async function acceptIntakeEvent(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  const untrusted = parseJson(input.rawBody);
  if (!isCompanyId(untrusted.companyId)) throw new Error("Webhook companyId must be a UUID");
  await verifyCompanyWebhook(
    ctx,
    input,
    untrusted.companyId,
    "intakeWebhookSecretRef",
    verifyWebhookSignature,
    "x-archlead-timestamp",
    "x-archlead-signature",
  );
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

export function createRequestData(body: Record<string, unknown>): {
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

export function createClientData(body: Record<string, unknown>): {
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

export function updatedRecord(
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

export async function createLeadFromApi(
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

export async function createRequest(
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

export async function createClient(
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

export async function updateRecord(
  ctx: PluginContext,
  companyId: string,
  entityTypeValue: unknown,
  externalIdValue: unknown,
  patch: unknown,
): Promise<PluginEntityRecord> {
  const entityType = scopedEntityType(entityTypeValue);
  const externalId = stringField(externalIdValue, 200);
  if (!entityType || !externalId) throw new PluginRequestError(400, "Unsupported record type or external ID");
  const lockKey = `${companyId}:${entityType}:${externalId}`;
  return withEntityLock(lockKey, async () => {
    const existing = await findEntity(ctx, companyId, entityType, externalId);
    if (!existing) throw new PluginRequestError(404, "ArchLead record not found");
    const updated = updatedRecord(entityType, existing, patch);
    if (!updated) throw new PluginRequestError(422, "Record update contains unsupported or invalid fields");
    return upsertEntity(ctx, companyId, entityType, externalId, updated.title, updated.status, updated.data);
  });
}

export async function convertRequestToClient(
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
  const updatedRequest = isLinked
    ? request
    : await withEntityLock(`${companyId}:${ENTITY_TYPES.request}:${requestExternalId}`, async () => {
        const latestRequest = await findEntity(ctx, companyId, ENTITY_TYPES.request, requestExternalId);
        return upsertEntity(
          ctx,
          companyId,
          ENTITY_TYPES.request,
          requestExternalId,
          latestRequest?.title ?? business,
          latestRequest?.status ?? "closed_won",
          {
            ...(latestRequest?.data ?? request.data),
            onboardingStatus: "manual_setup_required",
            clientExternalId,
          },
        );
      });
  return { client, request: updatedRequest, created: !existingClient, linked: isLinked };
}

export async function createFollowUpIssue(
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

  await withEntityLock(`${companyId}:${entityType}:${externalId}`, async () => {
    const latest = await findEntity(ctx, companyId, entityType, externalId);
    await upsertEntity(
      ctx,
      companyId,
      entityType,
      externalId,
      latest?.title ?? record.title ?? "ArchLead record",
      latest?.status ?? record.status ?? "open",
      {
        ...(latest?.data ?? record.data),
        paperclipIssueId: issue.id,
      },
    );
  });
  await logMutation(ctx, companyId, "issue", issue.id, "Created or linked an ArchLead follow-up task", {
    recordType: entityType,
    recordExternalId: externalId,
  });
  return { issueId: issue.id, title: issue.title, status: issue.status };
}

export async function listOverview(
  ctx: PluginContext,
  companyId: string,
  options?: { limit?: number; offset?: number },
) {
  const rawLimit = options?.limit;
  const limit =
    typeof rawLimit === "number" && Number.isSafeInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_RECORDS)
      : MAX_RECORDS;
  const rawOffset = options?.offset;
  const offset =
    typeof rawOffset === "number" && Number.isSafeInteger(rawOffset) && rawOffset > 0
      ? rawOffset
      : 0;
  const [leads, requests, clients, tickets, qualificationRecords, paymentReceipts] = await Promise.all([
    ctx.entities.list({ entityType: ENTITY_TYPES.lead, scopeKind: "company", scopeId: companyId, limit, offset }),
    ctx.entities.list({ entityType: ENTITY_TYPES.request, scopeKind: "company", scopeId: companyId, limit, offset }),
    ctx.entities.list({ entityType: ENTITY_TYPES.client, scopeKind: "company", scopeId: companyId, limit, offset }),
    ctx.entities.list({ entityType: ENTITY_TYPES.supportTicket, scopeKind: "company", scopeId: companyId, limit, offset }),
    ctx.entities.list({ entityType: ENTITY_TYPES.qualificationTask, scopeKind: "company", scopeId: companyId, limit: Math.min(limit, 50), offset }),
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

  const hasMoreLeads = leads.length >= limit;
  const hasMoreRequests = requests.length >= limit;
  const hasMoreClients = clients.length >= limit;
  const hasMoreTickets = tickets.length >= limit;
  const hasMoreQualifications = qualificationRecords.length >= Math.min(limit, 50);

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
    totals: {
      leads: leads.length,
      requests: requests.length,
      clients: clients.length,
      tickets: tickets.length,
      qualificationTasks: qualificationTasks.length,
      isLimited: hasMoreLeads || hasMoreRequests || hasMoreClients || hasMoreTickets || hasMoreQualifications,
    },
    pagination: {
      limit,
      offset,
      hasMore: {
        leads: hasMoreLeads,
        requests: hasMoreRequests,
        clients: hasMoreClients,
        tickets: hasMoreTickets,
        qualificationTasks: hasMoreQualifications,
      },
    },
    isLimited: hasMoreLeads || hasMoreRequests || hasMoreClients || hasMoreTickets || hasMoreQualifications,
  };
}
