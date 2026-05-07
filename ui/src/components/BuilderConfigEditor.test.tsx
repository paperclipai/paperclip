// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderConfigEditor } from "./BuilderConfigEditor";
import { buildOpenClawGatewayConfig } from "@paperclipai/adapter-openclaw-gateway/ui";
import { buildOttoAgentConfig } from "@paperclipai/adapter-otto-agent/ui";

const mockBuilderApi = vi.hoisted(() => ({
  getTools: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

const mockToast = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

vi.mock("@/api/builder", () => ({
  builderApi: mockBuilderApi,
}));

vi.mock("@/adapters", () => ({
  listUIAdapters: () => [
    { type: "openclaw_gateway", label: "OpenClaw Gateway" },
    { type: "otto_agent", label: "Otto Agent" },
  ],
  getUIAdapter: (type: string) => ({
    type,
    label: type,
    ConfigFields: () => <div>{type} config fields</div>,
    buildAdapterConfig:
      type === "openclaw_gateway" ? buildOpenClawGatewayConfig : buildOttoAgentConfig,
  }),
}));

vi.mock("./AgentConfigForm", () => ({
  AgentConfigForm: () => <div>mock agent config form</div>,
}));

vi.mock("@/context/ToastContext", () => ({
  useToastActions: () => mockToast,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("BuilderConfigEditor", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockBuilderApi.getTools.mockResolvedValue({
      tools: [],
      supportedAdapterTypes: ["openclaw_gateway", "otto_agent"],
    });
    mockToast.pushToast.mockReset();
    mockBuilderApi.updateSettings.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderWithSettings(settings: Record<string, unknown> | null) {
    mockBuilderApi.getSettings.mockResolvedValue({ settings });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <BuilderConfigEditor companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    return { root, queryClient };
  }

  it("hydrates OpenClaw Builder settings and saves without requiring a model", async () => {
    mockBuilderApi.updateSettings.mockResolvedValue({
      settings: {
        companyId: "company-1",
        adapterType: "openclaw_gateway",
        adapterConfig: {},
      },
    });

    const { root } = await renderWithSettings({
      companyId: "company-1",
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "wss://gateway.example",
        authTokenRef: { type: "secret_ref", secretId: "secret-1", version: "latest" },
        disableDeviceAuth: false,
        artifactOutputs: [
          { pattern: "deliverables/final-packet.md", title: "Final packet", primary: true },
        ],
      },
    });

    expect(container.textContent).toContain(
      "A gateway token is already stored for this Builder configuration. Leave the field blank to keep it.",
    );
    expect(container.textContent).not.toContain("Select a model before saving.");

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save Builder settings",
    );
    if (!saveButton) throw new Error("Save button not found");

    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockBuilderApi.updateSettings).toHaveBeenCalledWith("company-1", {
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "wss://gateway.example",
        disableDeviceAuth: false,
        timeoutSec: 120,
        waitTimeoutMs: 120000,
        sessionKeyStrategy: "issue",
        role: "operator",
        scopes: ["operator.admin", "operator.write"],
        artifactOutputs: [
          { pattern: "deliverables/final-packet.md", title: "Final packet", primary: true },
        ],
      },
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the stored Otto key note and saves without re-entering the key", async () => {
    mockBuilderApi.updateSettings.mockResolvedValue({
      settings: {
        companyId: "company-1",
        adapterType: "otto_agent",
        adapterConfig: {},
      },
    });

    const { root } = await renderWithSettings({
      companyId: "company-1",
      adapterType: "otto_agent",
      adapterConfig: {
        url: "https://otto.example/api/paperclip",
        apiKeyRef: { type: "secret_ref", secretId: "secret-otto", version: "latest" },
        timeoutSec: 900,
      },
    });

    expect(container.textContent).toContain(
      "An Otto API key is already stored for this Builder configuration. Leave the field blank to keep it.",
    );
    expect(container.textContent).not.toContain("Select a model before saving.");

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Save Builder settings",
    );
    if (!saveButton) throw new Error("Save button not found");

    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockBuilderApi.updateSettings).toHaveBeenCalledWith("company-1", {
      adapterType: "otto_agent",
      adapterConfig: {
        url: "https://otto.example/api/paperclip",
        timeoutSec: 900,
      },
    });

    await act(async () => {
      root.unmount();
    });
  });
});
