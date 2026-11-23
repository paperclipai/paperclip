import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { acceptSlackFormAckReceipt } from "./form-ack-work.js";
import { parseSlackFormFinalizedReceipt } from "./ack-receipt.js";

const original = { stack: process.env.PAPERCLIP_CLOUD_STACK_ID, jwks: process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS };
afterEach(() => {
  if (original.stack === undefined) delete process.env.PAPERCLIP_CLOUD_STACK_ID; else process.env.PAPERCLIP_CLOUD_STACK_ID = original.stack;
  if (original.jwks === undefined) delete process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS; else process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS = original.jwks;
});
it("rejects a genuinely signed foreign-company receipt and its action ID before any SQL", async () => {
  const keys = generateKeyPairSync("ed25519"), kid = "ack-company-test";
  process.env.PAPERCLIP_CLOUD_STACK_ID = "instance";
  process.env.PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS = JSON.stringify({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid, alg: "EdDSA", use: "sig" }] });
  const receipt = parseSlackFormFinalizedReceipt({ version: 1, kind: "slack_form_finalized", environment: "test",
    binding: { version: 1, instanceId: "instance", companyId: "foreign", endpointId: "endpoint", publicId: "p".repeat(43), connectionId: "connection",
      runtimeGeneration: 1, teamId: "T1", appId: "A1", eventBindingId: "slack-event:" + "a".repeat(64), credentialFingerprint: "b".repeat(64) },
    operationId: "c".repeat(64), deliveryId: "slack_form_" + "c".repeat(64), appReceiptId: "11111111-1111-4111-8111-111111111111",
    grantId: "grant", publicationId: "publication", interactionId: "interaction", userId: "U1", viewDigest: null,
    terminalDigest: "d".repeat(64), outcome: "no_effect", finalizedAt: "2026-11-06T00:00:00.000Z" });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = encode({ alg: "EdDSA", typ: "paperclip-connector-ack-receipt+jwt", kid }) + "."
    + encode({ v: 1, iss: "paperclip-cloud", aud: "paperclip-connector-ack-receipt/v1", sub: "instance", receipt });
  const receiptJws = input + "." + sign(null, Buffer.from(input), keys.privateKey).toString("base64url");
  const tx = { select: vi.fn(), update: vi.fn() };
  await expect(acceptSlackFormAckReceipt(tx, { companyId: "current", instanceId: "instance", leaseId: "lease", receiptJws }))
    .rejects.toMatchObject({ code: "form_ack_company_changed" });
  expect(tx.select).not.toHaveBeenCalled();
  expect(tx.update).not.toHaveBeenCalled();
});
