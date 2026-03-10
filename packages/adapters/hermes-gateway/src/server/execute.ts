import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asNumber, asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import type {
  HermesGatewayClientHello,
  HermesGatewayServerFrame,
  HermesGatewayWakeRun,
} from "../shared/stream.js";

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function resolveSessionKey(input: {
  strategy: "fixed" | "issue" | "run";
  sessionKey: string | null;
  agentId: string;
  issueId: string | null;
  runId: string;
}): string {
  if (input.strategy === "run") return `paperclip:run:${input.runId}`;
  if (input.strategy === "issue" && input.issueId) {
    return `paperclip:agent:${input.agentId}:issue:${input.issueId}`;
  }
  return input.sessionKey ?? `paperclip:agent:${input.agentId}`;
}

function resolveAgentRole(ctx: AdapterExecutionContext): string {
  const configured = parseObject(ctx.config);
  const contextualAgent = parseObject(ctx.context.agent);
  return asString(contextualAgent.role ?? configured.role, "agent");
}

function buildSystemPrompt(ctx: AdapterExecutionContext): string {
  const configured = parseObject(ctx.config);
  const promptTemplate = asString(
    configured.promptTemplate,
    "You are {{agent.name}}, acting as a Paperclip agent. Continue your assigned work.",
  );
  return promptTemplate
    .replaceAll("{{agent.name}}", ctx.agent.name)
    .replaceAll("{{agent.role}}", resolveAgentRole(ctx))
    .replaceAll("{{agent.id}}", ctx.agent.id)
    .replaceAll("{{company.id}}", ctx.agent.companyId);
}

