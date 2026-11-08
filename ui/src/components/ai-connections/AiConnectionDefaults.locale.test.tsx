// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiManagedConnectionSummary, ConnectionGrant } from "@paperclipai/shared";
import { i18n } from "@/i18n";
import { aiConnectionsApi } from "@/api/ai-connections";
import { ToastProvider } from "@/context/ToastContext";
import { ToastViewport } from "@/components/ToastViewport";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AiConnectionAccountControls } from "./AiConnectionAccountControls";
import { useAiConnectionDefaults } from "./useAiConnectionDefaults";
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { list: vi.fn(), setDefault: vi.fn() } }));
vi.mock("@/pages/apps/app-detail/IdentitiesSection", () => ({ RevokeGrantDialog: () => null }));
vi.mock("@/lib/router", () => ({ useNavigate: () => vi.fn() }));
const account: AiManagedConnectionSummary = { id: "connection", grantId: "grant", companyId: "company", provider: "anthropic", method: "subscription", name: "Custom <Account>", ownership: "personal", ownerUserId: "user", isDefault: false, canSetDefault: true, status: "connected" };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let current: AiManagedConnectionSummary;
function Harness() {
  const defaults = useAiConnectionDefaults("company", { userId: "user", settled: true });
  return <><button onClick={() => defaults.choose(account)}>Choose</button><ToastViewport /></>;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0)); vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  await i18n.changeLanguage("en"); current = { ...account };
  vi.mocked(aiConnectionsApi.list).mockReset().mockImplementation(async () => ({ currentUserId: "user", connections: [current], pools: [], canManageConnections: true }));
  vi.mocked(aiConnectionsApi.setDefault).mockReset().mockImplementation(async () => { current = { ...current, isDefault: true }; return undefined as never; });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove(); await i18n.changeLanguage("en"); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(20); }); }
it.each(["saved", "changed", "error", "unavailable"] as const)("retranslates the mounted %s default toast without repeating mutations", async mode => {
  if (mode === "changed") vi.mocked(aiConnectionsApi.setDefault).mockResolvedValue(undefined as never);
  if (mode === "error") vi.mocked(aiConnectionsApi.setDefault).mockRejectedValue(new Error("Vendor diagnostic: tenant.example refused selection"));
  if (mode === "unavailable") current = { ...current, canSetDefault: false };
  await act(async () => root.render(<QueryClientProvider client={client}><ToastProvider><Harness /></ToastProvider></QueryClientProvider>)); await flush();
  await act(async () => host.querySelector("button")!.click()); await flush(); await flush();
  const english = host.textContent;
  expect(english).toContain(mode === "saved" ? "Custom <Account> is now your Claude default" : mode === "changed" ? "Your Claude default was updated" : "Couldn’t change your Claude default");
  const mutations = vi.mocked(aiConnectionsApi.setDefault).mock.calls.length;
  const reads = vi.mocked(aiConnectionsApi.list).mock.calls.length;
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(host.textContent).toContain(mode === "saved" ? "Custom <Account> 现已成为你的 Claude 默认账号" : mode === "changed" ? "你的 Claude 默认账号已更新" : "无法更改你的 Claude 默认账号");
  if (mode === "error") expect(host.textContent).toContain("Vendor diagnostic: tenant.example refused selection");
  if (mode === "unavailable") expect(host.textContent).toContain("此账号无法用作默认账号");
  await act(async () => { await i18n.changeLanguage("en"); }); expect(host.textContent).toBe(english);
  expect(aiConnectionsApi.setDefault).toHaveBeenCalledTimes(mutations); expect(aiConnectionsApi.list).toHaveBeenCalledTimes(reads);
  expect(mutations).toBe(mode === "unavailable" ? 0 : 1);
});
it.each(["ready", "pending", "unavailable", "disconnected", "forbidden", "other-owner", "routed", "default"] as const)("preserves %s default controls across locale changes", async mode => {
  const value = { ...account, ...(mode === "unavailable" ? { unavailableReason: "vendor_reason" } : {}), ...(mode === "disconnected" ? { status: "revoked" as const } : {}), ...(mode === "forbidden" ? { canSetDefault: false } : {}), ...(mode === "other-owner" ? { ownerUserId: "other" } : {}), ...(mode === "routed" ? { routing: { kind: "openrouter" as const } as AiManagedConnectionSummary["routing"] } : {}), isDefault: mode === "default" };
  const choose = vi.fn();
  await act(async () => root.render(<TooltipProvider><AiConnectionAccountControls account={value} grant={{ capabilities: {} } as ConnectionGrant} currentUserId="user" defaultPending={mode === "pending"} onMakeDefault={choose} onReconnect={vi.fn()} onRevoke={vi.fn()} /></TooltipProvider>));
  const button = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.includes("Set as default"));
  if (["forbidden", "other-owner", "routed", "default"].includes(mode)) expect(button).toBeUndefined();
  else { expect(button?.disabled).toBe(mode !== "ready"); await act(async () => button!.click()); expect(choose).toHaveBeenCalledTimes(mode === "ready" ? 1 : 0); }
  await act(async () => { await i18n.changeLanguage("zh-CN"); });
  expect(host.querySelector("section")?.getAttribute("aria-label")).not.toBe("AI account settings");
  if (mode === "ready") expect(host.textContent).toContain("设为 Claude 的默认账号");
  if (mode === "default") expect(host.querySelector("button")?.getAttribute("aria-label")).toBe("你在 Claude 下的默认账号");
});
