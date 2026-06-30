import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyMemberships } from "@paperclipai/db";
import {
  pullRequestAssigneeRuleSchema,
  type IssueRootHumanRequester,
  type PullRequestAssigneeRule,
} from "@paperclipai/shared";
import { z } from "zod";
import { instanceSettingsService } from "./instance-settings.js";
import { issueRequesterService } from "./issue-requester.js";
import { normalizeUserId } from "./user-ids.js";

export type PullRequestAssigneeSource = "issue_tree_root_requester_rule";

/**
 * Board user id for Thomas. Kept in the server config/default layer — never in
 * the instance-agnostic `@paperclipai/shared` package — so a specific person's
 * id is not baked into a reusable type package. See TWX-1109.
 */
export const THOMAS_BOARD_USER_ID = "oiUyZpjYThWdccgNbKnHQjd7Zy1hl9Xw";

/**
 * Built-in instance default applied when `pullRequestAssigneeRules` is not
 * explicitly configured (neither instance settings nor the
 * `PAPERCLIP_PR_ASSIGNEE_RULES` env override): PRs from issue trees initiated by
 * Thomas are assigned to Thomas. Trees initiated by anyone else are left
 * untouched. Override or disable via instance general settings (an explicit
 * `[]` disables the rule entirely). See TWX-1103 / TWX-1102.
 */
export const DEFAULT_PULL_REQUEST_ASSIGNEE_RULES: readonly PullRequestAssigneeRule[] = [
  { rootRequesterUserId: THOMAS_BOARD_USER_ID, assigneeUserId: THOMAS_BOARD_USER_ID },
];

export interface PullRequestAssigneeResolution {
  /** Board user the PR should be assigned to. */
  userId: string;
  source: PullRequestAssigneeSource;
  /** Rootmost human requester of the issue tree that produced this PR. */
  rootRequesterUserId: string;
  /** Issue id where that human requester was resolved. */
  rootRequesterIssueId: string | null;
}

const envRulesSchema = z.array(pullRequestAssigneeRuleSchema);

/**
 * Reads the instance-wide override from `PAPERCLIP_PR_ASSIGNEE_RULES` (a JSON
 * array of `{ rootRequesterUserId, assigneeUserId }`). Returns null when unset
 * or malformed so resolution can fall back to the built-in default.
 */
function readEnvPullRequestAssigneeRules(): PullRequestAssigneeRule[] | null {
  const raw = process.env.PAPERCLIP_PR_ASSIGNEE_RULES;
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = envRulesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Effective rule list precedence:
 *   1. explicit instance general settings (`pullRequestAssigneeRules`, including
 *      an empty array which disables the feature),
 *   2. the `PAPERCLIP_PR_ASSIGNEE_RULES` env override,
 *   3. the built-in `DEFAULT_PULL_REQUEST_ASSIGNEE_RULES` (Thomas -> Thomas).
 */
export function getEffectivePullRequestAssigneeRules(
  settingsRules: PullRequestAssigneeRule[] | null | undefined,
): PullRequestAssigneeRule[] {
  if (Array.isArray(settingsRules)) return settingsRules;
  const envRules = readEnvPullRequestAssigneeRules();
  if (envRules) return envRules;
  return [...DEFAULT_PULL_REQUEST_ASSIGNEE_RULES];
}

async function isActiveCompanyUser(db: Db, args: {
  companyId: string;
  userId: string;
}): Promise<boolean> {
  const membership = await db
    .select({ id: companyMemberships.id })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, args.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, args.userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return membership != null;
}

/**
 * Resolves the board user a pull request should be assigned to, per the
 * instance-wide PR assignment rules, based on the rootmost human requester of
 * the PR's issue tree.
 *
 * Returns null (preserve existing behavior) when: there is no human root
 * requester, no rule matches that requester, or the matched assignee is not an
 * active member of the PR's company (company-boundary guard).
 *
 * Pass `rules` to bypass settings/env resolution (used in tests).
 */
export async function resolvePullRequestAssignee(db: Db, args: {
  companyId: string;
  issueId: string;
  rules?: PullRequestAssigneeRule[];
}): Promise<PullRequestAssigneeResolution | null> {
  const rootRequester = await issueRequesterService(db).resolveRootHumanRequesterForIssue({
    companyId: args.companyId,
    issueId: args.issueId,
  });
  return resolvePullRequestAssigneeForRootRequester(db, {
    companyId: args.companyId,
    rootRequester,
    rules: args.rules,
  });
}

/**
 * Variant that takes an already-resolved root human requester (e.g. from the
 * heartbeat-context projection) to avoid re-walking the issue parent chain.
 */
export async function resolvePullRequestAssigneeForRootRequester(db: Db, args: {
  companyId: string;
  rootRequester: IssueRootHumanRequester | null;
  rules?: PullRequestAssigneeRule[];
}): Promise<PullRequestAssigneeResolution | null> {
  const rootRequesterUserId = normalizeUserId(args.rootRequester?.userId);
  if (!args.rootRequester || !rootRequesterUserId) return null;

  const rules = args.rules
    ?? getEffectivePullRequestAssigneeRules(
      (await instanceSettingsService(db).getGeneral()).pullRequestAssigneeRules,
    );

  const matched = rules.find(
    (rule) => normalizeUserId(rule.rootRequesterUserId) === rootRequesterUserId,
  );
  const assigneeUserId = normalizeUserId(matched?.assigneeUserId);
  if (!matched || !assigneeUserId) return null;

  // Company-boundary guard: never assign a PR to a user who is not an active
  // member of that PR's company.
  if (!(await isActiveCompanyUser(db, { companyId: args.companyId, userId: assigneeUserId }))) {
    return null;
  }

  return {
    userId: assigneeUserId,
    source: "issue_tree_root_requester_rule",
    rootRequesterUserId,
    rootRequesterIssueId: args.rootRequester.issueId ?? null,
  };
}
