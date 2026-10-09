import { describe, expect, it, vi } from "vitest";
import { AggregatorDiscoveryUnavailableError, discoverArcadeApps, discoverExecutorApps, EXECUTOR_INVENTORY_CODE, inventoryPayload } from "../services/aggregator-app-discovery.js";
import { aggregatorManagementUrl } from "@paperclipai/shared/aggregator-apps";

const account = (id: string, user = "u1") => ({ id, user_id: user, provider_id: "notion-provider", connection_status: "active", provider_user_info: { email: "Work", access_token: "do-not-store" } });
const tool = { qualified_name: "Notion.ListPages", toolkit: { name: "Notion" }, requirements: { met: true, authorization: { provider_id: "notion-provider", token_status: "completed" } } };

describe("aggregator inventory adapters", () => {
  it("paginates Arcade, scopes the user and exposed tools, preserves distinct accounts, and strips credentials", async () => {
    const request = vi.fn(async (path: string) => path.startsWith("/v1/tools") ? { items: [tool, { ...tool, toolkit: { name: "Private" }, qualified_name: "Private.Read" }] }
      : path.includes("offset=100") ? { items: [account("last"), account("foreign", "u2")], total_count: 102, offset: 0 }
      : { items: Array.from({ length: 100 }, (_, index) => account(String(index))), total_count: 102, offset: 100 });
    const apps = await discoverArcadeApps({ request, userId: "u1", gatewayTools: ["Notion_ListPages"] });
    expect(apps).toHaveLength(1);
    expect(apps[0].accounts).toHaveLength(101);
    expect(apps[0].accounts[0]).toMatchObject({ appSlug: "notion", status: "ACTIVE", alias: "Work" });
    expect(JSON.stringify(apps)).not.toContain("do-not-store");
    expect(request.mock.calls[0][0]).toContain("user[id]=u1");
  });
  it("uses Arcade's next offset after a short page and rejects truncated final pages", async () => {
    const request = vi.fn(async (path: string) => path.startsWith("/v1/tools") ? { items: [tool], total_count: 1, offset: 0 }
      : path.includes("offset=1") ? { items: [account("second")], total_count: 2, offset: 0 }
      : { items: [account("first")], total_count: 2, offset: 1 });
    expect((await discoverArcadeApps({ request, userId: "u1", gatewayTools: ["Notion.ListPages"] }))[0].accounts).toHaveLength(2);
    expect(request.mock.calls.some(([path]) => path.includes("offset=1"))).toBe(true);
    await expect(discoverArcadeApps({ userId: "u1", gatewayTools: ["Notion.ListPages"], request: async path => path.startsWith("/v1/tools")
      ? { items: [tool], total_count: 1, offset: 0 } : { items: [account("one")], total_count: 2, offset: 0 } })).rejects.toThrow("Incomplete");
  });
  it("rejects an Arcade partial page rather than returning an authoritative empty inventory", async () => {
    for (const items of [[], [account("one")]]) await expect(discoverArcadeApps({ userId: "u1", gatewayTools: ["Notion.ListPages"], request: async path => path.startsWith("/v1/tools") ? { items: [tool] } : { items, total: 10 } })).rejects.toThrow("Incomplete");
  });
  it("does not claim Arcade authorization from account existence alone", async () => {
    const apps = await discoverArcadeApps({ userId: "u1", gatewayTools: ["Notion.ListPages"], request: async path => ({ items: path.startsWith("/v1/tools") ? [{ ...tool, requirements: { ...tool.requirements, met: false } }] : [account("1")] }) });
    expect(apps[0].accounts[0].status).toBe("UNVERIFIED");
  });
  it("enumerates Executor pages and uses owner/integration/account identity with honest health", async () => {
    const call = vi.fn(async (_name, args) => ({ result: { structuredContent: { items: [{ integration: args.offset ? "custom-notion-helper" : "notion", integrationName: "Custom helper", connection: "Work", owner: args.offset ? "user" : "org", identityLabel: "Work", lastHealth: args.offset ? null : { status: "healthy", checkedAt: 1000 }, secret: "never" }], hasMore: !args.offset, nextOffset: args.offset ? null : 50 } } }));
    const apps = await discoverExecutorApps({ call, toolNames: ["integrations"], managementUrl: "https://executor.example/team/integrations" });
    expect(apps[0].accounts[0]).toMatchObject({ appSlug: "notion", status: "ACTIVE", healthCheckedAt: "1970-01-01T00:00:01.000Z" });
    expect(apps[1].accounts[0]).toMatchObject({ appSlug: "executor:custom-notion-helper", status: "UNVERIFIED" });
    expect(JSON.stringify(apps)).not.toContain("never");
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("uses fixed read-only code and preserves an upstream workspace management link", async () => {
    const call = vi.fn(async () => ({ structuredContent: { status: "completed", result: { connections: [{ integration: "notion", name: "Work", owner: "user", lastHealth: { status: "expired" } }], integrations: [{ slug: "notion" }], managementUrls: { notion: "https://self-host.example/my-org/integrations/notion?addAccount=1" } } } }));
    const apps = await discoverExecutorApps({ call, toolNames: ["execute"] });
    expect(call).toHaveBeenCalledWith("execute", { code: EXECUTOR_INVENTORY_CODE });
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    expect(await new AsyncFunction("tools", EXECUTOR_INVENTORY_CODE)({})).toEqual({ discoveryUnavailable: true });
    expect(apps[0].accounts[0]).toMatchObject({ status: "EXPIRED", managementUrl: "https://self-host.example/my-org/integrations/notion" });
  });
  it("rejects unsupported, failed, malformed and truncated Executor inventories", async () => {
    await expect(discoverExecutorApps({ toolNames: [], call: vi.fn() })).rejects.toThrow("unavailable");
    await expect(discoverExecutorApps({ toolNames: ["execute"], call: async () => ({ structuredContent: { result: { incompatible: true } } }) })).rejects.toBeInstanceOf(AggregatorDiscoveryUnavailableError);
    await expect(discoverExecutorApps({ toolNames: ["execute"], call: async () => ({ isError: true }) })).rejects.toThrow("failed");
    await expect(discoverExecutorApps({ toolNames: ["integrations"], call: async () => ({ items: [], hasMore: true, nextOffset: 0 }) })).rejects.toThrow("Incomplete");
    expect(() => inventoryPayload({ content: [{ type: "text", text: "No accounts" }] })).toThrow();
  });
  it("validates browser destinations without leaking credentials", () => {
    expect(aggregatorManagementUrl("composio")).toBe("https://dashboard.composio.dev/~/org/connect/apps");
    for (const url of ["javascript:alert(1)", "https://user:password@executor.example/", "https://executor.example/?api_key=secret"]) expect(aggregatorManagementUrl("executor", url)).toBeNull();
    expect(aggregatorManagementUrl("arcade", "https://other.example")).toBeNull();
    expect(aggregatorManagementUrl("executor", "https://executor.example/team/accounts")).toBe("https://executor.example/team/accounts");
  });
});
