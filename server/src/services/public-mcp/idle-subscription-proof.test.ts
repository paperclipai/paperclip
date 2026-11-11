import { describe, expect, it } from "vitest";
import { projectIdleMcpSubscriptionProof, type IdleMcpSubscriptionProofInput } from "./idle-subscription-proof.js";
import { createMcpWakeAdmission } from "./wake-admission.js";
import { mcpEventSubscriptions } from "@paperclipai/db";
const context = { stackId: "stack", ownerId: "00000000-0000-4000-8000-000000000001", capabilityGeneration: "a".repeat(64), challenge: "c".repeat(64) };
const row: typeof mcpEventSubscriptions.$inferSelect = { id: "sub", companyId: "company", grantId: "grant", name: "paperclip.task.status_changed", taskId: "task", bindingId: null,
  arguments: { companyId: "company", taskId: "task" }, deliveryMaterial: {}, verifiedAt: new Date(0), startsAt: new Date(0), expiresAt: new Date(10_000), stoppedAt: null, scannedAt: new Date(1000) };
const input: IdleMcpSubscriptionProofInput = { now: 2000,
  ingress: { admission: createMcpWakeAdmission({ ...context, tokens: [] }), generation: "d".repeat(64), grantIds: ["grant"], dotBindingIds: ["binding"] },
  personal: { revision: "personal:1", reconciled: true }, dot: { revision: "dot:1", reconciled: true }, inspectDestination: async () => true };
describe("configured-idle MCP subscription proof", () => {
  it("retains enabled known subscription state with explicit ingress and reconciled producer", async () => {
    const proof = await projectIdleMcpSubscriptionProof([{ subscription: row, taskMatches: true }], input);
    expect(proof.blocked).toBe(false);
    expect(proof.subscriptionIds).toEqual(["sub"]);
    expect(row.stoppedAt).toBeNull();
    expect((await projectIdleMcpSubscriptionProof([{ subscription: { ...row, expiresAt: new Date(1500) }, taskMatches: true }], input)).blocked).toBe(false);
    expect((await projectIdleMcpSubscriptionProof([{ subscription: row, taskMatches: true }], { ...input, personal: { revision: "personal:2", reconciled: true } })).generation).not.toBe(proof.generation);
  });
  it("keeps unknown/foreign/malformed/uncertain subscriptions blocking", async () => {
    for (const change of [{ name: "unknown.event" }, { grantId: "foreign" }, { taskId: null }, { arguments: { companyId: "foreign", taskId: "task" } },
      { arguments: { companyId: "company", taskId: "task", injected: true } }, { arguments: { companyId: "company", taskId: "task", statuses: ["unknown"] } },
      { expiresAt: new Date(NaN) }, { verifiedAt: new Date(3000) }, { scannedAt: new Date(-1) }]) {
      expect((await projectIdleMcpSubscriptionProof([{ subscription: { ...row, ...change }, taskMatches: true }], input)).blocked).toBe(true);
    }
    expect((await projectIdleMcpSubscriptionProof([{ subscription: row, taskMatches: false }], input)).blocked).toBe(true);
    expect((await projectIdleMcpSubscriptionProof([{ subscription: row, taskMatches: true }], { ...input, inspectDestination: async () => false })).blocked).toBe(true);
    expect((await projectIdleMcpSubscriptionProof([{ subscription: row, taskMatches: true }], { ...input, personal: { revision: "dirty", reconciled: false } })).blocked).toBe(true);
  });
  it("requires the exact certified Dot binding and matching Dot reconciliation", async () => {
    const dot = { ...row, name: "paperclip.dot.mailbox_updated", taskId: null, bindingId: "binding", arguments: { companyId: "company", bindingId: "binding" } };
    expect((await projectIdleMcpSubscriptionProof([{ subscription: dot, taskMatches: false }], input)).blocked).toBe(false);
    expect((await projectIdleMcpSubscriptionProof([{ subscription: { ...dot, bindingId: "other" }, taskMatches: false }], input)).blocked).toBe(true);
    expect((await projectIdleMcpSubscriptionProof([], { ...input, personal: { revision: "missing", reconciled: false } })).blocked).toBe(false);
  });
  it("checks the shared inspection deadline between local decryptions", async () => {
    let expired = false, decryptions = 0;
    await expect(projectIdleMcpSubscriptionProof([{ subscription: row, taskMatches: true }, { subscription: { ...row, id: "next" }, taskMatches: true }], {
      ...input, budget: { beforeRead: async () => {}, check: () => { if (expired) throw new Error("inspection deadline exhausted"); } },
      inspectDestination: async () => { decryptions++; expired = true; return true; },
    })).rejects.toThrow("inspection deadline exhausted");
    expect(decryptions).toBe(1);
  });
});
