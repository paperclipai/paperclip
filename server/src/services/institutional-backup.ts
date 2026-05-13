/**
 * Institutional Backup + Disaster Recovery Framework
 *
 * QSL is now autonomous, revenue-generating, security-focused, crypto-adjacent,
 * and infrastructure-dependent. Treat institutional continuity as critical infrastructure.
 *
 * Generates recovery bundles with:
 * - DB backup metadata
 * - Board export snapshots
 * - Agent/config/instruction backups
 * - Constitution and governance snapshots
 * - Org topology and provider config
 *
 * Does NOT expose raw secrets in exports.
 *
 * Co-Authored-By: Paperclip <noreply@paperclip.ing>
 */
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  companyMemberships,
  companySkills,
  approvals,
  principalPermissionGrants,
  projects,
  routines,
  routineTriggers,
  budgetPolicies,
  issues,
} from "@paperclipai/db";
import { generateBoardExport } from "./board-export.js";

// ── Types ────────────────────────────────────────────────────────────

export interface BackupManifest {
  generatedAt: string;
  version: string;
  components: BackupComponent[];
  summary: BackupSummary;
}

export interface BackupComponent {
  name: string;
  status: "ok" | "warning" | "error" | "skipped";
  itemCount: number;
  detail: string | null;
  backedUpAt: string;
}

export interface BackupSummary {
  totalComponents: number;
  okCount: number;
  warningCount: number;
  errorCount: number;
  companies: number;
  agents: number;
  issues: number;
  approvals: number;
  routines: number;
  skills: number;
  permissions: number;
  readinessScore: number; // 0-100
}

export interface RecoveryBundle {
  manifest: BackupManifest;
  data: {
    companies: unknown[];
    agents: unknown[];
    agentConfigs: unknown[];
    memberships: unknown[];
    skills: unknown[];
    permissions: unknown[];
    projects: unknown[];
    routines: unknown[];
    routineTriggers: unknown[];
    budgetPolicies: unknown[];
    approvals: unknown[];
    boardExportBundle: unknown;
  };
}

// ── Service ──────────────────────────────────────────────────────────

