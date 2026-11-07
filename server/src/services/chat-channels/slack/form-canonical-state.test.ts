import { expect, it } from "vitest";
import { parseSlackFormAckWork } from "./form-ack-work.js";
import { parseSlackFormFinalizedReceipt } from "./ack-receipt.js";
import { parseSlackFormBinding } from "./cloud-forms.js";

const binding = parseSlackFormBinding({ version: 1, instanceId: "instance", companyId: "company", endpointId: "endpoint", publicId: "p".repeat(43), connectionId: "connection",
  runtimeGeneration: 1, teamId: "TTEST", appId: "ATEST", eventBindingId: "slack-event:" + "a".repeat(64), credentialFingerprint: "b".repeat(64) });
const receipt = parseSlackFormFinalizedReceipt({ version: 1, kind: "slack_form_finalized", environment: "test", binding,
  operationId: "c".repeat(64), deliveryId: "slack_form_" + "c".repeat(64), appReceiptId: "11111111-1111-4111-8111-111111111111",
  grantId: "grant", publicationId: "publication", interactionId: "interaction", userId: "UTEST", viewDigest: null,
  terminalDigest: "d".repeat(64), outcome: "no_effect", finalizedAt: "2026-11-06T00:00:00.000Z" });
it("keeps GC debt explicitly distinct from completed ACK history", () => {
  const pending = parseSlackFormAckWork({ version: 1, phase: "gc_pending", leaseId: "exact-lease", deliveryId: receipt.deliveryId, receiptJws: "a.b.c", receipt });
  expect(pending.phase).toBe("gc_pending"); expect(pending.leaseId).toBe("exact-lease"); expect(pending.receipt).toEqual(receipt);
  expect(parseSlackFormAckWork({ ...pending, phase: "transferred" }).phase).toBe("transferred");
});
it("GC cannot be constructed from absent proof or a different delivery", () => {
  const work = { version: 1, phase: "gc_pending", leaseId: "exact-lease", deliveryId: receipt.deliveryId, receiptJws: "a.b.c", receipt };
  expect(() => parseSlackFormAckWork({ ...work, receipt: null })).toThrow();
  expect(() => parseSlackFormAckWork({ ...work, deliveryId: "slack_form_" + "e".repeat(64) })).toThrow();
  expect(() => parseSlackFormAckWork({ ...work, phase: "released_by_absence" })).toThrow();
});
it("ordinary old pending and completed states remain closed and do not acquire new authority", () => {
  expect(parseSlackFormAckWork({ version: 1, phase: "pending", leaseId: "old", deliveryId: receipt.deliveryId, receipt: null, receiptJws: null }).phase).toBe("pending");
  expect(() => parseSlackFormAckWork({ version: 1, phase: "pending", leaseId: "old", deliveryId: receipt.deliveryId, receipt, receiptJws: "a.b.c" })).toThrow();
});
