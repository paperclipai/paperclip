// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDisabledAdaptersSync } from "./use-disabled-adapters";

const adaptersApiMocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

const healthApiMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

const authApiMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const disabledStoreMocks = vi.hoisted(() => ({
  setDisabledAdapterTypes: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  syncExternalAdapters: vi.fn(),
}));

vi.mock("@/api/adapters", () => ({
  adaptersApi: adaptersApiMocks,
}));

vi.mock("@/api/health", () => ({
  healthApi: healthApiMocks,
}));

vi.mock("@/api/auth", () => ({
  authApi: authApiMocks,
}));

vi.mock("@/adapters/disabled-store", () => ({
  setDisabledAdapterTypes: disabledStoreMocks.setDisabledAdapterTypes,
}));

vi.mock("@/adapters/registry", () => ({
  syncExternalAdapters: registryMocks.syncExternalAdapters,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const disabled = useDisabledAdaptersSync();
  return <div data-disabled-count={String(disabled.size)} />;
}

async function flushQueries() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useDisabledAdaptersSync", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
  });

  it("does not fetch adapters before board auth resolves in authenticated mode", async () => {
    healthApiMocks.get.mockResolvedValue({ deploymentMode: "authenticated" });
    authApiMocks.getSession.mockResolvedValue(null);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await flushQueries();

    expect(authApiMocks.getSession).toHaveBeenCalledTimes(1);
    expect(adaptersApiMocks.list).not.toHaveBeenCalled();
    expect(disabledStoreMocks.setDisabledAdapterTypes).not.toHaveBeenCalled();
  });

  it("fetches adapters after local trusted access is available", async () => {
    healthApiMocks.get.mockResolvedValue({ deploymentMode: "local_trusted" });
    adaptersApiMocks.list.mockResolvedValue([
      { type: "codex_local", label: "Codex", source: "builtin", disabled: true },
      { type: "external_test", label: "External", source: "external", disabled: false, overridePaused: false },
    ]);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await flushQueries();

    expect(authApiMocks.getSession).not.toHaveBeenCalled();
    expect(adaptersApiMocks.list).toHaveBeenCalledTimes(1);
    expect(disabledStoreMocks.setDisabledAdapterTypes).toHaveBeenCalledWith(["codex_local"]);
    expect(registryMocks.syncExternalAdapters).toHaveBeenCalledWith([
      {
        type: "external_test",
        label: "External",
        disabled: false,
        overrideDisabled: false,
      },
    ]);
    expect(container.firstElementChild?.getAttribute("data-disabled-count")).toBe("1");
  });
});
