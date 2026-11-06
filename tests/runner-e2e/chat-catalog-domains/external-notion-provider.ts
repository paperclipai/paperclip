import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { selectedExternalBinding, selectedExternalCredential, type ProviderBinding } from "./external-fixtures.js";
import { root } from "./external-support.js";
import { notionFactSpan, parseNotionFact, type NotionFact } from "./external-notion-semantics.js";
export interface NotionPageOracle { id: string; url: string; editedAt: string; marker: string; title: string; fact: NotionFact }
interface Page { object: string; id: string; url: string; last_edited_time: string; parent?: { type?: string; page_id?: string; workspace?: boolean }; properties?: Record<string, { type?: string; title?: Array<{ plain_text?: string }> }> }
interface Block { id: string; type: string; has_children: boolean; [key: string]: unknown }
const normalized = (id: string) => id.replaceAll("-", "").toLowerCase();
/** Only the selected disposable resource allowlist is accepted. This does not
 * enumerate an account, search workspaces, or infer permission from a token. */
export function assertNotionConnection(binding: ProviderBinding) {
  const p = binding.prerequisites, id = p.workspaceId;
  if (!id || !/^[a-f0-9-]{32,36}$/i.test(id) || !binding.resourceIds.some(resource => normalized(resource) === normalized(id))) throw new Error("Setup blocker: Notion workspaceId must be an explicitly allowlisted disposable UUID");
  const url = new URL(p.mcpUrl!);
  if (url.protocol !== "https:" || url.hostname !== "mcp.notion.com" || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) throw new Error("Setup blocker: named Notion proof requires the actual official Notion MCP resource");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.apiVersion ?? "")) throw new Error("Setup blocker: Notion API version reference is missing");
}
export function assertNotionFixture(binding: ProviderBinding) {
  assertNotionConnection(binding); const p = binding.prerequisites;
  for (const field of ["recentPageId", "olderPageId"]) { const id = p[field]; if (!id || !/^[a-f0-9-]{32,36}$/i.test(id) || !binding.resourceIds.some(resource => normalized(resource) === normalized(id))) throw new Error(`Setup blocker: Notion ${field} must be an explicitly allowlisted disposable UUID`); }
  if (!p.recentMarker || !p.olderMarker || p.recentMarker === p.olderMarker) throw new Error("Setup blocker: distinct synthetic recent/background Notion marker references are required");
  parseNotionFact(p.recentFactJson); parseNotionFact(p.olderFactJson);
}
async function notionJson<T>(token: string, version: string, pathname: string): Promise<T> {
  const url = new URL(pathname, "https://api.notion.com");
  if (url.origin !== "https://api.notion.com" || !/^\/v1\/(?:users\/me|pages\/[a-f0-9-]+|blocks\/[a-f0-9-]+\/children)$/.test(url.pathname)) throw new Error("Notion oracle escaped its read-only fixture resource");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${token}`, "Notion-Version": version, "content-type": "application/json" } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Setup blocker: authorized disposable Notion resource read returned HTTP ${response.status}; contents withheld`); }
  const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > 2 * 1024 * 1024) throw new Error("Setup blocker: Notion oracle response exceeds bounded fixture size");
  try { return JSON.parse(bytes.toString("utf8")) as T; } catch { throw new Error("Notion oracle returned invalid JSON; contents withheld"); }
}
function richText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(richText).join(" ");
  const row = value as Record<string, unknown>;
  if (typeof row.plain_text === "string") return row.plain_text;
  return Object.values(row).filter(value => value && typeof value === "object").map(richText).join(" ");
}
async function blocksText(token: string, version: string, pageId: string, maxChildren = 100) {
  let blocks = 0; const visited = new Set<string>();
  async function children(id: string, depth: number): Promise<string> {
    if (depth > 3 || visited.has(id)) throw new Error("Setup blocker: Notion page exceeds bounded fixture tree"); visited.add(id);
    const page = await notionJson<{ results: Block[]; has_more: boolean }>(token, version, `/v1/blocks/${id}/children?page_size=100`);
    if (!Array.isArray(page.results) || page.has_more || (blocks += page.results.length) > maxChildren) throw new Error("Setup blocker: Notion fixture page exceeds bounded child count");
    const contents: string[] = [];
    for (const block of page.results) { contents.push(richText(block[block.type])); if (block.has_children) contents.push(await children(block.id, depth + 1)); }
    return contents.join("\n");
  }
  return children(pageId, 0);
}
export async function verifyNotionWorkspace(ctx: ChatCatalogContext, binding: ProviderBinding) {
  assertNotionConnection(binding); const p = binding.prerequisites, token = selectedExternalCredential(ctx, binding, "apiTokenEnv");
  const self = await notionJson<{ object: string; type: string; bot?: { workspace_id?: string } }>(token, p.apiVersion!, "/v1/users/me");
  if (self.object !== "user" || self.type !== "bot" || !self.bot?.workspace_id || normalized(self.bot.workspace_id) !== normalized(p.workspaceId!)) throw new Error("Setup blocker: actual Notion token workspace differs from its authorized disposable workspace reference");
  return { provider: "notion" as const, workspaceMatched: true };
}
export async function readNotionFixturePages(ctx: ChatCatalogContext, binding = selectedExternalBinding(ctx)) {
  assertNotionFixture(binding); const p = binding.prerequisites;
  const token = selectedExternalCredential(ctx, binding, "apiTokenEnv");
  // Provider identity is checked privately; names, email and the raw account
  // receipt never enter state/evidence. Provider contract:
  // https://developers.notion.com/reference/user#bots
  await verifyNotionWorkspace(ctx, binding);
  const result: NotionPageOracle[] = [];
  for (const [idField, markerField] of [["recentPageId", "recentMarker"], ["olderPageId", "olderMarker"]] as const) {
    const id = p[idField]!, marker = p[markerField]!;
    const page = await notionJson<Page>(token, p.apiVersion!, `/v1/pages/${id}`);
    if (page.object !== "page" || normalized(page.id) !== normalized(id) || !Number.isFinite(Date.parse(page.last_edited_time))) throw new Error("Setup blocker: independent Notion page identity/date differs from its allowlisted fixture");
    const url = new URL(page.url); if (url.protocol !== "https:" || !/(^|\.)notion\.(?:so|site)$/.test(url.hostname)) throw new Error("Setup blocker: Notion page returned an unexpected source host");
    const body = await blocksText(token, p.apiVersion!, id);
    if (!body.includes(marker)) throw new Error(`Setup blocker: ${idField} no longer contains its authorized synthetic marker`);
    const fact = parseNotionFact(p[idField === "recentPageId" ? "recentFactJson" : "olderFactJson"]);
    if (!notionFactSpan(body, fact)) throw new Error(`Setup blocker: ${idField} body does not substantiate its bounded approved fact`);
    result.push({ id, url: page.url, editedAt: page.last_edited_time, marker, fact, title: Object.values(page.properties ?? {}).flatMap(row => row.title ?? []).map(row => row.plain_text ?? "").join("") });
  }
  if (Date.parse(result[0]!.editedAt) <= Date.parse(result[1]!.editedAt)) throw new Error("Setup blocker: recent Notion fixture must actually be newer than the background page");
  return result;
}
export async function connectNamedNotion(ctx: ChatCatalogContext, binding: ProviderBinding, agentIds: string[]) {
  assertNotionConnection(binding);
  const token = selectedExternalCredential(ctx, binding, "mcpTokenEnv");
  const result = await ctx.input.api.postSensitive<{ connectionId: string; actions: { readOnly: Array<{ catalogEntryId: string }>; canMakeChanges: Array<{ catalogEntryId: string }> } }>(`${root(ctx)}/tools/apps/connect`, {
    link: binding.prerequisites.mcpUrl, name: "Launch Notion", authMode: "bearer", credentialValues: { "credentials.authorization": token }, grantKind: "organization",
  });
  const read = result.actions.readOnly.map(row => row.catalogEntryId);
  if (!read.length) throw new Error("Setup blocker: actual Notion MCP connection did not expose any classified read actions");
  try {
    await ctx.input.api.post(`${root(ctx)}/tools/apps/${result.connectionId}/finish`, { enabledCatalogEntryIds: read, askFirstCatalogEntryIds: [], access: { agentIds } });
    await ctx.input.api.putSensitive(`/api/tool-connections/${result.connectionId}/installs`, { installs: agentIds.map(targetId => ({ targetType: "agent", targetId })) });
    return { connectionId: result.connectionId, readEntryIds: read };
  } catch (error) { await ctx.input.api.delete(`/api/tool-connections/${result.connectionId}`, { allowNotFound: true }); throw error; }
}

/** A known-existing personal fixture page must really be inaccessible under the
 * independently healthy shared workspace credential; never infer mismatch only
 * from a display name. No discovery or non-allowlisted page is attempted. */
export async function verifyNotionPersonalPageDenied(
  ctx: ChatCatalogContext,
  shared: ProviderBinding,
  pageId: string,
) {
  assertNotionConnection(shared);
  if (
    !/^[a-f0-9-]{32,36}$/i.test(pageId) ||
    !shared.resourceIds.some((id) => normalized(id) === normalized(pageId))
  )
    throw new Error(
      "Setup blocker: personal Notion page is outside explicit disposable resource allowlist",
    );
  const token = selectedExternalCredential(ctx, shared, "apiTokenEnv");
  const response = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": shared.prerequisites.apiVersion!,
    },
  });
  await response.body?.cancel();
  if (![403, 404].includes(response.status))
    throw new Error(
      "Setup blocker: healthy shared Notion credential did not prove the selected personal page inaccessible",
    );
  return true;
}
