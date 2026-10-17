// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolConnection } from "@paperclipai/shared";
import {
  GATEWAY,
  MASKED_KEY,
  readOk,
} from "./import-claude-config-fixtures";
import { ManagedAiConnectionDetails, ManagedAiConnectionRow } from "./ManagedAiConnectionDetails";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/router")>();
  return { ...actual, useNavigate: () => navigate };
});
const managedApi = vi.hoisted(() => ({
  list: vi.fn(),
  activeRuns: vi.fn(async () => []),
  setDefault: vi.fn(),
  probeUsage: vi.fn(),
  readLocalClaudeConfig: vi.fn(),
  importLocalClaudeConfig: vi.fn(),
}));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: managedApi }));
const agentsApi = vi.hoisted(() => ({ adapterModels: vi.fn(async () => []) }));
vi.mock("@/api/agents", () => ({ agentsApi }));
const toolsApi = vi.hoisted(() => ({ listConnectionGrants: vi.fn(), revokeConnectionGrant: vi.fn() }));
vi.mock("@/api/tools", () => ({ toolsApi }));
const heartbeatsApi = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi }));

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  // What the operator's machine answers, and what a re-import does to it. Set
  // here rather than in a hoisted factory so each case can override either one.
  managedApi.readLocalClaudeConfig.mockResolvedValue(readOk());
  managedApi.importLocalClaudeConfig.mockResolvedValue({ connectionId: "connection", grantId: "grant-1" });
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

const connection = (config: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  id: "connection",
  companyId: "company-1",
  connectionPurpose: "ai",
  credentialPolicy: "per_user",
  config,
  ...overrides,
}) as unknown as ToolConnection;

/** The gateway an imported connection carries, and the variable its key came from. */
const importedAi = {
  provider: "anthropic",
  method: "api_key",
  baseUrl: GATEWAY,
  keyVariable: "ANTHROPIC_API_KEY",
} as const;

const renderRow = (value: ToolConnection) =>
  flushSync(() => root.render(<ManagedAiConnectionRow connection={value} />));

/** What the list answers with for one company's accounts. */
const accountSummary = (overrides: Record<string, unknown> = {}) => ({
  id: "connection",
  grantId: "grant-1",
  companyId: "company-1",
  provider: "anthropic",
  method: "api_key",
  name: "Imported from Claude config",
  ownership: "personal",
  ownerUserId: "user-1",
  isDefault: true,
  status: "connected",
  ...overrides,
});

const grant = { id: "grant-1", status: "active", capabilities: { canRevoke: true } };

/** Open one connection's own page over a company whose accounts are already loaded. */
async function renderDetails(baseUrl?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["ai-connection-active-runs", "connection"], []);
  const accountList = {
    currentUserId: "user-1",
    canManageConnections: true,
    connections: [accountSummary(baseUrl ? { baseUrl } : {})],
  };
  client.setQueryData(["ai-connections", "company-1"], accountList);
  // The page re-reads the account after a re-import, so the list has to answer
  // again rather than resolve to nothing.
  managedApi.list.mockResolvedValue(accountList);
  client.setQueryData(["ai-connection-grants", "connection"], { grants: [grant] });
  // The card's model row waits for the adapter's list the way every other
  // surface's does, so it is seeded rather than left to land mid-press.
  client.setQueryData(queryKeys.agents.adapterModels("company-1", "claude_local", null), []);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ManagedAiConnectionDetails connection={connection({ ai: importedAi }, { name: "Imported from Claude config" })} />
      </QueryClientProvider>,
    );
  });
}

it("names the custom endpoint of an imported connection", () => {
  renderRow(connection({ ai: importedAi }));
  expect(host.textContent).toContain("Custom endpoint · https://gateway.example.test/v1");
});

it("marks every other connection as the provider's official endpoint", () => {
  renderRow(connection({ ai: { provider: "anthropic", method: "subscription" } }));
  expect(host.textContent).toContain("Claude subscription");
  expect(host.textContent).toContain("Official endpoint");
  expect(host.textContent).not.toContain("Custom endpoint");
});

