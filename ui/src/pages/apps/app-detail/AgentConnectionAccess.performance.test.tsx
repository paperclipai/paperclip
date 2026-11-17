// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ToolCatalogEntry, ToolPolicy, ToolProfileConfiguration } from "@paperclipai/shared";
import { AgentConnectionAccess } from "./AgentConnectionAccess";

it("indexes grant entries instead of scanning them for each catalog action", async () => {
  let entryReads = 0;
  let policyReads = 0;
  const catalog = Array.from({ length: 500 }, (_, index) => ({ id: `tool-${index}`, toolName: `Tool ${index}` })) as ToolCatalogEntry[];
  const entries = catalog.map(tool => ({ effect: "include", get catalogEntryId() {
    if (++entryReads > 1000) throw new Error("Grant matching scans the full entry list for each tool");
    return tool.id;
  } }));
  const profiles = [{ id: "profile-1", profileKey: "connection-intent:conn-1:agent-1", status: "active",
    metadata: { source: "connection_intent", connectionId: "conn-1", agentId: "agent-1" },
    bindings: [{ targetType: "agent", targetId: "agent-1" }], entries,
  }] as unknown as ToolProfileConfiguration[];
  const policies = catalog.map(tool => ({ enabled: true, policyType: "require_approval", selectors: { catalogEntryId: tool.id },
    get config() {
      if (++policyReads > 2000) throw new Error("Grant matching scans the policy list for each tool");
      return { source: "connection_intent", connectionId: "conn-1", agentId: "agent-1" };
    },
  })) as unknown as ToolPolicy[];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<AgentConnectionAccess connectionId="conn-1" profiles={profiles} policies={policies}
      catalog={catalog} agents={[]} canManage onRemove={vi.fn()} />));
    expect(container.querySelectorAll("li")).toHaveLength(500);
    expect(entryReads).toBeLessThanOrEqual(1000);
    expect(policyReads).toBeLessThanOrEqual(2000);
    expect(container.querySelectorAll("li")[499]?.textContent).toContain("Ask first");
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
