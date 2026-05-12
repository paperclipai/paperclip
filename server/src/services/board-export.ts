/**
 * Board Intelligence Export Service
 *
 * Queries the Paperclip database and generates structured exports (JSON + Markdown)
 * for cross-tool reasoning by ChatGPT, Claude Code, and the Paperclip board.
 */
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  agents,
  projects,
  goals,
  issues,
  issueComments,
  approvals,
  routines,
  routineTriggers,
  budgetPolicies,
  budgetIncidents,
  costEvents,
  companySkills,
  companyMemberships,
  principalPermissionGrants,
} from "@paperclipai/db";

// ── Types ───────────────────────────────────────────────────────────────

export interface CompanyExport {
  id: string;
  name: string;
  prefix: string;
  description: string | null;
  status: string;
  budget_monthly_cents: number;
  spent_monthly_cents: number;
  require_board_approval: boolean;
  projects: Array<{
    id: string;
    name: string;
    description: string | null;
    status: string;
    lead_agent_id: string | null;
    target_date: string | null;
  }>;
  routines: Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    assignee_agent_id: string | null;
    priority: string;
  }>;
  budget_policies: Array<{
    id: string;
    scope_type: string;
    scope_id: string | null;
    metric: string;
    window_kind: string;
    amount: number;
    warn_percent: number;
    hard_stop_enabled: boolean;
    is_active: boolean;
  }>;
}

export interface AgentExport {
  id: string;
  company_id: string;
  company_name: string;
  name: string;
  title: string | null;
  role: string;
  reports_to: string | null;
  reports_to_name: string | null;
  adapter_type: string;
  adapter_config: unknown;
  runtime_config: unknown;
  permissions: unknown;
  status: string;
  budget_monthly_cents: number;
  spent_monthly_cents: number;
  last_heartbeat_at: string | null;
  capabilities: string | null;
  skills: string[];
  dangerous_permissions: {
    skip_permissions: boolean;
    bypass_sandbox: boolean;
  };
  heartbeat_policy: {
    enabled: boolean;
    interval_sec: number | null;
  };
}

export interface IssueExport {
  id: string;
  identifier: string;
  company_id: string;
  company_name: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_agent_id: string | null;
  assignee_agent_name: string | null;
  project_id: string | null;
  origin_kind: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  latest_comment: string | null;
  latest_comment_at: string | null;
}

export interface GovernanceExport {
  approval_rules: Array<{
    company_id: string;
    company_name: string;
    require_board_approval_for_new_agents: boolean;
  }>;
  pending_approvals: Array<{
    id: string;
    company_id: string;
    company_name: string;
    type: string;
    status: string;
    requested_by_agent_id: string | null;
    requested_by_agent_name: string | null;
    requested_by_user_id: string | null;
    title: string;
    summary: string;
    recommended_action: string;
    risks: string[];
    decision_note: string | null;
    created_at: string;
    duplicate_of: string | null;
    risk_level: string;
    recommendation: string;
  }>;
  permission_grants: Array<{
    id: string;
    company_id: string;
    principal_type: string;
    principal_id: string;
    permission_key: string;
    scope: unknown;
  }>;
  membership_roles: Array<{
    company_id: string;
    principal_type: string;
    membership_role: string;
    status: string;
    count: number;
  }>;
}

export interface CrawDaddyExport {
  payment_related_issues: IssueExport[];
  scan_delivery_issues: IssueExport[];
  fulfillment_issues: IssueExport[];
  budget_incidents: Array<{
    id: string;
    company_id: string;
    policy_id: string;
    scope_type: string;
    threshold_type: string;
    amount_limit: number;
    amount_observed: number;
    status: string;
    created_at: string;
    resolved_at: string | null;
  }>;
  recent_cost_events: Array<{
    id: string;
    company_id: string;
    agent_id: string | null;
    provider: string | null;
    model: string | null;
    cost_cents: number;
    occurred_at: string;
  }>;
}

export interface BoardExportBundle {
  generated_at: string;
  companies: CompanyExport[];
  agents: AgentExport[];
  issues: IssueExport[];
  governance: GovernanceExport;
  crawdaddy: CrawDaddyExport;
}

// ── Query functions ─────────────────────────────────────────────────────

async function exportCompanies(db: Db): Promise<CompanyExport[]> {
  const rows = await db.select().from(companies).orderBy(companies.name);
  const result: CompanyExport[] = [];

  for (const co of rows) {
    const companyProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.companyId, co.id))
      .orderBy(projects.name);

    const companyRoutines = await db
      .select()
      .from(routines)
      .where(eq(routines.companyId, co.id))
      .orderBy(routines.title);

    const companyBudgetPolicies = await db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.companyId, co.id));

    result.push({
      id: co.id,
      name: co.name,
      prefix: co.issuePrefix,
      description: co.description,
      status: co.status,
      budget_monthly_cents: co.budgetMonthlyCents,
      spent_monthly_cents: co.spentMonthlyCents,
      require_board_approval: co.requireBoardApprovalForNewAgents,
      projects: companyProjects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
        lead_agent_id: p.leadAgentId,
        target_date: p.targetDate ?? null,
      })),
      routines: companyRoutines.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        status: r.status,
        assignee_agent_id: r.assigneeAgentId,
        priority: r.priority,
      })),
      budget_policies: companyBudgetPolicies.map((bp) => ({
        id: bp.id,
        scope_type: bp.scopeType,
        scope_id: bp.scopeId,
        metric: bp.metric,
        window_kind: bp.windowKind,
        amount: bp.amount,
        warn_percent: bp.warnPercent,
        hard_stop_enabled: bp.hardStopEnabled,
        is_active: bp.isActive,
      })),
    });
  }

  return result;
}