function resultBase(partial?: Partial<AdapterExecutionResult>): AdapterExecutionResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    sessionParams: null,
    sessionDisplayId: null,
    summary: null,
    ...partial,
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const url = nonEmpty(ctx.config.url);
  if (!url) {
    return resultBase({
      exitCode: 1,
      summary: "Hermes gateway URL is missing.",
      errorCode: "hermes_gateway_url_missing",
    });
  }

  if (!ctx.authToken) {
    return resultBase({
      exitCode: 1,
      summary: "Paperclip auth token missing for Hermes gateway run.",
      errorCode: "paperclip_auth_missing",
    });
  }

  const strategyRaw = asString(ctx.config.sessionKeyStrategy, "fixed").trim().toLowerCase();
  const strategy: "fixed" | "issue" | "run" =
    strategyRaw === "issue" || strategyRaw === "run" ? strategyRaw : "fixed";

  const issueId = nonEmpty(ctx.context.issueId) ?? nonEmpty(ctx.context.taskId) ?? null;
  const sessionKey = resolveSessionKey({
    strategy,
    sessionKey: nonEmpty(ctx.config.sessionKey),
    agentId: ctx.agent.id,
    issueId,
    runId: ctx.runId,
  });

  const paperclipApiUrl =
    nonEmpty(ctx.config.paperclipApiUrl) ??
    nonEmpty(process.env.PAPERCLIP_API_URL) ??
    "http://localhost:3100/api";

  const requestId = randomUUID();
  const timeoutMs = Math.max(1_000, asNumber(ctx.config.waitTimeoutMs, 120_000));

  const wake: HermesGatewayWakeRun = {
    type: "wake.run",
    requestId,
    idempotencyKey: `paperclip-run:${ctx.runId}`,
    session: {
      key: sessionKey,
      strategy,
    },
    paperclip: {
      apiUrl: paperclipApiUrl,
      authToken: ctx.authToken,
    },
    agent: {
      id: ctx.agent.id,
      companyId: ctx.agent.companyId,
      name: ctx.agent.name,
      role: resolveAgentRole(ctx),
    },
    context: {
      runId: ctx.runId,
      issueId: nonEmpty(ctx.context.issueId),
      taskId: nonEmpty(ctx.context.taskId),
      wakeReason: nonEmpty(ctx.context.wakeReason),
      actionHint: nonEmpty(ctx.context.actionHint) ?? undefined,
      followupIssue: parseObject(ctx.context.followupIssue),
      issueIds: Array.isArray(ctx.context.issueIds)
        ? ctx.context.issueIds.filter((value): value is string => typeof value === "string")
        : [],
      governance: parseObject(ctx.context.governance),
    },
    prompt: {
      system: buildSystemPrompt(ctx),
      user: [
        `Paperclip wake for ${ctx.agent.name}.`,
        `runId=${ctx.runId}`,
        `issueId=${nonEmpty(ctx.context.issueId) ?? 'none'}`,
        `wakeReason=${nonEmpty(ctx.context.wakeReason) ?? 'none'}`,
        "Use the paperclip tool when you need to inspect or act on issues.",
        "If issueId is present, call paperclip(action=list_issue_comments) and paperclip(action=get_issue) before replying.",
        "If the wakeReason asks for planning or follow-up work, you may use paperclip(action=create_issue) to open a concrete follow-up issue.",
        "You must inspect the issue via the paperclip tool before replying.",
        "Reply with a brief status update and the next immediate action, then stop.",
      ].join(" "),
    },
    runtime: {
      model: nonEmpty(ctx.config.model) ?? undefined,
      toolsets: toStringArray(ctx.config.toolsets),
      maxTurns: asNumber(ctx.config.maxTurnsPerRun, 0) || undefined,
    },
  };

  return await new Promise<AdapterExecutionResult>((resolve) => {
    const headers: Record<string, string> = {};
    const gatewayAuthToken = nonEmpty(ctx.config.gatewayAuthToken);
    if (gatewayAuthToken) headers.authorization = `Bearer ${gatewayAuthToken}`;

    const ws = new WebSocket(url, { headers });
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {}
      resolve(
        resultBase({
          exitCode: 1,
          timedOut: true,
          summary: "Timed out waiting for Hermes gateway final response.",
          errorCode: "hermes_gateway_timeout",
        }),
      );
    }, timeoutMs);

    const finish = (result: AdapterExecutionResult) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve(resultBase(result));
    };

    ws.on("open", () => {
      const hello: HermesGatewayClientHello = {
        type: "hello",
        protocolVersion: 1,
        client: { name: "paperclip", version: "0.3.0" },
      };
      ws.send(JSON.stringify(hello));
      ws.send(JSON.stringify(wake));
    });

    ws.on("message", async (raw) => {
      let frame: HermesGatewayServerFrame;
      try {
        frame = JSON.parse(String(raw)) as HermesGatewayServerFrame;
      } catch {
        return;
      }

      if (frame.type === "event.log" && frame.requestId === requestId) {
        await ctx.onLog(frame.stream, frame.text);
        return;
      }

      if (frame.type === "final" && frame.requestId === requestId) {
        finish({
          exitCode: frame.ok ? 0 : 1,
          signal: null,
          timedOut: false,
          summary:
            frame.summary ||
            (frame.ok ? "Hermes gateway run completed." : "Hermes gateway run failed."),
          errorCode: frame.ok ? null : frame.errorCode ?? "internal_error",
          sessionParams: frame.session?.id ? { sessionId: frame.session.id } : { sessionId: sessionKey },
          sessionDisplayId: frame.session?.id ?? sessionKey,
        });
      }
    });

    ws.on("error", (err) => {
      finish({
        exitCode: 1,
        signal: null,
        timedOut: false,
        summary: err instanceof Error ? err.message : "Failed to connect to Hermes gateway.",
        errorCode: "hermes_gateway_connect_failed",
      });
    });

    ws.on("close", () => {
      if (!done) {
        finish({
          exitCode: 1,
          signal: null,
          timedOut: false,
          summary: "Hermes gateway connection closed before final response.",
          errorCode: "hermes_gateway_protocol_error",
        });
      }
    });
  });
}
