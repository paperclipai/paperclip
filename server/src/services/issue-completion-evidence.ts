import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  heartbeatRuns,
  issueWorkProducts,
  projects,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import { unprocessable } from "../errors.js";

const WORK_PRODUCT_TYPES = [
  "preview_url",
  "runtime_service",
  "pull_request",
  "branch",
  "commit",
  "artifact",
  "document",
] as const;

type WorkProductType = (typeof WORK_PRODUCT_TYPES)[number];

const WORK_PRODUCT_TYPE_SET = new Set<string>(WORK_PRODUCT_TYPES);
const UNUSABLE_WORK_PRODUCT_STATUSES = new Set([
  "failed",
  "archived",
  "changes_requested",
]);

const WORK_PRODUCT_TYPE_ALIASES: Record<string, WorkProductType> = {
  preview_url: "preview_url",
  previewurl: "preview_url",
  deployment_url: "preview_url",
  deploy_url: "preview_url",
  runtime_service: "runtime_service",
  runtimeservice: "runtime_service",
  service: "runtime_service",
  pull_request: "pull_request",
  pullrequest: "pull_request",
  pr: "pull_request",
  branch: "branch",
  commit: "commit",
  artifact: "artifact",
  artifacts: "artifact",
  screenshot: "artifact",
  screenshots: "artifact",
  test_result: "artifact",
  test_results: "artifact",
  document: "document",
  documents: "document",
  report: "document",
  qa_report: "document",
};

const DECLARATION_CONTAINER_KEYS = new Set([
  "items",
  "requirements",
  "outputs",
  "evidence",
  "workProducts",
  "work_products",
]);

const DIRECT_TYPE_KEYS = [
  "workProductType",
  "work_product_type",
  "type",
] as const;

const DIRECT_TYPES_KEYS = [
  "workProductTypes",
  "work_product_types",
  "types",
] as const;

export type IssueCompletionEvidenceProduct = {
  type: string;
  status?: string | null;
  reviewState?: string | null;
  healthStatus?: string | null;
  url?: string | null;
  externalId?: string | null;
  runtimeServiceId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type IssueCompletionEvidenceRequirement = {
  acceptanceCheckCount: number;
  declaredEvidenceCount: number;
  declaredRequirementTypes: string[];
  requiresAnyWorkProduct: boolean;
  requiredAnyWorkProductCount: number;
  requiredWorkProductTypes: WorkProductType[];
  invalidDeclaredTypes: string[];
};

export type IssueCompletionEvidenceEvaluation = {
  required: boolean;
  satisfied: boolean;
  requirement: IssueCompletionEvidenceRequirement | null;
  qualifyingWorkProductCount: number;
  qualifyingWorkProductTypes: string[];
  missingAnyWorkProductCount: number;
  missingRequirementTypes: string[];
};

function throwIssueCompletionEvidenceMissing(
  issueId: string | null,
  evaluation: IssueCompletionEvidenceEvaluation,
): never {
  const requirement = evaluation.requirement;
  if (!requirement) throw new Error("Completion evidence error requires an active requirement");
  throw unprocessable(
    "Issue cannot be completed until its execution contract evidence is recorded as work products",
    {
      code: "issue_completion_evidence_missing",
      issueId,
      declaredRequirementTypes: requirement.declaredRequirementTypes,
      missingRequirementTypes: evaluation.missingRequirementTypes,
      acceptanceCheckCount: requirement.acceptanceCheckCount,
      declaredEvidenceCount: requirement.declaredEvidenceCount,
      qualifyingWorkProductCount: evaluation.qualifyingWorkProductCount,
      qualifyingWorkProductTypes: evaluation.qualifyingWorkProductTypes,
      requiredAnyWorkProductCount: requirement.requiredAnyWorkProductCount,
      missingAnyWorkProductCount: evaluation.missingAnyWorkProductCount,
      invalidDeclaredTypes: requirement.invalidDeclaredTypes,
    },
  );
}

type EvidenceDeclarationState = {
  count: number;
  genericCount: number;
  workProductTypes: Set<WorkProductType>;
  invalidTypes: Set<string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readField(record: Record<string, unknown> | null, ...keys: string[]) {
  if (!record) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function hasContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasContent);
  if (isRecord(value)) return Object.values(value).some(hasContent);
  return false;
}

function countDeclaredItems(value: unknown): number {
  if (!hasContent(value)) return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countDeclaredItems(item), 0);
  return 1;
}

function normalizeWorkProductType(value: unknown): WorkProductType | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
  if (!normalized) return null;
  const alias = WORK_PRODUCT_TYPE_ALIASES[normalized];
  if (alias) return alias;
  return WORK_PRODUCT_TYPE_SET.has(normalized) ? normalized as WorkProductType : null;
}

