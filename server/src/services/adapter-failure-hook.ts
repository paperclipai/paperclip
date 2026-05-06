import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentFailureState, agents, companies, labels, heartbeatRuns, issues } from "@paperclipai/db";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueService } from "./issues.js";

const ADAPTER_FAILURE_THRESHOLD = 2;
const AUTO_CLOSE_SUCCESS_THRESHOLD = 3;
const FALLBACK_LABEL_NAME = "unassigned-platform-fallback";

export interface AdapterFailureHookInput {
  runId: string;
  agentId: string;
  companyId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  errorFamily?: string | null;
}

interface CreateDecision {
  kind: "create";
  counter: number;
  firstFailureRunId: string;
  lastFailureRunId: string;
  idempotencyKey: string;
}

interface AutoCloseDecision {
  kind: "auto_close";
  counter: number;
  consecutiveSuccesses: number;
  openAutoIssueId: string;
}

interface AppendCommentDecision {
  kind: "append_comment";
  counter: number;
  existingIssueId: string;
  firstFailureRunId: string;
  lastFailureRunId: string;
}

interface SkipDecision {
  kind: "reset" | "noop" | "skipped_idempotent";
  counter: number;
}

type HookDecision = CreateDecision | AutoCloseDecision | AppendCommentDecision | SkipDecision;

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
        INSERT INTO agent_failure_state (agent_id, consecutive_adapter_failures, consecutive_successes, updated_at)
        VALUES (${input.agentId}, 0, 0, now())
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
        const hasOpenIssue = stateRow.openAutoIssueId !== null;
        const hadFailures = stateRow.consecutiveAdapterFailures > 0;

        if (!hasOpenIssue && !hadFailures) {
          return { kind: "noop", counter: 0 } as SkipDecision;
        }

        const newSuccessCount = stateRow.consecutiveSuccesses + 1;

        if (hasOpenIssue && newSuccessCount >= AUTO_CLOSE_SUCCESS_THRESHOLD) {
          await tx
            .update(agentFailureState)
            .set({
              consecutiveAdapterFailures: 0,
              consecutiveSuccesses: 0,
              firstFailureRunId: null,
              lastFailureRunId: null,
              updatedAt: new Date(),
            })
            .where(eq(agentFailureState.agentId, input.agentId));

          return {
            kind: "auto_close",
            counter: 0,
            consecutiveSuccesses: newSuccessCount,
            openAutoIssueId: stateRow.openAutoIssueId!,
          } as AutoCloseDecision;
        }

        await tx
          .update(agentFailureState)
          .set({
            consecutiveAdapterFailures: 0,
            consecutiveSuccesses: hasOpenIssue ? newSuccessCount : 0,
            firstFailureRunId: null,
            lastFailureRunId: null,
            updatedAt: new Date(),
          })
          .where(eq(agentFailureState.agentId, input.agentId));
        return { kind: "reset", counter: 0 } as SkipDecision;
      }

      const newCounter = stateRow.consecutiveAdapterFailures + 1;
      const firstFailureRunId = stateRow.firstFailureRunId ?? input.runId;

      if (newCounter >= ADAPTER_FAILURE_THRESHOLD && stateRow.openAutoIssueId === null) {
        const errorFamily = input.errorFamily ?? "default";

        const existingIssues = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, input.companyId),
              eq(issues.originKind, "adapter_failure"),
              eq(issues.originId, input.agentId),
              eq(issues.originFingerprint, errorFamily),
              sql`${issues.hiddenAt} is null`,
              sql`${issues.status} not in ('done', 'cancelled')`,
            ),
          );
        const existingIssue = existingIssues[0] ?? null;

        if (existingIssue) {
          await tx
            .update(agentFailureState)
            .set({
              consecutiveAdapterFailures: newCounter,
              consecutiveSuccesses: 0,
              firstFailureRunId,
              lastFailureRunId: input.runId,
              updatedAt: new Date(),
            })
            .where(eq(agentFailureState.agentId, input.agentId));

          return {
            kind: "append_comment",
            counter: newCounter,
            existingIssueId: existingIssue.id,
            firstFailureRunId,
            lastFailureRunId: input.runId,
          } as AppendCommentDecision;
        }

        const idempotencyKey = `auto-adapter-failure:${input.agentId}:${firstFailureRunId}`;
        await tx
          .update(agentFailureState)
          .set({
            consecutiveAdapterFailures: newCounter,
            consecutiveSuccesses: 0,
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
          consecutiveSuccesses: 0,
          firstFailureRunId,
          lastFailureRunId: input.runId,
          updatedAt: new Date(),
        })
        .where(eq(agentFailureState.agentId, input.agentId));

      return {
        kind: stateRow.openAutoIssueId ? "skipped_idempotent" : "noop",
        counter: newCounter,
      } as SkipDecision;
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

    const provider = String(agent.adapterConfig?.provider ?? agent.adapterType ?? "unknown");

    const createdIssue = await issuesSvc.create(input.companyId, {
      title: `Adapter failure: ${agent.name} (${decision.counter} consecutive runs)`,
      status: "todo",
      priority: "high",
      assigneeAgentId,
      billingCode: "platform-ops",
      labelIds,
      idempotencyKey: decision.idempotencyKey,
      description,
      originKind: "adapter_failure",
      originId: input.agentId,
      originFingerprint: input.errorFamily ?? "default",
    });

    await db
      .update(agentFailureState)
      .set({ openAutoIssueId: createdIssue.id, updatedAt: new Date() })
      .where(eq(agentFailureState.agentId, input.agentId));

    const telemetry = getTelemetryClient();
    if (telemetry) {
      telemetry.track("agent.adapter_failure.auto_issue_created", {
        agent_id: input.agentId,
        provider,
      });
    }
  }

  async function autoCloseIssue(input: AdapterFailureHookInput, decision: AutoCloseDecision): Promise<void> {
    await issuesSvc.addComment(
      decision.openAutoIssueId,
      `Auto-closed: ${decision.consecutiveSuccesses} consecutive successful runs detected. The adapter issue appears resolved.`,
      {},
    );

    await issuesSvc.update(decision.openAutoIssueId, { status: "done" });
    await clearSlotOnIssueClosed(decision.openAutoIssueId);

    logger.info(
      {
        agentId: input.agentId,
        runId: input.runId,
        issueId: decision.openAutoIssueId,
        consecutiveSuccesses: decision.consecutiveSuccesses,
      },
      "adapter-failure-hook: auto-closed issue after consecutive successes",
    );

    const telemetry = getTelemetryClient();
    if (telemetry) {
      telemetry.track("agent.adapter_failure.auto_issue_closed", {
        agent_id: input.agentId,
      });
    }
  }

  async function executeHook(input: AdapterFailureHookInput): Promise<void> {
    const experimental = await instanceSettings.getExperimental();
    if (!experimental.enableAdapterFailureAutoIssue) return;

    const decision = await updateFailureState(input);

    logger.info(
      {
        agentId: input.agentId,
        runId: input.runId,
        counter: decision.counter,
        decision: decision.kind,
      },
      "adapter-failure-hook",
    );

    const telemetry = getTelemetryClient();
    if (telemetry) {
      telemetry.track("agent.adapter_failure.consecutive_count", {
        agent_id: input.agentId,
        count: decision.counter,
      });
    }

    if (decision.kind === "auto_close") {
      try {
        await autoCloseIssue(input, decision);
      } catch (err: unknown) {
        logger.error(
          { err, agentId: input.agentId, runId: input.runId, issueId: decision.openAutoIssueId },
          "adapter-failure-hook: failed to auto-close issue",
        );
      }
    }

    if (decision.kind === "append_comment") {
      try {
        await issuesSvc.addComment(
          decision.existingIssueId,
          `Adapter failure recurring: ${decision.counter} consecutive runs as of ${new Date().toISOString()}.`,
          {},
        );
        await db
          .update(agentFailureState)
          .set({ openAutoIssueId: decision.existingIssueId, updatedAt: new Date() })
          .where(eq(agentFailureState.agentId, input.agentId));

        logger.info(
          { agentId: input.agentId, runId: input.runId, issueId: decision.existingIssueId, counter: decision.counter },
          "adapter-failure-hook: appended comment to existing issue (dedup)",
        );
      } catch (err: unknown) {
        logger.error(
          { err, agentId: input.agentId, runId: input.runId, issueId: decision.existingIssueId },
          "adapter-failure-hook: failed to append comment to existing issue",
        );
      }
    }

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
