import { withRestoreConcurrency } from "./internal-restore-concurrency.js";
import { projectMarkdownToText, resolveProjectionRange, createDocumentAnchorSelector } from "../../../packages/shared/src/document-anchors.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { privateDownloadCases } from "./internal-private-download.js";
import { project, task, goal, putDocument, entity, observation, checks, hasLink, sameTask, type Entity } from "./internal-support.js";
import { makeDefinition, retryDefinition, fixtureWorker } from "./internal-definition.js";
import { selectDocumentSource } from "./internal-document-context.js";
import type { IssueDocument } from "../../../packages/shared/src/types/issue.js";
import { factualContextQueryAttachment } from "../chat-query-attachments.js";

export function grade_documents_artifacts(value: unknown) {
  const c = checks(); const o = observation(value);
  c.add("complete-independent-observation", !!o, "Missing API, document, audit or rendered-link evidence cannot pass.");
  if (!o) return c.result();
  const before = o.state.task ? entity(o.state, "task") : undefined;
  const current = before && o.tasks.find(row => row.id === before.id);
  const savedProject = o.state.project ? entity(o.state, "project") : undefined;
  const projectNow = savedProject && o.projects.find(row => row.id === savedProject.id);
  const authored = (action: string, id: string) => o.activity.some(row => row.action === action && row.entityId === id && row.agentId === o.leadId);
  const linkedTask = () => !!current && hasLink(o, "issues", current);
  switch (o.scenarioId) {
    case "documents-artifacts.write-plan": {
      const plans = o.documents.filter(row => row.key === "plan"); const plan = plans[0];
      c.add("saved-implementation-plan", plans.length === 1 && !!plan && !!plan.latestRevisionId && meaningfulOrchidPlan(plan.body ?? ""), "A durable plan reflects the website's actual prerequisite brief and verification, rather than merely chat prose.");
      c.add("versioned-author", !!plan && o.revisions.some(row => row.id === plan.latestRevisionId && row.body === plan.body && row.createdByAgentId === o.leadId
        && o.runs.some(run => run.id === row.createdByRunId)), "The current document revision is attributed to this real agent run.");
      c.add("plan-audit", !!before && authored("issue.document_created", before.id), "The API audit records the CEO creating the plan after the request.");
      c.add("task-context-and-link", !!before && sameTask(before, current) && linkedTask(), "Saving a plan preserves the task and makes the saved plan reachable through its task.");
      break;
    }
    case "documents-artifacts.resolve-feedback": {
      const target = entity(o.state, "pricingThread"); const sibling = entity(o.state, "siblingThread");
      const annotation = o.annotations?.find(row => row.id === target.id); const unrelated = o.annotations?.find(row => row.id === sibling.id);
      const plan = o.documents.find(row => row.key === "plan");
      c.add("substantive-pricing-fix", !!plan && monthlyTeamPricing(plan.body ?? "") && (plan.body ?? "").includes(String(o.state.supportText)),
        "The actual current document unambiguously preserves $19 monthly total for the team and unrelated support content.");
      c.add("correct-thread-resolved", annotation?.status === "resolved" && annotation.resolvedByAgentId === o.leadId
        && unrelated?.status === "open" && annotation.documentId === plan?.id && annotation.originalRevisionId === o.state.originalRevisionId,
        "Only the anchored pricing annotation is resolved by the CEO, preserving its original document and revision relationship.");
      const edited = o.activity.find(row => row.action === "issue.document_updated" && row.agentId === o.leadId);
      const resolved = o.activity.find(row => row.action === "issue.document_annotation_thread_resolved" && row.agentId === o.leadId && row.details?.threadId === target.id);
      c.add("edit-before-resolution", !!edited && !!resolved && Date.parse(edited.createdAt ?? "") <= Date.parse(resolved.createdAt ?? "")
        && !!plan && o.revisions.some(row => row.id === plan.latestRevisionId && row.createdByAgentId === o.leadId && row.body === plan.body),
        "Saved revision and independent audit events establish the substantive edit before resolution.");
      c.add("task-and-document-access", !!before && sameTask(before, current) && linkedTask(), "Chat links the changed document's task without modifying task execution.");
      break;
    }
    case "documents-artifacts.restore-document": {
      const plan = o.documents.find(row => row.key === "plan"); const revisions = o.state.originalRevisions as Entity[];
      const previous = revisions?.[1];
      c.add("restored-exact-previous-bytes", !!previous && !!plan && plan.body === previous.body && plan.latestRevisionId !== previous.id
        && plan.latestRevisionId !== revisions[2]?.id, "Restoration creates a new current revision with the exact second revision's contents.");
      c.add("retained-history", Array.isArray(revisions) && revisions.length === 3 && o.revisions.length === 4
        && revisions.every(original => o.revisions.some(row => row.id === original.id && row.body === original.body)), "All three historical revisions remain unmodified alongside the restoration.");
      c.add("restore-path-attribution", !!before && o.activity.some(row => row.action === "issue.document_restored" && row.entityId === before.id
        && row.agentId === o.leadId && row.details?.restoredFromRevisionId === previous?.id), "An independently observed restore audit identifies the exact source revision.");
      c.add("no-execution-rewind", !!before && sameTask(before, current) && /\b(?:revision|version)\b/i.test(o.reply), "Chat identifies a document revision and leaves task execution unchanged.");
      break;
    }
    default: c.add("implemented-scenario", false, "No independent oracle is implemented for this scenario.");
  }
  return c.result();
}

