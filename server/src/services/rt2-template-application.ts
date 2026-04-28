import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  rt2CompanyTemplates,
  budgetPolicies,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import type {
  Rt2TemplateApplicationPreview,
  Rt2TemplateApplicationResult,
  Rt2TemplatePlanItem,
} from "@paperclipai/shared";

/**
 * M4.3: Apply a company template to create organizational structures
 *
 * Takes a template and creates:
 * - Budget policies from templateData.budgetPolicy
 * - Routines from templateData.workflows
 */
export async function applyTemplateToCompany(
  db: Db,
  templateId: string,
  targetCompanyId: string,
): Promise<Rt2TemplateApplicationResult> {
  const preview = await previewTemplateApplication(db, templateId, targetCompanyId);
  if (!preview) {
    return {
      success: false,
      templateId,
      templateName: "Unknown template",
      targetCompanyId,
      summary: { create: 0, skip: 0, error: 1 },
      items: [{
        kind: "agent_config",
        name: templateId,
        action: "error",
        reason: `Template ${templateId} not found`,
        existingId: null,
      }],
      errors: [`Template ${templateId} not found`],
      appliedAt: new Date().toISOString(),
    };
  }

  const [template] = await db
    .select()
    .from(rt2CompanyTemplates)
    .where(eq(rt2CompanyTemplates.id, templateId))
    .limit(1);

  if (!template) {
    return { ...preview, success: false, appliedAt: new Date().toISOString() };
  }

  const templateData = template.templateData;
  const items: Rt2TemplatePlanItem[] = [];

  if (preview.errors.length > 0) {
    return { ...preview, success: false, appliedAt: new Date().toISOString() };
  }

  const budgetPreview = preview.items.find((item) => item.kind === "budget_policy");
  if (templateData.budgetPolicy && budgetPreview?.action === "create") {
    try {
      const bp = templateData.budgetPolicy;
      const [companyBudget] = await db
        .insert(budgetPolicies)
        .values({
          companyId: targetCompanyId,
          scopeType: "company",
          scopeId: targetCompanyId,
          metric: "billed_cents",
          windowKind: "monthly",
          amount: bp.monthlyBudgetCents,
          warnPercent: bp.alertsAtPercent?.[0] ?? 80,
          hardStopEnabled: true,
          notifyEnabled: true,
          isActive: true,
        })
        .returning();

      items.push({ ...budgetPreview, createdId: companyBudget.id });
    } catch (error) {
      items.push({
        kind: "budget_policy",
        name: "Company monthly budget",
        action: "error",
        reason: `Failed to create budget policy: ${error}`,
        existingId: null,
      });
    }
  } else if (budgetPreview) {
    items.push(budgetPreview);
  }

  if (templateData.workflows && templateData.workflows.length > 0) {
    for (const workflow of templateData.workflows) {
      const workflowPreview = preview.items.find(
        (item) => item.kind === "routine" && item.name === workflow.name,
      );
      if (workflowPreview?.action !== "create") {
        if (workflowPreview) items.push(workflowPreview);
        continue;
      }
      try {
        const [routine] = await db
          .insert(routines)
          .values({
            companyId: targetCompanyId,
            title: workflow.name,
            description: `Template applied workflow: ${workflow.steps.join(" → ")}`,
            status: "active",
            priority: "medium",
            variables: [],
          })
          .returning();

        items.push({ ...workflowPreview, createdId: routine.id });

        await db
          .insert(routineTriggers)
          .values({
            companyId: targetCompanyId,
            routineId: routine.id,
            kind: "manual",
            label: workflow.name,
            enabled: true,
          })
          .returning();
      } catch (error) {
        items.push({
          kind: "routine",
          name: workflow.name,
          action: "error",
          reason: `Failed to create workflow ${workflow.name}: ${error}`,
          existingId: null,
        });
      }
    }
  }

  for (const item of preview.items) {
    if (item.kind !== "budget_policy" && item.kind !== "routine") {
      items.push(item);
    }
  }

  try {
    await db
      .update(rt2CompanyTemplates)
      .set({
        usageCount: template.usageCount + 1,
      })
      .where(eq(rt2CompanyTemplates.id, templateId));
  } catch (error) {
    // Non-critical, log but don't fail
    console.error("Failed to increment template usage:", error);
  }

  const summary = summarizeItems(items);
  const errors = items.filter((item) => item.action === "error").map((item) => item.reason);
  return {
    success: errors.length === 0,
    templateId,
    templateName: template.name,
    targetCompanyId,
    summary,
    items,
    errors,
    appliedAt: new Date().toISOString(),
  };
}

