// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { EmailEndpointSetup } from "./EmailEndpointSetup";

const mocks = vi.hoisted(() => ({ companyId: "company" as string | null, listAgents: vi.fn(), connect: vi.fn(), credentials: vi.fn(), control: vi.fn(), inspectNew: vi.fn(), inspect: vi.fn(), checkAddress: vi.fn(), setup: vi.fn(), listInboxes: vi.fn(), listConnections: vi.fn(), getConnection: vi.fn(), putInstalls: vi.fn() }));
vi.mock("@/lib/router", async () => import("react-router-dom"));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.companyId }) }));
vi.mock("@/components/chat/ChatSetupNavigation", () => ({ ChatSetupNavigation: () => null }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.listAgents } }));
vi.mock("@/api/tools", () => ({ toolsApi: { putConnectionInstalls: mocks.putInstalls, listConnections: mocks.listConnections, getConnection: mocks.getConnection } }));
vi.mock("@/api/email", () => ({ emailApi: { credentials: mocks.credentials, control: mocks.control, inspect: mocks.inspectNew, connect: mocks.connect, inspectSaved: mocks.inspect, checkAddress: mocks.checkAddress, setup: mocks.setup, list: mocks.listInboxes } }));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  mocks.companyId = "company";
  sessionStorage.clear();
  mocks.listAgents.mockResolvedValue([{ id: "ralph", name: "Ralph", status: "idle", permissions: {} }]);
  mocks.credentials.mockResolvedValue([]);
  mocks.inspectNew.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [], domains: [] });
  mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [], domains: [] });
  mocks.checkAddress.mockImplementation(async (_company, _connection, { username, domain }) => ({ address: `${username}@${domain}`, status: "unknown" }));
  mocks.listInboxes.mockResolvedValue([]);
  mocks.listConnections.mockResolvedValue({ connections: [] });
  mocks.connect.mockResolvedValue({ id: "account" });
  mocks.setup.mockResolvedValue({ id: "endpoint", address: "ralph-team@agentmail.to", connectionId: "inbox" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client?.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function Location() { const location = useLocation(); return <output data-testid="location" data-search={location.search}>{location.pathname}</output>; }
async function mount(saved = true, waitForCompany = true, agentId = "ralph", search = "") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[
    `/apps/chat/connect?provider=agentmail&agentId=${agentId}${saved ? "&connectionId=account" : ""}${search}`,
  ]}><EmailEndpointSetup /><Location /></MemoryRouter></QueryClientProvider>));
  if (waitForCompany) await vi.waitFor(() => expect(container.textContent).toContain(agentId === "support" ? "Support" : "Ralph"));
}
function button(name: string) {
  const value = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === name);
  expect(value).toBeDefined();
  return value!;
}
async function click(name: string) {
  if (name === "Create email address") await vi.waitFor(() => expect(button(name).disabled).toBe(false));
  await act(async () => button(name).click());
}
async function fill(selector: string, value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(selector)!;
    expect(input).not.toBeNull();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AgentMail two-step setup", () => {
  it("starts a fresh catalog connection without adopting a previous draft's key or email step", async () => {
    sessionStorage.setItem("paperclip.agentmail-setup:company:new:ralph", JSON.stringify({
      connectionId: "old-inbox-key", step: 1, agentId: "ralph", requestId: crypto.randomUUID(),
      addressMode: "existing", inboxId: "locked@agentmail.to",
    }));
    const setupId = crypto.randomUUID();
    await mount(false, true, "ralph", `&setupId=${setupId}`);
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    expect(mocks.inspect).not.toHaveBeenCalled();
    await fill('input[type="password"]', "organization-test-key");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-name")).not.toBeNull());
    expect(mocks.connect).toHaveBeenCalledWith("company", expect.objectContaining({ idempotencyKey: setupId }));
    expect(container.textContent).toContain("How it Works");
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/apps/chat/connect");
  });

  it("resumes the catalog's exact reserved inbox with its original account and request ID", async () => {
    const requestId = crypto.randomUUID();
    mocks.listInboxes.mockResolvedValue([{
      id: requestId, connectionId: "inbox-connection", assignedAgentId: "ralph",
      address: "reserved@paperclip.example", status: "draft", receiveMode: "websocket",
    }]);
    mocks.getConnection.mockResolvedValue({ config: { credentialConnectionId: "original-account" } });
    await mount(false, true, "", `&resume=${requestId}`);
    await vi.waitFor(() => expect(button("Finish connecting").disabled).toBe(false));
    expect(mocks.inspect).toHaveBeenCalledWith("company", "original-account");
    expect(container.textContent).toContain("reserved@paperclip.example");
    expect(container.querySelector("#email-name")).toBeNull();
    await click("Finish connecting");
    expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({
      idempotencyKey: requestId, credentialConnectionId: "original-account", inboxId: "reserved@paperclip.example",
    }));
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("blocks a missing resume target rather than creating another inbox", async () => {
    await mount(false, true, "ralph", `&resume=${crypto.randomUUID()}`);
    await vi.waitFor(() => expect(container.textContent).toContain("This email setup could not be found"));
    expect(button("Create email address").disabled).toBe(true);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("honors Finish setup when an older client saved a replacement under the original resume key", async () => {
    const requestId = crypto.randomUUID();
    sessionStorage.setItem(`paperclip.agentmail-setup:company:${requestId}:ralph`, JSON.stringify({
      connectionId: "wrong-account", agentId: "someone-else", requestId: crypto.randomUUID(), username: "replacement",
    }));
    mocks.listInboxes.mockResolvedValue([{ id: requestId, connectionId: "original-inbox", assignedAgentId: "ralph", address: "original@agentmail.to", status: "draft", receiveMode: "websocket" }]);
    mocks.getConnection.mockResolvedValue({ config: { credentialConnectionId: "original-account" } });
    await mount(false, true, "ralph", `&resume=${requestId}`);
    await vi.waitFor(() => expect(button("Finish connecting").disabled).toBe(false));
    await click("Finish connecting");
    expect(mocks.setup).toHaveBeenLastCalledWith("company", expect.objectContaining({
      credentialConnectionId: "original-account", inboxId: "original@agentmail.to", assignedAgentId: "ralph", idempotencyKey: requestId,
    }));
  });

  it("returns Cancel to Connectors rather than the credential permissions page", async () => {
    await mount();
    await click("Cancel");
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/apps");
  });

  it.each(["Done", "Email settings"])("sends %s to its email destination after completion", async action => {
    await mount();
    await click("Continue");
    await click("Create email address");
    await vi.waitFor(() => expect(container.textContent).toContain("Your agent’s email is ready"));
    await click(action);
    expect(container.querySelector('[data-testid="location"]')?.textContent)
      .toBe(action === "Done" ? "/apps" : "/apps/chat/endpoint/settings");
  });

  it("suggests an accessible account key and opens the editable email form without saving another secret", async () => {
    mocks.credentials.mockResolvedValue([
      { id: "inbox-key", label: "Inbox key", scope: "inbox", createdAt: "2026-10-01T14:00:00Z" },
      { id: "organization-account", label: "AgentMail account key", scope: "organization", createdAt: "2026-09-30T14:00:00Z" },
    ]);
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [],
      domains: [{ domain: "paperclip.example", status: "VERIFIED" }] });
    await mount(false);
    await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("organization-account"));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>("#email-domain")?.value).toBe("paperclip.example"));
    await fill("#email-name", "ralph-mail");
    await click("Create email address");
    expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({
      credentialConnectionId: "organization-account", username: "ralph-mail", domain: "paperclip.example",
    }));
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.putInstalls).not.toHaveBeenCalled();
  });

  it.each(["alternate", ""])("preserves the selected key choice across refresh (%s)", async selection => {
    mocks.credentials.mockResolvedValue([
      { id: "preferred", label: "Preferred account", scope: "organization", createdAt: "2026-10-01T14:00:00Z" },
      { id: "alternate", label: "Other account", scope: "organization", createdAt: "2026-09-30T14:00:00Z" },
    ]);
    await mount(false);
    await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("preferred"));
    await act(async () => {
      const picker = container.querySelector<HTMLSelectElement>("select")!;
      picker.value = selection; picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => root.unmount()); client.clear(); root = createRoot(container);
    await mount(false);
    await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe(selection));
    if (!selection) expect(container.querySelector('input[type="password"]')).not.toBeNull();
    else {
      await click("Continue");
      await vi.waitFor(() => expect(mocks.inspect).toHaveBeenCalledWith("company", "alternate"));
    }
  });

  it("does not replace a newly entered key when saved-key discovery finishes later", async () => {
    let resolve!: (options: unknown[]) => void;
    mocks.credentials.mockReturnValue(new Promise(value => { resolve = value; }));
    await mount(false);
    await fill('input[type="password"]', "new-account-key");
    await act(async () => resolve([{ id: "saved", label: "AgentMail account key", scope: "organization", createdAt: "2026-10-01T14:00:00Z" }]));
    await vi.waitFor(() => expect(container.querySelector("select")).not.toBeNull());
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("");
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("new-account-key");
    await click("Continue");
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledWith("company", expect.objectContaining({ apiKey: "new-account-key" })));
  });

  it("catches a pasted inbox key before the email step and requires an explicit existing-inbox choice", async () => {
    mocks.inspectNew.mockResolvedValue({ scope: { scope_type: "inbox" }, inboxes: [{ inbox_id: "locked@agentmail.to" }], domains: [] });
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "inbox" }, inboxes: [{ inbox_id: "locked@agentmail.to" }], domains: [] });
    await mount(false);
    await fill('input[type="password"]', "inbox-secret");
    await click("Continue");
    await vi.waitFor(() => expect(container.textContent).toContain("That key only connects locked@agentmail.to"));
    expect(container.querySelector("#email-existing")).toBeNull();
    expect(mocks.connect).not.toHaveBeenCalled();
    await click("Use the existing inbox instead");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-existing")).not.toBeNull());
    await click("Connect email address");
    expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({ inboxId: "locked@agentmail.to" }));
  });

  it("keeps an already reserved inbox tied to its original account", async () => {
    const requestId = crypto.randomUUID();
    sessionStorage.setItem("paperclip.agentmail-setup:company:account:ralph", JSON.stringify({
      connectionId: "account", agentId: "ralph", step: 1, requestId,
    }));
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "inbox" }, inboxes: [{ inbox_id: "locked@agentmail.to" }], domains: [] });
    mocks.listInboxes.mockResolvedValue([{ id: requestId, assignedAgentId: "ralph", address: "locked@agentmail.to", status: "error" }]);
    await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("This address was created in AgentMail"));
    expect(container.textContent).not.toContain("Change AgentMail account");
    await click("Finish connecting");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({
      credentialConnectionId: "account", idempotencyKey: requestId, inboxId: "locked@agentmail.to",
    })));
  });

  it("recovers an old locked draft at the key choice, with a new setup identity", async () => {
    const originalRequestId = crypto.randomUUID();
    const draftKey = "paperclip.agentmail-setup:company:account:ralph";
    sessionStorage.setItem(draftKey, JSON.stringify({ connectionId: "account", agentId: "ralph", step: 1, requestId: originalRequestId }));
    mocks.inspect.mockImplementation(async (_company, id) => ({
      scope: { scope_type: id === "account" ? "inbox" : "organization" },
      inboxes: [{ inbox_id: "locked@agentmail.to" }], domains: [],
    }));
    mocks.connect.mockResolvedValue({ id: "replacement-account" });
    await mount();
    await vi.waitFor(() => expect(container.textContent).toContain("That key only connects"));
    await fill('input[type="password"]', "replacement-secret");
    expect(sessionStorage.getItem(draftKey)).not.toContain("replacement-secret");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-name")).not.toBeNull());
    const replacementRequest = mocks.connect.mock.calls[0][1];
    expect(replacementRequest).toMatchObject({ apiKey: "replacement-secret", agentIds: ["ralph"], grantKind: "organization", allAgents: false });
    expect(replacementRequest.idempotencyKey).not.toBe(originalRequestId);
    const nextSearch = container.querySelector('[data-testid="location"]')!.getAttribute("data-search")!;
    await act(async () => root.unmount());
    client.clear(); root = createRoot(container);
    await mount(false, true, "ralph", nextSearch.replace(/^\?/, "&"));
    await click("Create email address");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({
      credentialConnectionId: "replacement-account", idempotencyKey: replacementRequest.idempotencyKey, username: "ralph",
    })));
    expect(mocks.connect).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("preserves an account switch from a resumed unallocated draft across refresh (%s cleanup failure)", async cleanupFails => {
    const requestId = crypto.randomUUID();
    const draftKey = `paperclip.agentmail-setup:company:${requestId}:ralph`;
    sessionStorage.setItem(draftKey, JSON.stringify({
      connectionId: "account", agentId: "ralph", step: 1, requestId,
    }));
    mocks.listInboxes.mockResolvedValue([{ id: requestId, assignedAgentId: "ralph", address: null, status: "draft" }]);
    mocks.inspect.mockImplementation(async (_company, id) => ({ scope: { scope_type: id === "account" ? "inbox" : "organization" }, inboxes: [{ inbox_id: "locked@agentmail.to" }], domains: [] }));
    mocks.connect.mockResolvedValue({ id: "replacement" });
    mocks.control.mockImplementation(async () => {
      if (cleanupFails) throw new Error("Draft cleanup failed");
      mocks.listInboxes.mockResolvedValue([]);
    });
    await mount(true, true, "ralph", `&resume=${requestId}`);
    await vi.waitFor(() => expect(container.textContent).toContain("That key only connects"));
    await fill('input[type="password"]', "new-account-key");
    await click("Continue");
    await vi.waitFor(() => expect(mocks.control).toHaveBeenCalledWith(requestId, "remove"));
    if (cleanupFails) {
      await vi.waitFor(() => expect(container.textContent).toContain("Draft cleanup failed"));
      expect(mocks.connect).toHaveBeenCalledTimes(1);
      expect(JSON.parse(sessionStorage.getItem(draftKey)!).requestId).toBe(requestId);
      expect(container.querySelector('[data-testid="location"]')!.getAttribute("data-search")).toContain(`resume=${requestId}`);
      return;
    }
    await vi.waitFor(() => expect(container.querySelector("#email-name")).not.toBeNull());
    expect(mocks.connect.mock.invocationCallOrder[0]).toBeLessThan(mocks.control.mock.invocationCallOrder[0]);
    const nextSearch = container.querySelector('[data-testid="location"]')!.getAttribute("data-search")!;
    const nextId = new URLSearchParams(nextSearch).get("setupId")!;
    expect(nextId).not.toBe(requestId);
    expect(nextSearch).not.toContain("resume=");
    await act(async () => root.unmount());
    client.clear(); root = createRoot(container);
    await mount(false, true, "ralph", nextSearch.replace(/^\?/, "&"));
    await click("Create email address");
    expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({ credentialConnectionId: "replacement", idempotencyKey: nextId, username: "ralph" }));
  });

  it("checks the initial address and debounces edits while ignoring stale responses", async () => {
    await mount();
    vi.useFakeTimers();
    await click("Continue");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(container.textContent).toContain("Checking address");
    expect(button("Create email address").disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(mocks.checkAddress).toHaveBeenLastCalledWith("company", "account", { username: "ralph", domain: "agentmail.to" }, expect.any(AbortSignal));
    let resolveOld!: (result: unknown) => void;
    mocks.checkAddress.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    await fill("#email-name", "ralph-old");
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    const oldSignal = mocks.checkAddress.mock.calls[1][3] as AbortSignal;
    await fill("#email-name", "ralph-n");
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await fill("#email-name", "ralph-new");
    expect(oldSignal.aborted).toBe(true);
    await act(async () => { resolveOld({ address: "ralph-old@agentmail.to", status: "taken" }); });
    expect(container.querySelector("#email-address-error")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(349); });
    expect(mocks.checkAddress).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.checkAddress).toHaveBeenCalledTimes(3);
    expect(mocks.checkAddress.mock.calls[2][2].username).toBe("ralph-new");
    expect(container.textContent).toContain("confirms availability when you create");
    expect(container.textContent).not.toContain("is available");
  });

  it("offers clickable alternatives for a taken initial address and checks the selection", async () => {
    mocks.checkAddress.mockResolvedValueOnce({ address: "ralph@agentmail.to", status: "taken" });
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-address-error")?.textContent).toContain("already in use"));
    expect(button("Create email address").disabled).toBe(true);
    await click("ralph-agent@agentmail.to");
    expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("ralph-agent");
    expect(container.querySelector("#email-address-error")).toBeNull();
    await vi.waitFor(() => expect(mocks.checkAddress).toHaveBeenLastCalledWith("company", "account", { username: "ralph-agent", domain: "agentmail.to" }, expect.any(AbortSignal)));
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("defaults to a verified custom domain beside the name and preserves an explicit selection on reload", async () => {
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [], domains: [
      { domain_id: "pending", domain: "pending.example", status: "PENDING" },
      { domain_id: "custom", domain: "paperclip.example", status: "VERIFIED" },
    ] });
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>("#email-domain")?.value).toBe("paperclip.example"));
    expect(container.querySelector("#email-domain")?.closest("details")).toBeNull();
    expect(container.querySelector('option[value="pending.example"]')).toBeNull();
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>("#email-domain")!;
      select.value = "agentmail.to";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(() => expect(mocks.checkAddress).toHaveBeenLastCalledWith("company", "account", { username: "ralph", domain: "agentmail.to" }, expect.any(AbortSignal)));
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
    await mount();
    await vi.waitFor(() => expect(container.querySelector<HTMLSelectElement>("#email-domain")?.value).toBe("agentmail.to"));
  });

  it("shows lookup failures without mislabeling the address taken or blocking creation", async () => {
    mocks.checkAddress.mockRejectedValue(new Error("AgentMail is rate limiting requests."));
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.textContent).toContain("Could not check this address"));
    expect(container.querySelector("#email-address-error")).toBeNull();
    expect(button("Create email address").disabled).toBe(false);
  });
  it("restores saved progress after the company loads without overwriting the draft", async () => {
    const key = "paperclip.agentmail-setup:company:account:ralph";
    const requestId = crypto.randomUUID();
    const draft = JSON.stringify({ connectionId: "account", step: 1, agentId: "ralph", username: "ralph-team", requestId });
    sessionStorage.setItem(key, draft);
    mocks.companyId = null;
    await mount(true, false);
    expect(container.textContent).toContain("Loading email setup");
    expect(sessionStorage.getItem(key)).toBe(draft);
    mocks.companyId = "company";
    await mount();
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("ralph-team"));
    await click("Create email address");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({ username: "ralph-team", idempotencyKey: requestId })));
  });

  it("creates from the email field without a review step and keeps advanced settings collapsed", async () => {
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("ralph"));
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).not.toContain("Review email address");
    await click("Create email address");
    await vi.waitFor(() => expect(container.textContent).toContain("Your agent’s email is ready"));
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.putInstalls).not.toHaveBeenCalled();
    expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({ assignedAgentId: "ralph", username: "ralph", domain: "agentmail.to", receiveMode: "websocket" }));
    expect(sessionStorage.getItem("paperclip.agentmail-setup:company:account:ralph")).toBeNull();
  });

  it("shows a taken address beside the field, clears it on editing, and resumes the same request after reload", async () => {
    mocks.setup.mockRejectedValueOnce(new ApiError("This email address is already in use. Choose a different address.", 409, { code: "agentmail_address_taken" }));
    await mount();
    await click("Continue");
    await click("Create email address");
    await vi.waitFor(() => expect(container.querySelector("#email-name")?.getAttribute("aria-invalid")).toBe("true"));
    expect(container.querySelector("#email-address-error")?.textContent).toContain("already in use");
    expect(button("Create email address").disabled).toBe(true);
    const firstRequest = mocks.setup.mock.calls[0][1];
    await fill("#email-name", "");
    expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("");
    await fill("#email-name", "ralph-team");
    expect(container.querySelector("#email-address-error")).toBeNull();
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
    await mount();
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("ralph-team"));
    await click("Create email address");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledTimes(2));
    expect(mocks.setup.mock.calls[1][1]).toMatchObject({ username: "ralph-team", idempotencyKey: firstRequest.idempotencyKey });
  });

  it("asks for one API key with the direct link and saves the requested access defaults", async () => {
    await mount(false);
    expect(container.querySelector('a[href="https://console.agentmail.to/dashboard/api-keys"]')).not.toBeNull();
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    await fill('input[type="password"]', "private-test-key");
    expect(sessionStorage.getItem("paperclip.agentmail-setup:company:new:ralph")).not.toContain("private-test-key");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-name")).not.toBeNull());
    expect(mocks.connect).toHaveBeenCalledWith("company", expect.objectContaining({ apiKey: "private-test-key", grantKind: "organization", allAgents: false, agentIds: ["ralph"] }));
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(sessionStorage.getItem("paperclip.agentmail-setup:company:new:ralph")).not.toContain("private-test-key");
  });

  it("flags an address already present in the connected account before submission", async () => {
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [{ inbox_id: "ralph@agentmail.to" }], domains: [] });
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-address-error")?.textContent).toContain("already in use"));
    expect(button("Create email address").disabled).toBe(true);
    expect(mocks.setup).not.toHaveBeenCalled();
    await click("Use an existing inbox");
    expect(container.querySelector("#email-existing")).not.toBeNull();
  });

  it("does not restore another requested agent's new-account draft", async () => {
    sessionStorage.setItem("paperclip.agentmail-setup:company:new:ralph", JSON.stringify({
      agentId: "ralph", step: 1, connectionId: "ralph-account", username: "ralph", requestId: crypto.randomUUID(),
    }));
    mocks.listAgents.mockResolvedValue([
      { id: "ralph", name: "Ralph", status: "idle", permissions: {} },
      { id: "support", name: "Support", status: "idle", permissions: {} },
    ]);
    await mount(false, true, "support");
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    await fill('input[type="password"]', "new-key");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("support"));
    expect(mocks.connect).toHaveBeenCalledWith("company", expect.objectContaining({ agentIds: ["support"] }));
    expect(mocks.inspect).not.toHaveBeenCalledWith("company", "ralph-account");
  });

  it("submits the final agent with the original setup request after changing agents and reloading", async () => {
    mocks.listAgents.mockResolvedValue([
      { id: "ralph", name: "Ralph", status: "idle", permissions: {} },
      { id: "support", name: "Support", status: "idle", permissions: {} },
    ]);
    await mount(false);
    await fill('input[type="password"]', "new-key");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-name")).not.toBeNull());
    await click("Back");
    await act(async () => container.querySelector<HTMLButtonElement>('#email-agent')!.click());
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Select Support"]')).not.toBeNull());
    await act(async () => document.querySelector<HTMLElement>('[aria-label="Select Support"]')!.click());
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
    await mount(false, false);
    await vi.waitFor(() => expect(button("Continue").disabled).toBe(false));
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email-name")?.value).toBe("support"));
    // Access is updated by email setup, without a separate agent-config permission.
    expect(mocks.putInstalls).not.toHaveBeenCalled();
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await click("Create email address");
    await vi.waitFor(() => expect(mocks.setup).toHaveBeenCalledWith("company", expect.objectContaining({ assignedAgentId: "support", idempotencyKey: mocks.connect.mock.calls[0][1].idempotencyKey })));
  });

  it.each(["new", "existing"])("resumes its allocated %s inbox after a provider failure and reload", async addressMode => {
    const requestId = crypto.randomUUID();
    sessionStorage.setItem("paperclip.agentmail-setup:company:account:ralph", JSON.stringify({
      connectionId: "account", agentId: "ralph", step: 1, username: "ralph", inboxId: "ralph@agentmail.to", addressMode, requestId,
    }));
    const endpoint = { id: requestId, assignedAgentId: "ralph", address: "ralph@agentmail.to", status: "draft" };
    // Creation succeeds before a later runtime-key request fails.
    mocks.setup.mockImplementationOnce(async () => {
      mocks.listInboxes.mockResolvedValue([endpoint]);
      mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [{ inbox_id: endpoint.address }], domains: [] });
      throw new ApiError("Could not create runtime key", 502, {});
    });
    await mount();
    await vi.waitFor(() => expect(button(addressMode === "new" ? "Create email address" : "Connect email address").disabled).toBe(false));
    await click(addressMode === "new" ? "Create email address" : "Connect email address");
    await vi.waitFor(() => expect(container.textContent).toContain("Could not create runtime key"));
    await vi.waitFor(() => expect(button("Finish connecting").disabled).toBe(false));
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
    await mount();
    await vi.waitFor(() => expect(button("Finish connecting").disabled).toBe(false));
    expect(container.querySelector("#email-address-error")).toBeNull();
    expect(container.textContent).toContain(endpoint.address);
    expect(container.querySelector("#email-name")).toBeNull();
    expect(container.querySelector("#email-existing")).toBeNull();
    await click("Back");
    expect(container.querySelector<HTMLButtonElement>('#email-agent')?.disabled).toBe(true);
    await click("Continue");
    await vi.waitFor(() => expect(button("Finish connecting").disabled).toBe(false));
    await click("Finish connecting");
    await vi.waitFor(() => expect(container.textContent).toContain("Your agent’s email is ready"));
    expect(mocks.setup).toHaveBeenLastCalledWith("company", expect.objectContaining({ inboxId: endpoint.address, assignedAgentId: "ralph", idempotencyKey: requestId }));
  });

  it("lets a failed setup choose another address without deleting or reusing its allocated inbox", async () => {
    const requestId = crypto.randomUUID();
    const draftKey = `paperclip.agentmail-setup:company:${requestId}:ralph`;
    sessionStorage.setItem(draftKey, JSON.stringify({ connectionId: "account", agentId: "ralph", step: 1, requestId }));
    mocks.listInboxes.mockResolvedValue([{ id: requestId, assignedAgentId: "ralph", address: "reserved@paperclip.example", status: "draft" }]);
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [{ inbox_id: "reserved@paperclip.example" }], domains: [{ domain_id: "custom", domain: "paperclip.example", status: "VERIFIED" }] });
    await mount(true, true, "ralph", `&resume=${requestId}`);
    await vi.waitFor(() => expect(button("Finish connecting").disabled).toBe(false));
    await click("Choose a different address");
    expect(container.querySelector<HTMLInputElement>("#email-name")?.readOnly).toBe(false);
    expect(container.querySelector<HTMLSelectElement>("#email-domain")?.disabled).toBe(false);
    expect(container.querySelector<HTMLSelectElement>("#email-domain")?.value).toBe("paperclip.example");
    await fill("#email-name", "another-address");
    const nextSearch = container.querySelector('[data-testid="location"]')!.getAttribute("data-search")!;
    const nextRequestId = new URLSearchParams(nextSearch).get("setupId")!;
    expect(nextRequestId).not.toBe(requestId);
    expect(JSON.parse(sessionStorage.getItem(draftKey)!).requestId).toBe(requestId);
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
    await mount(true, true, "ralph", `&setupId=${nextRequestId}`);
    await click("Create email address");
    expect(mocks.setup).toHaveBeenLastCalledWith("company", expect.objectContaining({
      username: "another-address", domain: "paperclip.example", idempotencyKey: nextRequestId,
    }));
    expect(mocks.control).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    client.clear();
    root = createRoot(container);
    await mount(true, true, "ralph", `&resume=${requestId}`);
    await vi.waitFor(() => expect(button("Finish connecting").disabled).toBe(false));
    await click("Finish connecting");
    expect(mocks.setup).toHaveBeenLastCalledWith("company", expect.objectContaining({
      inboxId: "reserved@paperclip.example", idempotencyKey: requestId,
    }));
  });

  it("does not treat another setup's allocated address as its own retry", async () => {
    mocks.inspect.mockResolvedValue({ scope: { scope_type: "organization" }, inboxes: [{ inbox_id: "ralph@agentmail.to" }], domains: [] });
    mocks.listInboxes.mockResolvedValue([{ id: crypto.randomUUID(), assignedAgentId: "ralph", address: "ralph@agentmail.to", status: "draft" }]);
    await mount();
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-address-error")?.textContent).toContain("already in use"));
    expect(button("Create email address").disabled).toBe(true);
    await click("Use an existing inbox");
    const option = container.querySelector<HTMLOptionElement>('option[value="ralph@agentmail.to"]');
    expect(option?.disabled).toBe(true);
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("retries loading setup progress without losing the entered key or reloading", async () => {
    mocks.listInboxes.mockRejectedValueOnce(new Error("Service unavailable"));
    await mount(false);
    await fill('input[type="password"]', "private-test-key");
    await vi.waitFor(() => expect(container.textContent).toContain("Could not load email setup progress"));
    expect(button("Continue").disabled).toBe(true);
    await click("Retry loading inboxes");
    await vi.waitFor(() => expect(button("Continue").disabled).toBe(false));
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("private-test-key");
    await click("Continue");
    await vi.waitFor(() => expect(container.querySelector("#email-name")).not.toBeNull());
    expect(mocks.listInboxes).toHaveBeenCalledTimes(2);
    expect(mocks.putInstalls).not.toHaveBeenCalled();
  });

  it("preserves the existing low-trust work-boundary gate", async () => {
    mocks.listAgents.mockResolvedValue([{ id: "ralph", name: "Ralph", status: "idle", permissions: { trustPreset: "low_trust_review" } }]);
    await mount();
    expect(container.textContent).toContain("needs a work boundary");
    expect(button("Continue").disabled).toBe(true);
    expect(mocks.setup).not.toHaveBeenCalled();
  });
});
