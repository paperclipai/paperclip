import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, issueComments, issues } from "@paperclipai/db";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { logger } from "../middleware/logger.js";
import {
  DEFAULT_SHOPIFY_ROUTER_CONFIG,
  type ShopifyRouterConfig,
} from "./shopify-skill-router.config.js";

export interface ShopifyRouterInput {
  issueTitle: string;
  issueDescription: string | null;
  commentBodies: string[];
  ancestorTitles: string[];
  agentRole: string | null;
  agentCapabilities: string | null;
  goalTitle: string | null;
  projectTags: string[];
}

export interface ShopifyRouterOutput {
  skillKeys: string[];
  matchedRules: string[];
  gated: boolean;
}

// Explicit per-run `skill://...` overrides are intentionally out of scope here.
// Operators can use persistent desiredSkills or extend the router rules instead.
export async function resolveRoutedShopifySkillKeys(args: {
  db: Db;
  companyId: string;
  issueId: string;
  agent: { role: string | null; capabilities: string | null };
}): Promise<ShopifyRouterOutput> {
  try {
    const issue = await args.db
      .select({
        title: issues.title,
        description: issues.description,
        goalId: issues.goalId,
        parentId: issues.parentId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, args.companyId), eq(issues.id, args.issueId)))
      .then((rows) => rows[0] ?? null);

    if (!issue) {
      return { skillKeys: [], matchedRules: [], gated: true };
    }

    const recentComments = await args.db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.companyId, args.companyId), eq(issueComments.issueId, args.issueId)))
      .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
      .limit(50);

    const ancestorTitles: string[] = [];
    let currentParentId = issue.parentId ?? null;
    let depth = 0;
    while (currentParentId && depth < 5) {
      const parent = await args.db
        .select({
          title: issues.title,
          parentId: issues.parentId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, args.companyId), eq(issues.id, currentParentId)))
        .then((rows) => rows[0] ?? null);
      if (!parent) break;
      ancestorTitles.push(parent.title);
      currentParentId = parent.parentId ?? null;
      depth += 1;
    }

    const goalTitle = issue.goalId
      ? await args.db
        .select({ title: goals.title })
        .from(goals)
        .where(and(eq(goals.companyId, args.companyId), eq(goals.id, issue.goalId)))
        .then((rows) => rows[0]?.title ?? null)
      : null;

    return routeShopifySkillKeys({
      issueTitle: issue.title,
      issueDescription: issue.description ?? null,
      commentBodies: recentComments.map((comment) => comment.body).reverse(),
      ancestorTitles,
      agentRole: args.agent.role,
      agentCapabilities: args.agent.capabilities,
      goalTitle,
      projectTags: [],
    });
  } catch (error) {
    logger.warn(
      {
        companyId: args.companyId,
        issueId: args.issueId,
        err: error,
      },
      "Failed to resolve routed Shopify skill keys",
    );
    return { skillKeys: [], matchedRules: [], gated: true };
  }
}

export function routeShopifySkillKeys(
  input: ShopifyRouterInput,
  config: ShopifyRouterConfig = DEFAULT_SHOPIFY_ROUTER_CONFIG,
): ShopifyRouterOutput {
  const haystack = [
    input.issueTitle,
    input.issueDescription ?? "",
    input.commentBodies.join("\n"),
    input.ancestorTitles.join("\n"),
    input.goalTitle ?? "",
    input.agentCapabilities ?? "",
  ].join("\n");
  const tagHaystack = input.projectTags.join("\n");
  const gateMatches = config.gateRegex.test(haystack) || config.gateRegex.test(tagHaystack);
  config.gateRegex.lastIndex = 0;
  if (!gateMatches) {
    return { skillKeys: [], matchedRules: [], gated: true };
  }

  const matchedRules = config.rules.filter((rule) => {
    const matched = rule.pattern.test(haystack);
    rule.pattern.lastIndex = 0;
    return matched;
  });

  const scoredKeys = new Map<string, { priority: number; order: number }>();
  scoredKeys.set(config.baselineSkillKey, { priority: Number.MAX_SAFE_INTEGER, order: -1 });

  for (const [ruleOrder, rule] of matchedRules.entries()) {
    for (const key of rule.skillKeys) {
      const previous = scoredKeys.get(key);
      if (!previous || previous.priority < rule.priority) {
        scoredKeys.set(key, { priority: rule.priority, order: ruleOrder });
      }
    }
  }

  const skillKeys = Array.from(scoredKeys.entries())
    .sort((a, b) => {
      if (b[1].priority !== a[1].priority) return b[1].priority - a[1].priority;
      return a[1].order - b[1].order;
    })
    .slice(0, config.cap)
    .map(([key]) => key);

  return {
    skillKeys,
    matchedRules: matchedRules.map((rule) => rule.id),
    gated: false,
  };
}

export async function resolveRoutedShopifyConfig(args: {
  db: Db;
  companyId: string;
  issueId: string | null;
  agent: { role: string | null; capabilities: string | null };
  resolvedConfig: Record<string, unknown>;
  onWarning?: (message: string) => Promise<void> | void;
  resolver?: typeof resolveRoutedShopifySkillKeys;
}): Promise<{ config: Record<string, unknown>; routing: ShopifyRouterOutput }> {
  if (!args.issueId) {
    return {
      config: args.resolvedConfig,
      routing: { skillKeys: [], matchedRules: [], gated: true },
    };
  }

  try {
    const resolver = args.resolver ?? resolveRoutedShopifySkillKeys;
    const routing = await resolver({
      db: args.db,
      companyId: args.companyId,
      issueId: args.issueId,
      agent: args.agent,
    });
    if (routing.skillKeys.length === 0) {
      return { config: args.resolvedConfig, routing };
    }

    const baseDesiredSkills = readPaperclipSkillSyncPreference(args.resolvedConfig).desiredSkills;
    const mergedDesiredSkills = Array.from(new Set([...baseDesiredSkills, ...routing.skillKeys]));
    return {
      config: writePaperclipSkillSyncPreference(args.resolvedConfig, mergedDesiredSkills),
      routing,
    };
  } catch (error) {
    await args.onWarning?.(
      `[paperclip] Shopify skill router warning: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return {
      config: args.resolvedConfig,
      routing: { skillKeys: [], matchedRules: [], gated: true },
    };
  }
}
