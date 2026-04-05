import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, isNull, ne, not } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentRuntimeState, agents, companyMemberships, heartbeatRuns, issues } from "@paperclipai/db";
import type { AdapterEnvironmentCheck } from "@paperclipai/shared";
import { findServerAdapter } from "../adapters/index.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { logActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { secretService } from "./secrets.js";

const AGENT_HEALTH_ALERT_ORIGIN_KIND = "agent_health_alert";
const DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);
const NON_BLOCKING_BOOTSTRAP_WARN_CODES = new Set([
  "claude_anthropic_api_key_overrides_subscription",
  "opencode_hello_probe_timed_out",
]);
const REQUIRED_AGENT_BOOTSTRAP_FILES = ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"] as const;
const DEFAULT_ENVIRONMENT_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_STALE_MULTIPLIER = 3;
const DEFAULT_HEARTBEAT_STALE_MIN_MS = 30 * 60 * 1000;
const DEFAULT_QUEUE_STARVATION_MS = 15 * 60 * 1000;
const DEFAULT_ALERT_REOPEN_COOLDOWN_MS = 30 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const OPEN_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "claimed",
  "in_progress",
  "handoff_ready",
  "technical_review",
  "changes_requested",
  "human_review",
  "blocked",
] as const;

type AgentRow = typeof agents.$inferSelect;
type MembershipRow = typeof companyMemberships.$inferSelect;
type RuntimeStateRow = typeof agentRuntimeState.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type ReviewQueueStatus = "technical_review" | "changes_requested" | "human_review";
type ReviewQueueOwner = {
  key: string;
  label: string;
  assigneeAgentId: string | null;
};
type ReviewQueueMonitoredIssue = Pick<
  IssueRow,
  "id" | "companyId" | "identifier" | "title" | "status" | "assigneeAgentId" | "assigneeUserId" | "createdAt" | "updatedAt"
>;

type HealthFinding = {
  companyId: string;
  originId: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  assigneeAgentId: string | null;
};

type ReviewQueuePolicy = {
  label: string;
  wipLimit: number;
  slaMs: number;
  wipPriority: HealthFinding["priority"];
  slaPriority: HealthFinding["priority"];
};

const REVIEW_QUEUE_POLICIES: Record<ReviewQueueStatus, ReviewQueuePolicy> = {
  technical_review: {
    label: "Technical review",
    wipLimit: 3,
    slaMs: 8 * HOUR_MS,
    wipPriority: "high",
    slaPriority: "high",
  },
  changes_requested: {
    label: "Changes requested",
    wipLimit: 5,
    slaMs: 24 * HOUR_MS,
    wipPriority: "medium",
    slaPriority: "medium",
  },
  human_review: {
    label: "Human review",
    wipLimit: 3,
    slaMs: 24 * HOUR_MS,
    wipPriority: "medium",
    slaPriority: "medium",
  },
};

