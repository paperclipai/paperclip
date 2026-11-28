// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSavedProviderKeys } from "./SavedProviderKeySelect";

const managedApi = vi.hoisted(() => ({
  list: vi.fn(async () => ({ currentUserId: "user-1", connections: [] as unknown[] })),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
const secretsMock = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  listMyUserSecrets: vi.fn(async () => []),
}));
vi.mock("@/api/secrets", () => ({ secretsApi: secretsMock }));

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const ANTIGRAVITY_SUBSCRIPTION = {
  id: "conn-antigravity",
  grantId: "grant-antigravity",
  companyId: "company-1",
  provider: "antigravity",
  method: "subscription",
  name: "My Antigravity",
  ownership: "personal",
  ownerUserId: "user-1",
  status: "connected",
  isDefault: true,
};
const GOOGLE_SUBSCRIPTION = {
  ...ANTIGRAVITY_SUBSCRIPTION,
  id: "conn-google",
  grantId: "grant-google",
  provider: "google",
  name: "My Google",
};
const OPENROUTER_SUBSCRIPTION = {
  ...ANTIGRAVITY_SUBSCRIPTION,
  id: "conn-openrouter",
  grantId: "grant-openrouter",
  provider: "openrouter",
  name: "My OpenRouter",
};
const ANTHROPIC_SUBSCRIPTION = {
  ...ANTIGRAVITY_SUBSCRIPTION,
  id: "conn-anthropic",
  grantId: "grant-anthropic",
  provider: "anthropic",
  name: "My Claude",
};

function Probe({ provider, envKey }: { provider?: "antigravity" | "openrouter"; envKey?: string }) {
  const { subscriptions, loading } = useSavedProviderKeys("company-1", envKey ?? "GEMINI_API_KEY", true, provider);
  return <div>{loading ? "loading" : subscriptions.map((option) => option.id).join(",")}</div>;
}

async function renderProbe(provider?: "antigravity" | "openrouter", envKey?: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe provider={provider} envKey={envKey} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) await flushReact();
  return { container, root };
}

describe("useSavedProviderKeys", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
    managedApi.list.mockResolvedValue({ currentUserId: "user-1", connections: [] });
  });

  it("finds a saved Antigravity subscription for agy_local when the provider is passed separately", async () => {
    managedApi.list.mockResolvedValue({
      currentUserId: "user-1",
      connections: [ANTIGRAVITY_SUBSCRIPTION, GOOGLE_SUBSCRIPTION],
    });
    const { container, root } = await renderProbe("antigravity");
    try {
      expect(container.textContent).toContain("ai:grant-antigravity");
      expect(container.textContent).not.toContain("ai:grant-google");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("still finds a saved Google subscription for the GEMINI_API_KEY default provider", async () => {
    managedApi.list.mockResolvedValue({
      currentUserId: "user-1",
      connections: [ANTIGRAVITY_SUBSCRIPTION, GOOGLE_SUBSCRIPTION],
    });
    const { container, root } = await renderProbe();
    try {
      expect(container.textContent).toContain("ai:grant-google");
      expect(container.textContent).not.toContain("ai:grant-antigravity");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("finds a saved OpenRouter subscription for pi_local when the provider is passed separately", async () => {
    managedApi.list.mockResolvedValue({
      currentUserId: "user-1",
      connections: [OPENROUTER_SUBSCRIPTION, ANTHROPIC_SUBSCRIPTION],
    });
    const { container, root } = await renderProbe("openrouter", "ANTHROPIC_API_KEY");
    try {
      expect(container.textContent).toContain("ai:grant-openrouter");
      expect(container.textContent).not.toContain("ai:grant-anthropic");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("still finds a saved Anthropic subscription for the ANTHROPIC_API_KEY default provider", async () => {
    managedApi.list.mockResolvedValue({
      currentUserId: "user-1",
      connections: [OPENROUTER_SUBSCRIPTION, ANTHROPIC_SUBSCRIPTION],
    });
    const { container, root } = await renderProbe(undefined, "ANTHROPIC_API_KEY");
    try {
      expect(container.textContent).toContain("ai:grant-anthropic");
      expect(container.textContent).not.toContain("ai:grant-openrouter");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
