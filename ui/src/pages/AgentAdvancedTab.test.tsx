// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { ToastProvider } from "../context/ToastContext";
import { AgentAdvancedTab } from "./AgentAdvancedTab";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@codemirror/view", () => {
  class MockEditorView {
    state = { doc: { toString: () => "name: Agent\n", length: 12 } };
    static contentAttributes = { of: () => [] };
    static editable = { of: () => [] };
    static updateListener = { of: () => [] };
    dispatch() {}
    destroy() {}
  }
  return { EditorView: MockEditorView };
});

vi.mock("../lib/agent-configuration/load", () => ({
  loadAgentConfiguration: vi.fn(async () => ({
    agent: { id: "agent-1", companyId: "company-1", urlKey: "agent-1", name: "Agent" },
    document: { apiVersion: "paperclip/v1", kind: "Agent", metadata: { name: "Agent" } },
  })),
}));

vi.mock("../lib/agent-configuration/compact", () => ({
  compactAgentConfiguration: (doc: unknown) => doc,
}));

vi.mock("../lib/agent-configuration-yaml", () => ({
  serializeAgentConfigurationDocument: () => "name: Agent\n",
  parseAgentConfigurationYaml: () => ({ metadata: { name: "Agent" } }),
}));

vi.mock("../lib/agent-configuration/save", () => ({
  ConfigurationSaveInterrupted: class extends Error {},
  planAgentConfiguration: () => [],
  saveAgentConfiguration: vi.fn(),
}));

describe("AgentAdvancedTab", () => {
  it("positions the sticky save footer above MobileBottomNav on mobile", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    const agent = { id: "agent-1", companyId: "company-1", urlKey: "agent-1", name: "Agent" } as Agent;
    queryClient.setQueryData(["agent-configuration-yaml", agent.companyId, agent.id], {
      agent,
      document: { apiVersion: "paperclip/v1", kind: "Agent", metadata: { name: "Agent" } },
    });
    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <ToastProvider>
              <AgentAdvancedTab
                agent={agent}
                onDirtyChange={vi.fn()}
                onSaved={vi.fn()}
              />
            </ToastProvider>
          </QueryClientProvider>,
        );
      });

      const footer = container.querySelector("footer");
      expect(footer).not.toBeNull();
      const classes = footer!.className.split(/\s+/);
      expect(classes).toContain("sticky");
      expect(classes).toContain("mobile-nav-composer");
      expect(classes).toContain("bottom-(--tc-composer-bottom)");
      expect(classes).toContain("md:bottom-0");
      expect(classes).toContain("z-20");
      expect(classes).toContain("flex-wrap");
      expect(footer!.textContent).toContain("Reload saved");
      expect(footer!.textContent).toContain("Save changes");
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });
});