type AgentHealthMonitorDeps = {
  adapterEnvironmentIntervalMs?: number;
  heartbeatStaleMultiplier?: number;
  heartbeatStaleMinMs?: number;
  queueStarvationMs?: number;
  alertReopenCooldownMs?: number;
  reviewQueuePolicies?: Partial<Record<ReviewQueueStatus, Partial<ReviewQueuePolicy>>>;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function parseHeartbeatPolicy(runtimeConfig: unknown) {
  const heartbeat = asRecord(asRecord(runtimeConfig).heartbeat);
  return {
    enabled: asBoolean(heartbeat.enabled, false),
    intervalSec: Math.max(0, Math.floor(asNumber(heartbeat.intervalSec, 0))),
  };
}

function priorityForEnvironmentCheck(check: AdapterEnvironmentCheck): HealthFinding["priority"] {
  return check.level === "error" ? "critical" : "high";
}

function formatLines(lines: string[]) {
  return lines.map((line) => `- ${line}`).join("\n");
}

function buildAlertDescription(input: {
  agent: AgentRow;
  code: string;
  summary: string;
  details: string[];
}) {
  const detailLines = input.details.length > 0 ? formatLines(input.details) : "- No additional details captured.";
  return [
    "## Agent Health Alert",
    "",
    formatLines([
      `Agent: ${input.agent.name} (\`${input.agent.id}\`)`,
      `Check: \`${input.code}\``,
      input.summary,
    ]),
    "",
    "## Details",
    "",
    detailLines,
  ].join("\n");
}

function buildIssueLink(issue: Pick<ReviewQueueMonitoredIssue, "identifier">) {
  if (!issue.identifier) return null;
  const prefix = issue.identifier.split("-")[0] ?? issue.identifier;
  return `/${prefix}/issues/${issue.identifier}`;
}

function buildIssueLabel(issue: Pick<ReviewQueueMonitoredIssue, "identifier" | "title">) {
  return issue.identifier ? `Issue ${issue.identifier}` : `Issue ${issue.title}`;
}

function buildReviewQueueAlertDescription(input: {
  scopeLabel: string;
  statusLabel: string;
  code: string;
  summary: string;
  details: string[];
}) {
  const detailLines = input.details.length > 0 ? formatLines(input.details) : "- No additional details captured.";
  return [
    "## Review Queue Alert",
    "",
    formatLines([
      `Scope: ${input.scopeLabel}`,
      `State: ${input.statusLabel}`,
      `Check: \`${input.code}\``,
      input.summary,
    ]),
    "",
    "## Details",
    "",
    detailLines,
  ].join("\n");
}

function issuePatchNeeded(
  issue: IssueRow,
  finding: HealthFinding,
) {
  return (
    issue.title !== finding.title
    || (issue.description ?? null) !== finding.description
    || issue.priority !== finding.priority
    || (issue.assigneeAgentId ?? null) !== finding.assigneeAgentId
  );
}

function normalizeAlertOriginId(agentId: string, code: string) {
  return `agent:${agentId}:health:${code}`;
}

function parseAgentIdFromOrigin(originId: string | null | undefined) {
  if (typeof originId !== "string") return null;
  const match = /^agent:([^:]+):health:/.exec(originId);
  return match?.[1] ?? null;
}

function normalizeReviewQueueOriginId(
  companyId: string,
  ownerKey: string,
  status: ReviewQueueStatus,
  code: "wip_limit" | "sla_breach",
) {
  return `company:${companyId}:review_queue:${ownerKey}:${status}:${code}`;
}

function isReviewQueueAlertOriginId(originId: string | null | undefined) {
  return typeof originId === "string" && originId.includes(":review_queue:");
}

function isManagedInstructionsAdapterType(adapterType: string | null | undefined) {
  return typeof adapterType === "string" && DEFAULT_MANAGED_INSTRUCTIONS_ADAPTER_TYPES.has(adapterType);
}

function resolveBootstrapBundleRelativePath(
  bundle: {
    entryFile: string;
    files: Array<{ path: string }>;
  },
  fileName: (typeof REQUIRED_AGENT_BOOTSTRAP_FILES)[number],
) {
  const exactMatch = bundle.files.find((file) => file.path === fileName);
  if (exactMatch) return exactMatch.path;

  if (fileName === "AGENTS.md" && path.posix.basename(bundle.entryFile) === fileName) {
    return bundle.entryFile;
  }

  const basenameMatches = bundle.files.filter((file) => path.posix.basename(file.path) === fileName);
  if (basenameMatches.length === 1) return basenameMatches[0]!.path;
  return null;
}

function resolveResponsibleAgentId(
  agent: AgentRow,
  agentsByCompany: Map<string, AgentRow[]>,
): string | null {
  const peers = agentsByCompany.get(agent.companyId) ?? [];
  const peersById = new Map(peers.map((row) => [row.id, row]));

  let cursor = agent.reportsTo;
  while (cursor) {
    const manager = peersById.get(cursor);
    if (!manager) break;
    if (manager.status !== "terminated" && manager.status !== "pending_approval" && manager.status !== "paused") {
      return manager.id;
    }
    cursor = manager.reportsTo;
  }

  const ceo = peers.find((row) =>
    row.role === "ceo"
    && row.status !== "terminated"
    && row.status !== "pending_approval"
    && row.status !== "paused",
  );
  if (ceo) return ceo.id;

  if (agent.status !== "terminated" && agent.status !== "pending_approval" && agent.status !== "paused") {
    return agent.id;
  }

  return null;
}

function resolveCompanyEscalationAgentId(companyId: string, agentsByCompany: Map<string, AgentRow[]>) {
  const peers = agentsByCompany.get(companyId) ?? [];
  const ceo = peers.find((row) =>
    row.role === "ceo"
    && row.status !== "terminated"
    && row.status !== "pending_approval"
    && row.status !== "paused",
  );
  if (ceo) return ceo.id;

  const available = peers.find((row) =>
    row.status !== "terminated"
    && row.status !== "pending_approval"
    && row.status !== "paused",
  );
  return available?.id ?? null;
}

function formatDurationHours(durationMs: number) {
  const hours = durationMs / HOUR_MS;
  const rounded = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${rounded}h`;
}

function issueDisplayLine(issue: ReviewQueueMonitoredIssue, enteredAt: Date | null) {
  const link = buildIssueLink(issue);
  const label = issue.identifier && link
    ? `[${issue.identifier}](${link})`
    : `\`${issue.id}\``;
  const enteredAtText = enteredAt ? enteredAt.toISOString() : "unknown";
  return `${label} (${issue.title}) entered this state at ${enteredAtText}.`;
}

function mergeReviewQueuePolicies(
  overrides: AgentHealthMonitorDeps["reviewQueuePolicies"],
): Record<ReviewQueueStatus, ReviewQueuePolicy> {
  return {
    technical_review: { ...REVIEW_QUEUE_POLICIES.technical_review, ...(overrides?.technical_review ?? {}) },
    changes_requested: { ...REVIEW_QUEUE_POLICIES.changes_requested, ...(overrides?.changes_requested ?? {}) },
    human_review: { ...REVIEW_QUEUE_POLICIES.human_review, ...(overrides?.human_review ?? {}) },
  };
}

function extractTransitionedStatus(details: Record<string, unknown>) {
  const nextStatus = asString(details.status);
  if (!nextStatus) return null;
  const previous = asRecord(details._previous);
  const previousStatus = asString(previous.status);
  return { nextStatus, previousStatus };
}

export function agentHealthMonitorService(db: Db, deps: AgentHealthMonitorDeps = {}) {
  const issuesSvc = issueService(db);
  const secretsSvc = secretService(db);
  const instructionsSvc = agentInstructionsService();
  const adapterCheckCache = new Map<string, number>();
  const adapterEnvironmentIntervalMs = deps.adapterEnvironmentIntervalMs ?? DEFAULT_ENVIRONMENT_CHECK_INTERVAL_MS;
  const heartbeatStaleMultiplier = deps.heartbeatStaleMultiplier ?? DEFAULT_HEARTBEAT_STALE_MULTIPLIER;
  const heartbeatStaleMinMs = deps.heartbeatStaleMinMs ?? DEFAULT_HEARTBEAT_STALE_MIN_MS;
  const queueStarvationMs = deps.queueStarvationMs ?? DEFAULT_QUEUE_STARVATION_MS;
  const alertReopenCooldownMs = deps.alertReopenCooldownMs ?? DEFAULT_ALERT_REOPEN_COOLDOWN_MS;
  const reviewQueuePolicies = mergeReviewQueuePolicies(deps.reviewQueuePolicies);

  async function evaluateManagedBootstrap(
    agent: AgentRow,
    assigneeAgentId: string | null,
    now: Date,
  ) {
    if (!isManagedInstructionsAdapterType(agent.adapterType)) return [] as HealthFinding[];

    const findings: HealthFinding[] = [];
    const bundle = await instructionsSvc.getBundle(agent);
    const details: string[] = [];

    if (bundle.warnings.length > 0) {
      details.push(...bundle.warnings);
    }

    const missingBundleFiles = REQUIRED_AGENT_BOOTSTRAP_FILES.filter(
      (fileName) => !resolveBootstrapBundleRelativePath(bundle, fileName),
    );
    if (missingBundleFiles.length > 0) {
      details.push(`Instructions bundle is missing required files: ${missingBundleFiles.join(", ")}.`);
    }

    const agentHome = resolveDefaultAgentWorkspaceDir(agent.id);
    const missingHomeFiles: string[] = [];
    for (const fileName of REQUIRED_AGENT_BOOTSTRAP_FILES) {
      const filePath = path.join(agentHome, fileName);
      const stat = await fs.lstat(filePath).catch(() => null);
      if (!stat) {
        missingHomeFiles.push(fileName);
        continue;
      }
      if (stat.isDirectory()) {
        missingHomeFiles.push(`${fileName} (directory present, file expected)`);
      }
    }
    if (missingHomeFiles.length > 0) {
      details.push(`$AGENT_HOME bootstrap files are missing or invalid: ${missingHomeFiles.join(", ")}.`);
    }

    if (details.length === 0) return findings;

    findings.push({
      companyId: agent.companyId,
      originId: normalizeAlertOriginId(agent.id, "bootstrap_integrity"),
      title: `Agent health: ${agent.name} bootstrap integrity is broken`,
      description: buildAlertDescription({
        agent,
        code: "bootstrap_integrity",
        summary: "Managed instructions/bootstrap files are not in a runnable state.",
        details,
      }),
      priority: "high",
      assigneeAgentId,
    });
    return findings;
  }

  async function evaluateAdapterEnvironment(
    agent: AgentRow,
    assigneeAgentId: string | null,
    now: Date,
  ) {
    const findings: HealthFinding[] = [];
    const adapter = findServerAdapter(agent.adapterType);
    if (!adapter) {
      findings.push({
        companyId: agent.companyId,
        originId: normalizeAlertOriginId(agent.id, "unknown_adapter"),
        title: `Agent health: ${agent.name} uses an unknown adapter`,
          description: buildAlertDescription({
            agent,
            code: "unknown_adapter",
            summary: `The configured adapter \`${agent.adapterType}\` is not registered in this runtime.`,
            details: [],
          }),
        priority: "critical",
        assigneeAgentId,
      });
      return findings;
    }

    try {
      const { config: runtimeAdapterConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
        agent.companyId,
        agent.adapterConfig,
      );
      const result = await adapter.testEnvironment({
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        config: runtimeAdapterConfig,
      });
      const blockingChecks = result.checks.filter(
        (check) =>
          check.level === "error"
          || (check.level === "warn" && !NON_BLOCKING_BOOTSTRAP_WARN_CODES.has(check.code)),
      );
      for (const check of blockingChecks) {
        const details = [check.message];
        if (check.detail) details.push(check.detail);
        if (check.hint) details.push(`Hint: ${check.hint}`);
        findings.push({
          companyId: agent.companyId,
          originId: normalizeAlertOriginId(agent.id, `environment_${check.code}`),
          title: `Agent health: ${agent.name} failed ${check.code}`,
          description: buildAlertDescription({
            agent,
            code: check.code,
            summary: `Adapter environment validation failed for \`${agent.adapterType}\`.`,
            details,
          }),
          priority: priorityForEnvironmentCheck(check),
          assigneeAgentId,
        });
      }
    } catch (error) {
      findings.push({
        companyId: agent.companyId,
        originId: normalizeAlertOriginId(agent.id, "environment_resolution_failed"),
        title: `Agent health: ${agent.name} configuration cannot be resolved`,
        description: buildAlertDescription({
          agent,
          code: "environment_resolution_failed",
          summary: "Paperclip could not resolve the adapter configuration for runtime validation.",
          details: [error instanceof Error ? error.message : String(error)],
        }),
        priority: "critical",
        assigneeAgentId,
      });
    }

    return findings;
  }

  async function evaluateAgentFastChecks(input: {
    agent: AgentRow;
    assigneeAgentId: string | null;
    membership: MembershipRow | null;
    runtimeState: RuntimeStateRow | null;
    queuedRuns: RunRow[];
    now: Date;
  }) {
    const { agent, assigneeAgentId, membership, runtimeState, queuedRuns, now } = input;
    const findings: HealthFinding[] = [];

    if (!membership || membership.status !== "active") {
      findings.push({
        companyId: agent.companyId,
        originId: normalizeAlertOriginId(agent.id, "membership_inactive"),
        title: `Agent health: ${agent.name} lost company access`,
        description: buildAlertDescription({
          agent,
          code: "membership_inactive",
          summary: "The agent no longer has an active company membership, so future heartbeats will fail authentication.",
          details: membership ? [`Membership status is \`${membership.status}\`.`] : ["No company membership row was found."],
        }),
        priority: "critical",
        assigneeAgentId,
      });
    }

    if (runtimeState && runtimeState.adapterType !== agent.adapterType) {
      findings.push({
        companyId: agent.companyId,
        originId: normalizeAlertOriginId(agent.id, "runtime_adapter_divergence"),
        title: `Agent health: ${agent.name} runtime state diverged from configuration`,
        description: buildAlertDescription({
          agent,
          code: "runtime_adapter_divergence",
          summary: "The persisted runtime state still points at a different adapter than the current agent configuration.",
          details: [
            `Agent config adapter: \`${agent.adapterType}\`.`,
            `Runtime state adapter: \`${runtimeState.adapterType}\`.`,
          ],
        }),
        priority: "high",
        assigneeAgentId,
      });
    }

    const hasRunningRun = queuedRuns.some((run) => run.status === "running");

    const heartbeatPolicy = parseHeartbeatPolicy(agent.runtimeConfig);
    // `agents.lastHeartbeatAt` advances only when a heartbeat **finishes**. A long-running local CLI
    // (OpenCode/Codex/Claude) can legitimately exceed the interval while `heartbeat_runs.status` is
    // still `running`. Do not flag "stalled" in that case — it is active work, not a missed timer.
    if (
      heartbeatPolicy.enabled
      && heartbeatPolicy.intervalSec > 0
      && !hasRunningRun
    ) {
      const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
      const staleAfterMs = Math.max(heartbeatStaleMinMs, heartbeatPolicy.intervalSec * 1000 * heartbeatStaleMultiplier);
      if (now.getTime() - baseline >= staleAfterMs) {
        findings.push({
          companyId: agent.companyId,
          originId: normalizeAlertOriginId(agent.id, "heartbeat_stalled"),
          title: `Agent health: ${agent.name} missed expected heartbeats`,
          description: buildAlertDescription({
            agent,
            code: "heartbeat_stalled",
            summary: "The agent has gone longer than expected without completing a heartbeat.",
            details: [
              `Heartbeat interval is ${heartbeatPolicy.intervalSec}s.`,
              `Last heartbeat at ${agent.lastHeartbeatAt ? agent.lastHeartbeatAt.toISOString() : "never"}.`,
              `Stale threshold is ${Math.floor(staleAfterMs / 60000)} minute(s).`,
            ],
          }),
          priority: "high",
          assigneeAgentId,
        });
      }
    }
    const oldestQueuedRun = queuedRuns
      .filter((run) => run.status === "queued")
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0] ?? null;
    if (!hasRunningRun && oldestQueuedRun && now.getTime() - oldestQueuedRun.createdAt.getTime() >= queueStarvationMs) {
      findings.push({
        companyId: agent.companyId,
        originId: normalizeAlertOriginId(agent.id, "queued_without_consumer"),
        title: `Agent health: ${agent.name} has queued work without a consumer`,
        description: buildAlertDescription({
          agent,
          code: "queued_without_consumer",
          summary: "Heartbeat work is sitting queued without any active run consuming it.",
          details: [
            `Oldest queued run: \`${oldestQueuedRun.id}\` created at ${oldestQueuedRun.createdAt.toISOString()}.`,
            `Queue starvation threshold is ${Math.floor(queueStarvationMs / 60000)} minute(s).`,
          ],
        }),
        priority: "critical",
        assigneeAgentId,
      });
    }

    return findings;
  }

  async function resolveReviewQueueStatusEnteredAt(reviewIssues: ReviewQueueMonitoredIssue[]) {
    const enteredAtByIssueId = new Map<string, Date>();
    if (reviewIssues.length === 0) return enteredAtByIssueId;

    const reviewIssueIds = reviewIssues.map((issue) => issue.id);
    const currentStatusByIssueId = new Map(
      reviewIssues.map((issue) => [issue.id, issue.status as ReviewQueueStatus]),
    );
    const statusRows = await db
      .select({
        entityId: activityLog.entityId,
        createdAt: activityLog.createdAt,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.action, "issue.updated"),
          inArray(activityLog.entityId, reviewIssueIds),
        ),
      )
      .orderBy(desc(activityLog.createdAt));

    const fallbackRows: typeof statusRows = [];
    for (const row of statusRows) {
      if (enteredAtByIssueId.has(row.entityId)) continue;
      const currentStatus = currentStatusByIssueId.get(row.entityId);
      if (!currentStatus) continue;
      const details = asRecord(row.details);
      const transition = extractTransitionedStatus(details);
      if (!transition || transition.nextStatus !== currentStatus) continue;
      if (transition.previousStatus && transition.previousStatus !== currentStatus) {
        enteredAtByIssueId.set(row.entityId, row.createdAt);
        continue;
      }
      fallbackRows.push(row);
    }

    for (const row of fallbackRows) {
      if (enteredAtByIssueId.has(row.entityId)) continue;
      enteredAtByIssueId.set(row.entityId, row.createdAt);
    }

    for (const issue of reviewIssues) {
      if (enteredAtByIssueId.has(issue.id)) continue;
      enteredAtByIssueId.set(issue.id, issue.updatedAt ?? issue.createdAt);
    }

    return enteredAtByIssueId;
  }

  function resolveReviewQueueOwner(
    issue: ReviewQueueMonitoredIssue,
    agentsById: Map<string, AgentRow>,
    agentsByCompany: Map<string, AgentRow[]>,
  ): ReviewQueueOwner {
    if (issue.assigneeAgentId) {
      const agent = agentsById.get(issue.assigneeAgentId) ?? null;
      return {
        key: `agent:${issue.assigneeAgentId}`,
        label: agent?.name ?? `Agent ${issue.assigneeAgentId}`,
        assigneeAgentId: agent
          ? resolveResponsibleAgentId(agent, agentsByCompany)
          : resolveCompanyEscalationAgentId(issue.companyId, agentsByCompany),
      };
    }

    if (issue.assigneeUserId) {
      return {
        key: `user:${issue.assigneeUserId}`,
        label: `User ${issue.assigneeUserId}`,
        assigneeAgentId: resolveCompanyEscalationAgentId(issue.companyId, agentsByCompany),
      };
    }

    if (issue.status === "human_review") {
      return {
        key: "board",
        label: "Board",
        assigneeAgentId: resolveCompanyEscalationAgentId(issue.companyId, agentsByCompany),
      };
    }

    return {
      key: "unassigned",
      label: "Unassigned queue",
      assigneeAgentId: resolveCompanyEscalationAgentId(issue.companyId, agentsByCompany),
    };
  }

  async function evaluateReviewQueueAlerts(
    agentsByCompany: Map<string, AgentRow[]>,
    agentsById: Map<string, AgentRow>,
    now: Date,
  ) {
    const reviewStatuses = Object.keys(reviewQueuePolicies) as ReviewQueueStatus[];
    const reviewIssues = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          inArray(issues.status, reviewStatuses),
          isNull(issues.hiddenAt),
          not(eq(issues.originKind, AGENT_HEALTH_ALERT_ORIGIN_KIND)),
          not(eq(issues.originKind, "routine_execution")),
        ),
      );
    if (reviewIssues.length === 0) return [] as HealthFinding[];

    const enteredAtByIssueId = await resolveReviewQueueStatusEnteredAt(reviewIssues);
    const findings: HealthFinding[] = [];
    const queueByOwnerAndStatus = new Map<string, Array<{ issue: ReviewQueueMonitoredIssue; owner: ReviewQueueOwner }>>();

    for (const issue of reviewIssues) {
      const status = issue.status as ReviewQueueStatus;
      const owner = resolveReviewQueueOwner(issue, agentsById, agentsByCompany);
      const groupKey = `${issue.companyId}:${owner.key}:${status}`;
      const list = queueByOwnerAndStatus.get(groupKey) ?? [];
      list.push({ issue, owner });
      queueByOwnerAndStatus.set(groupKey, list);

      const policy = reviewQueuePolicies[status];
      const enteredAt = enteredAtByIssueId.get(issue.id) ?? null;
      if (!enteredAt || now.getTime() - enteredAt.getTime() < policy.slaMs) continue;

      const ageMs = now.getTime() - enteredAt.getTime();
      findings.push({
        companyId: issue.companyId,
        originId: normalizeReviewQueueOriginId(issue.companyId, owner.key, status, "sla_breach") + `:${issue.id}`,
        title: `Review queue: ${policy.label} exceeded SLA for ${buildIssueLabel(issue)}`,
        description: buildReviewQueueAlertDescription({
          scopeLabel: owner.label,
          statusLabel: policy.label,
          code: "sla_breach",
          summary: `${buildIssueLabel(issue)} has been waiting longer than the ${formatDurationHours(policy.slaMs)} SLA.`,
          details: [
            issueDisplayLine(issue, enteredAt),
            `Current age is ${formatDurationHours(ageMs)} against an SLA of ${formatDurationHours(policy.slaMs)}.`,
          ],
        }),
        priority: policy.slaPriority,
        assigneeAgentId: owner.assigneeAgentId,
      });
    }

    for (const grouped of queueByOwnerAndStatus.values()) {
      const [{ issue, owner }] = grouped;
      const status = issue.status as ReviewQueueStatus;
      const policy = reviewQueuePolicies[status];
      if (grouped.length <= policy.wipLimit) continue;

      const sorted = [...grouped].sort((left, right) => {
        const leftEnteredAt = enteredAtByIssueId.get(left.issue.id) ?? left.issue.updatedAt ?? left.issue.createdAt;
        const rightEnteredAt = enteredAtByIssueId.get(right.issue.id) ?? right.issue.updatedAt ?? right.issue.createdAt;
        return leftEnteredAt.getTime() - rightEnteredAt.getTime();
      });
      const details = sorted.slice(0, 5).map(({ issue: candidate }) =>
        issueDisplayLine(candidate, enteredAtByIssueId.get(candidate.id) ?? null));
      if (sorted.length > 5) {
        details.push(`Plus ${sorted.length - 5} more open item(s) in this queue.`);
      }

      findings.push({
        companyId: issue.companyId,
        originId: normalizeReviewQueueOriginId(issue.companyId, owner.key, status, "wip_limit"),
        title: `Review queue: ${policy.label} WIP limit exceeded for ${owner.label}`,
        description: buildReviewQueueAlertDescription({
          scopeLabel: owner.label,
          statusLabel: policy.label,
          code: "wip_limit",
          summary: `${owner.label} has ${sorted.length} open item(s) in ${policy.label}, above the limit of ${policy.wipLimit}.`,
          details,
        }),
        priority: policy.wipPriority,
        assigneeAgentId: owner.assigneeAgentId,
      });
    }

    return findings;
  }

  return {
    tick: async (now = new Date()) => {
      const monitoredAgents = await db
        .select()
        .from(agents)
        .where(and(ne(agents.status, "terminated"), ne(agents.status, "pending_approval")));
      if (monitoredAgents.length === 0) {
        return { checked: 0, findings: 0, created: 0, updated: 0, resolved: 0 };
      }

      const agentIds = monitoredAgents.map((agent) => agent.id);
      const memberships = await db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "agent"),
            inArray(companyMemberships.principalId, agentIds),
          ),
        );
      const runtimeStates = await db
        .select()
        .from(agentRuntimeState)
        .where(inArray(agentRuntimeState.agentId, agentIds));
      const activeRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(inArray(heartbeatRuns.agentId, agentIds), inArray(heartbeatRuns.status, ["queued", "running"])));
      const openAlerts = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.originKind, AGENT_HEALTH_ALERT_ORIGIN_KIND),
            inArray(issues.status, [...OPEN_ISSUE_STATUSES]),
            isNull(issues.hiddenAt),
          ),
        );
      const historicalAlerts = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.originKind, AGENT_HEALTH_ALERT_ORIGIN_KIND),
            isNull(issues.hiddenAt),
          ),
        );

      const membershipByAgentId = new Map(
        memberships.map((membership) => [membership.principalId, membership]),
      );
      const runtimeStateByAgentId = new Map(
        runtimeStates.map((runtimeState) => [runtimeState.agentId, runtimeState]),
      );
      const runsByAgentId = new Map<string, RunRow[]>();
      for (const run of activeRuns) {
        const list = runsByAgentId.get(run.agentId) ?? [];
        list.push(run);
        runsByAgentId.set(run.agentId, list);
      }
      const agentsByCompany = new Map<string, AgentRow[]>();
      const agentsById = new Map<string, AgentRow>();
      for (const agent of monitoredAgents) {
        const list = agentsByCompany.get(agent.companyId) ?? [];
        list.push(agent);
        agentsByCompany.set(agent.companyId, list);
        agentsById.set(agent.id, agent);
      }
      const openAlertByOriginId = new Map(
        openAlerts
          .filter((issue) => issue.originId)
          .map((issue) => [issue.originId as string, issue]),
      );
      const latestHistoricalAlertByOriginId = new Map<string, IssueRow>();
      for (const alert of historicalAlerts) {
        if (!alert.originId) continue;
        const existing = latestHistoricalAlertByOriginId.get(alert.originId);
        if (!existing) {
          latestHistoricalAlertByOriginId.set(alert.originId, alert);
          continue;
        }
        const existingTimestamp = existing.updatedAt ?? existing.createdAt;
        const nextTimestamp = alert.updatedAt ?? alert.createdAt;
        if (nextTimestamp.getTime() >= existingTimestamp.getTime()) {
          latestHistoricalAlertByOriginId.set(alert.originId, alert);
        }
      }

      const activeFindingByOriginId = new Map<string, HealthFinding>();
      const evaluatedOriginIds = new Set<string>();

      for (const agent of monitoredAgents) {
        if (agent.status === "paused") continue;

        const assigneeAgentId = resolveResponsibleAgentId(agent, agentsByCompany);
        const fastFindings = await evaluateAgentFastChecks({
          agent,
          assigneeAgentId,
          membership: membershipByAgentId.get(agent.id) ?? null,
          runtimeState: runtimeStateByAgentId.get(agent.id) ?? null,
          queuedRuns: runsByAgentId.get(agent.id) ?? [],
          now,
        });
        for (const finding of fastFindings) {
          activeFindingByOriginId.set(finding.originId, finding);
          evaluatedOriginIds.add(finding.originId);
        }
        for (const originId of [
          normalizeAlertOriginId(agent.id, "membership_inactive"),
          normalizeAlertOriginId(agent.id, "runtime_adapter_divergence"),
          normalizeAlertOriginId(agent.id, "heartbeat_stalled"),
          normalizeAlertOriginId(agent.id, "queued_without_consumer"),
        ]) {
          evaluatedOriginIds.add(originId);
        }

        const lastSlowCheckAt = adapterCheckCache.get(agent.id) ?? 0;
        if (now.getTime() - lastSlowCheckAt < adapterEnvironmentIntervalMs) continue;
        adapterCheckCache.set(agent.id, now.getTime());

        const bootstrapFindings = await evaluateManagedBootstrap(agent, assigneeAgentId, now);
        for (const finding of bootstrapFindings) {
          activeFindingByOriginId.set(finding.originId, finding);
          evaluatedOriginIds.add(finding.originId);
        }

        const environmentFindings = await evaluateAdapterEnvironment(agent, assigneeAgentId, now);
        for (const finding of environmentFindings) {
          activeFindingByOriginId.set(finding.originId, finding);
          evaluatedOriginIds.add(finding.originId);
        }

        const knownSlowCodes = [
          normalizeAlertOriginId(agent.id, "bootstrap_integrity"),
          normalizeAlertOriginId(agent.id, "unknown_adapter"),
          normalizeAlertOriginId(agent.id, "environment_resolution_failed"),
        ];
        for (const alert of openAlerts) {
          if (!alert.originId) continue;
          if (alert.originId.startsWith(`agent:${agent.id}:health:environment_`)) {
            evaluatedOriginIds.add(alert.originId);
          }
        }
        for (const originId of knownSlowCodes) {
          evaluatedOriginIds.add(originId);
        }
      }

      const reviewQueueFindings = await evaluateReviewQueueAlerts(agentsByCompany, agentsById, now);
      for (const finding of reviewQueueFindings) {
        activeFindingByOriginId.set(finding.originId, finding);
        evaluatedOriginIds.add(finding.originId);
      }
      for (const alert of openAlerts) {
        if (alert.originId?.includes(":review_queue:")) {
          evaluatedOriginIds.add(alert.originId);
        }
      }

      let created = 0;
      let updated = 0;
      let resolved = 0;

      for (const finding of activeFindingByOriginId.values()) {
        const existing = openAlertByOriginId.get(finding.originId) ?? null;
        if (!existing) {
          const reusable = latestHistoricalAlertByOriginId.get(finding.originId) ?? null;
          if (reusable) {
            const latestAlertTimestamp = reusable.updatedAt ?? reusable.createdAt;
            const withinCooldown =
              !isReviewQueueAlertOriginId(finding.originId)
              && now.getTime() - latestAlertTimestamp.getTime() < alertReopenCooldownMs;
            if (withinCooldown) {
              await logActivity(db, {
                companyId: finding.companyId,
                actorType: "system",
                actorId: "agent-health-monitor",
                action: "issue.health_alert_reopen_suppressed",
                entityType: "issue",
                entityId: reusable.id,
                agentId: parseAgentIdFromOrigin(finding.originId),
                details: {
                  originId: finding.originId,
                  cooldownMs: alertReopenCooldownMs,
                  latestAlertAt: latestAlertTimestamp.toISOString(),
                  reason: "recent_auto_resolve_cooldown",
                },
              });
              continue;
            }
            await issuesSvc.update(reusable.id, {
              status: "todo",
              title: finding.title,
              description: finding.description,
              priority: finding.priority,
              assigneeAgentId: finding.assigneeAgentId,
            });
            await issuesSvc.addComment(
              reusable.id,
              [
                "## Update",
                "",
                "- Agent health condition recurred for this same origin.",
                "- Reopening the existing alert instead of creating a new issue.",
              ].join("\n"),
              {},
            );
            updated += 1;
            continue;
          }
          await issuesSvc.create(finding.companyId, {
            title: finding.title,
            description: finding.description,
            status: "todo",
            priority: finding.priority,
            assigneeAgentId: finding.assigneeAgentId,
            originKind: AGENT_HEALTH_ALERT_ORIGIN_KIND,
            originId: finding.originId,
          });
          created += 1;
          continue;
        }

        if (!issuePatchNeeded(existing, finding)) continue;
        await issuesSvc.update(existing.id, {
          title: finding.title,
          description: finding.description,
          priority: finding.priority,
          assigneeAgentId: finding.assigneeAgentId,
        });
        updated += 1;
      }

      for (const alert of openAlerts) {
        if (!alert.originId || !evaluatedOriginIds.has(alert.originId)) continue;
        if (activeFindingByOriginId.has(alert.originId)) continue;
        await issuesSvc.addComment(
          alert.id,
          [
            "## Update",
            "",
            "- Agent health check passed again for this condition.",
            "- Closing the alert automatically.",
          ].join("\n"),
          {},
        );
        await issuesSvc.update(alert.id, { status: "cancelled" });
        resolved += 1;
      }

      return {
        checked: monitoredAgents.filter((agent) => agent.status !== "paused").length,
        findings: activeFindingByOriginId.size,
        created,
        updated,
        resolved,
      };
    },
  };
}
