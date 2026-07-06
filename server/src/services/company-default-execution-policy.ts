import type { Db } from "@paperclipai/db";
import { and, desc, eq, ilike, ne } from "drizzle-orm";
import { agents, companies } from "@paperclipai/db";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

const VERIFIER_SENTINEL = "$COMPANY_VERIFIER";

interface ResolvedCompanySettings {
  defaultExecutionPolicy: IssueExecutionPolicy | null;
}

/**
 * Resolves $COMPANY_VERIFIER sentinel to the company's active Verifier agent.
 * Returns the resolved policy, or null if sentinel cannot be resolved.
 * If the policy contains the unresolved sentinel, logs a warning and returns null.
 */
export async function resolveCompanyDefaultExecutionPolicy(
  db: Db,
  companyId: string,
  policy: IssueExecutionPolicy | null,
): Promise<IssueExecutionPolicy | null> {
  if (!policy) return null;

  // Check if any participants contain the unresolved sentinel
  const hasUnresolvedSentinel = policy.stages.some((stage) =>
    stage.participants.some((participant) => participant.agentId === VERIFIER_SENTINEL)
  );

  if (!hasUnresolvedSentinel) {
    return policy;
  }

  // Try to resolve the Verifier agent
  const verifier = await findCompanyVerifier(db, companyId);

  if (!verifier) {
    logger.warn(
      `[default-execution-policy] Company ${companyId} policy contains $COMPANY_VERIFIER sentinel but no active Verifier agent found`,
    );
    return null;
  }

  // Replace the sentinel with the actual agent ID
  const resolvedPolicy: IssueExecutionPolicy = {
    ...policy,
    stages: policy.stages.map((stage) => ({
      ...stage,
      participants: stage.participants.map((participant) => ({
        ...participant,
        agentId:
          participant.agentId === VERIFIER_SENTINEL && participant.type === "agent"
            ? verifier.id
            : participant.agentId,
      })),
    })),
  };

  logger.debug(
    `[default-execution-policy] Resolved $COMPANY_VERIFIER to ${verifier.id} for company ${companyId}`,
  );

  return resolvedPolicy;
}

/**
 * Finds the company's active Verifier agent (named like 'Verifier%').
 * Returns the most recent non-terminated agent matching the pattern.
 */
async function findCompanyVerifier(db: Db, companyId: string) {
  const result = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        ilike(agents.name, "Verifier%"),
        ne(agents.status, "terminated"),
      ),
    )
    .orderBy(desc(agents.createdAt))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Reads the company's default execution policy from settings.
 */
export async function readCompanyDefaultExecutionPolicy(
  db: Db,
  companyId: string,
): Promise<IssueExecutionPolicy | null> {
  const result = await db.select().from(companies).where(eq(companies.id, companyId));
  const company = result[0];

  if (!company) {
    return null;
  }

  const settings = (company.settings as Record<string, unknown>) || {};
  const policy = settings.defaultExecutionPolicy;

  if (!policy) {
    return null;
  }

  // The policy in settings is the raw template; validate + resolve it
  try {
    const normalized = normalizeIssueExecutionPolicy(policy);
    if (!normalized) return null;

    // Resolve any sentinels
    return await resolveCompanyDefaultExecutionPolicy(db, companyId, normalized);
  } catch (err) {
    logger.warn(
      `[default-execution-policy] Failed to process company ${companyId} default policy: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Applies the company default execution policy to an incoming issue creation policy.
 * Returns the policy to use for issue creation, or null if no policy should be applied.
 *
 * Rules:
 * - If createInputPolicy is explicitly null, skip default (escape hatch)
 * - If createInputPolicy is undefined and company has a default, apply it (if issue type is work)
 * - Otherwise return the createInputPolicy as-is
 */
export async function applyCompanyDefaultExecutionPolicy(
  db: Db,
  companyId: string,
  createInputPolicy: IssueExecutionPolicy | null | undefined,
  issueType: string | null | undefined,
): Promise<IssueExecutionPolicy | null> {
  // Escape hatch: explicit null in input
  if (createInputPolicy === null) {
    return null;
  }

  // If explicit policy provided, use it
  if (createInputPolicy !== undefined) {
    return createInputPolicy;
  }

  // Check if this is a work-type issue
  if (!isWorkTypeIssue(issueType)) {
    return null;
  }

  // No explicit policy; try to apply company default
  const defaultPolicy = await readCompanyDefaultExecutionPolicy(db, companyId);
  if (defaultPolicy) {
    logger.info(
      `[default-execution-policy] Applied company default policy to issue (company=${companyId}, type=${issueType})`,
    );
  }
  return defaultPolicy;
}

/**
 * Determines if an issue type should be subject to default execution policy.
 * Work types: build, implement, content, or undefined (default to work).
 */
function isWorkTypeIssue(issueType: string | null | undefined): boolean {
  if (!issueType || issueType === "build" || issueType === "implement" || issueType === "content") {
    return true;
  }
  return false;
}
