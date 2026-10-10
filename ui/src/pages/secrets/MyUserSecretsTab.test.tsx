// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UserSecretDefinition } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MyUserSecretsTab } from "./MyUserSecretsTab";
import { ApiError } from "../../api/client";
import type { MyUserSecretEntry } from "../../api/secrets";
import { queryKeys } from "../../lib/queryKeys";

const mockSecretsApi = vi.hoisted(() => ({
  listMyUserSecrets: vi.fn(),
  removeMyUserSecret: vi.fn(),
  createMyUserSecret: vi.fn(),
  rotateMyUserSecret: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function definition(overrides: Partial<UserSecretDefinition> = {}): UserSecretDefinition {
  return {
    id: "def-1",
    companyId: "c1",
    key: "PERSONAL_GH_TOKEN",
    name: "Personal GitHub token",
    description: "Used for private repo access",
    status: "active",
    provider: "local_encrypted",
    managedMode: "paperclip_managed",
    providerConfigId: null,
    providerMetadata: null,
    usageGuidance: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const transientError = () =>
  new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" });

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForReact(predicate: () => boolean, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flushReact();
  }
  throw new Error("Timed out waiting for React state to settle");
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

function render() {
  root = createRoot(container);
  return act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MyUserSecretsTab companyId="c1" />
      </QueryClientProvider>,
    );
  });
}

describe("MyUserSecretsTab", () => {
  it("keeps loaded secrets visible when a refetch fails during an outage", async () => {
    const entries: MyUserSecretEntry[] = [{ definition: definition(), secret: null }];
    mockSecretsApi.listMyUserSecrets.mockResolvedValue(entries);

    await render();
    await flushReact();
    expect(container.textContent).toContain("Personal GitHub token");

    mockSecretsApi.listMyUserSecrets.mockRejectedValue(transientError());
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.secrets.myUserSecrets("c1") });
    });
    await flushReact();

    expect(mockSecretsApi.listMyUserSecrets).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Personal GitHub token");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting.");
  });

  it("shows readable copy and a Retry button when the list fails to load", async () => {
    const entries: MyUserSecretEntry[] = [{ definition: definition(), secret: null }];
    mockSecretsApi.listMyUserSecrets
      .mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }))
      .mockResolvedValue(entries);

    await render();
    await waitForReact(() => container.querySelector('[data-query-view="error"]') !== null);

    const errorState = container.querySelector('[data-query-view="error"]');
    expect(errorState?.textContent).toContain("Couldn't load your secrets");
    expect(errorState?.textContent).toContain("Boom");
    expect(container.textContent).not.toContain("No user secrets are defined");
    const retryButton = Array.from(errorState?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Retry"),
    );
    expect(retryButton).toBeTruthy();

    await act(() => retryButton!.click());
    await waitForReact(() => container.textContent?.includes("Personal GitHub token") ?? false);

    expect(mockSecretsApi.listMyUserSecrets).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
  });
});