function addTypedDeclaration(state: EvidenceDeclarationState, value: unknown) {
  const type = normalizeWorkProductType(value);
  if (!type) return false;
  state.count += 1;
  state.workProductTypes.add(type);
  return true;
}

function invalidTypeLabel(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 80);
  }
  return typeof value;
}

function addInvalidTypeDeclaration(state: EvidenceDeclarationState, value: unknown) {
  state.count += 1;
  state.invalidTypes.add(invalidTypeLabel(value));
}

function collectEvidenceDeclarations(
  value: unknown,
  state: EvidenceDeclarationState,
  options: { strictTypes: boolean },
): void {
  if (!hasContent(value)) return;

  if (typeof value === "string") {
    if (!addTypedDeclaration(state, value)) {
      if (options.strictTypes) addInvalidTypeDeclaration(state, value);
      else {
        state.count += 1;
        state.genericCount += 1;
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceDeclarations(item, state, options);
    return;
  }

  if (!isRecord(value)) {
    if (options.strictTypes) addInvalidTypeDeclaration(state, value);
    else {
      state.count += 1;
      state.genericCount += 1;
    }
    return;
  }

  let foundDirectType = false;
  let foundDirectTypeKey = false;
  for (const key of DIRECT_TYPE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      foundDirectTypeKey = true;
      foundDirectType = addTypedDeclaration(state, value[key]) || foundDirectType;
      if (!normalizeWorkProductType(value[key])) addInvalidTypeDeclaration(state, value[key]);
    }
  }
  for (const key of DIRECT_TYPES_KEYS) {
    const declaredTypes = value[key];
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    foundDirectTypeKey = true;
    if (!Array.isArray(declaredTypes)) {
      addInvalidTypeDeclaration(state, declaredTypes);
      continue;
    }
    for (const declaredType of declaredTypes) {
      foundDirectType = addTypedDeclaration(state, declaredType) || foundDirectType;
      if (!normalizeWorkProductType(declaredType)) addInvalidTypeDeclaration(state, declaredType);
    }
  }
  if (foundDirectType || foundDirectTypeKey) return;

  let foundContainer = false;
  for (const key of DECLARATION_CONTAINER_KEYS) {
    if (!hasContent(value[key])) continue;
    foundContainer = true;
    collectEvidenceDeclarations(value[key], state, options);
  }
  if (foundContainer) return;

  let foundTypeKey = false;
  let genericSiblingCount = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (!hasContent(entry)) continue;
    const type = normalizeWorkProductType(key);
    if (type) {
      foundTypeKey = true;
      state.count += 1;
      state.workProductTypes.add(type);
      continue;
    }
    if (!options.strictTypes) genericSiblingCount += 1;
  }
  if (foundTypeKey) {
    state.count += genericSiblingCount;
    state.genericCount += genericSiblingCount;
    return;
  }

  if (options.strictTypes) addInvalidTypeDeclaration(state, Object.keys(value).join("_"));
  else {
    const genericEntryCount = Object.values(value).filter(hasContent).length;
    state.count += genericEntryCount;
    state.genericCount += genericEntryCount;
  }
}

function requirementTypeForWorkProduct(type: WorkProductType) {
  return `work_product:${type}`;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const PLACEHOLDER_VALUE_PATTERN = /^(?:dummy|example|n\/?a|none|placeholder|sample|tbd|todo|unknown|xxx?)$/i;
const PLACEHOLDER_IDENTIFIER_COMPONENT_PATTERN =
  /(?:^|[^a-z0-9])(?:dummy|example|none|placeholder|sample|tbd|todo|unknown|xxx?)(?:$|[^a-z0-9])/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function hasDurableIdentifier(value: unknown) {
  if (!hasNonEmptyString(value)) return false;
  const normalized = value.trim();
  return normalized.length >= 3 &&
    !PLACEHOLDER_VALUE_PATTERN.test(normalized) &&
    !PLACEHOLDER_IDENTIFIER_COMPONENT_PATTERN.test(normalized);
}

function hasDurableUrl(value: unknown) {
  if (!hasNonEmptyString(value)) return false;
  try {
    const parsed = new URL(value.trim());
    const hostname = parsed.hostname.toLowerCase();
    const reservedExampleHost = hostname === "example.com" ||
      hostname === "example.org" ||
      hostname === "example.net" ||
      hostname.endsWith(".example.com") ||
      hostname.endsWith(".example.org") ||
      hostname.endsWith(".example.net");
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      hostname.length > 0 &&
      !reservedExampleHost;
  } catch {
    return false;
  }
}

const DURABLE_ARTIFACT_METADATA_KEYS = new Set([
  "artifactId",
  "assetId",
  "attachmentId",
  "documentId",
  "filePath",
  "objectKey",
  "sha256",
]);

function hasDurableArtifactMetadata(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata) return false;
  return Object.entries(metadata).some(([key, value]) => {
    if (!DURABLE_ARTIFACT_METADATA_KEYS.has(key)) return false;
    if (key === "sha256") return typeof value === "string" && SHA256_PATTERN.test(value.trim());
    if (["artifactId", "assetId", "attachmentId", "documentId"].includes(key)) {
      return typeof value === "string" && UUID_PATTERN.test(value.trim());
    }
    return hasDurableIdentifier(value);
  });
}

