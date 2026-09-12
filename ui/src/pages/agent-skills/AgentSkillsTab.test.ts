// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { queryKeys } from "../../lib/queryKeys";
import { AgentSkillsTab } from "./AgentSkillsTab";
import { TooltipProvider } from "../../components/ui/tooltip";

vi.mock("@/lib/router", () => ({ Link: ({ children }: { children: unknown }) => children }));
vi.mock("./AgentSkillRow", () => ({ AgentSkillRow: ({ variant, data }: { variant: string; data: { key: string } }) =>
  createElement("div", { "data-skill": data.key, "data-variant": variant }) }));
import { toDesiredSkillPayload } from "./AgentSkillsTab";

describe("toDesiredSkillPayload", () => {
  const skillKey = "paperclipai/paperclip/paperclip";
  const versionId = "22222222-2222-4222-8222-222222222222";

  it("includes saved version pins while beta skills are enabled", () => {
    expect(toDesiredSkillPayload([skillKey], { [skillKey]: versionId }, true)).toEqual([
      { key: skillKey, versionId },
    ]);
  });

  it("omits saved version pins while beta skills are disabled", () => {
    expect(toDesiredSkillPayload([skillKey], { [skillKey]: versionId }, false)).toEqual([
      skillKey,
    ]);
  });
});


it("removes a connector from editable library rows when its automatic assignment arrives", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const agent = { id: "agent-1", companyId: "company-1", adapterType: "codex_local", adapterConfig: {} } as Agent;
  const key = "paperclipai/paperclip/agentmail";
  const snapshot = { adapterType: "codex_local", supported: true, mode: "ephemeral", desiredSkills: [], entries: [], warnings: [] };
  client.setQueryData(queryKeys.agents.skills(agent.id), snapshot);
  client.setQueryData(queryKeys.companySkills.list(agent.companyId), [{ id: "skill-1", key, name: "agentmail", categories: [], sourceKind: "bundled", sourceType: "bundled" }]);
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableBetaSkills: false });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(createElement(QueryClientProvider, { client }, createElement(TooltipProvider, { children: createElement(AgentSkillsTab, { agent, companyId: agent.companyId }) }))));
    expect(container.querySelector(`[data-skill="${key}"][data-variant="available"]`)).not.toBeNull();
    client.setQueryData(queryKeys.agents.skills(agent.id), { ...snapshot, desiredSkills: [key], entries: [{ key, runtimeName: "agentmail", desired: true, managed: true, readOnly: true, state: "configured" }] });
    await vi.waitFor(() => {
      expect(container.querySelector(`[data-skill="${key}"][data-variant="available"]`)).toBeNull();
      expect(container.querySelector(`[data-skill="${key}"][data-variant="enabled"]`)).toBeNull();
      expect(container.textContent).toContain("Automatic and detected skills");
    });
  } finally {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
  }
});
