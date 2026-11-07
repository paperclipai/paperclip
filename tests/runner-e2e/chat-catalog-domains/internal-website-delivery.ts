import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect } from "@playwright/test";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import type { IssueAttachment } from "../../../packages/shared/src/types/issue.js";
import type { IssueWorkProduct } from "../../../packages/shared/src/types/work-product.js";
import type { WorkspaceFileContent } from "../../../packages/shared/src/types/workspace-file-resource.js";
import { pollUntil } from "../api.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { fixtureWorker, makeDefinition } from "./internal-definition.js";
import { checks, entity, hasLink, observation, observeInternal, project, task, type Entity, type InternalObservation } from "./internal-support.js";
import { selectDocumentSource } from "./internal-document-context.js";
import { factualContextQueryAttachment } from "../chat-query-attachments.js";
interface Downloaded { id: string; sha256: string; body: string }
interface DeliveryObservation extends InternalObservation { attachments: IssueAttachment[]; products: IssueWorkProduct[]; downloaded: Downloaded[] }
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const headline = (body: string) => /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
export function websitePrerequisiteSettled(value: { task: Entity; runs: { agentId: string; status: string }[] }, workerId: string, revising: boolean) {
  return value.runs.length === 1 && value.runs[0]?.agentId === workerId && value.runs[0]?.status === "succeeded"
    && value.task.status === (revising ? "done" : "blocked");
}
function downloadHref(o: InternalObservation, attachment: IssueAttachment) {
  const paths = [attachment.contentPath, attachment.openPath, attachment.downloadPath].filter((path): path is string => !!path);
  return o.links.find(href => { try { const url = new URL(href, o.origin); return url.origin === o.origin && paths.some(path => new URL(path, o.origin).pathname === url.pathname); } catch { return false; } });
}
function deliveredFiles(o: DeliveryObservation) {
  return o.attachments.filter(file => o.products.some(product => product.type === "artifact" && product.provider === "paperclip" && product.issueId === file.issueId
    && product.metadata?.attachmentId === file.id && ["active", "approved", "ready_for_review"].includes(product.status)
    && o.runs.some(run => run.id === product.createdByRunId && run.id === file.originatingRunId && run.agentId === o.leadId && run.status === "succeeded")));
}
export function gradeWebsiteDelivery(value: unknown) {
  const c = checks(); const o = observation(value) as DeliveryObservation | undefined;
  c.add("independent-registered-delivery", !!o && Array.isArray(o.attachments) && Array.isArray(o.products) && Array.isArray(o.downloaded), "Registered work products, immutable attachment origin and independently downloaded bytes are required.");
  if (!o || !Array.isArray(o.attachments) || !Array.isArray(o.products) || !Array.isArray(o.downloaded)) return c.result();
  const source = o.state.task ? entity(o.state, "task") : undefined; const prior = o.state.producedBody as string; const originalHash = o.state.producedHash;
  const files = deliveredFiles(o); const revising = o.scenarioId === "documents-artifacts.revise-delivery";
  c.add("actual-prior-work-and-source-retained", typeof prior === "string" && hash(prior) === originalHash && /<html\b/i.test(prior)
    && !!source && o.tasks.some(row => row.id === source.id && row.companyId === o.companyId && row.projectId === source.projectId) && hasLink(o, "issues", entity(o.state, "task"))
    && o.runs.some(run => run.id === o.state.priorRunId && run.agentId === entity(o.state, "worker").id && run.status === "succeeded"),
    "The request refers to actual earlier worker-produced website bytes and preserves its source task and execution attribution.");
  const correct = files.filter(file => o.downloaded.some(bytes => bytes.id === file.id && bytes.sha256 === file.sha256 && hash(bytes.body) === file.sha256
    && (revising ? bytes.sha256 !== originalHash && !!headline(bytes.body) && headline(bytes.body).length < headline(prior).length
      && bytes.body.includes(String(o.state.bodyFact)) && bytes.body.includes(String(o.state.signupHref)) && bytes.body.includes(String(o.state.marker)) : bytes.sha256 === originalHash)));
  c.add("new-exact-download-through-product-path", correct.length === 1 && !!downloadHref(o, correct[0]!), "Exactly one current-run registered artifact has the independently verified requested bytes and a usable returned product download link.");
  if (revising) {
    const original = o.state.originalAttachment as IssueAttachment | undefined;
    c.add("original-version-still-retrievable", !!original && o.attachments.some(file => file.id === original.id && file.sha256 === originalHash && file.issueId === source?.id)
      && o.downloaded.some(bytes => bytes.id === original.id && bytes.sha256 === originalHash && bytes.body === prior)
      && o.products.some(product => product.id === o.state.originalProductId && product.metadata?.attachmentId === original.id && product.issueId === source?.id)
      && correct[0]?.issueId === source?.id, "The original attachment and work product remain retrievable, while the shorter-headline revision belongs to the same source work.");
    c.add("clear-revision-context", /\b(?:new|updated|revised|shorter)\b/i.test(o.reply) && /\b(?:old|original|previous|v1|version one|first version)\b/i.test(o.reply)
      && /\b(?:kept|retained|available|preserved|still|unchanged)\b/i.test(o.reply), "Chat distinguishes the new revision from the retained original instead of relabeling stale bytes.");
  }
  return c.result();
}
function websiteDelivery(revising: boolean): ChatCatalogCase {
  const base = makeDefinition(revising ? "documents-artifacts.revise-delivery" : "documents-artifacts.produce-download", async ctx => {
    const worker = await fixtureWorker(ctx); const p = await project(ctx, "Launch", { workspace: { name: "Authorized launch workspace", sourceType: "local_path", cwd: ctx.input.workspacePath, isPrimary: true } });
    const root = `/api/companies/${ctx.input.fixtures.company.id}`;
    for (const scope of [{ scopeType: "company", scopeId: ctx.input.fixtures.company.id }, { scopeType: "agent", scopeId: worker.id }])
      await ctx.input.api.post(`${root}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
    const filename = revising ? "website-v1.html" : "website.html"; const marker = `ACORN-WEBSITE-${ctx.input.nonce}`;
    const bodyFact = "Acorn Notes keeps quiet research teams organized."; const signupHref = "https://example.test/acorn-signup";
    const producedBody = `<!doctype html><html><head><meta charset="utf-8"><title>Acorn Notes</title></head><body><h1>Bring all of your research team notes together in one calm and accessible place</h1><p>${bodyFact}</p><a href="${signupHref}">Join the list</a><footer>${marker}</footer></body></html>\n`;
    const t = await task(ctx, "Website task", p.id, { status: "todo", assigneeAgentId: worker.id,
      description: `Generate the website file ${filename} in this task's authorized project workspace, with exactly these UTF-8 bytes (JSON string): ${JSON.stringify(producedBody)}. Use ordinary filesystem tools and independently verify the saved file. ${revising ? `Deliver ${filename} through the normal product artifact registration and upload path, with that exact filename as its work-product title. Complete this initial build prerequisite after verifying the actual file.` : "This is the generate-only prerequisite stage: keep the verified file in the authorized workspace and pause the task as blocked awaiting the person's subsequent explicit delivery request. Do not claim finished delivery, register, or upload it yet."} Do not create other tasks.` });
    const ready = await pollUntil({ label: "Real prior website generation", deadlineAt: Date.now() + 240_000,
      load: async () => ({ task: await ctx.input.api.get<typeof t>(`/api/issues/${t.id}`), runs: await ctx.allRuns() }),
      accept: value => websitePrerequisiteSettled(value, worker.id, revising),
      reject: value => value.runs.some(run => ["failed", "cancelled", "timed_out"].includes(run.status)) ? "The real prerequisite website build did not finish" : undefined });
    const produced = await ctx.input.api.get<WorkspaceFileContent>(`/api/issues/${t.id}/file-resources/content?workspace=execution&path=${encodeURIComponent(filename)}`);
    const actual = produced.content.encoding === "base64" ? Buffer.from(produced.content.data, "base64").toString("utf8") : produced.content.data;
    if (actual !== producedBody) throw new Error("The prerequisite workspace bytes disagree with the actual generated website");
    const priorRunId = ready.runs[0]!.id; let originalAttachment: IssueAttachment | undefined; let originalProductId: string | undefined;
    if (revising) {
      const [original] = await readRegisteredArtifacts(ctx.input.api, t.id, priorRunId, [filename]);
      if (original.content !== actual) throw new Error("The prior registered delivery does not match the generated website");
      originalAttachment = (await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${t.id}/attachments`)).find(file => file.id === original.attachmentId)!; originalProductId = original.workProductId;
      if (!originalAttachment) throw new Error("The original registered delivery attachment is missing from its source task");
    } else if ((await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${t.id}/attachments`)).length) throw new Error("The undelivered prerequisite unexpectedly uploaded the requested outcome");
    // The delivered revision source can be handed over without starting work. The
    // undelivered prerequisite stays honestly blocked with its original worker;
    // assigning a nonterminal task here could admit an undeclared extra run.
    const handedOff = revising ? await ctx.input.api.patch<typeof t>(`/api/issues/${t.id}`, { assigneeAgentId: ctx.input.fixtures.agent.id }) : ready.task;
    const selectedSource = await selectDocumentSource(ctx, { task: handedOff,
      ...(revising ? { attachment: originalAttachment } : { workspaceFilename: filename }) });
    const state = { project: p, task: handedOff, worker, priorRunId, filename, producedBody: actual, producedHash: hash(actual), marker, bodyFact, signupHref, originalAttachment, originalProductId, selectedSource, factualContextAttachment: selectedSource.factualContextAttachment };
    await ctx.input.evidence("chat-catalog-actual-prior-website.json", state); return state;
  }, gradeWebsiteDelivery);
  return { ...base, authentication: "human-session", queryAttachments: factualContextQueryAttachment("selected-source.md"), expectedRunCount: 2, minimumRunCount: 2, attemptTimeoutMs: 600_000,
    sourceFiles: [...base.sourceFiles, "chat-catalog-domains/internal-website-delivery.ts", "registered-artifact.ts"],
    async observe(ctx, state): Promise<DeliveryObservation> {
      const o = await observeInternal(ctx, state); const ids = [entity(state, "task").id, ...(ctx.issue() ? [ctx.issue()!.id] : [])];
      const rows = await Promise.all(ids.map(async id => ({ attachments: await ctx.input.api.get<IssueAttachment[]>(`/api/issues/${id}/attachments`), products: await ctx.input.api.get<IssueWorkProduct[]>(`/api/issues/${id}/work-products`) })));
      const attachments = rows.flatMap(row => row.attachments); const products = rows.flatMap(row => row.products); const downloaded: Downloaded[] = [];
      for (const file of attachments.filter(row => /\.html?$/i.test(row.originalFilename ?? "")).slice(0, 10)) { const bytes = await ctx.input.api.getAttachmentContent(file.id); if (bytes.length > 262144) throw new Error("Website artifact exceeds fixture bounds"); downloaded.push({ id: file.id, sha256: hash(bytes), body: bytes.toString("utf8") }); }
      return { ...o, attachments, products, downloaded };
    },
    async verifyResult(ctx, state, value) {
      const o = value as DeliveryObservation; await base.verifyResult(ctx, state, value);
      const file = deliveredFiles(o).find(row => downloadHref(o, row)); if (!file) throw new Error("Missing exact registered download result");
      const href = downloadHref(o, file)!; const page = await ctx.input.page.context().newPage();
      try {
        const waiting = page.waitForEvent("download", { timeout: 5000 }).catch(() => undefined);
        await page.goto(new URL(href, o.origin).href).catch(error => { if (!/download|ERR_ABORTED/i.test(String(error))) throw error; });
        const download = await waiting;
        if (download) { const path = await download.path(); if (!path || hash(await readFile(path)) !== file.sha256) throw new Error("Browser download does not match the registered artifact bytes"); }
        else await expect(page.locator("h1")).toHaveText(headline(o.downloaded.find(row => row.id === file.id)!.body));
        await ctx.input.evidence("chat-catalog-website-download-opened.json", { attachmentId: file.id, sha256: file.sha256, downloaded: !!download, rendered: !download });
      } finally { await page.close(); }
      if (revising) { const source = ctx.input.page.url(); try {
        await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/artifacts?groupIssueId=${entity(state, "task").id}`, o.origin).href, { waitUntil: "domcontentloaded" });
        for (const product of o.products.filter(row => row.issueId === entity(state, "task").id && row.metadata?.attachmentId === file.id)) await expect(ctx.input.page.getByText(product.title, { exact: true }).first()).toBeVisible();
        await ctx.input.evidence("chat-catalog-website-version-library-opened.json", { taskId: entity(state, "task").id, url: ctx.input.page.url(), originalProductId: state.originalProductId });
      } finally { await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); } }
    },
  };
}
export const websiteDeliveryCases: readonly ChatCatalogCase[] = [websiteDelivery(false), websiteDelivery(true)];