/**
 * M4.3: Preview what a template will create
 */
export async function previewTemplateApplication(
  db: Db,
  templateId: string,
  targetCompanyId: string,
): Promise<Rt2TemplateApplicationPreview | null> {
  const [template] = await db
    .select()
    .from(rt2CompanyTemplates)
    .where(eq(rt2CompanyTemplates.id, templateId))
    .limit(1);

  if (!template) {
    return null;
  }

  const items: Rt2TemplatePlanItem[] = [];
  if (!template.isPublic && template.authorCompanyId !== targetCompanyId) {
    items.push({
      kind: "agent_config",
      name: template.name,
      action: "error",
      reason: "Template is not accessible by this company",
      existingId: null,
    });
    return {
      templateId: template.id,
      templateName: template.name,
      targetCompanyId,
      summary: summarizeItems(items),
      items,
      errors: items.map((item) => item.reason),
    };
  }

  const td = template.templateData;
  if (td.budgetPolicy) {
    const [existingBudget] = await db
      .select({ id: budgetPolicies.id })
      .from(budgetPolicies)
      .where(and(
        eq(budgetPolicies.companyId, targetCompanyId),
        eq(budgetPolicies.scopeType, "company"),
        eq(budgetPolicies.scopeId, targetCompanyId),
        eq(budgetPolicies.metric, "billed_cents"),
        eq(budgetPolicies.windowKind, "monthly"),
      ))
      .limit(1);

    items.push({
      kind: "budget_policy",
      name: "Company monthly budget",
      action: existingBudget ? "skip" : "create",
      reason: existingBudget
        ? "A company monthly budget policy already exists."
        : `Create monthly budget policy with ${td.budgetPolicy.monthlyBudgetCents} cents limit.`,
      existingId: existingBudget?.id ?? null,
    });
  }

  for (const workflow of td.workflows ?? []) {
    const [existingRoutine] = await db
      .select({ id: routines.id })
      .from(routines)
      .where(and(eq(routines.companyId, targetCompanyId), eq(routines.title, workflow.name)))
      .limit(1);

    items.push({
      kind: "routine",
      name: workflow.name,
      action: existingRoutine ? "skip" : "create",
      reason: existingRoutine
        ? "A routine with the same name already exists."
        : `Create manual routine for ${workflow.steps.length} workflow steps.`,
      existingId: existingRoutine?.id ?? null,
    });
  }

  for (const skill of td.skills ?? []) {
    items.push({
      kind: "skill",
      name: skill,
      action: "skip",
      reason: "Skill attachment is preview-only in this template pass; runtime capabilities stay governed separately.",
      existingId: null,
    });
  }

  for (const department of td.departments ?? []) {
    items.push({
      kind: "department",
      name: department.name,
      action: "skip",
      reason: "Department objects are not materialized by the current RT2 rollout apply path.",
      existingId: null,
    });
  }

  for (const config of td.agentConfigs ?? []) {
    items.push({
      kind: "agent_config",
      name: config.role,
      action: "skip",
      reason: "Agent configs are reviewed here but created through the governed Jarvis/agent flow.",
      existingId: null,
    });
  }

  return {
    templateId: template.id,
    templateName: template.name,
    targetCompanyId,
    summary: summarizeItems(items),
    items,
    errors: items.filter((item) => item.action === "error").map((item) => item.reason),
  };
}

function summarizeItems(items: Rt2TemplatePlanItem[]) {
  return {
    create: items.filter((item) => item.action === "create").length,
    skip: items.filter((item) => item.action === "skip").length,
    error: items.filter((item) => item.action === "error").length,
  };
}
