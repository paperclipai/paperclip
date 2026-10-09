// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { McpConnectPage, McpDevicePage } from "./McpConnect";

const route = vi.hoisted(() => ({ id: "request-one", companyId: null as string | null, unavailable: false, canWrite: true, requestedWrite: true, requestedConfigure: false, agentConnection: false, requiresSignIn: false, clientName: "Assistant", clientOrigin: null as string | null, setupUrl: "https://my.paperclip.app/orgs/new", reverseCompanies: false, hideFirst: false }));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ id: route.id }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: ({ companyName, logoUrl }: { companyName: string; logoUrl?: string | null }) => <img alt={`${companyName} logo`} src={logoUrl ?? undefined} />,
}));
vi.mock("../api/client", () => ({ api: {
  get: vi.fn(async () => ({
    id: route.id, clientName: route.clientName, clientOrigin: route.clientOrigin, redirectOrigin: "https://assistant.example.test",
    requestedWrite: route.requestedWrite, requestedConfigure: route.requestedConfigure, agentConnection: route.agentConnection, offlineAccess: true, requiresSignIn: route.requiresSignIn, requestedCompanyId: route.companyId,
    companies: route.unavailable ? [] : [
      { id: route.companyId ?? "company-one", name: "Acme Research", logoUrl: "/api/assets/acme-logo/content", canWrite: route.canWrite },
      ...(!route.companyId ? [{ id: "company-two", name: "Design Partners", logoUrl: null, canWrite: true }] : []),
    ].filter(item => !route.hideFirst || item.id !== "company-one").sort((a, b) => route.reverseCompanies ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id)), setupUrl: route.setupUrl,
  })),
  post: vi.fn(() => new Promise(() => {})),
} }));

beforeEach(() => {
  Object.assign(route, { id: "request-one", companyId: null, unavailable: false, canWrite: true, requestedWrite: true, requestedConfigure: false, agentConnection: false, requiresSignIn: false, clientName: "Assistant", clientOrigin: null, setupUrl: "https://my.paperclip.app/orgs/new", reverseCompanies: false, hideFirst: false });
  vi.clearAllMocks();
});

function setup(device = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => flushSync(() => root.render(<QueryClientProvider client={client}>{device ? <McpDevicePage initialCode="MIST-YPED" /> : <McpConnectPage />}</QueryClientProvider>));
  render();
  return {
    client, container, render,
    connect: () => Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Connect organization")!,
    checkbox: () => container.querySelector('[role="checkbox"]') as HTMLButtonElement,
    cleanup: () => { flushSync(() => root.unmount()); container.remove(); client.clear(); },
  };
}

it("lets a person correct an invalid device code without reloading", async () => {
  vi.mocked(api.get).mockRejectedValueOnce(new Error("Invalid code"));
  const page = setup(true);
  try {
    await vi.waitFor(() => expect(page.container.textContent).toContain("Invalid code"));
    const edit = Array.from(page.container.querySelectorAll("button")).find(item => item.textContent === "Enter a different code")!;
    flushSync(() => edit.click());
    expect(page.container.querySelector<HTMLInputElement>("#device-code")?.value).toBe("MIST-YPED");
    expect(page.container.querySelector("form")).not.toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  } finally { page.cleanup(); }
});

it("lets Dot use the operator pairing capability without signing into a board account", async () => {
  Object.assign(route, { agentConnection: true, requiresSignIn: true });
  vi.mocked(api.post).mockImplementationOnce(async () => ({ company: { id: "company-one", name: "Dot Test Drive" }, agent: { id: "agent-one", name: "Dot" }, permissions: "Assigned work only", accessDuration: "Ongoing until revoked", pairingExpiresAt: new Date(Date.now() + 60000).toISOString() }) as never);
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.querySelector("#dot-pairing-code")).not.toBeNull());
    const input = page.container.querySelector<HTMLInputElement>("#dot-pairing-code")!;
    expect(input.type).toBe("password");
    const connect = Array.from(page.container.querySelectorAll("button")).find(button => button.textContent === "Connect Dot with pairing code")!;
    expect(connect.disabled).toBe(true);
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "x".repeat(32));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await vi.waitFor(() => expect(page.container.textContent).toContain("Dot Test Drive"));
    expect(page.container.textContent).toContain("Assigned work only");
    expect(page.container.textContent).toContain("Ongoing until revoked");
    expect(connect.disabled).toBe(false);
    flushSync(() => connect.click());
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/mcp/requests/request-one/dot-pairing", { pairingCode: "x".repeat(32) }));
  } finally { page.cleanup(); }
});

