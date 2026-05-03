import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "../../../packages/plugins/sdk/src/testing.js";

function manifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-approvals",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Test Approvals",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

describe("ctx.approvals SDK contract", () => {
  it("create returns approvalId and pending status", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create"]) });

    const result = await harness.ctx.approvals.create({
      companyId,
      prompt: "Please approve deployment to production.",
    });

    expect(result.approvalId).toBeTruthy();
    expect(result.status).toBe("pending");
  });

  it("get returns the created approval by id", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create", "approvals.read"]) });

    const { approvalId } = await harness.ctx.approvals.create({
      companyId,
      prompt: "Approve cost increase.",
    });

    const approval = await harness.ctx.approvals.get({ approvalId, companyId });

    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(approvalId);
    expect(approval!.prompt).toBe("Approve cost increase.");
    expect(approval!.status).toBe("pending");
  });

  it("get returns null for unknown approvalId", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.read"]) });

    const result = await harness.ctx.approvals.get({
      approvalId: randomUUID(),
      companyId,
    });

    expect(result).toBeNull();
  });

  it("list returns pending approvals filtered by status", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create", "approvals.read"]) });

    await harness.ctx.approvals.create({ companyId, prompt: "Approval A" });
    await harness.ctx.approvals.create({ companyId, prompt: "Approval B" });

    const pending = await harness.ctx.approvals.list({ companyId, status: "pending" });

    expect(pending.length).toBe(2);
    expect(pending.every((a) => a.status === "pending")).toBe(true);
  });

  it("list respects limit and offset", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create", "approvals.read"]) });

    for (let i = 0; i < 5; i++) {
      await harness.ctx.approvals.create({ companyId, prompt: `Approval ${i}` });
    }

    const page = await harness.ctx.approvals.list({ companyId, limit: 2, offset: 1 });
    expect(page.length).toBe(2);
  });

  it("cancel sets status to cancelled and fires onResolved callback", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create", "approvals.read"]) });

    const { approvalId } = await harness.ctx.approvals.create({
      companyId,
      prompt: "Cancel me.",
    });

    const received: Array<{ status: string; decisionNote: string | null }> = [];
    harness.ctx.approvals.onResolved(approvalId, async (event) => {
      received.push({ status: event.status, decisionNote: event.decisionNote });
    });

    await harness.ctx.approvals.cancel({ approvalId, companyId, reason: "no longer needed" });

    const approval = await harness.ctx.approvals.get({ approvalId, companyId });
    expect(approval!.status).toBe("cancelled");
    expect(approval!.decisionNote).toBe("no longer needed");
    expect(received).toHaveLength(1);
    expect(received[0]!.status).toBe("cancelled");
    expect(received[0]!.decisionNote).toBe("no longer needed");
  });

  it("cancel is a no-op for already-cancelled approvals", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create", "approvals.read"]) });

    const { approvalId } = await harness.ctx.approvals.create({ companyId, prompt: "Already done." });

    // cancel once
    await harness.ctx.approvals.cancel({ approvalId, companyId, reason: "first cancel" });

    // cancel again — should not throw and should not overwrite decisionNote
    await expect(
      harness.ctx.approvals.cancel({ approvalId, companyId, reason: "second cancel" }),
    ).resolves.toBeUndefined();

    const approval = await harness.ctx.approvals.get({ approvalId, companyId });
    expect(approval!.status).toBe("cancelled");
    expect(approval!.decisionNote).toBe("first cancel");
  });

  it("onResolved fires with the resolution event and cleans up", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create", "approvals.read"]) });

    const { approvalId } = await harness.ctx.approvals.create({ companyId, prompt: "Wait for me." });

    const received: Array<{ status: string }> = [];
    const unsubscribe = harness.ctx.approvals.onResolved(approvalId, async (event) => {
      received.push({ status: event.status });
    });

    await harness.simulateApprovalResolved(approvalId, {
      status: "approved",
      decisionNote: "Looks good",
      decidedByUserId: "user-board",
      decidedAt: new Date().toISOString(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].status).toBe("approved");

    // second simulate should not fire (callback was consumed)
    await expect(
      harness.simulateApprovalResolved(approvalId, {
        status: "approved",
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow("No active approval resolution callback");

    unsubscribe();
  });

  // ---------------------------------------------------------------------------
  // Reconciliation-on-restart contract
  // ---------------------------------------------------------------------------

  it("plugin reconciles pending approvals after restart by calling list", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create", "approvals.read"]) });

    // Create two approvals
    const { approvalId: aId } = await harness.ctx.approvals.create({ companyId, prompt: "Approval A" });
    const { approvalId: bId } = await harness.ctx.approvals.create({ companyId, prompt: "Approval B" });

    // Before any resolution: both appear in pending list
    const pendingBefore = await harness.ctx.approvals.list({ companyId, status: "pending" });
    expect(pendingBefore.some((a) => a.id === aId)).toBe(true);
    expect(pendingBefore.some((a) => a.id === bId)).toBe(true);

    // Plugin "restarts" — no active callbacks. Reconcile by calling list.
    // Approval A gets cancelled (simulates external board decision arriving during downtime)
    await harness.ctx.approvals.cancel({ approvalId: aId, companyId, reason: "board declined" });

    // After restart, plugin reconciles: list(pending) excludes A, includes B
    const pendingAfter = await harness.ctx.approvals.list({ companyId, status: "pending" });
    expect(pendingAfter.some((a) => a.id === aId)).toBe(false);
    expect(pendingAfter.some((a) => a.id === bId)).toBe(true);

    // get on A shows cancelled
    const approvalA = await harness.ctx.approvals.get({ approvalId: aId, companyId });
    expect(approvalA!.status).toBe("cancelled");
  });

  // ---------------------------------------------------------------------------
  // Capability gate enforcement
  // ---------------------------------------------------------------------------

  it("blocks approvals.create without the required capability", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest([]) });

    await expect(
      harness.ctx.approvals.create({ companyId, prompt: "Unauthorized." }),
    ).rejects.toThrow(/approvals\.create/);
  });

  it("blocks approvals.get without approvals.read capability", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create"]) });

    await expect(
      harness.ctx.approvals.get({ approvalId: randomUUID(), companyId }),
    ).rejects.toThrow(/approvals\.read/);
  });

  it("blocks approvals.list without approvals.read capability", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest([]) });

    await expect(
      harness.ctx.approvals.list({ companyId }),
    ).rejects.toThrow(/approvals\.read/);
  });

  it("blocks approvals.onResolved without approvals.read capability", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create"]) });
    const { approvalId } = await harness.ctx.approvals.create({ companyId, prompt: "Wait for me." });

    expect(() => {
      harness.ctx.approvals.onResolved(approvalId, async () => {});
    }).toThrow(/approvals\.read/);
  });

  it("blocks approvals.cancel without approvals.create capability", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({ manifest: manifest([]) });

    await expect(
      harness.ctx.approvals.cancel({ approvalId: randomUUID(), companyId }),
    ).rejects.toThrow(/approvals\.create/);
  });

  it("cross-company get returns null", async () => {
    const companyA = randomUUID();
    const companyB = randomUUID();
    const harness = createTestHarness({ manifest: manifest(["approvals.create", "approvals.read"]) });

    const { approvalId } = await harness.ctx.approvals.create({ companyId: companyA, prompt: "Isolated." });

    const result = await harness.ctx.approvals.get({ approvalId, companyId: companyB });
    expect(result).toBeNull();
  });
});
