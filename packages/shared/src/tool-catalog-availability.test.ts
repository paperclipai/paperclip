import { describe, expect, it } from "vitest";
import { isCatalogEntryBlocked, isCatalogEntryOffered, isCatalogEntryRemovedByProvider } from "./tool-catalog-availability.js";

describe("tool catalog availability", () => {
  it("tells offered, provider-removed and blocked actions apart", () => {
    const cases = [
      [{ status: "active" }, true, false, false],
      [{ status: "quarantined", quarantineReason: "pending_review" }, true, false, false],
      [{ status: "disabled", quarantineReason: "mcp_tool_removed" }, false, true, false],
      [{ status: "removed", quarantineReason: "provider_tool_removed" }, false, true, false],
      [{ status: "disabled", quarantineReason: null }, false, false, true],
    ] as const;
    for (const [entry, offered, removed, blocked] of cases) {
      expect([isCatalogEntryOffered(entry), isCatalogEntryRemovedByProvider(entry), isCatalogEntryBlocked(entry)]).toEqual([offered, removed, blocked]);
    }
  });
});
