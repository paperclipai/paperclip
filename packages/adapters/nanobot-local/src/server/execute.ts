import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { asString, asNumber, buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = ctx.config as Record<string, unknown>;
  const url = asString(config.url, "").replace(/\/+$/, "");
  const apiKey = asString(config.apiKey, "");
  const timeoutSec = asNumber(config.timeoutSec, 300);

  if (!url) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Nanobot adapter requires a URL (adapterConfig.url).",
      errorCode: "NANOBOT_URL_MISSING",
    };
  }

  // Build wake text with Paperclip context
  const env = buildPaperclipEnv(ctx.agent);
  const taskKey = ctx.runtime.taskKey ?? "";
  const wakeReason = (ctx.context.wakeReason as string) ?? "heartbeat";
  const issueId = (ctx.context.issueId as string) ?? "";
  const issueTitle = (ctx.context.issueTitle as string) ?? "";
  const issueBody = (ctx.context.issueBody as string) ?? "";

  const lines: string[] = [];

  if (wakeReason === "new_issue" || wakeReason === "issue_comment") {
    lines.push(`[Paperclip Task] ${wakeReason}`);
    if (issueTitle) lines.push(`Title: ${issueTitle}`);
    if (issueBody) lines.push(`\n${issueBody}`);
  } else {
    lines.push(`[Paperclip] wake reason: ${wakeReason}`);
  }

  lines.push("");
  lines.push("---");
  lines.push("PAPERCLIP_AGENT_ID=" + ctx.agent.id);
  lines.push("PAPERCLIP_COMPANY_ID=" + ctx.agent.companyId);
  lines.push("PAPERCLIP_API_URL=" + (env.PAPERCLIP_API_URL ?? ""));
  lines.push("PAPERCLIP_RUN_ID=" + ctx.runId);
  if (taskKey) lines.push("PAPERCLIP_TASK_KEY=" + taskKey);

  const message = lines.join("\n");

  const invokeUrl = `${url}/api/invoke`;
  const body = JSON.stringify({
    message,
    runId: ctx.runId,
    agentId: ctx.agent.id,
    taskId: taskKey,
    sessionKey: `paperclip:${ctx.agent.id}:${taskKey || ctx.runId}`,
    metadata: {
      wakeReason,
      issueId,
      companyId: ctx.agent.companyId,
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  await ctx.onLog("stdout", `[nanobot-local] POST ${invokeUrl}\n`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const response = await fetch(invokeUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // not JSON
    }

    if (!response.ok) {
      const errorMsg = typeof parsed?.error === "string" ? parsed.error : text;
      await ctx.onLog("stderr", `[nanobot-local] HTTP ${response.status}: ${errorMsg}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: response.status === 408,
        errorMessage: `Nanobot returned HTTP ${response.status}: ${errorMsg}`,
        errorCode: "NANOBOT_HTTP_ERROR",
      };
    }

    const responseText = typeof parsed?.response === "string" ? parsed.response : text;
    await ctx.onLog("stdout", `[nanobot-local] response received (${responseText.length} chars)\n`);
    await ctx.onLog("stdout", responseText + "\n");

    const usageObj = parsed?.usage as Record<string, unknown> | undefined;
    const usage = usageObj
      ? {
          inputTokens: asNumber(usageObj.inputTokens, 0),
          outputTokens: asNumber(usageObj.outputTokens, 0),
          cachedInputTokens: asNumber(usageObj.cachedInputTokens, 0),
        }
      : undefined;
    const costUsd = usageObj ? asNumber(usageObj.costUsd, 0) : undefined;
    const model = usageObj && typeof usageObj.model === "string" ? usageObj.model : undefined;

    if (usage) {
      const cachedStr = usage.cachedInputTokens ? ` (${usage.cachedInputTokens} cached)` : "";
      const costStr = costUsd != null ? ` / $${costUsd.toFixed(4)}` : "";
      const modelStr = model ? ` (${model})` : "";
      await ctx.onLog(
        "stdout",
        `[nanobot-local] tokens: ${usage.inputTokens} in${cachedStr} / ${usage.outputTokens} out${costStr}${modelStr}\n`,
      );
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: responseText,
      usage,
      costUsd: costUsd ?? undefined,
      model: model || undefined,
      billingType: "api" as const,
      sessionParams: parsed?.sessionKey ? { sessionKey: parsed.sessionKey } : null,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    const message = err instanceof Error ? err.message : String(err);

    if (isAbort) {
      await ctx.onLog("stderr", `[nanobot-local] request timed out after ${timeoutSec}s\n`);
    } else {
      await ctx.onLog("stderr", `[nanobot-local] error: ${message}\n`);
    }

    return {
      exitCode: 1,
      signal: null,
      timedOut: isAbort,
      errorMessage: isAbort ? `Request timed out after ${timeoutSec}s` : message,
      errorCode: isAbort ? "NANOBOT_TIMEOUT" : "NANOBOT_FETCH_ERROR",
    };
  } finally {
    clearTimeout(timeout);
  }
}