it("keeps approval disabled while replacing a code and ignores an older preview response", async () => {
  Object.assign(route, { agentConnection: true, requiresSignIn: true });
  let resolveOld!: (value: unknown) => void;
  let resolveCurrent!: (value: unknown) => void;
  vi.mocked(api.post).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }) as never)
    .mockImplementationOnce(() => new Promise(resolve => { resolveCurrent = resolve; }) as never);
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.querySelector("#dot-pairing-code")).not.toBeNull());
    const input = page.container.querySelector<HTMLInputElement>("#dot-pairing-code")!;
    const connect = Array.from(page.container.querySelectorAll("button")).find(button => button.textContent === "Connect Dot with pairing code")!;
    const enter = (value: string) => flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    enter("x".repeat(32));
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    enter("y".repeat(32));
    expect(connect.disabled).toBe(true);
    await vi.waitFor(() => expect(resolveCurrent).toBeTypeOf("function"));
    resolveCurrent({ company: { id: "current", name: "Current company" }, agent: { id: "agent", name: "Dot" }, permissions: "Assigned work", accessDuration: "Until revoked" });
    await vi.waitFor(() => expect(connect.disabled).toBe(false));
    resolveOld({ company: { id: "old", name: "Old company" }, agent: { id: "other", name: "Other agent" }, permissions: "Other work", accessDuration: "Until revoked" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(page.container.textContent).toContain("Current company");
    expect(page.container.textContent).not.toContain("Old company");
    enter("");
    expect(connect.disabled).toBe(true);
    expect(page.container.textContent).not.toContain("Current company");
  } finally { page.cleanup(); }
});

it("does not offer Dot pairing-code approval on a personal connection", async () => {
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.querySelector("h1")).not.toBeNull());
    expect(page.container.querySelector("#dot-pairing-code")).toBeNull();
  } finally { page.cleanup(); }
});

it("identifies the receiving app and registered callback origin before approval", async () => {
  route.companyId = "company-one";
  route.clientName = "Claude";
  route.clientOrigin = "https://claude.ai";
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.querySelector("h1")?.textContent).toBe("Connect Claude to Paperclip"));
    expect(page.container.textContent).toContain("https://claude.ai");
    expect(page.container.textContent).toContain("https://assistant.example.test");
    expect(page.container.querySelector('img[src^="https://assistant.example.test"]')).toBeNull();
    expect(page.container.textContent).not.toContain("Access for");
    expect(page.container.querySelector('img[src="/brands/claude-color.svg"]')).not.toBeNull();
    expect(page.container.querySelector('a[href="https://my.paperclip.app/orgs/new"]')).toBeNull();
    expect(page.connect().disabled).toBe(false);
    // Registration metadata is text, never an executable link or verified-app badge.
    expect(page.container.querySelector('a[href="https://assistant.example.test"]')).toBeNull();
  } finally { page.cleanup(); }
});

it("defaults eligible writes on and preserves opt-out across organization changes and refetch", async () => {
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.querySelector('input[type="radio"]')).not.toBeNull());
    expect(page.connect().disabled).toBe(false);
    expect((page.container.querySelector('input[value="company-one"]') as HTMLInputElement).checked).toBe(true);
    expect(page.checkbox().getAttribute("aria-checked")).toBe("true");
    expect(api.post).not.toHaveBeenCalled();
    expect(page.container.querySelector("h1")?.textContent).toBe("Connect your assistant to Paperclip");
    flushSync(() => page.checkbox().click());
    flushSync(() => (page.container.querySelector('input[value="company-two"]') as HTMLInputElement).click());
    expect(page.checkbox().getAttribute("aria-checked")).toBe("false");
    flushSync(() => (page.container.querySelector('input[value="company-one"]') as HTMLInputElement).click());
    expect(page.checkbox().getAttribute("aria-checked")).toBe("false");
    await page.client.invalidateQueries({ queryKey: ["mcp-request", route.id] });
    expect(page.checkbox().getAttribute("aria-checked")).toBe("false");
    flushSync(() => page.connect().click());
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/mcp/requests/request-one/consent", { decision: "approve", companyId: "company-one", allowWrites: false, allowConfiguration: false }));
    route.id = "request-two";
    page.render();
    await vi.waitFor(() => expect(page.container.querySelector('input[type="radio"]')).not.toBeNull());
    expect((page.container.querySelector('input[type="radio"]') as HTMLInputElement).checked).toBe(true);
    expect(page.connect().disabled).toBe(false);
    expect(page.checkbox().getAttribute("aria-checked")).toBe("true");
  } finally { page.cleanup(); }
});

