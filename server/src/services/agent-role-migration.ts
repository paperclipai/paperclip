import { eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals } from "@paperclipai/db";
import { canonicalizeAgentRole } from "@paperclipai/shared";
import { agentInstructionsService } from "./agent-instructions.js";
import { loadDefaultAgentInstructionsBundle } from "./default-agent-instructions.js";

export const LEGACY_GENERIC_DEFAULT_AGENT_INSTRUCTIONS_BASELINE = `You are an agent at Paperclip company.

Keep the work moving until it's done. If you need QA to review it, ask them. If you need your boss to review it, ask them. If someone needs to unblock you, assign them the ticket with a comment asking for what you need. Don't let work just sit here. You must always update your task with a comment.
`;

export const CURRENT_SHARED_DEFAULT_AGENT_INSTRUCTIONS_BASELINE = `You are an agent at a Paperclip company.

Keep the work moving until it is done. Do not let work sit without visible issue-level truth.

## Shared Workflow Rules

- Always leave a task comment describing what you did, what changed, and who owns the next action.
- Use explicit issue-level markers when relevant: \`[BLOCKER]\`, \`[HANDOFF]\`, \`[READY FOR QA]\`, \`[QA ROUTE]\`, \`[QA PASS]\`, \`[RELEASE CONFIRMED]\`, \`[POISONED SESSION]\`, \`[RECOVERED BY REISSUE]\`.
- If you need QA, your manager, or another specialist, assign or ping them with a concrete ask.
- \`Backlog\` means not started.
- \`Todo\` means ready to start.
- \`In Progress\` means active implementation or rework.
- \`In Review\` means the issue is waiting for QA.
- \`Done\` means QA passed and the release is confirmed.
- A source issue linked by \`recovered_by\` may remain \`blocked\` as a valid recovery state. Do not cancel it just because a continuation issue exists.
`;

const SAFE_MANAGED_BUNDLE_RESEED_BASELINES = new Set([
  LEGACY_GENERIC_DEFAULT_AGENT_INSTRUCTIONS_BASELINE,
  CURRENT_SHARED_DEFAULT_AGENT_INSTRUCTIONS_BASELINE,
]);

type AgentRow = typeof agents.$inferSelect;

export type AgentRoleMigrationReport = {
  apply: boolean;
  agentRolesUpdated: number;
  agentRolesAlreadyCanonical: number;
  approvalPayloadsUpdated: number;
  approvalPayloadsAlreadyCanonical: number;
  managedBundlesReseeded: number;
  managedBundlesPreserved: number;
};

function normalizeHireApprovalPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const nextRole = typeof record.role === "string" ? canonicalizeAgentRole(record.role) : record.role;
  if (nextRole === record.role) return record;
  return {
    ...record,
    role: nextRole,
  };
}

export function isSafeManagedBundleReseedCandidate(input: {
  mode: string | null;
  entryFile: string;
  filePaths: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  entryContent: string;
}) {
  return (
    input.mode === "managed"
    && input.entryFile === "AGENTS.md"
    && input.filePaths.length === 1
    && input.filePaths[0] === "AGENTS.md"
    && !input.legacyPromptTemplateActive
    && !input.legacyBootstrapPromptTemplateActive
    && SAFE_MANAGED_BUNDLE_RESEED_BASELINES.has(input.entryContent)
  );
}

export function agentRoleMigrationService(db: Db) {
  const instructions = agentInstructionsService();

  async function migrateAgentRole(agent: AgentRow, apply: boolean) {
    const canonicalRole = canonicalizeAgentRole(agent.role);
    if (canonicalRole === agent.role) {
      return {
        updated: false,
        agent,
      };
    }

    if (!apply) {
      return {
        updated: true,
        agent: {
          ...agent,
          role: canonicalRole,
        },
      };
    }

    const updated = await db
      .update(agents)
      .set({
        role: canonicalRole,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agent.id))
      .returning()
      .then((rows) => rows[0] ?? { ...agent, role: canonicalRole });

    return {
      updated: true,
      agent: updated,
    };
  }

  async function maybeReseedManagedBundle(agent: AgentRow, apply: boolean) {
    const bundle = await instructions.getBundle(agent);
    const filePaths = bundle.files.map((file) => file.path).sort();
    const entryContent = filePaths.includes("AGENTS.md")
      ? (await instructions.readFile(agent, "AGENTS.md")).content
      : "";
    const shouldReseed = isSafeManagedBundleReseedCandidate({
      mode: bundle.mode,
      entryFile: bundle.entryFile,
      filePaths,
      legacyPromptTemplateActive: bundle.legacyPromptTemplateActive,
      legacyBootstrapPromptTemplateActive: bundle.legacyBootstrapPromptTemplateActive,
      entryContent,
    });
    if (!shouldReseed) return false;
    if (!apply) return true;

    const cooBundle = await loadDefaultAgentInstructionsBundle("coo");
    const materialized = await instructions.materializeManagedBundle(agent, cooBundle, {
      entryFile: "AGENTS.md",
      replaceExisting: true,
      clearLegacyPromptTemplate: true,
    });
    await db
      .update(agents)
      .set({
        adapterConfig: materialized.adapterConfig,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agent.id));
    return true;
  }

  return {
    async migrateOperationsToCoo(options?: { apply?: boolean }): Promise<AgentRoleMigrationReport> {
      const apply = options?.apply === true;
      const report: AgentRoleMigrationReport = {
        apply,
        agentRolesUpdated: 0,
        agentRolesAlreadyCanonical: 0,
        approvalPayloadsUpdated: 0,
        approvalPayloadsAlreadyCanonical: 0,
        managedBundlesReseeded: 0,
        managedBundlesPreserved: 0,
      };

      const roleCandidates = await db
        .select()
        .from(agents)
        .where(inArray(agents.role, ["operations", "coo"]));

      for (const candidate of roleCandidates) {
        const migrated = await migrateAgentRole(candidate, apply);
        if (migrated.updated) report.agentRolesUpdated += 1;
        else report.agentRolesAlreadyCanonical += 1;

        const reseeded = await maybeReseedManagedBundle(migrated.agent, apply);
        if (reseeded) report.managedBundlesReseeded += 1;
        else report.managedBundlesPreserved += 1;
      }

      const hireApprovals = await db
        .select()
        .from(approvals)
        .where(eq(approvals.type, "hire_agent"));

      for (const approval of hireApprovals) {
        const normalizedPayload = normalizeHireApprovalPayload(approval.payload);
        if (normalizedPayload === approval.payload) {
          report.approvalPayloadsAlreadyCanonical += 1;
          continue;
        }
        report.approvalPayloadsUpdated += 1;
        if (!apply) continue;
        await db
          .update(approvals)
          .set({
            payload: normalizedPayload,
            updatedAt: new Date(),
          })
          .where(eq(approvals.id, approval.id));
      }

      return report;
    },
  };
}
