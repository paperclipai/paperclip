import { createHash } from "node:crypto";
import type { ChatCatalogContext, ChatCatalogQueryAttachment } from "./chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { pollUntil } from "./api.js";

export interface ChatQueryAttachmentReceipt {
  id: string; companyId: string; issueId: string; issueCommentId: string | null;
  originalFilename: string | null; contentPath: string; byteSize: number; sha256: string;
  createdByAgentId: string | null; createdByUserId: string | null; originatingRunId?: string | null;
}
export interface ChatQueryHumanComment {
  id: string; body: string; authorAgentId?: string | null; authorUserId?: string | null;
  issueId?: string; companyId?: string; createdByRunId?: string | null;
}
const factualFiles: Readonly<Record<string, string>> = {
  "developer-labs.gated-lab": "historical-lab-link.md",
  "documents-artifacts.resolve-feedback": "selected-source.md",
  "documents-artifacts.restore-document": "selected-source.md",
  "documents-artifacts.produce-download": "selected-source.md",
  "documents-artifacts.revise-delivery": "selected-source.md",
  "skills.author-skill": "skill-context.md", "skills.studio-test": "skill-context.md",
  "skills.review-update": "skill-context.md", "skills.find-and-install": "skill-context.md", "skills.fork-read-only": "skill-context.md",
  "connection-setup.secure-api-key": "provider-account.md",
  "status-cards.explain-card": "selected-status-card.md", "status-cards.archive-card": "selected-status-card.md",
  "routines.webhook-trigger": "selected-routine.md",
  "cases.create-case": "customer-bug-brief.md", "app-permissions.ask-before-action": "launch-update.md",
};
const permitted = new Set(["steering.preserve-draft", "tasks.attachment-brief", "companies.import-preview", ...Object.keys(factualFiles)]);
export const factualContextQueryAttachment = (filename: string): readonly ChatCatalogQueryAttachment[] => [{ stateKey: "factualContextAttachment", filename }];

/** Upload factual user input through the real composer. This creates neither a
 * comment nor a run; the unchanged canonical query submits the production file
 * reference and attachmentId together. Contents are owned by the exact case. */