it("keeps hosted organization identity fixed and defaults each new request to eligible write access", async () => {
  route.companyId = "company-one";
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.textContent).toContain("Acme Research"));
    expect(page.container.querySelector('input[type="radio"]')).toBeNull();
    expect(page.container.querySelector('img[alt="Acme Research logo"]')?.getAttribute("src")).toBe("/api/assets/acme-logo/content");
    expect(page.checkbox().getAttribute("aria-checked")).toBe("true");
    flushSync(() => page.checkbox().click());
    expect(page.checkbox().getAttribute("aria-checked")).toBe("false");
    route.id = "hosted-two";
    route.companyId = "company-two";
    page.render();
    await vi.waitFor(() => expect(page.container.textContent).toContain("Acme Research"));
    expect(page.checkbox().getAttribute("aria-checked")).toBe("true");
    route.canWrite = false;
    await page.client.invalidateQueries({ queryKey: ["mcp-request", route.id] });
    await vi.waitFor(() => expect(page.checkbox().disabled).toBe(true));
    expect(page.checkbox().getAttribute("aria-checked")).toBe("false");
    // Losing membership never turns a fixed hosted organization into a picker.
    route.unavailable = true;
    await page.client.invalidateQueries({ queryKey: ["mcp-request", route.id] });
    await vi.waitFor(() => expect(page.container.textContent).toContain("selected organization is no longer available"));
    expect(page.container.querySelector('input[type="radio"]')).toBeNull();
    expect(page.connect().disabled).toBe(true);
    expect(Array.from(page.container.querySelectorAll("button")).find(item => item.textContent === "Cancel")!.disabled).toBe(false);
  } finally { page.cleanup(); }
});

it.each([
  { requestedWrite: true, canWrite: true, allowWrites: true },
  { requestedWrite: true, canWrite: false, allowWrites: false },
  { requestedWrite: false, canWrite: true, allowWrites: false },
])("submits only allowed requested access: %j", async ({ requestedWrite, canWrite, allowWrites }) => {
  Object.assign(route, { companyId: "company-one", requestedWrite, canWrite });
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.textContent).toContain("Acme Research"));
    if (requestedWrite) {
      expect(page.checkbox().getAttribute("aria-checked")).toBe(String(allowWrites));
      expect(page.checkbox().disabled).toBe(!canWrite);
    } else expect(page.checkbox()).toBeNull();
    flushSync(() => page.connect().click());
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/mcp/requests/request-one/consent", { decision: "approve", companyId: "company-one", allowWrites, allowConfiguration: false }));
  } finally { page.cleanup(); }
});

it("pins the default organization across refetches and never falls back after it disappears", async () => {
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.querySelector<HTMLInputElement>('input[value="company-one"]')?.checked).toBe(true));
    route.reverseCompanies = true;
    await page.client.invalidateQueries({ queryKey: ["mcp-request", route.id] });
    await vi.waitFor(() => expect(page.container.querySelector('input[type="radio"]')?.getAttribute("value")).toBe("company-two"));
    expect(page.container.querySelector<HTMLInputElement>('input[value="company-one"]')?.checked).toBe(true);
    route.hideFirst = true;
    await page.client.invalidateQueries({ queryKey: ["mcp-request", route.id] });
    await vi.waitFor(() => expect(page.connect().disabled).toBe(true));
    expect(page.container.querySelector<HTMLInputElement>('input[value="company-two"]')?.checked).toBe(false);
    expect(page.checkbox().getAttribute("aria-checked")).toBe("false");
    expect(page.container.textContent).not.toContain("Create a hosted organization");
    expect(api.post).not.toHaveBeenCalled();
  } finally { page.cleanup(); }
});

