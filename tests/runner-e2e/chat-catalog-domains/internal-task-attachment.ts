import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import type { ChatCatalogCase, ChatCatalogContext } from "../chat-catalog-contract.js";
import type { ChatQueryAttachmentReceipt } from "../chat-query-attachments.js";
import { pollUntil } from "../api.js";
import { openStandingChat } from "./identity-support.js";
import { fixtureWorker, makeDefinition } from "./internal-definition.js";
import { checks, entity, hasLink, observation, observeInternal, type Entity, type InternalObservation } from "./internal-support.js";

interface BriefObservation extends InternalObservation {
  sourceId?: string; originalBytesHash: string; sourceAttachments: ChatQueryAttachmentReceipt[];
  workAttachments: ChatQueryAttachmentReceipt[]; workDocuments: Entity[];
  workerTaskStatus?: number; workerDownloadStatus?: number; workerDownloadedHash?: string; durablePath?: string;
  workDescription?: string | null; workerReadInlineBrief?: boolean;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// Exact brief text, tolerant only of line endings, indentation, trailing spaces, blank lines and Markdown quote markers.
const briefLines = (text: string) => text.replace(/\r\n?/g, "\n").split("\n").map(line => line.trim().replace(/^(?:>\s?)+/, "").trim()).filter(Boolean);
export function containsExactBrief(context: string | null | undefined, brief: unknown): boolean {
  if (typeof brief !== "string" || typeof context !== "string") return false;
  const want = briefLines(brief); const have = briefLines(context);
  return want.length > 0 && have.some((_, start) => want.every((line, offset) => have[start + offset] === line));
}
const workerProbeKeys = new WeakMap<ChatCatalogContext, { id: string; token: string; workerId: string }>();
export function gradeAttachmentBrief(value: unknown) {
  const c = checks(); const o = observation(value) as BriefObservation | undefined;
  c.add("independent-upload-and-worker-evidence", !!o && Array.isArray(o.sourceAttachments) && Array.isArray(o.workAttachments) && Array.isArray(o.workDocuments),
    "The original UI upload, actual work context and independently authenticated worker download are required.");
  if (!o || !Array.isArray(o.sourceAttachments) || !Array.isArray(o.workAttachments) || !Array.isArray(o.workDocuments)) return c.result();
  const receipt = o.state.briefAttachment as ChatQueryAttachmentReceipt | undefined;
  const worker = entity(o.state, "worker"); const work = o.tasks.filter(row => row.id !== o.sourceId); const saved = work[0];
  c.add("actual-human-upload-retained", !!receipt && receipt.companyId === o.companyId && o.sourceAttachments.some(row => row.id === receipt.id && row.issueId === o.sourceId && row.companyId === o.companyId
    && row.createdByUserId === receipt.createdByUserId && row.createdByAgentId == null && row.issueCommentId && row.sha256 === o.state.briefHash)
    && o.originalBytesHash === o.state.briefHash, "The original signed-in person's uploaded brief and its exact bytes remain attached to the actual source human comment.");
  c.add("one-contextual-ordinary-work-task", work.length === 1 && !!saved && saved.companyId === o.companyId && saved.assigneeAgentId === worker.id
    && o.activity.some(row => row.action === "issue.created" && row.entityId === saved.id && row.agentId === o.leadId)
    && hasLink(o, "issues", saved), "One actual CEO-created website task is delegated to the intended Morgan and linked in chat.");
  const context = `${o.workDescription ?? saved?.description ?? ""}\n${o.workDocuments.map(row => row.body ?? "").join("\n")}`;
  const copied = o.workAttachments.some(row => row.issueId === saved?.id && row.companyId === o.companyId && row.sha256 === o.state.briefHash
    && o.durablePath === row.contentPath);
  const originalReference = !!receipt && context.includes(receipt.contentPath) && o.durablePath === receipt.contentPath;
  const inline = containsExactBrief(context, o.state.briefBody);
  c.add("durable-brief-in-work-context", copied || originalReference || inline,
    "The delegated task owns an exact-byte copy, a durable actual attachment reference, or the complete exact brief text; an unavailable filename, a paraphrase or a source-chat-only attachment fails.");
  const downloaded = o.workerDownloadStatus === 200 && o.workerDownloadedHash === o.state.briefHash;
  c.add("morgan-can-read-the-real-brief", o.workerTaskStatus === 200 && (downloaded || (inline && o.workerReadInlineBrief === true)),
    "An independent real Morgan bearer reads the work task and either downloads the actual referenced brief bytes or reads the complete exact brief in its own task context.");
  const runs = saved ? o.runs.filter(row => row.contextSnapshot?.issueId === saved.id || row.contextSnapshot?.taskId === saved.id) : [];
  c.add("separate-real-worker-admission", runs.length === 1 && runs[0]?.agentId === worker.id && ["queued", "running", "succeeded"].includes(runs[0]?.status ?? ""),
    "Morgan's real admitted run belongs to the new work task, separate from the source conversation.");
  return c.result();
}
async function workerReads(ctx: ChatCatalogContext, workerId: string, taskId: string, path: string | undefined, brief: string) {
  const key = workerProbeKeys.get(ctx);
  if (!key || key.workerId !== workerId) throw new Error("Attempt-private Morgan probe credential is unavailable");
  const get = (value: string) => {
    const url = new URL(value, ctx.input.api.baseURL);
    if (url.origin !== ctx.input.api.baseURL || !/^\/api\/(?:issues|attachments)\//.test(url.pathname)) throw new Error("Worker brief read escaped isolated resources");
    return fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${key.token}` } });
  };
  const taskRead = await get(`/api/issues/${taskId}`); const workerTaskStatus = taskRead.status;
  if (!path) {
    if (!taskRead.ok) { await taskRead.body?.cancel(); return { workerTaskStatus }; }
    const parts = [((await taskRead.json()) as Entity).description ?? ""];
    const list = await get(`/api/issues/${taskId}/documents`);
    if (list.ok) for (const summary of (await list.json()) as Entity[]) {
      const doc = await get(`/api/issues/${taskId}/documents/${encodeURIComponent(summary.key!)}`);
      if (doc.ok) parts.push(((await doc.json()) as Entity).body ?? ""); else await doc.body?.cancel();
    } else await list.body?.cancel();
    return { workerTaskStatus, workerReadInlineBrief: containsExactBrief(parts.join("\n"), brief) };
  }
  await taskRead.body?.cancel();
  const response = await get(path); const workerDownloadStatus = response.status;
  if (!response.ok) { await response.body?.cancel(); return { workerTaskStatus, workerDownloadStatus }; }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 65_536) throw new Error("Delegated brief unexpectedly exceeds its fixture size bound");
  return { workerTaskStatus, workerDownloadStatus, workerDownloadedHash: hash(bytes) };
}
const base = makeDefinition("tasks.attachment-brief", async ctx => {
  const worker = await fixtureWorker(ctx); const source = await openStandingChat(ctx);
  const briefBody = `# Acorn Field Notes\nBuild a simple accessible website for small research teams.\nUse headline: Research without the busywork.\nOffer early signup with invitation code ORCHID-${ctx.input.nonce}.\n`;
  const filename = "website-brief.md";
  await ctx.input.page.locator('input[type="file"]').first().setInputFiles({ name: filename, mimeType: "text/markdown", buffer: Buffer.from(briefBody) });
  const uploaded = await pollUntil({ label: "Actual human chat brief upload", deadlineAt: Date.now() + 30_000,
    load: () => ctx.input.api.get<ChatQueryAttachmentReceipt[]>(`/api/issues/${source.id}/attachments`),
    accept: rows => rows.filter(row => row.originalFilename === filename).length === 1 });
  const receipt = uploaded.find(row => row.originalFilename === filename)!;
  await expect(ctx.input.page.getByTestId("task-chat-composer-attachments")).toContainText(filename);
  await expect(ctx.input.page.getByTestId("task-chat-composer-attachments")).not.toContainText("Uploading");
  if (!ctx.input.privateSecrets) throw new Error("Worker brief probe requires private secret redaction");
  const key = await ctx.input.api.postSensitive<{ id: string; token: string }>(`/api/agents/${worker.id}/keys`, { name: "delegated-brief-read-control" });
  ctx.input.privateSecrets.push(key.token); workerProbeKeys.set(ctx, { ...key, workerId: worker.id });
  return { worker, sourceId: source.id, briefAttachment: receipt, briefBody, briefHash: hash(Buffer.from(briefBody)), workerProbeKeyId: key.id };
}, gradeAttachmentBrief);
export const taskAttachmentCases: readonly ChatCatalogCase[] = [{ ...base, authentication: "human-session", oracleVersion: "paperclip.chat-catalog.attachment-brief.v2",
  queryAttachments: [{ stateKey: "briefAttachment", filename: "website-brief.md" }], expectedRunCount: 3, minimumRunCount: 2,
  runPolicy: { kind: "source-settled-with-active-work", maximumActiveWorkerRuns: 1 },
  sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-task-attachment.ts", "chat-catalog-domains/identity-support.ts", "chat-query-attachments.ts"],
  async observe(ctx, state): Promise<BriefObservation> {
    const o = await observeInternal(ctx, state); const source = ctx.issue();
    const sourceAttachments = source ? await ctx.input.api.get<ChatQueryAttachmentReceipt[]>(`/api/issues/${source.id}/attachments`) : [];
    const receipt = state.briefAttachment as ChatQueryAttachmentReceipt;
    const originalBytesHash = hash(await ctx.input.api.getAttachmentContent(receipt.id));
    const saved = o.tasks.filter(row => row.id !== source?.id)[0]; const workAttachments: ChatQueryAttachmentReceipt[] = []; const workDocuments: Entity[] = [];
    let workDescription: string | null | undefined;
    if (saved) {
      // Company issue listings shorten descriptions; read the saved task in full.
      workDescription = (await ctx.input.api.get<Entity>(`/api/issues/${saved.id}`)).description;
      workAttachments.push(...await ctx.input.api.get<ChatQueryAttachmentReceipt[]>(`/api/issues/${saved.id}/attachments`));
      for (const summary of await ctx.input.api.get<Entity[]>(`/api/issues/${saved.id}/documents`))
        workDocuments.push(await ctx.input.api.get<Entity>(`/api/issues/${saved.id}/documents/${encodeURIComponent(summary.key!)}`));
    }
    const context = `${workDescription ?? ""}\n${workDocuments.map(row => row.body ?? "").join("\n")}`;
    const durablePath = workAttachments.find(row => row.sha256 === state.briefHash)?.contentPath
      ?? (context.includes(receipt.contentPath) ? receipt.contentPath : undefined);
    const reads = saved ? await workerReads(ctx, entity(state, "worker").id, saved.id, durablePath, String(state.briefBody ?? "")) : {};
    return { ...o, sourceId: source?.id, sourceAttachments, originalBytesHash, workAttachments, workDocuments, workDescription, durablePath, ...reads };
  },
  async cleanup(ctx, state) {
    const key = workerProbeKeys.get(ctx); workerProbeKeys.delete(ctx);
    const id = key?.id ?? state.workerProbeKeyId;
    if (id) await ctx.input.api.delete(`/api/agents/${entity(state, "worker").id}/keys/${id}`, { allowNotFound: true });
  },
}];
