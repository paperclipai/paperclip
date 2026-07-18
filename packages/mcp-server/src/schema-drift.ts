/**
 * Schema-drift guard: MCP tool input schemas vs REST route validators.
 *
 * Every write-oriented MCP tool forwards its (validated) input as the JSON body
 * of a REST call. The REST route validates that body with a zod schema exported
 * from `@paperclipai/shared`. If the two schemas silently diverge — a field is
 * added to the REST validator but not the tool, an enum gains a member on one
 * side only, a field changes type — the tool keeps type-checking while emitting
 * requests the server rejects (or vice versa).
 *
 * This module structurally compares each tool's effective body schema against
 * the shared validator the route uses, and reports drift. It is consumed by
 * `schema-drift.test.ts` and by `scripts/check-mcp-schema-drift.mjs` (the CI
 * step). Everything imports from `@paperclipai/shared` only, so the check never
 * pulls in the server package.
 *
 * Comparison granularity (v1): structural shape — field presence, optionality,
 * nullability, base type kind, enum/literal values, array element kind, and
 * nested object shape (recursive). String/number refinements (min/max/regex)
 * are intentionally NOT compared: they frequently differ benignly between a
 * client tool and a server normalization layer, and would drown real drift in
 * noise. `.default()` is treated as making a field optional (a defaulted field
 * is omittable on input), but the presence of a default is not itself compared.
 */
import { z } from "zod";
import {
  createApprovalSchema,
  createIssueSchema,
  updateIssueSchema,
  addIssueCommentSchema,
  checkoutIssueSchema,
  upsertIssueDocumentSchema,
  linkIssueApprovalSchema,
  createIssueThreadInteractionSchema,
} from "@paperclipai/shared";
import { PaperclipApiClient } from "./client.js";
import { createToolDefinitions, type ToolDefinition } from "./tools.js";

// ---------------------------------------------------------------------------
// Structural descriptor
// ---------------------------------------------------------------------------

export interface FieldDescriptor {
  kind: string;
  optional: boolean;
  nullable: boolean;
  enumValues?: string[];
  literal?: unknown;
  element?: FieldDescriptor;
  shape?: Record<string, FieldDescriptor>;
}

interface ZodDefLike {
  typeName?: string;
  innerType?: unknown;
  schema?: unknown;
  type?: unknown;
  in?: unknown;
  out?: unknown;
  values?: unknown;
  value?: unknown;
  shape?: () => Record<string, unknown>;
  options?: unknown;
}

function defOf(schema: unknown): ZodDefLike {
  return ((schema as { _def?: ZodDefLike })?._def ?? {}) as ZodDefLike;
}

interface Unwrapped {
  core: unknown;
  optional: boolean;
  nullable: boolean;
}

/**
 * Peel the wrapper types that only affect optionality/nullability/normalization
 * so comparison lands on the semantic core type. `.default()` marks the field
 * optional; `.pipe()` uses its input schema (what the endpoint accepts on the
 * wire); `.transform()`/`.refine()` (ZodEffects) and `.brand()` are transparent.
 */
function unwrap(schema: unknown, acc: { optional: boolean; nullable: boolean } = { optional: false, nullable: false }): Unwrapped {
  const def = defOf(schema);
  switch (def.typeName) {
    case "ZodOptional":
      return unwrap(def.innerType, { ...acc, optional: true });
    case "ZodNullable":
      return unwrap(def.innerType, { ...acc, nullable: true });
    case "ZodDefault":
      return unwrap(def.innerType, { ...acc, optional: true });
    case "ZodEffects":
      return unwrap(def.schema, acc);
    case "ZodBranded":
      return unwrap(def.type, acc);
    case "ZodPipeline":
      // Validate what the wire accepts (input side of the pipe).
      return unwrap(def.in, acc);
    case "ZodReadonly":
      return unwrap(def.innerType, acc);
    default:
      return { core: schema, optional: acc.optional, nullable: acc.nullable };
  }
}