const define = (id: string, setup: ChatCatalogCase["setup"]): ChatCatalogCase => {
  const base = makeDefinition(id, setup, grade_documents_artifacts);
  return id === "documents-artifacts.restore-document" || id === "documents-artifacts.resolve-feedback"
    ? { ...base, authentication: "human-session", queryAttachments: factualContextQueryAttachment("selected-source.md") } : base;
};
export const documents_artifactsCases: readonly ChatCatalogCase[] = [
  ...privateDownloadCases,
  resolveFeedback(),
  define("documents-artifacts.write-plan", async ctx => {
    const p = await project(ctx); const requirement = "Orchid";
    const t = await task(ctx, "Website task", p.id, { assigneeAgentId: ctx.input.fixtures.agent.id,
      description: `Build a single-page website for ${requirement}, with accessible signup and responsive layout. Verify keyboard navigation and mobile presentation.` });
    return { project: p, task: t, requirement };
  }),
  withRestoreConcurrency(define("documents-artifacts.restore-document", async ctx => {
    const p = await project(ctx); const t = await task(ctx, "Website task", p.id, { description: "The website task's plan has three saved revisions. The previous version before the last edit is the desired content." });
    const revisions: Entity[] = [];
    for (const body of [`# Plan\nBuild a responsive website for ${ctx.input.nonce}.`, `# Plan\nBuild accessible signup for ${ctx.input.nonce}.\nVerify keyboard operation.`, `# Plan\nReplace signup with an unrelated pricing experiment for ${ctx.input.nonce}.`]) {
      const saved = await putDocument(ctx, t.id, body, revisions.at(-1)?.id ?? null);
      revisions.push({ id: saved.latestRevisionId!, body });
    }
    const document = await ctx.input.api.get<IssueDocument>(`/api/issues/${t.id}/documents/plan`);
    const selectedSource = await selectDocumentSource(ctx, { task: t, document });
    return { project: p, task: t, originalRevisions: revisions, selectedSource, factualContextAttachment: selectedSource.factualContextAttachment };
  })),

];

function resolveFeedback(): ChatCatalogCase {
  const base = define("documents-artifacts.resolve-feedback", async ctx => {
    const p = await project(ctx); const t = await task(ctx, "Website task", p.id);
    const pricing = "Pricing is $19 every month and $19 per user every month.";
    const supportText = `Support is provided by the launch team ${ctx.input.nonce}.`;
    const body = `${pricing}\n\n${supportText}`;
    const doc = await putDocument(ctx, t.id, body);
    const createAnnotation = (quote: string, feedback: string) => {
      const projection = projectMarkdownToText(body);
      const start = projection.text.indexOf(quote);
      const range = resolveProjectionRange(projection, start, start + quote.length);
      if (!range || range.text !== quote) throw new Error("Fixture annotation quote did not resolve through production text projection");
      return ctx.input.api.post<Entity>(`/api/issues/${t.id}/documents/plan/annotations`, {
        baseRevisionId: doc.latestRevisionId, baseRevisionNumber: doc.latestRevisionNumber,
        selector: createDocumentAnchorSelector(projection, range),
        body: feedback,
      });
    };
    const pricingThread = await createAnnotation(pricing, "Clarify that $19 is the monthly total for the team, not per person. Keep the amount and billing cadence.");
    const siblingThread = await createAnnotation(supportText, "Please add a support contact later; leave this unrelated comment open for now.");
    const selectedSource = await selectDocumentSource(ctx, { task: t,
      document: { id: doc.id, key: "plan", latestRevisionId: doc.latestRevisionId! }, annotationId: pricingThread.id });
    return { project: p, task: t, pricingThread, siblingThread, supportText, originalRevisionId: doc.latestRevisionId, selectedSource, factualContextAttachment: selectedSource.factualContextAttachment };
  });
  return { ...base, sourceFiles: [...base.sourceFiles, "../../packages/shared/src/document-anchors.ts"], async observe(ctx, state) {
    const o = await observeInternal(ctx, state);
    return { ...o, annotations: await ctx.input.api.get<Entity[]>(`/api/issues/${entity(state, "task").id}/documents/plan/annotations?status=all&includeComments=true`) };
  } };
}
import { observeInternal } from "./internal-support.js";

