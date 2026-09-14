// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RuntimeService, RuntimeServiceShare } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { RuntimeServiceSharing } from "./RuntimeServiceSharing";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ shares: vi.fn(), createShare: vi.fn(), revokeShare: vi.fn() }));
vi.mock("../api/runtime-services", () => ({ runtimeServicesApi: api }));
const service = { id: "service", companyId: "company", endpoints: [{ name: "web", url: "https://app.example.test" }] } as RuntimeService;
const share: RuntimeServiceShare = { id: "share", endpointName: "web", url: "https://board.example.test/shared/capability", expiresAt: "2026-12-31T00:00:00Z", revokedAt: null, createdAt: "2026-09-12T00:00:00Z" };
let root: Root | undefined; let node: HTMLDivElement; let client: QueryClient;
async function mount() {
  node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  await act(async () => { root!.render(<QueryClientProvider client={client}><RuntimeServiceSharing service={service} /></QueryClientProvider>); });
}
const button = (text: string) => Array.from(node.querySelectorAll("button")).find((item) => item.textContent === text)!;
async function click(text: string) { await act(async () => { button(text).click(); }); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
beforeEach(() => { api.shares.mockResolvedValue([]); });
afterEach(async () => { await act(async () => { root?.unmount(); }); node?.remove(); client?.clear(); vi.resetAllMocks(); });

describe("preview sharing under uncertain responses", () => {
  it("suppresses repeated submits and retries a lost response with identical expiry and request identity", async () => {
    let reject!: (error: Error) => void;
    api.createShare.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValueOnce(share);
    await mount(); await click("Share preview");
    await act(async () => { button("Create share link").click(); button("Create share link").click(); }); await settle();
    expect(api.createShare).toHaveBeenCalledTimes(1); expect(node.textContent).toContain("Creating link…");
    await act(async () => { reject(new TypeError("Network interrupted")); }); await settle();
    expect(Array.from(node.querySelectorAll("select")).every((select) => select.disabled)).toBe(true);
    await click("Retry same request"); await settle();
    expect(api.createShare.mock.calls[1]![2]).toEqual(api.createShare.mock.calls[0]![2]);
    expect(node.textContent).toContain("Share link created.");
  });
  it("keeps an authoritative revocation visible when an older poll arrives", async () => {
    api.shares.mockResolvedValue([share]);
    api.revokeShare.mockResolvedValue({ ...share, revokedAt: "2026-09-12T12:00:00Z", url: null });
    await mount(); await settle(); await click("Revoke link"); await settle();
    expect(node.textContent).toContain("Revoked");
    await act(async () => { client.setQueryData(["runtime-services", "company", "shares", "service"], [share]); }); await settle();
    expect(node.querySelector('input[aria-label="web share link"]')).toBeNull();
    expect(node.textContent).toContain("Revoked");
  });
  it("lets the user correct settings after a definitive validation rejection", async () => {
    api.createShare.mockRejectedValue(new ApiError("This endpoint has no preview URL", 422, {}));
    await mount(); await click("Share preview"); await click("Create share link"); await settle();
    expect(node.textContent).toContain("This endpoint has no preview URL");
    expect(Array.from(node.querySelectorAll("select")).every((select) => !select.disabled)).toBe(true);
  });

  it("confirms revocation from a fresh list after its mutation response was lost", async () => {
    api.shares.mockResolvedValue([share]);
    let reject!: (error: Error) => void;
    api.revokeShare.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    await mount(); await settle(); await click("Revoke link"); await settle();
    api.shares.mockResolvedValue([{ ...share, revokedAt: "2026-09-12T12:00:00Z", url: null }]);
    await act(async () => { reject(new TypeError("Response lost")); }); await settle();
    expect(node.textContent).toContain("Share link revoked. Existing viewers lose access.");
    expect(node.querySelector('[role="alert"]')).toBeNull();
    expect(button("Retry revocation")).toBeUndefined();
    expect(api.revokeShare).toHaveBeenCalledTimes(1);
    api.createShare.mockResolvedValue({ ...share, id: "new-share" });
    await click("Share preview"); await click("Create share link"); await settle();
    expect(node.textContent).toContain("Share link created.");
    expect(node.textContent).not.toContain("Existing viewers lose access.");
  });

  it("retries the same revocation while a poll cannot confirm its outcome", async () => {
    api.shares.mockResolvedValue([share]);
    api.revokeShare.mockRejectedValueOnce(new TypeError("Response lost"))
      .mockResolvedValueOnce({ ...share, revokedAt: "2026-09-12T12:00:00Z", url: null });
    await mount(); await settle(); await click("Revoke link"); await settle();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("Could not confirm revocation");
    await act(async () => { button("Retry revocation").click(); button("Retry revocation").click(); }); await settle();
    expect(api.revokeShare).toHaveBeenCalledTimes(2);
    expect(api.revokeShare.mock.calls[1]?.slice(0, 3)).toEqual(api.revokeShare.mock.calls[0]?.slice(0, 3));
    expect(node.textContent).toContain("Share link revoked. Existing viewers lose access.");
  });
});
