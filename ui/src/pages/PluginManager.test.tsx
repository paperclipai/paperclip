// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginManager } from "./PluginManager";

const mockPluginsApi = vi.hoisted(() => ({
  install: vi.fn(),
  list: vi.fn(),
  listBundled: vi.fn(),
  uninstall: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("@/api/plugins", () => ({ pluginsApi: mockPluginsApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "company-1", name: "Paperclip" } }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));
vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderManager(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PluginManager />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return root;
}

describe("PluginManager", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockPluginsApi.list.mockResolvedValue([]);
    mockPluginsApi.listBundled.mockResolvedValue([]);
    mockPluginsApi.install.mockResolvedValue({ id: "plugin-1" });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("installs a server-local plugin using the local-path API mode", async () => {
    const root = await renderManager(container);

    const openButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Install Plugin"));
    expect(openButton).toBeTruthy();
    await act(async () => openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const localPathButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Local path"));
    expect(localPathButton).toBeTruthy();
    await act(async () => localPathButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const pathInput = document.querySelector<HTMLInputElement>('input[placeholder="/plugins/my-plugin"]');
    expect(pathInput).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(pathInput, "/plugins/ecs");
      pathInput?.dispatchEvent(new Event("input", { bubbles: true }));
      pathInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const installButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "Install");
    expect(installButton).toBeTruthy();
    await act(async () => installButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(mockPluginsApi.install).toHaveBeenCalledWith({ packageName: "/plugins/ecs", isLocalPath: true });

    await act(async () => root.unmount());
  });

  it("clears an npm package name when switching to local-path mode", async () => {
    const root = await renderManager(container);

    const openButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Install Plugin"));
    await act(async () => openButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    const npmInput = document.querySelector<HTMLInputElement>('input[placeholder="@paperclipai/plugin-example"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(npmInput, "@example/plugin");
      npmInput?.dispatchEvent(new Event("input", { bubbles: true }));
      npmInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const localPathButton = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Local path"));
    await act(async () => localPathButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(document.querySelector<HTMLInputElement>('input[placeholder="/plugins/my-plugin"]')?.value).toBe("");

    await act(async () => root.unmount());
  });
});
