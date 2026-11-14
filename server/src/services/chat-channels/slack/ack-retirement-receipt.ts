import { isSlackFormEnrollmentActionId } from "./form-enrollment-identity.js";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { parseSlackFormBinding as parseFormBinding, parseSlackFormPublicEnrollment, type SlackFormBinding as FormBinding } from "./cloud-forms.js";
function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("Invalid retirement receipt shape");
  return Object.fromEntries(Object.entries(value));
}
const formOwnerId = (b: FormBinding) => `slack-form-owner:${createHash("sha256").update(JSON.stringify([b.instanceId, b.companyId, b.endpointId, b.publicId, b.connectionId, b.runtimeGeneration, b.credentialFingerprint])).digest("hex")}`;

export type SlackFormRetirementReceipt = Readonly<{
  version: 1; kind: "slack_form_retired"; binding: FormBinding;
  environment: "development" | "test" | "staging" | "production";
  subject: string; ownerId: string; receiptId: string;
}>;
function identity(binding: FormBinding, environment: string, subject: string) {
  const b = binding;
  return ["slack-form-retirement/v1", b.version, b.instanceId, b.companyId, b.endpointId, b.publicId, b.connectionId,
    b.runtimeGeneration, b.teamId, b.appId, b.eventBindingId, b.credentialFingerprint, environment, subject, formOwnerId(binding)];
}
export function slackFormRetirementReceipt(binding: FormBinding, environment: string, subject: string): SlackFormRetirementReceipt {
  const parsed = parseFormBinding(binding);
  return parseSlackFormRetirementReceipt({ version: 1, kind: "slack_form_retired", binding: parsed, environment, subject,
    ownerId: formOwnerId(parsed), receiptId: createHash("sha256").update(JSON.stringify(identity(parsed, environment, subject))).digest("hex") });
}
export function parseSlackFormRetirementReceipt(value: unknown): SlackFormRetirementReceipt {
  const v = closedRecord(value, ["version", "kind", "binding", "environment", "subject", "ownerId", "receiptId"]);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 8192 || v.version !== 1 || v.kind !== "slack_form_retired"
    || typeof v.subject !== "string" || !v.subject.length || v.subject.length > 200
    || !["development", "test", "staging", "production"].includes(String(v.environment))) throw new Error("Invalid Slack retirement receipt");
  const binding = parseFormBinding(v.binding), environment = v.environment;
  if (environment !== "development" && environment !== "test" && environment !== "staging" && environment !== "production") throw new Error("Invalid Slack retirement environment");
  const receiptId = createHash("sha256").update(JSON.stringify(identity(binding, environment, v.subject))).digest("hex");
  if (v.ownerId !== formOwnerId(binding) || v.receiptId !== receiptId) throw new Error("Slack retirement identity changed");
  return Object.freeze({ version: 1, kind: "slack_form_retired", binding: Object.freeze(binding), environment, subject: v.subject,
    ownerId: formOwnerId(binding), receiptId });
}

export type SlackRetirementHistoryRow = { kind: string; companyId: string; endpointId: string; providerActionId?: string; status: string;
  payload: Record<string, unknown>; result: Record<string, unknown> | null };
export function slackFormRetirementHistoryReceipt(row: SlackRetirementHistoryRow): SlackFormRetirementReceipt | null {
  if (!["slack_form_owner", "slack_form_grant"].includes(row.kind) || row.result?.phase !== "transferred" || row.result?.nextAttemptAt !== null) return null;
  const retired = closedRecord(row.result.retirement, ["version", "binding", "instanceId", "environment", "subject", "receiptDigest", "receipt"]);
  const receipt = parseSlackFormRetirementReceipt(retired.receipt), binding = receipt.binding;
  if (row.companyId !== binding.companyId || row.endpointId !== binding.endpointId || row.payload.subject !== receipt.subject
    || row.payload.environment !== receipt.environment || retired.version !== 1 || retired.instanceId !== binding.instanceId
    || retired.environment !== receipt.environment || retired.subject !== receipt.subject || retired.receiptDigest !== receipt.receiptId
    || !isDeepStrictEqual(parseFormBinding(retired.binding), binding)
    || row.kind === "slack_form_owner" && row.status !== "processed" || row.kind === "slack_form_grant" && row.status !== "cancelled") throw new Error("Slack retirement history authority changed");
  if (row.payload.binding !== undefined) {
    if (!isDeepStrictEqual(parseFormBinding(row.payload.binding), binding)) throw new Error("Slack retirement history binding changed");
  } else {
    const enrollment = parseSlackFormPublicEnrollment(row.payload.enrollment);
    if (enrollment.bindingId !== binding.eventBindingId
      || ["instanceId", "companyId", "endpointId", "publicId", "connectionId", "runtimeGeneration", "teamId", "appId"].some(key => Reflect.get(enrollment, key) !== Reflect.get(binding, key))) throw new Error("Slack retirement enrollment history changed");
  }
  if (row.kind === "slack_form_owner" && !isSlackFormEnrollmentActionId(row.providerActionId, parseSlackFormPublicEnrollment(row.payload.enrollment)))
    throw new Error("Slack retirement history owner changed");
  return receipt;
}
