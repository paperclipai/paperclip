// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterConfigFieldsProps } from "./types";
import { SchemaConfigFields, invalidateConfigSchemaCache } from "./schema-config-fields";
import { aiConnectionKindLabel } from "./schema-ai-connection-field";
import { TooltipProvider } from "../components/ui/tooltip";
import { defaultCreateValues } from "../components/agent-config-defaults";

const mockAiConnectionsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../api/ai-connections", () => ({ aiConnectionsApi: mockAiConnectionsApi }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));

const adapterType = "ai-connection-field-test";
const SUBSCRIPTION = { id: "11111111-1111-4111-8111-111111111111", grantId: "21111111-1111-4111-8111-111111111111" };
const GATEWAY = { id: "33333333-3333-4333-8333-333333333333", grantId: "43333333-3333-4333-8333-333333333333" };

function connection(base: Record<string, unknown>) {
  return { companyId: "company-1", ownership: "shared", isDefault: false, status: "connected", ...base };
}

let root: Root | undefined;
let queryClient: QueryClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invalidateConfigSchemaCache(adapterType);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockAiConnectionsApi.list.mockReset();
  mockAiConnectionsApi.list.mockResolvedValue({
    currentUserId: "user-1",
    canManageConnections: true,
    connections: [
      connection({ ...SUBSCRIPTION, provider: "anthropic", method: "subscription", name: "Team Claude" }),
      connection({
        ...GATEWAY, provider: "anthropic", method: "api_key", name: "Edge gateway",
        routing: { kind: "gateway", protocol: "messages", baseUrl: "https://gateway.example.com", auth: "bearer", models: [] },
      }),
      connection({
        id: "53333333-3333-4333-8333-333333333333", grantId: "63333333-3333-4333-8333-333333333333",
        provider: "openai", method: "api_key", name: "OpenAI key",
      }),
      connection({
        id: "73333333-3333-4333-8333-333333333333", grantId: "83333333-3333-4333-8333-333333333333",
        provider: "anthropic", method: "api_key", name: "Chat gateway",
        routing: { kind: "gateway", protocol: "chat", baseUrl: "https://chat.example.com", auth: "bearer", models: [] },
      }),
    ],
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      fields: [
        {
          key: "judge", label: "Judge connection", type: "text",
          meta: { aiConnection: { harness: "claude_local", providers: ["anthropic"], protocols: ["messages"] } },
        },
        { key: "baseUrl", label: "Base URL", type: "text" },
      ],
    }),
  }));
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  queryClient.clear();
  vi.unstubAllGlobals();
});

async function renderFields(props: Partial<AdapterConfigFieldsProps>) {
  const full: AdapterConfigFieldsProps = {
    mode: "create", isCreate: true, adapterType, section: "configuration",
    values: { ...defaultCreateValues, adapterSchemaValues: {} }, set: vi.fn(),
    config: {}, eff: (_group, _field, original) => original, mark: vi.fn(), models: [],
    ...props,
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider><SchemaConfigFields {...full} /></TooltipProvider>
    </QueryClientProvider>,
  ));
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

function changeValue(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("schema ai connection fields", () => {
  it("lists only connections compatible with the declared harness, providers and protocols", async () => {
    const container = await renderFields({});
    const select = container.querySelector("select") as HTMLSelectElement;
    const labels = [...select.options].map((option) => option.textContent);
    expect(labels).toEqual([
      "No connection",
      "Team Claude · Claude subscription",
      "Edge gateway · Gateway · https://gateway.example.com",
    ]);
    expect(container.textContent).toContain("Base URL");
  });

  it("writes the binding when a connection is chosen in create mode", async () => {
    const set = vi.fn();
    const container = await renderFields({ set });
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => changeValue(select, `${GATEWAY.id}:${GATEWAY.grantId}`));
    expect(set).toHaveBeenCalledWith({
      adapterSchemaValues: {
        judge: { mode: "shared", provider: "anthropic", method: "api_key", connectionId: GATEWAY.id, grantId: GATEWAY.grantId },
      },
    });
  });

  it("marks a personal connection as delegated", async () => {
    mockAiConnectionsApi.list.mockResolvedValue({
      currentUserId: "user-1", canManageConnections: false,
      connections: [connection({ ...SUBSCRIPTION, ownership: "personal", ownerUserId: "user-1", provider: "anthropic", method: "subscription", name: "My Claude" })],
    });
    const set = vi.fn();
    const container = await renderFields({ set });
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => changeValue(select, `${SUBSCRIPTION.id}:${SUBSCRIPTION.grantId}`));
    expect(set.mock.calls[0][0].adapterSchemaValues.judge.mode).toBe("delegated");
  });

  it("shows the stored selection in edit mode and clears it", async () => {
    const mark = vi.fn();
    const container = await renderFields({
      mode: "edit", isCreate: false, values: null, set: null as never, mark,
      config: { judge: { mode: "shared", provider: "anthropic", method: "subscription", connectionId: SUBSCRIPTION.id, grantId: SUBSCRIPTION.grantId } },
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe(`${SUBSCRIPTION.id}:${SUBSCRIPTION.grantId}`);
    await act(async () => changeValue(select, ""));
    expect(mark).toHaveBeenCalledWith("adapterConfig", "judge", undefined);
  });

  it("flags a stored binding that is no longer available", async () => {
    const container = await renderFields({
      mode: "edit", isCreate: false, values: null, set: null as never,
      config: { judge: { mode: "shared", provider: "anthropic", method: "api_key", connectionId: "9".repeat(8) + "-9999-4999-8999-999999999999", grantId: "a".repeat(8) + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } },
    });
    expect(container.textContent).toContain("no longer available or compatible");
  });
});

describe("aiConnectionKindLabel", () => {
  it("describes subscriptions, API keys and gateways", () => {
    const base = { id: "i", grantId: "g", companyId: "c", ownership: "shared", isDefault: false, status: "connected", name: "n" } as const;
    expect(aiConnectionKindLabel({ ...base, provider: "anthropic", method: "subscription" })).toBe("Claude subscription");
    expect(aiConnectionKindLabel({ ...base, provider: "anthropic", method: "api_key" })).toBe("API key");
    expect(aiConnectionKindLabel({
      ...base, provider: "anthropic", method: "api_key",
      routing: { kind: "gateway", protocol: "messages", baseUrl: "https://g.example.com", auth: "bearer", models: [] },
    })).toBe("Gateway · https://g.example.com");
  });
});
