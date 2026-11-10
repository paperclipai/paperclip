import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { attachmentReceiptMatches, chatQueryWithAttachments, resolveChatQueryAttachments, type ChatQueryAttachmentReceipt } from "./chat-query-attachments.js";
import { chatCatalogHumanHistoryMatches, type ChatCatalogContext } from "./chat-catalog-contract.js";
const id = "11111111-1111-4111-8111-111111111111", bytes = Buffer.from("Synthetic website brief");
const receipt: ChatQueryAttachmentReceipt = { id, companyId: "company", issueId: "source", issueCommentId: null,
  originalFilename: "website-brief.md", contentPath: `/api/attachments/${id}/content`, byteSize: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), createdByAgentId: null, createdByUserId: "human", originatingRunId: null };
const base = { expected: receipt, saved: receipt, bytes, companyId: "company", issueId: "source" };
it("allows only exact production attachment suffixes after the unchanged canonical query", () => {
  const query = "Have Morgan turn the attached brief into a website.";
  const body = chatQueryWithAttachments(query, [receipt]);
  expect(body).toBe(`${query}\n\n[website-brief.md](${receipt.contentPath})`);
  expect(chatQueryWithAttachments(query, [])).toBe(query);
  expect(() => chatQueryWithAttachments(query, [receipt, receipt])).toThrow("Only one");
  expect(chatQueryWithAttachments(query, [{ ...receipt, originalFilename: "brief[1].md" }])).toContain("[brief\\[1\\].md]");
  const history = { implementation: {}, human: [{ id: "comment", body }], runIds: [], boundary: { humanCommentIds: [], runIds: [] }, renderedQuery: body };
  expect(chatCatalogHumanHistoryMatches(history)).toBe(true);
  expect(chatCatalogHumanHistoryMatches({ ...history, human: [{ id: "comment", body: body + "\nPlease finish" }] })).toBe(false);
  expect(chatCatalogHumanHistoryMatches({ ...history, human: [{ id: "comment", body: body.replace(query, "Another query") }] })).toBe(false);
});
it("requires genuine same-source human upload, fetched content hashes and canonical-comment attribution", () => {
  expect(attachmentReceiptMatches(base)).toBe(true);
  const comment = { id: "canonical", body: "query", authorUserId: "human", authorAgentId: null, createdByRunId: null, issueId: "source", companyId: "company" };
  const saved = { ...receipt, issueCommentId: "canonical" };
  expect(attachmentReceiptMatches({ ...base, saved, comment })).toBe(true);
  for (const patch of [{ companyId: "foreign" }, { issueId: "other-source" }, { contentPath: "https://outside.example/file" },
    { originalFilename: "wrong.md" }, { sha256: "0".repeat(64) }, { createdByAgentId: "agent" }, { originatingRunId: "run" },
    { createdByUserId: "other-human" }, { byteSize: 0 }]) expect(attachmentReceiptMatches({ ...base, saved: { ...receipt, ...patch } })).toBe(false);
  expect(attachmentReceiptMatches({ ...base, bytes: Buffer.from("wrong bytes") })).toBe(false);
  expect(attachmentReceiptMatches({ ...base, saved: { ...saved, issueCommentId: "other-comment" }, comment })).toBe(false);
  expect(attachmentReceiptMatches({ ...base, saved, comment: { ...comment, authorUserId: "other-human" } })).toBe(false);
});
it("independently resolves declared receipt IDs and rejects undeclared, duplicate or forged uploads", async () => {
  const ctx = { scenario: { id: "steering.preserve-draft" }, refreshIssue: async () => {}, issue: () => ({ id: "source" }),
    input: { fixtures: { company: { id: "company" } }, api: { get: async () => [receipt], getAttachmentContent: async (attachmentId: string) => { expect(attachmentId).toBe(id); return bytes; } } } } as unknown as ChatCatalogContext;
  const spec = { stateKey: "brief", filename: "website-brief.md" };
  expect(await resolveChatQueryAttachments(ctx, [spec], { brief: receipt })).toEqual([receipt]);
  await expect(resolveChatQueryAttachments({ ...ctx, scenario: { ...ctx.scenario, id: "goals.create-goal-tree" } }, [spec], { brief: receipt })).rejects.toThrow("Undeclared");
  await expect(resolveChatQueryAttachments(ctx, [spec, spec], { brief: receipt })).rejects.toThrow("duplicate");
  await expect(resolveChatQueryAttachments(ctx, [spec], { brief: { ...receipt, sha256: "0".repeat(64) } })).rejects.toThrow("hash");
  await expect(resolveChatQueryAttachments(ctx, [spec], {})).rejects.toThrow("persisted UI upload");
});

