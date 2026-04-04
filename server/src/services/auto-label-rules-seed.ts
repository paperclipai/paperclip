import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { autoLabelRules, companies, labels } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Default auto-label rules matching current hardcoded behavior.
 * These are seeded per-company when the rules engine is first enabled.
 */
const DEFAULT_RULES: Array<{
  name: string;
  description: string;
  triggerEvent: string;
  conditionExpression: string;
  action: string;
  labelName: string;
  labelColor: string;
  priority: number;
}> = [
  {
    name: "From Board",
    description: "Apply 'From Board' label when a board/user creates an issue",
    triggerEvent: "issue.created",
    conditionExpression: 'actor.type == "user"',
    action: "apply",
    labelName: "From Board",
    labelColor: "#0ea5e9",
    priority: 0,
  },
  {
    name: "Need Board",
    description: "Apply 'Need Board' label when issue is blocked on board",
    triggerEvent: "issue.updated",
    conditionExpression: 'issue.status == "blocked" && issue.blockedOn == "board"',
    action: "apply",
    labelName: "Need Board",
    labelColor: "#EF4444",
    priority: 10,
  },
  {
    name: "Remove Need Board",
    description: "Remove 'Need Board' label when issue is no longer blocked on board",
    triggerEvent: "issue.updated",
    conditionExpression: 'issue.blockedOn != "board"',
    action: "remove",
    labelName: "Need Board",
    labelColor: "#EF4444",
    priority: 11,
  },
  {
    name: "Board Comments",
    description: "Apply 'Board Comments' label when a board/user adds a comment",
    triggerEvent: "comment.created",
    conditionExpression: 'actor.type == "user"',
    action: "apply",
    labelName: "Board Comments",
    labelColor: "#6366f1",
    priority: 20,
  },
  {
    name: "Has PR",
    description: "Apply 'has-pr' label when a pull request work product is registered",
    triggerEvent: "work_product.registered",
    conditionExpression: 'workProduct.type == "pull_request"',
    action: "apply",
    labelName: "has-pr",
    labelColor: "#8B5CF6",
    priority: 30,
  },
];

/**
 * Seed default auto-label rules for a specific company.
 * Only seeds if the company has zero rules.
 */
export async function seedDefaultAutoLabelRules(db: Db, companyId: string): Promise<number> {
  // Check if rules already exist
  const [existing] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(autoLabelRules)
    .where(eq(autoLabelRules.companyId, companyId));

  if (existing && existing.count > 0) return 0;

  let seeded = 0;
  for (const rule of DEFAULT_RULES) {
    try {
      // Ensure the target label exists
      let [label] = await db
        .select({ id: labels.id })
        .from(labels)
        .where(
          sql`${labels.companyId} = ${companyId} AND ${labels.name} = ${rule.labelName}`,
        );

      if (!label) {
        [label] = await db
          .insert(labels)
          .values({ companyId, name: rule.labelName, color: rule.labelColor })
          .onConflictDoNothing()
          .returning({ id: labels.id });

        // Handle race condition
        if (!label) {
          [label] = await db
            .select({ id: labels.id })
            .from(labels)
            .where(
              sql`${labels.companyId} = ${companyId} AND ${labels.name} = ${rule.labelName}`,
            );
        }
      }

      if (!label) {
        logger.warn({ companyId, labelName: rule.labelName }, "failed to ensure label for seed rule");
        continue;
      }

      await db
        .insert(autoLabelRules)
        .values({
          companyId,
          name: rule.name,
          description: rule.description,
          triggerEvent: rule.triggerEvent,
          conditionExpression: rule.conditionExpression,
          action: rule.action,
          labelId: label.id,
          enabled: true,
          priority: rule.priority,
        })
        .onConflictDoNothing();

      seeded++;
    } catch (err) {
      logger.warn({ err, companyId, ruleName: rule.name }, "failed to seed default auto-label rule");
    }
  }

  return seeded;
}

/**
 * Seed default auto-label rules for ALL existing companies.
 * Called on startup when the feature flag is first enabled.
 */
export async function seedDefaultAutoLabelRulesForAllCompanies(db: Db): Promise<void> {
  const allCompanies = await db.select({ id: companies.id }).from(companies);

  for (const company of allCompanies) {
    const count = await seedDefaultAutoLabelRules(db, company.id);
    if (count > 0) {
      logger.info({ companyId: company.id, rulesSeeded: count }, "seeded default auto-label rules");
    }
  }
}
