// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanySecret, UserSecretDefinition } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissingUserSecretsBanner } from "./MissingUserSecretsBanner";
import type { MyUserSecretEntry } from "../../api/secrets";

const mockSecretsApi = vi.hoisted(() => ({
  listMyUserSecrets: vi.fn(),
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

function secret(): CompanySecret {
  return {
    id: "sec-1",
    companyId: "c1",
    scope: "user",
    ownerUserId: "u1",
    userSecretDefinitionId: "def-1",
    key: "PERSONAL_GH_TOKEN",
    name: "Personal GitHub token",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: null,
    latestVersion: 1,
    description: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: "u1",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
  return act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <MissingUserSecretsBanner companyId="c1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe("MissingUserSecretsBanner", () => {
  it("warns about an active user secret with no value and offers to set it", async () => {
    const entries: MyUserSecretEntry[] = [{ definition: definition(), secret: null }];
    mockSecretsApi.listMyUserSecrets.mockResolvedValue(entries);

    await render();
    await flushReact();

    expect(container.textContent).toContain("Personal GitHub token");
    expect(container.textContent).toContain("PERSONAL_GH_TOKEN");
    expect(container.textContent).toContain("Set value");
    expect(container.textContent?.toLowerCase()).toContain("will fail");
  });

  it("renders nothing when every active secret already has a value", async () => {
    const entries: MyUserSecretEntry[] = [{ definition: definition(), secret: secret() }];
    mockSecretsApi.listMyUserSecrets.mockResolvedValue(entries);

    await render();
    await flushReact();

    expect(container.textContent).toBe("");
  });

  it("ignores disabled definitions", async () => {
    const entries: MyUserSecretEntry[] = [
      { definition: definition({ status: "disabled" }), secret: null },
    ];
    mockSecretsApi.listMyUserSecrets.mockResolvedValue(entries);

    await render();
    await flushReact();

    expect(container.textContent).toBe("");
  });

  it("opens the set-value dialog when Set value is clicked", async () => {
    const entries: MyUserSecretEntry[] = [{ definition: definition(), secret: null }];
    mockSecretsApi.listMyUserSecrets.mockResolvedValue(entries);

    await render();
    await flushReact();

    const setButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Set value"),
    );
    expect(setButton).toBeTruthy();
    await act(() => setButton!.click());
    await flushReact();

    // Dialog content renders in a portal on document.body.
    expect(document.body.textContent).toContain("Set your value");
  });
});
