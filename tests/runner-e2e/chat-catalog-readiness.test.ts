import { describe, expect, it } from "vitest";
import { chatCatalogAgentIsReady } from "./chat-catalog-contract.js";
import { chatCatalogRunStatusAllowed } from "./chat-catalog-run-policy.js";
import { pollUntil } from "./api.js";

describe("catalog agent lifecycle readiness", () => {
  it.each(["idle", "active", "running"])("accepts a lifecycle-ready %s agent", status => {
    expect(chatCatalogAgentIsReady({ lifecycleState: "ready", status, lifecycleError: null })).toBe(true);
  });
  it.each(["paused", "error", "terminated", "pending_approval", "verifying", "failed", ""])("rejects non-ready operational status %s", status => {
    expect(chatCatalogAgentIsReady({ lifecycleState: "ready", status })).toBe(false);
  });
  it.each(["verifying", "pending", "failed", "paused", undefined, null])("rejects unready lifecycle %s even while running", lifecycleState => {
    expect(chatCatalogAgentIsReady({ lifecycleState, status: "running" })).toBe(false);
  });
  it("rejects lifecycle errors even when the status says ready and running", () => {
    expect(chatCatalogAgentIsReady({ lifecycleState: "ready", status: "running", lifecycleError: "failure" })).toBe(false);
    expect(chatCatalogAgentIsReady({ lifecycleState: "ready" })).toBe(false);
  });
  it("the actual polling helper accepts a ready busy worker without another readiness request", async () => {
    let reads = 0;
    const actual = { id: "held-worker", lifecycleState: "ready", status: "running", lifecycleError: null };
    expect(await pollUntil({ label: "held worker readiness", deadlineAt: Date.now() + 45_000,
      load: async () => { reads++; return actual; }, accept: chatCatalogAgentIsReady })).toBe(actual);
    expect(reads).toBe(1);
  });
  it("accepting a busy agent does not accept a running canonical native as a completed run", () => {
    expect(chatCatalogAgentIsReady({ lifecycleState: "ready", status: "running" })).toBe(true);
    expect(chatCatalogRunStatusAllowed({ implementation: {}, run: { status: "running" } as never,
      companyId: "company", leadId: "lead" })).toBe(false);
  });
});
