import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { readNotionFixturePages } from "./external-notion-provider.js";
const workspaceId = "11111111-1111-4111-8111-111111111111", recent = "22222222-2222-4222-8222-222222222222", older = "33333333-3333-4333-8333-333333333333";
function context() {
  const binding = { disposable: true, resourceIds: [workspaceId, recent, older], credentialEnv: ["PAPERCLIP_CHAT_EVAL_NOTION_API", "PAPERCLIP_CHAT_EVAL_NOTION_MCP"], prerequisites: {
    workspaceId, recentPageId: recent, olderPageId: older, mcpUrl: "https://mcp.notion.com/mcp", apiVersion: "2026-03-11", apiTokenEnv: "PAPERCLIP_CHAT_EVAL_NOTION_API", mcpTokenEnv: "PAPERCLIP_CHAT_EVAL_NOTION_MCP", recentMarker: "Current fixture fact", olderMarker: "Earlier fixture fact", recentFactJson: JSON.stringify({subjectAliases:["current"],valueAliases:["fixture fact"]}), olderFactJson: JSON.stringify({subjectAliases:["earlier"],valueAliases:["fixture fact"]}),
  } };
  return { scenario: { id: "connection-setup.notion-connected" }, input: { privateSecrets: [], privateInputs: { read: (name: string) => name === "PAPERCLIP_CHAT_EVAL_NOTION_API" ? "private-api-fixture" : "private-mcp-fixture", configuration: () => ({ schemaVersion: 1, providers: { notion: binding } }) } } } as unknown as ChatCatalogContext;
}
function provider(options: { wrongWorkspace?: boolean; missingBody?: boolean; reverseDates?: boolean } = {}) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: URL, input: RequestInit) => {
    expect(url.origin).toBe("https://api.notion.com"); expect(input.method ?? "GET").toBe("GET"); expect(input.redirect).toBe("error"); seen.push(url.pathname);
    if (url.pathname === "/v1/users/me") return Response.json({ object: "user", type: "bot", bot: { workspace_id: options.wrongWorkspace ? older : workspaceId, workspace_name: "Not retained in oracle projection" } });
    const id = url.pathname.split("/")[3], isRecent = id === recent;
    if (url.pathname.endsWith("/children")) return Response.json({ results: [{ id, type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: options.missingBody ? "Unrelated content with a convincing title" : isRecent ? "Current fixture fact" : "Earlier fixture fact" }] } }], has_more: false });
    return Response.json({ object: "page", id, url: `https://www.notion.so/${id}`, last_edited_time: isRecent !== !!options.reverseDates ? "2026-10-25T00:00:00Z" : "2026-10-01T00:00:00Z", properties: { title: { title: [{ plain_text: "Launch notes" }] } } });
  }));
  return seen;
}
afterEach(() => vi.unstubAllGlobals());
describe("named Notion callback calibration, no live provider operations", () => {
  it("reads only the fixed official identity and allowlisted page trees and projects no raw account metadata", async () => {
    const seen = provider(); const pages = await readNotionFixturePages(context()); expect(pages).toHaveLength(2); expect(pages[0]).toMatchObject({ id: recent, marker: "Current fixture fact" });
    expect(JSON.stringify(pages)).not.toContain("Not retained"); expect(seen).toEqual(["/v1/users/me", `/v1/pages/${recent}`, `/v1/blocks/${recent}/children`, `/v1/pages/${older}`, `/v1/blocks/${older}/children`]);
  });
  it("rejects a wrong token workspace before reading any page", async () => {
    const seen = provider({ wrongWorkspace: true }); await expect(readNotionFixturePages(context())).rejects.toThrow(/workspace differs/); expect(seen).toEqual(["/v1/users/me"]);
  });
  it("title-only content and stale date assumptions cannot satisfy the fixture prerequisite", async () => {
    provider({ missingBody: true }); await expect(readNotionFixturePages(context())).rejects.toThrow(/no longer contains/);
    provider({ reverseDates: true }); await expect(readNotionFixturePages(context())).rejects.toThrow(/actually be newer/);
  });
  it("missing selected private references block before provider traffic", async () => {
    const call = vi.fn(); vi.stubGlobal("fetch", call);
    await expect(readNotionFixturePages({ scenario: { id: "connection-setup.notion-connected" }, input: {} } as ChatCatalogContext)).rejects.toThrow(/private inputs/); expect(call).not.toHaveBeenCalled();
  });
});
