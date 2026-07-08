import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { join as joinPath } from "node:path";
import type { Agent, AgentSessionEvent, Issue, IssueComment, PluginContext, PluginEvent, PluginLocalFolderEntry, Project, ToolResult } from "@paperclipai/plugin-sdk";
import type { IssueDocument, PluginIssueOriginKind, PluginManagedRoutineResolution, PluginManagedSkillResolution } from "@paperclipai/plugin-sdk/types";
import {
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_MAX_PAPERCLIP_CURSOR_WINDOW_CHARS,
  DEFAULT_MAX_PAPERCLIP_ISSUE_SOURCE_CHARS,
  DEFAULT_MAX_PAPERCLIP_ROUTINE_RUN_CHARS,
  DEFAULT_PAPERCLIP_COST_CENTS_PER_1K_CHARS,
  PLUGIN_ID,
  WIKI_MAINTAINER_AGENT_KEY,
  WIKI_MANAGED_SKILL_KEYS,
  WIKI_MAINTENANCE_ROUTINE_KEYS,
  WIKI_PROJECT_KEY,
  WIKI_ROOT_FOLDER_KEY,
} from "../manifest.js";
import {
  BOOTSTRAP_FILES,
  LINT_PROMPT,
  QUERY_PROMPT,
  REQUIRED_WIKI_DIRECTORIES,
  REQUIRED_WIKI_FILES,
} from "../templates.js";

export const DEFAULT_WIKI_ID = "default";
export const DEFAULT_SPACE_SLUG = "default";
export const OPERATION_ORIGIN_KIND = `plugin:${PLUGIN_ID}:operation` as PluginIssueOriginKind;
const EVENT_INGESTION_STATE_NAMESPACE = "llm-wiki";
const EVENT_INGESTION_STATE_KEY = "event-ingestion";
const EVENT_INGESTION_DEDUP_NAMESPACE = "llm-wiki-event-ingestion";
const MAX_EVENT_SOURCE_CHARS = 20000;
const MAX_PAPERCLIP_INGESTION_PROFILE_SOURCE_COUNT = 3;
const MAX_PAPERCLIP_DISTILLATION_FAN_OUT = 25;
const MAX_PAPERCLIP_PROFILE_SELECTED_PROJECTS = 25;
const MAX_PAPERCLIP_PROFILE_ROOT_ISSUES = 25;
const PROTECTED_WIKI_CONTROL_FILES = new Set(["AGENTS.md", "IDEA.md"]);
export const PUBLIC_DISTILLATION_AUTO_APPLY_RESTRICTION =
  "Authenticated/public deployments always require manual review before wiki writes.";
type LocalFolderStatus = Awaited<ReturnType<PluginContext["localFolders"]["status"]>>;

export type WikiEventIngestionSource = "issues" | "comments" | "documents";
export type PaperclipDistillationScope = "company" | "project" | "root_issue";
export type PaperclipDistillationWorkItemKind = "manual" | "retry" | "backfill" | "priority_override" | "review_patch";

export type WikiEventIngestionSettings = {
  enabled: boolean;
  sources: Record<WikiEventIngestionSource, boolean>;
  wikiId: string;
  maxCharacters: number;
};

export type WikiEventIngestionSettingsUpdate = Omit<Partial<WikiEventIngestionSettings>, "sources"> & {
  sources?: Partial<Record<WikiEventIngestionSource, boolean>>;
};

export type PaperclipIngestionSourceScope =
  | { kind: "active_projects"; limit: number; statuses?: Array<"in_progress" | "todo" | "done"> }
  | { kind: "selected_projects"; projectIds: string[] }
  | { kind: "root_issues"; issueIds: string[] }
  | { kind: "company_all"; requiresBoardConfirmation: true };

export type PaperclipIngestionProfileV1 = {
  version: 1;
  enabled: boolean;
  sourceScopes: PaperclipIngestionSourceScope[];
  sourceKinds: Record<WikiEventIngestionSource, boolean> & {
    attachments: "off" | "metadata_only";
    workProducts: "off" | "metadata_only";
  };
  cursor: {
    maxWindowCharacters: number;
    maxCharactersPerSource: number;
    minSourceAgeMinutes: number;
    maxWindowsPerRun: number;
    staleAfterHours: number;
  };
  backfill: {
    defaultStartAt?: string | null;
    defaultEndAt?: string | null;
    requireManualQueue: boolean;
  };
};

export type PaperclipIngestionProfileEffectiveState =
  | "enabled"
  | "disabled"
  | "policy_blocked"
  | "pending_approval"
  | "enabled_no_scopes";

export type PaperclipIngestionProfileRead = {
  wikiId: string;
  space: Pick<WikiSpace, "id" | "slug" | "displayName" | "accessScope" | "status">;
  profile: PaperclipIngestionProfileV1;
  effectiveState: PaperclipIngestionProfileEffectiveState;
  policyBlocks: string[];
  historicalPageCount: number;
  overlapCount: number;
};

export type DistillationAutoApplyRestriction = {
  autoApplyAllowed: boolean;
  autoApplyRestriction: string | null;
  deploymentMode: "local_trusted" | "authenticated" | null;
  deploymentExposure: "private" | "public" | null;
};

type PaperclipIngestionPolicyPurpose =
  | "profile_read"
  | "profile_update"
  | "candidate_search"
  | "queue"
  | "execute"
  | "event_routing";

type PaperclipIngestionPolicyDecision =
  | { allowed: true; space: WikiSpace }
  | { allowed: false; space: WikiSpace; reason: "restricted_space" | "archived_space" | "profile_disabled" | "profile_empty"; message: string };

type PaperclipIngestionCandidatesInput = SpaceInput & {
  query?: string | null;
};

export type EnableActiveProjectDistillationResult = {
  wikiId: string;
  spaceSlug: string;
  selectedProjects: Array<{
    id: string;
    name: string;
    status: string;
    observedAt: string | null;
    cursorId: string;
  }>;
  eventIngestion: WikiEventIngestionSettings;
};

export const DEFAULT_EVENT_INGESTION_SETTINGS: WikiEventIngestionSettings = {
  enabled: false,
  sources: {
    issues: false,
    comments: false,
    documents: false,
  },
  wikiId: DEFAULT_WIKI_ID,
  maxCharacters: 12000,
};

export type WikiOverview = {
  status: "ok";
  checkedAt: string;
  wikiId: string;
  defaultSpace: WikiSpace;
  folder: Awaited<ReturnType<PluginContext["localFolders"]["status"]>>;
  managedAgent: WikiAgentResource;
  managedProject: WikiProjectResource;
  managedSkills: WikiSkillResource[];
  operationCount: number;
  eventIngestion: WikiEventIngestionSettings;
  capabilities: readonly string[];
  prompts: {
    query: string;
    lint: string;
  };
};

export type WikiAgentResource = {
  status: "missing" | "resolved" | "created" | "relinked" | "reset";
  source: "managed" | "selected";
  agentId: string | null;
  resourceKey: string;
  agent: Agent | null;
  details: { name: string; status: string; adapterType: string | null; icon?: string | null; urlKey?: string | null } | null;
  defaultDrift?: { entryFile: string; changedFiles: string[] } | null;
};

export type WikiProjectResource = {
  status: "missing" | "resolved" | "created" | "relinked" | "reset";
  source: "managed" | "selected";
  projectId: string | null;
  resourceKey: string;
  project: Project | null;
  details: { name: string; status: string; color: string | null } | null;
};

export type WikiSkillResource = {
  status: "missing" | "resolved" | "created" | "relinked" | "reset";
  skillId: string | null;
  resourceKey: string;
  skill: PluginManagedSkillResolution["skill"];
  details: { name: string; key: string; description: string | null } | null;
  defaultDrift?: { changedFiles: string[] } | null;
};

export type WikiResourceOption = {
  id: string;
  name: string;
  status?: string | null;
  adapterType?: string | null;
  color?: string | null;
  icon?: string | null;
  urlKey?: string | null;
};

export type WikiSpace = {
  id: string;
  companyId: string;
  wikiId: string;
  slug: string;
  displayName: string;
  spaceType: string;
  folderMode: string;
  rootFolderKey: string;
  pathPrefix: string | null;
  configuredRootPath: string | null;
  accessScope: string;
  ownerUserId: string | null;
  ownerAgentId: string | null;
  teamKey: string | null;
  bindingKind: "none" | "project" | string;
  projectId: string | null;
  settings: Record<string, unknown>;
  status: "active" | "archived" | string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type WikiSpaceWithFolderStatus = WikiSpace & {
  relativeRoot: string;
  folder: Awaited<ReturnType<PluginContext["localFolders"]["status"]>>;
};

type BootstrapInput = {
  companyId: string;
  path?: string | null;
};

type SpaceInput = {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
};

type CreateSpaceInput = {
  companyId: string;
  wikiId?: string | null;
  slug?: string | null;
  displayName?: string | null;
  folderMode?: "managed_subfolder" | "existing_local_folder" | null;
  accessScope?: "shared" | "personal" | "team" | null;
  settings?: Record<string, unknown> | null;
  bindingKind?: "none" | "project" | null;
  projectId?: string | null;
};

type UpdateSpaceInput = SpaceInput & {
  displayName?: string | null;
  settings?: Record<string, unknown> | null;
  status?: "active" | "archived" | null;
};

type OperationInput = {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  operationType: "ingest" | "query" | "lint" | "file-as-page" | "index" | "distill" | "backfill";
  title?: string | null;
  prompt?: string | null;
  useCheapModelProfile?: boolean;
};

type OperationSpaceContext = {
  wikiId: string;
  space: WikiSpace;
  operationType: OperationInput["operationType"];
  operationId: string;
  prompt?: string | null;
};

type QuerySessionInput = {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  question: string;
  title?: string | null;
};

type CaptureSourceInput = {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  sourceType?: string | null;
  title?: string | null;
  url?: string | null;
  contents: string;
  rawPath?: string | null;
  metadata?: Record<string, unknown> | null;
  author?: { kind: "agent" | "user" | "plugin"; id?: string | null; runId?: string | null } | null;
};

type PaperclipSourceBundleInput = {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  projectId?: string | null;
  rootIssueId?: string | null;
  maxCharacters?: number | null;
  maxCharactersPerSource?: number | null;
  backfillStartAt?: string | null;
  backfillEndAt?: string | null;
  routineRun?: boolean;
  includeComments?: boolean;
  includeDocuments?: boolean;
  workItemId?: string | null;
  operationIssueId?: string | null;
};

type PaperclipSourceRef = {
  kind: "issue" | "comment" | "document";
  issueId: string;
  issueIdentifier: string | null;
  projectId: string | null;
  title?: string | null;
  commentId?: string;
  documentId?: string;
  documentKey?: string;
  updatedAt?: string;
  createdAt?: string;
  redactionStatus?: "suppressed_sensitive_content";
  redactionReasons?: string[];
};

type PaperclipSourceBundle = {
  markdown: string;
  sourceRefs: PaperclipSourceRef[];
  sourceHash: string;
  sourceWindowStart: string | null;
  sourceWindowEnd: string | null;
  clipped: boolean;
  warnings: string[];
};

type PaperclipDistillationRunInput = PaperclipSourceBundleInput;

type PaperclipDistillationOutcomeInput = {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  runId: string;
  cursorId?: string | null;
  status: "succeeded" | "failed" | "review_required";
  sourceHash?: string | null;
  sourceWindowEnd?: string | null;
  warning?: string | null;
  costCents?: number | null;
  retryCount?: number | null;
};

type PaperclipDistillationWorkItemInput = {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  kind: PaperclipDistillationWorkItemKind;
  projectId?: string | null;
  rootIssueId?: string | null;
  requestedByIssueId?: string | null;
  priority?: "critical" | "high" | "medium" | "low" | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown> | null;
};

type PaperclipProjectPageDistillationInput = PaperclipSourceBundleInput & {
  autoApply?: boolean;
  expectedProjectPageHash?: string | null;
  includeSupportingPages?: boolean;
};

type WritePageInput = {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  path: string;
  contents: string;
  expectedHash?: string | null;
  summary?: string | null;
  sourceRefs?: unknown;
  operationId?: string | null;
  writer?: "agent_tool" | "board_ui" | "plugin_internal" | "agent_api";
  author?: { kind: "agent" | "user" | "plugin"; id?: string | null; runId?: string | null } | null;
};

type FileQueryAnswerInput = {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  querySessionId?: string | null;
  question?: string | null;
  answer?: string | null;
  path: string;
  title?: string | null;
  contents?: string | null;
  expectedHash?: string | null;
};

type ToolParams = Record<string, unknown>;
type WikiResourceKind = "agent" | "project";
type PaperclipDistillationPatchOperation =
  | "standup_update"
  | "project_page_distill"
  | "decision_distill"
  | "history_distill"
  | "index_refresh"
  | "log_append";
type PaperclipDistillationPatch = {
  pagePath: string;
  operationType: PaperclipDistillationPatchOperation;
  currentHash: string | null;
  proposedHash: string;
  proposedContents: string;
  sourceHash: string;
  sourceRefs: PaperclipSourceRef[];
  cursorWindow: {
    start: string | null;
    end: string | null;
  };
  confidence: "high" | "medium" | "low";
  warnings: string[];
  humanReviewRequired: boolean;
};
type PaperclipEventIngestResult =
  | { status: "skipped"; reason: "disabled" | "source_disabled" | "unsupported_event" | "missing_issue" | "missing_comment" | "missing_document" | "plugin_operation" | "already_ingested" }
  | { status: "recorded"; sourceKind: WikiEventIngestionSource; sourceId: string; cursorId: string; issueId: string };

type WikiResourceBinding = {
  resolvedId: string | null;
  metadata: Record<string, unknown>;
};

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireString(value: unknown, name: string): string {
  const field = stringField(value);
  if (!field) throw new Error(`${name} is required`);
  return field;
}

function normalizeWikiId(value: unknown): string {
  return stringField(value) ?? DEFAULT_WIKI_ID;
}

export function normalizeSpaceSlug(value: unknown): string {
  const raw = stringField(value) ?? DEFAULT_SPACE_SLUG;
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("spaceSlug is required");
  if (normalized.length > 64) throw new Error("spaceSlug must be 64 characters or fewer");
  return normalized;
}

async function requirePaperclipIngestionPolicy(
  ctx: PluginContext,
  input: { companyId: string; wikiId: string; spaceSlug?: string | null },
  purpose: PaperclipIngestionPolicyPurpose,
  options: { requireEnabledProfile?: boolean } = {},
): Promise<WikiSpace> {
  const space = await resolveSpace(ctx, {
    companyId: input.companyId,
    wikiId: input.wikiId,
    spaceSlug: input.spaceSlug,
  });
  const profile = await profileForSpace(ctx, input.companyId, space);
  const decision = evaluatePaperclipProfilePolicy({
    space,
    profile,
    purpose,
    requireEnabledProfile: options.requireEnabledProfile,
  });
  if (!decision.allowed) throw new Error(decision.message);
  return decision.space;
}

function assertPaperclipSourceScopePayload(input: { projectId?: string | null; rootIssueId?: string | null }) {
  if (input.projectId && input.rootIssueId) {
    throw new Error("Paperclip source scope must specify either projectId or rootIssueId, not both.");
  }
}

function assertRequestedCharacterLimit(name: string, value: unknown, max: number) {
  if (value == null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive number.`);
  }
  if (Math.floor(value) > max) {
    throw new Error(`${name} exceeds the hard Paperclip ingestion cap of ${max} characters.`);
  }
}

function stableSpaceId(input: { companyId: string; wikiId: string; slug: string }): string {
  const hex = createHash("md5")
    .update(`${input.companyId}:${input.wikiId}:${input.slug}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function contentHash(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function byteLength(contents: string): number {
  return Buffer.byteLength(contents, "utf8");
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "source";
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function jsonArrayParam(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function isoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeMaxSourceBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_SOURCE_BYTES;
  return Math.max(1, Math.floor(value));
}

function normalizeBundleLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1000, Math.floor(value));
}

function normalizeCostRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PAPERCLIP_COST_CENTS_PER_1K_CHARS;
  return Math.max(0, value);
}

type PaperclipDistillationLimits = {
  maxCharacters: number;
  maxCharactersPerSource: number;
  maxRoutineRunCharacters: number;
  costCentsPerThousandSourceCharacters: number;
};

const DISTILLATION_REDACTED_VALUE = "***REDACTED***";
const DISTILLATION_JSON_SECRET_FIELD_TEXT_RE =
  /((?:"|')?(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)(?:"|')?\s*:\s*(?:"|'))[^"'`\r\n]+((?:"|'))/gi;
const DISTILLATION_ESCAPED_JSON_SECRET_FIELD_TEXT_RE =
  /((?:\\")?(?:api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)(?:\\")?\s*:\s*(?:\\"))[^\\\r\n]+((?:\\"))/gi;
const DISTILLATION_ENV_SECRET_ASSIGNMENT_RE =
  /(\b[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTHORIZATION|JWT)[A-Za-z0-9_]*\s*=\s*)[^\s"'`]+/gi;
const DISTILLATION_AUTHORIZATION_BEARER_RE = /(\bAuthorization\s*:\s*Bearer\s+)[^\s"'`]+/gi;
const DISTILLATION_OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const DISTILLATION_GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g;
const DISTILLATION_JWT_RE =
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g;
const DISTILLATION_CONNECTION_STRING_RE =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s"'`]+/gi;
const DISTILLATION_PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN(?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END(?:[A-Z ]+)?PRIVATE KEY-----/gi;
const DISTILLATION_PRIVATE_KEY_BLOCK_TEST_RE =
  /-----BEGIN(?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END(?:[A-Z ]+)?PRIVATE KEY-----/i;

type DistillationSourceProtectionResult = {
  body: string;
  warning: string | null;
  refPatch: Pick<PaperclipSourceRef, "redactionStatus" | "redactionReasons">;
};

function redactDistillationSensitiveText(input: string): string {
  return input
    .replace(DISTILLATION_PRIVATE_KEY_BLOCK_RE, DISTILLATION_REDACTED_VALUE)
    .replace(DISTILLATION_JSON_SECRET_FIELD_TEXT_RE, `$1${DISTILLATION_REDACTED_VALUE}$2`)
    .replace(DISTILLATION_ESCAPED_JSON_SECRET_FIELD_TEXT_RE, `$1${DISTILLATION_REDACTED_VALUE}$2`)
    .replace(DISTILLATION_ENV_SECRET_ASSIGNMENT_RE, `$1${DISTILLATION_REDACTED_VALUE}`)
    .replace(DISTILLATION_AUTHORIZATION_BEARER_RE, `$1${DISTILLATION_REDACTED_VALUE}`)
    .replace(DISTILLATION_CONNECTION_STRING_RE, DISTILLATION_REDACTED_VALUE)
    .replace(DISTILLATION_OPENAI_KEY_RE, DISTILLATION_REDACTED_VALUE)
    .replace(DISTILLATION_GITHUB_TOKEN_RE, DISTILLATION_REDACTED_VALUE)
    .replace(DISTILLATION_JWT_RE, DISTILLATION_REDACTED_VALUE);
}

function protectDistillationSourceBody(input: {
  issue: Issue;
  sourceKind: "comment" | "document";
  sourceId: string;
  body: string;
}): DistillationSourceProtectionResult {
  const redactedBody = redactDistillationSensitiveText(input.body);
  const reasons = [
    DISTILLATION_PRIVATE_KEY_BLOCK_TEST_RE.test(input.body) ? "private_key_block" : null,
    redactedBody !== input.body ? "secret_like_token" : null,
  ].filter((reason): reason is string => Boolean(reason));
  if (reasons.length === 0) {
    return {
      body: input.body,
      warning: null,
      refPatch: {},
    };
  }

  return {
    body: [
      `[Suppressed by LLM Wiki distillation security policy for this ${input.sourceKind}.]`,
      "",
      `- Source ID: ${input.sourceId}`,
      `- Redaction reasons: ${reasons.join(", ")}`,
      "- Review the original Paperclip source directly if a human needs the unredacted material.",
    ].join("\n"),
    warning: `Suppressed ${input.sourceKind} content for ${sourceTitleForIssue(input.issue)} / ${input.sourceId}: ${reasons.join(", ")}.`,
    refPatch: {
      redactionStatus: "suppressed_sensitive_content",
      redactionReasons: reasons,
    },
  };
}

async function resolvePaperclipDistillationLimits(
  ctx: PluginContext,
  input: Pick<PaperclipSourceBundleInput, "maxCharacters" | "maxCharactersPerSource" | "routineRun">,
): Promise<PaperclipDistillationLimits> {
  assertRequestedCharacterLimit("maxCharacters", input.maxCharacters, DEFAULT_MAX_PAPERCLIP_CURSOR_WINDOW_CHARS);
  assertRequestedCharacterLimit("maxCharactersPerSource", input.maxCharactersPerSource, DEFAULT_MAX_PAPERCLIP_ISSUE_SOURCE_CHARS);
  const config = await ctx.config.get() as Record<string, unknown>;
  const maxCharactersPerSource = Math.min(
    normalizeBundleLimit(input.maxCharactersPerSource, DEFAULT_MAX_PAPERCLIP_ISSUE_SOURCE_CHARS),
    normalizeBundleLimit(config.maxPaperclipIssueSourceCharacters, DEFAULT_MAX_PAPERCLIP_ISSUE_SOURCE_CHARS),
  );
  const cursorWindowCap = normalizeBundleLimit(
    config.maxPaperclipCursorWindowCharacters,
    DEFAULT_MAX_PAPERCLIP_CURSOR_WINDOW_CHARS,
  );
  const routineRunCap = normalizeBundleLimit(
    config.maxPaperclipRoutineRunCharacters,
    DEFAULT_MAX_PAPERCLIP_ROUTINE_RUN_CHARS,
  );
  const requestedMaxCharacters = normalizeBundleLimit(input.maxCharacters, cursorWindowCap);
  const hardCharacterCap = input.routineRun ? Math.min(cursorWindowCap, routineRunCap) : cursorWindowCap;
  return {
    maxCharacters: Math.min(requestedMaxCharacters, hardCharacterCap),
    maxCharactersPerSource,
    maxRoutineRunCharacters: routineRunCap,
    costCentsPerThousandSourceCharacters: normalizeCostRate(config.paperclipCostCentsPerThousandSourceCharacters),
  };
}

async function resolvePaperclipDistillationLimitsForSpace(
  ctx: PluginContext,
  input: Pick<PaperclipSourceBundleInput, "companyId" | "maxCharacters" | "maxCharactersPerSource" | "routineRun"> & { space: WikiSpace },
): Promise<PaperclipDistillationLimits> {
  const [base, profile] = await Promise.all([
    resolvePaperclipDistillationLimits(ctx, input),
    profileForSpace(ctx, input.companyId, input.space),
  ]);
  return {
    ...base,
    maxCharacters: Math.min(base.maxCharacters, profile.cursor.maxWindowCharacters),
    maxCharactersPerSource: Math.min(base.maxCharactersPerSource, profile.cursor.maxCharactersPerSource),
  };
}

function estimateSourceCostCents(characters: number, costCentsPerThousandSourceCharacters: number): number {
  if (characters <= 0 || costCentsPerThousandSourceCharacters <= 0) return 0;
  return Math.ceil((characters / 1000) * costCentsPerThousandSourceCharacters);
}

async function assertSourceWithinConfiguredLimit(ctx: PluginContext, contents: string) {
  const config = await ctx.config.get();
  const maxSourceBytes = normalizeMaxSourceBytes(config.maxSourceBytes);
  const sourceBytes = byteLength(contents);
  if (sourceBytes > maxSourceBytes) {
    throw new Error(`Source content is ${sourceBytes} bytes, which exceeds the configured LLM Wiki source limit of ${maxSourceBytes} bytes.`);
  }
}

function normalizeEventIngestionSettings(value: unknown): WikiEventIngestionSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_EVENT_INGESTION_SETTINGS, sources: { ...DEFAULT_EVENT_INGESTION_SETTINGS.sources } };
  }
  const record = value as Record<string, unknown>;
  const sources = record.sources && typeof record.sources === "object" && !Array.isArray(record.sources)
    ? record.sources as Record<string, unknown>
    : {};
  const maxCharacters = typeof record.maxCharacters === "number" && Number.isFinite(record.maxCharacters)
    ? Math.max(1000, Math.min(MAX_EVENT_SOURCE_CHARS, Math.floor(record.maxCharacters)))
    : DEFAULT_EVENT_INGESTION_SETTINGS.maxCharacters;
  return {
    enabled: normalizeBoolean(record.enabled, DEFAULT_EVENT_INGESTION_SETTINGS.enabled),
    sources: {
      issues: normalizeBoolean(sources.issues, DEFAULT_EVENT_INGESTION_SETTINGS.sources.issues),
      comments: normalizeBoolean(sources.comments, DEFAULT_EVENT_INGESTION_SETTINGS.sources.comments),
      documents: normalizeBoolean(sources.documents, DEFAULT_EVENT_INGESTION_SETTINGS.sources.documents),
    },
    wikiId: normalizeWikiId(record.wikiId),
    maxCharacters,
  };
}

function defaultPaperclipIngestionProfile(input: {
  space: Pick<WikiSpace, "slug">;
  legacySettings?: WikiEventIngestionSettings | null;
}): PaperclipIngestionProfileV1 {
  const legacy = input.space.slug === DEFAULT_SPACE_SLUG ? input.legacySettings : null;
  return {
    version: 1,
    enabled: legacy?.enabled ?? false,
    sourceScopes: legacy?.enabled ? [{ kind: "company_all", requiresBoardConfirmation: true }] : [],
    sourceKinds: {
      issues: legacy?.sources.issues ?? true,
      comments: legacy?.sources.comments ?? true,
      documents: legacy?.sources.documents ?? true,
      attachments: "off",
      workProducts: "off",
    },
    cursor: {
      maxWindowCharacters: DEFAULT_MAX_PAPERCLIP_CURSOR_WINDOW_CHARS,
      maxCharactersPerSource: DEFAULT_MAX_PAPERCLIP_ISSUE_SOURCE_CHARS,
      minSourceAgeMinutes: 15,
      maxWindowsPerRun: 6,
      staleAfterHours: 72,
    },
    backfill: {
      defaultStartAt: null,
      defaultEndAt: null,
      requireManualQueue: true,
    },
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => stringField(item)).filter((item): item is string => Boolean(item)))];
}

function normalizePaperclipIngestionSourceScope(value: unknown): PaperclipIngestionSourceScope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = stringField(record.kind);
  if (kind === "active_projects") {
    const statuses = Array.isArray(record.statuses)
      ? record.statuses.filter((status): status is "in_progress" | "todo" | "done" =>
          status === "in_progress" || status === "todo" || status === "done")
      : undefined;
    return {
      kind,
      limit: normalizeLimit(record.limit, 3, MAX_PAPERCLIP_PROFILE_SELECTED_PROJECTS),
      ...(statuses && statuses.length > 0 ? { statuses: [...new Set(statuses)] } : {}),
    };
  }
  if (kind === "selected_projects") {
    return { kind, projectIds: stringArray(record.projectIds).slice(0, MAX_PAPERCLIP_PROFILE_SELECTED_PROJECTS) };
  }
  if (kind === "root_issues") {
    return { kind, issueIds: stringArray(record.issueIds).slice(0, MAX_PAPERCLIP_PROFILE_ROOT_ISSUES) };
  }
  if (kind === "company_all") {
    return { kind, requiresBoardConfirmation: true };
  }
  return null;
}

function normalizePaperclipIngestionProfile(
  value: unknown,
  input: { space: Pick<WikiSpace, "slug">; legacySettings?: WikiEventIngestionSettings | null },
): PaperclipIngestionProfileV1 {
  const fallback = defaultPaperclipIngestionProfile(input);
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  const sourceKinds = record.sourceKinds && typeof record.sourceKinds === "object" && !Array.isArray(record.sourceKinds)
    ? record.sourceKinds as Record<string, unknown>
    : {};
  const cursor = record.cursor && typeof record.cursor === "object" && !Array.isArray(record.cursor)
    ? record.cursor as Record<string, unknown>
    : {};
  const backfill = record.backfill && typeof record.backfill === "object" && !Array.isArray(record.backfill)
    ? record.backfill as Record<string, unknown>
    : {};
  return {
    version: 1,
    enabled: normalizeBoolean(record.enabled, fallback.enabled),
    sourceScopes: Array.isArray(record.sourceScopes)
      ? record.sourceScopes.map(normalizePaperclipIngestionSourceScope).filter((scope): scope is PaperclipIngestionSourceScope => Boolean(scope))
      : fallback.sourceScopes,
    sourceKinds: {
      issues: normalizeBoolean(sourceKinds.issues, fallback.sourceKinds.issues),
      comments: normalizeBoolean(sourceKinds.comments, fallback.sourceKinds.comments),
      documents: normalizeBoolean(sourceKinds.documents, fallback.sourceKinds.documents),
      attachments: sourceKinds.attachments === "metadata_only" ? "metadata_only" : "off",
      workProducts: sourceKinds.workProducts === "metadata_only" ? "metadata_only" : "off",
    },
    cursor: {
      maxWindowCharacters: normalizeLimit(cursor.maxWindowCharacters, fallback.cursor.maxWindowCharacters, DEFAULT_MAX_PAPERCLIP_CURSOR_WINDOW_CHARS),
      maxCharactersPerSource: normalizeLimit(cursor.maxCharactersPerSource, fallback.cursor.maxCharactersPerSource, DEFAULT_MAX_PAPERCLIP_ISSUE_SOURCE_CHARS),
      minSourceAgeMinutes: normalizeLimit(cursor.minSourceAgeMinutes, fallback.cursor.minSourceAgeMinutes, 24 * 60),
      maxWindowsPerRun: normalizeLimit(cursor.maxWindowsPerRun, fallback.cursor.maxWindowsPerRun, 25),
      staleAfterHours: normalizeLimit(cursor.staleAfterHours, fallback.cursor.staleAfterHours, 24 * 30),
    },
    backfill: {
      defaultStartAt: isoString(backfill.defaultStartAt),
      defaultEndAt: isoString(backfill.defaultEndAt),
      requireManualQueue: normalizeBoolean(backfill.requireManualQueue, fallback.backfill.requireManualQueue),
    },
  };
}

async function profileForSpace(ctx: PluginContext, companyId: string, space: WikiSpace): Promise<PaperclipIngestionProfileV1> {
  const legacySettings = space.slug === DEFAULT_SPACE_SLUG ? await getEventIngestionSettings(ctx, companyId) : null;
  return normalizePaperclipIngestionProfile(space.settings.paperclipIngestion, { space, legacySettings });
}

function eventIngestionStateKey(companyId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: EVENT_INGESTION_STATE_NAMESPACE,
    stateKey: EVENT_INGESTION_STATE_KEY,
  };
}

