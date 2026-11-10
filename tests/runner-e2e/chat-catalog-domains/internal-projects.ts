import { expect } from "@playwright/test";
import { projectPrivacyCases } from "./internal-privacy.js";
import { repositoryProjectCases } from "./internal-repositories.js";
import { projectWorkCases } from "./internal-task-creation.js";
import type { ChatCatalogCase } from "../chat-catalog-contract.js";
import { project, task, goal, putDocument, entity, observation, checks, hasLink, sameTask, type Entity, type InternalObservation } from "./internal-support.js";
import { makeDefinition, retryDefinition, fixtureWorker } from "./internal-definition.js";

export function grade_projects(value: unknown) {
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
    case "projects.create-project": {
      const created = o.projects.filter(row => row.name === "Launch");
      c.add("one-company-project", created.length === 1 && created[0]?.companyId === o.companyId, "Exactly one Launch is saved in the active company.");
      c.add("agent-created-project", created.length === 1 && authored("project.created", created[0]!.id), "Creation is attributed to the acting CEO rather than fixture setup.");
      c.add("usable-project-link", created.length === 1 && hasLink(o, "projects", created[0]!), "Chat renders the exact saved project link.");
      c.add("retry-reuses-first-project", initialProjectCreation(observation(o.state.firstCreation)) && Array.isArray(o.state.firstIds) && o.state.firstIds.length === 1 && created[0]?.id === o.state.firstIds[0]
        && o.humanQueries.filter(query => query === o.state.retryQuery).length === 2, "The exact user retry preserves the first saved project rather than silently creating and replacing it.");
      c.add("no-invented-ready-work", o.tasks.length === 0 && !/\b(?:deployed|website is ready|repository is ready)\b/i.test(o.reply), "Creation does not invent execution, repository readiness or a deployment.");
      break;
    }
    case "projects.archive-project": {
      c.add("archived-not-deleted", !!projectNow && Number.isFinite(Date.parse(projectNow.archivedAt ?? "")), "Launch remains retrievable in the supported archived state.");
      c.add("history-retained", !!before && sameTask(before, current) && o.documents.some(row => row.body === o.state.originalBody)
        && o.activity.some(row => row.id === o.state.originalActivityId), "The original task, document bytes and creation audit survive archiving.");
      c.add("attributed-project-update", !!projectNow && authored("project.updated", projectNow.id), "The saved lifecycle change belongs to the acting agent.");
      c.add("historical-api-reachability", !!projectNow && o.state.historicalProjectReadId === projectNow.id && o.state.historicalTaskReadId === before?.id, "The actual archived project and retained task remain independently readable through their public resource APIs.");
      c.add("truthful-archive-report", /\barchived\b/i.test(o.reply) && !assertsDestructiveArchiveChange(o.reply), "The response reports saved archiving without falsely claiming resource deletion or task cancellation.");
      break;
    }
    default: c.add("implemented-scenario", false, "No independent oracle is implemented for this scenario.");
  }
  return c.result();
}

const define = (id: string, setup: ChatCatalogCase["setup"]) => makeDefinition(id, setup, grade_projects);
export const projectsCases: readonly ChatCatalogCase[] = [
  ...projectPrivacyCases,
  ...repositoryProjectCases,
  ...projectWorkCases,
  retryDefinition("projects.create-project", grade_projects, initialProjectCreation),
  archivedProject(),

];

function initialProjectCreation(o: InternalObservation | undefined): boolean {
  if (!o) return false;
  const projects = o.projects.filter(row => row.name === "Launch"); const p = projects[0];
  return projects.length === 1 && !!p && p.companyId === o.companyId && o.tasks.length === 0 && hasLink(o, "projects", p)
    && o.activity.some(row => row.action === "project.created" && row.entityId === p.id && row.agentId === o.leadId)
    && !/\b(?:deployed|website is ready|repository is ready)\b/i.test(o.reply);
}

function assertsDestructiveArchiveChange(reply: string) {
  for (const match of reply.matchAll(/\b(?:delet(?:e|ed|ing)|cancel(?:led|ed|ling|ing))\b/gi)) {
    const before = reply.slice(Math.max(0, match.index! - 75), match.index);
    if (!/(?:\b(?:not|never|nothing|without|no resources?|no tasks?)|n['’]t|rather than)\s+(?:(?:was|were|is|are|been|be|being|have|has|had)\s+)*$/i.test(before)) return true;
  }
  return false;
}
function archivedProject(): ChatCatalogCase {
  const base = define("projects.archive-project", async ctx => {
    const p = await project(ctx, "Launch", { status: "completed" });
    const t = await task(ctx, "Website task", p.id, { status: "done" });
    const body = `# Delivered website\nHistorical receipt ${ctx.input.nonce}.`;
    await putDocument(ctx, t.id, body);
    const activity = await ctx.input.api.get<Entity[]>(`/api/issues/${t.id}/activity`);
    return { project: p, task: t, originalBody: body, originalActivityId: activity.find(row => row.action === "issue.created")?.id };
  });
  return { ...base,
    async observe(ctx, state) {
      const [p, t] = await Promise.all([ctx.input.api.get<Entity>(`/api/projects/${entity(state, "project").id}`), ctx.input.api.get<Entity>(`/api/issues/${entity(state, "task").id}`)]);
      state.historicalProjectReadId = p.id; state.historicalTaskReadId = t.id;
      return base.observe!(ctx, state);
    },
    async verifyResult(ctx, state) {
      const source = ctx.input.page.url();
      for (const [kind, row] of [["projects", entity(state, "project")], ["issues", entity(state, "task")]] as const) {
        await ctx.input.page.goto(new URL(`/${ctx.input.fixtures.company.issuePrefix}/${kind}/${row.id}`, ctx.input.api.baseURL).href, { waitUntil: "domcontentloaded" });
        await expect(ctx.input.page.getByRole("heading", { name: row.name ?? row.title!, exact: true }).first()).toBeVisible();
        await ctx.input.evidence(`chat-catalog-archived-history-${kind}.json`, { id: row.id, actualUrl: ctx.input.page.url(), actualHeading: row.name ?? row.title });
      }
      await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
      await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    },
  };
}
