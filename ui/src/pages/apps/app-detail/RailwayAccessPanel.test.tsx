// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionGrantsResponse, ToolConnection } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RailwayAccessPanel } from "./RailwayAccessPanel";
const { configure } = vi.hoisted(() => ({ configure: vi.fn(async () => null) }));
vi.mock("@/api/tools", () => ({ toolsApi: { configureRailwaySsh: configure } }));
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root?.unmount()); container?.remove(); vi.clearAllMocks(); });
async function render(status: string, canConfigure = true, owner = "operator") {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const connection = { id: "connection", status: "disabled", config: { railwaySsh: { grantId: "grant", publicKey: "ssh-ed25519 public-fixture", knownHosts: "", enabled: false } } } as unknown as ToolConnection;
  const grants = { currentUserId: "operator", capabilities: { canConfigure }, grants: [{ id: "grant", kind: "user", subjectUserId: owner, status }] } as unknown as ConnectionGrantsResponse;
  await act(async () => root!.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><RailwayAccessPanel connection={connection} grants={grants} /></QueryClientProvider>));
}
describe("Railway container setup", () => {
  it("allows an owner to remove a revoked key without reauthorizing", async () => {
    await render("revoked");
    const remove = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Remove container key")!;
    const enable = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Enable container access")!;
    expect(remove.disabled).toBe(false);
    expect(enable.disabled).toBe(true);
    await act(async () => remove.click());
    expect(configure).toHaveBeenCalledWith("connection", { action: "remove", grantId: "grant" });
  });
  it("does not show credential controls for another personal owner", async () => {
    await render("active", true, "another-user");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
  it("requires connection configuration access for key changes", async () => {
    await render("revoked", false);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});