function hasDurableEvidenceMarker(product: IssueCompletionEvidenceProduct) {
  const type = normalizeWorkProductType(product.type);
  if (!type) return false;
  switch (type) {
    case "preview_url":
      return hasDurableUrl(product.url);
    case "runtime_service":
      return typeof product.runtimeServiceId === "string" &&
        UUID_PATTERN.test(product.runtimeServiceId.trim()) &&
        product.healthStatus?.trim().toLowerCase() === "healthy";
    case "pull_request":
    case "branch":
    case "commit":
      return hasDurableUrl(product.url) || hasDurableIdentifier(product.externalId);
    case "artifact":
      return hasDurableUrl(product.url) ||
        hasDurableIdentifier(product.externalId) ||
        hasDurableArtifactMetadata(product.metadata);
    case "document":
      return hasDurableUrl(product.url) ||
        hasDurableIdentifier(product.externalId) ||
        (typeof product.metadata?.documentId === "string" &&
          UUID_PATTERN.test(product.metadata.documentId.trim()));
  }
}

function workProductIsUsable(product: IssueCompletionEvidenceProduct) {
  const status = product.status?.trim().toLowerCase() ?? "";
  const reviewState = product.reviewState?.trim().toLowerCase() ?? "";
  const healthStatus = product.healthStatus?.trim().toLowerCase() ?? "";
  return hasDurableEvidenceMarker(product) &&
    !UNUSABLE_WORK_PRODUCT_STATUSES.has(status) &&
    reviewState !== "changes_requested" &&
    healthStatus !== "unhealthy";
}

export function deriveIssueCompletionEvidenceRequirement(
  executionContract: Record<string, unknown> | null | undefined,
): IssueCompletionEvidenceRequirement | null {
  if (!executionContract) return null;
  const coreValue = readField(executionContract, "core");
  if (!isRecord(coreValue)) return null;

  const acceptanceChecks = readField(coreValue, "acceptanceChecks", "acceptance_checks");
  const acceptanceCheckCount = countDeclaredItems(acceptanceChecks);

  const state: EvidenceDeclarationState = {
    count: 0,
    genericCount: 0,
    workProductTypes: new Set(),
    invalidTypes: new Set(),
  };
  collectEvidenceDeclarations(
    readField(coreValue, "evidenceRequired", "evidence_required"),
    state,
    { strictTypes: false },
  );
  collectEvidenceDeclarations(
    readField(coreValue, "requiredOutputs", "required_outputs"),
    state,
    { strictTypes: true },
  );
  if (state.count === 0) return null;

  const requiredWorkProductTypes = [...state.workProductTypes].sort();
  const invalidDeclaredTypes = [...state.invalidTypes].sort();
  const requiresAnyWorkProduct = state.genericCount > 0;
  const declaredRequirementTypes = [
    ...(requiresAnyWorkProduct ? ["work_product:any"] : []),
    ...requiredWorkProductTypes.map(requirementTypeForWorkProduct),
    ...(invalidDeclaredTypes.length > 0 ? ["work_product:invalid"] : []),
  ].sort();

  return {
    acceptanceCheckCount,
    declaredEvidenceCount: state.count,
    declaredRequirementTypes,
    requiresAnyWorkProduct,
    requiredAnyWorkProductCount: state.genericCount,
    requiredWorkProductTypes,
    invalidDeclaredTypes,
  };
}

