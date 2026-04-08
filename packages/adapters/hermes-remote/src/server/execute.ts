import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE, HERMES_CLI, DEFAULT_TIMEOUT_SEC, DEFAULT_GRACE_SEC } from "./constants.js";

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

interface ParseResult {
  response?: string;
  sessionId?: string;
  errorMessage?: string;
  usage?: { inputTokens: number; outputTokens: number };
  costUsd?: number;
}

function parseHermesOutput(stdout: string): ParseResult {
  const lines = stdout.split("\n").filter((l) => l.trim());
  let lastResponse = "";
  let sessionId: string | undefined;
  let errorMessage: string | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let costUsd: number | undefined;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "response" || obj.type === "result" || obj.role === "assistant") {
        if (typeof obj.content === "string") {
          lastResponse = obj.content;
        } else if (Array.isArray(obj.content)) {
          for (const block of obj.content) {
            if (block.type === "output_text" || block.type === "text") {
              lastResponse += block.text || "";
            }
          }
        }
      }
      if (obj.session_id) sessionId = obj.session_id;
      if (obj.sessionId) sessionId = obj.sessionId;
      if (obj.error) errorMessage = obj.error;
      if (obj.type === "error") errorMessage = obj.message || obj.error;
      if (obj.usage) {
        usage = {
          inputTokens: obj.usage.input_tokens || obj.usage.prompt_tokens || 0,
          outputTokens: obj.usage.output_tokens || obj.usage.completion_tokens || 0,
        };
      }
      if (obj.cost_usd !== undefined) costUsd = obj.cost_usd;
      if (obj.costUsd !== undefined) costUsd = obj.costUsd;
    } catch {
      const trimmed = line.trim();
      if (trimmed && !lastResponse) {
        lastResponse = trimmed;
      }
      const sidMatch = trimmed.match(/session_id[:\s]+([a-zA-Z0-9_]+)/);
      if (sidMatch) sessionId = sidMatch[1];
    }
  }

  return { response: lastResponse.trim() || undefined, sessionId, errorMessage, usage, costUsd };
}

