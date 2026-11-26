import { afterEach, expect, it, vi } from "vitest";
import { readFile, access } from "node:fs/promises";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { openVettedSkillSource, closeVettedSkillSource, recordVettedSourceImport, skillSourceRequests, sourceSkillMarkdown, importReadOnlySkill } from "./integrator-skill-source.js";
import { saveSkillConversationContext } from "./integrator-skill-context.js";
import { accessibilityUpdatePins as pins } from "./integrator-skill-pins.js";
import { uploadFactualQueryAttachment } from "../chat-query-attachments.js";
vi.mock("../chat-query-attachments.js", async importOriginal => ({ ...await importOriginal<typeof import("../chat-query-attachments.js")>(), uploadFactualQueryAttachment: vi.fn(async () => ({ id: "factual-upload" })) }));
afterEach(() => vi.unstubAllGlobals());
it("creates only one bounded uninstalled synthetic source and records no imported result during setup", async () => {
  const ctx = {} as ChatCatalogContext;
  const source = await openVettedSkillSource(ctx);
  try {
    expect(source.url.startsWith(source.workspaceRoot + "/vetted-candidates/")).toBe(true);
    expect(await readFile(source.url + "/SKILL.md", "utf8")).toBe(sourceSkillMarkdown);
    expect(skillSourceRequests(ctx)).toEqual([]);
    await expect(access(source.workspaceRoot + "/SKILL.md")).rejects.toThrow();
    await expect(recordVettedSourceImport(ctx, source.url, "substituted installed content")).rejects.toThrow();
    expect(skillSourceRequests(ctx)).toEqual([]);
    await recordVettedSourceImport(ctx, source.url, sourceSkillMarkdown);
    expect(skillSourceRequests(ctx)[0]).toMatchObject({ method: "public-local-import", path: "SKILL.md" });
  } finally { await closeVettedSkillSource(ctx); }
  await expect(access(source.workspaceRoot)).rejects.toThrow();
});
it("uses the actual canonical source document and factual selection without adding human messages", async () => {
  const calls: Array<{ path: string; body?: unknown }> = []; const source = { id: "source" }; let document: unknown;
  const ctx = { issue: () => source, refreshIssue: async () => {}, input: { fixtures: { company: { id: "company" }, agent: { id: "ceo" } }, api: {
    post: async (path: string) => { calls.push({ path }); }, patch: async (path: string, body: unknown) => { calls.push({ path, body }); },
    putSensitive: async (path: string, body: object) => { document = { ...body, issueId: source.id }; calls.push({ path, body }); }, get: async () => document,
  } } } as unknown as ChatCatalogContext;
  const selected = await saveSkillConversationContext(ctx, { description: "Selected existing skill: skill-id", document: { key: "sample", title: "Sample page", body: "Synthetic actual input" } });
  expect(calls.map(call => call.path)).toEqual(["/api/companies/company/chats/ceo", "/api/issues/source", "/api/issues/source/documents/sample"]);
  expect(calls.some(call => call.path.includes("/comments"))).toBe(false);
  expect(uploadFactualQueryAttachment).toHaveBeenLastCalledWith(ctx, { filename: "skill-context.md", body: "Selected existing skill: skill-id\n\n# Sample page\n\nSynthetic actual input" });
  expect(selected.factualContextAttachment.id).toBe("factual-upload");
});
it("qualifies the genuine immutable GitHub upstream without treating a local file as read-only", async () => {
  const markdown = await readFile(new URL("../fixtures/accessibility-source/0.4.SKILL.md", import.meta.url), "utf8");
  const fetch = vi.fn(async (_url: string, _options: unknown) => new Response(markdown)); vi.stubGlobal("fetch", fetch);
  let editable = false;
  const api = { post: vi.fn(async (_path: string, _body: unknown) => ({ source: { lastScanCommit: pins.oldCommit, entries: [{ path: pins.path, skillId: "upstream" }] }, imported: [{ id: "upstream" }] })),
    get: async () => ({ id: "upstream", sourceType: "github", sourceRef: pins.oldCommit, markdown, editable, currentVersionId: "saved-version" }) };
  const ctx = { input: { fixtures: { company: { id: "company" } }, api } } as unknown as ChatCatalogContext;
  expect((await importReadOnlySkill(ctx)).sourceRef).toBe(pins.oldCommit);
  expect(fetch.mock.calls[0]?.[0]).toBe(`https://raw.githubusercontent.com/KreerC/ACCESSIBILITY.md/${pins.oldCommit}/${pins.path}`);
  expect(api.post.mock.calls[0]).toEqual(["/api/companies/company/skill-sources", { repositoryUrl: pins.repositoryURL, trackingRef: pins.oldCommit, commitSha: pins.oldCommit, selectedPaths: [pins.path], excludedFolders: [] }]);
  editable = true;
  await expect(importReadOnlySkill(ctx)).rejects.toThrow("Actual read-only checklist identity/content/version was not established");
});