export async function uploadFactualQueryAttachment(ctx: ChatCatalogContext, input: { filename: string; body: string }): Promise<ChatQueryAttachmentReceipt> {
  if (factualFiles[ctx.scenario.id] !== input.filename) throw new Error("Undeclared factual query attachment filename/scenario");
  const bytes = Buffer.from(input.body, "utf8");
  if (!bytes.length || bytes.length > 65_536) throw new Error("Factual context must be a bounded nonempty UTF-8 document");
  const { api, page, fixtures } = ctx.input;
  const health = await api.get<{ deploymentMode: string }>("/api/health");
  const session = await api.get<{ user?: { id: string } }>("/api/auth/get-session");
  if (health.deploymentMode !== "authenticated" || !session.user?.id || session.user.id === "local-board")
    throw new Error("Factual query input requires its real authenticated human uploader");
  await api.post(`/api/companies/${fixtures.company.id}/chats/${fixtures.agent.id}`);
  await ctx.refreshIssue(); const source = ctx.issue();
  if (!source) throw new Error("Factual upload requires the actual canonical standing conversation");
  await page.goto(new URL(`/${fixtures.company.issuePrefix}/chats/${fixtures.agent.id}`, api.baseURL).href, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
  const endpoint = `/api/issues/${source.id}/attachments`;
  if ((await api.get<ChatQueryAttachmentReceipt[]>(endpoint)).some(row => row.originalFilename === input.filename))
    throw new Error("Factual input already exists; do not silently replace or duplicate source context");
  await page.locator('input[type="file"]').first().setInputFiles({ name: input.filename, mimeType: "text/markdown", buffer: bytes });
  const rows = await pollUntil({ label: "Actual human factual context upload", deadlineAt: Date.now() + 30_000,
    load: () => api.get<ChatQueryAttachmentReceipt[]>(endpoint), accept: rows => rows.filter(row => row.originalFilename === input.filename).length === 1 });
  const saved = rows.find(row => row.originalFilename === input.filename)!;
  const expected = { ...saved, companyId: fixtures.company.id, issueId: source.id, createdByUserId: session.user.id, sha256: digest(bytes), byteSize: bytes.length };
  const downloaded = await api.getAttachmentContent(saved.id);
  if (!attachmentReceiptMatches({ expected, saved, bytes: downloaded, companyId: fixtures.company.id, issueId: source.id }) || !Buffer.from(downloaded).equals(bytes))
    throw new Error("Factual upload bytes/source/human attribution do not match the original input");
  const tray = page.getByTestId("task-chat-composer-attachments");
  await expect(tray).toContainText(input.filename); await expect(tray).not.toContainText("Uploading");
  const receipt = receiptProjection(saved);
  await ctx.input.evidence("chat-catalog-factual-query-input.json", { scenarioId: ctx.scenario.id, receipt, body: input.body,
    delivery: "pending canonical human comment attachment; description readback is not model delivery" });
  return receipt;
}
function receiptProjection(row: ChatQueryAttachmentReceipt): ChatQueryAttachmentReceipt {
  return { id: row.id, companyId: row.companyId, issueId: row.issueId, issueCommentId: row.issueCommentId,
    originalFilename: row.originalFilename, contentPath: row.contentPath, byteSize: row.byteSize, sha256: row.sha256,
    createdByAgentId: row.createdByAgentId, createdByUserId: row.createdByUserId, originatingRunId: row.originatingRunId };
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Exact IssueChatThread submittedBody formatter; no alternate markdown or body rewriting. */
export function chatQueryWithAttachments(query: string, receipts: readonly ChatQueryAttachmentReceipt[]): string {
  if (receipts.length > 1) throw new Error("Only one declared production attachment is supported");
  return [query.trim(), ...receipts.map(item => `[${item.originalFilename!.replace(/[[\]]/g, "\\$&")}](${item.contentPath})`)].filter(Boolean).join("\n\n");
}
export function attachmentReceiptMatches(input: {
  expected: ChatQueryAttachmentReceipt; saved: ChatQueryAttachmentReceipt; bytes: Uint8Array;
  companyId: string; issueId: string; comment?: ChatQueryHumanComment;
}): boolean {
  const { expected, saved, bytes, companyId, issueId, comment } = input;
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(saved.id)
    && saved.id === expected.id && saved.companyId === companyId && saved.issueId === issueId
    && saved.originalFilename === expected.originalFilename && !!saved.originalFilename
    && saved.contentPath === `/api/attachments/${saved.id}/content` && saved.contentPath === expected.contentPath
    && typeof saved.createdByUserId === "string" && !!saved.createdByUserId && saved.createdByUserId === expected.createdByUserId
    && saved.createdByAgentId == null && saved.originatingRunId == null
    && /^[a-f0-9]{64}$/.test(saved.sha256) && saved.sha256 === expected.sha256
    && digest(bytes) === saved.sha256 && saved.byteSize === bytes.byteLength && saved.byteSize === expected.byteSize
    && (comment ? saved.issueCommentId === comment.id && comment.authorUserId === saved.createdByUserId
      && comment.authorAgentId == null && comment.createdByRunId == null && comment.issueId === issueId && comment.companyId === companyId
      : saved.issueCommentId == null);
}
export async function resolveChatQueryAttachments(ctx: ChatCatalogContext, specs: readonly ChatCatalogQueryAttachment[] = [], state: Record<string, unknown>) {
  if (!specs.length) return [];
  if (!permitted.has(ctx.scenario.id) || specs.length !== 1 || new Set(specs.map(row => row.stateKey)).size !== specs.length) throw new Error("Undeclared or duplicate catalog query attachment");
  if (factualFiles[ctx.scenario.id] && specs[0]?.filename !== factualFiles[ctx.scenario.id]) throw new Error("Factual query attachment does not match its exact scenario filename");
  if (ctx.scenario.id === "companies.import-preview" && (specs[0]?.filename !== "company-package.json" || specs[0]?.stateKey !== "packageAttachment"))
    throw new Error("Company preview requires its exact declared package attachment");
  await ctx.refreshIssue(); const issue = ctx.issue(); if (!issue) throw new Error("UI upload has no persisted source issue");
  const saved = await ctx.input.api.get<ChatQueryAttachmentReceipt[]>(`/api/issues/${issue.id}/attachments`);
  const receipts: ChatQueryAttachmentReceipt[] = [];
  for (const spec of specs) {
    const expected = state[spec.stateKey] as ChatQueryAttachmentReceipt | undefined;
    const matches = saved.filter(row => row.id === expected?.id);
    if (!expected || matches.length !== 1 || expected.originalFilename !== spec.filename || !spec.filename.trim() || /[\r\n\0]/.test(spec.filename)
      || receipts.some(row => row.id === expected.id)) throw new Error("Declared attachment differs from the persisted UI upload");
    const receipt = matches[0]!; const bytes = await ctx.input.api.getAttachmentContent(receipt.id);
    if (!attachmentReceiptMatches({ expected, saved: receipt, bytes, companyId: ctx.input.fixtures.company.id, issueId: issue.id })) throw new Error("Attachment source, content hash or human upload attribution does not match");
    receipts.push(receiptProjection(receipt));
  }
  return receipts;
}
export async function verifyChatQueryAttachments(ctx: ChatCatalogContext, receipts: readonly ChatQueryAttachmentReceipt[], comment: ChatQueryHumanComment) {
  const issue = ctx.issue(); if (!issue) return false;
  const saved = await ctx.input.api.get<ChatQueryAttachmentReceipt[]>(`/api/issues/${issue.id}/attachments`);
  for (const expected of receipts) {
    const matches = saved.filter(row => row.id === expected.id); if (matches.length !== 1) return false;
    const receipt = matches[0]!; const bytes = await ctx.input.api.getAttachmentContent(receipt.id);
    if (!attachmentReceiptMatches({ expected, saved: receipt, bytes, companyId: ctx.input.fixtures.company.id, issueId: issue.id, comment })) return false;
  }
  return true;
}