function eventIngestionDedupKey(companyId: string, wikiId: string, spaceId: string, sourceKind: WikiEventIngestionSource, sourceId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: EVENT_INGESTION_DEDUP_NAMESPACE,
    stateKey: `${wikiId}:${spaceId}:${sourceKind}:${sourceId}`,
  };
}

export async function getEventIngestionSettings(ctx: PluginContext, companyId: string): Promise<WikiEventIngestionSettings> {
  return normalizeEventIngestionSettings(await ctx.state.get(eventIngestionStateKey(companyId)));
}

function evaluatePaperclipProfilePolicy(input: {
  space: WikiSpace;
  profile?: PaperclipIngestionProfileV1 | null;
  purpose: PaperclipIngestionPolicyPurpose;
  requireEnabledProfile?: boolean;
}): PaperclipIngestionPolicyDecision {
  const { space, profile, purpose } = input;
  if (space.status !== "active") {
    return {
      allowed: false,
      space,
      reason: "archived_space",
      message: `Paperclip ingestion policy denied ${purpose}: space "${space.slug}" is ${space.status}.`,
    };
  }
  if (space.accessScope !== "shared") {
    return {
      allowed: false,
      space,
      reason: "restricted_space",
      message: `Paperclip ingestion policy denied ${purpose}: ${space.accessScope} spaces cannot ingest Paperclip sources until host permissions are enforced.`,
    };
  }
  if (input.requireEnabledProfile && space.slug !== DEFAULT_SPACE_SLUG && !profile?.enabled) {
    return {
      allowed: false,
      space,
      reason: "profile_disabled",
      message: `Paperclip ingestion policy denied ${purpose}: Paperclip ingestion is not enabled for space "${space.slug}".`,
    };
  }
  if (input.requireEnabledProfile && space.slug !== DEFAULT_SPACE_SLUG && profile?.enabled && profile.sourceScopes.length === 0) {
    return {
      allowed: false,
      space,
      reason: "profile_empty",
      message: `Paperclip ingestion policy denied ${purpose}: space "${space.slug}" has no source scopes configured.`,
    };
  }
  return { allowed: true, space };
}

export async function getPaperclipIngestionProfile(
  ctx: PluginContext,
  input: { companyId: string; wikiId?: string | null; spaceSlug?: string | null },
): Promise<PaperclipIngestionProfileRead> {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const profile = await profileForSpace(ctx, input.companyId, space);
  const policy = evaluatePaperclipProfilePolicy({ space, profile, purpose: "profile_read" });
  const historicalPageCount = await countPaperclipHistoricalPages(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceId: space.id,
  });
  const overlapCount = await countPaperclipProfileOverlaps(ctx, {
    companyId: input.companyId,
    wikiId,
    space,
    profile,
  });
  const effectiveState: PaperclipIngestionProfileEffectiveState = !policy.allowed
    ? "policy_blocked"
    : profile.enabled && profile.sourceScopes.length === 0
      ? "enabled_no_scopes"
      : profile.enabled
        ? "enabled"
        : "disabled";
  return {
    wikiId,
    space: {
      id: space.id,
      slug: space.slug,
      displayName: space.displayName,
      accessScope: space.accessScope,
      status: space.status,
    },
    profile,
    effectiveState,
    policyBlocks: policy.allowed ? [] : [policy.message],
    historicalPageCount,
    overlapCount,
  };
}

async function countPaperclipHistoricalPages(ctx: PluginContext, input: { companyId: string; wikiId: string; spaceId: string }): Promise<number> {
  const rows = await ctx.db.query<{ count: string | number }>(
    `SELECT count(*)::text AS count
       FROM ${pageBindingTable(ctx)}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3`,
    [input.companyId, input.wikiId, input.spaceId],
  );
  return Number(rows[0]?.count ?? 0) || 0;
}

function scopeIdentity(scope: PaperclipIngestionSourceScope): string[] {
  if (scope.kind === "active_projects") return [`active_projects:${scope.limit}`];
  if (scope.kind === "selected_projects") return scope.projectIds.map((id) => `project:${id}`);
  if (scope.kind === "root_issues") return scope.issueIds.map((id) => `root_issue:${id}`);
  return ["company_all"];
}

async function countPaperclipProfileOverlaps(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  space: WikiSpace;
  profile: PaperclipIngestionProfileV1;
}): Promise<number> {
  if (!input.profile.enabled || input.profile.sourceScopes.length === 0) return 0;
  const own = new Set(input.profile.sourceScopes.flatMap(scopeIdentity));
  if (own.size === 0) return 0;
  const { spaces } = await listSpaces(ctx, { companyId: input.companyId, wikiId: input.wikiId });
  let overlaps = 0;
  for (const space of spaces) {
    if (space.id === input.space.id) continue;
    const profile = await profileForSpace(ctx, input.companyId, space);
    if (!profile.enabled) continue;
    for (const key of profile.sourceScopes.flatMap(scopeIdentity)) {
      if (own.has(key)) overlaps += 1;
    }
  }
  return overlaps;
}

async function validatePaperclipIngestionProfile(ctx: PluginContext, input: {
  companyId: string;
  space: WikiSpace;
  profile: PaperclipIngestionProfileV1;
}) {
  const policy = evaluatePaperclipProfilePolicy({
    space: input.space,
    profile: input.profile,
    purpose: "profile_update",
    requireEnabledProfile: input.profile.enabled && input.space.slug !== DEFAULT_SPACE_SLUG,
  });
  if (!policy.allowed) throw new Error(policy.message);
  if (input.profile.enabled && input.profile.sourceScopes.length === 0) {
    throw new Error("Paperclip ingestion profile must include at least one source scope before it can be enabled.");
  }
  if (input.profile.sourceScopes.length > MAX_PAPERCLIP_INGESTION_PROFILE_SOURCE_COUNT) {
    throw new Error(`Paperclip ingestion profile sources exceed the hard cap of ${MAX_PAPERCLIP_INGESTION_PROFILE_SOURCE_COUNT}.`);
  }
  for (const scope of input.profile.sourceScopes) {
    if (scope.kind === "company_all" && input.space.slug !== DEFAULT_SPACE_SLUG) {
      throw new Error("Everything in the company is only available on the default wiki space.");
    }
    if (scope.kind === "selected_projects") {
      if (scope.projectIds.length > MAX_PAPERCLIP_PROFILE_SELECTED_PROJECTS) {
        throw new Error(`selected_projects exceeds the hard cap of ${MAX_PAPERCLIP_PROFILE_SELECTED_PROJECTS}.`);
      }
      for (const projectId of scope.projectIds) {
        const project = await ctx.projects.get(projectId, input.companyId);
        if (!project) throw new Error(`Project belongs to another company or does not exist: ${projectId}`);
      }
    }
    if (scope.kind === "root_issues") {
      if (scope.issueIds.length > MAX_PAPERCLIP_PROFILE_ROOT_ISSUES) {
        throw new Error(`root_issues exceeds the hard cap of ${MAX_PAPERCLIP_PROFILE_ROOT_ISSUES}.`);
      }
      for (const issueId of scope.issueIds) {
        const issue = await ctx.issues.get(issueId, input.companyId);
        if (!issue) throw new Error(`Issue belongs to another company or does not exist: ${issueId}`);
      }
    }
  }
}

export async function updatePaperclipIngestionProfile(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  profile: unknown;
}): Promise<PaperclipIngestionProfileRead> {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const current = await profileForSpace(ctx, input.companyId, space);
  const profile = normalizePaperclipIngestionProfile(input.profile, { space, legacySettings: space.slug === DEFAULT_SPACE_SLUG ? await getEventIngestionSettings(ctx, input.companyId) : null });
  await validatePaperclipIngestionProfile(ctx, { companyId: input.companyId, space, profile });
  await updateSpace(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceSlug: space.slug,
    settings: { paperclipIngestion: profile },
  });
  if (space.slug === DEFAULT_SPACE_SLUG) {
    await ctx.state.set(eventIngestionStateKey(input.companyId), {
      enabled: profile.enabled,
      wikiId,
      maxCharacters: profile.cursor.maxCharactersPerSource,
      sources: {
        issues: profile.sourceKinds.issues,
        comments: profile.sourceKinds.comments,
        documents: profile.sourceKinds.documents,
      },
    });
  }
  await ctx.activity.log({
    companyId: input.companyId,
    message: `Updated Paperclip ingestion profile for ${space.displayName}`,
    entityType: "llm_wiki_space",
    entityId: space.id,
    metadata: {
      type: "plugin.llm_wiki.paperclip_ingestion_profile_updated",
      wikiId,
      spaceSlug: space.slug,
      beforeEnabled: current.enabled,
      afterEnabled: profile.enabled,
      sourceScopeKinds: profile.sourceScopes.map((scope) => scope.kind),
      sourceKinds: profile.sourceKinds,
      cursor: profile.cursor,
    },
  });
  return getPaperclipIngestionProfile(ctx, { companyId: input.companyId, wikiId, spaceSlug: space.slug });
}

export async function listPaperclipIngestionCandidates(ctx: PluginContext, input: PaperclipIngestionCandidatesInput): Promise<{
  projects: Array<{ id: string; name: string; status: string; updatedAt: string | null }>;
  rootIssues: Array<{ id: string; identifier: string | null; title: string; status: string; projectId: string | null }>;
}> {
  const wikiId = normalizeWikiId(input.wikiId);
  await requirePaperclipIngestionPolicy(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug }, "candidate_search");
  const query = stringField(input.query)?.toLowerCase() ?? "";
  const projects = (await ctx.projects.list({ companyId: input.companyId, limit: 200 }))
    .filter((project) => !project.archivedAt)
    .filter((project) => !query || project.name.toLowerCase().includes(query))
    .slice(0, 50)
    .map((project) => ({
      id: project.id,
      name: project.name,
      status: project.status,
      updatedAt: isoString(project.updatedAt),
    }));
  const issues = (await ctx.issues.list({
    companyId: input.companyId,
    includePluginOperations: false,
    limit: 200,
  }))
    .filter((issue) => !issue.parentId)
    .filter((issue) => !query || issue.title.toLowerCase().includes(query) || issue.identifier?.toLowerCase().includes(query))
    .slice(0, 50)
    .map((issue) => ({
      id: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
      status: issue.status,
      projectId: issue.projectId ?? null,
    }));
  return { projects, rootIssues: issues };
}

export async function updateEventIngestionSettings(
  ctx: PluginContext,
  input: { companyId: string; settings: WikiEventIngestionSettingsUpdate },
): Promise<WikiEventIngestionSettings> {
  await requirePaperclipIngestionPolicy(ctx, {
    companyId: input.companyId,
    wikiId: normalizeWikiId(input.settings.wikiId),
    spaceSlug: DEFAULT_SPACE_SLUG,
  }, "profile_update");
  const sourceKeys = Object.keys(input.settings.sources ?? {});
  if (sourceKeys.length > MAX_PAPERCLIP_INGESTION_PROFILE_SOURCE_COUNT) {
    throw new Error(`Paperclip ingestion profile sources exceed the hard cap of ${MAX_PAPERCLIP_INGESTION_PROFILE_SOURCE_COUNT}.`);
  }
  assertRequestedCharacterLimit("maxCharacters", input.settings.maxCharacters, MAX_EVENT_SOURCE_CHARS);
  const current = await getEventIngestionSettings(ctx, input.companyId);
  const next = normalizeEventIngestionSettings({
    ...current,
    ...input.settings,
    sources: {
      ...current.sources,
      ...(input.settings.sources ?? {}),
    },
  });
  await ctx.state.set(eventIngestionStateKey(input.companyId), next);
  const defaultSpace = await ensureDefaultSpace(ctx, { companyId: input.companyId, wikiId: next.wikiId });
  const profile = normalizePaperclipIngestionProfile(
    {
      ...defaultPaperclipIngestionProfile({ space: defaultSpace, legacySettings: next }),
      enabled: next.enabled,
      sourceKinds: {
        issues: next.sources.issues,
        comments: next.sources.comments,
        documents: next.sources.documents,
        attachments: "off",
        workProducts: "off",
      },
      cursor: {
        ...defaultPaperclipIngestionProfile({ space: defaultSpace, legacySettings: next }).cursor,
        maxCharactersPerSource: next.maxCharacters,
      },
    },
    { space: defaultSpace, legacySettings: next },
  );
  await updateSpace(ctx, {
    companyId: input.companyId,
    wikiId: next.wikiId,
    spaceSlug: DEFAULT_SPACE_SLUG,
    settings: { paperclipIngestion: profile },
  });
  return next;
}

function assertWikiPath(path: string, options: { allowMetadata?: boolean } = {}): string {
  const trimmed = path.trim().replace(/^\/+/, "");
  if (
    !trimmed ||
    trimmed.includes("\\") ||
    trimmed.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid wiki path: ${path}`);
  }
  if (
    trimmed !== ".gitignore" &&
    trimmed !== "WIKI.md" &&
    trimmed !== "AGENTS.md" &&
    trimmed !== "IDEA.md" &&
    trimmed !== "index.md" &&
    trimmed !== "log.md" &&
    !trimmed.startsWith("raw/") &&
    !trimmed.startsWith("wiki/") &&
    !(options.allowMetadata && trimmed.startsWith(".paperclip/"))
  ) {
    throw new Error(`Wiki path must stay inside AGENTS.md, IDEA.md, raw/, or wiki/: ${path}`);
  }
  return trimmed;
}

function assertPagePath(path: string): string {
  const normalized = assertWikiPath(path);
  if (normalized !== "index.md" && normalized !== "log.md" && normalized !== "WIKI.md" && normalized !== "AGENTS.md" && normalized !== "IDEA.md" && !normalized.startsWith("wiki/")) {
    throw new Error(`Wiki page writes must target AGENTS.md, IDEA.md, or wiki/: ${path}`);
  }
  if (!normalized.endsWith(".md")) {
    throw new Error(`Wiki page path must be a markdown file: ${path}`);
  }
  return normalized;
}

function assertPageWriteAllowed(path: string, writer: WritePageInput["writer"] = "agent_tool"): void {
  if (writer !== "board_ui" && PROTECTED_WIKI_CONTROL_FILES.has(path)) {
    throw new Error(`Refusing to overwrite protected wiki control file ${path}; board-managed edits must use the wiki UI.`);
  }
}

function assertRawPath(path: string): string {
  const normalized = assertWikiPath(path);
  if (!normalized.startsWith("raw/")) {
    throw new Error(`Source path must stay inside raw/: ${path}`);
  }
  return normalized;
}

function tableName(namespace: string, table: string): string {
  return `${namespace}.${table}`;
}

function spaceTable(ctx: PluginContext): string {
  return tableName(ctx.db.namespace, "wiki_spaces");
}

function bindingTable(ctx: PluginContext): string {
  return tableName(ctx.db.namespace, "wiki_resource_bindings");
}

function distillationCursorTable(ctx: PluginContext): string {
  return tableName(ctx.db.namespace, "paperclip_distillation_cursors");
}

function distillationRunTable(ctx: PluginContext): string {
  return tableName(ctx.db.namespace, "paperclip_distillation_runs");
}

function sourceSnapshotTable(ctx: PluginContext): string {
  return tableName(ctx.db.namespace, "paperclip_source_snapshots");
}

function distillationWorkItemTable(ctx: PluginContext): string {
  return tableName(ctx.db.namespace, "paperclip_distillation_work_items");
}

function pageBindingTable(ctx: PluginContext): string {
  return tableName(ctx.db.namespace, "paperclip_page_bindings");
}

function parseBindingMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

type WikiSpaceRow = {
  id: string;
  company_id: string;
  wiki_id: string;
  slug: string;
  display_name: string;
  space_type: string;
  folder_mode: string;
  root_folder_key: string;
  path_prefix: string | null;
  configured_root_path: string | null;
  access_scope: string;
  owner_user_id: string | null;
  owner_agent_id: string | null;
  team_key: string | null;
  binding_kind?: string | null;
  project_id?: string | null;
  settings: unknown;
  status: string;
  created_at: string | null;
  updated_at: string | null;
};

function wikiSpaceFromRow(row: WikiSpaceRow): WikiSpace {
  return {
    id: row.id,
    companyId: row.company_id,
    wikiId: row.wiki_id,
    slug: row.slug,
    displayName: row.display_name,
    spaceType: row.space_type,
    folderMode: row.folder_mode,
    rootFolderKey: row.root_folder_key,
    pathPrefix: row.path_prefix,
    configuredRootPath: row.configured_root_path,
    accessScope: row.access_scope,
    ownerUserId: row.owner_user_id,
    ownerAgentId: row.owner_agent_id,
    teamKey: row.team_key,
    bindingKind: row.binding_kind ?? "none",
    projectId: row.project_id ?? null,
    settings: parseJsonObject(row.settings),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fallbackDefaultSpace(input: { companyId: string; wikiId: string }): WikiSpace {
  return {
    id: stableSpaceId({ companyId: input.companyId, wikiId: input.wikiId, slug: DEFAULT_SPACE_SLUG }),
    companyId: input.companyId,
    wikiId: input.wikiId,
    slug: DEFAULT_SPACE_SLUG,
    displayName: DEFAULT_SPACE_SLUG,
    spaceType: "local_folder",
    folderMode: "managed_subfolder",
    rootFolderKey: WIKI_ROOT_FOLDER_KEY,
    pathPrefix: null,
    configuredRootPath: null,
    accessScope: "shared",
    ownerUserId: null,
    ownerAgentId: null,
    teamKey: null,
    bindingKind: "none",
    projectId: null,
    settings: {},
    status: "active",
    createdAt: null,
    updatedAt: null,
  };
}

export async function ensureDefaultSpace(ctx: PluginContext, input: { companyId: string; wikiId?: string | null }): Promise<WikiSpace> {
  const wikiId = normalizeWikiId(input.wikiId);
  const id = stableSpaceId({ companyId: input.companyId, wikiId, slug: DEFAULT_SPACE_SLUG });
  await ctx.db.execute(
    `INSERT INTO ${spaceTable(ctx)} AS wiki_spaces
       (id, company_id, wiki_id, slug, display_name, space_type, folder_mode, root_folder_key, path_prefix, access_scope, status, settings)
     VALUES ($1, $2, $3, 'default', 'default', 'local_folder', 'managed_subfolder', $4, NULL, 'shared', 'active', '{}'::jsonb)
     ON CONFLICT (company_id, wiki_id, slug)
     DO UPDATE SET updated_at = wiki_spaces.updated_at`,
    [id, input.companyId, wikiId, WIKI_ROOT_FOLDER_KEY],
  );
  const rows = await ctx.db.query<WikiSpaceRow>(
    `SELECT id, company_id, wiki_id, slug, display_name, space_type, folder_mode, root_folder_key,
            path_prefix, configured_root_path, access_scope, owner_user_id, owner_agent_id, team_key,
            binding_kind, project_id,
            settings, status, created_at::text AS created_at, updated_at::text AS updated_at
       FROM ${spaceTable(ctx)}
      WHERE company_id = $1 AND wiki_id = $2 AND slug = 'default'
      LIMIT 1`,
    [input.companyId, wikiId],
  );
  return rows[0] ? wikiSpaceFromRow(rows[0]) : fallbackDefaultSpace({ companyId: input.companyId, wikiId });
}

export async function resolveSpace(ctx: PluginContext, input: SpaceInput): Promise<WikiSpace> {
  const wikiId = normalizeWikiId(input.wikiId);
  const slug = normalizeSpaceSlug(input.spaceSlug);
  if (slug === DEFAULT_SPACE_SLUG) {
    return ensureDefaultSpace(ctx, { companyId: input.companyId, wikiId });
  }
  const rows = await ctx.db.query<WikiSpaceRow>(
    `SELECT id, company_id, wiki_id, slug, display_name, space_type, folder_mode, root_folder_key,
            path_prefix, configured_root_path, access_scope, owner_user_id, owner_agent_id, team_key,
            binding_kind, project_id,
            settings, status, created_at::text AS created_at, updated_at::text AS updated_at
       FROM ${spaceTable(ctx)}
      WHERE company_id = $1 AND wiki_id = $2 AND slug = $3 AND status <> 'archived'
      LIMIT 1`,
    [input.companyId, wikiId, slug],
  );
  if (!rows[0]) throw new Error(`LLM Wiki space not found: ${slug}`);
  return wikiSpaceFromRow(rows[0]);
}

async function resolveSpaceAnyStatus(ctx: PluginContext, input: SpaceInput): Promise<WikiSpace> {
  const wikiId = normalizeWikiId(input.wikiId);
  const slug = normalizeSpaceSlug(input.spaceSlug);
  if (slug === DEFAULT_SPACE_SLUG) {
    return ensureDefaultSpace(ctx, { companyId: input.companyId, wikiId });
  }
  const rows = await ctx.db.query<WikiSpaceRow>(
    `SELECT id, company_id, wiki_id, slug, display_name, space_type, folder_mode, root_folder_key,
            path_prefix, configured_root_path, access_scope, owner_user_id, owner_agent_id, team_key,
            binding_kind, project_id,
            settings, status, created_at::text AS created_at, updated_at::text AS updated_at
       FROM ${spaceTable(ctx)}
      WHERE company_id = $1 AND wiki_id = $2 AND slug = $3
      LIMIT 1`,
    [input.companyId, wikiId, slug],
  );
  if (!rows[0]) throw new Error(`LLM Wiki space not found: ${slug}`);
  return wikiSpaceFromRow(rows[0]);
}

export async function listSpaces(ctx: PluginContext, input: { companyId: string; wikiId?: string | null }): Promise<{ spaces: WikiSpace[] }> {
  const wikiId = normalizeWikiId(input.wikiId);
  await ensureDefaultSpace(ctx, { companyId: input.companyId, wikiId });
  const rows = await ctx.db.query<WikiSpaceRow>(
    `SELECT id, company_id, wiki_id, slug, display_name, space_type, folder_mode, root_folder_key,
            path_prefix, configured_root_path, access_scope, owner_user_id, owner_agent_id, team_key,
            binding_kind, project_id,
            settings, status, created_at::text AS created_at, updated_at::text AS updated_at
       FROM ${spaceTable(ctx)}
      WHERE company_id = $1 AND wiki_id = $2 AND status <> 'archived'
      ORDER BY CASE WHEN slug = 'default' THEN 0 ELSE 1 END, display_name, slug`,
    [input.companyId, wikiId],
  );
  const spaces = rows.length > 0 ? rows.map(wikiSpaceFromRow) : [fallbackDefaultSpace({ companyId: input.companyId, wikiId })];
  return { spaces };
}

export async function createSpace(ctx: PluginContext, input: CreateSpaceInput): Promise<{ status: "created"; space: WikiSpace }> {
  const wikiId = normalizeWikiId(input.wikiId);
  const displayName = stringField(input.displayName) ?? stringField(input.slug) ?? "New space";
  const slug = normalizeSpaceSlug(input.slug ?? displayName);
  if (slug === DEFAULT_SPACE_SLUG) {
    return { status: "created", space: await ensureDefaultSpace(ctx, { companyId: input.companyId, wikiId }) };
  }
  const folderMode = input.folderMode ?? "managed_subfolder";
  if (folderMode !== "managed_subfolder") {
    throw new Error("Only managed_subfolder spaces are supported until dynamic local folder bindings are available.");
  }
  const accessScope = input.accessScope ?? "shared";
  const bindingKind = input.bindingKind ?? "none";
  const projectId = bindingKind === "project" ? stringField(input.projectId) : null;
  if (bindingKind === "project" && !projectId) {
    throw new Error("Project-bound spaces require a projectId.");
  }
  const id = randomUUID();
  const pathPrefix = `spaces/${slug}`;
  await ctx.db.execute(
    `INSERT INTO ${spaceTable(ctx)}
       (id, company_id, wiki_id, slug, display_name, space_type, folder_mode, root_folder_key, path_prefix, access_scope, settings, status, binding_kind, project_id)
     VALUES ($1, $2, $3, $4, $5, 'local_folder', $6, $7, $8, $9, $10::jsonb, 'active', $11, $12)`,
    [
      id,
      input.companyId,
      wikiId,
      slug,
      displayName,
      folderMode,
      WIKI_ROOT_FOLDER_KEY,
      pathPrefix,
      accessScope,
      jsonParam(input.settings ?? {}),
      bindingKind,
      projectId,
    ],
  );
  const space: WikiSpace = {
    id,
    companyId: input.companyId,
    wikiId,
    slug,
    displayName,
    spaceType: "local_folder",
    folderMode,
    rootFolderKey: WIKI_ROOT_FOLDER_KEY,
    pathPrefix,
    configuredRootPath: null,
    accessScope,
    ownerUserId: null,
    ownerAgentId: null,
    teamKey: null,
    bindingKind,
    projectId,
    settings: input.settings ?? {},
    status: "active",
    createdAt: null,
    updatedAt: null,
  };
  await bootstrapSpaceFiles(ctx, input.companyId, space);
  await upsertWikiInstance(ctx, { companyId: input.companyId, wikiId });
  return { status: "created", space };
}

export async function updateSpace(ctx: PluginContext, input: UpdateSpaceInput): Promise<{ status: "ok"; space: WikiSpace }> {
  const nextStatus = input.status ?? null;
  if (nextStatus !== null && nextStatus !== "active" && nextStatus !== "archived") {
    throw new Error("LLM Wiki space status must be active or archived.");
  }
  const space = nextStatus === "active" ? await resolveSpaceAnyStatus(ctx, input) : await resolveSpace(ctx, input);
  const nextDisplayName = stringField(input.displayName);
  if (space.slug === DEFAULT_SPACE_SLUG && nextStatus === "archived") {
    throw new Error("The default LLM Wiki space cannot be archived.");
  }
  await ctx.db.execute(
    `UPDATE ${spaceTable(ctx)}
        SET display_name = COALESCE($4, display_name),
            settings = CASE WHEN $5::jsonb IS NULL THEN settings ELSE settings || $5::jsonb END,
            status = COALESCE($6, status),
            updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND slug = $3`,
    [
      input.companyId,
      space.wikiId,
      space.slug,
      nextDisplayName,
      input.settings ? jsonParam(input.settings) : null,
      nextStatus ?? null,
    ],
  );
  if (nextStatus === "archived") {
    return {
      status: "ok",
      space: {
        ...space,
        displayName: nextDisplayName ?? space.displayName,
        settings: input.settings ? { ...space.settings, ...input.settings } : space.settings,
        status: "archived",
      },
    };
  }
  return { status: "ok", space: await resolveSpace(ctx, { companyId: input.companyId, wikiId: space.wikiId, spaceSlug: space.slug }) };
}

export async function archiveSpace(ctx: PluginContext, input: SpaceInput): Promise<{ status: "archived"; space: WikiSpace }> {
  const space = await resolveSpace(ctx, input);
  if (space.slug === DEFAULT_SPACE_SLUG) throw new Error("The default LLM Wiki space cannot be archived.");
  await ctx.db.execute(
    `UPDATE ${spaceTable(ctx)}
        SET status = 'archived', updated_at = now()
      WHERE company_id = $1 AND wiki_id = $2 AND slug = $3`,
    [input.companyId, space.wikiId, space.slug],
  );
  return { status: "archived", space: { ...space, status: "archived" } };
}

export const PROJECT_SPACE_SLUG_PREFIX = "proj-";

// Slugs stay stable after creation; project renames only update display_name so
// the managed subfolder never has to move on disk.
export function projectSpaceSlug(projectName: string, projectId: string): string {
  const base = slugify(projectName).slice(0, 40).replace(/^-+|-+$/g, "");
  return normalizeSpaceSlug(`${PROJECT_SPACE_SLUG_PREFIX}${base || projectId.slice(0, 8)}`);
}

async function querySpaceBySlugAnyStatus(
  ctx: PluginContext,
  input: { companyId: string; wikiId: string; slug: string },
): Promise<WikiSpace | null> {
  const rows = await ctx.db.query<WikiSpaceRow>(
    `SELECT id, company_id, wiki_id, slug, display_name, space_type, folder_mode, root_folder_key,
            path_prefix, configured_root_path, access_scope, owner_user_id, owner_agent_id, team_key,
            binding_kind, project_id,
            settings, status, created_at::text AS created_at, updated_at::text AS updated_at
       FROM ${spaceTable(ctx)}
      WHERE company_id = $1 AND wiki_id = $2 AND slug = $3
      LIMIT 1`,
    [input.companyId, input.wikiId, input.slug],
  );
  return rows[0] ? wikiSpaceFromRow(rows[0]) : null;
}

export async function findProjectSpace(
  ctx: PluginContext,
  input: { companyId: string; wikiId?: string | null; projectId: string },
): Promise<WikiSpace | null> {
  const wikiId = normalizeWikiId(input.wikiId);
  const rows = await ctx.db.query<WikiSpaceRow>(
    `SELECT id, company_id, wiki_id, slug, display_name, space_type, folder_mode, root_folder_key,
            path_prefix, configured_root_path, access_scope, owner_user_id, owner_agent_id, team_key,
            binding_kind, project_id,
            settings, status, created_at::text AS created_at, updated_at::text AS updated_at
       FROM ${spaceTable(ctx)}
      WHERE company_id = $1 AND wiki_id = $2 AND project_id = $3
      LIMIT 1`,
    [input.companyId, wikiId, input.projectId],
  );
  return rows[0] ? wikiSpaceFromRow(rows[0]) : null;
}

export type EnsureProjectSpaceResult = {
  status: "created" | "updated" | "unchanged" | "archived" | "skipped";
  space: WikiSpace | null;
  warnings: string[];
};

export async function ensureProjectSpace(
  ctx: PluginContext,
  input: { companyId: string; wikiId?: string | null; project: Project },
): Promise<EnsureProjectSpaceResult> {
  const wikiId = normalizeWikiId(input.wikiId);
  const project = input.project;
  const warnings: string[] = [];
  if (project.companyId !== input.companyId) {
    return { status: "skipped", space: null, warnings: [`Project ${project.id} belongs to another company.`] };
  }
  if (project.managedByPlugin) {
    return { status: "skipped", space: null, warnings: [] };
  }
  const projectArchived = Boolean(project.archivedAt);
  const existing = await findProjectSpace(ctx, { companyId: input.companyId, wikiId, projectId: project.id });

  if (existing) {
    if (projectArchived) {
      if (existing.status === "archived") return { status: "unchanged", space: existing, warnings };
      await ctx.db.execute(
        `UPDATE ${spaceTable(ctx)} SET status = 'archived', updated_at = now() WHERE company_id = $1 AND wiki_id = $2 AND id = $3`,
        [input.companyId, wikiId, existing.id],
      );
      return { status: "archived", space: { ...existing, status: "archived" }, warnings };
    }
    if (existing.displayName === project.name && existing.status === "active") {
      return { status: "unchanged", space: existing, warnings };
    }
    await ctx.db.execute(
      `UPDATE ${spaceTable(ctx)} SET display_name = $4, status = 'active', updated_at = now() WHERE company_id = $1 AND wiki_id = $2 AND id = $3`,
      [input.companyId, wikiId, existing.id, project.name],
    );
    return { status: "updated", space: { ...existing, displayName: project.name, status: "active" }, warnings };
  }

  if (projectArchived) {
    return { status: "skipped", space: null, warnings };
  }

  try {
    await ensureWikiRootConfigured(ctx, input.companyId);
  } catch (error) {
    warnings.push(`Wiki root is not configured and could not be initialized: ${error instanceof Error ? error.message : String(error)}`);
  }

  let slug = projectSpaceSlug(project.name, project.id);
  const collision = await querySpaceBySlugAnyStatus(ctx, { companyId: input.companyId, wikiId, slug });
  if (collision && collision.projectId !== project.id) {
    slug = normalizeSpaceSlug(`${slug}-${project.id.slice(0, 8)}`);
  }

  const attemptCreate = (spaceSlug: string) => createSpace(ctx, {
    companyId: input.companyId,
    wikiId,
    slug: spaceSlug,
    displayName: project.name,
    accessScope: "shared",
    bindingKind: "project",
    projectId: project.id,
  });

  try {
    const created = await attemptCreate(slug);
    return { status: "created", space: created.space, warnings };
  } catch (error) {
    // createSpace bootstraps skeleton files after inserting the row; when the
    // wiki root is unavailable the row may still exist, so surface the space if
    // it does instead of failing the whole reconcile.
    const space = await findProjectSpace(ctx, { companyId: input.companyId, wikiId, projectId: project.id });
    warnings.push(`Project space files pending: ${error instanceof Error ? error.message : String(error)}`);
    if (space) return { status: "created", space, warnings };
    // Losing a slug race against a concurrently created same-name project
    // leaves no row for this project; retry once with the deterministic
    // project-id suffix before giving up.
    const suffixed = normalizeSpaceSlug(`${projectSpaceSlug(project.name, project.id)}-${project.id.slice(0, 8)}`);
    if (slug !== suffixed) {
      try {
        const retried = await attemptCreate(suffixed);
        return { status: "created", space: retried.space, warnings };
      } catch (retryError) {
        warnings.push(`Retry with suffixed slug failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
        const raced = await findProjectSpace(ctx, { companyId: input.companyId, wikiId, projectId: project.id });
        if (raced) return { status: "created", space: raced, warnings };
      }
    }
    return { status: "skipped", space: null, warnings };
  }
}