async function exportAgents(db: Db): Promise<AgentExport[]> {
  const allAgents = await db.select().from(agents).orderBy(agents.name);
  const allCompanies = await db.select().from(companies);
  const companyMap = new Map(allCompanies.map((c) => [c.id, c.name]));
  const agentMap = new Map(allAgents.map((a) => [a.id, a.name]));

  const allSkills = await db.select().from(companySkills);
  // Build per-company skill lists for agent matching
  const companySkillMap = new Map<string, string[]>();
  for (const skill of allSkills) {
    const existing = companySkillMap.get(skill.companyId) ?? [];
    existing.push(skill.name);
    companySkillMap.set(skill.companyId, existing);
  }

  return allAgents.map((a) => {
    const adapterConfig = (a.adapterConfig ?? {}) as Record<string, unknown>;
    const runtimeConfig = (a.runtimeConfig ?? {}) as Record<string, unknown>;

    return {
      id: a.id,
      company_id: a.companyId,
      company_name: companyMap.get(a.companyId) ?? "unknown",
      name: a.name,
      title: a.title,
      role: a.role,
      reports_to: a.reportsTo,
      reports_to_name: a.reportsTo ? (agentMap.get(a.reportsTo) ?? null) : null,
      adapter_type: a.adapterType,
      adapter_config: a.adapterConfig,
      runtime_config: a.runtimeConfig,
      permissions: a.permissions,
      status: a.status,
      budget_monthly_cents: a.budgetMonthlyCents,
      spent_monthly_cents: a.spentMonthlyCents,
      last_heartbeat_at: a.lastHeartbeatAt?.toISOString() ?? null,
      capabilities: a.capabilities,
      skills: companySkillMap.get(a.companyId) ?? [],
      dangerous_permissions: {
        skip_permissions: adapterConfig.dangerouslySkipPermissions === true,
        bypass_sandbox: adapterConfig.dangerouslyBypassSandbox === true,
      },
      heartbeat_policy: {
        enabled: runtimeConfig.heartbeatEnabled === true,
        interval_sec: typeof runtimeConfig.intervalSec === "number" ? runtimeConfig.intervalSec : null,
      },
    };
  });
}

async function exportIssues(db: Db): Promise<IssueExport[]> {
  const allCompanies = await db.select().from(companies);
  const companyMap = new Map(allCompanies.map((c) => [c.id, c.name]));
  const allAgents = await db.select().from(agents);
  const agentMap = new Map(allAgents.map((a) => [a.id, a.name]));

  // Get open/active issues (not done/cancelled) — include recently completed too
  const rows = await db
    .select()
    .from(issues)
    .where(
      or(
        inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
        // Include issues completed in the last 7 days
        sql`${issues.completedAt} > now() - interval '7 days'`,
      ),
    )
    .orderBy(desc(issues.updatedAt))
    .limit(500);

  const result: IssueExport[] = [];

  for (const issue of rows) {
    // Get latest comment
    let latestComment: string | null = null;
    let latestCommentAt: string | null = null;

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(desc(issueComments.createdAt))
      .limit(1);

    if (comments.length > 0) {
      latestComment = comments[0].body;
      latestCommentAt = comments[0].createdAt.toISOString();
    }

    result.push({
      id: issue.id,
      identifier: issue.identifier ?? `${issue.issueNumber}`,
      company_id: issue.companyId,
      company_name: companyMap.get(issue.companyId) ?? "unknown",
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      assignee_agent_id: issue.assigneeAgentId,
      assignee_agent_name: issue.assigneeAgentId
        ? (agentMap.get(issue.assigneeAgentId) ?? null)
        : null,
      project_id: issue.projectId,
      origin_kind: issue.originKind,
      created_at: issue.createdAt.toISOString(),
      updated_at: issue.updatedAt.toISOString(),
      started_at: issue.startedAt?.toISOString() ?? null,
      completed_at: issue.completedAt?.toISOString() ?? null,
      latest_comment: latestComment,
      latest_comment_at: latestCommentAt,
    });
  }

  return result;
}

/**
 * Assess risk level of an approval based on its type and payload content.
 */
