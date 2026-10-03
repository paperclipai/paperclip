// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { McpConnectPage } from "./McpConnect";

const route = vi.hoisted(() => ({ id: "request-one" }));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ id: route.id }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("../api/client", () => ({ api: { get: vi.fn(async () => ({
  id: route.id, clientName: "Assistant", redirectOrigin: "https://assistant.example.test",
  requestedWrite: true, offlineAccess: true, requiresSignIn: false,
  companies: [{ id: "company-one", name: "Team", canWrite: true }], setupUrl: null,
})) } }));

it("requires a new team selection and write consent when the request changes", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => flushSync(() => root.render(<QueryClientProvider client={client}><McpConnectPage /></QueryClientProvider>));
  const button = () => Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "Connect team")!;
  try {
    render();
    await vi.waitFor(() => expect(container.querySelector('input[type="radio"]')).not.toBeNull());
    expect(button().disabled).toBe(true);
    flushSync(() => (container.querySelector('input[type="radio"]') as HTMLInputElement).click());
    flushSync(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
    expect(button().disabled).toBe(false);
    route.id = "request-two";
    render();
    await vi.waitFor(() => expect(container.querySelector('input[type="radio"]')).not.toBeNull());
    expect((container.querySelector('input[type="radio"]') as HTMLInputElement).checked).toBe(false);
    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
    expect(button().disabled).toBe(true);
  } finally {
    flushSync(() => root.unmount());
    container.remove();
    client.clear();
  }
});