const PROJECT_LIST_PAGE_SIZE = 200;
const PROJECT_LIST_MAX_PAGES = 50;

// ctx.projects.list windows results host-side, so a single capped call
// silently truncates large companies; page until a short page instead.
export async function listAllCompanyProjects(ctx: PluginContext, companyId: string): Promise<Project[]> {
  const projects: Project[] = [];
  for (let page = 0; page < PROJECT_LIST_MAX_PAGES; page += 1) {
    const batch = await ctx.projects.list({
      companyId,
      limit: PROJECT_LIST_PAGE_SIZE,
      offset: page * PROJECT_LIST_PAGE_SIZE,
    });
    projects.push(...batch);
    if (batch.length < PROJECT_LIST_PAGE_SIZE) return projects;
  }
  return projects;
}

export type ReconcileProjectSpacesResult = {
  status: "ok";
  wikiId: string;
  created: string[];
  updated: string[];
  archived: string[];
  skipped: string[];
  warnings: string[];
};

export async function reconcileProjectSpaces(
  ctx: PluginContext,
  input: { companyId: string; wikiId?: string | null },
): Promise<ReconcileProjectSpacesResult> {
  const wikiId = normalizeWikiId(input.wikiId);
  const projects = await listAllCompanyProjects(ctx, input.companyId);
  const result: ReconcileProjectSpacesResult = {
    status: "ok",
    wikiId,
    created: [],
    updated: [],
    archived: [],
    skipped: [],
    warnings: [],
  };
  const activeProjectIds = new Set<string>();
  for (const project of projects) {
    if (!project.archivedAt && !project.managedByPlugin) activeProjectIds.add(project.id);
    const outcome = await ensureProjectSpace(ctx, { companyId: input.companyId, wikiId, project });
    result.warnings.push(...outcome.warnings);
    const label = outcome.space ? `${outcome.space.slug} (${project.name})` : project.name;
    if (outcome.status === "created") result.created.push(label);
    else if (outcome.status === "updated") result.updated.push(label);
    else if (outcome.status === "archived") result.archived.push(label);
    else if (outcome.status === "skipped") result.skipped.push(label);
  }

  const rows = await ctx.db.query<WikiSpaceRow>(
    `SELECT id, company_id, wiki_id, slug, display_name, space_type, folder_mode, root_folder_key,
            path_prefix, configured_root_path, access_scope, owner_user_id, owner_agent_id, team_key,
            binding_kind, project_id,
            settings, status, created_at::text AS created_at, updated_at::text AS updated_at
       FROM ${spaceTable(ctx)}
      WHERE company_id = $1 AND wiki_id = $2 AND binding_kind = 'project' AND status <> 'archived'`,
    [input.companyId, wikiId],
  );
  for (const row of rows.map(wikiSpaceFromRow)) {
    if (row.projectId && activeProjectIds.has(row.projectId)) continue;
    // The snapshot can miss projects created while this reconcile was running
    // (fire-and-forget startup sweep racing project.created handlers), so
    // confirm against live state before archiving.
    if (row.projectId) {
      const project = await ctx.projects.get(row.projectId, input.companyId);
      if (project && !project.archivedAt) continue;
    }
    await ctx.db.execute(
      `UPDATE ${spaceTable(ctx)} SET status = 'archived', updated_at = now() WHERE company_id = $1 AND wiki_id = $2 AND id = $3`,
      [input.companyId, wikiId, row.id],
    );
    result.archived.push(row.slug);
  }
  return result;
}

export function spaceRelativePath(space: Pick<WikiSpace, "pathPrefix">, path: string): string {
  const normalized = path.replace(/^\/+/, "");
  return space.pathPrefix ? `${space.pathPrefix}/${normalized}` : normalized;
}

function logicalPathFromSpacePath(space: Pick<WikiSpace, "pathPrefix">, path: string): string {
  if (!space.pathPrefix) return path;
  const prefix = `${space.pathPrefix}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export async function spaceFolderStatus(ctx: PluginContext, input: SpaceInput): Promise<WikiSpaceWithFolderStatus> {
  const space = await resolveSpace(ctx, input);
  const folder = await ctx.localFolders.status(input.companyId, WIKI_ROOT_FOLDER_KEY);
  return {
    ...space,
    relativeRoot: space.pathPrefix ?? ".",
    folder,
  };
}

async function getResourceBinding(
  ctx: PluginContext,
  input: { companyId: string; wikiId: string; resourceKind: WikiResourceKind; resourceKey: string },
): Promise<WikiResourceBinding | null> {
  const rows = await ctx.db.query<{ resolved_id: string | null; metadata: unknown }>(
    `SELECT resolved_id, metadata
       FROM ${bindingTable(ctx)}
      WHERE company_id = $1
        AND wiki_id = $2
        AND resource_kind = $3
        AND resource_key = $4
      LIMIT 1`,
    [input.companyId, input.wikiId, input.resourceKind, input.resourceKey],
  );
  const row = rows[0];
  return row ? { resolvedId: row.resolved_id, metadata: parseBindingMetadata(row.metadata) } : null;
}

async function upsertResourceBinding(
  ctx: PluginContext,
  input: { companyId: string; wikiId: string; resourceKind: WikiResourceKind; resourceKey: string; resolvedId: string; metadata?: Record<string, unknown> },
) {
  await ctx.db.execute(
    `INSERT INTO ${bindingTable(ctx)} AS wiki_resource_bindings
       (id, company_id, wiki_id, resource_kind, resource_key, resolved_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (company_id, wiki_id, resource_kind, resource_key)
     DO UPDATE SET resolved_id = EXCLUDED.resolved_id,
                   metadata = EXCLUDED.metadata,
                   updated_at = now()`,
    [
      randomUUID(),
      input.companyId,
      input.wikiId,
      input.resourceKind,
      input.resourceKey,
      input.resolvedId,
      jsonParam(input.metadata ?? {}),
    ],
  );
}

function agentDetails(agent: Agent | null): WikiAgentResource["details"] {
  return agent
    ? { name: agent.name, status: agent.status, adapterType: agent.adapterType ?? null, icon: agent.icon ?? null, urlKey: agent.urlKey ?? null }
    : null;
}

function projectDetails(project: Project | null): WikiProjectResource["details"] {
  return project ? { name: project.name, status: project.status, color: project.color ?? null } : null;
}

function skillDetails(skill: PluginManagedSkillResolution["skill"]): WikiSkillResource["details"] {
  return skill
    ? { name: skill.name, key: skill.key, description: skill.description ?? null }
    : null;
}

function agentResource(input: {
  status: WikiAgentResource["status"];
  source: WikiAgentResource["source"];
  agent: Agent | null;
  defaultDrift?: WikiAgentResource["defaultDrift"];
}): WikiAgentResource {
  return {
    status: input.status,
    source: input.source,
    agentId: input.agent?.id ?? null,
    resourceKey: `${PLUGIN_ID}:agent:${WIKI_MAINTAINER_AGENT_KEY}`,
    agent: input.agent,
    details: agentDetails(input.agent),
    defaultDrift: input.defaultDrift ?? null,
  };
}

function projectResource(input: {
  status: WikiProjectResource["status"];
  source: WikiProjectResource["source"];
  project: Project | null;
}): WikiProjectResource {
  return {
    status: input.status,
    source: input.source,
    projectId: input.project?.id ?? null,
    resourceKey: `${PLUGIN_ID}:project:${WIKI_PROJECT_KEY}`,
    project: input.project,
    details: projectDetails(input.project),
  };
}

function skillResource(resolved: PluginManagedSkillResolution): WikiSkillResource {
  return {
    status: resolved.status,
    skillId: resolved.skillId,
    resourceKey: resolved.resourceKey,
    skill: resolved.skill,
    details: skillDetails(resolved.skill),
    defaultDrift: resolved.defaultDrift ?? null,
  };
}

async function resolveSelectedAgent(ctx: PluginContext, companyId: string, binding: WikiResourceBinding | null) {
  if (!binding?.resolvedId) return null;
  const agent = await ctx.agents.get(binding.resolvedId, companyId);
  return agent && agent.status !== "terminated" ? agent : null;
}

async function resolveSelectedProject(ctx: PluginContext, companyId: string, binding: WikiResourceBinding | null) {
  if (!binding?.resolvedId) return null;
  return ctx.projects.get(binding.resolvedId, companyId);
}

function inferTitle(path: string, contents: string): string {
  const heading = contents.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  const filename = path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
  return filename.replace(/[-_]+/g, " ");
}

function inferPageType(path: string): string | null {
  if (/^wiki\/projects\/[^/]+\/standup\.md$/.test(path)) return "project-standup";
  const match = path.match(/^wiki\/([^/]+)\//);
  return match?.[1] ?? (path === "index.md" || path === "wiki/index.md" ? "index" : path === "log.md" || path === "wiki/log.md" ? "log" : null);
}

const WIKI_LINK_TOKEN_PATTERN = /\[\[([^\]\r\n]+)\]\]/g;
const ROOT_WIKI_LINK_PAGES = new Set(["WIKI.md", "AGENTS.md", "IDEA.md", "index.md", "log.md"]);

// Must mirror normalizeWikiLinkPagePath in src/ui/app.tsx so indexed backlinks
// match the pages the renderer actually links to.
function normalizeWikiLinkTarget(target: string): string | null {
  const [rawTarget] = target.split("|");
  const trimmed = rawTarget?.trim() ?? "";
  if (!trimmed || trimmed.includes("[") || trimmed.includes("]")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return null;
  const hashIndex = trimmed.indexOf("#");
  const rawPath = (hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed).trim().replace(/^\/+/, "");
  if (
    !rawPath ||
    rawPath.includes("\\") ||
    rawPath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  let path = rawPath.toLowerCase().endsWith(".md") ? rawPath : `${rawPath}.md`;
  if (!path.startsWith("wiki/") && !path.startsWith("raw/") && !ROOT_WIKI_LINK_PAGES.has(path)) {
    path = `wiki/${path}`;
  }
  return path;
}

function stripCodeSegments(contents: string): string {
  return contents.replace(/```[\s\S]*?```/g, "").replace(/`[^`\r\n]*`/g, "");
}

function extractWikiLinks(contents: string): string[] {
  const links = new Set<string>();
  const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const match of contents.matchAll(markdownLinkPattern)) {
    const target = match[1]?.split("#")[0]?.trim();
    if (target && (target.startsWith("wiki/") || target === "index.md" || target === "log.md" || target === "AGENTS.md" || target === "IDEA.md")) {
      links.add(target);
    }
  }
  const wikiTokenPattern = /\bwiki\/[A-Za-z0-9._/-]+\.md\b/g;
  for (const match of contents.matchAll(wikiTokenPattern)) {
    links.add(match[0]);
  }
  for (const match of stripCodeSegments(contents).matchAll(WIKI_LINK_TOKEN_PATTERN)) {
    const normalized = normalizeWikiLinkTarget(match[1] ?? "");
    if (normalized) links.add(normalized);
  }
  return [...links].sort();
}

async function readCurrentWithHash(
  ctx: PluginContext,
  companyId: string,
  path: string,
  space: Pick<WikiSpace, "pathPrefix">,
): Promise<{ contents: string | null; hash: string | null }> {
  try {
    const contents = await ctx.localFolders.readText(companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, path));
    return { contents, hash: contentHash(contents) };
  } catch {
    return { contents: null, hash: null };
  }
}

async function filterReadableRows<T>(
  ctx: PluginContext,
  companyId: string,
  space: Pick<WikiSpace, "pathPrefix">,
  rows: T[],
  pathForRow: (row: T) => string,
): Promise<T[]> {
  const checks: Array<T | null> = await Promise.all(rows.map(async (row): Promise<T | null> => {
    try {
      await ctx.localFolders.readText(companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, pathForRow(row)));
      return row;
    } catch {
      return null;
    }
  }));
  return checks.filter((row): row is T => row != null);
}

async function listLocalFiles(ctx: PluginContext, input: { companyId: string; space: Pick<WikiSpace, "pathPrefix">; relativePath: "wiki" | "raw" }): Promise<PluginLocalFolderEntry[]> {
  try {
    const relativePath = spaceRelativePath(input.space, input.relativePath);
    const listing = await ctx.localFolders.list(input.companyId, WIKI_ROOT_FOLDER_KEY, {
      relativePath,
      recursive: true,
      maxEntries: LOCAL_BROWSE_FILE_LIMIT,
    });
    return listing.entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({ ...entry, path: logicalPathFromSpacePath(input.space, entry.path) }));
  } catch {
    return [];
  }
}

function mergeLocalPageRows(pages: WikiPageRow[], entries: PluginLocalFolderEntry[]): WikiPageRow[] {
  const byPath = new Map(pages.map((page) => [page.path, page]));
  for (const entry of entries) {
    if (!entry.path.endsWith(".md") || byPath.has(entry.path)) continue;
    byPath.set(entry.path, {
      path: entry.path,
      title: null,
      pageType: inferPageType(entry.path),
      links: [],
      backlinkCount: 0,
      sourceCount: 0,
      contentHash: null,
      updatedAt: entry.modifiedAt ?? new Date(0).toISOString(),
    });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function mergeLocalSourceRows(sources: WikiSourceRow[], entries: PluginLocalFolderEntry[]): WikiSourceRow[] {
  const byPath = new Map(sources.map((source) => [source.rawPath, source]));
  for (const entry of entries) {
    if (!entry.path.endsWith(".md") || byPath.has(entry.path)) continue;
    byPath.set(entry.path, {
      rawPath: entry.path,
      title: null,
      sourceType: "local_file",
      url: null,
      status: "present",
      createdAt: entry.modifiedAt ?? new Date(0).toISOString(),
    });
  }
  return [...byPath.values()].sort((a, b) => a.rawPath.localeCompare(b.rawPath));
}

export class WikiHashConflictError extends Error {
  readonly currentHash: string | null;
  readonly path: string;

  constructor(path: string, expectedHash: string, currentHash: string | null) {
    super(`Refusing to overwrite ${path}: expected hash ${expectedHash} but current hash is ${currentHash}`);
    this.name = "WikiHashConflictError";
    this.path = path;
    this.currentHash = currentHash;
  }
}

/**
 * A wiki page path that has no file on disk yet. Kept distinct from generic
 * read failures so callers (agent HTTP routes, UI) map it to 404 with a clean
 * message — the underlying fs error embeds the host's absolute path, which must
 * never reach an agent. The message intentionally contains "not found" so the
 * agent-route error mapper classifies it as 404.
 */
export class WikiPageNotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Wiki page not found: ${path}`);
    this.name = "WikiPageNotFoundError";
    this.path = path;
  }
}

/** True when a local-folder read failed because the target file does not exist. */
function isFileMissingError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  // The error crosses the plugin RPC boundary, where `.code` may be dropped, so
  // also match the ENOENT text and the test harness's "not found" phrasing.
  return /ENOENT|no such file|folder file not found/i.test(message);
}

function assertExpectedHash(expectedHash: string | null | undefined, currentHash: string | null, path: string): void {
  if (expectedHash && currentHash && expectedHash !== currentHash) {
    throw new WikiHashConflictError(path, expectedHash, currentHash);
  }
}

async function upsertWikiInstance(ctx: PluginContext, input: { companyId: string; wikiId: string; rootPath?: string | null }) {
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "wiki_instances")} AS wiki_instances
       (id, company_id, wiki_id, root_folder_key, configured_root_path, schema_version, settings, managed_agent_key, managed_project_key)
     VALUES ($1, $2, $3, $4, $5, 1, '{}'::jsonb, $6, $7)
     ON CONFLICT (company_id, wiki_id)
     DO UPDATE SET configured_root_path = COALESCE(EXCLUDED.configured_root_path, wiki_instances.configured_root_path),
                   managed_agent_key = EXCLUDED.managed_agent_key,
                   managed_project_key = EXCLUDED.managed_project_key,
                   updated_at = now()`,
    [
      randomUUID(),
      input.companyId,
      input.wikiId,
      WIKI_ROOT_FOLDER_KEY,
      input.rootPath ?? null,
      WIKI_MAINTAINER_AGENT_KEY,
      WIKI_PROJECT_KEY,
    ],
  );
}

export type WikiWriteAuthor = {
  kind: "agent" | "user" | "plugin";
  id?: string | null;
  runId?: string | null;
};

const SEARCH_DOCUMENT_MAX_CHARS = 200_000;
const REVISION_CONTENTS_MAX_CHARS = 512_000;

async function upsertSearchDocument(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  spaceId: string;
  docKind: "page" | "source";
  path: string;
  title: string | null;
  contents: string;
  contentHash: string;
}) {
  const bodyText = redactDistillationSensitiveText(input.contents).slice(0, SEARCH_DOCUMENT_MAX_CHARS);
  const title = input.title ? redactDistillationSensitiveText(input.title) : null;
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "wiki_search_documents")}
       (id, company_id, wiki_id, space_id, doc_kind, path, title, body_text, content_hash, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (company_id, wiki_id, space_id, doc_kind, path)
     DO UPDATE SET title = EXCLUDED.title,
                   body_text = EXCLUDED.body_text,
                   content_hash = EXCLUDED.content_hash,
                   updated_at = now()`,
    [randomUUID(), input.companyId, input.wikiId, input.spaceId, input.docKind, input.path, title, bodyText, input.contentHash],
  );
}

async function upsertPageMetadata(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  spaceId: string;
  path: string;
  contents: string;
  summary?: string | null;
  sourceRefs?: unknown;
  operationId?: string | null;
  author?: WikiWriteAuthor | null;
}) {
  const pageId = randomUUID();
  const revisionId = randomUUID();
  const hash = contentHash(input.contents);
  const title = inferTitle(input.path, input.contents);
  const pageType = inferPageType(input.path);
  const backlinks = extractWikiLinks(input.contents);
  const sourceRefs = Array.isArray(input.sourceRefs) ? input.sourceRefs : [];

  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "wiki_pages")}
       (id, company_id, wiki_id, space_id, path, title, page_type, frontmatter, source_refs, backlinks, content_hash, current_revision_id)
     VALUES ($1, $2, $3, $11, $4, $5, $6, '{}'::jsonb, $7::jsonb, $8::jsonb, $9, $10)
     ON CONFLICT (company_id, wiki_id, space_id, path)
     DO UPDATE SET title = EXCLUDED.title,
                   page_type = EXCLUDED.page_type,
                   source_refs = EXCLUDED.source_refs,
                   backlinks = EXCLUDED.backlinks,
                   content_hash = EXCLUDED.content_hash,
                   current_revision_id = EXCLUDED.current_revision_id,
                   updated_at = now()`,
    [
      pageId,
      input.companyId,
      input.wikiId,
      input.path,
      title,
      pageType,
      jsonParam(sourceRefs),
      jsonParam(backlinks),
      hash,
      revisionId,
      input.spaceId,
    ],
  );

  // The append-only log grows without bound and gets a revision per append, so
  // storing full snapshots there would be quadratic; keep log revisions (and
  // oversized pages) hash-only like before migration 006.
  const revisionContents = pageType === "log" || input.contents.length > REVISION_CONTENTS_MAX_CHARS
    ? null
    : input.contents;
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "wiki_page_revisions")}
       (id, company_id, wiki_id, space_id, page_id, operation_id, path, content_hash, summary, metadata, author_kind, author_id, author_run_id, contents)
     VALUES ($1, $2, $3, $8, (SELECT id FROM ${tableName(ctx.db.namespace, "wiki_pages")} WHERE company_id = $2 AND wiki_id = $3 AND space_id = $8 AND path = $4), $7, $4, $5, $6, '{}'::jsonb, $9, $10, $11, $12)`,
    [
      revisionId,
      input.companyId,
      input.wikiId,
      input.path,
      hash,
      input.summary ?? null,
      input.operationId ?? null,
      input.spaceId,
      input.author?.kind ?? null,
      input.author?.id ?? null,
      input.author?.runId ?? null,
      revisionContents,
    ],
  );

  await upsertSearchDocument(ctx, {
    companyId: input.companyId,
    wikiId: input.wikiId,
    spaceId: input.spaceId,
    docKind: "page",
    path: input.path,
    title,
    contents: input.contents,
    contentHash: hash,
  });

  return { title, pageType, backlinks, hash, revisionId };
}

export async function writeWikiPage(ctx: PluginContext, input: WritePageInput) {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const path = assertPagePath(input.path);
  assertPageWriteAllowed(path, input.writer);
  const current = await readCurrentWithHash(ctx, input.companyId, path, space);
  assertExpectedHash(input.expectedHash, current.hash, path);
  await ctx.localFolders.writeTextAtomic(input.companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, path), input.contents);
  const metadata = await upsertPageMetadata(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceId: space.id,
    path,
    contents: input.contents,
    summary: input.summary,
    sourceRefs: input.sourceRefs,
    operationId: input.operationId,
    author: input.author ?? null,
  });
  await upsertWikiInstance(ctx, { companyId: input.companyId, wikiId });
  return { status: "ok", wikiId, spaceSlug: space.slug, path, previousHash: current.hash, ...metadata };
}

export async function captureWikiSource(ctx: PluginContext, input: CaptureSourceInput) {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const title = stringField(input.title) ?? "Untitled source";
  await assertSourceWithinConfiguredLimit(ctx, input.contents);
  const hash = contentHash(input.contents);
  const rawPath = input.rawPath
    ? assertRawPath(input.rawPath)
    : assertRawPath(`raw/${new Date().toISOString().slice(0, 10)}-${slugify(title)}-${hash.slice(0, 8)}.md`);
  await ctx.localFolders.writeTextAtomic(input.companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, rawPath), input.contents);
  await upsertWikiInstance(ctx, { companyId: input.companyId, wikiId });
  // rawPath embeds the content hash, so an existing row means this is a retry
  // of an already-persisted capture (e.g. after a failure later in the
  // pipeline); refresh the search doc and return the original source instead
  // of inserting a duplicate row.
  const existingRows = await ctx.db.query<{ id: string }>(
    `SELECT id FROM ${tableName(ctx.db.namespace, "wiki_sources")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND raw_path = $4
      LIMIT 1`,
    [input.companyId, wikiId, space.id, rawPath],
  );
  if (existingRows[0]) {
    await upsertSearchDocument(ctx, {
      companyId: input.companyId,
      wikiId,
      spaceId: space.id,
      docKind: "source",
      path: rawPath,
      title,
      contents: input.contents,
      contentHash: hash,
    });
    return { status: "ok", sourceId: existingRows[0].id, wikiId, spaceSlug: space.slug, rawPath, hash, title };
  }
  const sourceId = randomUUID();
  const metadata = {
    ...(input.metadata ?? {}),
    ...(input.author ? { author: { kind: input.author.kind, id: input.author.id ?? null, runId: input.author.runId ?? null } } : {}),
  };
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "wiki_sources")}
       (id, company_id, wiki_id, space_id, source_type, title, url, raw_path, content_hash, status, metadata)
     VALUES ($1, $2, $3, $10, $4, $5, $6, $7, $8, 'captured', $9::jsonb)`,
    [
      sourceId,
      input.companyId,
      wikiId,
      stringField(input.sourceType) ?? "text",
      title,
      stringField(input.url),
      rawPath,
      hash,
      jsonParam(metadata),
      space.id,
    ],
  );
  await upsertSearchDocument(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceId: space.id,
    docKind: "source",
    path: rawPath,
    title,
    contents: input.contents,
    contentHash: hash,
  });
  return { status: "ok", sourceId, wikiId, spaceSlug: space.slug, rawPath, hash, title };
}