it("denies without granting default work or configuration access", async () => {
  route.requestedConfigure = true;
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.checkbox()?.getAttribute("aria-checked")).toBe("true"));
    flushSync(() => Array.from(page.container.querySelectorAll("button")).find(button => button.textContent === "Cancel")!.click());
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/mcp/requests/request-one/consent", { decision: "deny", companyId: "company-one", allowWrites: false, allowConfiguration: false }));
  } finally { page.cleanup(); }
});

it.each([false, true])("explains Dot agent consent and requires an operator in both browser and device flows (device=%s)", async device => {
  Object.assign(route, { companyId: "company-one", agentConnection: true, canWrite: false });
  const page = setup(device);
  const connect = () => Array.from(page.container.querySelectorAll("button")).find(button => button.textContent === "Connect Dot agent")!;
  try {
    await vi.waitFor(() => expect(page.container.textContent).toContain("Connect Dot as a Paperclip agent"));
    expect(page.container.textContent).not.toContain("Read all of your Paperclip data");
    expect(page.checkbox()).toBeNull();
    expect(connect().disabled).toBe(true);
    route.canWrite = true;
    await page.client.invalidateQueries({ queryKey: [device ? "mcp-device" : "mcp-request", device ? "MIST-YPED" : route.id] });
    await vi.waitFor(() => expect(connect().disabled).toBe(false));
    flushSync(() => connect().click());
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith(device ? "/mcp/device/consent" : "/mcp/requests/request-one/consent", {
      decision: "approve", companyId: "company-one", allowWrites: false, allowConfiguration: false, ...(device ? { userCode: "MIST-YPED" } : {}),
    }));
  } finally { page.cleanup(); }
});


it("does not fetch client-selected favicons or trust names for branding", async () => {
  route.clientName = "Claude";
  route.clientOrigin = "https://unrecognized.example.test";
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.textContent).toContain(route.clientOrigin));
    expect(page.container.textContent).toContain("https://assistant.example.test");
    expect(page.container.querySelector('img[src^="https://"]')).toBeNull();
    expect(page.container.querySelector('img[src="/brands/claude-color.svg"]')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  } finally { page.cleanup(); }
});


it.each([
  { device: false, optOut: false },
  { device: false, optOut: true },
  { device: true, optOut: false },
  { device: true, optOut: true },
])("uses one write choice for requested work and configuration access: %j", async ({ device, optOut }) => {
  route.requestedConfigure = true;
  const page = setup(device);
  try {
    await vi.waitFor(() => expect(page.checkbox()?.getAttribute("aria-checked")).toBe("true"));
    expect(page.container.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
    expect(page.container.textContent).toContain("Write all of your Paperclip data");
    expect(page.container.textContent).not.toContain("Allow configuring");
    if (optOut) flushSync(() => page.checkbox().click());
    flushSync(() => page.connect().click());
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith(
      device ? "/mcp/device/consent" : "/mcp/requests/request-one/consent",
      { decision: "approve", companyId: "company-one", allowWrites: !optOut, allowConfiguration: !optOut, ...(device ? { userCode: "MIST-YPED" } : {}) },
    ));
  } finally { page.cleanup(); }
});

it.each([
  { requestedWrite: false, canWrite: true, enabled: true },
  { requestedWrite: true, canWrite: false, enabled: false },
])("keeps one write choice for configuration-only requests and viewer restrictions: %j", async ({ requestedWrite, canWrite, enabled }) => {
  Object.assign(route, { requestedWrite, requestedConfigure: true, canWrite });
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.checkbox()?.getAttribute("aria-checked")).toBe(String(enabled)));
    expect(page.container.querySelectorAll('[role="checkbox"]')).toHaveLength(1);
    expect(page.checkbox().disabled).toBe(!canWrite);
    flushSync(() => page.connect().click());
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowWrites: false, allowConfiguration: enabled })));
  } finally { page.cleanup(); }
});