export function meaningfulOrchidPlan(body: string): boolean {
  const clauses = body.replace(/[*_`]/g, "").split(/[.!?;\n]|\b(?:but|however|instead)\b|\band\s+(?=(?:do not|don't|never|skip|omit|exclude|no need))/i).filter(Boolean);
  const negativeDirective = /\b(?:do not|don't|never|(?:must|should|will|can|shall)\s+not)(?:\s+(?:ever|actually|really|even))?\s+(?:build|implement|develop|include|add|provide|support|verify|test|check|make|use|preserve)\b|\b(?:skip|omit|exclude)\b|\bno need to\s+(?:build|implement|develop|include|add|provide|support|verify|test|check|make|use|preserve)\b/i;
  const requirements = [
    /\b(?:implement|build|develop)\b/i,
    /\b(?:test|verify|verification|validation)\b/i,
    /\bOrchid\b/i,
    /\b(?:single|one)(?:[- ]+[a-z]+){0,3}[- ]+page\b/i,
    /\b(?:signup|sign.up|registration)\b/i,
    /\b(?:accessible|accessibility|labels?|semantic)\b/i,
    /\b(?:responsive|breakpoints?)\b/i,
    /\bkeyboard\b/i,
    /\bmobile\b/i,
  ];
  if (!requirements.every(fact => clauses.some(clause => fact.test(clause) && !negativeDirective.test(clause)))) return false;
  const features = requirements.slice(3);
  if (clauses.some(clause => {
    const directive = negativeDirective.exec(clause);
    if (!directive) return false;
    const target = clause.slice(directive.index + directive[0].length).trim();
    return features.some(fact => new RegExp(`^(?:(?:a|an|the|any|our|this)\\s+)?${fact.source}`, "i").test(target));
  })) return false;
  if (/\bwithout\s+(?:(?:any|the)\s+)?(?:signup|registration|accessibility|labels?|responsive(?:ness)?|keyboard|mobile)\b/i.test(body)) return false;
  return !clauses.some(clause => /\b(?:multi[- ]page|multiple\s+pages|separate\s+pages)\b/i.test(clause)
    && !negativeDirective.test(clause) && !/\b(?:not|no|without|avoid)\s+(?:a\s+)?(?:multi[- ]page|multiple\s+pages|separate\s+pages)\b/i.test(clause));
}

export function monthlyTeamPricing(body: string): boolean {
  const pricingClauses = body.split(/(?<=[.!?])\s+|[\n;]|\bbut\b/i);
  if (!pricingClauses.some(clause => /\$19(?:\.00)?(?![\d.])/.test(clause) && /\b(?:monthly|month)\b/i.test(clause)
    && /\bteam\b/i.test(clause) && /\b(?:total|entire|whole|per team|for the team)\b/i.test(clause))) return false;
  const negated = (index: number) => /\b(?:not|never|no|rather than|instead of)(?:\s+(?:charged|billed|priced|calculated|applied))?(?:\s+(?:a|an|the))?(?:\s+\$[\d,.]+)?\s*$/i.test(body.slice(Math.max(0, index - 80), index));
  for (const amount of body.matchAll(/\$([\d,]+(?:\.\d+)?)/g)) {
    if (Number(amount[1]!.replaceAll(",", "")) !== 19 && !negated(amount.index!)) return false;
    if (Number(amount[1]!.replaceAll(",", "")) === 19 && negated(amount.index!)
      && !/\bper[- ](?:user|person|seat)\b/i.test(body.slice(amount.index! + amount[0].length).split(/[.;\n]/)[0]!)) return false;
  }
  for (const scope of body.matchAll(/\b(?:per[- ]|each\s+|every\s+)(?:user|person|seat)\b/gi)) {
    const suffix = body.slice(scope.index! + scope[0].length);
    const deniedAfter = /^\s+(?:(?:pricing|billing|charge)\s+)?(?:is|would be)\s+(?:wrong|incorrect|not (?:correct|applicable|required))\b/i.test(suffix);
    if (!negated(scope.index!) && !deniedAfter) return false;
  }
  for (const cadence of body.matchAll(/\b(?:yearly|annually|annual|per year|one[- ]time)\b/gi)) if (!negated(cadence.index!)) return false;
  return !/\b(?:not|never|no)\s+(?:monthly|per month|(?:the\s+)?total|(?:(?:for|per)\s+(?:the\s+)?)?(?:(?:entire|whole)\s+)?team)\b/i.test(body);
}