export async function getOverview(ctx: PluginContext, companyId: string): Promise<WikiOverview> {
  const [defaultSpace, folder, managedAgent, managedProject, managedSkills] = await Promise.all([
    ensureDefaultSpace(ctx, { companyId, wikiId: DEFAULT_WIKI_ID }),
    ctx.localFolders.status(companyId, WIKI_ROOT_FOLDER_KEY),
    resolveWikiAgentResource(ctx, companyId),
    resolveWikiProjectResource(ctx, companyId),
    resolveWikiSkillResources(ctx, companyId),
  ]);
  const operationRows = await ctx.db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${tableName(ctx.db.namespace, "wiki_operations")} WHERE company_id = $1`,
    [companyId],
  );
  const operationCount = Number(operationRows[0]?.count ?? 0);
  const eventIngestion = await getEventIngestionSettings(ctx, companyId);
  return {
    status: "ok",
    checkedAt: new Date().toISOString(),
    wikiId: DEFAULT_WIKI_ID,
    defaultSpace,
    folder,
    managedAgent,
    managedProject,
    managedSkills,
    operationCount,
    eventIngestion,
    capabilities: ctx.manifest.capabilities,
    prompts: {
      query: QUERY_PROMPT,
      lint: LINT_PROMPT,
    },
  };
}

export async function resolveWikiAgentResource(
  ctx: PluginContext,
  companyId: string,
  options: { reconcileMissing?: boolean } = {},
): Promise<WikiAgentResource> {
  const wikiId = DEFAULT_WIKI_ID;
  const binding = await getResourceBinding(ctx, {
    companyId,
    wikiId,
    resourceKind: "agent",
    resourceKey: WIKI_MAINTAINER_AGENT_KEY,
  });
  const selectedAgent = await resolveSelectedAgent(ctx, companyId, binding);
  if (selectedAgent) {
    const source = binding?.metadata.source === "managed-default" ? "managed" : "selected";
    const managedResolution = source === "managed"
      ? await ctx.agents.managed.get(WIKI_MAINTAINER_AGENT_KEY, companyId)
      : null;
    return agentResource({
      status: "resolved",
      source,
      agent: selectedAgent,
      defaultDrift: managedResolution?.defaultDrift ?? null,
    });
  }
  if (binding?.resolvedId && !options.reconcileMissing) {
    return agentResource({ status: "missing", source: "selected", agent: null });
  }

  const resolved = options.reconcileMissing
    ? await ctx.agents.managed.reconcile(WIKI_MAINTAINER_AGENT_KEY, companyId)
    : await ctx.agents.managed.get(WIKI_MAINTAINER_AGENT_KEY, companyId);
  if (resolved.agentId && options.reconcileMissing) {
    await upsertResourceBinding(ctx, {
      companyId,
      wikiId,
      resourceKind: "agent",
      resourceKey: WIKI_MAINTAINER_AGENT_KEY,
      resolvedId: resolved.agentId,
      metadata: { source: "managed-default", updatedBy: "resolve" },
    });
  }
  return agentResource({ status: resolved.status, source: "managed", agent: resolved.agent, defaultDrift: resolved.defaultDrift ?? null });
}

export async function resolveWikiProjectResource(
  ctx: PluginContext,
  companyId: string,
  options: { reconcileMissing?: boolean } = {},
): Promise<WikiProjectResource> {
  const wikiId = DEFAULT_WIKI_ID;
  const binding = await getResourceBinding(ctx, {
    companyId,
    wikiId,
    resourceKind: "project",
    resourceKey: WIKI_PROJECT_KEY,
  });
  const selectedProject = await resolveSelectedProject(ctx, companyId, binding);
  if (selectedProject) {
    return projectResource({
      status: "resolved",
      source: binding?.metadata.source === "managed-default" ? "managed" : "selected",
      project: selectedProject,
    });
  }
  if (binding?.resolvedId && !options.reconcileMissing) {
    return projectResource({ status: "missing", source: "selected", project: null });
  }

  const resolved = options.reconcileMissing
    ? await ctx.projects.managed.reconcile(WIKI_PROJECT_KEY, companyId)
    : await ctx.projects.managed.get(WIKI_PROJECT_KEY, companyId);
  if (resolved.projectId && options.reconcileMissing) {
    await upsertResourceBinding(ctx, {
      companyId,
      wikiId,
      resourceKind: "project",
      resourceKey: WIKI_PROJECT_KEY,
      resolvedId: resolved.projectId,
      metadata: { source: "managed-default", updatedBy: "resolve" },
    });
  }
  return projectResource({ status: resolved.status, source: "managed", project: resolved.project });
}

export async function resolveWikiSkillResources(
  ctx: PluginContext,
  companyId: string,
  options: { reconcileMissing?: boolean } = {},
): Promise<WikiSkillResource[]> {
  return Promise.all(
    WIKI_MANAGED_SKILL_KEYS.map(async (skillKey) => {
      const resolved = options.reconcileMissing
        ? await ctx.skills.managed.reconcile(skillKey, companyId)
        : await ctx.skills.managed.get(skillKey, companyId);
      return skillResource(resolved);
    }),
  );
}

export async function reconcileWikiAgentResource(ctx: PluginContext, companyId: string): Promise<WikiAgentResource> {
  const resolved = await ctx.agents.managed.reconcile(WIKI_MAINTAINER_AGENT_KEY, companyId);
  if (resolved.agentId) {
    await upsertResourceBinding(ctx, {
      companyId,
      wikiId: DEFAULT_WIKI_ID,
      resourceKind: "agent",
      resourceKey: WIKI_MAINTAINER_AGENT_KEY,
      resolvedId: resolved.agentId,
      metadata: { source: "managed-default", updatedBy: "reconcile" },
    });
  }
  return agentResource({ status: resolved.status, source: "managed", agent: resolved.agent, defaultDrift: resolved.defaultDrift ?? null });
}

export async function resetWikiAgentResource(ctx: PluginContext, companyId: string): Promise<WikiAgentResource> {
  const resolved = await ctx.agents.managed.reset(WIKI_MAINTAINER_AGENT_KEY, companyId);
  if (resolved.agentId) {
    await upsertResourceBinding(ctx, {
      companyId,
      wikiId: DEFAULT_WIKI_ID,
      resourceKind: "agent",
      resourceKey: WIKI_MAINTAINER_AGENT_KEY,
      resolvedId: resolved.agentId,
      metadata: { source: "managed-default", updatedBy: "reset" },
    });
  }
  return agentResource({ status: resolved.status, source: "managed", agent: resolved.agent, defaultDrift: resolved.defaultDrift ?? null });
}

export async function selectWikiAgentResource(ctx: PluginContext, input: { companyId: string; agentId: string }): Promise<WikiAgentResource> {
  const agent = await ctx.agents.get(input.agentId, input.companyId);
  if (!agent || agent.status === "terminated") {
    throw new Error("Selected Wiki Maintainer agent was not found or is terminated.");
  }
  await upsertResourceBinding(ctx, {
    companyId: input.companyId,
    wikiId: DEFAULT_WIKI_ID,
    resourceKind: "agent",
    resourceKey: WIKI_MAINTAINER_AGENT_KEY,
    resolvedId: agent.id,
    metadata: { source: "selected-existing", updatedBy: "settings" },
  });
  return agentResource({ status: "resolved", source: "selected", agent });
}

export async function reconcileWikiProjectResource(ctx: PluginContext, companyId: string): Promise<WikiProjectResource> {
  const resolved = await ctx.projects.managed.reconcile(WIKI_PROJECT_KEY, companyId);
  if (resolved.projectId) {
    await upsertResourceBinding(ctx, {
      companyId,
      wikiId: DEFAULT_WIKI_ID,
      resourceKind: "project",
      resourceKey: WIKI_PROJECT_KEY,
      resolvedId: resolved.projectId,
      metadata: { source: "managed-default", updatedBy: "reconcile" },
    });
  }
  return projectResource({ status: resolved.status, source: "managed", project: resolved.project });
}

export async function resetWikiProjectResource(ctx: PluginContext, companyId: string): Promise<WikiProjectResource> {
  const resolved = await ctx.projects.managed.reset(WIKI_PROJECT_KEY, companyId);
  if (resolved.projectId) {
    await upsertResourceBinding(ctx, {
      companyId,
      wikiId: DEFAULT_WIKI_ID,
      resourceKind: "project",
      resourceKey: WIKI_PROJECT_KEY,
      resolvedId: resolved.projectId,
      metadata: { source: "managed-default", updatedBy: "reset" },
    });
  }
  return projectResource({ status: resolved.status, source: "managed", project: resolved.project });
}

export async function reconcileWikiSkillResources(ctx: PluginContext, companyId: string): Promise<WikiSkillResource[]> {
  return resolveWikiSkillResources(ctx, companyId, { reconcileMissing: true });
}

export async function resetWikiSkillResources(ctx: PluginContext, companyId: string): Promise<WikiSkillResource[]> {
  return Promise.all(
    WIKI_MANAGED_SKILL_KEYS.map(async (skillKey) => {
      return skillResource(await ctx.skills.managed.reset(skillKey, companyId));
    }),
  );
}

export async function reconcileWikiRoutineResources(
  ctx: PluginContext,
  companyId: string,
): Promise<{
  managedAgent: WikiAgentResource;
  managedProject: WikiProjectResource;
  managedRoutines: PluginManagedRoutineResolution[];
}> {
  const [managedAgent, managedProject] = await Promise.all([
    reconcileWikiAgentResource(ctx, companyId),
    reconcileWikiProjectResource(ctx, companyId),
  ]);

  const managedRoutines = await Promise.all(
    WIKI_MAINTENANCE_ROUTINE_KEYS.map((routineKey) =>
      ctx.routines.managed.reconcile(routineKey, companyId, {
        assigneeAgentId: managedAgent.agentId,
        projectId: managedProject.projectId,
      })),
  );

  return { managedAgent, managedProject, managedRoutines };
}

export async function selectWikiProjectResource(ctx: PluginContext, input: { companyId: string; projectId: string }): Promise<WikiProjectResource> {
  const project = await ctx.projects.get(input.projectId, input.companyId);
  if (!project) {
    throw new Error("Selected LLM Wiki project was not found.");
  }
  await upsertResourceBinding(ctx, {
    companyId: input.companyId,
    wikiId: DEFAULT_WIKI_ID,
    resourceKind: "project",
    resourceKey: WIKI_PROJECT_KEY,
    resolvedId: project.id,
    metadata: { source: "selected-existing", updatedBy: "settings" },
  });
  return projectResource({ status: "resolved", source: "selected", project });
}

export async function listWikiAgentOptions(ctx: PluginContext, companyId: string): Promise<WikiResourceOption[]> {
  const agents = await ctx.agents.list({ companyId, limit: 200 });
  return agents
    .filter((agent) => agent.status !== "terminated")
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      adapterType: agent.adapterType ?? null,
      icon: agent.icon ?? null,
      urlKey: agent.urlKey ?? null,
    }));
}

export async function listWikiProjectOptions(ctx: PluginContext, companyId: string): Promise<WikiResourceOption[]> {
  const projects = await ctx.projects.list({ companyId, limit: 200 });
  return projects.map((project) => ({ id: project.id, name: project.name, status: project.status, color: project.color ?? null }));
}

function formatFolderProblems(folder: LocalFolderStatus): string {
  const details = folder.problems
    .map((problem) => problem.path ? `${problem.message} ${problem.path}` : problem.message)
    .filter(Boolean);
  return details.length > 0 ? details.join("; ") : "No detailed health problem was reported.";
}

function assertWikiRootCanBootstrap(folder: LocalFolderStatus): void {
  const blockingProblems = folder.problems.filter((problem) =>
    problem.code !== "missing_directory" && problem.code !== "missing_file"
  );
  const writable = folder.access === "readWrite" && folder.writable;
  if (!folder.configured || !folder.realPath || !folder.readable || !writable || blockingProblems.length > 0) {
    throw new Error(`Wiki root folder is not ready: ${formatFolderProblems(folder)}`);
  }
}

function expandHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return joinPath(os.homedir(), value.slice(2));
  return value;
}

// Mirrors packages/shared/src/home-paths.ts resolution so the managed default
// lands inside the same instance-owned tree the server uses. The worker
// inherits PAPERCLIP_HOME / PAPERCLIP_INSTANCE_ID from the host process.
export function defaultWikiRootPath(companyId: string): string {
  const configuredHome = process.env.PAPERCLIP_HOME?.trim();
  const home = configuredHome ? expandHomePath(configuredHome) : joinPath(os.homedir(), ".paperclip");
  const rawInstanceId = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  const instanceId = /^[a-zA-Z0-9_-]+$/.test(rawInstanceId) ? rawInstanceId : "default";
  return joinPath(home, "instances", instanceId, "plugin-data", companyId, PLUGIN_ID, "wiki-root");
}

export async function ensureWikiRootConfigured(ctx: PluginContext, companyId: string): Promise<LocalFolderStatus> {
  const status = await ctx.localFolders.status(companyId, WIKI_ROOT_FOLDER_KEY);
  if (status.configured && status.path) return status;
  const folder = await ctx.localFolders.configure({
    companyId,
    folderKey: WIKI_ROOT_FOLDER_KEY,
    path: defaultWikiRootPath(companyId),
    access: "readWrite",
    requiredDirectories: [...REQUIRED_WIKI_DIRECTORIES],
    requiredFiles: [...REQUIRED_WIKI_FILES],
  });
  const defaultSpace = await ensureDefaultSpace(ctx, { companyId });
  await bootstrapSpaceFiles(ctx, companyId, defaultSpace);
  await upsertWikiInstance(ctx, { companyId, wikiId: DEFAULT_WIKI_ID, rootPath: folder.path });
  return folder;
}

/**
 * Make the wiki usable for a company without any human bootstrap step: the
 * root folder exists (auto-defaulted under the instance tree), the managed
 * skills — including the required company-wide `wiki` skill — are installed,
 * and every project has its space. Idempotent; safe to run on every startup
 * and on company.created. The managed maintainer agent/routines are NOT
 * activated here — they cost money and stay opt-in via activate-wiki-maintenance.
 */
export async function ensureCompanyWikiProvisioned(
  ctx: PluginContext,
  companyId: string,
): Promise<{
  folder: LocalFolderStatus;
  managedSkills: WikiSkillResource[];
  projectSpaces: ReconcileProjectSpacesResult;
}> {
  const folder = await ensureWikiRootConfigured(ctx, companyId);
  const managedSkills = await reconcileWikiSkillResources(ctx, companyId);
  const projectSpaces = await reconcileProjectSpaces(ctx, { companyId });
  return { folder, managedSkills, projectSpaces };
}

export async function bootstrapWikiRoot(ctx: PluginContext, input: BootstrapInput) {
  const wikiId = DEFAULT_WIKI_ID;
  const defaultSpace = await ensureDefaultSpace(ctx, { companyId: input.companyId, wikiId });
  const configureFolder = (path: string) => ctx.localFolders.configure({
      companyId: input.companyId,
      folderKey: WIKI_ROOT_FOLDER_KEY,
      path,
      access: "readWrite",
      requiredDirectories: [...REQUIRED_WIKI_DIRECTORIES],
      requiredFiles: [...REQUIRED_WIKI_FILES],
    });
  const currentFolder = input.path
    ? null
    : await ctx.localFolders.status(input.companyId, WIKI_ROOT_FOLDER_KEY);
  const folder = input.path
    ? await configureFolder(input.path)
    : currentFolder?.configured && currentFolder.path
      ? await configureFolder(currentFolder.path)
      : await configureFolder(defaultWikiRootPath(input.companyId));
  assertWikiRootCanBootstrap(folder);

  const writtenFiles: string[] = [];
  const preservedFiles: string[] = [];
  for (const file of BOOTSTRAP_FILES) {
    const path = assertWikiPath(file.path, { allowMetadata: true });
    try {
      await ctx.localFolders.readText(input.companyId, WIKI_ROOT_FOLDER_KEY, path);
      preservedFiles.push(path);
      continue;
    } catch {
      // Missing files are initialized below. Existing files are intentionally preserved.
    }
    await ctx.localFolders.writeTextAtomic(input.companyId, WIKI_ROOT_FOLDER_KEY, file.path, file.contents);
    writtenFiles.push(path);
  }

  const finalFolder = await ctx.localFolders.status(input.companyId, WIKI_ROOT_FOLDER_KEY);
  await upsertWikiInstance(ctx, { companyId: input.companyId, wikiId, rootPath: finalFolder.path ?? folder.path });
  const managedSkills = await reconcileWikiSkillResources(ctx, input.companyId);
  const [managedAgent, managedProject] = await Promise.all([
    reconcileWikiAgentResource(ctx, input.companyId),
    reconcileWikiProjectResource(ctx, input.companyId),
  ]);
  await ctx.state.set(
    {
      scopeKind: "company",
      scopeId: input.companyId,
      namespace: "llm-wiki",
      stateKey: "last-bootstrap",
    },
    { at: new Date().toISOString(), path: folder.path },
  );

  return {
    status: "ok",
    folder: finalFolder,
    wikiId,
    space: defaultSpace,
    managedAgent,
    managedProject,
    managedSkills,
    writtenFiles,
    preservedFiles,
  };
}

export async function bootstrapSpace(ctx: PluginContext, input: SpaceInput) {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const { writtenFiles, preservedFiles } = await bootstrapSpaceFiles(ctx, input.companyId, space);
  await upsertWikiInstance(ctx, { companyId: input.companyId, wikiId });
  return {
    status: "ok",
    wikiId,
    space,
    writtenFiles,
    preservedFiles,
  };
}

async function bootstrapSpaceFiles(ctx: PluginContext, companyId: string, space: WikiSpace) {
  const writtenFiles: string[] = [];
  const preservedFiles: string[] = [];
  for (const file of BOOTSTRAP_FILES) {
    const path = assertWikiPath(file.path, { allowMetadata: true });
    const physicalPath = spaceRelativePath(space, path);
    try {
      await ctx.localFolders.readText(companyId, WIKI_ROOT_FOLDER_KEY, physicalPath);
      preservedFiles.push(path);
      continue;
    } catch {
      // Missing files are initialized below. Existing files are intentionally preserved.
    }
    await ctx.localFolders.writeTextAtomic(companyId, WIKI_ROOT_FOLDER_KEY, physicalPath, file.contents);
    writtenFiles.push(path);
  }
  return { writtenFiles, preservedFiles };
}

function operationSpaceRoot(space: WikiSpace): string {
  return space.pathPrefix ? `${space.rootFolderKey}/${space.pathPrefix}` : `${space.rootFolderKey} root`;
}

function operationBillingContext(wikiId: string, space: WikiSpace): string {
  return space.slug === DEFAULT_SPACE_SLUG
    ? `plugin-llm-wiki:${wikiId} (space ${space.slug})`
    : `plugin-llm-wiki:${wikiId}:${space.slug}`;
}

function operationBillingCode(wikiId: string, space: WikiSpace): string {
  return space.slug === DEFAULT_SPACE_SLUG ? `plugin-llm-wiki:${wikiId}` : `plugin-llm-wiki:${wikiId}:${space.slug}`;
}

function operationIssueOriginId(input: { wikiId: string; space: WikiSpace; operationId: string }): string {
  return input.space.slug === DEFAULT_SPACE_SLUG
    ? `wiki:${input.wikiId}:operation:${input.operationId}`
    : `wiki:${input.wikiId}:space:${input.space.slug}:operation:${input.operationId}`;
}

function operationTitleWithSpace(title: string, space: WikiSpace): string {
  return `${title} [space: ${space.displayName} / ${space.slug}]`;
}

function operationPromptWithSpaceContext(input: OperationSpaceContext): string {
  const paperclipDerived = input.operationType === "distill" || input.operationType === "backfill";
  return [
    `Plugin operation: ${input.operationType}`,
    `Wiki ID: ${input.wikiId}`,
    `Space: ${input.space.displayName} (${input.space.slug})`,
    `Space root: ${operationSpaceRoot(input.space)}`,
    `Billing context: ${operationBillingContext(input.wikiId, input.space)}`,
    "",
    "Space isolation requirement:",
    `- Pass wikiId \`${input.wikiId}\` and spaceSlug \`${input.space.slug}\` on every LLM Wiki tool call.`,
    "- Treat all paths in the prompt as relative to this space root.",
    paperclipDerived
      ? "- Paperclip-derived distill/backfill operations are default-space-only in Phase 1. Stop and comment if asked to write Paperclip-derived pages into a non-default space."
      : "- Manual ingest, query, lint, index, and file-as-page operations follow the named destination space. Do not cross into another space unless the operation explicitly asks for a multi-space sweep.",
    "",
    input.prompt ?? "Created by the LLM Wiki plugin.",
  ].join("\n");
}

function operationMetadata(input: OperationSpaceContext) {
  return {
    operationType: input.operationType,
    operationId: input.operationId,
    wikiId: input.wikiId,
    spaceId: input.space.id,
    spaceSlug: input.space.slug,
    spaceName: input.space.displayName,
    spaceRootFolderKey: input.space.rootFolderKey,
    spacePathPrefix: input.space.pathPrefix,
    spaceRoot: operationSpaceRoot(input.space),
  };
}

export async function createOperationIssue(ctx: PluginContext, input: OperationInput) {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = input.operationType === "distill" || input.operationType === "backfill"
    ? await requirePaperclipIngestionPolicy(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug }, "queue", { requireEnabledProfile: true })
    : await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const managedAgent = await resolveWikiAgentResource(ctx, input.companyId, { reconcileMissing: true });
  const managedProject = await resolveWikiProjectResource(ctx, input.companyId, { reconcileMissing: true });
  const operationId = randomUUID();
  const title = operationTitleWithSpace(input.title ?? `LLM Wiki ${input.operationType}`, space);
  const originId = operationIssueOriginId({ wikiId, space, operationId });
  const operationContext = { wikiId, space, operationType: input.operationType, operationId, prompt: input.prompt };
  const assignableAgentId =
    managedAgent.agent &&
    managedAgent.agent.status !== "pending_approval" &&
    managedAgent.agent.status !== "terminated"
      ? managedAgent.agent.id
      : undefined;
  const issue = await ctx.issues.create({
    companyId: input.companyId,
    projectId: managedProject.projectId ?? undefined,
    title,
    description: operationPromptWithSpaceContext(operationContext),
    status: "todo",
    priority: input.operationType === "query" ? "medium" : "low",
    assigneeAgentId: assignableAgentId,
    assigneeAdapterOverrides: input.useCheapModelProfile ? { modelProfile: "cheap" } : null,
    billingCode: operationBillingCode(wikiId, space),
    surfaceVisibility: "plugin_operation",
    originKind: `${OPERATION_ORIGIN_KIND}:${input.operationType}` as PluginIssueOriginKind,
    originId,
  });

  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "wiki_operations")}
       (id, company_id, wiki_id, space_id, operation_type, status, hidden_issue_id, project_id, run_ids, cost_cents, warnings, metadata)
     VALUES ($1, $2, $3, $8, $4, $5, $6, $7, '[]'::jsonb, 0, '[]'::jsonb, $9::jsonb)`,
    [
      operationId,
      input.companyId,
      wikiId,
      input.operationType,
      "queued",
      issue.id,
      issue.projectId ?? null,
      space.id,
      jsonParam({
        ...operationMetadata(operationContext),
        issueOriginId: originId,
        billingCode: operationBillingCode(wikiId, space),
      }),
    ],
  );

  return { operationId, wikiId, spaceSlug: space.slug, issue };
}

function isLlmWikiOperationIssue(issue: Issue): boolean {
  return typeof issue.originKind === "string" && issue.originKind.startsWith(OPERATION_ORIGIN_KIND);
}

function paperclipDistillationScope(input: { projectId?: string | null; rootIssueId?: string | null }): PaperclipDistillationScope {
  if (input.rootIssueId) return "root_issue";
  if (input.projectId) return "project";
  return "company";
}

function paperclipCursorScopeMetadata(input: { projectId?: string | null; rootIssueId?: string | null }) {
  const sourceScope = paperclipDistillationScope(input);
  const projectId = sourceScope === "project" ? input.projectId ?? null : null;
  const rootIssueId = sourceScope === "root_issue" ? input.rootIssueId ?? null : null;
  return {
    sourceScope,
    scopeKey: rootIssueId ?? projectId ?? "company",
    projectId,
    rootIssueId,
  };
}

async function upsertPaperclipDistillationCursor(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  spaceId: string;
  projectId?: string | null;
  rootIssueId?: string | null;
  observedAt?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const cursorId = randomUUID();
  const scope = paperclipCursorScopeMetadata(input);
  await ctx.db.execute(
    `INSERT INTO ${distillationCursorTable(ctx)} AS paperclip_distillation_cursors
       (id, company_id, wiki_id, space_id, source_scope, scope_key, project_id, root_issue_id, source_kind, last_observed_at, pending_event_count, metadata)
     VALUES ($1, $2, $3, $11, $4, $5, $6, $7, 'paperclip_issue_history', $8::timestamptz, $9, $10::jsonb)
     ON CONFLICT (company_id, wiki_id, space_id, source_scope, scope_key, source_kind)
     DO UPDATE SET last_observed_at = GREATEST(
                       COALESCE(paperclip_distillation_cursors.last_observed_at, EXCLUDED.last_observed_at),
                       COALESCE(EXCLUDED.last_observed_at, paperclip_distillation_cursors.last_observed_at)
                     ),
                   pending_event_count = paperclip_distillation_cursors.pending_event_count + EXCLUDED.pending_event_count,
                   metadata = paperclip_distillation_cursors.metadata || EXCLUDED.metadata,
                   updated_at = now()`,
    [
      cursorId,
      input.companyId,
      input.wikiId,
      scope.sourceScope,
      scope.scopeKey,
      scope.projectId,
      scope.rootIssueId,
      input.observedAt ?? null,
      input.observedAt ? 1 : 0,
      jsonParam(input.metadata ?? {}),
      input.spaceId,
    ],
  );
  const rows = await ctx.db.query<{ id: string }>(
    `SELECT id
       FROM ${distillationCursorTable(ctx)}
      WHERE company_id = $1
        AND wiki_id = $2
        AND space_id = $3
        AND source_scope = $4
        AND scope_key = $5
        AND source_kind = 'paperclip_issue_history'
      LIMIT 1`,
    [input.companyId, input.wikiId, input.spaceId, scope.sourceScope, scope.scopeKey],
  );
  return rows[0]?.id ?? cursorId;
}

function isActiveDistillationProject(project: Project): boolean {
  if (project.status !== "in_progress") return false;
  if (project.archivedAt) return false;
  if (project.managedByPlugin?.pluginKey === PLUGIN_ID) return false;
  if (project.managedByPlugin?.resourceKey === WIKI_PROJECT_KEY) return false;
  return true;
}

function projectActivityTimestamp(project: Project): string {
  return isoString(project.updatedAt) ?? new Date().toISOString();
}

export async function enableActiveProjectDistillation(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  limit?: number | null;
}): Promise<EnableActiveProjectDistillationResult> {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await requirePaperclipIngestionPolicy(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug }, "candidate_search", { requireEnabledProfile: true });
  if (typeof input.limit === "number" && Number.isFinite(input.limit) && Math.floor(input.limit) > MAX_PAPERCLIP_DISTILLATION_FAN_OUT) {
    throw new Error(`Paperclip ingestion fan-out exceeds the hard cap of ${MAX_PAPERCLIP_DISTILLATION_FAN_OUT} enabled profiles.`);
  }
  const limit = normalizeLimit(input.limit ?? 3, 3, 25);
  const projects = await ctx.projects.list({ companyId: input.companyId, limit: 200 });
  const activeProjects = projects
    .filter(isActiveDistillationProject)
    .sort((a, b) => projectActivityTimestamp(b).localeCompare(projectActivityTimestamp(a)))
    .slice(0, limit);

  const selectedProjects: EnableActiveProjectDistillationResult["selectedProjects"] = [];
  for (const project of activeProjects) {
    const observedAt = projectActivityTimestamp(project);
    const cursorId = await upsertPaperclipDistillationCursor(ctx, {
      companyId: input.companyId,
      wikiId,
      spaceId: space.id,
      projectId: project.id,
      rootIssueId: null,
      observedAt,
      metadata: {
        configuredBy: "enable-active-projects",
        projectName: project.name,
        projectStatus: project.status,
      },
    });
    selectedProjects.push({
      id: project.id,
      name: project.name,
      status: project.status,
      observedAt,
      cursorId,
    });
  }

  const eventIngestion = await updateEventIngestionSettings(ctx, {
    companyId: input.companyId,
    settings: {
      enabled: true,
      wikiId,
      sources: {
        issues: true,
        comments: true,
        documents: true,
      },
    },
  });

  return {
    wikiId,
    spaceSlug: space.slug,
    selectedProjects,
    eventIngestion,
  };
}

function appendBoundedSection(input: {
  lines: string[];
  title: string;
  body: string;
  refs: PaperclipSourceRef[];
  ref: PaperclipSourceRef;
  remaining: { value: number };
  perSourceLimit: number;
  warnings: string[];
}) {
  if (input.remaining.value <= 0) {
    input.warnings.push(`Skipped ${input.title}: source bundle character limit reached.`);
    return;
  }
  const boundedBody = input.body.length > input.perSourceLimit
    ? `${input.body.slice(0, input.perSourceLimit)}\n\n[Clipped at ${input.perSourceLimit} characters for this source.]`
    : input.body;
  const section = [`## ${input.title}`, "", boundedBody.trim() || "_No content._", ""].join("\n");
  const clippedSection = section.length > input.remaining.value
    ? `${section.slice(0, input.remaining.value)}\n\n[Source bundle clipped at configured limit.]\n`
    : section;
  input.lines.push(clippedSection);
  input.refs.push(input.ref);
  if (boundedBody.length !== input.body.length || clippedSection.length !== section.length) {
    input.warnings.push(`Clipped ${input.title}.`);
  }
  input.remaining.value -= clippedSection.length;
}

function issueSortKey(issue: Issue): string {
  return `${issue.identifier ?? ""}:${issue.title}:${issue.id}`;
}

function sourceRefUpdatedAt(ref: PaperclipSourceRef): string | null {
  return ref.updatedAt ?? ref.createdAt ?? null;
}

function issueInBackfillWindow(issue: Issue, input: Pick<PaperclipSourceBundleInput, "backfillStartAt" | "backfillEndAt">): boolean {
  const issueUpdatedAt = isoString(issue.updatedAt);
  if (!issueUpdatedAt) return true;
  const startAt = isoString(input.backfillStartAt);
  const endAt = isoString(input.backfillEndAt);
  if (startAt && issueUpdatedAt < startAt) return false;
  if (endAt && issueUpdatedAt > endAt) return false;
  return true;
}

async function listPaperclipBundleIssues(ctx: PluginContext, input: PaperclipSourceBundleInput): Promise<Issue[]> {
  const filterAndSort = (issues: Issue[]) =>
    issues
      .filter((issue) => !isLlmWikiOperationIssue(issue))
      .filter((issue) => issueInBackfillWindow(issue, input))
      .sort((a, b) => issueSortKey(a).localeCompare(issueSortKey(b)));

  if (input.rootIssueId) {
    const subtree = await ctx.issues.getSubtree(input.rootIssueId, input.companyId, {
      includeRoot: true,
      includeRelations: true,
      includeDocuments: true,
      includeAssignees: true,
    });
    return filterAndSort(subtree.issues);
  }

  const issues = await ctx.issues.list({
    companyId: input.companyId,
    projectId: input.projectId ?? undefined,
    includePluginOperations: false,
    limit: 500,
  });
  return filterAndSort(issues);
}

export async function assemblePaperclipSourceBundle(ctx: PluginContext, input: PaperclipSourceBundleInput): Promise<PaperclipSourceBundle> {
  const wikiId = normalizeWikiId(input.wikiId);
  assertPaperclipSourceScopePayload(input);
  const space = await requirePaperclipIngestionPolicy(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug }, "execute", { requireEnabledProfile: true });
  const limits = await resolvePaperclipDistillationLimitsForSpace(ctx, { ...input, space });
  const maxCharacters = limits.maxCharacters;
  const perSourceLimit = limits.maxCharactersPerSource;
  const includeComments = input.includeComments !== false;
  const includeDocuments = input.includeDocuments !== false;
  const issues = await listPaperclipBundleIssues(ctx, input);
  const scope = paperclipCursorScopeMetadata(input);
  const sourceRefs: PaperclipSourceRef[] = [];
  const warnings: string[] = [];
  const lines = [
    `# Paperclip source bundle`,
    "",
    "## Bundle Metadata",
    "",
    `- Company ID: ${input.companyId}`,
    `- Wiki ID: ${wikiId}`,
    `- Space: ${space.displayName} (${space.slug})`,
    `- Source scope: ${scope.sourceScope}`,
    scope.projectId ? `- Project ID: ${scope.projectId}` : null,
    scope.rootIssueId ? `- Root issue ID: ${scope.rootIssueId}` : null,
    input.backfillStartAt ? `- Backfill start: ${isoString(input.backfillStartAt) ?? input.backfillStartAt}` : null,
    input.backfillEndAt ? `- Backfill end: ${isoString(input.backfillEndAt) ?? input.backfillEndAt}` : null,
    `- Issue count: ${issues.length}`,
    `- Source caps: ${maxCharacters} characters per window; ${perSourceLimit} characters per source`,
    "",
  ].filter((line): line is string => line !== null);
  const remaining = { value: maxCharacters - lines.join("\n").length };

  for (const issue of issues) {
    const issueBody = [
      `- Issue ID: ${issue.id}`,
      issue.identifier ? `- Identifier: ${issue.identifier}` : null,
      `- Status: ${issue.status}`,
      `- Priority: ${issue.priority}`,
      issue.parentId ? `- Parent issue ID: ${issue.parentId}` : null,
      issue.projectId ? `- Project ID: ${issue.projectId}` : null,
      `- Updated at: ${isoString(issue.updatedAt) ?? "unknown"}`,
      "",
      issue.description?.trim() ? issue.description.trim() : "_No issue description._",
    ].filter((line): line is string => line !== null).join("\n");
    appendBoundedSection({
      lines,
      title: `Issue: ${sourceTitleForIssue(issue)}`,
      body: issueBody,
      refs: sourceRefs,
      ref: {
        kind: "issue",
        issueId: issue.id,
        issueIdentifier: issue.identifier ?? null,
        projectId: issue.projectId ?? null,
        title: issue.title,
        updatedAt: isoString(issue.updatedAt) ?? undefined,
      },
      remaining,
      perSourceLimit,
      warnings,
    });

    if (includeDocuments && remaining.value > 0) {
      const documentSummaries = await ctx.issues.documents.list(issue.id, input.companyId);
      for (const summary of [...documentSummaries].sort((a, b) => a.key.localeCompare(b.key))) {
        const document = await ctx.issues.documents.get(issue.id, summary.key, input.companyId);
        if (!document) continue;
        const protectedDocument = protectDistillationSourceBody({
          issue,
          sourceKind: "document",
          sourceId: document.key,
          body: document.body,
        });
        if (protectedDocument.warning) warnings.push(protectedDocument.warning);
        appendBoundedSection({
          lines,
          title: `Document: ${sourceTitleForIssue(issue)} / ${document.key}`,
          body: [
            `- Issue ID: ${issue.id}`,
            issue.identifier ? `- Issue identifier: ${issue.identifier}` : null,
            `- Document ID: ${document.id}`,
            `- Document key: ${document.key}`,
            `- Revision: ${document.latestRevisionNumber}`,
            `- Updated at: ${isoString(document.updatedAt) ?? "unknown"}`,
            "",
            protectedDocument.body,
          ].filter((line): line is string => line !== null).join("\n"),
          refs: sourceRefs,
          ref: {
            kind: "document",
            issueId: issue.id,
            issueIdentifier: issue.identifier ?? null,
            projectId: issue.projectId ?? null,
            documentId: document.id,
            documentKey: document.key,
            updatedAt: isoString(document.updatedAt) ?? undefined,
            ...protectedDocument.refPatch,
          },
          remaining,
          perSourceLimit,
          warnings,
        });
      }
    }

    if (includeComments && remaining.value > 0) {
      const comments = await ctx.issues.listComments(issue.id, input.companyId);
      for (const comment of [...comments].sort((a, b) => (isoString(a.createdAt) ?? "").localeCompare(isoString(b.createdAt) ?? ""))) {
        const protectedComment = protectDistillationSourceBody({
          issue,
          sourceKind: "comment",
          sourceId: comment.id,
          body: comment.body,
        });
        if (protectedComment.warning) warnings.push(protectedComment.warning);
        appendBoundedSection({
          lines,
          title: `Comment: ${sourceTitleForIssue(issue)} / ${comment.id}`,
          body: [
            `- Issue ID: ${issue.id}`,
            issue.identifier ? `- Issue identifier: ${issue.identifier}` : null,
            `- Comment ID: ${comment.id}`,
            `- Created at: ${isoString(comment.createdAt) ?? "unknown"}`,
            "",
            protectedComment.body,
          ].filter((line): line is string => line !== null).join("\n"),
          refs: sourceRefs,
          ref: {
            kind: "comment",
            issueId: issue.id,
            issueIdentifier: issue.identifier ?? null,
            projectId: issue.projectId ?? null,
            commentId: comment.id,
            createdAt: isoString(comment.createdAt) ?? undefined,
            ...protectedComment.refPatch,
          },
          remaining,
          perSourceLimit,
          warnings,
        });
      }
    }
  }

  const markdown = lines.join("\n").slice(0, maxCharacters);
  const sourceDates = sourceRefs.map(sourceRefUpdatedAt).filter((date): date is string => Boolean(date)).sort();
  return {
    markdown,
    sourceRefs,
    sourceHash: contentHash(markdown),
    sourceWindowStart: sourceDates[0] ?? null,
    sourceWindowEnd: sourceDates[sourceDates.length - 1] ?? null,
    clipped: warnings.some((warning) => warning.includes("Clipped") || warning.includes("Skipped")) || lines.join("\n").length > maxCharacters,
    warnings,
  };
}

