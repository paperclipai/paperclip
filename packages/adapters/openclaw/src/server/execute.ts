import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { parseOpenClawResponse } from "./parse.js";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context, onLog, onMeta } = ctx;
  const url = asString(config.url, "").trim();
  if (!url) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "OpenClaw adapter missing url",
      errorCode: "openclaw_url_missing",
    };
  }

  const method = asString(config.method, "POST").trim().toUpperCase() || "POST";
  const timeoutSec = Math.max(1, asNumber(config.timeoutSec, 30));
  const headersConfig = parseObject(config.headers) as Record<string, unknown>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const webhookAuthHeader = nonEmpty(config.webhookAuthHeader);

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  for (const [key, value] of Object.entries(headersConfig)) {
    if (typeof value === "string" && value.trim().length > 0) {
      headers[key] = value;
    }
  }
  if (webhookAuthHeader && !headers.authorization && !headers.Authorization) {
    headers.authorization = webhookAuthHeader;
  }

  const wakePayload = {
    runId,
    agentId: agent.id,
    companyId: agent.companyId,
    taskId: nonEmpty(context.taskId) ?? nonEmpty(context.issueId),
    issueId: nonEmpty(context.issueId),
    wakeReason: nonEmpty(context.wakeReason),
    wakeCommentId: nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId),
    approvalId: nonEmpty(context.approvalId),
    approvalStatus: nonEmpty(context.approvalStatus),
    issueIds: Array.isArray(context.issueIds)
      ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [],
  };

  const body = {
    ...payloadTemplate,
    paperclip: {
      ...wakePayload,
      context,
    },
  };

  if (onMeta) {
    await onMeta({
      adapterType: "openclaw",
      command: "webhook",
      commandArgs: [method, url],
      context,
    });
  }

  await onLog("stdout", `[openclaw] invoking ${method} ${url}\n`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const responseText = await response.text();
    if (responseText.trim().length > 0) {
      await onLog("stdout", `[openclaw] response (${response.status}) ${responseText.slice(0, 2000)}\n`);
    } else {
      await onLog("stdout", `[openclaw] response (${response.status}) <empty>\n`);
    }

    if (!response.ok) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `OpenClaw webhook failed with status ${response.status}`,
        errorCode: "openclaw_http_error",
        resultJson: {
          status: response.status,
          statusText: response.statusText,
          response: parseOpenClawResponse(responseText) ?? responseText,
        },
      };
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "openclaw",
      model: null,
      summary: `OpenClaw webhook ${method} ${url}`,
      resultJson: {
        status: response.status,
        statusText: response.statusText,
        response: parseOpenClawResponse(responseText) ?? responseText,
      },
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      await onLog("stderr", `[openclaw] request timed out after ${timeoutSec}s\n`);
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[openclaw] request failed: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
      errorCode: "openclaw_request_failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}
