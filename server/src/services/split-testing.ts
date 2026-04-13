import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { splitTestRuns, agents } from "@paperclipai/db";
import { getServerAdapter, findServerAdapter } from "../adapters/index.js";
import type { AdapterExecutionContext } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { logger } from "../middleware/logger.js";
import { asString, parseObject } from "../adapters/utils.js";
import type { SplitTestRun, SplitTestConfig } from "@paperclipai/shared";

const SHADOW_MODE_PROMPT_PREFIX = `
⚠️ SHADOW TEST MODE — DO NOT CALL ANY TOOLS ⚠️

This is a model comparison evaluation run. Your response will be compared against the primary model's execution. You MUST NOT:
- Call any tools or functions
- Use the Bash, Edit, Write, Read, or any other tools
- Checkout tasks, update statuses, or post comments
- Make any API calls to Paperclip or external services

Instead, write a detailed plain-text response covering:
1. Your understanding of the task at hand
2. The exact approach and steps you would take to solve it
3. Key challenges or risks you foresee
4. Your confidence level and why

Output plain text only — no tool invocations whatsoever.

---

`;

export function parseSplitTestConfig(runtimeConfig: unknown): SplitTestConfig | null {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return null;
  const rc = runtimeConfig as Record<string, unknown>;
  const st = rc.splitTesting;
  if (!st || typeof st !== "object") return null;
  const cfg = st as Record<string, unknown>;
  if (!cfg.enabled) return null;
  const shadowModels = Array.isArray(cfg.shadowModels)
    ? cfg.shadowModels.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    : [];
  if (shadowModels.length === 0) return null;
  return {
    enabled: true,
    shadowModels,
    judgeModel: typeof cfg.judgeModel === "string" ? cfg.judgeModel : undefined,
    autoAnalyze: typeof cfg.autoAnalyze === "boolean" ? cfg.autoAnalyze : false,
  };
}

/**
 * Parse a shadow model string into adapter type + model ID.
 * Supports "adapterType:modelId" namespace syntax (e.g. "codex_local:gpt-5.4").
 * If no known adapter prefix is found, returns { adapterType: null, model: modelStr }.
 */
function parseShadowModelSpec(modelStr: string): { adapterType: string | null; model: string } {
  const colonIdx = modelStr.indexOf(":");
  if (colonIdx <= 0) return { adapterType: null, model: modelStr };

  const possibleAdapter = modelStr.slice(0, colonIdx);
  const model = modelStr.slice(colonIdx + 1);

  // Only treat it as a cross-adapter spec if the prefix is a registered adapter type
  if (findServerAdapter(possibleAdapter)) {
    return { adapterType: possibleAdapter, model };
  }
  return { adapterType: null, model: modelStr };
}

