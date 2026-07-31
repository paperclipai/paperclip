// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecretBindingPicker, SecretRefHintsContext, type SecretRefHint } from "./SecretBindingPicker";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

describe("SecretBindingPicker", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockSecretsApi.list.mockReset();
    mockSecretsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    queryClient.clear();
  });

  async function render(hints: Record<string, SecretRefHint> | undefined) {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <SecretRefHintsContext.Provider value={hints}>
            <SecretBindingPicker
              value={{ secretId: "22222222-2222-2222-2222-222222222222" }}
              onChange={() => {}}
            />
          </SecretRefHintsContext.Provider>
        </QueryClientProvider>,
      );
    });
    // Let the secrets query settle so selectedMissing is based on real data.
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("names a cross-company secret and its owner instead of calling it missing", async () => {
    await render({
      "22222222-2222-2222-2222-222222222222": {
        name: "DAYTONA_API_KEY",
        status: "active",
        companyId: "company-2",
        companyName: "Other Team",
      },
    });

    expect(container.textContent).toContain("DAYTONA_API_KEY — Other Team");
    expect(container.textContent).toContain("Owned by the Other Team company");
    expect(container.textContent).not.toContain("Missing secret");
    expect(container.querySelector("select")?.className).not.toContain("border-destructive");
  });

  it("reports a deleted hinted secret as deleted", async () => {
    await render({
      "22222222-2222-2222-2222-222222222222": {
        name: "DAYTONA_API_KEY",
        status: "deleted",
        companyId: "company-2",
        companyName: "Other Team",
      },
    });

    expect(container.textContent).toContain("was deleted");
    expect(container.textContent).toContain("Missing secret");
  });

  it("keeps the generic missing-secret treatment when no hint exists", async () => {
    await render(undefined);

    expect(container.textContent).toContain("Missing secret");
    expect(container.textContent).toContain("no longer available");
    expect(container.querySelector("select")?.className).toContain("border-destructive");
  });
});