export async function createPaperclipDistillationRun(ctx: PluginContext, input: PaperclipDistillationRunInput) {
  const wikiId = normalizeWikiId(input.wikiId);
  assertPaperclipSourceScopePayload(input);
  const space = await requirePaperclipIngestionPolicy(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug }, "execute", { requireEnabledProfile: true });
  const scope = paperclipCursorScopeMetadata(input);
  const limits = await resolvePaperclipDistillationLimitsForSpace(ctx, { ...input, space });
  const cursorId = await upsertPaperclipDistillationCursor(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceId: space.id,
    projectId: scope.projectId,
    rootIssueId: scope.rootIssueId,
    metadata: { source: "source-bundle" },
  });
  const bundle = await assemblePaperclipSourceBundle(ctx, input);
  const estimatedCostCents = estimateSourceCostCents(
    bundle.markdown.length,
    limits.costCentsPerThousandSourceCharacters,
  );
  const runId = randomUUID();
  const snapshotId = randomUUID();

  await ctx.db.execute(
    `INSERT INTO ${distillationRunTable(ctx)}
       (id, company_id, wiki_id, space_id, cursor_id, work_item_id, project_id, root_issue_id, source_window_start, source_window_end, source_hash, status, operation_issue_id, retry_count, cost_cents, warnings, metadata)
     VALUES ($1, $2, $3, $15, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, 'source_ready', $11, 0, $12, $13::jsonb, $14::jsonb)`,
    [
      runId,
      input.companyId,
      wikiId,
      cursorId,
      input.workItemId ?? null,
      scope.projectId,
      scope.rootIssueId,
      bundle.sourceWindowStart,
      bundle.sourceWindowEnd,
      bundle.sourceHash,
      input.operationIssueId ?? null,
      estimatedCostCents,
      jsonArrayParam(bundle.warnings),
      jsonParam({
        spaceSlug: space.slug,
        sourceScope: scope.sourceScope,
        limits,
        backfillStartAt: isoString(input.backfillStartAt),
        backfillEndAt: isoString(input.backfillEndAt),
      }),
      space.id,
    ],
  );
  await ctx.db.execute(
    `INSERT INTO ${sourceSnapshotTable(ctx)}
       (id, company_id, wiki_id, space_id, distillation_run_id, project_id, root_issue_id, source_hash, max_characters, clipped, source_refs, bundle_markdown, metadata)
     VALUES ($1, $2, $3, $13, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb)`,
    [
      snapshotId,
      input.companyId,
      wikiId,
      runId,
      scope.projectId,
      scope.rootIssueId,
      bundle.sourceHash,
      limits.maxCharacters,
      bundle.clipped,
      jsonParam(bundle.sourceRefs),
      bundle.markdown,
      jsonParam({
        spaceSlug: space.slug,
        sourceScope: scope.sourceScope,
        estimatedCostCents,
        backfillStartAt: isoString(input.backfillStartAt),
        backfillEndAt: isoString(input.backfillEndAt),
      }),
      space.id,
    ],
  );

  return { status: "source_ready" as const, wikiId, spaceSlug: space.slug, cursorId, runId, snapshotId, bundle, estimatedCostCents };
}

export async function recordPaperclipDistillationOutcome(ctx: PluginContext, input: PaperclipDistillationOutcomeInput) {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await requirePaperclipIngestionPolicy(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug }, "execute", { requireEnabledProfile: true });
  const warnings = input.warning ? [input.warning] : [];
  await ctx.db.execute(
    `UPDATE ${distillationRunTable(ctx)}
        SET status = $4,
            warnings = CASE WHEN $5::jsonb = '[]'::jsonb THEN warnings ELSE warnings || $5::jsonb END,
            cost_cents = CASE WHEN $6::integer IS NULL THEN cost_cents ELSE $6::integer END,
            retry_count = CASE WHEN $7::integer IS NULL THEN retry_count ELSE $7::integer END,
            updated_at = now()
      WHERE company_id = $1
        AND wiki_id = $2
        AND space_id = $8
        AND id = $3`,
    [
      input.companyId,
      wikiId,
      input.runId,
      input.status,
      jsonArrayParam(warnings),
      input.costCents ?? null,
      input.retryCount ?? null,
      space.id,
    ],
  );

  if (input.status === "succeeded" && input.cursorId && input.sourceHash && input.sourceWindowEnd) {
    await ctx.db.execute(
      `UPDATE ${distillationCursorTable(ctx)}
          SET last_processed_at = $4::timestamptz,
              last_successful_run_id = $3,
              last_source_hash = $5,
              pending_event_count = 0,
              updated_at = now()
        WHERE company_id = $1
          AND wiki_id = $2
          AND space_id = $7
          AND id = $6`,
      [input.companyId, wikiId, input.runId, input.sourceWindowEnd, input.sourceHash, input.cursorId, space.id],
    );
  }

  return {
    status: input.status,
    cursorAdvanced: input.status === "succeeded" && Boolean(input.cursorId && input.sourceHash && input.sourceWindowEnd),
  };
}

export async function createPaperclipDistillationWorkItem(ctx: PluginContext, input: PaperclipDistillationWorkItemInput) {
  const wikiId = normalizeWikiId(input.wikiId);
  assertPaperclipSourceScopePayload(input);
  const space = await requirePaperclipIngestionPolicy(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug }, "queue", { requireEnabledProfile: true });
  const itemId = randomUUID();
  const scope = paperclipCursorScopeMetadata(input);
  if (input.kind === "backfill" && !scope.projectId && !scope.rootIssueId) {
    throw new Error("Backfill work items must target a projectId or rootIssueId; whole-company backfill is not allowed.");
  }
  await ctx.db.execute(
    `INSERT INTO ${distillationWorkItemTable(ctx)} AS paperclip_distillation_work_items
       (id, company_id, wiki_id, space_id, work_item_kind, status, priority, project_id, root_issue_id, requested_by_issue_id, idempotency_key, metadata)
     VALUES ($1, $2, $3, $11, $4, 'pending', $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (company_id, wiki_id, space_id, idempotency_key)
     DO UPDATE SET priority = EXCLUDED.priority,
                   metadata = paperclip_distillation_work_items.metadata || EXCLUDED.metadata,
                   updated_at = now()`,
    [
      itemId,
      input.companyId,
      wikiId,
      input.kind,
      input.priority ?? "medium",
      scope.projectId,
      scope.rootIssueId,
      input.requestedByIssueId ?? null,
      input.idempotencyKey ?? null,
      jsonParam({
        spaceSlug: space.slug,
        sourceScope: scope.sourceScope,
        ...(input.metadata ?? {}),
      }),
      space.id,
    ],
  );
  return { status: "pending", workItemId: itemId, wikiId, spaceSlug: space.slug, kind: input.kind, sourceScope: scope.sourceScope };
}

function sourceRefLabel(ref: PaperclipSourceRef): string {
  const issue = ref.issueIdentifier ? issueReference(ref.issueIdentifier) : (ref.title ?? "Paperclip source");
  if (ref.kind === "document") return `${issue} document:${ref.documentKey ?? "unknown"}`;
  if (ref.kind === "comment") return `${issue} comment`;
  return issue;
}

function sourceRefMarkdown(ref: PaperclipSourceRef): string {
  const metadata = [
    ref.redactionStatus ? `redaction=${ref.redactionStatus}` : null,
    ref.redactionReasons?.length ? `redaction_reasons=${ref.redactionReasons.join("|")}` : null,
  ].filter((part): part is string => Boolean(part)).join(", ");
  return `- ${sourceRefLabel(ref)}${metadata ? ` (${metadata})` : ""}`;
}

function issueSourceRef(issue: Issue): PaperclipSourceRef {
  return {
    kind: "issue",
    issueId: issue.id,
    issueIdentifier: issue.identifier ?? null,
    projectId: issue.projectId ?? null,
    title: issue.title,
    updatedAt: isoString(issue.updatedAt) ?? undefined,
  };
}

function projectPageSlug(input: { project: Project | null; rootIssue: Issue | null }): string {
  return slugify(input.project?.name ?? input.rootIssue?.title ?? "paperclip-project");
}

function issueDescription(issue: Issue): string {
  return issue.description?.trim() ?? "";
}

function issueReference(identifier: string): string {
  const prefix = identifier.match(/^([A-Z]+)-\d+$/)?.[1];
  return prefix ? `[${identifier}](/${prefix}/issues/${identifier})` : identifier;
}

function issueReferenceFor(issue: Issue): string {
  return issue.identifier ? issueReference(issue.identifier) : "source issue";
}

function issueConcept(issue: Issue): string {
  const title = issue.title
    .replace(/^\s*(implement|add|update|fix|ship|write|create|publish|review|validate|investigate|design|refactor|support|make)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = title.split(" ").filter(Boolean).slice(0, 5).join(" ");
  return words || issue.title;
}

function issueNarrative(issue: Issue, maxLength = 260): string {
  const details = issueDescription(issue);
  return excerpt(details || issue.title, maxLength);
}

function conceptBullet(issue: Issue): string {
  return `- **${issueConcept(issue)}.** ${issueNarrative(issue)} (${issueReferenceFor(issue)})`;
}

function excerpt(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function hasDecisionSignal(value: string): boolean {
  return /\b(accepted|approved|rejected|reversed|decided|decision|plan|proposal|approach|architecture|tradeoff)\b/i.test(value);
}

function hasRiskSignal(value: string): boolean {
  return /\b(blocked|blocker|risk|warning|stale|conflict|failed|failure|regression)\b/i.test(value);
}

function hasDurableSignal(bundle: PaperclipSourceBundle, issues: Issue[]): boolean {
  if (bundle.sourceRefs.some((ref) => ref.kind === "document" || ref.kind === "comment")) return true;
  if (issues.some((issue) => issue.status !== "todo" || issueDescription(issue).length > 0)) return true;
  return /\b(decision|approved|implemented|completed|blocked|risk|artifact|plan|handoff|merged|fixed)\b/i.test(bundle.markdown);
}

function standupPageContents(input: {
  project: Project | null;
  rootIssue: Issue | null;
  issues: Issue[];
  bundle: PaperclipSourceBundle;
  pagePath: string;
  durablePagePath: string;
}): string {
  const currentAsOf = input.bundle.sourceWindowEnd ?? new Date().toISOString();
  const title = input.project?.name ?? input.rootIssue?.title ?? "Paperclip Project";
  const activeIssues = input.issues.filter((issue) => !["done", "cancelled"].includes(issue.status));
  const recentlyChanged = [...input.issues]
    .sort((a, b) => (isoString(b.updatedAt) ?? "").localeCompare(isoString(a.updatedAt) ?? ""))
    .slice(0, 6);
  const completedIssues = recentlyChanged.filter((issue) => issue.status === "done");
  const advancedIssues = recentlyChanged.filter((issue) => issue.status !== "done" && issue.status !== "cancelled");
  const decisionIssues = input.issues.filter((issue) => hasDecisionSignal(`${issue.title}\n${issueDescription(issue)}`)).slice(0, 6);
  const riskIssues = input.issues.filter((issue) => issue.status === "blocked" || hasRiskSignal(`${issue.title}\n${issueDescription(issue)}`)).slice(0, 6);
  const nextActionIssues = activeIssues.slice(0, 6);
  const lead = activeIssues[0] ?? recentlyChanged[0] ?? null;

  return [
    "---",
    `title: ${JSON.stringify(`${title} Standup`)}`,
    "type: project-standup",
    `project: ${JSON.stringify(projectPageSlug(input))}`,
    `current_as_of: ${JSON.stringify(currentAsOf)}`,
    "sources: []",
    "---",
    "",
    `# ${title} Standup`,
    "",
    "## Executive Readout",
    "",
    lead
      ? `The current center of gravity is **${issueConcept(lead)}** (${issueReferenceFor(lead)}). ${input.bundle.clipped ? "The source window was clipped, so treat this as a bounded readout rather than the full live state." : "This is a high-level readout of the meaningful Paperclip work in the current source window."}`
      : "No meaningful project movement was present in this source window.",
    "",
    "## What Changed",
    "",
    ...(completedIssues.length
      ? completedIssues.map(conceptBullet)
      : advancedIssues.length
        ? advancedIssues.map(conceptBullet)
        : ["- No material completed or advanced work was identified in this source window."]),
    "",
    "## Decisions",
    "",
    ...(decisionIssues.length
      ? decisionIssues.map(conceptBullet)
      : ["- No decision changed the project direction in this source window."]),
    "",
    "## Blockers / Risks",
    "",
    ...(riskIssues.length
      ? riskIssues.map(conceptBullet)
      : ["- No active blocker or material risk surfaced in this source window."]),
    "",
    "## Next Actions",
    "",
    ...(nextActionIssues.length
      ? nextActionIssues.map((issue) => `- **${issueConcept(issue)}.** Continue the work represented by ${issueReferenceFor(issue)}; focus on the next concrete deliverable rather than routine status churn.`)
      : ["- No next action inferred from this source window."]),
    "",
    "## Links",
    "",
    `- Durable project overview: [[${input.durablePagePath}]]`,
    ...input.bundle.sourceRefs.slice(0, 12).map(sourceRefMarkdown),
    "",
  ].filter((line): line is string => line !== null).join("\n");
}

function projectPageContents(input: {
  project: Project | null;
  rootIssue: Issue | null;
  issues: Issue[];
  bundle: PaperclipSourceBundle;
  pagePath: string;
}): string {
  const currentAsOf = input.bundle.sourceWindowEnd ?? new Date().toISOString();
  const title = input.project?.name ?? input.rootIssue?.title ?? "Paperclip Project";
  const description = input.project?.description?.trim() || input.rootIssue?.description?.trim() || "";
  const activeIssues = input.issues.filter((issue) => !["done", "cancelled"].includes(issue.status));
  const recentIssues = [...input.issues]
    .sort((a, b) => (isoString(b.updatedAt) ?? "").localeCompare(isoString(a.updatedAt) ?? ""))
    .slice(0, 8);
  const decisionIssues = input.issues.filter((issue) => hasDecisionSignal(`${issue.title}\n${issueDescription(issue)}`)).slice(0, 8);
  const riskIssues = input.issues.filter((issue) => issue.status === "blocked" || hasRiskSignal(`${issue.title}\n${issueDescription(issue)}`)).slice(0, 8);

  return [
    "---",
    `title: ${JSON.stringify(title)}`,
    "type: project",
    `current_as_of: ${JSON.stringify(currentAsOf)}`,
    "sources: []",
    "---",
    "",
    `# ${title}`,
    "",
    "## Overview",
    "",
    description ? excerpt(description, 700) : `This page synthesizes Paperclip issue history into a stable project brief for ${title}.`,
    "",
    "## Current Direction",
    "",
    activeIssues.length
      ? `Work is currently organized around ${activeIssues.slice(0, 3).map((issue) => `**${issueConcept(issue)}** (${issueReferenceFor(issue)})`).join(", ")}. The useful project view is the concept being advanced, not the raw issue queue.`
      : "The current source window does not show active project work.",
    input.bundle.clipped ? "\nThe source window was clipped, so verify Paperclip before treating this as complete state." : null,
    "",
    "## Workstreams",
    "",
    ...(recentIssues.length
      ? recentIssues.map(conceptBullet)
      : ["- No meaningful workstream signal was identified in this source window."]),
    "",
    "## Decisions",
    "",
    ...(decisionIssues.length
      ? decisionIssues.map(conceptBullet)
      : ["- No durable decision signal was identified in this source window."]),
    "",
    "## Open Risks / Blockers",
    "",
    ...(riskIssues.length
      ? riskIssues.map(conceptBullet)
      : ["- No open risks or blockers identified in this source window."]),
    "",
    "## References",
    "",
    `- Current standup: [[${input.pagePath.replace(/\/index\.md$/, "/standup.md")}]]`,
    ...input.bundle.sourceRefs.slice(0, 12).map(sourceRefMarkdown),
    "",
  ].filter((line): line is string => line !== null).join("\n");
}

function decisionsPageContents(input: { project: Project | null; rootIssue: Issue | null; issues: Issue[]; bundle: PaperclipSourceBundle }): string {
  const title = input.project?.name ?? input.rootIssue?.title ?? "Paperclip Project";
  const decisionIssues = input.issues.filter((issue) => hasDecisionSignal(`${issue.title}\n${issueDescription(issue)}`));
  return [
    `# ${title} Decisions`,
    "",
    "Durable project decisions grouped by concept. Use this as an editorial memory of why the project changed direction, not as an issue log.",
    "",
    ...(decisionIssues.length
      ? decisionIssues.map((issue) => [
        `## ${issueConcept(issue)}`,
        "",
        issueDescription(issue) ? excerpt(issueDescription(issue), 900) : "_No decision details beyond the issue title._",
        "",
        `Source: ${issueReferenceFor(issue)}`,
        "",
      ].join("\n"))
      : ["No durable decisions identified in this source window.", ""]),
    "## References",
    "",
    ...input.bundle.sourceRefs.slice(0, 40).map(sourceRefMarkdown),
    "",
  ].join("\n");
}

function historyPageContents(input: { project: Project | null; rootIssue: Issue | null; issues: Issue[]; bundle: PaperclipSourceBundle }): string {
  const title = input.project?.name ?? input.rootIssue?.title ?? "Paperclip Project";
  const timeline = [...input.issues]
    .sort((a, b) => (isoString(a.updatedAt) ?? "").localeCompare(isoString(b.updatedAt) ?? ""))
    .slice(-30);
  return [
    `# ${title} History`,
    "",
    "Narrative history of meaningful project movement. Group by what changed in the work, not by dates or metadata.",
    "",
    "## Meaningful Project Movement",
    "",
    ...(timeline.length
      ? timeline.map(conceptBullet)
      : ["- No source issues in this window."]),
    "",
    "## References",
    "",
    ...input.bundle.sourceRefs.slice(0, 40).map(sourceRefMarkdown),
    "",
  ].join("\n");
}

function updateProjectIndexContents(current: string | null, input: { pagePath: string; standupPath: string; title: string }): string {
  const base = current?.trimEnd() || "# Index\n\n## Sources\n\n_(none yet)_\n\n## Projects\n\n_(none yet)_\n\n## Entities\n\n_(none yet)_\n\n## Concepts\n\n_(none yet)_\n\n## Synthesis\n\n_(none yet)_";
  const entry = `- [[${input.pagePath}]] — ${input.title} project overview. Current executive standup: [[${input.standupPath}]].`;
  const projectsMatch = base.match(/(^## Projects\n)([\s\S]*?)(?=^## |\s*$)/m);
  if (!projectsMatch || projectsMatch.index == null) {
    return `${base}\n\n## Projects\n\n${entry}\n`;
  }
  const start = projectsMatch.index + projectsMatch[1].length;
  const end = start + projectsMatch[2].length;
  const existingLines = projectsMatch[2]
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && line.trim() !== "_(none yet)_" && !line.includes(input.pagePath) && !line.includes(input.standupPath));
  const nextLines = [...existingLines, entry].sort((a, b) => a.localeCompare(b));
  return `${base.slice(0, start)}${nextLines.join("\n")}\n\n${base.slice(end).replace(/^\n+/, "")}`.trimEnd() + "\n";
}

function appendProjectLogContents(current: string | null, input: { standupPath: string; pagePath: string; runId: string; sourceHash: string; status: string; warnings: string[] }): string {
  const base = current?.trimEnd() || "# Log\n\nAppend-only chronological record of wiki operations.";
  const warningLines = input.warnings.length
    ? input.warnings.map((warning) => `- warning: ${warning}`)
    : ["- warnings: none"];
  const entry = [
    `## [${new Date().toISOString().slice(0, 10)}] paperclip-distill | ${input.status}`,
    `- standup: \`${input.standupPath}\``,
    `- page: \`${input.pagePath}\``,
    `- run: \`${input.runId}\``,
    `- source hash: \`${input.sourceHash}\``,
    ...warningLines,
  ].join("\n");
  return `${base}\n\n${entry}\n`;
}

function patchForPage(input: {
  path: string;
  operationType: PaperclipDistillationPatchOperation;
  currentHash: string | null;
  contents: string;
  bundle: PaperclipSourceBundle;
  confidence: "high" | "medium" | "low";
  warnings: string[];
  humanReviewRequired: boolean;
}): PaperclipDistillationPatch {
  return {
    pagePath: input.path,
    operationType: input.operationType,
    currentHash: input.currentHash,
    proposedHash: contentHash(input.contents),
    proposedContents: input.contents,
    sourceHash: input.bundle.sourceHash,
    sourceRefs: input.bundle.sourceRefs,
    cursorWindow: {
      start: input.bundle.sourceWindowStart,
      end: input.bundle.sourceWindowEnd,
    },
    confidence: input.confidence,
    warnings: input.warnings,
    humanReviewRequired: input.humanReviewRequired,
  };
}

async function readPageBinding(ctx: PluginContext, input: { companyId: string; wikiId: string; spaceId: string; pagePath: string }) {
  const rows = await ctx.db.query<{ last_applied_source_hash: string | null }>(
    `SELECT last_applied_source_hash
       FROM ${pageBindingTable(ctx)}
      WHERE company_id = $1
        AND wiki_id = $2
        AND space_id = $3
        AND page_path = $4
      LIMIT 1`,
    [input.companyId, input.wikiId, input.spaceId, input.pagePath],
  );
  return rows[0] ?? null;
}

async function upsertPageBinding(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  spaceId: string;
  spaceSlug: string;
  projectId: string | null;
  rootIssueId: string | null;
  pagePath: string;
  sourceHash: string;
  runId: string;
  metadata?: Record<string, unknown>;
}) {
  await ctx.db.execute(
    `INSERT INTO ${pageBindingTable(ctx)} AS paperclip_page_bindings
       (id, company_id, wiki_id, space_id, project_id, root_issue_id, page_path, last_applied_source_hash, last_distillation_run_id, metadata)
     VALUES ($1, $2, $3, $10, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (company_id, wiki_id, space_id, page_path)
     DO UPDATE SET last_applied_source_hash = EXCLUDED.last_applied_source_hash,
                   last_distillation_run_id = EXCLUDED.last_distillation_run_id,
                   metadata = paperclip_page_bindings.metadata || EXCLUDED.metadata,
                   updated_at = now()`,
    [
      randomUUID(),
      input.companyId,
      input.wikiId,
      input.projectId,
      input.rootIssueId,
      input.pagePath,
      input.sourceHash,
      input.runId,
      jsonParam({ spaceSlug: input.spaceSlug, ...(input.metadata ?? {}) }),
      input.spaceId,
    ],
  );
}

async function autoApplyEnabled(ctx: PluginContext, requested: boolean | undefined): Promise<boolean> {
  if (getDistillationAutoApplyRestriction().autoApplyRestriction) {
    return false;
  }
  const config = await ctx.config.get();
  const configured = (config as { autoApplyIngestPatches?: unknown }).autoApplyIngestPatches !== false;
  return configured && requested !== false;
}

export function getDistillationAutoApplyRestriction(): DistillationAutoApplyRestriction {
  const rawMode = process.env.PAPERCLIP_DEPLOYMENT_MODE;
  const rawExposure = process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE;
  const deploymentMode =
    rawMode === "local_trusted" || rawMode === "authenticated" ? rawMode : null;
  const deploymentExposure =
    rawExposure === "private" || rawExposure === "public" ? rawExposure : null;
  const blocked = deploymentMode === "authenticated" && deploymentExposure === "public";
  return {
    autoApplyAllowed: !blocked,
    autoApplyRestriction: blocked ? PUBLIC_DISTILLATION_AUTO_APPLY_RESTRICTION : null,
    deploymentMode,
    deploymentExposure,
  };
}

export async function distillPaperclipProjectPage(ctx: PluginContext, input: PaperclipProjectPageDistillationInput) {
  if (!input.projectId && !input.rootIssueId) {
    throw new Error("projectId or rootIssueId is required");
  }
  const wikiId = normalizeWikiId(input.wikiId);
  assertPaperclipSourceScopePayload(input);
  const space = await requirePaperclipIngestionPolicy(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug }, "execute", { requireEnabledProfile: true });
  const scope = paperclipCursorScopeMetadata(input);
  const issues = await listPaperclipBundleIssues(ctx, input);
  const project = scope.projectId ? await ctx.projects.get(scope.projectId, input.companyId) : null;
  const rootIssue = scope.rootIssueId ? await ctx.issues.get(scope.rootIssueId, input.companyId) : null;
  const slug = projectPageSlug({ project, rootIssue });
  const projectDir = `wiki/projects/${slug}`;
  const standupPath = assertPagePath(`${projectDir}/standup.md`);
  const pagePath = assertPagePath(`${projectDir}/index.md`);
  const run = await createPaperclipDistillationRun(ctx, input);
  const bundle = run.bundle;
  const current = await readCurrentWithHash(ctx, input.companyId, pagePath, space);
  assertExpectedHash(input.expectedProjectPageHash, current.hash, pagePath);

  if (!hasDurableSignal(bundle, issues)) {
    await recordPaperclipDistillationOutcome(ctx, {
      companyId: input.companyId,
      wikiId,
      spaceSlug: space.slug,
      runId: run.runId,
      cursorId: run.cursorId,
      status: "succeeded",
      sourceHash: bundle.sourceHash,
      sourceWindowEnd: bundle.sourceWindowEnd,
      warning: "Skipped low-signal Paperclip source window.",
    });
    return {
      status: "skipped",
      reason: "low_signal",
      wikiId,
      runId: run.runId,
      cursorId: run.cursorId,
      sourceHash: bundle.sourceHash,
      warnings: ["Skipped low-signal Paperclip source window."],
      patches: [] as PaperclipDistillationPatch[],
    };
  }

  const existingBinding = await readPageBinding(ctx, { companyId: input.companyId, wikiId, spaceId: space.id, pagePath });
  if (existingBinding?.last_applied_source_hash === bundle.sourceHash) {
    await recordPaperclipDistillationOutcome(ctx, {
      companyId: input.companyId,
      wikiId,
      spaceSlug: space.slug,
      runId: run.runId,
      cursorId: run.cursorId,
      status: "succeeded",
      sourceHash: bundle.sourceHash,
      sourceWindowEnd: bundle.sourceWindowEnd,
      warning: "Skipped unchanged Paperclip source hash.",
    });
    return {
      status: "skipped",
      reason: "unchanged_source",
      wikiId,
      runId: run.runId,
      cursorId: run.cursorId,
      sourceHash: bundle.sourceHash,
      warnings: ["Skipped unchanged Paperclip source hash."],
      patches: [] as PaperclipDistillationPatch[],
    };
  }

  const warnings = [...bundle.warnings];
  const confidence: "high" | "medium" | "low" = bundle.clipped ? "medium" : "high";
  const reviewRequired = bundle.clipped || warnings.length > 0;
  const title = project?.name ?? rootIssue?.title ?? "Paperclip Project";
  const standupCurrent = await readCurrentWithHash(ctx, input.companyId, standupPath, space);
  const standupContents = standupPageContents({ project, rootIssue, issues, bundle, pagePath: standupPath, durablePagePath: pagePath });
  const projectContents = projectPageContents({ project, rootIssue, issues, bundle, pagePath });
  const indexCurrent = await readCurrentWithHash(ctx, input.companyId, "wiki/index.md", space);
  const logCurrent = await readCurrentWithHash(ctx, input.companyId, "wiki/log.md", space);
  const indexContents = updateProjectIndexContents(indexCurrent.contents, {
    pagePath,
    standupPath,
    title,
  });
  const logContents = appendProjectLogContents(logCurrent.contents, {
    standupPath,
    pagePath,
    runId: run.runId,
    sourceHash: bundle.sourceHash,
    status: "proposed",
    warnings,
  });
  const patches: PaperclipDistillationPatch[] = [
    patchForPage({ path: standupPath, operationType: "standup_update", currentHash: standupCurrent.hash, contents: standupContents, bundle, confidence, warnings, humanReviewRequired: reviewRequired }),
    patchForPage({ path: pagePath, operationType: "project_page_distill", currentHash: current.hash, contents: projectContents, bundle, confidence, warnings, humanReviewRequired: reviewRequired }),
    patchForPage({ path: "wiki/index.md", operationType: "index_refresh", currentHash: indexCurrent.hash, contents: indexContents, bundle, confidence: "high", warnings: [], humanReviewRequired: false }),
    patchForPage({ path: "wiki/log.md", operationType: "log_append", currentHash: logCurrent.hash, contents: logContents, bundle, confidence: "high", warnings: [], humanReviewRequired: false }),
  ];

  if (input.includeSupportingPages !== false) {
    const hasDecisions = issues.some((issue) => hasDecisionSignal(`${issue.title}\n${issueDescription(issue)}`));
    if (hasDecisions) {
      const decisionsPath = assertPagePath(`${projectDir}/decisions.md`);
      const decisionsCurrent = await readCurrentWithHash(ctx, input.companyId, decisionsPath, space);
      patches.push(patchForPage({
        path: decisionsPath,
        operationType: "decision_distill",
        currentHash: decisionsCurrent.hash,
        contents: decisionsPageContents({ project, rootIssue, issues, bundle }),
        bundle,
        confidence,
        warnings,
        humanReviewRequired: reviewRequired,
      }));
    }
    const historyPath = assertPagePath(`${projectDir}/history.md`);
    const historyCurrent = await readCurrentWithHash(ctx, input.companyId, historyPath, space);
    patches.push(patchForPage({
      path: historyPath,
      operationType: "history_distill",
      currentHash: historyCurrent.hash,
      contents: historyPageContents({ project, rootIssue, issues, bundle }),
      bundle,
      confidence,
      warnings,
      humanReviewRequired: reviewRequired,
    }));
  }

  const autoApplyRestriction = getDistillationAutoApplyRestriction();
  const canAutoApply = await autoApplyEnabled(ctx, input.autoApply);
  if (!canAutoApply || reviewRequired) {
    const autoApplyWarning =
      autoApplyRestriction.autoApplyRestriction
      ?? "Auto-apply policy disabled; proposed patches require review.";
    await recordPaperclipDistillationOutcome(ctx, {
      companyId: input.companyId,
      wikiId,
      spaceSlug: space.slug,
      runId: run.runId,
      cursorId: run.cursorId,
      status: "review_required",
      sourceHash: bundle.sourceHash,
      sourceWindowEnd: bundle.sourceWindowEnd,
      warning: canAutoApply ? "Human review required by patch warnings." : autoApplyWarning,
    });
    return {
      status: "review_required",
      wikiId,
      runId: run.runId,
      cursorId: run.cursorId,
      sourceHash: bundle.sourceHash,
      patches,
      appliedPages: [] as string[],
      warnings: canAutoApply ? warnings : [autoApplyWarning, ...warnings],
    };
  }

  const appliedPages: string[] = [];
  for (const patch of patches) {
    await writeWikiPage(ctx, {
      companyId: input.companyId,
      wikiId,
      spaceSlug: space.slug,
      path: patch.pagePath,
      contents: patch.proposedContents,
      expectedHash: patch.currentHash,
      summary: `Paperclip distillation ${patch.operationType} from ${bundle.sourceHash}`,
      sourceRefs: patch.sourceRefs,
    });
    await upsertPageBinding(ctx, {
      companyId: input.companyId,
      wikiId,
      spaceId: space.id,
      spaceSlug: space.slug,
      projectId: scope.projectId,
      rootIssueId: scope.rootIssueId,
      pagePath: patch.pagePath,
      sourceHash: bundle.sourceHash,
      runId: run.runId,
      metadata: { operationType: patch.operationType },
    });
    appliedPages.push(patch.pagePath);
  }
  await recordPaperclipDistillationOutcome(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceSlug: space.slug,
    runId: run.runId,
    cursorId: run.cursorId,
    status: "succeeded",
    sourceHash: bundle.sourceHash,
    sourceWindowEnd: bundle.sourceWindowEnd,
  });

  return {
    status: "applied",
    wikiId,
    runId: run.runId,
    cursorId: run.cursorId,
    sourceHash: bundle.sourceHash,
    patches,
    appliedPages,
    warnings,
  };
}