it.each([
  ["status-cards.explain-card", "selected-status-card.md"], ["status-cards.archive-card", "selected-status-card.md"],
  ["routines.webhook-trigger", "selected-routine.md"],
  ["developer-labs.gated-lab", "historical-lab-link.md"],
  ["documents-artifacts.resolve-feedback", "selected-source.md"], ["documents-artifacts.restore-document", "selected-source.md"],
  ["documents-artifacts.produce-download", "selected-source.md"], ["documents-artifacts.revise-delivery", "selected-source.md"],
  ["skills.author-skill", "skill-context.md"], ["skills.studio-test", "skill-context.md"], ["skills.review-update", "skill-context.md"],
  ["skills.find-and-install", "skill-context.md"], ["skills.fork-read-only", "skill-context.md"],
  ["cases.create-case", "customer-bug-brief.md"], ["app-permissions.ask-before-action", "launch-update.md"], ["connection-setup.secure-api-key", "provider-account.md"],
])("binds only the exact factual file for %s", async (scenarioId, filename) => {
  const actual = { ...receipt, originalFilename: filename };
  const ctx = { scenario: { id: scenarioId }, refreshIssue: async () => {}, issue: () => ({ id: "source" }), input: {
    fixtures: { company: { id: "company" } }, api: { get: async () => [actual], getAttachmentContent: async () => bytes },
  } } as unknown as ChatCatalogContext;
  expect(await resolveChatQueryAttachments(ctx, [{ stateKey: "factualContextAttachment", filename }], { factualContextAttachment: actual })).toEqual([actual]);
  await expect(resolveChatQueryAttachments(ctx, [{ stateKey: "factualContextAttachment", filename: "wrong-context.md" }], { factualContextAttachment: actual })).rejects.toThrow("exact scenario filename");
});

it("matches the actual production submittedBody formatter without loading its UI module", () => {
  const source = readFileSync(new URL("../../ui/src/components/IssueChatThread.tsx", import.meta.url), "utf8");
  const expression = source.match(/const submittedBody = \[\s*trimmed,\s*\.\.\.attachedFiles\.map\(\s*\(item\) =>\s*(`[^`]+`),/);
  expect(expression).not.toBeNull();
  const production = new Function("trimmed", "attachedFiles", `return [trimmed,...attachedFiles.map(item => ${expression![1]})].filter(Boolean).join("\\n\\n")`) as (query: string, attachments: Array<{ name: string; contentPath: string }>) => string;
  for (const name of ["website-brief.md", "brief[1].md", "brief (draft).md"]) {
    expect(chatQueryWithAttachments("Original query", [{ ...receipt, originalFilename: name }])).toBe(production("Original query", [{ name, contentPath: receipt.contentPath }]));
  }
});

it("also matches the active TaskChatComposer for its one declared upload", () => {
  const source = readFileSync(new URL("../../ui/src/components/task-chat/TaskChatComposer.tsx", import.meta.url), "utf8");
  const escapeBody = source.match(/function escapeMarkdownLabel\(name: string\): string \{\s*([^}]+)\}/)![1]!;
  const escape = new Function("name", escapeBody);
  const template = source.match(/const refLines = attachedRefs\s*\.map\(\(item\) => (`[^`]+`)\)/)![1]!;
  const production = new Function("trimmed", "attachedRefs", "escapeMarkdownLabel", "isImage", `return [trimmed,attachedRefs.map(item => ${template}).join("\\n")].filter(Boolean).join("\\n\\n")`) as (query: string, refs: Array<{ name: string; contentPath: string }>, escape: Function, isImage: Function) => string;
  // The composer marks images with `!`; the declared uploads are Markdown documents.
  expect(source).toContain("function isImage(item: ComposerAttachment)");
  const isImage = (item: { name: string }) => /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(item.name);
  for (const name of ["website-brief.md", "brief[1].md"]) expect(chatQueryWithAttachments("Canonical query", [{ ...receipt, originalFilename: name }])).toBe(production("Canonical query", [{ name, contentPath: receipt.contentPath }], escape, isImage));
});

it("admits only the declared human company-preview package with independent receipt checks", async () => {
  const actual = { ...receipt, originalFilename: "company-package.json" };
  const ctx = { scenario: { id: "companies.import-preview" }, refreshIssue: async () => {}, issue: () => ({ id: "source" }), input: {
    fixtures: { company: { id: "company" } }, api: { get: async () => [actual], getAttachmentContent: async () => bytes },
  } } as unknown as ChatCatalogContext;
  const spec = { stateKey: "packageAttachment", filename: "company-package.json" };
  expect(await resolveChatQueryAttachments(ctx, [spec], { packageAttachment: actual })).toEqual([actual]);
  for (const invalid of [{ ...spec, filename: "arbitrary.zip" }, { ...spec, stateKey: "otherUpload" }])
    await expect(resolveChatQueryAttachments(ctx, [invalid], { packageAttachment: actual })).rejects.toThrow("exact declared");
  await expect(resolveChatQueryAttachments(ctx, [spec, spec], { packageAttachment: actual })).rejects.toThrow("duplicate");
  await expect(resolveChatQueryAttachments(ctx, [spec], { packageAttachment: { ...actual, createdByUserId: "forged" } })).rejects.toThrow("attribution");
  await expect(resolveChatQueryAttachments(ctx, [spec], { packageAttachment: { ...actual, sha256: "0".repeat(64) } })).rejects.toThrow("hash");
});
