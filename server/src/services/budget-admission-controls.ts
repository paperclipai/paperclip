import { and, eq } from "drizzle-orm";
import { companies, projects, type Db } from "@paperclipai/db";
import { notFound } from "../errors.js";

/** Shared execution-authority fences allow concurrent admissions. Acquire
 * before feature/agent/run locks; they exclude manual pause/delete until this
 * admission commits. Settlements and eligibility-only reads never call this. */
export async function lockBudgetAdmissionControls(tx: Db, companyId: string, projectId?: string | null) {
  const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("share");
  if (!company) throw notFound("Company not found");
  if (projectId) {
    const [project] = await tx.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId))).for("share");
    if (!project) throw notFound("Budget project not found");
  }
}