function shellQuote(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = ctx.config ?? {};
  const context = ctx.context ?? {};
  const agent = ctx.agent;

  const sshHost = cfgString(config["sshHost"]) || "10.0.0.14";
  const sshPort = String(cfgNumber(config["sshPort"]) ?? 22);
  const sshUser = cfgString(config["sshUser"]) || "Evan";
  const remoteHermesCmd = cfgString(config["hermesCommand"]) || HERMES_CLI;
  const timeoutSec = cfgNumber(config["timeoutSec"]) ?? DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config["graceSec"]) ?? DEFAULT_GRACE_SEC;
  const persistSession = cfgBoolean(config["persistSession"]) ?? true;
  const model = cfgString(config["model"]) || "MiniMax-M2.7";
  const provider = cfgString(config["provider"]) || "minimax";
  const cwd = cfgString(config["cwd"]) || undefined;

  const prevSessionId = ctx.runtime?.sessionParams != null
    ? (ctx.runtime.sessionParams as Record<string, unknown>)?.sessionId as string | undefined
    : undefined;

  const env: Record<string, string> = { ...buildPaperclipEnv(agent), PAPERCLIP_RUN_ID: ctx.runId };
  // Pass MINIMAX_API_KEY from the local hermes auth.json so the remote hermes process can authenticate.
  // hermes stores credentials at ~/.hermes/auth.json; we read the key directly to avoid depending on
  // the paperclip server having MINIMAX_API_KEY in its own environment.
  let minimaxKeySource = 'not_found';
  let minimaxKey = '';
  try {
    const authPath = os.homedir() + '/.hermes/auth.json';
    const authContent = fs.readFileSync(authPath, 'utf8');
    const authJson = JSON.parse(authContent);
    const minimaxCreds = authJson?.credential_pool?.minimax?.[0]?.access_token;
    if (minimaxCreds) { minimaxKey = minimaxCreds; minimaxKeySource = 'auth_json'; }
  } catch (e) { minimaxKeySource = 'error:' + String(e); }
  await ctx.onLog('stdout', '[hermes_remote] MINIMAX_API_KEY source: ' + minimaxKeySource);
  if (minimaxKey) await ctx.onLog('stdout', '[hermes_remote] MINIMAX_API_KEY prefix: ' + minimaxKey.slice(0, 10) + '...');
  // When executing remotely, PAPERCLIP_API_URL points to localhost on the remote machine (the Pi),
  // which is wrong — it needs to be the LAN IP of the PC running Paperclip so the remote agent can
  // reach it. The PC is the SSH client, so we use its LAN IP (10.0.0.91) as the callback address.
  if (sshHost !== "localhost" && sshHost !== "127.0.0.1") {
    env.PAPERCLIP_API_URL = "http://10.0.0.91:3100";
  }
  const userEnv = config["env"] as Record<string, string> | undefined;
  if (userEnv && typeof userEnv === "object") Object.assign(env, userEnv);

  // Read instructions file from remote machine if configured
  const instructionsFilePath = cfgString(config["instructionsFilePath"]) || "";
  let instructionsContent = "";
  if (instructionsFilePath) {
    const readResult = await execViaSSH({
      host: sshHost, port: sshPort, user: sshUser,
      command: "cat",
      args: [instructionsFilePath],
      env: {}, cwd,
      timeoutMs: 15000, graceMs: 5000,
      onLog: async () => {},
    });
    if (readResult.exitCode === 0 && readResult.stdout.trim()) {
      instructionsContent = readResult.stdout.trim();
      await ctx.onLog("stdout", "[hermes_remote] Loaded instructions from " + instructionsFilePath + " (" + instructionsContent.length + " chars)");
    } else {
      await ctx.onLog("stderr", "[hermes_remote] Warning: could not read instructions file " + instructionsFilePath);
    }
  }

  const systemPromptExt = buildSystemPromptExtension(ctx, context, agent, instructionsContent, sshHost);

  let args: string[] = ["chat", "-Q"];
  args.push("-q", systemPromptExt);
  if (provider && provider !== "auto") args.push("--provider", provider);
  if (model) args.push("-m", model);
  if (persistSession && prevSessionId) args.push("--resume", prevSessionId);
  const toolsets = cfgString(config["toolsets"]) || "terminal,file";
  args.push("-t", toolsets);

  await ctx.onLog("stdout", "[hermes_remote] SSH to " + sshUser + "@" + sshHost + ":" + sshPort);
  await ctx.onLog("stdout", "[hermes_remote] Remote command: " + remoteHermesCmd + " " + args.map(shellQuote).join(" "));
  if (prevSessionId) await ctx.onLog("stdout", "[hermes_remote] Resuming session: " + prevSessionId);

  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      const isBenign = /^\[\d{4}[-/]\d{2}[-/]\d{2}[\sT]\d{2}:\d{2}:\d{2}/.test(trimmed)
        || /^(INFO|DEBUG|WARN|WARNING|ERROR)[\/:]/.test(trimmed)
        || /Successfully registered all tools/.test(trimmed)
        || /MCP.*server.*registered/i.test(trimmed)
        || /tool registered successfully/.test(trimmed)
        || /Application initialized/.test(trimmed);
      if (isBenign) return;
    }
    return ctx.onLog(stream, chunk);
  };

  // Command to run on the remote host. If MINIMAX_API_KEY is set, we wrap it in a bash
  // subshell that exports the key so hermes can authenticate. SSH doesn't forward env vars
  // by default (only AcceptEnv ones), so we put the key directly on the command.
  let command = remoteHermesCmd;
  await ctx.onLog('stdout', '[hermes_remote] minimaxKey value length: ' + minimaxKey.length + ', bool: ' + String(Boolean(minimaxKey)));
  if (minimaxKey) {
    const keyPrefix = minimaxKey.slice(0, 10) + '...';
    await ctx.onLog('stdout', '[hermes_remote] Injecting MINIMAX_API_KEY (prefix: ' + keyPrefix + ') into SSH command');
    args = ['-c', 'export MINIMAX_API_KEY=' + minimaxKey + '; exec ' + remoteHermesCmd + ' ' + args.map(shellQuote).join(' ')];
    command = 'bash';
  }

  const result = await execViaSSH({
    host: sshHost, port: sshPort, user: sshUser,
    command: command, args: args, env, cwd,
    timeoutMs: timeoutSec * 1000, graceMs: graceSec * 1000,
    onLog: wrappedOnLog,
  });

  const parsed = parseHermesOutput(result.stdout);
  await ctx.onLog("stdout", "[hermes_remote] Exit: " + (result.exitCode ?? "null") + ", timedOut: " + result.timedOut);
  if (parsed.sessionId) await ctx.onLog("stdout", "[hermes_remote] Session: " + parsed.sessionId);

  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode ?? null, signal: null, timedOut: result.timedOut,
    provider: provider || null, model: model || null,
  };
  if (parsed.errorMessage) executionResult.errorMessage = parsed.errorMessage;
  if (parsed.usage) executionResult.usage = parsed.usage;
  if (parsed.costUsd !== undefined) executionResult.costUsd = parsed.costUsd;
  if (parsed.response) executionResult.summary = parsed.response.slice(0, 2000);
  executionResult.resultJson = {
    result: parsed.response || "", session_id: parsed.sessionId || null,
    usage: parsed.usage || null, cost_usd: parsed.costUsd ?? null,
  };
  if (persistSession && parsed.sessionId) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }
  return executionResult;
}

