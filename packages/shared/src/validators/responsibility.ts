import { z } from "zod";
import {
  RESPONSIBILITY_AREA_SOURCES,
  RESPONSIBILITY_AREA_STATUSES,
  RESPONSIBILITY_DELEGATION_MODES,
  RESPONSIBILITY_HEALTH_OVERRIDES,
  RESPONSIBILITY_METRIC_DIRECTIONS,
  RESPONSIBILITY_SOURCES,
  RESPONSIBILITY_STATUSES,
} from "../constants.js";
import {
  RESPONSIBILITY_METRIC_KINDS,
  resolveResponsibilityMetricKind,
  responsibilityBarIssues,
  responsibilityMetricNameSchema,
  responsibilityMetricReadingSchema,
  responsibilityMetricUnitSchema,
  responsibilityMetricValueSchema,
} from "../responsibility-bars.js";

const title = z.string().trim().min(1).max(200);
const longText = z.string().trim().max(10_000);
const optionalText = longText.optional().nullable();
const requiredText = longText.min(1);
const metricName = responsibilityMetricNameSchema;
const metricUnit = responsibilityMetricUnitSchema;
const metricValue = responsibilityMetricValueSchema;
const sortOrder = z.number().int().min(-1_000_000).max(1_000_000);

/** The inputs that set a metric on create: sending any one of them means the whole metric must be there. */
const CREATE_METRIC_KEYS = [
  "metricKind",
  "metricName",
  "metricUnit",
  "metricDirection",
  "metricTarget",
  "metricLow",
  "metricHigh",
  "metricCurrent",
] as const;

const createResponsibilityFields = z.object({
  title,
  description: optionalText,
  /**
   * The bar, as a sentence. A person may leave it out (with the metric) and
   * set the bar later; it is required with a metric, and always from an agent.
   */
  standard: optionalText,
  /**
   * The bar template. Omitted: `percentage` when metricUnit is "%", otherwise
   * `volume`. Each template requires and allows its own fields (see
   * `RESPONSIBILITY_BAR_TEMPLATES`).
   */
  metricKind: z.enum(RESPONSIBILITY_METRIC_KINDS).optional(),
  /** What is measured. A person may leave the whole metric out; required from an agent. */
  metricName: metricName.optional(),
  /** Volume and percentage (required for them). */
  metricTarget: metricValue.optional().nullable(),
  /** Range (required for it): the lowest value that is still inside. */
  metricLow: metricValue.optional().nullable(),
  /** Range (required for it): the highest value that is still inside. */
  metricHigh: metricValue.optional().nullable(),
  /** A number; true or false for `yes_no`. */
  metricCurrent: responsibilityMetricReadingSchema.optional().nullable(),
  metricUnit: metricUnit.optional().nullable(),
  /** Volume and percentage only. Default `at_least`. */
  metricDirection: z.enum(RESPONSIBILITY_METRIC_DIRECTIONS).optional(),
  /** An area in the same company. */
  areaId: z.string().uuid().optional().nullable(),
  /** An agent in the same company that runs the work. */
  runByAgentId: z.string().uuid().optional().nullable(),
  evidence: optionalText,
  /** Board: defaults to the acting user. Agent: required. */
  ownerUserId: z.string().trim().min(1).optional(),
  /** Board only; agents always create `proposed`. Board default: `active`. */
  status: z.enum(RESPONSIBILITY_STATUSES).optional(),
  /** Board only; agents always create `onboarding`. Board default: `manual`. */
  source: z.enum(RESPONSIBILITY_SOURCES).optional(),
  sortOrder: sortOrder.optional(),
});

type CreateResponsibilityFields = z.infer<typeof createResponsibilityFields>;

/** A metric that is sent must be whole: the sentence, what is measured, and the template's inputs. */
function refineCreateBar(value: CreateResponsibilityFields, ctx: z.RefinementCtx) {
  const measured = CREATE_METRIC_KEYS.some((key) => value[key] !== undefined && value[key] !== null);
  if (!measured) return;
  if (!value.standard?.trim()) {
    ctx.addIssue({ code: "custom", path: ["standard"], message: "A responsibility with a metric needs its bar as a sentence (standard)" });
  }
  if (!value.metricName?.trim()) {
    ctx.addIssue({ code: "custom", path: ["metricName"], message: "A responsibility with a metric needs what is measured (metricName)" });
  }
  const metricKind = value.metricKind ?? resolveResponsibilityMetricKind(null, value.metricUnit);
  for (const issue of responsibilityBarIssues({ ...value, metricKind }, { complete: true })) {
    ctx.addIssue({ code: "custom", path: [issue.field], message: issue.message });
  }
}

/**
 * Create a responsibility. A person may send only a title: it is saved with
 * no bar and reads as not measured until its bar is set. Any metric input
 * makes the whole bar required (the sentence, what is measured and the
 * template's inputs), so a half-filled metric is refused. Agents send
 * `proposeResponsibilitySchema` instead, which always requires the bar.
 */
export const createResponsibilitySchema = createResponsibilityFields.strict().superRefine(refineCreateBar);

