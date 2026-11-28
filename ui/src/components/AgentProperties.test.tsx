// @vitest-environment jsdom
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { AgentProperties, agentConfiguredModel } from "./AgentProperties";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    list: vi.fn(async () => []),
  },
}));

describe("AgentProperties", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("extracts trimmed configured model strings", () => {
    expect(agentConfiguredModel({ model: "  gemini-4-hydrogen-xhigh  " })).toBe("gemini-4-hydrogen-xhigh");
    expect(agentConfiguredModel({ model: "   " })).toBeNull();
    expect(agentConfiguredModel({})).toBeNull();
  });

  it("renders Google Antigravity label and configured model row", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "Builder",
      urlKey: "builder",
      role: "engineer",
      title: "Lead Engineer",
      status: "idle",
      adapterType: "gemini_local",
      adapterConfig: {
        agentCommand: "agy acp",
        model: "gemini-4-hydrogen-xhigh",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    } as unknown as Agent;

    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentProperties agent={agent} />
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("Google Antigravity");
    expect(container.textContent).toContain("gemini-4-hydrogen-xhigh");

    flushSync(() => {
      root.unmount();
    });
  });
});