export function describe(schema: unknown): FieldDescriptor {
  const { core, optional, nullable } = unwrap(schema);
  const def = defOf(core);
  const base: FieldDescriptor = { kind: def.typeName ?? "Unknown", optional, nullable };

  switch (def.typeName) {
    case "ZodEnum":
      base.enumValues = [...((def.values as string[]) ?? [])].sort();
      break;
    case "ZodNativeEnum":
      base.enumValues = Object.values((def.values as Record<string, string>) ?? {})
        .map(String)
        .sort();
      break;
    case "ZodLiteral":
      base.literal = def.value;
      break;
    case "ZodArray":
      base.element = describe(def.type);
      break;
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : {};
      base.shape = {};
      for (const [key, value] of Object.entries(shape)) {
        base.shape[key] = describe(value);
      }
      break;
    }
    default:
      break;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export interface FieldDiff {
  path: string;
  detail: string;
}

function pushDiff(diffs: FieldDiff[], path: string, detail: string): void {
  diffs.push({ path, detail });
}

function diffField(path: string, tool: FieldDescriptor, rest: FieldDescriptor, diffs: FieldDiff[]): void {
  if (tool.kind !== rest.kind) {
    pushDiff(diffs, path, `type differs (tool=${tool.kind}, rest=${rest.kind})`);
    return; // Comparing further is meaningless once base types differ.
  }
  if (tool.optional !== rest.optional) {
    pushDiff(diffs, path, `optionality differs (tool ${tool.optional ? "optional" : "required"}, rest ${rest.optional ? "optional" : "required"})`);
  }
  if (tool.nullable !== rest.nullable) {
    pushDiff(diffs, path, `nullability differs (tool ${tool.nullable ? "nullable" : "non-null"}, rest ${rest.nullable ? "nullable" : "non-null"})`);
  }
  if (tool.enumValues || rest.enumValues) {
    const a = JSON.stringify(tool.enumValues ?? null);
    const b = JSON.stringify(rest.enumValues ?? null);
    if (a !== b) pushDiff(diffs, path, `enum members differ (tool=${a}, rest=${b})`);
  }
  if ("literal" in tool || "literal" in rest) {
    if (JSON.stringify(tool.literal) !== JSON.stringify(rest.literal)) {
      pushDiff(diffs, path, `literal differs (tool=${JSON.stringify(tool.literal)}, rest=${JSON.stringify(rest.literal)})`);
    }
  }
  if (tool.element && rest.element) {
    diffField(`${path}[]`, tool.element, rest.element, diffs);
  }
  if (tool.shape || rest.shape) {
    diffShape(path, tool.shape ?? {}, rest.shape ?? {}, diffs);
  }
}

function diffShape(
  prefix: string,
  tool: Record<string, FieldDescriptor>,
  rest: Record<string, FieldDescriptor>,
  diffs: FieldDiff[],
): void {
  const keys = new Set([...Object.keys(tool), ...Object.keys(rest)]);
  for (const key of [...keys].sort()) {
    const path = prefix ? `${prefix}.${key}` : key;
    const inTool = key in tool;
    const inRest = key in rest;
    if (inTool && !inRest) {
      pushDiff(diffs, path, "present on tool, missing on rest validator");
    } else if (!inTool && inRest) {
      pushDiff(diffs, path, "required by rest validator, missing on tool");
    } else {
      diffField(path, tool[key], rest[key], diffs);
    }
  }
}

/** Top-level object-shape comparison, honoring an allowlist of documented diffs. */
export function diffObjectSchemas(
  toolSchema: z.ZodTypeAny,
  restSchema: z.ZodTypeAny,
  allowedDiffs: string[] = [],
): FieldDiff[] {
  const allowed = new Set(allowedDiffs);
  const toolDesc = describe(toolSchema);
  const restDesc = describe(restSchema);
  const diffs: FieldDiff[] = [];
  diffShape("", toolDesc.shape ?? {}, restDesc.shape ?? {}, diffs);
  // An allowlisted top-level field silences every diff at or below it.
  return diffs.filter((d) => {
    const top = d.path.split(/[.[]/)[0];
    return !allowed.has(d.path) && !allowed.has(top);
  });
}

// ---------------------------------------------------------------------------
// Registry: MCP tool -> REST validator
// ---------------------------------------------------------------------------

/** Pull the discriminated-union member for `kind` and strip the `kind` literal. */
function interactionBody(kind: string): z.AnyZodObject {
  const options = (defOf(createIssueThreadInteractionSchema).options as z.AnyZodObject[]) ?? [];
  const member = options.find((option) => {
    const kindField = option.shape.kind as z.ZodLiteral<string> | undefined;
    return kindField?._def.value === kind;
  });
  if (!member) throw new Error(`No interaction union member for kind=${kind}`);
  return member.omit({ kind: true });
}

export interface DriftCase {
  /** MCP tool name. */
  tool: string;
  /** Human-readable REST route the tool targets. */
  route: string;
  /** The shared zod validator the REST route enforces on the body. */
  restSchema: () => z.ZodTypeAny;
  /** Tool-schema keys consumed as URL path params (not sent in the body). */
  pathParams?: string[];
  /**
   * Field paths that are intentionally divergent, each with a documented
   * reason. Any *undocumented* difference fails the check.
   */
  allowedDiffs?: Array<{ path: string; reason: string }>;
}

export const SCHEMA_DRIFT_CASES: DriftCase[] = [
  {
    tool: "paperclipCreateIssue",
    route: "POST /companies/:companyId/issues",
    restSchema: () => createIssueSchema,
    pathParams: ["companyId"],
    allowedDiffs: [
      { path: "status", reason: "tool sends status optional; createIssueSchema wraps the base in a z.preprocess that injects the default status when omitted, so an absent status is accepted at runtime" },
    ],
  },
  {
    tool: "paperclipUpdateIssue",
    route: "PATCH /issues/:id",
    // Route wraps this as updateIssueRouteSchema = updateIssueSchema.extend({ interrupt })
    // but `interrupt` is already in updateIssueSchema, so the shared schema is the source of truth.
    restSchema: () => updateIssueSchema,
    pathParams: ["issueId"],
  },
  {
    tool: "paperclipAddComment",
    route: "POST /issues/:id/comments",
    restSchema: () => addIssueCommentSchema,
    pathParams: ["issueId"],
  },
  {
    tool: "paperclipCheckoutIssue",
    route: "POST /issues/:id/checkout",
    restSchema: () => checkoutIssueSchema,
    pathParams: ["issueId"],
    allowedDiffs: [
      { path: "agentId", reason: "tool accepts optional/nullable agentId and resolves it to the configured agent before send; route requires a concrete uuid" },
      { path: "expectedStatuses", reason: "tool defaults expectedStatuses to [todo,backlog,blocked] before send; route requires a non-empty array" },
    ],
  },
  {
    tool: "paperclipCreateApproval",
    route: "POST /companies/:companyId/approvals",
    restSchema: () => createApprovalSchema,
    pathParams: ["companyId"],
  },
  {
    tool: "paperclipLinkIssueApproval",
    route: "POST /issues/:id/approvals",
    restSchema: () => linkIssueApprovalSchema,
    pathParams: ["issueId"],
  },
  {
    tool: "paperclipUpsertIssueDocument",
    route: "PUT /issues/:id/documents/:key",
    restSchema: () => upsertIssueDocumentSchema,
    pathParams: ["issueId", "key"],
    allowedDiffs: [
      { path: "format", reason: "tool applies a client-side markdown default (always sends format); route requires an explicit format enum" },
    ],
  },
  {
    tool: "paperclipSuggestTasks",
    route: "POST /issues/:id/interactions (kind=suggest_tasks)",
    restSchema: () => interactionBody("suggest_tasks"),
    pathParams: ["issueId"],
  },
  {
    tool: "paperclipAskUserQuestions",
    route: "POST /issues/:id/interactions (kind=ask_user_questions)",
    restSchema: () => interactionBody("ask_user_questions"),
    pathParams: ["issueId"],
  },
  {
    tool: "paperclipRequestConfirmation",
    route: "POST /issues/:id/interactions (kind=request_confirmation)",
    restSchema: () => interactionBody("request_confirmation"),
    pathParams: ["issueId"],
  },
  {
    tool: "paperclipRequestCheckboxConfirmation",
    route: "POST /issues/:id/interactions (kind=request_checkbox_confirmation)",
    restSchema: () => interactionBody("request_checkbox_confirmation"),
    pathParams: ["issueId"],
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface DriftViolation {
  tool: string;
  route: string;
  diffs: FieldDiff[];
}

function stubClient(): PaperclipApiClient {
  // No network is performed while building tool definitions; schemas are static.
  return new PaperclipApiClient({
    apiUrl: "http://schema-drift.invalid/api",
    apiKey: "schema-drift",
    companyId: "00000000-0000-0000-0000-000000000000",
    agentId: "00000000-0000-0000-0000-000000000000",
    runId: "00000000-0000-0000-0000-000000000000",
  });
}

function toolSchemaByName(defs: ToolDefinition[], name: string): z.AnyZodObject {
  const def = defs.find((candidate) => candidate.name === name);
  if (!def) throw new Error(`MCP tool "${name}" not found in tool definitions`);
  return def.schema;
}

/**
 * Compare every registered tool against its REST validator. Returns one entry
 * per tool that has at least one undocumented structural difference.
 */
export function collectSchemaDriftViolations(): DriftViolation[] {
  const defs = createToolDefinitions(stubClient());
  const violations: DriftViolation[] = [];
  for (const testCase of SCHEMA_DRIFT_CASES) {
    const toolSchema = toolSchemaByName(defs, testCase.tool);
    const pathParams = testCase.pathParams ?? [];
    const body = pathParams.length
      ? toolSchema.omit(Object.fromEntries(pathParams.map((key) => [key, true])) as Record<string, true>)
      : toolSchema;
    const allowed = (testCase.allowedDiffs ?? []).map((entry) => entry.path);
    const diffs = diffObjectSchemas(body, testCase.restSchema(), allowed);
    if (diffs.length) {
      violations.push({ tool: testCase.tool, route: testCase.route, diffs });
    }
  }
  return violations;
}

export function formatViolations(violations: DriftViolation[]): string {
  return violations
    .map((violation) => {
      const lines = violation.diffs.map((diff) => `    - ${diff.path}: ${diff.detail}`);
      return `  ${violation.tool}  →  ${violation.route}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}
