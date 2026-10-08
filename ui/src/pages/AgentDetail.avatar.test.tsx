// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { appearanceForPalette, type Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentAvatarField } from "./AgentDetail";

const mockAgentsApi = vi.hoisted(() => ({ update: vi.fn() }));
const mockAssetsApi = vi.hoisted(() => ({ uploadImage: vi.fn() }));

vi.mock("../api/agents", () => ({ agentsApi: mockAgentsApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

// The live renderer has its own coverage in AgentPersona.test.tsx; this suite is about the controls.
vi.mock("../components/AgentCharacter", () => ({
  AgentCharacter: ({ label }: { label?: string }) => <span data-testid="agent-character">{label}</span>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mockAgentsApi.update.mockResolvedValue({});
  mockAssetsApi.uploadImage.mockResolvedValue({ contentPath: "/api/assets/asset-1/content" });
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function act(callback: () => void | Promise<void>) {
  if (typeof reactAct === "function") {
    await reactAct(callback);
    return;
  }

  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor<T>(assertion: () => T): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

function makeAgent(image?: string): Agent {
  const appearance = appearanceForPalette("deep-tide");
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Codex Coder",
    urlKey: "codexcoder",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    appearance: image ? { ...appearance, image } : appearance,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  } as Agent;
}

function renderField(agent: Agent, handlers: { onUpdated: () => void; onError: (message: string | null) => void }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <AgentAvatarField agent={agent} companyId="company-1" agentRef="agent-1" {...handlers} />
      </QueryClientProvider>,
    );
  });
}

function selectFile(file: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  return act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function buttonByText(text: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

describe("agent avatar field", () => {
  it("uploads a selected file and saves the returned asset path on the appearance", async () => {
    const onUpdated = vi.fn(), onError = vi.fn();
    await renderField(makeAgent(), { onUpdated, onError });
    const file = new File(["png"], "face.png", { type: "image/png" });

    await selectFile(file);

    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(mockAssetsApi.uploadImage).toHaveBeenCalledWith("company-1", file, "agents/agent-1");
    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      "agent-1",
      { appearance: { ...appearanceForPalette("deep-tide"), image: "/api/assets/asset-1/content" } },
      "company-1",
    );
    expect(onError).toHaveBeenCalledWith(null);
  });

  it("removes the uploaded image without uploading and keeps the palette appearance", async () => {
    const onUpdated = vi.fn(), onError = vi.fn();
    await renderField(makeAgent("/api/assets/old-asset/content"), { onUpdated, onError });

    await act(() => buttonByText("Remove image").click());

    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(1));
    expect(mockAssetsApi.uploadImage).not.toHaveBeenCalled();
    expect(mockAgentsApi.update).toHaveBeenCalledWith(
      "agent-1",
      { appearance: appearanceForPalette("deep-tide") },
      "company-1",
    );
  });

  it("offers removal only when an image is set", async () => {
    await renderField(makeAgent(), { onUpdated: vi.fn(), onError: vi.fn() });
    expect(() => buttonByText("Remove image")).toThrow();
  });

  it("reports a failed agent update and leaves the controls usable", async () => {
    const onUpdated = vi.fn(), onError = vi.fn();
    mockAgentsApi.update.mockRejectedValue(new Error("Appearance is invalid"));
    await renderField(makeAgent(), { onUpdated, onError });

    await selectFile(new File(["png"], "face.png", { type: "image/png" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Appearance is invalid"));
    expect(onUpdated).not.toHaveBeenCalled();
    const upload = container.querySelector<HTMLButtonElement>('button[aria-label="Upload Codex Coder avatar image"]');
    expect(upload?.disabled).toBe(false);
  });
});
