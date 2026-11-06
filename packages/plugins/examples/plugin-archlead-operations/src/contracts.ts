import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { EnvSecretRefBinding } from "@paperclipai/plugin-sdk";

export const ENTITY_TYPES = {
  lead: "archlead-lead",
  request: "archlead-request",
  client: "archlead-client",
  supportTicket: "archlead-support-ticket",
  qualificationTask: "archlead-qualification-task",
} as const;

export type ArchLeadEntityType = typeof ENTITY_TYPES[keyof typeof ENTITY_TYPES];

export interface LeadRecord {
  name: string;
  email: string;
  business: string;
  phone: string | null;
  message: string | null;
  source: string;
  idealBuyer: string | null;
  regions: string | null;
  volume: string | null;
  referrer: string | null;
  attribution: Record<string, string>;
}

export interface SupportTicketRecord {
  name: string;
  email: string;
  phone: string | null;
  business: string | null;
  orderId: string | null;
  category: string;
  subject: string;
  message: string;
  bounceLogUrl: string | null;
  source: string;
}

export interface SandboxQualificationInput {
  externalLeadId: string;
  lead: LeadRecord;
}

export interface IntakeEvent {
  companyId: string;
  eventId: string;
  eventType: "lead.created" | "support_ticket.created";
  lead?: LeadRecord;
  ticket?: SupportTicketRecord;
}

export type PaymentProvider = "cashfree" | "paddle";
export type PaymentOrderStatus = "pending" | "paid" | "failed" | "canceled" | "past_due" | "refunded";

export interface CreatePaymentOrderInput {
  externalId: string;
  provider: PaymentProvider;
  amount: number;
  currency: string;
  planId: string;
}

export interface VerifiedPaymentStatusEvent {
  companyId: string;
  paymentOrderId: string;
  eventId: string;
  providerResourceId: string;
  providerOrderId: string | null;
  status: PaymentOrderStatus;
  occurredAt: string;
}

