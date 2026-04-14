import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, issues, projects } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";

export type ExecutionBlockCode =
  | "company_paused_manual"
  | "company_paused_budget"
  | "company_budget_hard_stop"
  | "project_paused_manual"
  | "project_paused_budget"
  | "project_budget_hard_stop"
  | "agent_paused_budget"
  | "agent_budget_hard_stop";

export type ExecutionBlock = {
  code: ExecutionBlockCode;
  scopeType: "company" | "agent" | "project";
  scopeId: string;
  scopeName: string;
  message: string;
  skipReason: "company.paused" | "project.paused" | "budget.blocked";
};

type ExecutionContext = {
  issueId?: string | null;
  projectId?: string | null;
};

export function executionGateService(db: Db) {
  const budgets = budgetService(db);

  async function resolveProjectId(companyId: string, context?: ExecutionContext) {
    const explicitProjectId = context?.projectId?.trim();
    if (explicitProjectId) return explicitProjectId;

    const issueId = context?.issueId?.trim();
    if (!issueId) return null;

    const issue = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    if (!issue) return null;
    return issue.projectId;
  }

  return {
    getExecutionBlock: async (
      companyId: string,
      agentId: string,
      context?: ExecutionContext,
    ): Promise<ExecutionBlock | null> => {
      const agent = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");

      const company = await db
        .select({
          id: companies.id,
          name: companies.name,
          status: companies.status,
          pauseReason: companies.pauseReason,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      if (company.status === "paused") {
        return {
          code: company.pauseReason === "budget" ? "company_paused_budget" : "company_paused_manual",
          scopeType: "company",
          scopeId: company.id,
          scopeName: company.name,
          message:
            company.pauseReason === "budget"
              ? "Company is paused because its budget hard-stop was reached."
              : "Company is paused and cannot start new work.",
          skipReason: company.pauseReason === "budget" ? "budget.blocked" : "company.paused",
        };
      }

      const projectId = await resolveProjectId(companyId, context);
      if (projectId) {
        const project = await db
          .select({
            id: projects.id,
            companyId: projects.companyId,
            name: projects.name,
            pauseReason: projects.pauseReason,
            pausedAt: projects.pausedAt,
          })
          .from(projects)
          .where(eq(projects.id, projectId))
          .then((rows) => rows[0] ?? null);

        if (project && project.companyId === companyId && project.pausedAt) {
          return {
            code: project.pauseReason === "budget" ? "project_paused_budget" : "project_paused_manual",
            scopeType: "project",
            scopeId: project.id,
            scopeName: project.name,
            message:
              project.pauseReason === "budget"
                ? "Project is paused because its budget hard-stop was reached."
                : "Project is paused and cannot start new work.",
            skipReason: project.pauseReason === "budget" ? "budget.blocked" : "project.paused",
          };
        }
      }

      const budgetBlock = await budgets.getInvocationBlock(companyId, agentId, {
        issueId: context?.issueId ?? null,
        projectId,
      });
      if (!budgetBlock) return null;

      if (budgetBlock.scopeType === "company") {
        return {
          code: "company_budget_hard_stop",
          scopeType: "company",
          scopeId: budgetBlock.scopeId,
          scopeName: budgetBlock.scopeName,
          message: budgetBlock.reason,
          skipReason: "budget.blocked",
        };
      }

      if (budgetBlock.scopeType === "project") {
        return {
          code: "project_budget_hard_stop",
          scopeType: "project",
          scopeId: budgetBlock.scopeId,
          scopeName: budgetBlock.scopeName,
          message: budgetBlock.reason,
          skipReason: "budget.blocked",
        };
      }

      return {
        code: budgetBlock.reason.includes("paused because")
          ? "agent_paused_budget"
          : "agent_budget_hard_stop",
        scopeType: "agent",
        scopeId: budgetBlock.scopeId,
        scopeName: budgetBlock.scopeName,
        message: budgetBlock.reason,
        skipReason: "budget.blocked",
      };
    },
  };
}