it("stays silent about an endpoint when the stored metadata carries none", () => {
  renderRow(connection({ ai: { provider: "openai", method: "api_key" } }));
  expect(host.textContent).toContain("API key");
  expect(host.textContent).toContain("Official endpoint");
});

it("keeps an imported endpoint and an official one apart in the same list", async () => {
  // Two Anthropic connections in one company can differ in nothing but the
  // endpoint, so each row has to say which it is (PRODUCT #30) — and neither
  // label may be the row's only answer, or the two cannot be told apart.
  await act(async () => {
    root.render(
      <>
        <ManagedAiConnectionRow connection={connection({ ai: importedAi }, { id: "imported" })} />
        <ManagedAiConnectionRow connection={connection({ ai: { provider: "anthropic", method: "api_key" } }, { id: "official" })} />
      </>,
    );
  });
  const rows = [...host.querySelectorAll("p")].map((node) => node.textContent ?? "");
  expect(rows.filter((row) => row.includes(`Custom endpoint · ${GATEWAY}`))).toHaveLength(1);
  expect(rows.filter((row) => row.includes("Official endpoint"))).toHaveLength(1);
  // The masked key is what the import card showed; the row never repeats it.
  expect(host.textContent).not.toContain(MASKED_KEY);
});

it.each([
  ["an imported gateway", GATEWAY, true],
  ["an official endpoint", undefined, false],
])("says which endpoint the connection's own page is for on %s", async (_label, baseUrl, custom) => {
  // The row is the list; this is the page an operator opens to pick or repair one
  // of them (PRODUCT #30). The endpoint is read off the account the list
  // answered with, which is where the import stored it.
  await renderDetails(baseUrl);
  expect(host.textContent).toContain("API key");
  expect(host.textContent).toContain(custom ? `Custom endpoint · ${GATEWAY}` : "Official endpoint");
  expect(host.textContent).not.toContain(custom ? "Official endpoint" : "Custom endpoint");
});

/** Radix portals the card out of the host, so the card is read off the document. */
const cardText = () => document.body.textContent ?? "";
/**
 * A button by its whole label. Not a substring: the page's own action is called
 * "Re-import from this machine", and a match on "Re-import" would find that one
 * instead of the card's own button.
 */
