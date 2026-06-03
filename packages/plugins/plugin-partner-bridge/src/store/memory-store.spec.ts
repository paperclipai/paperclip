import { describe, expect, it } from "vitest";
import { MemoryStore } from "./memory-store.js";

describe("MemoryStore", () => {
  it("cursors round-trip per (link, issue)", async () => {
    const s = new MemoryStore(); await s.ensure();
    expect(await s.getCursor("L", "iss")).toBeNull();
    await s.setCursor("L", "iss", "2026-06-03T10:00:00Z");
    expect(await s.getCursor("L", "iss")).toBe("2026-06-03T10:00:00Z");
  });
  it("mapping is found by source id", async () => {
    const s = new MemoryStore(); await s.ensure();
    await s.putMapping({ bridgeMsgId: "B", sourceItemId: "src", mirroredItemId: "mir", flags: { mirrored: true, notified: false, emailed: false } });
    expect((await s.findMappingBySource("src"))?.mirroredItemId).toBe("mir");
    expect(await s.findMappingBySource("nope")).toBeNull();
  });
  it("pending approval state transitions", async () => {
    const s = new MemoryStore(); await s.ensure();
    await s.putPendingApproval({ approvalId: "ap", linkId: "L", sourceCompanyId: "A", sourceItemId: "src", bridgeMsgId: "B", body: "x", state: "pending", createdAt: "t" });
    await s.setApprovalState("ap", "approved");
    expect((await s.getPendingApproval("ap"))?.state).toBe("approved");
  });
});
