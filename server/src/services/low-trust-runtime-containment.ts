import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import type { TrustPresetResolution } from "./trust-preset-resolver.js";
import {
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH,
  isIssueWithinLowTrustBoundary,
} from "./trust-preset-resolver.js";

export const LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS = "runtime.manage";

export function isLowTrustRuntimeManagementAllowed(resolution: TrustPresetResolution) {
  return resolution.kind === "low_trust_review" &&
    (resolution.boundary.allowedToolClasses ?? []).includes(LOW_TRUST_RUNTIME_MANAGEMENT_TOOL_CLASS);
}

async function issueIdIsDescendantOf(db: Db, issueId: string, rootIssueId: string, companyId: string) {
  let cursor: string | null = issueId;
  // Keep the runtime preflight aligned with authorization while bounding DB work.
  for (let depth = 0; cursor && depth < LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH; depth += 1) {
    if (cursor === rootIssueId) return true;
    const row: { id: string; companyId: string; parentId: string | null } | null = await db
      .select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId })
      .from(issues)
      .where(eq(issues.id, cursor))
      .then((rows) => rows[0] ?? null);
    if (!row || row.companyId !== companyId) return false;
    cursor = row.parentId;
  }
  return false;
}

async function workspaceIssueWithinLowTrustBoundary(input: {
  db?: Db;
  boundary: Extract<TrustPresetResolution, { kind: "low_trust_review" }>["boundary"];
  issue: { companyId: string; id?: string | null; projectId?: string | null };
}) {
  if (isIssueWithinLowTrustBoundary(input.boundary, input.issue)) return true;
  if (!input.db || !input.issue.id || !input.boundary.rootIssueId) return false;
  return issueIdIsDescendantOf(input.db, input.issue.id, input.boundary.rootIssueId, input.boundary.companyId);
}

export async function assertLowTrustWorkspaceIsolation(input: {
  db?: Db;
  resolution: TrustPresetResolution;
  isolatedWorkspacesEnabled: boolean;
  effectiveExecutionWorkspaceMode: string | null | undefined;
  selectedEnvironmentDriver: string | null | undefined;
  issue: { companyId: string; id?: string | null; projectId?: string | null } | null;
}) {
  if (input.resolution.kind === "denied") {
    throw unprocessable(input.resolution.detail, {
      code: input.resolution.reason,
      source: input.resolution.source,
    });
  }
  if (input.resolution.kind !== "low_trust_review") return;

  if (!input.isolatedWorkspacesEnabled) {
    throw unprocessable("Low-trust execution requires isolated workspaces to be enabled.", {
      code: "low_trust_isolation_unavailable",
    });
  }
  if (input.effectiveExecutionWorkspaceMode !== "isolated_workspace") {
    throw unprocessable("Low-trust execution requires an isolated execution workspace.", {
      code: "low_trust_requires_isolated_workspace",
    });
  }
  if (
    !input.issue ||
    !(await workspaceIssueWithinLowTrustBoundary({
      db: input.db,
      boundary: input.resolution.boundary,
      issue: input.issue,
    }))
  ) {
    throw unprocessable("Low-trust execution issue is outside the active trust boundary.", {
      code: "low_trust_boundary_mismatch",
    });
  }
  if (input.selectedEnvironmentDriver !== "sandbox") {
    throw unprocessable("Low-trust execution requires a sandbox environment driver.", {
      code: "low_trust_requires_sandbox_environment",
    });
  }
}

export function assertLowTrustRuntimeServicesAllowed(input: {
  resolution: TrustPresetResolution;
  runtimeServiceCount: number;
}) {
  if (input.resolution.kind === "denied") {
    throw unprocessable(input.resolution.detail, {
      code: input.resolution.reason,
      source: input.resolution.source,
    });
  }
  if (input.resolution.kind !== "low_trust_review") return;
  if (input.runtimeServiceCount === 0) return;
  if (isLowTrustRuntimeManagementAllowed(input.resolution)) return;
  throw unprocessable("Low-trust execution cannot start runtime services unless the boundary grants runtime.manage.", {
    code: "low_trust_runtime_services_denied",
  });
}