const button = (label: string) => [...document.querySelectorAll("button")].find(
  (item) => item.textContent?.trim() === label,
);
const press = async (label: string) => {
  // The import is an async round trip, so the press waits a turn for it to land
  // before the assertions read what it did.
  await act(async () => {
    button(label)?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("re-importing a connection from this machine", () => {
  // The card is a real React tree driven by real presses, so `act` needs to know
  // it is the test environment doing the driving.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  it.each([
    ["an imported gateway", GATEWAY],
    ["an official endpoint", undefined],
  ])("offers the action on %s", async (_label, baseUrl) => {
    // Only a connection that carries its own endpoint was ever imported, so only
    // it can be re-read: for any other account the endpoint is the provider's
    // official API, which this machine's settings never described (PRODUCT #33).
    await renderDetails(baseUrl);
    expect(Boolean(button("Re-import from this machine"))).toBe(baseUrl === GATEWAY);
  });

  it("reads the file on entry and confirms with a mask, never the key", async () => {
    await renderDetails(GATEWAY);
    await press("Re-import from this machine");
    expect(managedApi.readLocalClaudeConfig).toHaveBeenCalledWith("company-1");
    expect(cardText()).toContain(GATEWAY);
    expect(cardText()).toContain(`ANTHROPIC_API_KEY · ${MASKED_KEY}`);
    expect(cardText()).toContain("claude-opus-4-6");
    // The read does not return the value, so there is nothing on the card to
    // leak — and a plaintext-looking fragment would mean something slipped in.
    expect(cardText()).not.toContain("sk-ant-api03");
  });

  it("reconnects the same account, keeping its name and its grants", async () => {
    await renderDetails(GATEWAY);
    await press("Re-import from this machine");
    await press("Re-import");
    // #34: the connection id is what makes this a reconnect rather than a second
    // account, and the name goes back unchanged because a reconnect cannot rename.
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledWith("company-1", expect.objectContaining({
      provider: "anthropic",
      method: "api_key",
      connectionId: "connection",
      name: "Imported from Claude config",
      baseUrl: GATEWAY,
      keyVariable: "ANTHROPIC_API_KEY",
      model: "claude-opus-4-6",
      confirm: {
        keyVariable: "ANTHROPIC_API_KEY",
        maskedKey: MASKED_KEY,
        defaultModel: "claude-opus-4-6",
        alternativeModels: ["claude-sonnet-4-6", "claude-haiku-4-5"],
      },
    }));
    // Nothing about the credential travels: `confirm` carries the mask the route
    // compares against what it reads, and that is the whole of it. Strip it and
    // nothing key-shaped is left behind.
    const payload = JSON.stringify(managedApi.importLocalClaudeConfig.mock.calls);
    expect(payload).toContain(MASKED_KEY);
    expect(payload.replace(MASKED_KEY, "")).not.toContain("sk-ant");
    // Done, and the page re-reads the account so the endpoint and the model
    // ladder it now shows are the stored ones.
    expect(button("Re-import from this machine")).toBeDefined();
    expect(managedApi.list).toHaveBeenCalled();
  });

  it("keeps the card standing and the account untouched when the gateway refuses", async () => {
    await renderDetails(GATEWAY);
    await press("Re-import from this machine");
    // #35: the route writes nothing when the probe fails, so the account on the
    // page is still the one it was — the card just has to say why.
    managedApi.importLocalClaudeConfig.mockRejectedValueOnce(new ApiError(
      "The gateway rejected this key. If this machine's settings.json sets both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, the imported variable may be the wrong one: they authenticate differently. Change the file and import again.",
      422,
      {},
    ));
    await press("Re-import");
    expect(cardText()).toContain("rejected this key");
    // The values are all still there: one more press is the whole retry.
    expect(cardText()).toContain(GATEWAY);
    expect(cardText()).toContain(`ANTHROPIC_API_KEY · ${MASKED_KEY}`);
    // And the retry lands on the same account rather than a second one.
    await press("Re-import");
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledTimes(2);
    expect(managedApi.importLocalClaudeConfig).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ connectionId: "connection" }));
  });

  it("lets the operator pick a different model from the tiers the read folded", async () => {
    await renderDetails(GATEWAY);
    await press("Re-import from this machine");
    // The card's model row is the same field it is everywhere else (PRODUCT #19),
    // and re-importing is a chance to change what this connection runs.
    const select = document.querySelector<HTMLButtonElement>('[aria-label="Model"]')!;
    await act(async () => { select.click(); });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (item) => item.textContent === "claude-sonnet-4-6",
    )!;
    await act(async () => { option.click(); });
    await press("Re-import");
    expect(managedApi.importLocalClaudeConfig).toHaveBeenCalledWith("company-1", expect.objectContaining({
      model: "claude-sonnet-4-6",
    }));
  });

  it("names the file and the variable to fix when this machine no longer has a gateway configured", async () => {
    await renderDetails(GATEWAY);
    managedApi.readLocalClaudeConfig.mockResolvedValue({
      status: "unavailable",
      reason: "base_url_missing",
      message: "No gateway is configured on this machine.",
    });
    await press("Re-import from this machine");
    expect(cardText()).toContain("No gateway is configured on this machine.");
    // The guidance is the part that says what to set and where.
    expect(cardText()).toContain("ANTHROPIC_BASE_URL");
    expect(cardText()).toContain("~/.claude/settings.json");
    // Nothing was imported, and the account is untouched.
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
  });

  it("imports nothing at all when the card is cancelled", async () => {
    await renderDetails(GATEWAY);
    await press("Re-import from this machine");
    await press("Cancel");
    expect(button("Re-import from this machine")).toBeDefined();
    expect(managedApi.importLocalClaudeConfig).not.toHaveBeenCalled();
  });
});