export type CreateResponsibility = z.infer<typeof createResponsibilitySchema>;

/** What an agent sends to propose a responsibility: the create body, with the whole bar required. */
export const proposeResponsibilitySchema = createResponsibilityFields
  .extend({ standard: requiredText, metricName })
  .strict()
  .superRefine(refineCreateBar);

export type ProposeResponsibility = z.infer<typeof proposeResponsibilitySchema>;

export const updateResponsibilitySchema = z.object({
  title: title.optional(),
  description: optionalText,
  /** `null` clears it; refused on an active responsibility. */
  standard: optionalText,
  /** `null` clears it; refused on an active responsibility. */
  metricName: metricName.optional().nullable(),
  /**
   * Change the bar template. Inputs the new template does not use are cleared,
   * and so is the reading unless metricCurrent is sent too. The merged bar
   * must follow the template's rules (422 otherwise).
   */
  metricKind: z.enum(RESPONSIBILITY_METRIC_KINDS).optional(),
  /** `null` clears it; refused on an active responsibility. */
  metricTarget: metricValue.optional().nullable(),
  /** Range: `null` clears it; refused on an active responsibility. */
  metricLow: metricValue.optional().nullable(),
  /** Range: `null` clears it; refused on an active responsibility. */
  metricHigh: metricValue.optional().nullable(),
  /**
   * The latest reading; sets `metricUpdatedAt`. A number, or true/false for a
   * `yes_no` bar. On an active responsibility an agent may send this field
   * alone when it runs the responsibility or is assigned a task or routine
   * under it.
   */
  metricCurrent: responsibilityMetricReadingSchema.optional().nullable(),
  metricUnit: metricUnit.optional().nullable(),
  /** Volume and percentage only. */
  metricDirection: z.enum(RESPONSIBILITY_METRIC_DIRECTIONS).optional().nullable(),
  areaId: z.string().uuid().optional().nullable(),
  runByAgentId: z.string().uuid().optional().nullable(),
  evidence: optionalText,
  sortOrder: sortOrder.optional(),
  /** `null` clears the override. */
  healthOverride: z.enum(RESPONSIBILITY_HEALTH_OVERRIDES).nullable().optional(),
  healthNote: optionalText,
  status: z.enum(RESPONSIBILITY_STATUSES).optional(),
}).strict();

export type UpdateResponsibility = z.infer<typeof updateResponsibilitySchema>;

export const linkResponsibilitySchema = z.object({
  projectId: z.string().uuid().optional(),
  issueId: z.string().uuid().optional(),
  routineId: z.string().uuid().optional(),
}).strict().refine(
  (value) => [value.projectId, value.issueId, value.routineId].filter((id) => id !== undefined).length === 1,
  { message: "Provide exactly one of projectId, issueId or routineId" },
);

export type LinkResponsibility = z.infer<typeof linkResponsibilitySchema>;

export const delegateResponsibilitySchema = z.object({
  title,
  instructions: longText.optional().nullable(),
  assigneeAgentId: z.string().uuid(),
  mode: z.enum(RESPONSIBILITY_DELEGATION_MODES),
  projectId: z.string().uuid().optional().nullable(),
}).strict();

export type DelegateResponsibility = z.infer<typeof delegateResponsibilitySchema>;

const booleanQuery = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

export const listResponsibilitiesQuerySchema = z.object({
  /** Board: defaults to the acting user. Agent: required. */
  ownerUserId: z.string().trim().min(1).optional(),
  includeLetGo: booleanQuery.optional().default(false),
});

export type ListResponsibilitiesQuery = z.infer<typeof listResponsibilitiesQuerySchema>;

export const createResponsibilityAreaSchema = z.object({
  title,
  description: optionalText,
  sortOrder: sortOrder.optional(),
  /** Board only; agents always create `proposed`. Board default: `active`. */
  status: z.enum(["proposed", "active"]).optional(),
  /** Board only; agents always create `onboarding`. Board default: `manual`. */
  source: z.enum(RESPONSIBILITY_AREA_SOURCES).optional(),
}).strict();

export type CreateResponsibilityArea = z.infer<typeof createResponsibilityAreaSchema>;

export const updateResponsibilityAreaSchema = z.object({
  title: title.optional(),
  description: optionalText,
  sortOrder: sortOrder.optional(),
  status: z.enum(RESPONSIBILITY_AREA_STATUSES).optional(),
}).strict();

export type UpdateResponsibilityArea = z.infer<typeof updateResponsibilityAreaSchema>;

export const listResponsibilityAreasQuerySchema = z.object({
  includeArchived: booleanQuery.optional().default(false),
});

export type ListResponsibilityAreasQuery = z.infer<typeof listResponsibilityAreasQuerySchema>;

export const responsibilityLinkLookupQuerySchema = z.object({
  issueId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  routineId: z.string().uuid().optional(),
}).refine(
  (value) => [value.projectId, value.issueId, value.routineId].filter((id) => id !== undefined).length === 1,
  { message: "Provide exactly one of issueId, projectId or routineId" },
);

export type ResponsibilityLinkLookupQuery = z.infer<typeof responsibilityLinkLookupQuerySchema>;
