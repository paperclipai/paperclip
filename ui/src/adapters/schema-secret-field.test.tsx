// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterConfigFieldsProps } from "./types";
import { SchemaConfigFields, invalidateConfigSchemaCache } from "./schema-config-fields";
import { schemaSecretBinding, schemaSecretRawValue } from "./schema-secret-field";
import { TooltipProvider } from "../components/ui/tooltip";
import { defaultCreateValues } from "../components/agent-config-defaults";

const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));

vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));

const SECRET_ID = "33333333-3333-3333-3333-333333333333";
const adapterType = "secret-field-test";

let root: Root | undefined;
let queryClient: QueryClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  invalidateConfigSchemaCache(adapterType);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockSecretsApi.list.mockReset();
  mockSecretsApi.list.mockResolvedValue([
    { id: SECRET_ID, name: "Gateway token", key: "gateway-token", provider: "local_encrypted", status: "active", latestVersion: 1, managedMode: "paperclip_managed" },
  ]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      fields: [
        { key: "token", label: "Token", type: "text", meta: { secret: true } },
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

function changeValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("schema secret fields", () => {
  it("renders a password input and no picker for non-secret fields", async () => {
    const container = await renderFields({});
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(container.querySelectorAll("select")).toHaveLength(1);
    expect(container.textContent).toContain("Base URL");
  });

  it("writes a secret_ref when an existing secret is chosen in create mode", async () => {
    const set = vi.fn();
    const container = await renderFields({ set });
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => changeValue(select, SECRET_ID));
    expect(set).toHaveBeenCalledWith({
      adapterSchemaValues: { token: { type: "secret_ref", secretId: SECRET_ID, version: "latest" } },
    });
  });

  it("writes a plain string when a new value is typed", async () => {
    const set = vi.fn();
    const container = await renderFields({ set });
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => changeValue(input, "s3cret"));
    expect(set).toHaveBeenLastCalledWith({ adapterSchemaValues: { token: "s3cret" } });
  });

  it("shows the bound secret name in edit mode and clears it", async () => {
    const mark = vi.fn();
    const container = await renderFields({
      mode: "edit", isCreate: false, values: null, set: null as never, mark,
      config: { token: { type: "secret_ref", secretId: SECRET_ID, version: "latest" } },
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe(SECRET_ID);
    expect(container.textContent).toContain("Gateway token");
    expect(container.querySelector('input[type="password"]')).toBeNull();
    await act(async () => changeValue(select, ""));
    expect(mark).toHaveBeenCalledWith("adapterConfig", "token", undefined);
  });

  it("never shows the redacted placeholder as an editable value", async () => {
    const mark = vi.fn();
    const container = await renderFields({
      mode: "edit", isCreate: false, values: null, set: null as never, mark,
      config: { token: "***REDACTED***" },
    });
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toContain("Stored secret");
    expect(mark).not.toHaveBeenCalled();
  });
});

describe("schema secret helpers", () => {
  it("maps stored values", () => {
    expect(schemaSecretBinding({ type: "secret_ref", secretId: "a" })).toEqual({ secretId: "a", version: "latest" });
    expect(schemaSecretBinding("plain")).toBeNull();
    expect(schemaSecretRawValue("***REDACTED***")).toBe("");
    expect(schemaSecretRawValue("abc")).toBe("abc");
    expect(schemaSecretRawValue({ type: "secret_ref", secretId: "a" })).toBe("");
  });
});
