import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { chatActions } from "@paperclipai/db";
import { parseSlackFormBinding } from "./cloud-forms.js";
import { parseSlackFormRetirementReceipt, slackFormRetirementReceipt, slackFormRetirementHistoryReceipt } from "./ack-retirement-receipt.js";
import { assertSlackFormRetirementWorkAuthority, verifyRetainedSlackFormRetirement } from "./form-retirement-work.js";
import { verifySlackFormFinalizedReceipt, verifySlackFormRetirementReceipt } from "./receipt-authority.js";
import { projectSlackFormRetainedOwner } from "./form-session.js";

const binding = parseSlackFormBinding({ version: 1, instanceId: "instance", companyId: "company", endpointId: "endpoint", publicId: "p".repeat(43), connectionId: "connection",
  runtimeGeneration: 1, teamId: "TTEST", appId: "ATEST", eventBindingId: "slack-event:" + "a".repeat(64), credentialFingerprint: "b".repeat(64) });
const { credentialFingerprint, eventBindingId, ...base } = binding;
const enrollment = { ...base, bindingId: eventBindingId }, identity = { instanceId: "instance", environment: "test" as const };
const receipt = slackFormRetirementReceipt(binding, "test", "original-actor");
function row(): typeof chatActions.$inferSelect {
  return { id: "11111111-1111-4111-8111-111111111111", companyId: "company", endpointId: "endpoint", deliveryId: null,
    conversationId: null, principalId: null, kind: "slack_form_owner", providerActionId: `slack-form-owner:${createHash("sha256").update(JSON.stringify(enrollment)).digest("hex")}`,
    payload: { enrollment, binding, environment: "test", subject: "original-actor" }, status: "issued", result: { phase: "retired_cleanup", nextAttemptAt: null },
    createdAt: new Date(0), updatedAt: new Date(0) };
}
function signed(value: unknown = receipt) {
  const pair = generateKeyPairSync("ed25519"), kid = "retirement-unit";
  const env = { PAPERCLIP_CLOUD_STACK_ID: "instance", PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify({ keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "EdDSA" }] }) };
  const enc = (input: unknown) => Buffer.from(JSON.stringify(input)).toString("base64url");
  const body = enc({ alg: "EdDSA", typ: "paperclip-connector-ack-receipt+jwt", kid }) + "." + enc({ v: 1, iss: "paperclip-cloud", aud: "paperclip-connector-ack-receipt/v1", sub: "instance", receipt: value });
  return { compactJws: body + "." + sign(null, Buffer.from(body), pair.privateKey).toString("base64url"), env };
}
afterEach(() => vi.unstubAllEnvs());
it("verifies a real runtime signature without admitting the other receipt kind", () => {
  const input = signed(); expect(verifySlackFormRetirementReceipt(input)).toEqual(receipt);
  expect(() => verifySlackFormFinalizedReceipt(input)).toThrow();
});
it("rejects foreign instance, unknown signing key and tampered retirement payload", () => {
  const input = signed();
  expect(() => verifySlackFormRetirementReceipt({ ...input, env: { ...input.env, PAPERCLIP_CLOUD_STACK_ID: "foreign" } })).toThrow();
  expect(() => verifySlackFormRetirementReceipt({ ...input, env: { ...input.env, PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: '{"keys":[]}' } })).toThrow();
  const parts = input.compactJws.split("."); parts[1] = Buffer.from("{}").toString("base64url");
  expect(() => verifySlackFormRetirementReceipt({ ...input, compactJws: parts.join(".") })).toThrow();
});
it("fails closed on changed canonical identity, extra keys and oversized original subject", () => {
  expect(() => parseSlackFormRetirementReceipt({ ...receipt, subject: "replacement" })).toThrow();
  expect(() => parseSlackFormRetirementReceipt({ ...receipt, extra: true })).toThrow();
  expect(() => slackFormRetirementReceipt(binding, "test", "x".repeat(201))).toThrow();
});
it("requires exact local company, immutable original subject, fingerprint and owner action", () => {
  const current = row(); expect(() => assertSlackFormRetirementWorkAuthority(current, identity, receipt)).not.toThrow();
  for (const changed of [{ ...current, companyId: "foreign" }, { ...current, payload: { ...current.payload, subject: "replacement" } },
    { ...current, payload: { ...current.payload, binding: { ...binding, credentialFingerprint: "c".repeat(64) } } }, { ...current, providerActionId: "foreign-action" }])
    expect(() => assertSlackFormRetirementWorkAuthority(changed, identity, receipt)).toThrow();
  expect(() => assertSlackFormRetirementWorkAuthority(current, { ...identity, instanceId: "foreign" }, receipt)).toThrow();
});
it("key outage remains retryable and invalid signature is visible attention", () => {
  const input = signed(); vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "instance"); vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", "");
  expect(() => verifyRetainedSlackFormRetirement(input.compactJws)).toThrow(expect.objectContaining({ code: "form_retirement_verifier_unavailable" }));
  vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", input.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS);
  const other = signed(); expect(() => verifyRetainedSlackFormRetirement(other.compactJws)).toThrow(expect.objectContaining({ code: "form_retirement_receipt_invalid" }));
});
it("accepted retirement retains normal polling identity without granting new-use delivery authority", () => {
  const current = row(), input = signed(); current.result = { phase: "retirement_accepted", retirementReceipt: receipt, retirementReceiptJws: input.compactJws, nextAttemptAt: new Date(0).toISOString() };
  expect(projectSlackFormRetainedOwner(current, identity.instanceId, identity.environment)).toEqual({ subject: "github-bot-events", companyId: current.companyId, binding, requiresDelivery: false });
  const missingBinding = { ...current, payload: { enrollment, environment: "test", subject: "original-actor" } };
  expect(projectSlackFormRetainedOwner(missingBinding, identity.instanceId, identity.environment)).not.toBeNull();
  expect(() => projectSlackFormRetainedOwner({ ...current, result: { ...current.result, retirementReceiptJws: "invalid" } }, identity.instanceId, identity.environment)).toThrow();
});
it("only exact committed transfer discharges history and its retained consumer", () => {
  const current = row(); current.status = "processed";
  const retirement = { version: 1, binding, instanceId: identity.instanceId, environment: identity.environment, subject: receipt.subject, receiptDigest: receipt.receiptId, receipt };
  current.result = { phase: "transferred", nextAttemptAt: null, retirement };
  expect(slackFormRetirementHistoryReceipt(current)).toEqual(receipt);
  expect(projectSlackFormRetainedOwner(current, identity.instanceId, identity.environment)).toBeNull();
  expect(() => slackFormRetirementHistoryReceipt({ ...current, companyId: "foreign" })).toThrow();
  expect(() => slackFormRetirementHistoryReceipt({ ...current, result: { ...current.result, retirement: { ...retirement, receiptDigest: "0".repeat(64) } } })).toThrow();
  expect(() => slackFormRetirementHistoryReceipt({ ...current, result: { phase: "transferred", nextAttemptAt: null } })).toThrow();
});
