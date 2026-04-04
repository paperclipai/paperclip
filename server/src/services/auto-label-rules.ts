import { eq, and, asc, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  autoLabelRules,
  autoLabelRuleExecutions,
  labels,
  issueLabels,
  issues,
} from "@paperclipai/db";
import type { CreateAutoLabelRule, UpdateAutoLabelRule } from "@paperclipai/shared";
import type { AutoLabelTriggerEvent, AutoLabelRuleAction } from "@paperclipai/shared";
import {
  evaluateCelExpression,
  validateCelExpression,
  buildCelContext,
  type CelContext,
} from "./cel-evaluator.js";
import { logger } from "../middleware/logger.js";

export function autoLabelRulesService(db: Db) {
  return {
    /** List all rules for a company, ordered by priority ascending. */
    list: async (companyId: string) => {
      return db
        .select()
        .from(autoLabelRules)
        .where(eq(autoLabelRules.companyId, companyId))
        .orderBy(asc(autoLabelRules.priority), asc(autoLabelRules.createdAt));
    },

    /** Get a single rule by id. */
    getById: async (ruleId: string) => {
      const [rule] = await db
        .select()
        .from(autoLabelRules)
        .where(eq(autoLabelRules.id, ruleId));
      return rule ?? null;
    },

    /** Create a new rule. */
    create: async (
      companyId: string,
      data: CreateAutoLabelRule,
      actor: { userId?: string; agentId?: string },
    ) => {
      // Validate CEL expression syntax
      const parseError = validateCelExpression(data.conditionExpression);
      if (parseError) {
        throw new Error(`Invalid CEL expression: ${parseError}`);
      }

      const [rule] = await db
        .insert(autoLabelRules)
        .values({
          companyId,
          name: data.name,
          description: data.description ?? null,
          triggerEvent: data.triggerEvent,
          conditionExpression: data.conditionExpression,
          action: data.action,
          labelId: data.labelId,
          enabled: data.enabled,
          priority: data.priority,
          createdByUserId: actor.userId ?? null,
          createdByAgentId: actor.agentId ?? null,
        })
        .returning();
      return rule;
    },

    /** Update an existing rule. */
    update: async (ruleId: string, data: UpdateAutoLabelRule) => {
      // If conditionExpression is being updated, validate it
      if (data.conditionExpression !== undefined) {
        const parseError = validateCelExpression(data.conditionExpression);
        if (parseError) {
          throw new Error(`Invalid CEL expression: ${parseError}`);
        }
      }

      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) patch.name = data.name;
      if (data.description !== undefined) patch.description = data.description;
      if (data.triggerEvent !== undefined) patch.triggerEvent = data.triggerEvent;
      if (data.conditionExpression !== undefined) patch.conditionExpression = data.conditionExpression;
      if (data.action !== undefined) patch.action = data.action;
      if (data.labelId !== undefined) patch.labelId = data.labelId;
      if (data.enabled !== undefined) patch.enabled = data.enabled;
      if (data.priority !== undefined) patch.priority = data.priority;

      const [updated] = await db
        .update(autoLabelRules)
        .set(patch)
        .where(eq(autoLabelRules.id, ruleId))
        .returning();
      return updated ?? null;
    },

    /** Delete a rule. */
    delete: async (ruleId: string) => {
      const [deleted] = await db
        .delete(autoLabelRules)
        .where(eq(autoLabelRules.id, ruleId))
        .returning();
      return deleted ?? null;
    },

    /** List executions for a specific rule. */
    listExecutions: async (ruleId: string, limit = 50) => {
      return db
        .select()
        .from(autoLabelRuleExecutions)
        .where(eq(autoLabelRuleExecutions.ruleId, ruleId))
        .orderBy(desc(autoLabelRuleExecutions.createdAt))
        .limit(limit);
    },

    /**
     * Dry-run a rule against a specific issue without applying any changes.
     * Returns the evaluation result.
     */
    dryRun: async (ruleId: string, issueId: string) => {
      const [rule] = await db
        .select()
        .from(autoLabelRules)
        .where(eq(autoLabelRules.id, ruleId));
      if (!rule) return { error: "Rule not found" };

      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId));
      if (!issue) return { error: "Issue not found" };

      const context = buildCelContext({
        eventType: rule.triggerEvent,
        issue: issue as unknown as Record<string, unknown>,
        actor: { type: "user", id: "dry-run" },
      });

      const result = evaluateCelExpression(rule.conditionExpression, context);

      return {
        rule: { id: rule.id, name: rule.name, conditionExpression: rule.conditionExpression },
        issue: { id: issue.id, identifier: (issue as any).identifier, title: issue.title },
        conditionResult: result.value,
        wouldApplyAction: result.value ? rule.action : null,
        evaluationError: result.error ?? null,
      };
    },

    /**
     * Evaluate all enabled rules for a company matching a trigger event,
     * and apply label actions. This is the core rules engine entry point.
     */
    evaluateRules: async (opts: {
      companyId: string;
      triggerEvent: AutoLabelTriggerEvent;
      issueId: string;
      issue: Record<string, unknown>;
      actor: { type: "user" | "agent"; id: string };
      workProduct?: Record<string, unknown>;
      comment?: Record<string, unknown>;
    }) => {
      // Load enabled rules matching the trigger event
      const rules = await db
        .select()
        .from(autoLabelRules)
        .where(
          and(
            eq(autoLabelRules.companyId, opts.companyId),
            eq(autoLabelRules.triggerEvent, opts.triggerEvent),
            eq(autoLabelRules.enabled, true),
          ),
        )
        .orderBy(asc(autoLabelRules.priority), asc(autoLabelRules.createdAt));

      if (rules.length === 0) return [];

      const context = buildCelContext({
        eventType: opts.triggerEvent,
        issue: opts.issue,
        actor: opts.actor,
        workProduct: opts.workProduct,
        comment: opts.comment,
      });

      const results: Array<{
        ruleId: string;
        ruleName: string;
        conditionResult: boolean;
        actionTaken: string | null;
        error?: string;
      }> = [];

      for (const rule of rules) {
        const evalResult = evaluateCelExpression(rule.conditionExpression, context);
        const conditionResult = Boolean(evalResult.value);
        let actionTaken: string | null = null;

        if (evalResult.error) {
          logger.warn(
            { ruleId: rule.id, issueId: opts.issueId, error: evalResult.error },
            "auto-label rule CEL evaluation error",
          );
        }

        if (conditionResult) {
          try {
            actionTaken = await applyRuleAction(
              db,
              rule.action as AutoLabelRuleAction,
              rule.labelId,
              opts.issueId,
              opts.companyId,
            );
          } catch (err) {
            logger.warn(
              { err, ruleId: rule.id, issueId: opts.issueId },
              "failed to apply auto-label rule action",
            );
            actionTaken = `error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // Record execution in audit log
        try {
          await db.insert(autoLabelRuleExecutions).values({
            ruleId: rule.id,
            issueId: opts.issueId,
            triggerEventType: opts.triggerEvent,
            conditionResult,
            actionTaken,
          });
        } catch (err) {
          logger.warn({ err, ruleId: rule.id }, "failed to record auto-label rule execution");
        }

        results.push({
          ruleId: rule.id,
          ruleName: rule.name,
          conditionResult,
          actionTaken,
          error: evalResult.error,
        });
      }

      return results;
    },
  };
}

/**
 * Apply a label action (apply/remove/toggle) to an issue.
 * Returns a description of what was done.
 */
async function applyRuleAction(
  db: Db,
  action: AutoLabelRuleAction,
  labelId: string,
  issueId: string,
  companyId: string,
): Promise<string> {
  const hasLabel = await db
    .select({ issueId: issueLabels.issueId })
    .from(issueLabels)
    .where(and(eq(issueLabels.issueId, issueId), eq(issueLabels.labelId, labelId)))
    .then((rows) => rows.length > 0);

  switch (action) {
    case "apply": {
      if (hasLabel) return "already_applied";
      await db
        .insert(issueLabels)
        .values({ issueId, labelId, companyId })
        .onConflictDoNothing();
      return "applied";
    }
    case "remove": {
      if (!hasLabel) return "already_removed";
      await db
        .delete(issueLabels)
        .where(and(eq(issueLabels.issueId, issueId), eq(issueLabels.labelId, labelId)));
      return "removed";
    }
    case "toggle": {
      if (hasLabel) {
        await db
          .delete(issueLabels)
          .where(and(eq(issueLabels.issueId, issueId), eq(issueLabels.labelId, labelId)));
        return "toggled_off";
      } else {
        await db
          .insert(issueLabels)
          .values({ issueId, labelId, companyId })
          .onConflictDoNothing();
        return "toggled_on";
      }
    }
    default:
      return `unknown_action:${action}`;
  }
}
