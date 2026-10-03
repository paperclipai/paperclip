// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { McpConnectPage } from "./McpConnect";

const route = vi.hoisted(() => ({ id: "request-one", companyId: null as string | null, unavailable: false, canWrite: true, requestedWrite: true }));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ id: route.id }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: ({ companyName, logoUrl }: { companyName: string; logoUrl?: string | null }) => <img alt={`${companyName} logo`} src={logoUrl ?? undefined} />,
}));
vi.mock("../api/client", () => ({ api: {
  get: vi.fn(async () => ({
    id: route.id, clientName: "Assistant", redirectOrigin: "https://assistant.example.test",
    requestedWrite: route.requestedWrite, offlineAccess: true, requiresSignIn: false, requestedCompanyId: route.companyId,
    companies: route.unavailable ? [] : [
      { id: route.companyId ?? "company-one", name: "Acme Research", logoUrl: "/api/assets/acme-logo/content", canWrite: route.canWrite },
      ...(!route.companyId ? [{ id: "company-two", name: "Design Partners", logoUrl: null, canWrite: true }] : []),
    ], setupUrl: null,
  })),
  post: vi.fn(() => new Promise(() => {})),
} }));

beforeEach(() => {
  Object.assign(route, { id: "request-one", companyId: null, unavailable: false, canWrite: true, requestedWrite: true });
  vi.clearAllMocks();
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => flushSync(() => root.render(<QueryClientProvider client={client}><McpConnectPage /></QueryClientProvider>));
  render();
  return {
    client, container, render,
    connect: () => Array.from(container.querySelectorAll("button")).find(item => item.textContent === "Connect organization")!,
    checkbox: () => container.querySelector('[role="checkbox"]') as HTMLButtonElement,
    cleanup: () => { flushSync(() => root.unmount()); container.remove(); client.clear(); },
  };
}

it("identifies the receiving app and registered callback origin before approval", async () => {
  route.companyId = "company-one";
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.textContent).toContain("Access for Assistant · https://assistant.example.test"));
    expect(page.connect().disabled).toBe(false);
    // Registration metadata is text, never an executable link or verified-app badge.
    expect(page.container.querySelector('a[href="https://assistant.example.test"]')).toBeNull();
  } finally { page.cleanup(); }
});

it("defaults eligible writes on and preserves opt-out across organization changes and refetch", async () => {
  const page = setup();
  try {
    await vi.waitFor(() => expect(page.container.querySelector('input[type="radio"]')).not.toBeNull());
    expect(page.connect().disabled).toBe(true);
    expect(page.checkbox().getAttribute("aria-checked")).toBe("false");
    flushSync(() => (page.container.querySelector('input[type="radio"]') as HTMLInputElement).click());
    expect(page.checkbox().getAttribute("aria-checked")).toBe("true");
    flushSync(() => page.checkbox().click());
    flushSync(() => (page.container.querySelector('input[value="company-two"]') as HTMLInputElement).click());
    expect(page.checkbox().getAttribute("aria-checked")).toBe("false");
    flushSync(() => (page.container.querySelector('input[value="company-one"]') as HTMLInputElement).click());
    expect(page.checkbox().getAttribute("aria-checked")).toBe("false");
    await page.client.invalidateQueries({ queryKey: ["mcp-request", route.id] });
    expect(page.checkbox().getAttribute("aria-checked")).toBe("false");
    flushSync(() => page.connect().click());
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/mcp/requests/request-one/consent", { decision: "approve", companyId: "company-one", allowWrites: false }));
    route.id = "request-two";
    page.render();
    await vi.waitFor(() => expect(page.container.querySelector('input[type="radio"]')).not.toBeNull());
    expect((page.container.querySelector('input[type="radio"]') as HTMLInputElement).checked).toBe(false);
    expect(page.connect().disabled).toBe(true);
    flushSync(() => (page.container.querySelector('input[type="radio"]') as HTMLInputElement).click());
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
    await vi.waitFor(() => expect(api.post).toHaveBeenCalledWith("/mcp/requests/request-one/consent", { decision: "approve", companyId: "company-one", allowWrites }));
  } finally { page.cleanup(); }
});