function truncateEventSource(contents: string, maxCharacters: number): string {
  if (contents.length <= maxCharacters) return contents;
  return `${contents.slice(0, maxCharacters)}\n\n[Truncated by LLM Wiki event ingestion policy at ${maxCharacters} characters.]\n`;
}

function eventPayload(event: PluginEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function sourceTitleForIssue(issue: Issue): string {
  return issue.identifier ? `${issue.identifier} ${issue.title}` : issue.title;
}

function rawPathForPaperclipEvent(input: {
  sourceKind: WikiEventIngestionSource;
  issue: Issue;
  label: string;
  contents: string;
  event: PluginEvent;
}): string {
  const identifier = input.issue.identifier ?? input.issue.id.slice(0, 8);
  const eventDate = input.event.occurredAt.slice(0, 10);
  return assertRawPath(`raw/paperclip/${input.sourceKind}/${eventDate}-${slugify(identifier)}-${slugify(input.label)}-${contentHash(input.contents).slice(0, 8)}.md`);
}

function formatIssueEventSource(issue: Issue, event: PluginEvent, maxCharacters: number): string {
  return truncateEventSource([
    `# Paperclip issue: ${sourceTitleForIssue(issue)}`,
    "",
    "## Provenance",
    "",
    `- Company ID: ${issue.companyId}`,
    `- Issue ID: ${issue.id}`,
    issue.identifier ? `- Issue identifier: ${issue.identifier}` : null,
    `- Event type: ${event.eventType}`,
    `- Event ID: ${event.eventId}`,
    `- Event occurred at: ${event.occurredAt}`,
    `- Status: ${issue.status}`,
    `- Priority: ${issue.priority}`,
    "",
    "## Issue",
    "",
    issue.description?.trim() ? issue.description.trim() : "_No issue description._",
  ].filter((line): line is string => line !== null).join("\n"), maxCharacters);
}

function formatCommentEventSource(issue: Issue, comment: IssueComment, event: PluginEvent, maxCharacters: number): string {
  return truncateEventSource([
    `# Paperclip comment on ${sourceTitleForIssue(issue)}`,
    "",
    "## Provenance",
    "",
    `- Company ID: ${issue.companyId}`,
    `- Issue ID: ${issue.id}`,
    issue.identifier ? `- Issue identifier: ${issue.identifier}` : null,
    `- Comment ID: ${comment.id}`,
    `- Event type: ${event.eventType}`,
    `- Event ID: ${event.eventId}`,
    `- Event occurred at: ${event.occurredAt}`,
    "",
    "## Comment",
    "",
    comment.body,
  ].filter((line): line is string => line !== null).join("\n"), maxCharacters);
}

function formatDocumentEventSource(issue: Issue, document: IssueDocument, event: PluginEvent, maxCharacters: number): string {
  return truncateEventSource([
    `# Paperclip document: ${document.title ?? document.key}`,
    "",
    "## Provenance",
    "",
    `- Company ID: ${issue.companyId}`,
    `- Issue ID: ${issue.id}`,
    issue.identifier ? `- Issue identifier: ${issue.identifier}` : null,
    `- Document ID: ${document.id}`,
    `- Document key: ${document.key}`,
    `- Event type: ${event.eventType}`,
    `- Event ID: ${event.eventId}`,
    `- Event occurred at: ${event.occurredAt}`,
    `- Format: ${document.format}`,
    `- Revision: ${document.latestRevisionNumber}`,
    "",
    "## Document",
    "",
    document.body,
  ].filter((line): line is string => line !== null).join("\n"), maxCharacters);
}

async function recordPaperclipCursorObservation(ctx: PluginContext, input: {
  companyId: string;
  wikiId: string;
  space: WikiSpace;
  sourceKind: WikiEventIngestionSource;
  sourceId: string;
  issue: Issue;
  event: PluginEvent;
}): Promise<Extract<PaperclipEventIngestResult, { status: "recorded" }>> {
  const cursorId = await upsertPaperclipDistillationCursor(ctx, {
    companyId: input.companyId,
    wikiId: input.wikiId,
    spaceId: input.space.id,
    projectId: input.issue.projectId ?? null,
    rootIssueId: null,
    observedAt: input.event.occurredAt,
    metadata: {
      lastEventId: input.event.eventId,
      lastEventType: input.event.eventType,
      lastSourceKind: input.sourceKind,
      lastSourceId: input.sourceId,
      lastIssueId: input.issue.id,
      lastIssueIdentifier: input.issue.identifier ?? null,
    },
  });
  await ctx.state.set(eventIngestionDedupKey(input.companyId, input.wikiId, input.space.id, input.sourceKind, input.sourceId), {
    eventId: input.event.eventId,
    cursorId,
    issueId: input.issue.id,
    spaceSlug: input.space.slug,
    observedAt: new Date().toISOString(),
  });
  return {
    status: "recorded",
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    cursorId,
    issueId: input.issue.id,
  };
}

async function paperclipProfileIncludesIssue(ctx: PluginContext, input: {
  companyId: string;
  issue: Issue;
  profile: PaperclipIngestionProfileV1;
}): Promise<boolean> {
  for (const scope of input.profile.sourceScopes) {
    if (scope.kind === "company_all") return true;
    if (scope.kind === "selected_projects" && input.issue.projectId && scope.projectIds.includes(input.issue.projectId)) {
      return true;
    }
    if (scope.kind === "active_projects" && input.issue.projectId) {
      const project = await ctx.projects.get(input.issue.projectId, input.companyId);
      const statuses = scope.statuses ?? ["in_progress"];
      if (project && statuses.includes(project.status as "in_progress" | "todo" | "done") && isActiveDistillationProject(project)) {
        return true;
      }
    }
    if (scope.kind === "root_issues") {
      for (const rootIssueId of scope.issueIds) {
        if (input.issue.id === rootIssueId) return true;
        const subtree = await ctx.issues.getSubtree(rootIssueId, input.companyId, { includeRoot: true });
        if (subtree.issues.some((issue) => issue.id === input.issue.id)) return true;
      }
    }
  }
  return false;
}

async function routePaperclipCursorObservation(ctx: PluginContext, input: {
  companyId: string;
  sourceKind: WikiEventIngestionSource;
  sourceId: string;
  issue: Issue;
  event: PluginEvent;
}): Promise<PaperclipEventIngestResult> {
  const { spaces } = await listSpaces(ctx, { companyId: input.companyId, wikiId: DEFAULT_WIKI_ID });
  const recorded: Array<Extract<PaperclipEventIngestResult, { status: "recorded" }>> = [];
  let eligibleProfileCount = 0;
  for (const space of spaces) {
    const profile = await profileForSpace(ctx, input.companyId, space);
    if (!profile.enabled) continue;
    const policy = evaluatePaperclipProfilePolicy({ space, profile, purpose: "event_routing", requireEnabledProfile: true });
    if (!policy.allowed) continue;
    if (!profile.sourceKinds[input.sourceKind]) continue;
    if (!(await paperclipProfileIncludesIssue(ctx, { companyId: input.companyId, issue: input.issue, profile }))) continue;
    eligibleProfileCount += 1;
    if (eligibleProfileCount > MAX_PAPERCLIP_DISTILLATION_FAN_OUT) {
      throw new Error(`Paperclip ingestion fan-out exceeds the hard cap of ${MAX_PAPERCLIP_DISTILLATION_FAN_OUT} enabled profiles.`);
    }
    if (await ctx.state.get(eventIngestionDedupKey(input.companyId, space.wikiId, space.id, input.sourceKind, input.sourceId))) {
      continue;
    }
    recorded.push(await recordPaperclipCursorObservation(ctx, {
      ...input,
      wikiId: space.wikiId,
      space,
    }));
  }
  return recorded[0] ?? { status: "skipped", reason: "source_disabled" };
}

export async function handlePaperclipEventIngestion(ctx: PluginContext, event: PluginEvent): Promise<PaperclipEventIngestResult> {
  const companyId = event.companyId;

  const issueId = stringField(event.entityId);
  if (!issueId) return { status: "skipped", reason: "unsupported_event" };
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return { status: "skipped", reason: "missing_issue" };
  if (isLlmWikiOperationIssue(issue)) return { status: "skipped", reason: "plugin_operation" };

  const payload = eventPayload(event);
  if (event.eventType === "issue.created" || event.eventType === "issue.updated") {
    const sourceId = `${event.eventType}:${issue.id}:${event.eventId}`;
    return routePaperclipCursorObservation(ctx, {
      companyId,
      sourceKind: "issues",
      sourceId,
      issue,
      event,
    });
  }

  if (event.eventType === "issue.comment.created") {
    const commentId = stringField(payload.commentId);
    if (!commentId) return { status: "skipped", reason: "missing_comment" };
    const sourceId = `comment:${commentId}`;
    return routePaperclipCursorObservation(ctx, {
      companyId,
      sourceKind: "comments",
      sourceId,
      issue,
      event,
    });
  }

  if (event.eventType === "issue.document.created" || event.eventType === "issue.document.updated") {
    const documentKey = stringField(payload.key) ?? stringField(payload.documentKey);
    if (!documentKey) return { status: "skipped", reason: "missing_document" };
    const revision = stringField(payload.revisionId) ?? stringField(payload.latestRevisionId) ?? stringField(payload.revisionNumber) ?? event.eventId;
    const sourceId = `document:${issue.id}:${documentKey}:revision:${revision}`;
    return routePaperclipCursorObservation(ctx, {
      companyId,
      sourceKind: "documents",
      sourceId,
      issue,
      event,
    });
  }

  return { status: "skipped", reason: "unsupported_event" };
}

function queryStreamChannel(operationId: string): string {
  return `llm-wiki:query:${operationId}`;
}

function buildQueryPrompt(input: { companyId: string; wikiId: string; space: WikiSpace; question: string }): string {
  return [
    QUERY_PROMPT,
    `Company ID: ${input.companyId}`,
    `Wiki ID: ${input.wikiId}`,
    `Space: ${input.space.displayName} (${input.space.slug})`,
    `Space root: ${operationSpaceRoot(input.space)}`,
    `Tool arguments: always pass wikiId \`${input.wikiId}\` and spaceSlug \`${input.space.slug}\`.`,
    "Use the LLM Wiki plugin tools against that space only. Read wiki/index.md first with wiki_read_page, then use wiki_search, wiki_read_page, wiki_list_sources, and wiki_read_source as needed.",
    "Cite the wiki page paths and raw source paths you used. If the wiki does not contain enough evidence, say that directly.",
    `Question: ${input.question}`,
  ].join("\n\n");
}

async function markOperation(ctx: PluginContext, input: {
  companyId: string;
  operationId: string;
  status: string;
  runId?: string | null;
  warning?: string | null;
  affectedPages?: unknown[] | null;
  metadata?: Record<string, unknown> | null;
}) {
  await ctx.db.execute(
    `UPDATE ${tableName(ctx.db.namespace, "wiki_operations")}
        SET status = $3,
            run_ids = CASE WHEN $4::jsonb = '[]'::jsonb THEN run_ids ELSE run_ids || $4::jsonb END,
            warnings = CASE WHEN $5::jsonb = '[]'::jsonb THEN warnings ELSE warnings || $5::jsonb END,
            affected_pages = CASE WHEN $6::jsonb = '[]'::jsonb THEN affected_pages ELSE $6::jsonb END,
            metadata = metadata || $7::jsonb,
            updated_at = now()
      WHERE company_id = $1 AND id = $2`,
    [
      input.companyId,
      input.operationId,
      input.status,
      jsonArrayParam(input.runId ? [input.runId] : []),
      jsonArrayParam(input.warning ? [input.warning] : []),
      jsonArrayParam(input.affectedPages ?? []),
      jsonParam(input.metadata ?? {}),
    ],
  );
}

function isTerminalSessionEvent(event: AgentSessionEvent): boolean {
  return event.eventType === "done" || event.eventType === "error";
}

export async function startWikiQuerySession(ctx: PluginContext, input: QuerySessionInput) {
  const question = requireString(input.question, "question");
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const operation = await createOperationIssue(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceSlug: space.slug,
    operationType: "query",
    title: input.title ?? `Query LLM Wiki: ${question.slice(0, 72)}`,
    prompt: question,
  });
  const agentId = operation.issue.assigneeAgentId;
  const channel = queryStreamChannel(operation.operationId);

  if (!agentId) {
    const warning = "No configured Wiki Maintainer agent is available for this company.";
    await markOperation(ctx, {
      companyId: input.companyId,
      operationId: operation.operationId,
      status: "blocked",
      warning,
    });
    await ctx.issues.update(operation.issue.id, { status: "blocked" }, input.companyId);
    await ctx.issues.createComment(operation.issue.id, warning, input.companyId);
    throw new Error(warning);
  }

  const agent = await ctx.agents.get(agentId, input.companyId);
  if (!agent || agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
    const warning = agent
      ? `Wiki Maintainer agent is not invokable while status is ${agent.status}.`
      : "Wiki Maintainer agent could not be loaded.";
    await markOperation(ctx, {
      companyId: input.companyId,
      operationId: operation.operationId,
      status: "blocked",
      warning,
    });
    await ctx.issues.update(operation.issue.id, { status: "blocked" }, input.companyId);
    await ctx.issues.createComment(operation.issue.id, warning, input.companyId);
    throw new Error(warning);
  }

  const session = await ctx.agents.sessions.create(agentId, input.companyId, {
    taskKey: `plugin:${PLUGIN_ID}:session:wiki:${wikiId}:query:${operation.operationId}`,
    reason: "LLM Wiki query session",
  });
  await ctx.db.execute(
    `INSERT INTO ${tableName(ctx.db.namespace, "wiki_query_sessions")}
       (id, company_id, wiki_id, space_id, hidden_issue_id, agent_session_id, status, filed_outputs)
     VALUES ($1, $2, $3, $6, $4, $5, 'active', '[]'::jsonb)`,
    [operation.operationId, input.companyId, wikiId, operation.issue.id, session.sessionId, space.id],
  );

  const prompt = buildQueryPrompt({ companyId: input.companyId, wikiId, space, question });
  ctx.streams.open(channel, input.companyId);
  ctx.streams.emit(channel, {
    type: "query.started",
    operationId: operation.operationId,
    querySessionId: operation.operationId,
    issueId: operation.issue.id,
    sessionId: session.sessionId,
    question,
  });

  let answer = "";
  const sendResult = await ctx.agents.sessions.sendMessage(session.sessionId, input.companyId, {
    prompt,
    reason: "LLM Wiki query",
    onEvent: (event) => {
      if (event.eventType === "chunk" && event.stream !== "stderr" && event.message) {
        answer += event.message;
      }
      ctx.streams.emit(channel, {
        type: "agent.event",
        operationId: operation.operationId,
        querySessionId: operation.operationId,
        eventType: event.eventType,
        stream: event.stream,
        message: event.message,
        payload: event.payload,
        runId: event.runId,
        seq: event.seq,
      });
      if (isTerminalSessionEvent(event)) {
        const finalStatus = event.eventType === "done" ? "done" : "failed";
        ctx.streams.emit(channel, {
          type: event.eventType === "done" ? "query.done" : "query.error",
          operationId: operation.operationId,
          querySessionId: operation.operationId,
          issueId: operation.issue.id,
          sessionId: session.sessionId,
          runId: event.runId,
          answer,
          message: event.message,
        });
        ctx.streams.close(channel);
        void markOperation(ctx, {
          companyId: input.companyId,
          operationId: operation.operationId,
          status: finalStatus,
          runId: event.runId,
          warning: event.eventType === "error" ? event.message : null,
          metadata: { answerLength: answer.length },
        });
        void ctx.db.execute(
          `UPDATE ${tableName(ctx.db.namespace, "wiki_query_sessions")}
              SET status = $3,
                  updated_at = now()
            WHERE company_id = $1 AND id = $2`,
          [input.companyId, operation.operationId, finalStatus === "done" ? "completed" : "failed"],
        );
        void ctx.issues.createComment(
          operation.issue.id,
          event.eventType === "done"
            ? `Query completed.\n\n${answer.trim() || "_No answer text was streamed._"}`
            : `Query failed: ${event.message ?? "agent session ended with an error"}`,
          input.companyId,
        );
        void ctx.issues.update(
          operation.issue.id,
          { status: event.eventType === "done" ? "done" : "blocked", originRunId: event.runId },
          input.companyId,
        );
      }
    },
  });

  await markOperation(ctx, {
    companyId: input.companyId,
    operationId: operation.operationId,
    status: "running",
    runId: sendResult.runId,
  });
  await ctx.issues.update(operation.issue.id, { originRunId: sendResult.runId }, input.companyId);

  return {
    status: "running",
    wikiId,
    spaceSlug: space.slug,
    operationId: operation.operationId,
    querySessionId: operation.operationId,
    issue: operation.issue,
    sessionId: session.sessionId,
    runId: sendResult.runId,
    channel,
  };
}

export async function fileQueryAnswerAsPage(ctx: PluginContext, input: FileQueryAnswerInput) {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const path = assertPagePath(input.path);
  const title = stringField(input.title) ?? inferTitle(path, input.contents ?? input.answer ?? "");
  const answer = stringField(input.answer);
  const contents = stringField(input.contents) ?? [
    `# ${title}`,
    "",
    input.question ? `> Filed from query: ${input.question}` : null,
    "",
    answer ?? "",
  ].filter((line): line is string => line !== null).join("\n").trimEnd() + "\n";
  const operation = await createOperationIssue(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceSlug: space.slug,
    operationType: "file-as-page",
    title: `File LLM Wiki answer as ${path}`,
    prompt: input.question ?? answer ?? `Write ${path}`,
  });
  const result = await writeWikiPage(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceSlug: space.slug,
    path,
    contents,
    expectedHash: stringField(input.expectedHash),
    summary: `Filed query answer as ${path}`,
    sourceRefs: input.querySessionId ? [{ querySessionId: input.querySessionId }] : [],
    operationId: operation.operationId,
  });
  const affectedPage = {
    path,
    title: result.title,
    pageType: result.pageType,
    revisionId: result.revisionId,
  };
  await markOperation(ctx, {
    companyId: input.companyId,
    operationId: operation.operationId,
    status: "done",
    affectedPages: [affectedPage],
    metadata: { querySessionId: input.querySessionId ?? null },
  });
  await ctx.issues.update(operation.issue.id, { status: "done" }, input.companyId);
  await ctx.issues.createComment(
    operation.issue.id,
    `Filed query answer as \`${path}\`.`,
    input.companyId,
  );

  if (input.querySessionId) {
    await ctx.db.execute(
      `UPDATE ${tableName(ctx.db.namespace, "wiki_query_sessions")}
          SET filed_outputs = filed_outputs || $3::jsonb,
              updated_at = now()
        WHERE company_id = $1 AND id = $2`,
      [input.companyId, input.querySessionId, jsonArrayParam([affectedPage])],
    );
  }

  return {
    status: "ok",
    wikiId,
    spaceSlug: space.slug,
    path,
    operationId: operation.operationId,
    issue: operation.issue,
    page: affectedPage,
  };
}

export async function registerWikiTools(ctx: PluginContext) {
  ctx.tools.register("wiki_search", {
    displayName: "Search Wiki",
    description: "Search indexed wiki page and source metadata.",
    parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "wiki_search")?.parametersSchema ?? { type: "object" },
  }, async (params: unknown): Promise<ToolResult> => {
    const input = params as ToolParams;
    const companyId = requireString(input.companyId, "companyId");
    const wikiId = normalizeWikiId(input.wikiId);
    const space = await resolveSpace(ctx, { companyId, wikiId, spaceSlug: input.spaceSlug as string | null | undefined });
    const query = requireString(input.query, "query");
    const limit = normalizeLimit(input.limit, 20, 50);
    const body = await searchWikiDocuments(ctx, { companyId, wikiId, spaceSlug: space.slug, query, limit });
    const rows = await ctx.db.query<{ kind: string; path: string; title: string | null; match_text: string | null }>(
      `SELECT 'page' AS kind, path, title, page_type AS match_text
         FROM ${tableName(ctx.db.namespace, "wiki_pages")}
        WHERE company_id = $1 AND wiki_id = $2 AND space_id = $5 AND (lower(path) LIKE lower($3) OR lower(coalesce(title, '')) LIKE lower($3))
       UNION ALL
       SELECT 'source' AS kind, raw_path AS path, title, source_type AS match_text
         FROM ${tableName(ctx.db.namespace, "wiki_sources")}
        WHERE company_id = $1 AND wiki_id = $2 AND space_id = $5 AND (lower(raw_path) LIKE lower($3) OR lower(coalesce(title, '')) LIKE lower($3) OR lower(coalesce(url, '')) LIKE lower($3))
       ORDER BY kind, path
       LIMIT $4`,
      [companyId, wikiId, `%${query}%`, limit, space.id],
    );
    const seen = new Set(body.results.map((result) => `${result.kind}:${result.path}`));
    const merged = [
      ...body.results.map((result) => ({ kind: result.kind, path: result.path, title: result.title, match_text: result.snippet })),
      ...rows.filter((row) => !seen.has(`${row.kind}:${row.path}`)),
    ].slice(0, limit);
    return {
      content: merged.length ? merged.map((row) => `${row.kind}: ${row.path}${row.title ? ` - ${row.title}` : ""}`).join("\n") : "No wiki matches found.",
      data: { companyId, wikiId, spaceSlug: space.slug, query, results: merged, bodyResults: body.results },
    };
  });

  ctx.tools.register("wiki_read_page", {
    displayName: "Read Wiki Page",
    description: "Read a markdown wiki page from the configured local wiki root.",
    parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "wiki_read_page")?.parametersSchema ?? { type: "object" },
  }, async (params: unknown): Promise<ToolResult> => {
    const input = params as ToolParams;
    const companyId = requireString(input.companyId, "companyId");
    const wikiId = normalizeWikiId(input.wikiId);
    const space = await resolveSpace(ctx, { companyId, wikiId, spaceSlug: input.spaceSlug as string | null | undefined });
    const path = assertPagePath(requireString(input.path, "path"));
    const contents = await ctx.localFolders.readText(companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, path));
    return { content: contents, data: { companyId, wikiId, spaceSlug: space.slug, path, hash: contentHash(contents) } };
  });

  ctx.tools.register("wiki_write_page", {
    displayName: "Write Wiki Page",
    description: "Atomically write a markdown wiki page after plugin path validation.",
    parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "wiki_write_page")?.parametersSchema ?? { type: "object" },
  }, async (params: unknown): Promise<ToolResult> => {
    const input = params as ToolParams;
    const result = await writeWikiPage(ctx, {
      companyId: requireString(input.companyId, "companyId"),
      wikiId: stringField(input.wikiId),
      spaceSlug: stringField(input.spaceSlug),
      path: requireString(input.path, "path"),
      contents: requireString(input.contents, "contents"),
      expectedHash: stringField(input.expectedHash),
      summary: stringField(input.summary),
      sourceRefs: input.sourceRefs,
    });
    return { content: `Wrote ${result.path}`, data: result };
  });

  ctx.tools.register("wiki_propose_patch", {
    displayName: "Propose Wiki Patch",
    description: "Return a structured proposed page write without changing files.",
    parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "wiki_propose_patch")?.parametersSchema ?? { type: "object" },
  }, async (params: unknown): Promise<ToolResult> => {
    const input = params as ToolParams;
    const companyId = requireString(input.companyId, "companyId");
    const wikiId = normalizeWikiId(input.wikiId);
    const space = await resolveSpace(ctx, { companyId, wikiId, spaceSlug: input.spaceSlug as string | null | undefined });
    const path = assertPagePath(requireString(input.path, "path"));
    const contents = requireString(input.contents, "contents");
    const current = await readCurrentWithHash(ctx, companyId, path, space);
    return {
      content: `Proposed patch for ${path}`,
      data: {
        companyId,
        wikiId,
        spaceSlug: space.slug,
        path,
        summary: stringField(input.summary),
        currentHash: current.hash,
        proposedHash: contentHash(contents),
        proposedContents: contents,
      },
    };
  });

  ctx.tools.register("wiki_list_sources", {
    displayName: "List Wiki Sources",
    description: "Return captured raw source metadata from the plugin index.",
    parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "wiki_list_sources")?.parametersSchema ?? { type: "object" },
  }, async (params: unknown): Promise<ToolResult> => {
    const input = params as ToolParams;
    const companyId = requireString(input.companyId, "companyId");
    const wikiId = normalizeWikiId(input.wikiId);
    const space = await resolveSpace(ctx, { companyId, wikiId, spaceSlug: input.spaceSlug as string | null | undefined });
    const limit = normalizeLimit(input.limit, 50, 200);
    const rows = await ctx.db.query<{ raw_path: string; title: string | null; source_type: string; url: string | null; content_hash: string }>(
      `SELECT raw_path, title, source_type, url, content_hash
         FROM ${tableName(ctx.db.namespace, "wiki_sources")}
        WHERE company_id = $1 AND wiki_id = $2 AND space_id = $4
        ORDER BY created_at DESC
        LIMIT $3`,
      [companyId, wikiId, limit, space.id],
    );
    return {
      content: rows.length ? rows.map((row) => `${row.raw_path}${row.title ? ` - ${row.title}` : ""}`).join("\n") : "No sources captured yet.",
      data: { companyId, wikiId, spaceSlug: space.slug, sources: rows },
    };
  });

  ctx.tools.register("wiki_read_source", {
    displayName: "Read Wiki Source",
    description: "Read a captured raw source from the configured local wiki root.",
    parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "wiki_read_source")?.parametersSchema ?? { type: "object" },
  }, async (params: unknown): Promise<ToolResult> => {
    const input = params as ToolParams;
    const companyId = requireString(input.companyId, "companyId");
    const wikiId = normalizeWikiId(input.wikiId);
    const space = await resolveSpace(ctx, { companyId, wikiId, spaceSlug: input.spaceSlug as string | null | undefined });
    const rawPath = assertRawPath(requireString(input.rawPath, "rawPath"));
    const contents = await ctx.localFolders.readText(companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, rawPath));
    return { content: contents, data: { companyId, wikiId, spaceSlug: space.slug, rawPath, hash: contentHash(contents) } };
  });

  ctx.tools.register("wiki_append_log", {
    displayName: "Append Wiki Log",
    description: "Append a maintenance note to wiki/log.md.",
    parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "wiki_append_log")?.parametersSchema ?? { type: "object" },
  }, async (params: unknown): Promise<ToolResult> => {
    const input = params as ToolParams;
    const result = await appendWikiLog(ctx, {
      companyId: requireString(input.companyId, "companyId"),
      wikiId: stringField(input.wikiId),
      spaceSlug: input.spaceSlug as string | null | undefined,
      entry: requireString(input.entry, "entry"),
    });
    return { content: "Appended log entry", data: { companyId: requireString(input.companyId, "companyId"), wikiId: result.wikiId, spaceSlug: result.spaceSlug, hash: result.hash } };
  });

  ctx.tools.register("wiki_update_index", {
    displayName: "Update Wiki Index",
    description: "Atomically replace wiki/index.md with optional hash conflict checks.",
    parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "wiki_update_index")?.parametersSchema ?? { type: "object" },
  }, async (params: unknown): Promise<ToolResult> => {
    const input = params as ToolParams;
    const result = await writeWikiPage(ctx, {
      companyId: requireString(input.companyId, "companyId"),
      wikiId: stringField(input.wikiId),
      spaceSlug: stringField(input.spaceSlug),
      path: "wiki/index.md",
      contents: requireString(input.contents, "contents"),
      expectedHash: stringField(input.expectedHash),
      summary: "Update index",
    });
    return { content: "Updated wiki/index.md", data: result };
  });

  ctx.tools.register("wiki_list_backlinks", {
    displayName: "List Wiki Backlinks",
    description: "Return indexed backlinks for a wiki page.",
    parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "wiki_list_backlinks")?.parametersSchema ?? { type: "object" },
  }, async (params: unknown): Promise<ToolResult> => {
    const input = params as ToolParams;
    const companyId = requireString(input.companyId, "companyId");
    const wikiId = normalizeWikiId(input.wikiId);
    const space = await resolveSpace(ctx, { companyId, wikiId, spaceSlug: input.spaceSlug as string | null | undefined });
    const path = assertPagePath(requireString(input.path, "path"));
    const rows = await ctx.db.query<{ path: string; title: string | null }>(
      `SELECT path, title
         FROM ${tableName(ctx.db.namespace, "wiki_pages")}
        WHERE company_id = $1 AND wiki_id = $2 AND space_id = $4 AND backlinks ? $3
        ORDER BY path
        LIMIT 200`,
      [companyId, wikiId, path, space.id],
    );
    return {
      content: rows.length ? rows.map((row) => `${row.path}${row.title ? ` - ${row.title}` : ""}`).join("\n") : "No backlinks indexed.",
      data: { companyId, wikiId, spaceSlug: space.slug, path, backlinks: rows },
    };
  });

  ctx.tools.register("wiki_list_pages", {
    displayName: "List Wiki Pages",
    description: "Return the known page index from plugin metadata.",
    parametersSchema: ctx.manifest.tools?.find((tool) => tool.name === "wiki_list_pages")?.parametersSchema ?? { type: "object" },
  }, async (params: unknown): Promise<ToolResult> => {
    const input = params as ToolParams;
    const companyId = requireString(input.companyId, "companyId");
    const wikiId = normalizeWikiId(input.wikiId);
    const space = await resolveSpace(ctx, { companyId, wikiId, spaceSlug: input.spaceSlug as string | null | undefined });
    const rows = await ctx.db.query<{ path: string; title: string | null; page_type: string | null }>(
      `SELECT path, title, page_type FROM ${tableName(ctx.db.namespace, "wiki_pages")} WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 ORDER BY path LIMIT 200`,
      [companyId, wikiId, space.id],
    );
    return {
      content: rows.length ? rows.map((row) => `${row.path}${row.title ? ` - ${row.title}` : ""}`).join("\n") : "No pages indexed yet.",
      data: { companyId, wikiId, spaceSlug: space.slug, pages: rows },
    };
  });
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function tokenizeWikiQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return [...new Set(tokens)].slice(0, 8);
}