function assessApprovalRisk(type: string, payload: Record<string, unknown>): string {
  const risks = Array.isArray(payload.risks) ? payload.risks : [];
  const action = typeof payload.recommendedAction === "string" ? payload.recommendedAction.toLowerCase() : "";
  const title = typeof payload.title === "string" ? payload.title.toLowerCase() : "";
  const text = `${title} ${action}`;

  // High risk: financial transfers, credential changes, security group changes with 0.0.0.0/0
  if (text.includes("transfer") || text.includes("fund") || text.includes("send tao") || text.includes("send eth")) return "HIGH";
  if (text.includes("0.0.0.0/0") && text.includes("port")) return "MEDIUM";
  if (type === "hire_agent") return "MEDIUM";
  if (type === "budget_override_required") return "HIGH";
  if (text.includes("port") || text.includes("firewall") || text.includes("security group")) return "MEDIUM";
  if (risks.length >= 3) return "MEDIUM";

  return "LOW";
}

/**
 * Generate a recommendation for an approval based on its content.
 */
function generateApprovalRecommendation(
  type: string,
  payload: Record<string, unknown>,
  riskLevel: string,
  isDuplicate: boolean,
): string {
  if (isDuplicate) return "SUPERSEDE — duplicate of existing pending approval";

  const action = typeof payload.recommendedAction === "string" ? payload.recommendedAction : "";

  if (riskLevel === "HIGH") {
    return `REVIEW REQUIRED — ${type === "budget_override_required" ? "budget override" : "financial/security action"} needs explicit Board confirmation`;
  }
  if (riskLevel === "MEDIUM") {
    return action ? `Conditionally approve — verify: ${action.slice(0, 100)}` : "Review before approving";
  }
  return "Low risk — approve if action aligns with company objectives";
}

/**
 * Detect if a pending approval is a duplicate of another pending approval
 * by comparing normalized title + key identifiers.
 */
function detectDuplicateApprovals(
  pendingApprovals: Array<{ id: string; type: string; payload: Record<string, unknown> }>,
): Map<string, string> {
  const duplicateMap = new Map<string, string>(); // id → duplicate_of_id

  const fingerprints = new Map<string, string>(); // fingerprint → first approval id
  for (const a of pendingApprovals) {
    const title = typeof a.payload.title === "string" ? a.payload.title : "";
    const action = typeof a.payload.recommendedAction === "string" ? a.payload.recommendedAction : "";

    // Normalize: strip UUIDs, timestamps, whitespace differences
    const normalize = (s: string) =>
      s.toLowerCase()
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "")
        .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[^\s]*/g, "")
        .replace(/\s+/g, " ")
        .trim();

    // Extract key identifiers (wallet addresses, ports, IPs)
    const identifiers = action.match(/\b(0x[0-9a-fA-F]{6,}|5[A-Za-z0-9]{47}|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|port \d+)\b/gi) ?? [];
    const fp = [a.type, normalize(title), ...identifiers.map((id) => id.toLowerCase())].join("|");

    const existing = fingerprints.get(fp);
    if (existing) {
      duplicateMap.set(a.id, existing);
    } else {
      fingerprints.set(fp, a.id);
    }
  }

  return duplicateMap;
}

