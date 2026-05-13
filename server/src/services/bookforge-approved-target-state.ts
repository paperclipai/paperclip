import { existsSync, readFileSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { bookforgeApprovedTargets } from "@paperclipai/db";

export type BookforgeApprovedTargetSource = "db" | "json_file" | "env";

export interface BookforgeApprovedTargetPolicy {
  yaml?: string | null;
  itemId?: string | null;
  projectName?: string | null;
}

export interface BookforgeApprovedTargetRecord extends BookforgeApprovedTargetPolicy {
  id: string;
  status: string;
  source: BookforgeApprovedTargetSource;
  approvedAt?: string | null;
  expiresAt?: string | null;
  approvalIssueId?: string | null;
  approvalCommentId?: string | null;
}

export interface BookforgeApprovedTargetConflict {
  field: "yaml" | "itemId" | "projectName";
  dbValue?: string | null;
  jsonFileValue?: string | null;
  envValue?: string | null;
}

export interface BookforgeApprovedTargetState {
  authority: "db" | "none_read_only";
  status: "missing" | "proposed_stale_check_needed" | "mismatch_blocked" | "active" | "active_with_stale_config_warning";
  activeTarget: BookforgeApprovedTargetRecord | null;
  candidateTarget: (BookforgeApprovedTargetPolicy & { source: BookforgeApprovedTargetSource; filePath?: string | null }) | null;
  warnings: string[];
  stopConditions: string[];
  conflicts: BookforgeApprovedTargetConflict[];
  approvedTargetFilePath: string | null;
}

function clean(value: string | null | undefined) {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : null;
}

export function normalizeBookforgeApprovedTargetPolicy(
  target: BookforgeApprovedTargetPolicy | null | undefined,
): Required<BookforgeApprovedTargetPolicy> {
  return {
    yaml: clean(target?.yaml),
    itemId: clean(target?.itemId),
    projectName: clean(target?.projectName),
  };
}

function hasAnyTargetField(target: BookforgeApprovedTargetPolicy | null | undefined) {
  const normalized = normalizeBookforgeApprovedTargetPolicy(target);
  return Boolean(normalized.yaml || normalized.itemId || normalized.projectName);
}

function compareTargets(input: {
  dbTarget?: BookforgeApprovedTargetPolicy | null;
  jsonFileTarget?: BookforgeApprovedTargetPolicy | null;
  envTarget?: BookforgeApprovedTargetPolicy | null;
}) {
  const conflicts: BookforgeApprovedTargetConflict[] = [];
  const dbTarget = normalizeBookforgeApprovedTargetPolicy(input.dbTarget);
  const jsonFileTarget = normalizeBookforgeApprovedTargetPolicy(input.jsonFileTarget);
  const envTarget = normalizeBookforgeApprovedTargetPolicy(input.envTarget);
  for (const field of ["yaml", "itemId", "projectName"] as const) {
    if (dbTarget[field] && jsonFileTarget[field] && dbTarget[field] !== jsonFileTarget[field]) {
      conflicts.push({ field, dbValue: dbTarget[field], jsonFileValue: jsonFileTarget[field] });
    }
    if (dbTarget[field] && envTarget[field] && dbTarget[field] !== envTarget[field]) {
      conflicts.push({ field, dbValue: dbTarget[field], envValue: envTarget[field] });
    }
    if (!dbTarget[field] && jsonFileTarget[field] && envTarget[field] && jsonFileTarget[field] !== envTarget[field]) {
      conflicts.push({ field, jsonFileValue: jsonFileTarget[field], envValue: envTarget[field] });
    }
  }
  return conflicts;
}

export function buildBookforgeApprovedTargetState(input: {
  dbTarget?: BookforgeApprovedTargetRecord | null;
  jsonFileTarget?: BookforgeApprovedTargetPolicy | null;
  envTarget?: BookforgeApprovedTargetPolicy | null;
  approvedTargetFilePath?: string | null;
}): BookforgeApprovedTargetState {
  const warnings = new Set<string>();
  const stopConditions = new Set<string>();
  const conflicts = compareTargets(input);
  const dbTarget = input.dbTarget ?? null;
  const jsonFileTarget = hasAnyTargetField(input.jsonFileTarget)
    ? normalizeBookforgeApprovedTargetPolicy(input.jsonFileTarget)
    : null;
  const envTarget = hasAnyTargetField(input.envTarget) ? normalizeBookforgeApprovedTargetPolicy(input.envTarget) : null;

  if (conflicts.length > 0) {
    stopConditions.add("stale_target_config_conflict");
  }

  if (dbTarget && dbTarget.status === "active") {
    if (conflicts.some((conflict) => conflict.dbValue)) {
      if (conflicts.some((conflict) => conflict.jsonFileValue !== undefined)) {
        warnings.add("db_json_target_conflict");
      }
      if (conflicts.some((conflict) => conflict.envValue !== undefined)) {
        warnings.add("db_env_target_conflict");
      }
      return {
        authority: "db",
        status: "active_with_stale_config_warning",
        activeTarget: dbTarget,
        candidateTarget: jsonFileTarget ? { ...jsonFileTarget, source: "json_file", filePath: input.approvedTargetFilePath ?? null } : null,
        warnings: Array.from(warnings),
        stopConditions: Array.from(stopConditions),
        conflicts,
        approvedTargetFilePath: input.approvedTargetFilePath ?? null,
      };
    }
    return {
      authority: "db",
      status: "active",
      activeTarget: dbTarget,
      candidateTarget: jsonFileTarget ? { ...jsonFileTarget, source: "json_file", filePath: input.approvedTargetFilePath ?? null } : null,
      warnings: Array.from(warnings),
      stopConditions: Array.from(stopConditions),
      conflicts,
      approvedTargetFilePath: input.approvedTargetFilePath ?? null,
    };
  }

  stopConditions.add("no_active_first_class_approved_target");
  if (jsonFileTarget) {
    warnings.add("json_file_is_not_production_approval");
  }
  if (envTarget) {
    warnings.add("env_target_is_not_production_approval");
  }
  if (conflicts.length > 0) {
    warnings.add("json_env_target_conflict");
  }

  return {
    authority: "none_read_only",
    status: conflicts.length > 0 ? "mismatch_blocked" : jsonFileTarget || envTarget ? "proposed_stale_check_needed" : "missing",
    activeTarget: null,
    candidateTarget: jsonFileTarget
      ? { ...jsonFileTarget, source: "json_file", filePath: input.approvedTargetFilePath ?? null }
      : envTarget
        ? { ...envTarget, source: "env" }
        : null,
    warnings: Array.from(warnings),
    stopConditions: Array.from(stopConditions),
    conflicts,
    approvedTargetFilePath: input.approvedTargetFilePath ?? null,
  };
}

export function readBookforgeApprovedTargetFile(filePath: string | null | undefined): BookforgeApprovedTargetPolicy | null {
  const path = clean(filePath);
  if (!path || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return normalizeBookforgeApprovedTargetPolicy({
      yaml: parsed.yaml as string | null | undefined,
      itemId: (parsed.itemId ?? parsed.item_id) as string | null | undefined,
      projectName: (parsed.projectName ?? parsed.project_name) as string | null | undefined,
    });
  } catch {
    return null;
  }
}

export function readBookforgeApprovedTargetEnv(env: NodeJS.ProcessEnv = process.env): BookforgeApprovedTargetPolicy | null {
  const target = normalizeBookforgeApprovedTargetPolicy({
    yaml: env.PAPERCLIP_BOOKFORGE_APPROVED_TARGET_YAML,
    itemId: env.PAPERCLIP_BOOKFORGE_APPROVED_TARGET_ITEM_ID,
    projectName: env.PAPERCLIP_BOOKFORGE_APPROVED_TARGET_PROJECT,
  });
  return hasAnyTargetField(target) ? target : null;
}

export function bookforgeApprovedTargetStateService(db: Db, opts: { approvedTargetFilePath?: string | null } = {}) {
  async function getDbTarget(companyId: string): Promise<BookforgeApprovedTargetRecord | null> {
    const row = await db
      .select()
      .from(bookforgeApprovedTargets)
      .where(and(eq(bookforgeApprovedTargets.companyId, companyId), eq(bookforgeApprovedTargets.status, "active")))
      .orderBy(desc(bookforgeApprovedTargets.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return {
      id: row.id,
      status: row.status,
      source: "db",
      yaml: row.yaml,
      itemId: row.itemId,
      projectName: row.projectName,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      approvalIssueId: row.approvalIssueId,
      approvalCommentId: row.approvalCommentId,
    };
  }

  return {
    async getState(companyId: string) {
      const approvedTargetFilePath = opts.approvedTargetFilePath ?? process.env.PAPERCLIP_BOOKFORGE_APPROVED_TARGET_FILE ?? `${process.env.HOME ?? ""}/.paperclip/bookforge-approved-target.json`;
      const configuredBookforgeCompanyId = clean(process.env.PAPERCLIP_BOOKFORGE_COMPANY_ID);
      const includeRuntimeConfig = !configuredBookforgeCompanyId || configuredBookforgeCompanyId === companyId;
      return buildBookforgeApprovedTargetState({
        dbTarget: await getDbTarget(companyId),
        jsonFileTarget: includeRuntimeConfig ? readBookforgeApprovedTargetFile(approvedTargetFilePath) : null,
        envTarget: includeRuntimeConfig ? readBookforgeApprovedTargetEnv() : null,
        approvedTargetFilePath: includeRuntimeConfig ? approvedTargetFilePath : null,
      });
    },
  };
}
