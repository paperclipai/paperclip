import { createHash } from "node:crypto";
import { parseSlackFormBinding, sameSlackFormBinding, type SlackFormBinding } from "./cloud-forms.js";

export type SlackFormFinalizedReceipt = Readonly<{
  version: 1;
  kind: "slack_form_finalized";
  binding: SlackFormBinding;
  environment: "development" | "test" | "staging" | "production";
  operationId: string;
  deliveryId: string;
  appReceiptId: string;
  grantId: string;
  publicationId: string;
  interactionId: string;
  userId: string;
  viewDigest: string | null;
  terminalDigest: string;
  outcome: "submitted" | "closed" | "no_effect";
  finalizedAt: string;
}>;

function invalid(): never { throw new Error("slack_form_ack_receipt_invalid"); }
export function parseSlackFormFinalizedReceipt(value: unknown): SlackFormFinalizedReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 8192) return invalid();
  const field = (key: string): unknown => Reflect.get(value, key);
  const keys = ["version", "kind", "binding", "environment", "operationId", "deliveryId", "appReceiptId", "terminalDigest", "outcome", "finalizedAt", "grantId", "publicationId", "interactionId", "userId", "viewDigest"];
  if (Object.keys(value).sort().join() !== keys.sort().join()) return invalid();
  const binding = parseSlackFormBinding(field("binding"));
  const environment = field("environment");
  const operationId = field("operationId"), deliveryId = field("deliveryId");
  const appReceiptId = field("appReceiptId"), terminalDigest = field("terminalDigest");
  const grantId = field("grantId"), publicationId = field("publicationId"), interactionId = field("interactionId"), userId = field("userId"), viewDigest = field("viewDigest");
  const outcome = field("outcome"), finalizedAt = field("finalizedAt");
  if (field("version") !== 1 || field("kind") !== "slack_form_finalized"
    || environment !== "development" && environment !== "test" && environment !== "staging" && environment !== "production"
    || typeof operationId !== "string" || !/^[a-f0-9]{64}$/.test(operationId)
    || typeof deliveryId !== "string" || deliveryId !== `slack_form_${operationId}` || typeof appReceiptId !== "string" || !/^[a-f0-9-]{36}$/i.test(appReceiptId)
    || typeof grantId !== "string" || !grantId.length || grantId.length > 200
    || typeof publicationId !== "string" || !publicationId.length || publicationId.length > 200
    || typeof interactionId !== "string" || !interactionId.length || interactionId.length > 200
    || typeof userId !== "string" || !userId.length || userId.length > 200
    || viewDigest !== null && (typeof viewDigest !== "string" || !/^[a-f0-9]{64}$/.test(viewDigest))
    || typeof terminalDigest !== "string" || !/^[a-f0-9]{64}$/.test(terminalDigest)
    || outcome !== "submitted" && outcome !== "closed" && outcome !== "no_effect"
    || typeof finalizedAt !== "string" || !Number.isFinite(Date.parse(finalizedAt))) return invalid();
  return Object.freeze({ version: 1, kind: "slack_form_finalized", binding: Object.freeze(binding), environment,
    operationId, deliveryId, appReceiptId, grantId, publicationId, interactionId, userId, viewDigest, terminalDigest, outcome, finalizedAt });
}

export function assertSameSlackFormFinalization(actual: SlackFormFinalizedReceipt, expected: SlackFormFinalizedReceipt): void {
  if (!sameSlackFormBinding(actual.binding, expected.binding)
    || actual.environment !== expected.environment || actual.operationId !== expected.operationId
    || actual.deliveryId !== expected.deliveryId || actual.appReceiptId !== expected.appReceiptId
    || actual.grantId !== expected.grantId || actual.publicationId !== expected.publicationId
    || actual.interactionId !== expected.interactionId || actual.userId !== expected.userId || actual.viewDigest !== expected.viewDigest
    || actual.terminalDigest !== expected.terminalDigest || actual.outcome !== expected.outcome
    || actual.finalizedAt !== expected.finalizedAt) return invalid();
}

export function slackFormFinalizedReceiptDigest(receipt: SlackFormFinalizedReceipt): string {
  const b = receipt.binding;
  return createHash("sha256").update(JSON.stringify(["slack-form-finalized-receipt/v1", b.version, b.instanceId, b.companyId, b.endpointId,
    b.publicId, b.connectionId, b.runtimeGeneration, b.teamId, b.appId, b.eventBindingId, b.credentialFingerprint,
    receipt.environment, receipt.operationId, receipt.deliveryId, receipt.appReceiptId, receipt.grantId, receipt.publicationId,
    receipt.interactionId, receipt.userId, receipt.viewDigest, receipt.terminalDigest, receipt.outcome, receipt.finalizedAt]), "utf8").digest("hex");
}