export function evaluateIssueCompletionEvidence(
  executionContract: Record<string, unknown> | null | undefined,
  workProducts: IssueCompletionEvidenceProduct[],
): IssueCompletionEvidenceEvaluation {
  const requirement = deriveIssueCompletionEvidenceRequirement(executionContract);
  if (!requirement) {
    return {
      required: false,
      satisfied: true,
      requirement: null,
      qualifyingWorkProductCount: 0,
      qualifyingWorkProductTypes: [],
      missingAnyWorkProductCount: 0,
      missingRequirementTypes: [],
    };
  }

  const qualifyingProducts = workProducts.filter(workProductIsUsable);
  const qualifyingWorkProductTypes = Array.from(
    new Set(qualifyingProducts.map((product) => product.type)),
  ).sort();
  const qualifyingTypeSet = new Set(qualifyingWorkProductTypes);
  const missingAnyWorkProductCount = Math.max(
    0,
    requirement.requiredAnyWorkProductCount - qualifyingProducts.length,
  );
  const missingRequirementTypes = [
    ...(missingAnyWorkProductCount > 0
      ? ["work_product:any"]
      : []),
    ...requirement.requiredWorkProductTypes
      .filter((type) => !qualifyingTypeSet.has(type))
      .map(requirementTypeForWorkProduct),
    ...(requirement.invalidDeclaredTypes.length > 0 ? ["work_product:invalid"] : []),
  ].sort();

  return {
    required: true,
    satisfied: missingRequirementTypes.length === 0,
    requirement,
    qualifyingWorkProductCount: qualifyingProducts.length,
    qualifyingWorkProductTypes,
    missingAnyWorkProductCount,
    missingRequirementTypes,
  };
}

export function assertIssueCompletionEvidenceOnCreate(
  executionContract: Record<string, unknown> | null | undefined,
) {
  assertIssueCompletionEvidenceProducts(executionContract, [], null);
}

export function assertIssueCompletionEvidenceProducts(
  executionContract: Record<string, unknown> | null | undefined,
  workProducts: IssueCompletionEvidenceProduct[],
  issueId: string | null,
) {
  const evaluation = evaluateIssueCompletionEvidence(executionContract, workProducts);
  if (!evaluation.required || evaluation.satisfied) return;
  throwIssueCompletionEvidenceMissing(issueId, evaluation);
}

type CompletionEvidenceDb = Pick<Db, "select">;

export async function loadCompanyScopedIssueCompletionEvidenceProducts(
  dbOrTx: CompletionEvidenceDb,
  input: { companyId: string; issueId: string },
) {
  const rows = await dbOrTx
    .select()
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, input.companyId),
      eq(issueWorkProducts.issueId, input.issueId),
    ));
  const projectIds = [...new Set(rows.flatMap((row) => row.projectId ? [row.projectId] : []))];
  const executionWorkspaceIds = [...new Set(rows.flatMap((row) =>
    row.executionWorkspaceId ? [row.executionWorkspaceId] : []))];
  const runtimeServiceIds = [...new Set(rows.flatMap((row) =>
    row.runtimeServiceId ? [row.runtimeServiceId] : []))];
  const runIds = [...new Set(rows.flatMap((row) => row.createdByRunId ? [row.createdByRunId] : []))];
  const [projectRows, executionWorkspaceRows, runtimeServiceRows, runRows] = await Promise.all([
    projectIds.length > 0
      ? dbOrTx.select({ id: projects.id }).from(projects).where(and(
          eq(projects.companyId, input.companyId),
          inArray(projects.id, projectIds),
        ))
      : Promise.resolve([]),
    executionWorkspaceIds.length > 0
      ? dbOrTx.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
          eq(executionWorkspaces.companyId, input.companyId),
          inArray(executionWorkspaces.id, executionWorkspaceIds),
        ))
      : Promise.resolve([]),
    runtimeServiceIds.length > 0
      ? dbOrTx.select({ id: workspaceRuntimeServices.id }).from(workspaceRuntimeServices).where(and(
          eq(workspaceRuntimeServices.companyId, input.companyId),
          inArray(workspaceRuntimeServices.id, runtimeServiceIds),
        ))
      : Promise.resolve([]),
    runIds.length > 0
      ? dbOrTx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, input.companyId),
          inArray(heartbeatRuns.id, runIds),
        ))
      : Promise.resolve([]),
  ]);
  const projectSet = new Set(projectRows.map((row) => row.id));
  const executionWorkspaceSet = new Set(executionWorkspaceRows.map((row) => row.id));
  const runtimeServiceSet = new Set(runtimeServiceRows.map((row) => row.id));
  const runSet = new Set(runRows.map((row) => row.id));

  return rows.filter((row) =>
    (!row.projectId || projectSet.has(row.projectId)) &&
    (!row.executionWorkspaceId || executionWorkspaceSet.has(row.executionWorkspaceId)) &&
    (!row.runtimeServiceId || runtimeServiceSet.has(row.runtimeServiceId)) &&
    (!row.createdByRunId || runSet.has(row.createdByRunId)));
}

export async function assertIssueCompletionEvidence(
  dbOrTx: CompletionEvidenceDb,
  input: {
    companyId: string;
    issueId: string;
    executionContract: Record<string, unknown> | null | undefined;
  },
) {
  const requirement = deriveIssueCompletionEvidenceRequirement(input.executionContract);
  if (!requirement) return;

  const rows = await loadCompanyScopedIssueCompletionEvidenceProducts(dbOrTx, input);
  assertIssueCompletionEvidenceProducts(input.executionContract, rows, input.issueId);
}