async function exportGovernance(db: Db): Promise<GovernanceExport> {
  const allCompanies = await db.select().from(companies);
  const companyMap = new Map(allCompanies.map((c) => [c.id, c.name]));
  const allAgents = await db.select().from(agents);
  const agentMap = new Map(allAgents.map((a) => [a.id, a.name]));

  const approvalRules = allCompanies.map((c) => ({
    company_id: c.id,
    company_name: c.name,
    require_board_approval_for_new_agents: c.requireBoardApprovalForNewAgents,
  }));

  const pendingApprovals = await db
    .select()
    .from(approvals)
    .where(eq(approvals.status, "pending"))
    .orderBy(desc(approvals.createdAt));

  // Detect duplicates among pending approvals
  const duplicateMap = detectDuplicateApprovals(
    pendingApprovals.map((a) => ({
      id: a.id,
      type: a.type,
      payload: (a.payload ?? {}) as Record<string, unknown>,
    })),
  );

  const grants = await db.select().from(principalPermissionGrants);

  // Aggregate membership roles
  const memberships = await db.select().from(companyMemberships);
  const roleCounts = new Map<string, number>();
  const roleEntries: GovernanceExport["membership_roles"] = [];
  for (const m of memberships) {
    const key = `${m.companyId}|${m.principalType}|${m.membershipRole}|${m.status}`;
    roleCounts.set(key, (roleCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of roleCounts) {
    const [companyId, principalType, membershipRole, status] = key.split("|");
    roleEntries.push({ company_id: companyId, principal_type: principalType, membership_role: membershipRole, status, count });
  }

  return {
    approval_rules: approvalRules,
    pending_approvals: pendingApprovals.map((a) => {
      const payload = (a.payload ?? {}) as Record<string, unknown>;
      const title = typeof payload.title === "string" ? payload.title : a.type;
      const summary = typeof payload.summary === "string" ? payload.summary : "";
      const recommendedAction = typeof payload.recommendedAction === "string" ? payload.recommendedAction : "";
      const risks = Array.isArray(payload.risks) ? payload.risks.map(String) : [];
      const isDuplicate = duplicateMap.has(a.id);
      const riskLevel = assessApprovalRisk(a.type, payload);
      const recommendation = generateApprovalRecommendation(a.type, payload, riskLevel, isDuplicate);

      return {
        id: a.id,
        company_id: a.companyId,
        company_name: companyMap.get(a.companyId) ?? "unknown",
        type: a.type,
        status: a.status,
        requested_by_agent_id: a.requestedByAgentId,
        requested_by_agent_name: a.requestedByAgentId ? (agentMap.get(a.requestedByAgentId) ?? null) : null,
        requested_by_user_id: a.requestedByUserId,
        title,
        summary,
        recommended_action: recommendedAction,
        risks,
        decision_note: a.decisionNote,
        created_at: a.createdAt.toISOString(),
        duplicate_of: duplicateMap.get(a.id) ?? null,
        risk_level: riskLevel,
        recommendation,
      };
    }),
    permission_grants: grants.map((g) => ({
      id: g.id,
      company_id: g.companyId,
      principal_type: g.principalType,
      principal_id: g.principalId,
      permission_key: g.permissionKey,
      scope: g.scope,
    })),
    membership_roles: roleEntries,
  };
}

async function exportCrawDaddy(db: Db, allIssues: IssueExport[]): Promise<CrawDaddyExport> {
  // Filter issues by CrawDaddy-relevant keywords
  const paymentKeywords = ["payment", "charge", "billing", "invoice", "stripe", "price"];
  const scanKeywords = ["scan", "delivery", "crawl", "scrape", "fetch"];
  const fulfillmentKeywords = ["fulfillment", "fulfill", "refund", "retry", "failed"];

  const matchesAny = (issue: IssueExport, keywords: string[]) => {
    const text = `${issue.title} ${issue.description ?? ""}`.toLowerCase();
    return keywords.some((kw) => text.includes(kw));
  };

  const paymentIssues = allIssues.filter((i) => matchesAny(i, paymentKeywords));
  const scanIssues = allIssues.filter((i) => matchesAny(i, scanKeywords));
  const fulfillmentIssues = allIssues.filter((i) => matchesAny(i, fulfillmentKeywords));

  // Budget incidents
  const incidents = await db
    .select()
    .from(budgetIncidents)
    .orderBy(desc(budgetIncidents.createdAt))
    .limit(50);

  // Recent cost events (last 24h)
  const recentCosts = await db
    .select()
    .from(costEvents)
    .where(sql`${costEvents.occurredAt} > now() - interval '24 hours'`)
    .orderBy(desc(costEvents.occurredAt))
    .limit(100);

  return {
    payment_related_issues: paymentIssues,
    scan_delivery_issues: scanIssues,
    fulfillment_issues: fulfillmentIssues,
    budget_incidents: incidents.map((bi) => ({
      id: bi.id,
      company_id: bi.companyId,
      policy_id: bi.policyId,
      scope_type: bi.scopeType,
      threshold_type: bi.thresholdType,
      amount_limit: bi.amountLimit,
      amount_observed: bi.amountObserved,
      status: bi.status,
      created_at: bi.createdAt.toISOString(),
      resolved_at: bi.resolvedAt?.toISOString() ?? null,
    })),
    recent_cost_events: recentCosts.map((ce) => ({
      id: ce.id,
      company_id: ce.companyId,
      agent_id: ce.agentId ?? null,
      provider: ce.provider ?? null,
      model: ce.model ?? null,
      cost_cents: ce.costCents,
      occurred_at: ce.occurredAt.toISOString(),
    })),
  };
}

// ── Markdown generators ────────────────────────────────────────────────

function companyMapMd(companyExports: CompanyExport[]): string {
  const lines: string[] = ["# Company Map", "", `> Generated ${new Date().toISOString()}`, ""];

  for (const co of companyExports) {
    lines.push(`## ${co.name} (\`${co.prefix}\`)`);
    lines.push("");
    lines.push(`- **Status:** ${co.status}`);
    lines.push(`- **Description:** ${co.description ?? "—"}`);
    lines.push(`- **Budget:** $${(co.budget_monthly_cents / 100).toFixed(2)}/mo (spent: $${(co.spent_monthly_cents / 100).toFixed(2)})`);
    lines.push(`- **Board approval required for new agents:** ${co.require_board_approval ? "Yes" : "No"}`);
    lines.push("");

    if (co.projects.length > 0) {
      lines.push("### Projects");
      lines.push("");
      lines.push("| Name | Status | Lead Agent | Target Date |");
      lines.push("|------|--------|------------|-------------|");
      for (const p of co.projects) {
        lines.push(`| ${p.name} | ${p.status} | ${p.lead_agent_id ?? "—"} | ${p.target_date ?? "—"} |`);
      }
      lines.push("");
    }

    if (co.routines.length > 0) {
      lines.push("### Routines");
      lines.push("");
      lines.push("| Title | Status | Priority | Assignee |");
      lines.push("|-------|--------|----------|----------|");
      for (const r of co.routines) {
        lines.push(`| ${r.title} | ${r.status} | ${r.priority} | ${r.assignee_agent_id ?? "—"} |`);
      }
      lines.push("");
    }

    if (co.budget_policies.length > 0) {
      lines.push("### Budget Policies");
      lines.push("");
      lines.push("| Scope | Metric | Window | Amount | Warn% | Hard Stop | Active |");
      lines.push("|-------|--------|--------|--------|-------|-----------|--------|");
      for (const bp of co.budget_policies) {
        lines.push(`| ${bp.scope_type} | ${bp.metric} | ${bp.window_kind} | $${(bp.amount / 100).toFixed(2)} | ${bp.warn_percent}% | ${bp.hard_stop_enabled ? "Yes" : "No"} | ${bp.is_active ? "Yes" : "No"} |`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function agentsMd(agentExports: AgentExport[]): string {
  const lines: string[] = ["# Agents", "", `> Generated ${new Date().toISOString()}`, ""];

  // Group by company
  const byCompany = new Map<string, AgentExport[]>();
  for (const a of agentExports) {
    const list = byCompany.get(a.company_name) ?? [];
    list.push(a);
    byCompany.set(a.company_name, list);
  }

  for (const [companyName, companyAgents] of byCompany) {
    lines.push(`## ${companyName}`);
    lines.push("");
    lines.push("| Agent | Title | Role | Reports To | Adapter | Status | Heartbeat | Dangerous Perms |");
    lines.push("|-------|-------|------|------------|---------|--------|-----------|-----------------|");

    for (const a of companyAgents) {
      const dangerFlags: string[] = [];
      if (a.dangerous_permissions.skip_permissions) dangerFlags.push("skip-perms");
      if (a.dangerous_permissions.bypass_sandbox) dangerFlags.push("bypass-sandbox");
      const danger = dangerFlags.length > 0 ? dangerFlags.join(", ") : "none";
      const heartbeat = a.heartbeat_policy.enabled
        ? `every ${a.heartbeat_policy.interval_sec ?? "?"}s`
        : "disabled";
      const reportsTo = a.reports_to_name ?? "—";

      lines.push(`| **${a.name}** | ${a.title ?? "—"} | ${a.role} | ${reportsTo} | ${a.adapter_type} | ${a.status} | ${heartbeat} | ${danger} |`);
    }
    lines.push("");

    // Detailed agent blocks
    for (const a of companyAgents) {
      lines.push(`### ${a.name}`);
      lines.push("");
      lines.push(`- **ID:** \`${a.id}\``);
      lines.push(`- **Role:** ${a.role}`);
      lines.push(`- **Title:** ${a.title ?? "—"}`);
      lines.push(`- **Status:** ${a.status}`);
      lines.push(`- **Adapter:** ${a.adapter_type}`);
      lines.push(`- **Reports to:** ${a.reports_to_name ?? "—"}`);
      lines.push(`- **Budget:** $${(a.budget_monthly_cents / 100).toFixed(2)}/mo (spent: $${(a.spent_monthly_cents / 100).toFixed(2)})`);
      lines.push(`- **Last heartbeat:** ${a.last_heartbeat_at ?? "never"}`);
      lines.push(`- **Capabilities:** ${a.capabilities ?? "—"}`);
      if (a.skills.length > 0) {
        lines.push(`- **Skills:** ${a.skills.join(", ")}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function issuesMd(issueExports: IssueExport[]): string {
  const lines: string[] = ["# Issues", "", `> Generated ${new Date().toISOString()}`, ""];

  const urgent = issueExports.filter((i) => i.priority === "critical" || i.priority === "high");
  const blocked = issueExports.filter((i) => i.status === "blocked");
  const inProgress = issueExports.filter((i) => i.status === "in_progress");
  const open = issueExports.filter((i) => ["backlog", "todo", "in_progress", "in_review", "blocked"].includes(i.status));

  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- **Total open:** ${open.length}`);
  lines.push(`- **Urgent/High priority:** ${urgent.length}`);
  lines.push(`- **Blocked:** ${blocked.length}`);
  lines.push(`- **In progress:** ${inProgress.length}`);
  lines.push("");

  if (urgent.length > 0) {
    lines.push("## Urgent / High Priority");
    lines.push("");
    lines.push("| ID | Title | Status | Priority | Assignee | Updated |");
    lines.push("|----|-------|--------|----------|----------|---------|");
    for (const i of urgent) {
      lines.push(`| ${i.identifier} | ${i.title} | ${i.status} | ${i.priority} | ${i.assignee_agent_name ?? "—"} | ${i.updated_at.split("T")[0]} |`);
    }
    lines.push("");
  }

  if (blocked.length > 0) {
    lines.push("## Blocked");
    lines.push("");
    lines.push("| ID | Title | Priority | Assignee | Updated |");
    lines.push("|----|-------|----------|----------|---------|");
    for (const i of blocked) {
      lines.push(`| ${i.identifier} | ${i.title} | ${i.priority} | ${i.assignee_agent_name ?? "—"} | ${i.updated_at.split("T")[0]} |`);
    }
    lines.push("");
  }

  lines.push("## All Open Issues");
  lines.push("");
  lines.push("| ID | Company | Title | Status | Priority | Assignee | Origin | Updated |");
  lines.push("|----|---------|-------|--------|----------|----------|--------|---------|");
  for (const i of open) {
    lines.push(`| ${i.identifier} | ${i.company_name} | ${i.title} | ${i.status} | ${i.priority} | ${i.assignee_agent_name ?? "—"} | ${i.origin_kind ?? "—"} | ${i.updated_at.split("T")[0]} |`);
  }
  lines.push("");

  return lines.join("\n");
}

function governanceMd(gov: GovernanceExport): string {
  const lines: string[] = ["# Governance", "", `> Generated ${new Date().toISOString()}`, ""];

  lines.push("## Approval Rules by Company");
  lines.push("");
  lines.push("| Company | Board Approval for New Agents |");
  lines.push("|---------|------------------------------|");
  for (const rule of gov.approval_rules) {
    lines.push(`| ${rule.company_name} | ${rule.require_board_approval_for_new_agents ? "Required" : "Not required"} |`);
  }
  lines.push("");

  // ── Approval Review Packet ──────────────────────────────────────────
  lines.push("## Approval Review Packet");
  lines.push("");
  lines.push("> **GOVERNANCE RULE:** Board approvals may not be bulk-approved or bulk-denied.");
  lines.push("> Each approval requires individual review. Explicit Board decision required per item.");
  lines.push("");

  if (gov.pending_approvals.length > 0) {
    const duplicates = gov.pending_approvals.filter((a) => a.duplicate_of);
    const unique = gov.pending_approvals.filter((a) => !a.duplicate_of);

    lines.push(`**${gov.pending_approvals.length} pending** (${unique.length} unique, ${duplicates.length} duplicates detected)`);
    lines.push("");

    // Summary table
    lines.push("| # | Title | Requester | Risk | Duplicate? | Decision |");
    lines.push("|---|-------|-----------|------|------------|----------|");
    for (let i = 0; i < gov.pending_approvals.length; i++) {
      const a = gov.pending_approvals[i];
      const requester = a.requested_by_agent_name ?? a.requested_by_user_id ?? "unknown";
      const dup = a.duplicate_of ? `Yes (of ${a.duplicate_of.slice(0, 8)}…)` : "No";
      lines.push(`| ${i + 1} | ${a.title} | ${requester} | **${a.risk_level}** | ${dup} | PENDING |`);
    }
    lines.push("");

    // Detailed per-approval review
    for (let i = 0; i < gov.pending_approvals.length; i++) {
      const a = gov.pending_approvals[i];
      lines.push(`### Approval ${i + 1}: ${a.title}`);
      lines.push("");
      lines.push(`- **ID:** \`${a.id}\``);
      lines.push(`- **Company:** ${a.company_name}`);
      lines.push(`- **Type:** ${a.type}`);
      lines.push(`- **Requester:** ${a.requested_by_agent_name ?? a.requested_by_user_id ?? "unknown"} (${a.requested_by_agent_id ? `agent:${a.requested_by_agent_id.slice(0, 8)}…` : `user:${a.requested_by_user_id ?? "?"}`})`);
      lines.push(`- **Created:** ${a.created_at}`);
      lines.push(`- **Risk Level:** **${a.risk_level}**`);
      if (a.duplicate_of) {
        lines.push(`- **DUPLICATE OF:** \`${a.duplicate_of}\``);
      }
      lines.push("");
      if (a.summary) {
        lines.push(`**Summary:** ${a.summary}`);
        lines.push("");
      }
      if (a.recommended_action) {
        lines.push(`**Requested Action:** ${a.recommended_action}`);
        lines.push("");
      }
      if (a.risks.length > 0) {
        lines.push("**Risks:**");
        for (const risk of a.risks) {
          lines.push(`- ${risk}`);
        }
        lines.push("");
      }
      lines.push(`**Recommendation:** ${a.recommendation}`);
      lines.push("");
      lines.push("**Board Decision:** ___________________ (APPROVE / DENY / REQUEST REVISION)");
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  } else {
    lines.push("No pending approvals.");
    lines.push("");
  }

  if (gov.permission_grants.length > 0) {
    lines.push("## Permission Grants");
    lines.push("");
    lines.push("| Principal Type | Permission | Company |");
    lines.push("|---------------|------------|---------|");
    for (const g of gov.permission_grants) {
      lines.push(`| ${g.principal_type} | ${g.permission_key} | ${g.company_id.slice(0, 8)}… |`);
    }
    lines.push("");
  }

  if (gov.membership_roles.length > 0) {
    lines.push("## Authority Tiers (Membership Roles)");
    lines.push("");
    lines.push("| Company | Principal Type | Role | Status | Count |");
    lines.push("|---------|---------------|------|--------|-------|");
    for (const m of gov.membership_roles) {
      lines.push(`| ${m.company_id.slice(0, 8)}… | ${m.principal_type} | ${m.membership_role} | ${m.status} | ${m.count} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function crawDaddyMd(cd: CrawDaddyExport): string {
  const lines: string[] = [
    "# CrawDaddy Transaction Integrity",
    "",
    `> Generated ${new Date().toISOString()}`,
    "",
  ];

  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Payment-related issues:** ${cd.payment_related_issues.length}`);
  lines.push(`- **Scan/delivery issues:** ${cd.scan_delivery_issues.length}`);
  lines.push(`- **Fulfillment issues:** ${cd.fulfillment_issues.length}`);
  lines.push(`- **Budget incidents:** ${cd.budget_incidents.length}`);
  lines.push(`- **Cost events (last 24h):** ${cd.recent_cost_events.length}`);
  lines.push("");

  if (cd.payment_related_issues.length > 0) {
    lines.push("## Payment-Related Issues");
    lines.push("");
    lines.push("| ID | Title | Status | Priority | Assignee |");
    lines.push("|----|-------|--------|----------|----------|");
    for (const i of cd.payment_related_issues) {
      lines.push(`| ${i.identifier} | ${i.title} | ${i.status} | ${i.priority} | ${i.assignee_agent_name ?? "—"} |`);
    }
    lines.push("");
  }

  if (cd.scan_delivery_issues.length > 0) {
    lines.push("## Scan / Delivery Issues");
    lines.push("");
    lines.push("| ID | Title | Status | Priority | Assignee |");
    lines.push("|----|-------|--------|----------|----------|");
    for (const i of cd.scan_delivery_issues) {
      lines.push(`| ${i.identifier} | ${i.title} | ${i.status} | ${i.priority} | ${i.assignee_agent_name ?? "—"} |`);
    }
    lines.push("");
  }

  if (cd.fulfillment_issues.length > 0) {
    lines.push("## Fulfillment Issues");
    lines.push("");
    lines.push("| ID | Title | Status | Priority | Assignee |");
    lines.push("|----|-------|--------|----------|----------|");
    for (const i of cd.fulfillment_issues) {
      lines.push(`| ${i.identifier} | ${i.title} | ${i.status} | ${i.priority} | ${i.assignee_agent_name ?? "—"} |`);
    }
    lines.push("");
  }

  if (cd.budget_incidents.length > 0) {
    lines.push("## Budget Incidents");
    lines.push("");
    lines.push("| Scope | Threshold | Limit | Observed | Status | Date |");
    lines.push("|-------|-----------|-------|----------|--------|------|");
    for (const bi of cd.budget_incidents) {
      lines.push(`| ${bi.scope_type} | ${bi.threshold_type} | $${(bi.amount_limit / 100).toFixed(2)} | $${(bi.amount_observed / 100).toFixed(2)} | ${bi.status} | ${bi.created_at.split("T")[0]} |`);
    }
    lines.push("");
  }

  if (cd.recent_cost_events.length > 0) {
    const totalCents = cd.recent_cost_events.reduce((sum, ce) => sum + ce.cost_cents, 0);
    lines.push("## Recent Cost Events (Last 24h)");
    lines.push("");
    lines.push(`**Total cost:** $${(totalCents / 100).toFixed(2)}`);
    lines.push("");
    lines.push("| Provider | Model | Cost | Agent | Time |");
    lines.push("|----------|-------|------|-------|------|");
    for (const ce of cd.recent_cost_events.slice(0, 25)) {
      lines.push(`| ${ce.provider ?? "—"} | ${ce.model ?? "—"} | $${(ce.cost_cents / 100).toFixed(4)} | ${ce.agent_id?.slice(0, 8) ?? "—"} | ${ce.occurred_at} |`);
    }
    if (cd.recent_cost_events.length > 25) {
      lines.push(`| … | … | … | … | *(${cd.recent_cost_events.length - 25} more)* |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function boardReviewPacketMd(bundle: BoardExportBundle): string {
  const lines: string[] = [
    "# Board Review Packet",
    "",
    `> Generated ${bundle.generated_at}`,
    "",
    "This packet summarizes the current operational state of all Paperclip-managed companies, agents, and issues.",
    "",
  ];

  // Executive summary
  const activeCompanies = bundle.companies.filter((c) => c.status === "active");
  const activeAgents = bundle.agents.filter((a) => a.status === "active" || a.status === "running" || a.status === "idle");
  const openIssues = bundle.issues.filter((i) => ["backlog", "todo", "in_progress", "in_review", "blocked"].includes(i.status));
  const criticalIssues = bundle.issues.filter((i) => i.priority === "critical");
  const blockedIssues = bundle.issues.filter((i) => i.status === "blocked");

  lines.push("## Executive Summary");
  lines.push("");
  lines.push(`| Metric | Count |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Active companies | ${activeCompanies.length} |`);
  lines.push(`| Active agents | ${activeAgents.length} |`);
  lines.push(`| Open issues | ${openIssues.length} |`);
  lines.push(`| Critical issues | ${criticalIssues.length} |`);
  lines.push(`| Blocked issues | ${blockedIssues.length} |`);
  lines.push(`| Pending approvals | ${bundle.governance.pending_approvals.length} |`);
  lines.push(`| Budget incidents | ${bundle.crawdaddy.budget_incidents.length} |`);
  lines.push("");

  // Company overview
  lines.push("## Companies");
  lines.push("");
  for (const co of bundle.companies) {
    const coAgents = bundle.agents.filter((a) => a.company_id === co.id);
    const coIssues = openIssues.filter((i) => i.company_id === co.id);
    lines.push(`### ${co.name} (\`${co.prefix}\`) — ${co.status}`);
    lines.push("");
    lines.push(`- Agents: ${coAgents.length} | Projects: ${co.projects.length} | Open issues: ${coIssues.length}`);
    lines.push(`- Budget: $${(co.budget_monthly_cents / 100).toFixed(2)}/mo (spent: $${(co.spent_monthly_cents / 100).toFixed(2)})`);
    lines.push("");
  }

  // Critical items
  if (criticalIssues.length > 0) {
    lines.push("## Critical Issues");
    lines.push("");
    for (const i of criticalIssues) {
      lines.push(`- **${i.identifier}** — ${i.title} (${i.status}, assigned: ${i.assignee_agent_name ?? "unassigned"})`);
    }
    lines.push("");
  }

  if (blockedIssues.length > 0) {
    lines.push("## Blocked Issues");
    lines.push("");
    for (const i of blockedIssues) {
      lines.push(`- **${i.identifier}** — ${i.title} (assigned: ${i.assignee_agent_name ?? "unassigned"})`);
    }
    lines.push("");
  }

  // Governance alerts
  if (bundle.governance.pending_approvals.length > 0) {
    const uniqueApprovals = bundle.governance.pending_approvals.filter((a) => !a.duplicate_of);
    const dupCount = bundle.governance.pending_approvals.length - uniqueApprovals.length;
    lines.push("## Pending Governance Approvals");
    lines.push("");
    lines.push("> **Do not bulk-approve.** See `governance.md` for full Approval Review Packet.");
    lines.push("");
    for (const a of bundle.governance.pending_approvals) {
      const dup = a.duplicate_of ? " **[DUPLICATE]**" : "";
      lines.push(`- **${a.title}** — ${a.risk_level} risk | ${a.requested_by_agent_name ?? "unknown"} | ${a.created_at.split("T")[0]}${dup}`);
    }
    if (dupCount > 0) {
      lines.push("");
      lines.push(`*${dupCount} duplicate(s) detected — recommend superseding.*`);
    }
    lines.push("");
  }

  // CrawDaddy alerts
  const cdAlerts = bundle.crawdaddy.budget_incidents.filter((bi) => bi.status === "open");
  if (cdAlerts.length > 0) {
    lines.push("## Open Budget Incidents");
    lines.push("");
    for (const bi of cdAlerts) {
      lines.push(`- **${bi.scope_type}** ${bi.threshold_type} breach: $${(bi.amount_observed / 100).toFixed(2)} / $${(bi.amount_limit / 100).toFixed(2)} limit (${bi.status})`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("*See individual export files for full details: `company_map.md`, `agents.md`, `issues.md`, `governance.md`, `crawdaddy_transaction_integrity.md`*");
  lines.push("");

  return lines.join("\n");
}

// ── Main export function ───────────────────────────────────────────────

export async function generateBoardExport(db: Db): Promise<{
  bundle: BoardExportBundle;
  files: Record<string, string>;
}> {
  const generatedAt = new Date().toISOString();

  const [companyExports, agentExports, issueExports, governanceExport] = await Promise.all([
    exportCompanies(db),
    exportAgents(db),
    exportIssues(db),
    exportGovernance(db),
  ]);

  const crawDaddyExport = await exportCrawDaddy(db, issueExports);

  const bundle: BoardExportBundle = {
    generated_at: generatedAt,
    companies: companyExports,
    agents: agentExports,
    issues: issueExports,
    governance: governanceExport,
    crawdaddy: crawDaddyExport,
  };

  const files: Record<string, string> = {
    "company_map.json": JSON.stringify(companyExports, null, 2),
    "company_map.md": companyMapMd(companyExports),
    "agents.json": JSON.stringify(agentExports, null, 2),
    "agents.md": agentsMd(agentExports),
    "issues.json": JSON.stringify(issueExports, null, 2),
    "issues.md": issuesMd(issueExports),
    "governance.md": governanceMd(governanceExport),
    "crawdaddy_transaction_integrity.md": crawDaddyMd(crawDaddyExport),
    "board_review_packet.md": boardReviewPacketMd(bundle),
  };

  return { bundle, files };
}
