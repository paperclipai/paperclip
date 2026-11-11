import type { cases } from "../../../packages/db/src/schema/cases.js";
import type { CaseHandoff } from "../../../packages/shared/src/case-handoffs.js";
import type { IssueDocument, DocumentRevision } from "../../../packages/shared/src/types/issue.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { uploadFactualQueryAttachment, factualContextQueryAttachment } from "../chat-query-attachments.js";
import { checks, hasLink, observation, project, type Entity, type InternalObservation } from "./internal-support.js";
import { fixtureWorker } from "./internal-definition.js";
import { integratorDefinition, inspectResult, resultHref, observeInternal } from "./integrator-support.js";
type CaseRecord = typeof cases.$inferSelect;
interface CaseCreationObservation extends InternalObservation { cases: CaseRecord[]; handoffs: Record<string, CaseHandoff[]>; taskDocuments: Record<string, IssueDocument[]>; documentVersions: Record<string, DocumentRevision[]> }
export const customerBugFacts = { customer: "Acorn Test Shop", symptom: "Checkout button becomes unresponsive", browser: "Safari 18", device: "iPhone 15", reproduction: "Add the synthetic trial item, enter the test address, then press Pay", expected: "Order confirmation appears", actual: "No confirmation and no charge" };
export function preservesCustomerBugFacts(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const text = JSON.stringify(value); const entries: Array<{ path: string; text: string }> = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") entries.push({ path, text: node });
    else if (node && typeof node === "object") for (const [key, nested] of Object.entries(node)) walk(nested, `${path}.${key}`);
  }; walk(value, "");
  const expected = entries.filter(entry => /expect|should/i.test(entry.path)).map(entry => entry.text).join(" ");
  const actual = entries.filter(entry => /actual|observ|result/i.test(entry.path)).map(entry => entry.text).join(" ");
  return /Acorn Test Shop/i.test(text) && /checkout/i.test(text) && /unresponsive|non.responsive|does not respond|stops responding|no response/i.test(text)
    && /Safari\s*18/i.test(text) && /iPhone\s*15/i.test(text) && /trial item/i.test(text) && /test address/i.test(text) && /\bPay\b/i.test(text)
    && /order confirmation/i.test(expected) && !/\b(?:no|not|without|never)\b/i.test(expected)
    && /(?:no|without) (?:order )?confirmation|confirmation (?:does not|doesn't|never) appear/i.test(actual)
    && /no charge|not charged|without (?:a )?charge/i.test(actual);
}
const briefHasFacts = (body: string) => /Acorn Test Shop/i.test(body) && /checkout/i.test(body) && /unresponsive|non.responsive|does not respond|stops responding|no response/i.test(body)
  && /Safari\s*18/i.test(body) && /iPhone\s*15/i.test(body) && /trial item/i.test(body) && /test address/i.test(body) && /\bPay\b/i.test(body)
  && /order confirmation/i.test(body) && /(?:no|without) (?:order )?confirmation|confirmation (?:does not|doesn't|never) appear/i.test(body) && /no charge|not charged|without (?:a )?charge/i.test(body);
async function observeCreation(ctx: ChatCatalogContext, state: Record<string, unknown>): Promise<CaseCreationObservation> {
  const o = await observeInternal(ctx, state); const api = ctx.input.api;
  const cases = await api.get<CaseRecord[]>(`/api/companies/${o.companyId}/cases`);
  const handoffs: Record<string, CaseHandoff[]> = {}; const taskDocuments: Record<string, IssueDocument[]> = {}; const documentVersions: Record<string, DocumentRevision[]> = {};
  for (const row of cases) {
    handoffs[row.id] = (await api.get<{ items: CaseHandoff[] }>(`/api/cases/${row.id}/handoffs?limit=100`)).items;
    if (!row.workIssueId) continue;
    const summaries = await api.get<IssueDocument[]>(`/api/issues/${row.workIssueId}/documents`);
    taskDocuments[row.workIssueId] = await Promise.all(summaries.map(doc => api.get<IssueDocument>(`/api/issues/${row.workIssueId}/documents/${encodeURIComponent(doc.key)}`)));
    for (const doc of summaries) documentVersions[`${row.workIssueId}:${doc.key}`] = await api.get<DocumentRevision[]>(`/api/issues/${row.workIssueId}/documents/${encodeURIComponent(doc.key)}/revisions`);
  }
  return { ...o, cases, handoffs, taskDocuments, documentVersions };
}
function creationObservation(value: unknown): CaseCreationObservation | undefined {
  const o = value as CaseCreationObservation;
  return observation(value) && Array.isArray(o.cases) && !!o.handoffs && !!o.taskDocuments && !!o.documentVersions ? o : undefined;
}
export function gradeIntegratorCaseCreation(value: unknown) {
  const c = checks(); const o = creationObservation(value);
  c.add("public-case-kickoff-and-document-evidence", !!o, "Requires actual public case, handoff, primary task and saved document revision evidence.");
  if (!o) return c.result();
  const row = o.cases[0]; const worker = o.state.worker as Entity | undefined;
  const primary = row?.workIssueId ? o.tasks.find(task => task.id === row.workIssueId) : undefined;
  c.add("one-case-with-one-primary-task", o.cases.length === 1 && !!row && row.companyId === o.companyId && row.projectId === (o.state.project as Entity | undefined)?.id
    && !!primary && o.tasks.filter(task => task.id !== (o.state.task as Entity | undefined)?.id).length === 1, "One actual company case has one primary task; the prerequisite customer brief remains a separate original record.");
  c.add("structured-customer-facts", preservesCustomerBugFacts(row?.fields), "Structured case fields preserve the actual customer, device/browser, reproduction and expected versus observed behavior; prose may be paraphrased.");
  const kickoff = row && o.handoffs[row.id]?.filter(handoff => handoff.version === 1);
  c.add("real-first-morgan-kickoff", !!worker && kickoff?.length === 1 && kickoff[0]?.caseId === row?.id && kickoff[0]?.issueId === primary?.id && kickoff[0]?.toAgentId === worker.id
    && kickoff[0]?.actorId === o.leadId && !!kickoff[0]?.sourceRunId && o.runs.some(run => run.id === kickoff[0]?.sourceRunId && run.agentId === o.leadId)
    && ["delivered", "completed"].includes(kickoff[0]?.state ?? "")
    && o.runs.some(run => run.agentId === worker.id && run.contextSnapshot?.issueId === primary?.id && ["queued", "running", "succeeded"].includes(run.status)), "The real measured CEO starts the primary task with Morgan as its first actual investigation recipient.");
  const docs = primary ? o.taskDocuments[primary.id] ?? [] : [];
  const workflow = docs.find(doc => doc.key === "workflow"); const brief = docs.find(doc => doc.key !== "workflow" && briefHasFacts(doc.body));
  const workerRun = o.runs.find(run => run.agentId === worker?.id && run.contextSnapshot?.issueId === primary?.id);
  const savedBeforeStart = (doc: IssueDocument | undefined, content: (body: string) => boolean) => !!doc && !!primary && doc.issueId === primary.id && doc.companyId === o.companyId
    && !!workerRun && o.documentVersions[`${primary.id}:${doc.key}`]?.some(revision => revision.issueId === primary.id && revision.documentId === doc.id && revision.createdByAgentId === o.leadId
    && content(revision.body) && revision.createdByRunId === kickoff?.[0]?.sourceRunId && Date.parse(String(revision.createdAt)) <= Date.parse(String(workerRun.startedAt)));
  c.add("required-documents-persist-before-investigation", savedBeforeStart(workflow, body => /Morgan/i.test(body) && /\b(?:review|handoff|hand.off|owner)\b/i.test(body)) && savedBeforeStart(brief, briefHasFacts), "The primary task owns an attributed saved brief and workflow describing Morgan, owners and later handoffs before Morgan's run begins; a later repaired document cannot rescue a missing initial brief.");
  c.add("case-and-primary-task-links", !!row && !!primary && !!(resultHref(o, row.id, "cases") ?? resultHref(o, row.identifier, "cases")) && hasLink(o, "issues", primary), "Chat links the actual case and primary task instead of a passive record with a fictional investigation claim.");
  return c.result();
}
const previous = new WeakMap<ChatCatalogContext, boolean>();
export const integratorCaseCreationCases = [integratorDefinition("cases", "cases.create-case", async ctx => {
  const settings = await ctx.input.api.get<{ enableCases: boolean }>("/api/instance/settings/experimental"); previous.set(ctx, settings.enableCases);
  try {
    await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: true });
    const p = await project(ctx, "Launch"); const worker = await fixtureWorker(ctx);
    await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/chats/${ctx.input.fixtures.agent.id}`);
    await ctx.refreshIssue(); const t = ctx.issue();
    if (!t) throw new Error("Customer brief requires its actual standing conversation");
    await ctx.input.api.patch(`/api/issues/${t.id}`, { projectId: p.id });
    const body = `# Customer bug brief\n\n${Object.entries(customerBugFacts).map(([key, value]) => `${key}: ${value}`).join("\n")}`;
    await ctx.input.api.putSensitive(`/api/issues/${t.id}/documents/brief`, { title: "Customer bug brief", format: "markdown", body, baseRevisionId: null });
    const brief = await ctx.input.api.get<IssueDocument>(`/api/issues/${t.id}/documents/brief`);
    if (brief.body !== body || brief.issueId !== t.id) throw new Error("Customer brief did not persist on the actual canonical conversation");
    const factualContextAttachment = await uploadFactualQueryAttachment(ctx, { filename: "customer-bug-brief.md", body: brief.body });
    return { project: p, task: t, worker, factualContextAttachment };
  } catch (error) { await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: settings.enableCases }); previous.delete(ctx); throw error; }
}, observeCreation, gradeIntegratorCaseCreation, async (ctx, _state, value) => {
  const o = creationObservation(value); const row = o?.cases[0]; if (!o || !row) throw new Error("Missing created case result");
  const href = resultHref(o, row.id, "cases") ?? resultHref(o, row.identifier, "cases"); if (!href) throw new Error("Missing real case link");
  await inspectResult(ctx, new URL(href, o.origin).pathname, row.title, href);
  const primary = o.tasks.find(task => task.id === row.workIssueId); if (!primary) throw new Error("Missing primary case task");
  const taskHref = o.links.find(link => hasLink({ ...o, links: [link] }, "issues", primary)); if (!taskHref) throw new Error("Missing primary task link");
  await inspectResult(ctx, new URL(taskHref, o.origin).pathname, primary.title!, taskHref);
}, { authentication: "human-session", queryAttachments: factualContextQueryAttachment("customer-bug-brief.md"), sourceFiles: ["chat-catalog-domains/integrator-case-create.ts", "chat-catalog-domains/integrator-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/internal-definition.ts", "chat-scenarios/cases.yaml"],
  expectedRunCount: 2, minimumRunCount: 2, runPolicy: { kind: "source-settled-with-active-work", maximumActiveWorkerRuns: 1 }, attemptTimeoutMs: 420_000,
  async cleanup(ctx) { const value = previous.get(ctx); if (value !== undefined) { await ctx.input.api.patch("/api/instance/settings/experimental", { enableCases: value }); previous.delete(ctx); } },
})];