function buildShadowConfig(
  baseConfig: Record<string, unknown>,
  shadowModel: string,
  primaryContext?: string,
): Record<string, unknown> {
  const shadowConfig = { ...baseConfig };

  // Override model
  shadowConfig.model = shadowModel;

  // Limit to 1 turn so the shadow only produces a single response
  shadowConfig.maxTurnsPerRun = 1;

  // Disable dangerous permissions to reduce risk of tool execution
  shadowConfig.dangerouslySkipPermissions = false;

  // Build the context block so the shadow knows what the primary agent was doing
  const contextBlock = primaryContext
    ? `## Primary Agent Run Context\n\n${primaryContext}\n\n---\n\n`
    : "";

  // Prefix the prompt template with shadow mode instructions + context
  const existingTemplate = asString(
    shadowConfig.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  shadowConfig.promptTemplate = SHADOW_MODE_PROMPT_PREFIX + contextBlock + existingTemplate;

  // Inject PAPERCLIP_SHADOW_MODE into the env config
  const envConfig = parseObject(shadowConfig.env) as Record<string, string>;
  shadowConfig.env = { ...envConfig, PAPERCLIP_SHADOW_MODE: "1" };

  return shadowConfig;
}

function toSplitTestRun(row: typeof splitTestRuns.$inferSelect): SplitTestRun {
  return {
    id: row.id,
    companyId: row.companyId,
    primaryRunId: row.primaryRunId,
    agentId: row.agentId,
    model: row.model,
    adapterType: row.adapterType,
    status: row.status as SplitTestRun["status"],
    prompt: row.prompt,
    summary: row.summary,
    usageJson: row.usageJson as Record<string, unknown> | null,
    costUsd: row.costUsd,
    logContent: row.logContent,
    error: row.error,
    judgeAnalysis: row.judgeAnalysis,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function splitTestingService(db: Db) {
  async function getShadowRuns(primaryRunId: string): Promise<SplitTestRun[]> {
    const rows = await db
      .select()
      .from(splitTestRuns)
      .where(eq(splitTestRuns.primaryRunId, primaryRunId))
      .orderBy(splitTestRuns.createdAt);
    return rows.map(toSplitTestRun);
  }

  async function getShadowRun(id: string): Promise<SplitTestRun | null> {
    const rows = await db.select().from(splitTestRuns).where(eq(splitTestRuns.id, id));
    return rows[0] ? toSplitTestRun(rows[0]) : null;
  }

  /**
   * Look up the adapterConfig of an active agent in the company that uses the given adapter type.
   * Used for cross-adapter shadow runs — we borrow an existing agent's config (API keys, cwd, etc.)
   * so we don't have to manage per-adapter config ourselves.
   */
  async function findCrossAdapterConfig(
    companyId: string,
    adapterType: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await db
      .select({ adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.adapterType, adapterType),
          eq(agents.status, "active"),
        ),
      )
      .limit(1);
    return rows[0]?.adapterConfig ?? null;
  }

  async function executeShadowRun(
    shadowRunId: string,
    agent: AdapterExecutionContext["agent"],
    runtimeConfig: Record<string, unknown>,
    context: Record<string, unknown>,
    authToken: string | null,
  ): Promise<void> {
    const now = new Date();
    await db
      .update(splitTestRuns)
      .set({ status: "running", startedAt: now, updatedAt: now })
      .where(eq(splitTestRuns.id, shadowRunId));

    const row = await db.select().from(splitTestRuns).where(eq(splitTestRuns.id, shadowRunId)).then((r) => r[0]);
    if (!row) return;

    const adapter = getServerAdapter(row.adapterType);

    let logChunks: string[] = [];
    const onLog = async (_stream: "stdout" | "stderr", chunk: string) => {
      logChunks.push(chunk);
    };

    try {
      const result = await adapter.execute({
        runId: shadowRunId,
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: runtimeConfig,
        context,
        onLog,
        authToken: authToken ?? undefined,
      });

      const logContent = logChunks.join("");
      const usageJson = result.usage
        ? {
            inputTokens: result.usage.inputTokens,
            cachedInputTokens: result.usage.cachedInputTokens,
            outputTokens: result.usage.outputTokens,
          }
        : null;

      const summary =
        typeof result.summary === "string" && result.summary.trim().length > 0
          ? result.summary.trim()
          : null;

      const costUsd = result.costUsd != null ? String(result.costUsd) : null;

      await db
        .update(splitTestRuns)
        .set({
          status: (result.exitCode ?? 0) === 0 && !result.errorMessage ? "done" : "failed",
          summary,
          usageJson: usageJson as Record<string, unknown> | null,
          costUsd,
          logContent: logContent.slice(0, 500_000), // cap at 500KB
          error: result.errorMessage ?? null,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(splitTestRuns.id, shadowRunId));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Shadow run failed";
      logger.warn({ err, shadowRunId }, "shadow run execution failed");
      await db
        .update(splitTestRuns)
        .set({
          status: "failed",
          error: errorMsg,
          logContent: logChunks.join("").slice(0, 500_000),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(splitTestRuns.id, shadowRunId));
    }
  }

  async function createAndRunShadows(input: {
    primaryRunId: string;
    agent: AdapterExecutionContext["agent"];
    baseAdapterConfig: Record<string, unknown>;
    context: Record<string, unknown>;
    shadowModels: string[];
    /** Summary from the primary run — injected into shadow prompt so the model knows what the primary did. */
    primarySummary?: string | null;
  }): Promise<void> {
    const { primaryRunId, agent, baseAdapterConfig, context, shadowModels, primarySummary } = input;

    // Build the context string injected into each shadow prompt
    const primaryContext = primarySummary
      ? `The primary agent completed its run successfully.\n\nPrimary run summary:\n${primarySummary}`
      : "The primary agent completed its run (no summary available — it may have had nothing to do or produced no output).";

    // Parse model specs and resolve cross-adapter configs up front
    const shadowSpecs = shadowModels.map(parseShadowModelSpec);
    const primaryAdapterType = agent.adapterType ?? "unknown";

    const uniqueCrossAdapters = [
      ...new Set(
        shadowSpecs
          .map((s) => s.adapterType)
          .filter((t): t is string => t !== null && t !== primaryAdapterType),
      ),
    ];

    const crossAdapterConfigs = new Map<string, Record<string, unknown>>();
    for (const targetType of uniqueCrossAdapters) {
      const cfg = await findCrossAdapterConfig(agent.companyId, targetType);
      if (cfg) {
        crossAdapterConfigs.set(targetType, cfg);
      } else {
        logger.warn(
          { targetType, companyId: agent.companyId },
          "no active agent found for cross-adapter shadow type — skipping",
        );
      }
    }

    // Create DB rows and shadow configs for each valid spec
    type ShadowEntry = {
      row: typeof splitTestRuns.$inferSelect;
      shadowConfig: Record<string, unknown>;
      effectiveAdapterType: string;
      authToken: string | null;
    };

    const shadowEntries: ShadowEntry[] = [];

    for (const { adapterType: specAdapterType, model } of shadowSpecs) {
      const isCrossAdapter = specAdapterType !== null && specAdapterType !== primaryAdapterType;
      const effectiveAdapterType = specAdapterType ?? primaryAdapterType;

      let baseConfig = baseAdapterConfig;
      if (isCrossAdapter) {
        const crossConfig = crossAdapterConfigs.get(effectiveAdapterType);
        if (!crossConfig) continue; // already warned above
        baseConfig = crossConfig;
      }

      const shadowConfig = buildShadowConfig(baseConfig, model, primaryContext);
      const promptText = asString(shadowConfig.promptTemplate, "") || undefined;

      const [row] = await db
        .insert(splitTestRuns)
        .values({
          companyId: agent.companyId,
          primaryRunId,
          agentId: agent.id,
          model,
          adapterType: effectiveAdapterType,
          status: "queued",
          prompt: promptText,
        })
        .returning();

      const shadowAdapter = getServerAdapter(effectiveAdapterType);
      const authToken = shadowAdapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.companyId, effectiveAdapterType, primaryRunId)
        : null;

      shadowEntries.push({ row, shadowConfig, effectiveAdapterType, authToken });
    }

    // Execute all shadows in parallel (fire and forget called from heartbeat)
    await Promise.allSettled(
      shadowEntries.map(({ row, shadowConfig, authToken }) =>
        executeShadowRun(row.id, agent, shadowConfig, context, authToken),
      ),
    );
  }

  async function requestJudgeAnalysis(
    primaryRunId: string,
    primarySummary: string | null,
    judgeModel: string,
    agent: AdapterExecutionContext["agent"],
    baseAdapterConfig: Record<string, unknown>,
    context: Record<string, unknown>,
  ): Promise<void> {
    const shadows = await getShadowRuns(primaryRunId);
    if (shadows.length === 0) return;

    const shadowSummaries = shadows
      .filter((s) => s.status === "done" && s.summary)
      .map((s, i) => `### Shadow Model ${i + 1}: ${s.model}\n${s.summary}`)
      .join("\n\n");

    const judgePrompt = `You are a neutral model performance judge. Below are outputs from different AI models given the same task. Analyze each response and provide:

1. A ranking of the models (best to worst) with reasoning
2. Which model best understood the task
3. Which model had the most actionable/practical approach
4. Recommended primary model going forward and why
5. Any cost/performance trade-offs worth noting

## Primary Model Output (${asString(baseAdapterConfig.model, "primary")})
${primarySummary ?? "(no summary available)"}

## Shadow Models
${shadowSummaries}

Provide a clear, structured verdict.`;

    const { adapterType: judgeSpecAdapterType, model: judgeModelId } = parseShadowModelSpec(judgeModel);
    const judgeAdapterType = judgeSpecAdapterType ?? agent.adapterType ?? "unknown";
    const judgeAdapter = getServerAdapter(judgeAdapterType);

    const judgeConfig = buildShadowConfig(baseAdapterConfig, judgeModelId);
    judgeConfig.promptTemplate = judgePrompt;

    const authToken = judgeAdapter.supportsLocalAgentJwt
      ? createLocalAgentJwt(agent.id, agent.companyId, judgeAdapterType, `judge-${primaryRunId}`)
      : null;

    let logChunks: string[] = [];
    try {
      const result = await judgeAdapter.execute({
        runId: `judge-${primaryRunId}`,
        agent,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: judgeConfig,
        context,
        onLog: async (_stream, chunk) => { logChunks.push(chunk); },
        authToken: authToken ?? undefined,
      });

      const analysis = typeof result.summary === "string" && result.summary.trim()
        ? result.summary.trim()
        : logChunks.join("").trim().slice(0, 10_000);

      if (analysis) {
        await db
          .update(splitTestRuns)
          .set({ judgeAnalysis: analysis, updatedAt: new Date() })
          .where(eq(splitTestRuns.primaryRunId, primaryRunId));
      }
    } catch (err) {
      logger.warn({ err, primaryRunId }, "judge analysis failed");
    }
  }

  return {
    getShadowRuns,
    getShadowRun,
    createAndRunShadows,
    requestJudgeAnalysis,
    parseSplitTestConfig,
  };
}