function buildSystemPromptExtension(
  ctx: AdapterExecutionContext,
  context: Record<string, unknown>,
  agent: { id: string; name: string; companyId: string },
  instructionsContent?: string,
  sshHost?: string,
): string {
  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeTaskTitle = typeof context.taskTitle === "string" ? context.taskTitle.trim() : null;
  const wakeTaskBody = typeof context.taskBody === "string" ? context.taskBody.trim() : null;
  const paperclipApiUrl = sshHost && sshHost !== "localhost" && sshHost !== "127.0.0.1"
    ? "http://10.0.0.91:3100"
    : (process.env.PAPERCLIP_API_URL || "http://localhost:3100");

  const parts: string[] = [];
  if (instructionsContent) {
    parts.push("# Agent Instructions", instructionsContent, "");
  }
  parts.push("You are \"" + agent.name + "\", an AI agent employee in a Paperclip-managed company.");
  parts.push("Your Paperclip identity:");
  parts.push("  Agent ID: " + agent.id);
  parts.push("  Company ID: " + agent.companyId);
  parts.push("  API Base: " + paperclipApiUrl);

  if (wakeTaskId) {
    parts.push("", "# Assigned Task", "Issue ID: " + wakeTaskId);
    if (wakeTaskTitle) parts.push("Title: " + wakeTaskTitle);
    if (wakeTaskBody) parts.push("", wakeTaskBody);
    parts.push("", "# Workflow", "1. Work on the task using your tools", "2. When done, mark the issue as completed using curl", "3. Post a completion comment summarizing what you did");
    parts.push("", "# Heartbeat Wake - Check for Work");
    parts.push("1. List all open issues assigned to you (todo, backlog, in_progress)");
    parts.push("2. If issues found, pick the highest priority one and work on it");
    parts.push("3. If no issues assigned, check for unassigned issues in backlog");
  }
  return parts.join("\n");
}

interface SSHExecOptions {
  host: string; port: string; user: string; command: string; args: string[];
  env: Record<string, string>; cwd?: string; timeoutMs: number; graceMs: number;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}
interface SSHExecResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; }

function execViaSSH(options: SSHExecOptions): Promise<SSHExecResult> {
  return new Promise((resolve) => {
    const { host, port, user, command, args, env, cwd, timeoutMs, graceMs, onLog } = options;
    const remoteCmd = command + " " + args.map((a) => shellQuote(a)).join(" ");
    const sshArgs = [
      "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10", "-p", port, user + "@" + host,
    ];
    if (cwd) {
      sshArgs.push("bash", "-c", "cd " + JSON.stringify(cwd) + " && " + remoteCmd);
    }
    sshArgs.push(command);
    for (const arg of args) {
      sshArgs.push(arg);
    }
    let stdout = ""; let stderr = ""; let finished = false;
    const spawnOpts: { env: Record<string, string | undefined> } = { env: { ...process.env, ...env } };
    const proc = spawn("ssh", sshArgs, spawnOpts);
    const timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      proc.kill("SIGTERM");
      setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, graceMs);
    }, timeoutMs + graceMs);
    proc.stdout.on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr.on("data", (chunk: string) => { onLog("stderr", chunk); });
    proc.on("close", (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      resolve({ exitCode: code, stdout, stderr, timedOut: false });
    });
    proc.on("error", (err: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      resolve({ exitCode: -1, stdout, stderr, timedOut: false });
    });
  });
}