function createWikiSnippet(body: string, query: string, tokens: string[]): string | null {
  const plain = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_~|`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  const lower = plain.toLowerCase();
  const needles = [query.toLowerCase().trim(), ...tokens].filter((needle) => needle.length > 0);
  let index = -1;
  for (const needle of needles) {
    index = lower.indexOf(needle);
    if (index >= 0) break;
  }
  if (index < 0) index = 0;
  const start = Math.max(0, index - 80);
  const snippet = plain.slice(start, start + 240).trim();
  if (!snippet) return null;
  return `${start > 0 ? "…" : ""}${snippet}${start + 240 < plain.length ? "…" : ""}`;
}

export type WikiSearchResult = {
  kind: "page" | "source";
  wikiId: string;
  spaceSlug: string;
  spaceDisplayName: string;
  projectId: string | null;
  path: string;
  title: string | null;
  score: number;
  snippet: string | null;
  updatedAt: string | null;
};

type WikiSearchDocumentRow = {
  doc_kind: string;
  path: string;
  title: string | null;
  body_text: string;
  updated_at: string | null;
  space_slug: string;
  space_display_name: string;
  project_id: string | null;
  score: number | string;
};

// Body search over wiki_search_documents using the same lexical recipe as core
// company search (lower LIKE + per-token unnest + pg_trgm similarity, CASE score).
export async function searchWikiDocuments(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  query: string;
  limit?: number | null;
}): Promise<{ results: WikiSearchResult[] }> {
  const wikiId = normalizeWikiId(input.wikiId);
  const query = stringField(input.query);
  if (!query) return { results: [] };
  const limit = normalizeLimit(input.limit, 20, 50);
  const normalizedQuery = query.toLowerCase().trim();
  const escapedQuery = escapeLikePattern(normalizedQuery);
  const containsPattern = `%${escapedQuery}%`;
  const startsPattern = `${escapedQuery}%`;
  const tokens = tokenizeWikiQuery(query).map(escapeLikePattern);
  const space = stringField(input.spaceSlug)
    ? await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug })
    : null;

  const tokenMatch = (expression: string) =>
    `EXISTS (
       SELECT 1 FROM unnest($6::text[]) AS search_token(value)
       WHERE lower(coalesce(${expression}, '')) LIKE '%' || search_token.value || '%' ESCAPE '\\'
     )`;
  const searchText = `coalesce(d.title, '') || ' ' || d.body_text`;
  const scopeClause = space ? "AND d.space_id = $8" : "AND s.access_scope = 'shared'";
  const params: unknown[] = [input.companyId, wikiId, containsPattern, startsPattern, normalizedQuery, tokens, limit];
  if (space) params.push(space.id);

  const rows = await ctx.db.query<WikiSearchDocumentRow>(
    `SELECT d.doc_kind, d.path, d.title, d.body_text, d.updated_at::text AS updated_at,
            s.slug AS space_slug, s.display_name AS space_display_name, s.project_id,
            (
              CASE WHEN lower(coalesce(d.title, '')) = $5 THEN 900 ELSE 0 END
              + CASE WHEN lower(coalesce(d.title, '')) LIKE $4 ESCAPE '\\' THEN 550 ELSE 0 END
              + CASE WHEN lower(coalesce(d.title, '')) LIKE $3 ESCAPE '\\' THEN 350 ELSE 0 END
              + CASE WHEN lower(d.body_text) LIKE $3 ESCAPE '\\' THEN 170 ELSE 0 END
              + CASE WHEN ${tokenMatch(searchText)} THEN 260 ELSE 0 END
              + CASE WHEN similarity(lower(coalesce(d.title, '')), $5) >= 0.45 THEN 110 ELSE 0 END
            )::double precision AS score
       FROM ${tableName(ctx.db.namespace, "wiki_search_documents")} d
       JOIN ${spaceTable(ctx)} s ON s.id = d.space_id
      WHERE d.company_id = $1 AND d.wiki_id = $2
        AND s.status <> 'archived'
        ${scopeClause}
        AND (
          lower(coalesce(d.title, '')) LIKE $3 ESCAPE '\\'
          OR lower(d.body_text) LIKE $3 ESCAPE '\\'
          OR ${tokenMatch(searchText)}
          OR similarity(lower(coalesce(d.title, '')), $5) >= 0.45
        )
      ORDER BY score DESC, d.updated_at DESC
      LIMIT $7`,
    params,
  );

  const results = rows.map((row): WikiSearchResult => ({
    kind: row.doc_kind === "source" ? "source" : "page",
    wikiId,
    spaceSlug: row.space_slug,
    spaceDisplayName: row.space_display_name,
    projectId: row.project_id ?? null,
    path: row.path,
    title: row.title,
    score: typeof row.score === "number" ? row.score : Number(row.score ?? 0),
    snippet: createWikiSnippet(row.body_text ?? "", normalizedQuery, tokens),
    updatedAt: row.updated_at ?? null,
  }));
  return { results };
}

export async function appendWikiLog(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  entry: string;
  author?: WikiWriteAuthor | null;
}) {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const entry = stringField(input.entry);
  if (!entry) throw new Error("entry is required");
  let current = "";
  try {
    current = await ctx.localFolders.readText(input.companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, "wiki/log.md"));
  } catch {
    current = "# Log\n\nAppend-only chronological record of wiki operations.\n";
  }
  const next = `${current.trimEnd()}\n\n- ${new Date().toISOString()} ${entry}\n`;
  await ctx.localFolders.writeTextAtomic(input.companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, "wiki/log.md"), next);
  await upsertPageMetadata(ctx, {
    companyId: input.companyId,
    wikiId,
    spaceId: space.id,
    path: "wiki/log.md",
    contents: next,
    summary: "Append log entry",
    author: input.author ?? null,
  });
  return { status: "ok" as const, wikiId, spaceSlug: space.slug, hash: contentHash(next) };
}

const SPACE_INDEX_MAX_CHARS = 4000;

export async function readSpaceIndex(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
}) {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  try {
    const contents = await ctx.localFolders.readText(input.companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, "wiki/index.md"));
    return {
      wikiId,
      spaceSlug: space.slug,
      spaceDisplayName: space.displayName,
      projectId: space.projectId,
      path: "wiki/index.md",
      contents: contents.slice(0, SPACE_INDEX_MAX_CHARS),
      truncated: contents.length > SPACE_INDEX_MAX_CHARS,
    };
  } catch {
    return {
      wikiId,
      spaceSlug: space.slug,
      spaceDisplayName: space.displayName,
      projectId: space.projectId,
      path: "wiki/index.md",
      contents: null,
      truncated: false,
    };
  }
}

export async function reindexWikiSearch(ctx: PluginContext, input: { companyId: string; wikiId?: string | null }) {
  const wikiId = normalizeWikiId(input.wikiId);
  const startedAt = new Date().toISOString();
  const { spaces } = await listSpaces(ctx, { companyId: input.companyId, wikiId });
  const summary = {
    status: "ok" as const,
    wikiId,
    spaces: 0,
    pages: 0,
    sources: 0,
    removed: 0,
    warnings: [] as string[],
  };
  for (const space of spaces) {
    summary.spaces += 1;
    const seen = new Set<string>();
    const pageEntries = await listLocalFiles(ctx, { companyId: input.companyId, space, relativePath: "wiki" });
    for (const entry of pageEntries) {
      if (!entry.path.endsWith(".md")) continue;
      try {
        const contents = await ctx.localFolders.readText(input.companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, entry.path));
        const hash = contentHash(contents);
        seen.add(`page:${entry.path}`);
        const rows = await ctx.db.query<{ content_hash: string | null }>(
          `SELECT content_hash FROM ${tableName(ctx.db.namespace, "wiki_pages")}
            WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND path = $4
            LIMIT 1`,
          [input.companyId, wikiId, space.id, entry.path],
        );
        if (rows[0]?.content_hash === hash) {
          await upsertSearchDocument(ctx, {
            companyId: input.companyId,
            wikiId,
            spaceId: space.id,
            docKind: "page",
            path: entry.path,
            title: inferTitle(entry.path, contents),
            contents,
            contentHash: hash,
          });
        } else {
          await upsertPageMetadata(ctx, {
            companyId: input.companyId,
            wikiId,
            spaceId: space.id,
            path: entry.path,
            contents,
            summary: "Search reindex",
            author: { kind: "plugin" },
          });
        }
        summary.pages += 1;
      } catch (error) {
        summary.warnings.push(`${space.slug}/${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const rawEntries = await listLocalFiles(ctx, { companyId: input.companyId, space, relativePath: "raw" });
    for (const entry of rawEntries) {
      if (!entry.path.endsWith(".md")) continue;
      try {
        const contents = await ctx.localFolders.readText(input.companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, entry.path));
        seen.add(`source:${entry.path}`);
        await upsertSearchDocument(ctx, {
          companyId: input.companyId,
          wikiId,
          spaceId: space.id,
          docKind: "source",
          path: entry.path,
          title: inferTitle(entry.path, contents),
          contents,
          contentHash: contentHash(contents),
        });
        summary.sources += 1;
      } catch (error) {
        summary.warnings.push(`${space.slug}/${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const docRows = await ctx.db.query<{ doc_kind: string; path: string }>(
      `SELECT doc_kind, path FROM ${tableName(ctx.db.namespace, "wiki_search_documents")}
        WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3`,
      [input.companyId, wikiId, space.id],
    );
    for (const row of docRows) {
      if (seen.has(`${row.doc_kind}:${row.path}`)) continue;
      // updated_at guard: a doc upserted after this reindex started belongs to
      // a concurrent write whose file simply postdates our directory listing.
      await ctx.db.execute(
        `DELETE FROM ${tableName(ctx.db.namespace, "wiki_search_documents")}
          WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND doc_kind = $4 AND path = $5
            AND updated_at < $6::timestamptz`,
        [input.companyId, wikiId, space.id, row.doc_kind, row.path, startedAt],
      );
      summary.removed += 1;
    }
  }
  return summary;
}

export function readCompanyIdFromParams(params: Record<string, unknown>): string {
  return requireString(params.companyId, "companyId");
}

const TEMPLATE_FILES = ["AGENTS.md", "IDEA.md"] as const;
type WikiTemplateFile = (typeof TEMPLATE_FILES)[number];

function isTemplateFile(value: string): value is WikiTemplateFile {
  return (TEMPLATE_FILES as readonly string[]).includes(value);
}

export type WikiPageRow = {
  path: string;
  title: string | null;
  pageType: string | null;
  links: string[];
  backlinkCount: number;
  sourceCount: number;
  contentHash: string | null;
  updatedAt: string;
};

export type WikiSourceRow = {
  rawPath: string;
  title: string | null;
  sourceType: string;
  url: string | null;
  status: string;
  createdAt: string;
};

const LOCAL_BROWSE_FILE_LIMIT = 2000;
const KNOWLEDGE_GRAPH_DEFAULT_LIMIT = 360;
const KNOWLEDGE_GRAPH_MAX_LIMIT = 800;
const KNOWLEDGE_GRAPH_PROJECT_LIMIT = 36;
const KNOWLEDGE_GRAPH_WIKI_PAGE_LIMIT = 280;
const KNOWLEDGE_GRAPH_SOURCE_LIMIT = 120;
const KNOWLEDGE_GRAPH_DOCUMENT_LIMIT = 220;
const KNOWLEDGE_GRAPH_WORK_PRODUCT_LIMIT = 160;
const KNOWLEDGE_GRAPH_REFERENCE_EDGE_LIMIT = 900;

export type KnowledgeGraphNodeKind =
  | "company"
  | "space"
  | "project"
  | "wiki_page"
  | "source"
  | "issue"
  | "agent"
  | "document"
  | "work_product";

export type KnowledgeGraphEdgeKind =
  | "contains"
  | "project_issue"
  | "wiki_link"
  | "source_ref"
  | "assigned_to"
  | "parent_child"
  | "blocks"
  | "mentions"
  | "documents"
  | "produces";

export type KnowledgeGraphNode = {
  id: string;
  kind: KnowledgeGraphNodeKind;
  label: string;
  sublabel: string | null;
  status: string | null;
  group: string | null;
  href: string | null;
  weight: number;
  updatedAt: string | null;
  metadata: Record<string, unknown>;
};

export type KnowledgeGraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: KnowledgeGraphEdgeKind;
  label: string | null;
  weight: number;
  metadata: Record<string, unknown>;
};

export type KnowledgeGraphData = {
  status: "ok";
  checkedAt: string;
  wikiId: string;
  space: Pick<WikiSpace, "id" | "slug" | "displayName" | "bindingKind" | "projectId">;
  scope: {
    kind: "project" | "company";
    projectId: string | null;
    projectName: string | null;
  };
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  stats: {
    nodes: number;
    edges: number;
    wikiPages: number;
    issues: number;
    projects: number;
    agents: number;
    documents: number;
    workProducts: number;
    references: number;
  };
  warnings: string[];
};

type KnowledgeProjectRow = {
  id: string;
  name: string;
  status: string | null;
  color: string | null;
  updated_at: string | null;
  issue_count: string | number | null;
};

type KnowledgeIssueRow = {
  id: string;
  project_id: string | null;
  parent_id: string | null;
  title: string;
  status: string | null;
  priority: string | null;
  identifier: string | null;
  assignee_agent_id: string | null;
  updated_at: string | null;
};

type KnowledgeAgentRow = {
  id: string;
  name: string;
  role: string | null;
  status: string | null;
  icon: string | null;
  updated_at: string | null;
};

type KnowledgeDocumentRow = {
  id: string;
  issue_id: string;
  key: string;
  document_id: string | null;
  updated_at: string | null;
};

type KnowledgeWorkProductRow = {
  id: string;
  issue_id: string;
  type: string | null;
  title: string | null;
  status: string | null;
  health_status: string | null;
  updated_at: string | null;
};

function graphId(kind: KnowledgeGraphNodeKind, id: string): string {
  return `${kind}:${id}`;
}

function parseCount(value: string | number | null | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function graphSqlPlaceholders(startIndex: number, count: number): string {
  return Array.from({ length: count }, (_, index) => `$${startIndex + index}`).join(", ");
}

function truncateLabel(value: string, max = 96): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function addGraphNode(nodes: Map<string, KnowledgeGraphNode>, node: KnowledgeGraphNode) {
  const existing = nodes.get(node.id);
  if (!existing) {
    nodes.set(node.id, node);
    return;
  }
  nodes.set(node.id, {
    ...existing,
    weight: Math.max(existing.weight, node.weight),
    metadata: { ...existing.metadata, ...node.metadata },
  });
}

function addGraphEdge(
  edges: Map<string, KnowledgeGraphEdge>,
  nodes: Map<string, KnowledgeGraphNode>,
  edge: Omit<KnowledgeGraphEdge, "id"> & { id?: string },
) {
  if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) return;
  const id = edge.id ?? `${edge.kind}:${edge.from}->${edge.to}`;
  const existing = edges.get(id);
  if (existing) {
    edges.set(id, { ...existing, weight: Math.max(existing.weight, edge.weight) });
    return;
  }
  edges.set(id, { ...edge, id });
}

async function safeKnowledgeGraphQuery<T>(
  ctx: PluginContext,
  warnings: string[],
  label: string,
  query: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await query();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.warn("LLM Wiki knowledge graph skipped optional query", { label, error: message });
    warnings.push(`Skipped ${label}; optional graph details are unavailable.`);
    return [];
  }
}

function sourceRefField(ref: unknown, field: string): string | null {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  const value = (ref as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function publicIssueHref(issue: Pick<KnowledgeIssueRow, "id" | "identifier">): string {
  return `/issues/${encodeURIComponent(issue.identifier ?? issue.id)}`;
}

function projectHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/issues`;
}

function agentHref(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}`;
}

function knowledgeWikiGroupForPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (path.startsWith("raw/")) return "raw";
  if (parts[0] === "wiki" && parts[1]) return parts[1];
  return parts[0] ?? "wiki";
}

export type WikiOperationRow = {
  id: string;
  operationType: string;
  status: string;
  hiddenIssueId: string | null;
  hiddenIssueIdentifier: string | null;
  hiddenIssueTitle: string | null;
  hiddenIssueStatus: string | null;
  projectId: string | null;
  runIds: unknown[];
  costCents: number;
  warnings: unknown[];
  affectedPages: unknown[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export async function listPages(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  pageType?: string | null;
  includeRaw?: boolean;
  limit?: number | null;
}): Promise<{ pages: WikiPageRow[]; sources: WikiSourceRow[] }> {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const limit = normalizeLimit(input.limit, 500, LOCAL_BROWSE_FILE_LIMIT);
  const params: unknown[] = [input.companyId, wikiId, space.id];
  let pageFilter = "";
  if (input.pageType) {
    params.push(input.pageType);
    pageFilter = ` AND page_type = $${params.length}`;
  }
  params.push(limit);
  const limitIndex = params.length;
  const pageRows = await ctx.db.query<{
    path: string;
    title: string | null;
    page_type: string | null;
    backlinks: unknown;
    source_refs: unknown;
    content_hash: string | null;
    updated_at: string;
  }>(
    `SELECT path, title, page_type, backlinks, source_refs, content_hash, updated_at::text AS updated_at
       FROM ${tableName(ctx.db.namespace, "wiki_pages")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3${pageFilter}
      ORDER BY path
      LIMIT $${limitIndex}`,
    params,
  );
  const readablePageRows = await filterReadableRows(ctx, input.companyId, space, pageRows, (row) => row.path);
  const pages: WikiPageRow[] = readablePageRows.map((row) => ({
    path: row.path,
    title: row.title,
    pageType: row.page_type,
    links: Array.isArray(row.backlinks) ? row.backlinks.filter((link): link is string => typeof link === "string") : [],
    backlinkCount: Array.isArray(row.backlinks) ? row.backlinks.length : 0,
    sourceCount: Array.isArray(row.source_refs) ? row.source_refs.length : 0,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
  }));
  let pagesWithLocalFiles = pages;
  if (!input.pageType) {
    const wikiFiles = await listLocalFiles(ctx, { companyId: input.companyId, space, relativePath: "wiki" });
    pagesWithLocalFiles = mergeLocalPageRows(pages, wikiFiles);
  }

  let sources: WikiSourceRow[] = [];
  if (input.includeRaw) {
    sources = (await listSources(ctx, { companyId: input.companyId, wikiId, spaceSlug: space.slug, limit, onlyReadable: true })).sources;
    sources = mergeLocalSourceRows(sources, await listLocalFiles(ctx, { companyId: input.companyId, space, relativePath: "raw" }));
  }
  return { pages: pagesWithLocalFiles, sources };
}

export async function listSources(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  limit?: number | null;
  onlyReadable?: boolean;
}): Promise<{ sources: WikiSourceRow[] }> {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const limit = normalizeLimit(input.limit, 500, LOCAL_BROWSE_FILE_LIMIT);
  const rows = await ctx.db.query<{ raw_path: string; title: string | null; source_type: string; url: string | null; status: string; created_at: string }>(
    `SELECT raw_path, title, source_type, url, status, created_at::text AS created_at
       FROM ${tableName(ctx.db.namespace, "wiki_sources")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $4
      ORDER BY created_at DESC
      LIMIT $3`,
    [input.companyId, wikiId, limit, space.id],
  );
  const sourceRows = input.onlyReadable
    ? await filterReadableRows(ctx, input.companyId, space, rows, (row) => row.raw_path)
    : rows;
  return {
    sources: sourceRows.map((row) => ({
      rawPath: row.raw_path,
      title: row.title,
      sourceType: row.source_type,
      url: row.url,
      status: row.status,
      createdAt: row.created_at,
    })),
  };
}

export async function getKnowledgeGraph(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  limit?: number | null;
}): Promise<KnowledgeGraphData> {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const limit = normalizeLimit(input.limit, KNOWLEDGE_GRAPH_DEFAULT_LIMIT, KNOWLEDGE_GRAPH_MAX_LIMIT);
  const projectScopeId = space.bindingKind === "project" ? space.projectId : null;
  const warnings: string[] = [];
  const nodes = new Map<string, KnowledgeGraphNode>();
  const edges = new Map<string, KnowledgeGraphEdge>();

  const companyRows = await ctx.db.query<{ id: string; name: string; updated_at: string | null }>(
    `SELECT id, name, updated_at::text AS updated_at FROM companies WHERE id = $1 LIMIT 1`,
    [input.companyId],
  );
  const company = companyRows[0] ?? { id: input.companyId, name: "Company", updated_at: null };
  const companyNodeId = graphId("company", input.companyId);
  const spaceNodeId = graphId("space", space.id);

  addGraphNode(nodes, {
    id: companyNodeId,
    kind: "company",
    label: company.name,
    sublabel: "Company",
    status: null,
    group: "company",
    href: "/dashboard",
    weight: 12,
    updatedAt: company.updated_at,
    metadata: { companyId: input.companyId },
  });
  addGraphNode(nodes, {
    id: spaceNodeId,
    kind: "space",
    label: space.displayName,
    sublabel: space.slug,
    status: space.status,
    group: "wiki",
    href: space.slug === DEFAULT_SPACE_SLUG ? "/wiki" : `/wiki/spaces/${encodeURIComponent(space.slug)}`,
    weight: 9,
    updatedAt: space.updatedAt,
    metadata: { spaceId: space.id, spaceSlug: space.slug, bindingKind: space.bindingKind, projectId: space.projectId },
  });
  addGraphEdge(edges, nodes, {
    from: companyNodeId,
    to: spaceNodeId,
    kind: "contains",
    label: "wiki space",
    weight: 2,
    metadata: {},
  });

  const projectRows = projectScopeId
    ? await ctx.db.query<KnowledgeProjectRow>(
        `SELECT id, name, status, color, updated_at::text AS updated_at, 0::text AS issue_count
           FROM projects
          WHERE company_id = $1 AND id = $2
          LIMIT 1`,
        [input.companyId, projectScopeId],
      )
    : await ctx.db.query<KnowledgeProjectRow>(
        `SELECT p.id, p.name, p.status, p.color, p.updated_at::text AS updated_at, count(i.id)::text AS issue_count
           FROM projects p
           LEFT JOIN issues i ON i.company_id = p.company_id AND i.project_id = p.id AND i.hidden_at IS NULL
          WHERE p.company_id = $1 AND p.archived_at IS NULL
          GROUP BY p.id
          ORDER BY count(i.id) DESC, p.updated_at DESC NULLS LAST
          LIMIT $2`,
        [input.companyId, KNOWLEDGE_GRAPH_PROJECT_LIMIT],
      );

  for (const project of projectRows) {
    const nodeId = graphId("project", project.id);
    addGraphNode(nodes, {
      id: nodeId,
      kind: "project",
      label: project.name,
      sublabel: "Project",
      status: project.status,
      group: "projects",
      href: projectHref(project.id),
      weight: Math.max(4, Math.min(12, 4 + parseCount(project.issue_count) / 90)),
      updatedAt: project.updated_at,
      metadata: { projectId: project.id, color: project.color, issueCount: parseCount(project.issue_count) },
    });
    addGraphEdge(edges, nodes, {
      from: companyNodeId,
      to: nodeId,
      kind: "contains",
      label: "project",
      weight: 1.4,
      metadata: {},
    });
    if (project.id === projectScopeId) {
      addGraphEdge(edges, nodes, {
        from: spaceNodeId,
        to: nodeId,
        kind: "contains",
        label: "project space",
        weight: 2.4,
        metadata: {},
      });
    }
  }

  const issueParams: unknown[] = [input.companyId];
  let issueWhere = "i.company_id = $1 AND i.hidden_at IS NULL";
  if (projectScopeId) {
    issueParams.push(projectScopeId);
    issueWhere += ` AND i.project_id = $${issueParams.length}`;
  } else if (projectRows.length > 0) {
    const projectIds = projectRows.map((project) => project.id);
    const projectPlaceholders = graphSqlPlaceholders(issueParams.length + 1, projectIds.length);
    issueParams.push(...projectIds);
    issueWhere += ` AND (i.project_id IN (${projectPlaceholders}) OR i.status IN ('blocked', 'in_progress', 'in_review'))`;
  }
  issueParams.push(limit);
  const issueRows = await ctx.db.query<KnowledgeIssueRow>(
    `SELECT i.id,
            i.project_id,
            i.parent_id,
            i.title,
            i.status,
            i.priority,
            i.identifier,
            i.assignee_agent_id,
            i.updated_at::text AS updated_at
       FROM issues i
      WHERE ${issueWhere}
      ORDER BY CASE i.status
                 WHEN 'blocked' THEN 0
                 WHEN 'in_progress' THEN 1
                 WHEN 'in_review' THEN 2
                 WHEN 'todo' THEN 3
                 WHEN 'done' THEN 4
                 ELSE 5
               END,
               i.updated_at DESC NULLS LAST
      LIMIT $${issueParams.length}`,
    issueParams,
  );

  const knownProjectIds = new Set(projectRows.map((project) => project.id));
  const missingProjectIds = [...new Set(issueRows.map((issue) => issue.project_id).filter((id): id is string => Boolean(id)))]
    .filter((id) => !knownProjectIds.has(id));
  if (missingProjectIds.length > 0) {
    const extraProjectParams: unknown[] = [input.companyId, ...missingProjectIds];
    const extraProjects = await ctx.db.query<KnowledgeProjectRow>(
      `SELECT id, name, status, color, updated_at::text AS updated_at, 0::text AS issue_count
         FROM projects
        WHERE company_id = $1 AND id IN (${graphSqlPlaceholders(2, missingProjectIds.length)})`,
      extraProjectParams,
    );
    for (const project of extraProjects) {
      const nodeId = graphId("project", project.id);
      addGraphNode(nodes, {
        id: nodeId,
        kind: "project",
        label: project.name,
        sublabel: "Project",
        status: project.status,
        group: "projects",
        href: projectHref(project.id),
        weight: 4,
        updatedAt: project.updated_at,
        metadata: { projectId: project.id, color: project.color },
      });
      addGraphEdge(edges, nodes, {
        from: companyNodeId,
        to: nodeId,
        kind: "contains",
        label: "project",
        weight: 1.2,
        metadata: {},
      });
    }
  }

  const issueIds = issueRows.map((issue) => issue.id);
  for (const issue of issueRows) {
    const issueNodeId = graphId("issue", issue.id);
    addGraphNode(nodes, {
      id: issueNodeId,
      kind: "issue",
      label: truncateLabel(issue.title || issue.identifier || issue.id),
      sublabel: issue.identifier,
      status: issue.status,
      group: issue.project_id ?? "issues",
      href: publicIssueHref(issue),
      weight: issue.status === "blocked" ? 7 : issue.status === "in_progress" ? 6 : 4.5,
      updatedAt: issue.updated_at,
      metadata: {
        issueId: issue.id,
        projectId: issue.project_id,
        parentId: issue.parent_id,
        priority: issue.priority,
        identifier: issue.identifier,
      },
    });
    if (issue.project_id) {
      addGraphEdge(edges, nodes, {
        from: graphId("project", issue.project_id),
        to: issueNodeId,
        kind: "project_issue",
        label: "issue",
        weight: 1.3,
        metadata: {},
      });
    } else {
      addGraphEdge(edges, nodes, {
        from: companyNodeId,
        to: issueNodeId,
        kind: "contains",
        label: "issue",
        weight: 0.8,
        metadata: {},
      });
    }
    if (issue.parent_id) {
      addGraphEdge(edges, nodes, {
        from: graphId("issue", issue.parent_id),
        to: issueNodeId,
        kind: "parent_child",
        label: "sub-issue",
        weight: 1.8,
        metadata: {},
      });
    }
  }

  const pageRows = await ctx.db.query<{
    path: string;
    title: string | null;
    page_type: string | null;
    backlinks: unknown;
    source_refs: unknown;
    updated_at: string | null;
  }>(
    `SELECT path, title, page_type, backlinks, source_refs, updated_at::text AS updated_at
       FROM ${tableName(ctx.db.namespace, "wiki_pages")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3
      ORDER BY updated_at DESC NULLS LAST, path
      LIMIT $4`,
    [input.companyId, wikiId, space.id, KNOWLEDGE_GRAPH_WIKI_PAGE_LIMIT],
  );
  const wikiPathSet = new Set(pageRows.map((page) => page.path));
  for (const page of pageRows) {
    const nodeId = graphId("wiki_page", page.path);
    const links = Array.isArray(page.backlinks) ? page.backlinks.filter((link): link is string => typeof link === "string") : [];
    const sourceRefs = Array.isArray(page.source_refs) ? page.source_refs : [];
    addGraphNode(nodes, {
      id: nodeId,
      kind: "wiki_page",
      label: page.title ?? page.path.replace(/\.md$/, "").split("/").pop() ?? page.path,
      sublabel: page.path,
      status: null,
      group: page.page_type ?? knowledgeWikiGroupForPath(page.path),
      href: space.slug === DEFAULT_SPACE_SLUG
        ? `/wiki/page/${page.path}`
        : `/wiki/spaces/${encodeURIComponent(space.slug)}/page/${page.path}`,
      weight: Math.max(3.4, Math.min(8, 3.4 + links.length * 0.35 + sourceRefs.length * 0.45)),
      updatedAt: page.updated_at,
      metadata: { path: page.path, pageType: page.page_type, linkCount: links.length, sourceRefCount: sourceRefs.length },
    });
    addGraphEdge(edges, nodes, {
      from: spaceNodeId,
      to: nodeId,
      kind: "contains",
      label: "page",
      weight: 0.8,
      metadata: {},
    });
    if (projectScopeId && page.path.startsWith("wiki/projects/")) {
      addGraphEdge(edges, nodes, {
        from: graphId("project", projectScopeId),
        to: nodeId,
        kind: "source_ref",
        label: "project wiki",
        weight: 1.1,
        metadata: {},
      });
    }
    for (const rawLink of links) {
      const targetPath = normalizeWikiLinkTarget(rawLink);
      if (!targetPath || !wikiPathSet.has(targetPath)) continue;
      addGraphEdge(edges, nodes, {
        from: nodeId,
        to: graphId("wiki_page", targetPath),
        kind: "wiki_link",
        label: "wiki link",
        weight: 1.4,
        metadata: { target: rawLink },
      });
    }
    for (const ref of sourceRefs) {
      const issueId = sourceRefField(ref, "issueId");
      if (issueId) {
        addGraphEdge(edges, nodes, {
          from: nodeId,
          to: graphId("issue", issueId),
          kind: "source_ref",
          label: "source",
          weight: 2,
          metadata: {},
        });
      }
      const projectId = sourceRefField(ref, "projectId");
      if (projectId) {
        addGraphEdge(edges, nodes, {
          from: nodeId,
          to: graphId("project", projectId),
          kind: "source_ref",
          label: "source",
          weight: 1.7,
          metadata: {},
        });
      }
      const documentId = sourceRefField(ref, "documentId");
      if (documentId) {
        addGraphEdge(edges, nodes, {
          from: nodeId,
          to: graphId("document", documentId),
          kind: "source_ref",
          label: "source",
          weight: 1.4,
          metadata: {},
        });
      }
    }
  }

  const sourceRows = await ctx.db.query<{ raw_path: string; title: string | null; source_type: string; status: string; created_at: string | null }>(
    `SELECT raw_path, title, source_type, status, created_at::text AS created_at
       FROM ${tableName(ctx.db.namespace, "wiki_sources")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3
      ORDER BY created_at DESC NULLS LAST
      LIMIT $4`,
    [input.companyId, wikiId, space.id, KNOWLEDGE_GRAPH_SOURCE_LIMIT],
  );
  for (const source of sourceRows) {
    const nodeId = graphId("source", source.raw_path);
    addGraphNode(nodes, {
      id: nodeId,
      kind: "source",
      label: source.title ?? source.raw_path,
      sublabel: source.raw_path,
      status: source.status,
      group: "sources",
      href: space.slug === DEFAULT_SPACE_SLUG
        ? `/wiki/page/${source.raw_path}`
        : `/wiki/spaces/${encodeURIComponent(space.slug)}/page/${source.raw_path}`,
      weight: 2.8,
      updatedAt: source.created_at,
      metadata: { rawPath: source.raw_path, sourceType: source.source_type },
    });
    addGraphEdge(edges, nodes, {
      from: spaceNodeId,
      to: nodeId,
      kind: "contains",
      label: "source",
      weight: 0.7,
      metadata: {},
    });
  }

  if (issueIds.length > 0) {
    const assigneeIds = [...new Set(issueRows.map((issue) => issue.assignee_agent_id).filter((id): id is string => Boolean(id)))];
    if (assigneeIds.length > 0) {
      const agentParams: unknown[] = [input.companyId, ...assigneeIds];
      const agentRows = await ctx.db.query<KnowledgeAgentRow>(
        `SELECT id, name, role, status, icon, updated_at::text AS updated_at
           FROM agents
          WHERE company_id = $1 AND id IN (${graphSqlPlaceholders(2, assigneeIds.length)})`,
        agentParams,
      );
      for (const agent of agentRows) {
        addGraphNode(nodes, {
          id: graphId("agent", agent.id),
          kind: "agent",
          label: agent.name,
          sublabel: agent.role,
          status: agent.status,
          group: "agents",
          href: agentHref(agent.id),
          weight: 4.6,
          updatedAt: agent.updated_at,
          metadata: { agentId: agent.id, icon: agent.icon },
        });
      }
      for (const issue of issueRows) {
        if (!issue.assignee_agent_id) continue;
        addGraphEdge(edges, nodes, {
          from: graphId("agent", issue.assignee_agent_id),
          to: graphId("issue", issue.id),
          kind: "assigned_to",
          label: "assignee",
          weight: 1.5,
          metadata: {},
        });
      }
    }

    const issueIdPlaceholders = graphSqlPlaceholders(2, issueIds.length);
    const issueIdLimitIndex = issueIds.length + 2;
    const relationRows = await safeKnowledgeGraphQuery(ctx, warnings, "issue relation edges", () =>
      ctx.db.query<{ issue_id: string; related_issue_id: string; type: string; created_at: string | null }>(
        `SELECT issue_id, related_issue_id, type, created_at::text AS created_at
           FROM issue_relations
          WHERE company_id = $1
            AND (issue_id IN (${issueIdPlaceholders}) OR related_issue_id IN (${issueIdPlaceholders}))
          ORDER BY created_at DESC NULLS LAST
          LIMIT $${issueIdLimitIndex}`,
        [input.companyId, ...issueIds, KNOWLEDGE_GRAPH_REFERENCE_EDGE_LIMIT],
      ),
    );
    for (const relation of relationRows) {
      addGraphEdge(edges, nodes, {
        from: graphId("issue", relation.issue_id),
        to: graphId("issue", relation.related_issue_id),
        kind: relation.type === "blocks" ? "blocks" : "mentions",
        label: relation.type,
        weight: relation.type === "blocks" ? 2.5 : 1.4,
        metadata: { createdAt: relation.created_at },
      });
    }

    const mentionRows = await safeKnowledgeGraphQuery(ctx, warnings, "issue mention edges", () =>
      ctx.db.query<{ source_issue_id: string; target_issue_id: string; source_kind: string; count: string }>(
        `SELECT source_issue_id, target_issue_id, source_kind, count(*)::text AS count
           FROM issue_reference_mentions
          WHERE company_id = $1
            AND (source_issue_id IN (${issueIdPlaceholders}) OR target_issue_id IN (${issueIdPlaceholders}))
          GROUP BY source_issue_id, target_issue_id, source_kind
          ORDER BY count(*) DESC
          LIMIT $${issueIdLimitIndex}`,
        [input.companyId, ...issueIds, KNOWLEDGE_GRAPH_REFERENCE_EDGE_LIMIT],
      ),
    );
    for (const mention of mentionRows) {
      addGraphEdge(edges, nodes, {
        from: graphId("issue", mention.source_issue_id),
        to: graphId("issue", mention.target_issue_id),
        kind: "mentions",
        label: mention.source_kind,
        weight: Math.min(4, 1 + parseCount(mention.count) / 4),
        metadata: { sourceKind: mention.source_kind, count: parseCount(mention.count) },
      });
    }

    const documentRows = await safeKnowledgeGraphQuery(ctx, warnings, "issue document nodes", () =>
      ctx.db.query<KnowledgeDocumentRow>(
        `SELECT id, issue_id, key, document_id, updated_at::text AS updated_at
           FROM issue_documents
          WHERE company_id = $1 AND issue_id IN (${issueIdPlaceholders})
          ORDER BY updated_at DESC NULLS LAST
          LIMIT $${issueIdLimitIndex}`,
        [input.companyId, ...issueIds, KNOWLEDGE_GRAPH_DOCUMENT_LIMIT],
      ),
    );
    for (const doc of documentRows) {
      const nodeId = graphId("document", doc.id);
      addGraphNode(nodes, {
        id: nodeId,
        kind: "document",
        label: doc.key,
        sublabel: "Document",
        status: null,
        group: "documents",
        href: publicIssueHref({ id: doc.issue_id, identifier: null }),
        weight: 2.4,
        updatedAt: doc.updated_at,
        metadata: { issueId: doc.issue_id, documentId: doc.document_id, key: doc.key },
      });
      addGraphEdge(edges, nodes, {
        from: graphId("issue", doc.issue_id),
        to: nodeId,
        kind: "documents",
        label: "document",
        weight: 1,
        metadata: {},
      });
    }

    const workProductRows = await safeKnowledgeGraphQuery(ctx, warnings, "issue work product nodes", () =>
      ctx.db.query<KnowledgeWorkProductRow>(
        `SELECT id, issue_id, type, title, status, health_status, updated_at::text AS updated_at
           FROM issue_work_products
          WHERE company_id = $1 AND issue_id IN (${issueIdPlaceholders})
          ORDER BY updated_at DESC NULLS LAST
          LIMIT $${issueIdLimitIndex}`,
        [input.companyId, ...issueIds, KNOWLEDGE_GRAPH_WORK_PRODUCT_LIMIT],
      ),
    );
    for (const workProduct of workProductRows) {
      const nodeId = graphId("work_product", workProduct.id);
      addGraphNode(nodes, {
        id: nodeId,
        kind: "work_product",
        label: workProduct.title ?? workProduct.type ?? "Work product",
        sublabel: workProduct.type,
        status: workProduct.health_status ?? workProduct.status,
        group: "work-products",
        href: publicIssueHref({ id: workProduct.issue_id, identifier: null }),
        weight: 2.8,
        updatedAt: workProduct.updated_at,
        metadata: { issueId: workProduct.issue_id, type: workProduct.type },
      });
      addGraphEdge(edges, nodes, {
        from: graphId("issue", workProduct.issue_id),
        to: nodeId,
        kind: "produces",
        label: "work product",
        weight: 1.1,
        metadata: {},
      });
    }
  } else {
    warnings.push("No Paperclip issues matched this graph scope.");
  }

  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()];
  return {
    status: "ok",
    checkedAt: new Date().toISOString(),
    wikiId,
    space: {
      id: space.id,
      slug: space.slug,
      displayName: space.displayName,
      bindingKind: space.bindingKind,
      projectId: space.projectId,
    },
    scope: {
      kind: projectScopeId ? "project" : "company",
      projectId: projectScopeId,
      projectName: projectRows.find((project) => project.id === projectScopeId)?.name ?? null,
    },
    nodes: nodeList,
    edges: edgeList,
    stats: {
      nodes: nodeList.length,
      edges: edgeList.length,
      wikiPages: nodeList.filter((node) => node.kind === "wiki_page").length,
      issues: nodeList.filter((node) => node.kind === "issue").length,
      projects: nodeList.filter((node) => node.kind === "project").length,
      agents: nodeList.filter((node) => node.kind === "agent").length,
      documents: nodeList.filter((node) => node.kind === "document").length,
      workProducts: nodeList.filter((node) => node.kind === "work_product").length,
      references: edgeList.filter((edge) => edge.kind === "mentions" || edge.kind === "blocks" || edge.kind === "source_ref").length,
    },
    warnings,
  };
}

export async function readWikiPage(ctx: PluginContext, input: { companyId: string; wikiId?: string | null; spaceSlug?: string | null; path: string }) {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const path = assertWikiPath(input.path);
  let contents: string;
  try {
    contents = await ctx.localFolders.readText(input.companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, path));
  } catch (error) {
    if (BOOTSTRAP_FILES.some((file) => file.path === path)) {
      // A space row can exist before its skeleton files do (e.g. the space was
      // auto-created while the wiki root was unconfigured, or the root was
      // repointed later). Heal skeleton files on first read instead of failing.
      await bootstrapSpaceFiles(ctx, input.companyId, space);
      contents = await ctx.localFolders.readText(input.companyId, WIKI_ROOT_FOLDER_KEY, spaceRelativePath(space, path));
    } else if (isFileMissingError(error)) {
      // A normal page that was never written. Surface a clean not-found error
      // (no host filesystem path) so the documented read-before-write flow can
      // distinguish "page does not exist yet" from a real failure — GET returns
      // 404, the agent then creates the page with a POST and no expectedHash.
      throw new WikiPageNotFoundError(path);
    } else {
      throw error;
    }
  }
  const meta = await ctx.db.query<{ title: string | null; page_type: string | null; backlinks: unknown; source_refs: unknown; updated_at: string }>(
    `SELECT title, page_type, backlinks, source_refs, updated_at::text AS updated_at
       FROM ${tableName(ctx.db.namespace, "wiki_pages")}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $4 AND path = $3
      LIMIT 1`,
    [input.companyId, wikiId, path, space.id],
  );
  const row = meta[0] ?? null;
  return {
    wikiId,
    spaceSlug: space.slug,
    path,
    contents,
    title: row?.title ?? inferTitle(path, contents),
    pageType: row?.page_type ?? inferPageType(path),
    backlinks: Array.isArray(row?.backlinks) ? row?.backlinks : [],
    sourceRefs: Array.isArray(row?.source_refs) ? row?.source_refs : [],
    updatedAt: row?.updated_at ?? null,
    hash: contentHash(contents),
  };
}

export async function readTemplate(ctx: PluginContext, input: { companyId: string; path: string }) {
  if (!isTemplateFile(input.path)) {
    throw new Error(`template path must be one of ${TEMPLATE_FILES.join(", ")}`);
  }
  try {
    const contents = await ctx.localFolders.readText(input.companyId, WIKI_ROOT_FOLDER_KEY, input.path);
    return { path: input.path, contents, hash: contentHash(contents), exists: true };
  } catch (error) {
    return { path: input.path, contents: "", hash: null, exists: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function writeTemplate(ctx: PluginContext, input: { companyId: string; path: string; contents: string }) {
  if (!isTemplateFile(input.path)) {
    throw new Error(`template path must be one of ${TEMPLATE_FILES.join(", ")}`);
  }
  await ctx.localFolders.writeTextAtomic(input.companyId, WIKI_ROOT_FOLDER_KEY, input.path, input.contents);
  return { status: "ok", path: input.path, hash: contentHash(input.contents) };
}

export type DistillationCursorRow = {
  id: string;
  sourceScope: string;
  scopeKey: string;
  projectId: string | null;
  projectName: string | null;
  projectColor: string | null;
  rootIssueId: string | null;
  rootIssueIdentifier: string | null;
  rootIssueTitle: string | null;
  lastProcessedAt: string | null;
  lastObservedAt: string | null;
  pendingEventCount: number;
  lastSourceHash: string | null;
  lastSuccessfulRunId: string | null;
};

export type DistillationRunRow = {
  id: string;
  cursorId: string | null;
  workItemId: string | null;
  projectId: string | null;
  projectName: string | null;
  rootIssueId: string | null;
  rootIssueIdentifier: string | null;
  sourceWindowStart: string | null;
  sourceWindowEnd: string | null;
  sourceHash: string | null;
  status: string;
  costCents: number;
  retryCount: number;
  warnings: string[];
  metadata: Record<string, unknown>;
  operationIssueId: string | null;
  operationIssueIdentifier: string | null;
  operationIssueTitle: string | null;
  affectedPagePaths: string[];
  createdAt: string;
  updatedAt: string;
};

export type DistillationWorkItemRow = {
  id: string;
  workItemKind: string;
  status: string;
  priority: string;
  projectId: string | null;
  rootIssueId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type DistillationPageBindingRow = {
  id: string;
  pagePath: string;
  projectId: string | null;
  projectName: string | null;
  rootIssueId: string | null;
  lastAppliedSourceHash: string | null;
  lastDistillationRunId: string | null;
  lastRunStatus: string | null;
  lastRunCompletedAt: string | null;
  lastRunSourceWindowEnd: string | null;
  lastRunSourceHash: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

export type DistillationSourceSnapshotRow = {
  id: string;
  distillationRunId: string;
  sourceHash: string;
  maxCharacters: number;
  clipped: boolean;
  sourceRefs: unknown[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type DistillationOverview = {
  cursors: DistillationCursorRow[];
  runs: DistillationRunRow[];
  workItems: DistillationWorkItemRow[];
  pageBindings: DistillationPageBindingRow[];
  reviewWorkItems: DistillationWorkItemRow[];
  counts: {
    cursors: number;
    runningRuns: number;
    failedRuns24h: number;
    reviewRequired: number;
  };
};

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function affectedPagePathsFromRunMetadata(metadata: Record<string, unknown>, fallbackBindings: DistillationPageBindingRow[], runId: string): string[] {
  const explicit = jsonArray(metadata.affectedPages ?? metadata.pagePaths ?? metadata.affected_pages)
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const path = (entry as Record<string, unknown>).path;
        return typeof path === "string" ? path : null;
      }
      return null;
    })
    .filter((value): value is string => Boolean(value));
  if (explicit.length > 0) return Array.from(new Set(explicit));
  const bindings = fallbackBindings
    .filter((binding) => binding.lastDistillationRunId === runId)
    .map((binding) => binding.pagePath);
  return Array.from(new Set(bindings));
}

export async function getDistillationOverview(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  limit?: number | null;
}): Promise<DistillationOverview> {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const runLimit = normalizeLimit(input.limit ?? 25, 25, 200);
  const cursorRows = await ctx.db.query<{
    id: string;
    source_scope: string;
    scope_key: string;
    project_id: string | null;
    project_name: string | null;
    project_color: string | null;
    root_issue_id: string | null;
    root_issue_identifier: string | null;
    root_issue_title: string | null;
    last_processed_at: string | null;
    last_observed_at: string | null;
    pending_event_count: number;
    last_source_hash: string | null;
    last_successful_run_id: string | null;
  }>(
    `SELECT cursor.id,
            cursor.source_scope,
            cursor.scope_key,
            cursor.project_id,
            project.name AS project_name,
            project.color AS project_color,
            cursor.root_issue_id,
            issue.identifier AS root_issue_identifier,
            issue.title AS root_issue_title,
            cursor.last_processed_at::text AS last_processed_at,
            cursor.last_observed_at::text AS last_observed_at,
            cursor.pending_event_count,
            cursor.last_source_hash,
            cursor.last_successful_run_id
       FROM ${distillationCursorTable(ctx)} cursor
       LEFT JOIN public.projects project ON project.id = cursor.project_id
       LEFT JOIN public.issues issue ON issue.id = cursor.root_issue_id
      WHERE cursor.company_id = $1 AND cursor.wiki_id = $2 AND cursor.space_id = $3
      ORDER BY cursor.updated_at DESC
      LIMIT 200`,
    [input.companyId, wikiId, space.id],
  );

  const runRows = await ctx.db.query<{
    id: string;
    cursor_id: string | null;
    work_item_id: string | null;
    project_id: string | null;
    project_name: string | null;
    root_issue_id: string | null;
    root_issue_identifier: string | null;
    source_window_start: string | null;
    source_window_end: string | null;
    source_hash: string | null;
    status: string;
    cost_cents: number;
    retry_count: number;
    warnings: unknown;
    metadata: unknown;
    operation_issue_id: string | null;
    operation_issue_identifier: string | null;
    operation_issue_title: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT run.id,
            run.cursor_id,
            run.work_item_id,
            run.project_id,
            project.name AS project_name,
            run.root_issue_id,
            root_issue.identifier AS root_issue_identifier,
            run.source_window_start::text AS source_window_start,
            run.source_window_end::text AS source_window_end,
            run.source_hash,
            run.status,
            run.cost_cents,
            run.retry_count,
            run.warnings,
            run.metadata,
            run.operation_issue_id,
            op_issue.identifier AS operation_issue_identifier,
            op_issue.title AS operation_issue_title,
            run.created_at::text AS created_at,
            run.updated_at::text AS updated_at
       FROM ${distillationRunTable(ctx)} run
       LEFT JOIN public.projects project ON project.id = run.project_id
       LEFT JOIN public.issues root_issue ON root_issue.id = run.root_issue_id
       LEFT JOIN public.issues op_issue ON op_issue.id = run.operation_issue_id
      WHERE run.company_id = $1 AND run.wiki_id = $2 AND run.space_id = $4
      ORDER BY run.created_at DESC
      LIMIT $3`,
    [input.companyId, wikiId, runLimit, space.id],
  );

  const workItemRows = await ctx.db.query<{
    id: string;
    work_item_kind: string;
    status: string;
    priority: string;
    project_id: string | null;
    root_issue_id: string | null;
    metadata: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, work_item_kind, status, priority, project_id, root_issue_id, metadata,
            created_at::text AS created_at, updated_at::text AS updated_at
       FROM ${distillationWorkItemTable(ctx)}
      WHERE company_id = $1 AND wiki_id = $2 AND space_id = $3 AND status IN ('pending', 'review_required', 'in_progress', 'failed')
      ORDER BY created_at DESC
      LIMIT 100`,
    [input.companyId, wikiId, space.id],
  );

  const bindingRows = await ctx.db.query<{
    id: string;
    page_path: string;
    project_id: string | null;
    project_name: string | null;
    root_issue_id: string | null;
    last_applied_source_hash: string | null;
    last_distillation_run_id: string | null;
    last_run_status: string | null;
    last_run_completed_at: string | null;
    last_run_source_window_end: string | null;
    last_run_source_hash: string | null;
    metadata: unknown;
    updated_at: string;
  }>(
    `SELECT binding.id,
            binding.page_path,
            binding.project_id,
            project.name AS project_name,
            binding.root_issue_id,
            binding.last_applied_source_hash,
            binding.last_distillation_run_id,
            run.status::text AS last_run_status,
            run.updated_at::text AS last_run_completed_at,
            run.source_window_end::text AS last_run_source_window_end,
            run.source_hash AS last_run_source_hash,
            binding.metadata,
            binding.updated_at::text AS updated_at
       FROM ${pageBindingTable(ctx)} binding
       LEFT JOIN public.projects project ON project.id = binding.project_id
       LEFT JOIN ${distillationRunTable(ctx)} run ON run.id = binding.last_distillation_run_id
      WHERE binding.company_id = $1 AND binding.wiki_id = $2 AND binding.space_id = $3
      ORDER BY binding.updated_at DESC
      LIMIT 200`,
    [input.companyId, wikiId, space.id],
  );

  const cursors: DistillationCursorRow[] = cursorRows.map((row) => ({
    id: row.id,
    sourceScope: row.source_scope,
    scopeKey: row.scope_key,
    projectId: row.project_id,
    projectName: row.project_name,
    projectColor: row.project_color,
    rootIssueId: row.root_issue_id,
    rootIssueIdentifier: row.root_issue_identifier,
    rootIssueTitle: row.root_issue_title,
    lastProcessedAt: row.last_processed_at,
    lastObservedAt: row.last_observed_at,
    pendingEventCount: Number(row.pending_event_count ?? 0),
    lastSourceHash: row.last_source_hash,
    lastSuccessfulRunId: row.last_successful_run_id,
  }));

  const pageBindings: DistillationPageBindingRow[] = bindingRows.map((row) => ({
    id: row.id,
    pagePath: row.page_path,
    projectId: row.project_id,
    projectName: row.project_name,
    rootIssueId: row.root_issue_id,
    lastAppliedSourceHash: row.last_applied_source_hash,
    lastDistillationRunId: row.last_distillation_run_id,
    lastRunStatus: row.last_run_status,
    lastRunCompletedAt: row.last_run_completed_at,
    lastRunSourceWindowEnd: row.last_run_source_window_end,
    lastRunSourceHash: row.last_run_source_hash,
    metadata: jsonObject(row.metadata),
    updatedAt: row.updated_at,
  }));

  const runs: DistillationRunRow[] = runRows.map((row) => {
    const metadata = jsonObject(row.metadata);
    return {
      id: row.id,
      cursorId: row.cursor_id,
      workItemId: row.work_item_id,
      projectId: row.project_id,
      projectName: row.project_name,
      rootIssueId: row.root_issue_id,
      rootIssueIdentifier: row.root_issue_identifier,
      sourceWindowStart: row.source_window_start,
      sourceWindowEnd: row.source_window_end,
      sourceHash: row.source_hash,
      status: row.status,
      costCents: Number(row.cost_cents ?? 0),
      retryCount: Number(row.retry_count ?? 0),
      warnings: jsonArray(row.warnings).map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))),
      metadata,
      operationIssueId: row.operation_issue_id,
      operationIssueIdentifier: row.operation_issue_identifier,
      operationIssueTitle: row.operation_issue_title,
      affectedPagePaths: affectedPagePathsFromRunMetadata(metadata, pageBindings, row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  const workItems: DistillationWorkItemRow[] = workItemRows.map((row) => ({
    id: row.id,
    workItemKind: row.work_item_kind,
    status: row.status,
    priority: row.priority,
    projectId: row.project_id,
    rootIssueId: row.root_issue_id,
    metadata: jsonObject(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  const reviewWorkItems = workItems.filter((item) => item.status === "review_required" || item.workItemKind === "review");
  const failedSince = Date.now() - 24 * 60 * 60 * 1000;
  const failedRuns24h = runs.filter((run) => {
    if (run.status !== "failed" && run.status !== "refused_cost_cap") return false;
    const updatedAt = run.updatedAt ? Date.parse(run.updatedAt) : Number.NaN;
    return Number.isFinite(updatedAt) ? updatedAt >= failedSince : true;
  }).length;

  return {
    cursors,
    runs,
    workItems,
    pageBindings,
    reviewWorkItems,
    counts: {
      cursors: cursors.length,
      runningRuns: runs.filter((run) => run.status === "running").length,
      failedRuns24h,
      reviewRequired: reviewWorkItems.length,
    },
  };
}

export async function getDistillationPageProvenance(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  pagePath: string;
}): Promise<{
  binding: DistillationPageBindingRow | null;
  runs: DistillationRunRow[];
  snapshot: DistillationSourceSnapshotRow | null;
  cursor: DistillationCursorRow | null;
}> {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const overview = await getDistillationOverview(ctx, { companyId: input.companyId, wikiId, spaceSlug: space.slug });
  const binding = overview.pageBindings.find((row) => row.pagePath === input.pagePath) ?? null;
  if (!binding) {
    return { binding: null, runs: [], snapshot: null, cursor: null };
  }
  const relatedRuns = overview.runs.filter((run) => {
    if (binding.lastDistillationRunId === run.id) return true;
    if (binding.projectId && run.projectId === binding.projectId) return true;
    if (binding.rootIssueId && run.rootIssueId === binding.rootIssueId) return true;
    return run.affectedPagePaths.includes(binding.pagePath);
  });
  const cursor = overview.cursors.find((row) => {
    if (binding.rootIssueId && row.rootIssueId === binding.rootIssueId) return true;
    if (binding.projectId && row.projectId === binding.projectId) return true;
    return false;
  }) ?? null;

  let snapshot: DistillationSourceSnapshotRow | null = null;
  if (binding.lastDistillationRunId) {
    const snapshotRows = await ctx.db.query<{
      id: string;
      distillation_run_id: string;
      source_hash: string;
      max_characters: number;
      clipped: boolean;
      source_refs: unknown;
      metadata: unknown;
      created_at: string;
    }>(
      `SELECT id, distillation_run_id, source_hash, max_characters, clipped, source_refs, metadata, created_at::text AS created_at
         FROM ${sourceSnapshotTable(ctx)}
        WHERE company_id = $1 AND wiki_id = $2 AND space_id = $4 AND distillation_run_id = $3
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.companyId, wikiId, binding.lastDistillationRunId, space.id],
    );
    if (snapshotRows[0]) {
      const row = snapshotRows[0];
      snapshot = {
        id: row.id,
        distillationRunId: row.distillation_run_id,
        sourceHash: row.source_hash,
        maxCharacters: Number(row.max_characters ?? 0),
        clipped: Boolean(row.clipped),
        sourceRefs: jsonArray(row.source_refs),
        metadata: jsonObject(row.metadata),
        createdAt: row.created_at,
      };
    }
  }

  return { binding, runs: relatedRuns, snapshot, cursor };
}

export async function listOperations(ctx: PluginContext, input: {
  companyId: string;
  wikiId?: string | null;
  spaceSlug?: string | null;
  operationType?: string | null;
  status?: string | null;
  limit?: number | null;
}): Promise<{ operations: WikiOperationRow[] }> {
  const wikiId = normalizeWikiId(input.wikiId);
  const space = await resolveSpace(ctx, { companyId: input.companyId, wikiId, spaceSlug: input.spaceSlug });
  const limit = normalizeLimit(input.limit, 50, 500);
  const params: unknown[] = [input.companyId, wikiId, space.id];
  const filters: string[] = [];
  if (input.operationType && input.operationType !== "all") {
    params.push(input.operationType);
    filters.push(`op.operation_type = $${params.length}`);
  }
  if (input.status && input.status !== "all") {
    params.push(input.status);
    filters.push(`op.status = $${params.length}`);
  }
  params.push(limit);
  const filterSql = filters.length ? ` AND ${filters.join(" AND ")}` : "";
  const rows = await ctx.db.query<{
    id: string;
    operation_type: string;
    status: string;
    hidden_issue_id: string | null;
    hidden_issue_identifier: string | null;
    hidden_issue_title: string | null;
    hidden_issue_status: string | null;
    project_id: string | null;
    run_ids: unknown;
    cost_cents: number;
    warnings: unknown;
    affected_pages: unknown;
    metadata: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT op.id, op.operation_type, op.status, op.hidden_issue_id, op.project_id,
            op.run_ids, op.cost_cents, op.warnings, op.affected_pages, op.metadata,
            op.created_at::text AS created_at, op.updated_at::text AS updated_at,
            issue.identifier AS hidden_issue_identifier,
            issue.title AS hidden_issue_title,
            issue.status::text AS hidden_issue_status
       FROM ${tableName(ctx.db.namespace, "wiki_operations")} op
       LEFT JOIN public.issues issue ON issue.id = op.hidden_issue_id
      WHERE op.company_id = $1 AND op.wiki_id = $2 AND op.space_id = $3${filterSql}
      ORDER BY op.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return {
    operations: rows.map((row) => ({
      id: row.id,
      operationType: row.operation_type,
      status: row.status,
      hiddenIssueId: row.hidden_issue_id,
      hiddenIssueIdentifier: row.hidden_issue_identifier,
      hiddenIssueTitle: row.hidden_issue_title,
      hiddenIssueStatus: row.hidden_issue_status,
      projectId: row.project_id,
      runIds: Array.isArray(row.run_ids) ? row.run_ids : [],
      costCents: Number(row.cost_cents ?? 0),
      warnings: Array.isArray(row.warnings) ? row.warnings : [],
      affectedPages: Array.isArray(row.affected_pages) ? row.affected_pages : [],
      metadata: jsonObject(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}
