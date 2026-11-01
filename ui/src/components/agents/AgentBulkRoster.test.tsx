// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentBulkRoster } from "./AgentBulkRoster";

vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: {
  list: vi.fn(async () => ({ currentUserId: "board", connections: [] })),
} }));

describe("pending agent roster display", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    client.clear();
    container.remove();
  });

  function render(metadata: Record<string, unknown>) {
    const agent = { id: "draft", name: "Atlas", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
      pauseReason: "setup", status: "paused", metadata } as unknown as Agent;
    flushSync(() => root.render(<QueryClientProvider client={client}>
      <AgentBulkRoster companyId="company" agents={[agent]} visibleAgents={[agent]} renderAgent={item => <span>{item.name}</span>} />
    </QueryClientProvider>));
    return [...container.querySelectorAll("tbody tr")][0] as HTMLTableRowElement;
  }

  it("retains the pending harness label while keeping the placeholder unavailable for bulk editing", () => {
    const row = render({ setupAdapterPending: true,
      setupAdapterChoice: { adapterType: "paperclip_runner", runnerProvider: "antigravity", runner: "auto" } });
    expect([...row.querySelectorAll("td")].slice(2).map(cell => cell.textContent)).toEqual([
      "Google Antigravity", "Not configured", "Not available yet",
    ]);
    const checkbox = row.querySelector<HTMLButtonElement>('[role="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.disabled).toBe(true);
    expect(container.textContent).not.toContain("Edit connection & model");
  });

  it("preserves ordinary process display without a saved setup choice", () => {
    const row = render({ setupAdapterPending: true });
    expect([...row.querySelectorAll("td")].slice(2).map(cell => cell.textContent)).toEqual([
      "Process", "Managed externally", "Harness default",
    ]);
    const checkbox = row.querySelector<HTMLButtonElement>('[role="checkbox"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox!.disabled).toBe(true);
  });
});