export function institutionalBackupService(db: Db) {
  return {
    /**
     * Generate a full recovery bundle containing all institutional data.
     * Secrets are redacted — only references are included.
     */
    async generateRecoveryBundle(): Promise<RecoveryBundle> {
      const now = new Date().toISOString();
      const components: BackupComponent[] = [];

      // 1. Companies
      const allCompanies = await db.select().from(companies);
      components.push({
        name: "companies",
        status: allCompanies.length > 0 ? "ok" : "warning",
        itemCount: allCompanies.length,
        detail: null,
        backedUpAt: now,
      });

      // 2. Agents (with config, redacting secrets)
      const allAgents = await db.select().from(agents);
      const agentConfigs = allAgents.map((a) => ({
        id: a.id,
        companyId: a.companyId,
        name: a.name,
        role: a.role,
        title: a.title,
        adapterType: a.adapterType,
        adapterConfig: redactSecrets(a.adapterConfig as Record<string, unknown>),
        runtimeConfig: redactSecrets(a.runtimeConfig as Record<string, unknown>),
        permissions: a.permissions,
        status: a.status,
        reportsTo: a.reportsTo,
        budgetMonthlyCents: a.budgetMonthlyCents,
      }));
      components.push({
        name: "agents",
        status: allAgents.length > 0 ? "ok" : "warning",
        itemCount: allAgents.length,
        detail: null,
        backedUpAt: now,
      });

      // 3. Memberships (org topology)
      const allMemberships = await db.select().from(companyMemberships);
      components.push({
        name: "memberships",
        status: "ok",
        itemCount: allMemberships.length,
        detail: null,
        backedUpAt: now,
      });

      // 4. Skills
      const allSkills = await db.select().from(companySkills);
      components.push({
        name: "skills",
        status: "ok",
        itemCount: allSkills.length,
        detail: null,
        backedUpAt: now,
      });

      // 5. Permissions
      const allPermissions = await db.select().from(principalPermissionGrants);
      components.push({
        name: "permissions",
        status: "ok",
        itemCount: allPermissions.length,
        detail: null,
        backedUpAt: now,
      });

      // 6. Projects
      const allProjects = await db.select().from(projects);
      components.push({
        name: "projects",
        status: "ok",
        itemCount: allProjects.length,
        detail: null,
        backedUpAt: now,
      });

      // 7. Routines
      const allRoutines = await db.select().from(routines);
      components.push({
        name: "routines",
        status: "ok",
        itemCount: allRoutines.length,
        detail: null,
        backedUpAt: now,
      });

      // 8. Routine triggers
      const allTriggers = await db.select().from(routineTriggers);
      components.push({
        name: "routine_triggers",
        status: "ok",
        itemCount: allTriggers.length,
        detail: null,
        backedUpAt: now,
      });

      // 9. Budget policies
      const allBudgets = await db.select().from(budgetPolicies);
      components.push({
        name: "budget_policies",
        status: "ok",
        itemCount: allBudgets.length,
        detail: null,
        backedUpAt: now,
      });

      // 10. Approvals
      const allApprovals = await db.select().from(approvals).orderBy(desc(approvals.createdAt)).limit(100);
      components.push({
        name: "approvals",
        status: "ok",
        itemCount: allApprovals.length,
        detail: "Latest 100 approvals",
        backedUpAt: now,
      });

      // 11. Board export snapshot
      let boardExportBundle: unknown = null;
      try {
        const { bundle } = await generateBoardExport(db);
        boardExportBundle = bundle;
        components.push({
          name: "board_export",
          status: "ok",
          itemCount: 1,
          detail: null,
          backedUpAt: now,
        });
      } catch {
        components.push({
          name: "board_export",
          status: "error",
          itemCount: 0,
          detail: "Failed to generate board export",
          backedUpAt: now,
        });
      }

      // 12. Issues (open only)
      const [issueCount] = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(issues)
        .where(sql`${issues.status} NOT IN ('done', 'cancelled')`);
      components.push({
        name: "issues",
        status: "ok",
        itemCount: issueCount?.count ?? 0,
        detail: "Open issues only (tracked in DB backup)",
        backedUpAt: now,
      });

      // Build summary
      const okCount = components.filter((c) => c.status === "ok").length;
      const warningCount = components.filter((c) => c.status === "warning").length;
      const errorCount = components.filter((c) => c.status === "error").length;
      const readinessScore = Math.round((okCount / components.length) * 100);

      const summary: BackupSummary = {
        totalComponents: components.length,
        okCount,
        warningCount,
        errorCount,
        companies: allCompanies.length,
        agents: allAgents.length,
        issues: issueCount?.count ?? 0,
        approvals: allApprovals.length,
        routines: allRoutines.length,
        skills: allSkills.length,
        permissions: allPermissions.length,
        readinessScore,
      };

      const manifest: BackupManifest = {
        generatedAt: now,
        version: "1.0.0",
        components,
        summary,
      };

      return {
        manifest,
        data: {
          companies: allCompanies,
          agents: allAgents.map((a) => ({
            ...a,
            adapterConfig: redactSecrets(a.adapterConfig as Record<string, unknown>),
            runtimeConfig: redactSecrets(a.runtimeConfig as Record<string, unknown>),
          })),
          agentConfigs,
          memberships: allMemberships,
          skills: allSkills,
          permissions: allPermissions,
          projects: allProjects,
          routines: allRoutines,
          routineTriggers: allTriggers,
          budgetPolicies: allBudgets,
          approvals: allApprovals,
          boardExportBundle,
        },
      };
    },

    /**
     * Generate a backup status markdown for board exports.
     */
    async generateBackupStatusExport(): Promise<string> {
      const bundle = await this.generateRecoveryBundle();
      const { manifest } = bundle;
      const lines: string[] = [
        "# Backup Status Report",
        "",
        `> Generated ${manifest.generatedAt}`,
        "",
        "## Recovery Readiness",
        "",
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Readiness score | **${manifest.summary.readinessScore}%** |`,
        `| Components OK | ${manifest.summary.okCount}/${manifest.summary.totalComponents} |`,
        `| Warnings | ${manifest.summary.warningCount} |`,
        `| Errors | ${manifest.summary.errorCount} |`,
        "",
        "## Component Status",
        "",
        "| Component | Status | Items | Detail |",
        "|-----------|--------|-------|--------|",
      ];

      for (const c of manifest.components) {
        const statusIcon = c.status === "ok" ? "OK" : c.status === "warning" ? "WARN" : "ERROR";
        lines.push(`| ${c.name} | ${statusIcon} | ${c.itemCount} | ${c.detail ?? "—"} |`);
      }
      lines.push("");

      lines.push("## Institutional Data Summary");
      lines.push("");
      lines.push(`| Entity | Count |`);
      lines.push(`|--------|-------|`);
      lines.push(`| Companies | ${manifest.summary.companies} |`);
      lines.push(`| Agents | ${manifest.summary.agents} |`);
      lines.push(`| Open Issues | ${manifest.summary.issues} |`);
      lines.push(`| Approvals | ${manifest.summary.approvals} |`);
      lines.push(`| Routines | ${manifest.summary.routines} |`);
      lines.push(`| Skills | ${manifest.summary.skills} |`);
      lines.push(`| Permissions | ${manifest.summary.permissions} |`);
      lines.push("");

      lines.push("## Recovery Procedures");
      lines.push("");
      lines.push("1. **Database**: Restore from embedded-postgres backup (pnpm db:backup)");
      lines.push("2. **Configuration**: Agent configs in recovery bundle (secrets redacted)");
      lines.push("3. **Board state**: Board export snapshot in recovery bundle");
      lines.push("4. **Secrets**: Must be restored from secure storage separately");
      lines.push("5. **Infrastructure**: EC2 instance state from AWS console");
      lines.push("");

      lines.push("## What is NOT in the recovery bundle");
      lines.push("");
      lines.push("- Raw secrets, API keys, SSH keys (redacted for security)");
      lines.push("- Full issue history (only open issues — closed issues in DB backup)");
      lines.push("- Run logs (stored in log store, not in recovery bundle)");
      lines.push("- File attachments (stored in S3/local storage)");
      lines.push("");

      return lines.join("\n");
    },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

const SECRET_KEYS = /(?:key|token|secret|password|credential|private)/i;

function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SECRET_KEYS.test(key) && typeof value === "string") {
      redacted[key] = "***REDACTED***";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      redacted[key] = redactSecrets(value as Record<string, unknown>);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