export interface PaymentReceipt {
  event_id: string;
  provider: string;
  resource_id: string;
  payment_status: string;
  received_at: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ATTRIBUTION_KEYS = ["source", "medium", "campaign", "content", "term"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

export function optionalStringField(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  return stringField(value, maxLength) ?? undefined;
}

export function isEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}

export function isCompanyId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isSecretRef(value: unknown): value is EnvSecretRefBinding {
  return isRecord(value)
    && value.type === "secret_ref"
    && typeof value.secretId === "string"
    && value.secretId.length > 0;
}

export function parseLead(value: unknown): LeadRecord | null {
  if (!isRecord(value)) return null;
  const name = stringField(value.name, 200);
  const email = stringField(value.email, 320)?.toLowerCase() ?? null;
  if (!name || !email || !isEmail(email)) return null;

  const business = optionalStringField(value.business ?? value.company, 240);
  const phone = optionalStringField(value.phone, 80);
  const message = optionalStringField(value.message, 12_000);
  const source = optionalStringField(value.source, 200);
  const idealBuyer = optionalStringField(value.idealBuyer ?? value.ideal_buyer, 1_000);
  const regions = optionalStringField(value.regions, 1_000);
  const volume = optionalStringField(value.volume, 500);
  const referrer = optionalStringField(value.referrer, 2_000);
  if ([business, phone, message, source, idealBuyer, regions, volume, referrer].includes(undefined)) return null;
  const attribution = parseAttribution(value.attribution ?? value);
  if (!attribution) return null;

  return {
    name,
    email,
    business: business ?? "",
    phone: phone ?? null,
    message: message ?? null,
    source: source ?? "website",
    idealBuyer: idealBuyer ?? null,
    regions: regions ?? null,
    volume: volume ?? null,
    referrer: referrer ?? null,
    attribution,
  };
}

export function parseSupportTicket(value: unknown): SupportTicketRecord | null {
  if (!isRecord(value)) return null;
  const name = stringField(value.name, 200);
  const email = stringField(value.email ?? value.requesterEmail, 320)?.toLowerCase() ?? null;
  const subject = stringField(value.subject, 240);
  const message = stringField(value.message, 12_000);
  if (!name || !email || !isEmail(email) || !subject || !message) return null;

  const phone = optionalStringField(value.phone, 80);
  const business = optionalStringField(value.business ?? value.company, 240);
  const orderId = optionalStringField(value.orderId ?? value.order_id, 200);
  const category = optionalStringField(value.category, 100);
  const bounceLogUrl = optionalStringField(value.bounceLogUrl ?? value.bounce_log_url, 2_000);
  const source = optionalStringField(value.source, 200);
  if ([phone, business, orderId, category, bounceLogUrl, source].includes(undefined)) return null;

  return {
    name,
    email,
    phone: phone ?? null,
    business: business ?? null,
    orderId: orderId ?? null,
    category: category ?? "general",
    subject,
    message,
    bounceLogUrl: bounceLogUrl ?? null,
    source: source ?? "public_support",
  };
}

export function parseIntakeEvent(value: unknown): IntakeEvent | null {
  if (!isRecord(value) || !isCompanyId(value.companyId)) return null;
  const eventId = stringField(value.eventId, 200);
  if (!eventId) return null;

  if (value.eventType === "lead.created") {
    const lead = parseLead(value.lead);
    return lead ? { companyId: value.companyId, eventId, eventType: value.eventType, lead } : null;
  }
  if (value.eventType === "support_ticket.created") {
    const ticket = parseSupportTicket(value.ticket);
    return ticket ? { companyId: value.companyId, eventId, eventType: value.eventType, ticket } : null;
  }
  return null;
}

export function parseCreatePaymentOrderInput(value: unknown): CreatePaymentOrderInput | null {
  if (!isRecord(value)) return null;
  const externalId = stringField(value.externalId, 200);
  const provider = value.provider === "cashfree" || value.provider === "paddle" ? value.provider : null;
  const amount = typeof value.amount === "number" || (typeof value.amount === "string" && value.amount.trim() !== "")
    ? Number(value.amount)
    : Number.NaN;
  const currency = stringField(value.currency, 3)?.toUpperCase() ?? null;
  const planId = stringField(value.planId, 100);
  if (!externalId || !provider || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000
    || !currency || !/^[A-Z]{3}$/.test(currency) || !planId) {
    return null;
  }
  const cents = amount * 100;
  if (Math.abs(cents - Math.round(cents)) > Number.EPSILON * Math.max(1, Math.abs(cents)) * 2) return null;
  return { externalId, provider, amount, currency, planId };
}

export function parseSandboxQualificationInput(value: unknown): SandboxQualificationInput | null {
  if (!isRecord(value) || value.sandbox !== true) return null;
  const externalLeadId = stringField(value.externalLeadId, 200);
  const lead = parseLead(value.lead);
  if (
    !externalLeadId
    || !/^sandbox:[A-Za-z0-9][A-Za-z0-9._:-]{0,180}$/.test(externalLeadId)
    || !lead
    || !lead.email.endsWith("@example.test")
  ) {
    return null;
  }
  return {
    externalLeadId,
    lead: { ...lead, source: "sandbox" },
  };
}

export function buildPaymentOrderMetadata(
  provider: PaymentProvider,
  companyId: string,
  paymentOrderId: string,
): Record<string, unknown> {
  if (!isCompanyId(companyId) || !stringField(paymentOrderId, 200)) {
    throw new Error("Payment-order metadata requires a valid company and order ID");
  }
  const association = {
    paperclip_company_id: companyId,
    paperclip_payment_order_id: paymentOrderId,
  };
  return provider === "cashfree"
    ? { order_tags: association }
    : { custom_data: association };
}

function paymentOrderAssociation(value: unknown): { companyId: string; paymentOrderId: string } | null {
  if (!isRecord(value)) return null;
  const companyId = value.paperclip_company_id;
  const paymentOrderId = stringField(value.paperclip_payment_order_id, 200);
  if (!isCompanyId(companyId) || !paymentOrderId) return null;
  return { companyId, paymentOrderId };
}

function paymentStatus(value: unknown): PaymentOrderStatus | null {
  if (typeof value !== "string") return null;
  switch (value.toLowerCase()) {
    case "success":
    case "paid":
    case "completed":
      return "paid";
    case "failed":
    case "user_dropped":
      return "failed";
    case "pending":
      return "pending";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "past_due":
      return "past_due";
    case "refunded":
      return "refunded";
    default:
      return null;
  }
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parseCashfreeStatusEvent(value: unknown): VerifiedPaymentStatusEvent | null {
  if (!isRecord(value) || !isRecord(value.data) || !isRecord(value.data.order) || !isRecord(value.data.payment)) {
    return null;
  }
  const order = value.data.order;
  const payment = value.data.payment;
  const association = paymentOrderAssociation(order.order_tags);
  const eventType = stringField(value.type, 100);
  const providerOrderId = stringField(order.order_id, 200);
  const providerResourceId = stringField(payment.cf_payment_id, 200);
  const occurredAt = isoDate(value.event_time);
  const status = paymentStatus(payment.payment_status);
  const eventStatuses: Record<string, PaymentOrderStatus> = {
    PAYMENT_SUCCESS_WEBHOOK: "paid",
    PAYMENT_FAILED_WEBHOOK: "failed",
    PAYMENT_USER_DROPPED_WEBHOOK: "failed",
  };
  if (!association || !eventType || eventStatuses[eventType] !== status
    || !providerOrderId || !providerResourceId || !occurredAt || !status) {
    return null;
  }
  return {
    ...association,
    eventId: `${eventType}:${providerResourceId}`,
    providerResourceId,
    providerOrderId,
    status,
    occurredAt,
  };
}

export function parsePaddleStatusEvent(value: unknown): VerifiedPaymentStatusEvent | null {
  if (!isRecord(value) || typeof value.event_type !== "string" || !value.event_type.startsWith("transaction.")
    || !isRecord(value.data)) {
    return null;
  }
  const data = value.data;
  const association = paymentOrderAssociation(data.custom_data);
  const eventId = stringField(value.event_id, 300);
  const providerResourceId = stringField(data.id, 200);
  const occurredAt = isoDate(value.occurred_at);
  const status = paymentStatus(data.status);
  if (!association || !eventId || !providerResourceId || !occurredAt || !status) return null;
  return {
    ...association,
    eventId,
    providerResourceId,
    providerOrderId: null,
    status,
    occurredAt,
  };
}

export function verifyWebhookSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!timestampHeader || !/^\d{10}$/.test(timestampHeader)) return false;
  const timestampSeconds = Number(timestampHeader);
  if (Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) > 300) return false;
  if (!signatureHeader || !/^sha256=[0-9a-f]{64}$/i.test(signatureHeader)) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestampHeader}.${rawBody}`, "utf8")
    .digest();
  const received = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function verifyCashfreeSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!timestampHeader || !/^\d{13}$/.test(timestampHeader)
    || !signatureHeader || !/^[A-Za-z0-9+/]{43}=$/.test(signatureHeader) || !secret) return false;
  let received: Buffer;
  try {
    received = Buffer.from(signatureHeader, "base64");
  } catch {
    return false;
  }
  if (received.length !== 32) return false;
  const expected = createHmac("sha256", secret).update(`${timestampHeader}${rawBody}`, "utf8").digest();
  return timingSafeEqual(received, expected);
}

export function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split(";").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("ts="))?.slice(3);
  if (!timestamp || !/^\d{10}$/.test(timestamp)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > 5) return false;
  const signatures = parts
    .filter((part) => part.startsWith("h1="))
    .map((part) => part.slice(3))
    .filter((signature) => /^[0-9a-f]{64}$/i.test(signature));
  if (signatures.length === 0) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp}:${rawBody}`, "utf8").digest();
  return signatures.some((signature) => {
    const received = Buffer.from(signature, "hex");
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
}

export function payloadSha256(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseAttribution(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return null;
  const attribution: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    if (value[key] === undefined || value[key] === null || value[key] === "") continue;
    const item = stringField(value[key], 200);
    if (!item) return null;
    if (item) attribution[key] = item;
  }
  return attribution;
}
