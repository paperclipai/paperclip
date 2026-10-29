// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SecretBindingPicker,
  SecretRefHintsContext,
  type SecretRefHintsContextValue,
} from "./SecretBindingPicker";

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

  async function render(context: SecretRefHintsContextValue | undefined) {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <SecretRefHintsContext.Provider value={context}>
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

  function readyContext(status: string): SecretRefHintsContextValue {
    return {
      status: "ready",
      hints: {
        "22222222-2222-2222-2222-222222222222": {
          name: "DAYTONA_API_KEY",
          status,
          companyId: "company-2",
          companyName: "Other Team",
        },
      },
    };
  }

  it("names an active cross-company secret and its owner instead of calling it missing", async () => {
    await render(readyContext("active"));

    expect(container.textContent).toContain("DAYTONA_API_KEY — Other Team");
    expect(container.textContent).toContain("Owned by the Other Team organization");
    expect(container.textContent).not.toContain("Missing secret");
    expect(container.querySelector("select")?.className).not.toContain("border-destructive");
  });

  it("reports a deleted hinted secret as deleted", async () => {
    await render(readyContext("deleted"));

    expect(container.textContent).toContain("DAYTONA_API_KEY — Other Team");
    expect(container.textContent).toContain("was deleted");
    expect(container.querySelector("select")?.className).toContain("border-destructive");
  });

  it("does not present a disabled cross-company secret as working", async () => {
    await render(readyContext("disabled"));

    expect(container.textContent).toContain("DAYTONA_API_KEY — Other Team");
    expect(container.textContent).toContain("This secret is disabled");
    expect(container.textContent).not.toContain("keeps working");
    expect(container.querySelector("select")?.className).toContain("border-destructive");
  });

  it("stays neutral while descriptors are loading", async () => {
    await render({ status: "loading", hints: {} });

    expect(container.textContent).toContain("Checking this secret reference");
    expect(container.textContent).not.toContain("Missing secret");
    expect(container.querySelector("select")?.className).not.toContain("border-destructive");
  });

  it("stays neutral when the descriptor lookup failed", async () => {
    await render({ status: "error", hints: {} });

    expect(container.textContent).toContain("Could not load this secret reference");
    expect(container.textContent).not.toContain("Missing secret");
    expect(container.querySelector("select")?.className).not.toContain("border-destructive");
  });

  it("treats an unknown id as missing once descriptors are ready", async () => {
    await render({ status: "ready", hints: {} });

    expect(container.textContent).toContain("Missing secret");
    expect(container.textContent).toContain("no longer available");
    expect(container.querySelector("select")?.className).toContain("border-destructive");
  });

  it("keeps the generic missing-secret treatment when no hint context exists", async () => {
    await render(undefined);

    expect(container.textContent).toContain("Missing secret");
    expect(container.textContent).toContain("no longer available");
    expect(container.querySelector("select")?.className).toContain("border-destructive");
  });
});
