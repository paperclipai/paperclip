// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentDetail } from "@paperclipai/shared";
import { ConfigurationTab } from "./AgentDetail";

const mocks = vi.hoisted(() => ({ update: vi.fn(), navigate: vi.fn(), toast: vi.fn() }));
vi.mock("../api/agents", async importOriginal => {
  const actual = await importOriginal<typeof import("../api/agents")>();
  return { ...actual, agentsApi: { ...actual.agentsApi, update: mocks.update, adapterModels: async () => [] } };
});
vi.mock("@/lib/router", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return { ...actual, useNavigate: () => mocks.navigate, useParams: () => ({ tab: "runtime" }) };
});
vi.mock("../context/ToastContext", async importOriginal => {
  const actual = await importOriginal<typeof import("../context/ToastContext")>();
  return { ...actual, useToastActions: () => ({ pushToast: mocks.toast }) };
});
vi.mock("../components/AgentConfigForm", () => ({
  AgentConfigForm: ({ onSave }: { onSave: (patch: Record<string, unknown>) => Promise<unknown> }) =>
    <button onClick={() => { void onSave({ runner: "paperclip" }); }}>Upgrade runner</button>,
}));

function agent(id: string): AgentDetail {
  return { id, companyId: "company-1", name: id, urlKey: id, role: "engineer", permissions: {},
    adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, chainOfCommand: [] } as unknown as AgentDetail;
}

afterEach(() => vi.clearAllMocks());

it("keeps an upgrade receipt on its original agent when navigation changes the configuration page", async () => {
  const original = agent("original-agent");
  let finish!: (updated: AgentDetail) => void;
  mocks.update.mockReturnValue(new Promise<AgentDetail>(resolve => { finish = resolve; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const noop = () => {};
  const render = (value: AgentDetail) => root.render(<QueryClientProvider client={client}>
    <ConfigurationTab agent={value} companyId={value.companyId} onDirtyChange={noop} onSaveActionChange={noop}
      onCancelActionChange={noop} onSavingChange={noop} updatePermissions={{ mutate: noop, isPending: false }} />
  </QueryClientProvider>);
  try {
    await act(async () => render(original));
    await act(async () => container.querySelector("button")!.click());
    await act(async () => render(agent("other-agent")));
    await act(async () => finish({ ...original, adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(mocks.update).toHaveBeenCalledWith(original.id, { runner: "paperclip" }, original.companyId);
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agents", "detail", original.id] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["agents", "detail", "other-agent"] });
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});
