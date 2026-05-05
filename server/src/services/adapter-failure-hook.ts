import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentFailureState, agents, companies, labels, heartbeatRuns, issues } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";

const ADAPTER_FAILURE_THRESHOLD = 2;
const FALLBACK_LABEL_NAME = "unassigned-platform-fallback";

export interface AdapterFailureHookInput {
  runId: string;
  agentId: string;
  companyId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

interface CreateDecision {
  kind: "create";
  counter: number;
  firstFailureRunId: string;
  lastFailureRunId: string;
  idempotencyKey: string;
}

interface SkipDecision {
  kind: "reset" | "noop" | "skipped_idempotent";
}

type HookDecision = CreateDecision | SkipDecision;

export function adapterFailureHookService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const issuesSvc = issueService(db);

  async function resolveAssignee(
    failingAgentId: string,
    companyId: string,
  ): Promise<{ assigneeAgentId: string | null; fallbackLabel: boolean }> {
    const failingAgent = await db
      .select({ id: agents.id, reportsTo: agents.reportsTo })
      .from(agents)
      .where(eq(agents.id, failingAgentId))
      .then((rows) => rows[0] ?? null);

    if (failingAgent?.reportsTo && failingAgent.reportsTo !== failingAgentId) {
      const manager = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(eq(agents.id, failingAgent.reportsTo))
        .then((rows) => rows[0] ?? null);
      if (manager && manager.status !== "terminated") {
        return { assigneeAgentId: manager.id, fallbackLabel: false };
      }
    }

    const ctoAgent = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, "cto")))
      .then((rows) => rows.find((r) => r.status !== "terminated") ?? null);
    if (ctoAgent) {
      return { assigneeAgentId: ctoAgent.id, fallbackLabel: false };
    }

    const ceoAgent = await db
      .select({ id: agents.id, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")))
      .then((rows) => rows.find((r) => r.status !== "terminated") ?? null);
    if (ceoAgent) {
      return { assigneeAgentId: ceoAgent.id, fallbackLabel: false };
    }

    logger.error(
      { agentId: failingAgentId, companyId },
      "adapter-failure-hook: no assignee resolved (triple-null fallback)",
    );
    return { assigneeAgentId: null, fallbackLabel: true };
  }

  async function ensureLabelId(companyId: string, labelName: string, color: string): Promise<string> {
    const existing = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), eq(labels.name, labelName)))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing.id;

    const [created] = await db
      .insert(labels)
      .values({ companyId, name: labelName, color })
      .onConflictDoNothing()
      .returning({ id: labels.id });
    if (created) return created.id;

    const raced = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), eq(labels.name, labelName)))
      .then((rows) => rows[0]!);
    return raced.id;
  }

  function buildIssueDescription(input: {
    agent: { id: string; name: string; urlKey: string };
    companyPrefix: string;
    counter: number;
    firstFailureRunId: string;
    lastFailureRunId: string;
    errorMessage: string | null;
    lastIssueIdentifier: string | null;
    lastIssueTitle: string | null;
    adapterType: string;
    adapterConfig: Record<string, unknown>;
  }): string {
    const provider = String(input.adapterConfig.provider ?? input.adapterType ?? "unknown");
    const model = String(input.adapterConfig.model ?? "unknown");
    const adapterType = input.adapterType;
    const configHash = createHash("sha256")
      .update(JSON.stringify(input.adapterConfig))
      .digest("hex")
      .slice(0, 12);

    let body = `## Adapter failure detected\n\n`;
    body += `Agent: [${input.agent.name}](/${input.companyPrefix}/agents/${input.agent.urlKey})\n`;
    body += `Consecutive adapter failures: ${input.counter}\n`;
    body += `First failure run: [${input.firstFailureRunId.slice(0, 8)}](/${input.companyPrefix}/agents/${input.agent.urlKey}/runs/${input.firstFailureRunId})\n`;
    body += `Latest failure run: [${input.lastFailureRunId.slice(0, 8)}](/${input.companyPrefix}/agents/${input.agent.urlKey}/runs/${input.lastFailureRunId})\n`;

    body += `\n### Latest run error\n\n\`\`\`\n${input.errorMessage ?? "No error message"}\n\`\`\`\n`;

    if (input.lastIssueIdentifier) {
      body += `\n### Last assigned issue\n\n`;
      body += `[${input.lastIssueIdentifier}](/${input.companyPrefix}/issues/${input.lastIssueIdentifier}) — ${input.lastIssueTitle ?? "untitled"}\n`;
    }

    body += `\n### Adapter snapshot\n\n`;
    body += `- Provider: ${provider}\n`;
    body += `- Model: ${model}\n`;
    body += `- Adapter type: ${adapterType}\n`;
    body += `- Adapter config hash: ${configHash}\n`;

    body += `\n### Suggested actions\n\n`;
    body += `1. Check the provider's status page.\n`;
    body += `2. Inspect adapter config and credentials for this agent.\n`;
    body += `3. Run a smoke task; if successful, close this issue manually.\n`;
    body += `4. If the agent is shut down deliberately, cancel this issue.\n`;

    return body;
  }

  /**
   * Phase 1: Serialized counter update under SELECT FOR UPDATE.
   * Returns a decision on whether to create an auto-issue.
   */
  async function updateFailureState(input: AdapterFailureHookInput): Promise<HookDecision> {
    const isAdapterFailed = input.errorCode === "adapter_failed";

    return db.transaction(async (tx) => {
      // Ensure the row exists (no-op if already present), then lock it.
      await tx.execute(sql`
        INSERT INTO agent_failure_state (agent_id, consecutive_adapter_failures, updated_at)
        VALUES (${input.agentId}, 0, now())
        ON CONFLICT (agent_id) DO NOTHING
      `);
      await tx.execute(
        sql`SELECT agent_id FROM agent_failure_state WHERE agent_id = ${input.agentId} FOR UPDATE`,
      );
      const rows = await tx
        .select()
        .from(agentFailureState)
        .where(eq(agentFailureState.agentId, input.agentId));

      const stateRow = rows[0]!;

      if (!isAdapterFailed) {
        if (stateRow.consecutiveAdapterFailures === 0) {
          return { kind: "noop" } as SkipDecision;
        }
        await tx
          .update(agentFailureState)
          .set({
            consecutiveAdapterFailures: 0,
            firstFailureRunId: null,
            lastFailureRunId: null,
            updatedAt: new Date(),
          })
          .where(eq(agentFailureState.agentId, input.agentId));
        return { kind: "reset" } as SkipDecision;
      }

      const newCounter = stateRow.consecutiveAdapterFailures + 1;
      const firstFailureRunId = stateRow.firstFailureRunId ?? input.runId;

      if (newCounter >= ADAPTER_FAILURE_THRESHOLD && stateRow.openAutoIssueId === null) {
        const idempotencyKey = `auto-adapter-failure:${input.agentId}:${firstFailureRunId}`;
        await tx
          .update(agentFailureState)
          .set({
            consecutiveAdapterFailures: newCounter,
            firstFailureRunId,
            lastFailureRunId: input.runId,
            openAutoIssueId: sql`gen_random_uuid()`,
            updatedAt: new Date(),
          })
          .where(eq(agentFailureState.agentId, input.agentId));

        return {
          kind: "create",
          counter: newCounter,
          firstFailureRunId,
          lastFailureRunId: input.runId,
          idempotencyKey,
        } as CreateDecision;
      }

      await tx
        .update(agentFailureState)
        .set({
          consecutiveAdapterFailures: newCounter,
          firstFailureRunId,
          lastFailureRunId: input.runId,
          updatedAt: new Date(),
        })
        .where(eq(agentFailureState.agentId, input.agentId));

      return { kind: stateRow.openAutoIssueId ? "skipped_idempotent" : "noop" } as SkipDecision;
    });
  }

  /**
   * Phase 2: Create the auto-issue and update openAutoIssueId with the real ID.
   */
  async function createAutoIssue(input: AdapterFailureHookInput, decision: CreateDecision): Promise<void> {
    const agent = await db
      .select({
        id: agents.id,
        name: agents.name,
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .then((rows) => rows[0]!);

    const [company] = await db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, input.companyId));

    const urlKey = normalizeAgentUrlKey(agent.name) ?? agent.id;

    const lastRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .then((rows) => rows[0] ?? null);

    let lastIssueIdentifier: string | null = null;
    let lastIssueTitle: string | null = null;
    const contextSnapshot = lastRun?.contextSnapshot as Record<string, unknown> | null;
    const issueId = (contextSnapshot?.issueId as string | null) ?? null;
    if (issueId) {
      const issueRow = await db
        .select({ identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (issueRow) {
        lastIssueIdentifier = issueRow.identifier;
        lastIssueTitle = issueRow.title;
      }
    }

    const { assigneeAgentId, fallbackLabel } = await resolveAssignee(input.agentId, input.companyId);

    const labelNames = ["auto-generated", "adapter-failure"];
    if (fallbackLabel) labelNames.push(FALLBACK_LABEL_NAME);
    const labelIds = await Promise.all(
      labelNames.map((name) => ensureLabelId(input.companyId, name, "#e74c3c")),
    );

    const description = buildIssueDescription({
      agent: { id: agent.id, name: agent.name, urlKey },
      companyPrefix: company.issuePrefix,
      counter: decision.counter,
      firstFailureRunId: decision.firstFailureRunId,
      lastFailureRunId: decision.lastFailureRunId,
      errorMessage: input.errorMessage,
      lastIssueIdentifier,
      lastIssueTitle,
      adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig,
    });

    const createdIssue = await issuesSvc.create(input.companyId, {
      title: `Adapter failure: ${agent.name} (${decision.counter} consecutive runs)`,
      status: "todo",
      priority: "high",
      assigneeAgentId,
      billingCode: "platform-ops",
      labelIds,
      idempotencyKey: decision.idempotencyKey,
      description,
    });

    await db
      .update(agentFailureState)
      .set({ openAutoIssueId: createdIssue.id, updatedAt: new Date() })
      .where(eq(agentFailureState.agentId, input.agentId));
  }

  async function executeHook(input: AdapterFailureHookInput): Promise<void> {
    const experimental = await instanceSettings.getExperimental();
    if (!experimental.enableAdapterFailureAutoIssue) return;

    const decision = await updateFailureState(input);

    logger.info(
      { agentId: input.agentId, runId: input.runId, decision: decision.kind },
      "adapter-failure-hook",
    );

    if (decision.kind === "create") {
      try {
        await createAutoIssue(input, decision);
      } catch (err: unknown) {
        const isUniqueViolation =
          err instanceof Error && "code" in err && (err as { code: string }).code === "23505";
        if (isUniqueViolation) {
          logger.info(
            { agentId: input.agentId, runId: input.runId, idempotencyKey: decision.idempotencyKey },
            "adapter-failure-hook: idempotency constraint caught duplicate",
          );
          const existingIssue = await db
            .select({ id: issues.id })
            .from(issues)
            .where(eq(issues.idempotencyKey, decision.idempotencyKey))
            .then((rows) => rows[0] ?? null);
          if (existingIssue) {
            await db
              .update(agentFailureState)
              .set({ openAutoIssueId: existingIssue.id, updatedAt: new Date() })
              .where(eq(agentFailureState.agentId, input.agentId));
          }
        } else {
          logger.error(
            { err, agentId: input.agentId, runId: input.runId },
            "adapter-failure-hook: failed to create auto-issue",
          );
        }
      }
    }
  }

  async function clearSlotOnIssueClosed(issueId: string): Promise<void> {
    await db
      .update(agentFailureState)
      .set({ openAutoIssueId: null, updatedAt: new Date() })
      .where(eq(agentFailureState.openAutoIssueId, issueId));
  }

  return { executeHook, clearSlotOnIssueClosed };
}
