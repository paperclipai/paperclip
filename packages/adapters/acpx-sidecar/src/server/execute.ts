import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asStringArray,
  parseObject,
  buildPaperclipEnv,
  renderTemplate,
  redactEnvForLogs,
} from "@paperclipai/adapter-utils/server-utils";
import { parseAcpxJson } from "./parse.js";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseHeaders(raw: unknown): Record<string, string> {
  const record = parseObject(raw);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.trim().length > 0) headers[key] = value;
  }
  return headers;
}

function buildAcpxCommandArgs(input: {
  cwd: string;
  extraArgs: string[];
  agentCommand: string | null;
  customAgentCommand: string | null;
  operation: "sessions" | "set" | "prompt";
  sessionName: string;
  model?: string | null;
}): string[] {
  const prefix = ["--cwd", input.cwd];
  const target = input.customAgentCommand
    ? [...input.extraArgs, "--agent", input.customAgentCommand]
    : [...input.extraArgs, ...(input.agentCommand ? [input.agentCommand] : [])];

  if (input.operation === "sessions") {
    return [...prefix, "--format", "json", "--json-strict", ...target, "sessions", "ensure", "--name", input.sessionName];
  }
  if (input.operation === "set") {
    return [...prefix, ...target, "set", "model", input.model ?? "", "-s", input.sessionName];
  }
  return [...prefix, "--format", "json", "--json-strict", ...target, "prompt", "-s", input.sessionName, "--file", "-"];
}

async function sidecarRun(input: {
  url: string;
  headers: Record<string, string>;
  agentId: string;
  args: string[];
  timeout: number;
  cwd?: string;
  stdin?: string;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, input.timeout + 30) * 1000);
  const response = await fetch(`${input.url.replace(/\/+$/, "")}/run`, {
    method: "POST",
    signal: controller.signal,
    headers: {
      "content-type": "application/json",
      ...input.headers,
    },
    body: JSON.stringify({
      agent: input.agentId,
      args: input.args,
      timeout: input.timeout,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
    }),
  }).finally(() => clearTimeout(timer));
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(`sidecar_run_failed:${response.status}:${JSON.stringify(payload)}`);
  }
  return payload;
}

function buildSessionName(ctx: AdapterExecutionContext, template: string | null): string {
  if (template) {
    return renderTemplate(template, {
      agent: ctx.agent,
      runId: ctx.runId,
      context: ctx.context,
      runtime: ctx.runtime,
    }).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
  }
  return `paperclip-${ctx.agent.id}${ctx.runtime.taskKey ? `-${ctx.runtime.taskKey}` : ""}`
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 120);
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, runtime, onLog, onMeta, authToken } = ctx;
  const url = asString(config.url, "").trim();
  if (!url) throw new Error("acpx_sidecar missing url");

  const agentCommand = asString(config.agentCommand, "").trim() || asString(config.command, "").trim();
  const customAgentCommand = asString(config.customAgentCommand, "").trim();
  if (!agentCommand && !customAgentCommand) throw new Error("acpx_sidecar missing agentCommand or customAgentCommand");

  const timeoutSec = asNumber(config.timeoutSec, 300);
  const model = asString(config.model, "").trim();
  const cwd =
    nonEmptyString(config.cwd) ||
    nonEmptyString(parseObject(context.paperclipWorkspace).cwd) ||
    `/home/node/workspaces/${agent.id}`;
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();
  const sessionName = buildSessionName(ctx, nonEmptyString(config.sessionNameTemplate));
  const headers = parseHeaders(config.headers);
  if (authToken && !headers.authorization) {
    headers.authorization = `Bearer ${authToken}`;
  }

  const env = redactEnvForLogs(buildPaperclipEnv(agent));
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    try {
      const instructionsContents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${instructionsContents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. Resolve relative paths from ${path.dirname(instructionsFilePath)}/.\n\n`;
    } catch (err) {
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read acpx_sidecar instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const prompt = instructionsPrefix + renderTemplate(promptTemplate, {
    agent,
    runId,
    context,
    runtime,
  });

  if (onMeta) {
    await onMeta({
      adapterType: "acpx_sidecar",
      command: "sidecar:/run",
      cwd,
      commandArgs: customAgentCommand
        ? ["acpx", "--agent", customAgentCommand, "sessions", "ensure", "set", "prompt"]
        : ["acpx", agentCommand, "sessions", "ensure", "set", "prompt"],
      env,
      prompt,
      context,
      commandNotes: [`External ACPX sidecar at ${url}`],
    });
  }

  const ensurePayload = await sidecarRun({
    url,
    headers,
    agentId: agent.id,
    timeout: Math.max(timeoutSec, 60),
    cwd,
    args: buildAcpxCommandArgs({
      cwd,
      extraArgs,
      agentCommand: agentCommand || null,
      customAgentCommand: customAgentCommand || null,
      operation: "sessions",
      sessionName,
    }),
  });
  const ensureStdout = asString(ensurePayload.stdout, "");
  const ensureLines = ensureStdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const ensureLast = ensureLines.at(-1);
  let sessionId: string | null = null;
  if (ensureLast) {
    try {
      const parsed = JSON.parse(ensureLast) as Record<string, unknown>;
      sessionId = nonEmptyString(parsed.sessionId) ?? nonEmptyString(parsed.id);
    } catch {
      sessionId = null;
    }
  }

  if (model) {
    const setPayload = await sidecarRun({
      url,
      headers,
      agentId: agent.id,
      timeout: 30,
      cwd,
      args: buildAcpxCommandArgs({
        cwd,
        extraArgs,
        agentCommand: agentCommand || null,
        customAgentCommand: customAgentCommand || null,
        operation: "set",
        sessionName,
        model,
      }),
    });
    const setExit = asNumber(setPayload.exit_code, 0);
    if (setExit !== 0) {
      await onLog("stderr", `[paperclip] Warning: failed to set model via acpx sidecar: ${asString(setPayload.stderr, "").trim() || asString(setPayload.stdout, "").trim()}\n`);
    }
  }

  const promptPayload = await sidecarRun({
    url,
    headers,
    agentId: agent.id,
    timeout: timeoutSec,
    cwd,
    stdin: prompt,
    args: buildAcpxCommandArgs({
      cwd,
      extraArgs,
      agentCommand: agentCommand || null,
      customAgentCommand: customAgentCommand || null,
      operation: "prompt",
      sessionName,
    }),
  });

  const stdout = asString(promptPayload.stdout, "");
  const stderr = asString(promptPayload.stderr, "");
  if (stdout) await onLog("stdout", stdout);
  if (stderr) await onLog("stderr", stderr);

  const parsed = parseAcpxJson(stdout);
  const exitCode = asNumber(promptPayload.exit_code, 1);
  const ok = promptPayload.ok === true && exitCode === 0;
  const errorMessage = ok ? null : parsed.errorMessage || stderr.trim() || stdout.trim() || "acpx_sidecar_failed";

  return {
    exitCode,
    signal: null,
    timedOut: false,
    errorMessage,
    errorCode: ok ? null : "acpx_sidecar_error",
    summary: parsed.summary,
    sessionId,
    sessionDisplayId: sessionName,
    sessionParams: { sessionId, sessionName, cwd },
    provider: `${(customAgentCommand || agentCommand || "acpx")}-sidecar`,
    model: model || null,
    billingType: "subscription",
    resultJson: parsed.stopReason ? { stopReason: parsed.stopReason } : null,
  };
}
