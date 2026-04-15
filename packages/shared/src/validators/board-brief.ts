import { z } from "zod";
import {
  BOARD_BRIEF_ACTION_KINDS,
  BOARD_BRIEF_ACTION_SEVERITIES,
  BOARD_BRIEF_ALERT_EVENT_STATUSES,
  BOARD_BRIEF_CONFIDENCE_LEVELS,
  BOARD_BRIEF_FRESHNESS_STATUSES,
  BOARD_BRIEF_HEALTH_TONES,
  BOARD_BRIEF_INCIDENT_SEVERITIES,
  BOARD_BRIEF_INCIDENT_TYPES,
  BOARD_BRIEF_OUTPUT_KINDS,
  BOARD_BRIEF_SNAPSHOT_SOURCES,
} from "../constants.js";
import { companyKpiTrendSchema } from "./executive-summary.js";

const dateSchema = z.coerce.date();

const dashboardBriefMetricSchema = z.object({
  value: z.string(),
  label: z.string(),
  headline: z.string(),
  detail: z.string(),
  tone: z.enum(BOARD_BRIEF_HEALTH_TONES),
});

const companyKpiSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  label: z.string(),
  value: z.string(),
  trend: companyKpiTrendSchema,
  note: z.string().nullable(),
  position: z.number().int(),
  updatedByUserId: z.string().nullable(),
  updatedByAgentId: z.string().uuid().nullable(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

export const boardBriefFreshnessEntrySchema = z.object({
  status: z.enum(BOARD_BRIEF_FRESHNESS_STATUSES),
  lastUpdatedAt: dateSchema.nullable(),
  reason: z.string().nullable(),
});

export const boardBriefHealthSchema = z.object({
  tone: z.enum(BOARD_BRIEF_HEALTH_TONES),
  reasons: z.array(z.string()),
});

export const boardBriefFocusAreaSchema = z.object({
  key: z.string(),
  label: z.string(),
  tone: z.enum(BOARD_BRIEF_HEALTH_TONES),
  changedIssueCount: z.number().int().nonnegative(),
  blockedCount: z.number().int().nonnegative(),
  failedRunCount: z.number().int().nonnegative(),
  activeAgentCount: z.number().int().nonnegative(),
  outputCount: z.number().int().nonnegative(),
  latestUpdate: z.string(),
  href: z.string(),
});

export const boardBriefActionItemSchema = z.object({
  key: z.string(),
  kind: z.enum(BOARD_BRIEF_ACTION_KINDS),
  entityId: z.string(),
  title: z.string(),
  reason: z.string(),
  severity: z.enum(BOARD_BRIEF_ACTION_SEVERITIES),
  timestamp: dateSchema,
  href: z.string(),
  ctaLabel: z.string(),
});

export const boardBriefIncidentSchema = z.object({
  fingerprint: z.string(),
  type: z.enum(BOARD_BRIEF_INCIDENT_TYPES),
  severity: z.enum(BOARD_BRIEF_INCIDENT_SEVERITIES),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  title: z.string(),
  reason: z.string(),
  openedAt: dateSchema,
  lastSeenAt: dateSchema,
  shouldAlert: z.boolean(),
});

export const boardBriefOutputSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(BOARD_BRIEF_OUTPUT_KINDS),
  issueId: z.string().uuid(),
  issueIdentifier: z.string().nullable(),
  issueTitle: z.string(),
  projectId: z.string().uuid().nullable(),
  title: z.string(),
  subtitle: z.string().nullable(),
  url: z.string().nullable(),
  outputType: z.string(),
  status: z.string().nullable(),
  reviewState: z.string().nullable(),
  updatedAt: dateSchema,
});

export const boardBriefSchema = z.object({
  meta: z.object({
    companyId: z.string().uuid(),
    schemaVersion: z.literal(1),
    generatedAt: dateSchema,
    windowStart: dateSchema,
    windowEnd: dateSchema,
  }),
  totals: z.object({
    agents: z.object({
      active: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      paused: z.number().int().nonnegative(),
      error: z.number().int().nonnegative(),
    }),
    tasks: z.object({
      open: z.number().int().nonnegative(),
      inProgress: z.number().int().nonnegative(),
      blocked: z.number().int().nonnegative(),
      done: z.number().int().nonnegative(),
    }),
    costs: z.object({
      monthSpendCents: z.number().int().nonnegative(),
      monthBudgetCents: z.number().int().nonnegative(),
      monthUtilizationPercent: z.number().nonnegative(),
    }),
    budgets: z.object({
      activeIncidents: z.number().int().nonnegative(),
      pendingApprovals: z.number().int().nonnegative(),
      pausedAgents: z.number().int().nonnegative(),
      pausedProjects: z.number().int().nonnegative(),
    }),
    pendingApprovals: z.number().int().nonnegative(),
  }),
  health: boardBriefHealthSchema,
  freshness: z.object({
    execution: boardBriefFreshnessEntrySchema,
    work: boardBriefFreshnessEntrySchema,
    cost: boardBriefFreshnessEntrySchema,
    approvals: boardBriefFreshnessEntrySchema,
    outputs: boardBriefFreshnessEntrySchema,
  }),
  confidence: z.enum(BOARD_BRIEF_CONFIDENCE_LEVELS),
  snapshot: z.object({
    progress: dashboardBriefMetricSchema,
    risk: dashboardBriefMetricSchema,
    decisions: dashboardBriefMetricSchema,
    spend: dashboardBriefMetricSchema,
    outputs: dashboardBriefMetricSchema,
  }),
  focusAreas: z.array(boardBriefFocusAreaSchema),
  actionQueue: z.array(boardBriefActionItemSchema),
  incidents: z.array(boardBriefIncidentSchema),
  outputs: z.array(boardBriefOutputSchema),
  manualKpis: z.array(companyKpiSchema),
});

export const boardBriefSnapshotSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  source: z.enum(BOARD_BRIEF_SNAPSHOT_SOURCES),
  schemaVersion: z.number().int().positive(),
  health: z.enum(BOARD_BRIEF_HEALTH_TONES),
  confidence: z.enum(BOARD_BRIEF_CONFIDENCE_LEVELS),
  windowStart: dateSchema,
  windowEnd: dateSchema,
  generatedAt: dateSchema,
  relatedAlertEventId: z.string().uuid().nullable(),
  payload: boardBriefSchema,
  createdAt: dateSchema,
});

export const boardBriefAlertEventSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  fingerprint: z.string(),
  incidentType: z.enum(BOARD_BRIEF_INCIDENT_TYPES),
  severity: z.enum(BOARD_BRIEF_INCIDENT_SEVERITIES),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  status: z.enum(BOARD_BRIEF_ALERT_EVENT_STATUSES),
  firstDetectedAt: dateSchema,
  lastDetectedAt: dateSchema,
  firstSentAt: dateSchema.nullable(),
  lastSentAt: dateSchema.nullable(),
  lastSnapshotId: z.string().uuid().nullable(),
  createdAt: dateSchema,
  updatedAt: dateSchema,
});
