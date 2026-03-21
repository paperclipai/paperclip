/**
 * Emisso Sandbox adapter — execute function.
 *
 * Runs Claude Code inside an ephemeral Vercel Sandbox microVM.
 * Lifecycle: create sandbox → clone repos → inject instructions + MCP config →
 * run Claude CLI → stream logs → parse result → stop sandbox.
 *
 * Ported from emisso-hq's VercelSandboxService, adapted for the Paperclip
 * adapter execution model (AdapterExecutionContext → AdapterExecutionResult).
 */

import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";
import { parseStreamJsonOutput, extractRepoDirName, embedGitCredentials } from "./helpers.js";
import { estimateSessionCost } from "./cost-calculator.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_TIMEOUT_SEC = 10;
const MAX_TIMEOUT_SEC = 300;
const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_VCPUS = 2;
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TURNS = 30;
const CLONE_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;
const WORKSPACE_DIR = "/vercel/sandbox/workspace";

const DEFAULT_ALLOWED_DOMAINS = [
  "github.com",
  "*.github.com",
  "api.anthropic.com",
  "registry.npmjs.org",
  "*.npmjs.org",
];

// ---------------------------------------------------------------------------
// Sandbox types (minimal interface matching @vercel/sandbox)
// ---------------------------------------------------------------------------

interface SandboxCommandFinished {
  exitCode: number;
  stdout(opts?: { signal?: AbortSignal }): Promise<string>;
  stderr(opts?: { signal?: AbortSignal }): Promise<string>;
}

interface SandboxCommand {
  logs(opts?: { signal?: AbortSignal }): AsyncGenerator<
    { data: string; stream: "stdout" | "stderr" },
    void,
    void
  >;
  wait(opts?: { signal?: AbortSignal }): Promise<SandboxCommandFinished>;
  kill(signal?: string): Promise<void>;
}

interface SandboxHandle {
  sandboxId: string;
  stop(opts?: { signal?: AbortSignal }): Promise<void>;
  writeFiles(
    files: Array<{ path: string; content: Buffer }>,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    sudo?: boolean;
    signal?: AbortSignal;
    detached?: boolean;
  }): Promise<SandboxCommand & SandboxCommandFinished>;
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog } = ctx;
  const startTime = Date.now();

  // --- Resolve configuration ---
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const repoUrl =
    asString(config.repoUrl, "") || asString(workspaceContext.repoUrl, "");
  const revision =
    asString(config.revision, "") || asString(workspaceContext.repoRef, "");
  const additionalRepos = Array.isArray(config.additionalRepos)
    ? (config.additionalRepos as Array<{ repoUrl: string; dirName?: string }>)
    : [];
  const cloneDepth = asNumber(config.cloneDepth, 1);
  const model = asString(config.model, DEFAULT_MODEL);
  const maxTurns = asNumber(config.maxTurns, DEFAULT_MAX_TURNS);
  const timeoutSec = clamp(asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC), MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
  const vcpus = clamp(asNumber(config.vcpus, DEFAULT_VCPUS), 1, 8);
  const snapshotId = asString(config.snapshotId, "");
  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const mcpServers = parseObject(config.mcpServers);

  // Auth — resolve from config, then env vars
  const anthropicApiKey =
    asString(config.anthropicApiKey, "") || process.env.ANTHROPIC_API_KEY || "";
  const gitToken =
    asString(config.gitToken, "") || process.env.GITHUB_TOKEN || "";
  const vercelTeamId =
    asString(config.vercelTeamId, "") || process.env.VERCEL_TEAM_ID || "";
  const vercelProjectId =
    asString(config.vercelProjectId, "") || process.env.VERCEL_PROJECT_ID || "";
  const vercelToken =
    asString(config.vercelToken, "") || process.env.VERCEL_TOKEN || "";

  // Network policy
  const networkPolicyConfig = parseObject(config.networkPolicy);
  const networkPolicy = Object.keys(networkPolicyConfig).length > 0
    ? networkPolicyConfig
    : { allow: DEFAULT_ALLOWED_DOMAINS };

  if (!repoUrl) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Emisso Sandbox adapter requires a repoUrl (in adapterConfig or workspace context).",
      errorCode: "missing_repo_url",
    };
  }

  if (!anthropicApiKey) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "ANTHROPIC_API_KEY is required for sandbox execution.",
      errorCode: "missing_api_key",
    };
  }

  // --- Render prompt ---
  const prompt = promptTemplate
    .replace(/\{\{agent\.id\}\}/g, agent.id)
    .replace(/\{\{agent\.name\}\}/g, agent.name)
    .replace(/\{\{agent\.companyId\}\}/g, agent.companyId)
    .replace(/\{\{run\.id\}\}/g, runId);

  let sandbox: SandboxHandle | null = null;
  let sandboxId = "";

  try {
    // --- 1. Create sandbox ---
    await onLog("stdout", `[emisso-sandbox] Creating sandbox (${vcpus} vCPUs, ${timeoutSec}s timeout)...\n`);

    const { Sandbox } = await import("@vercel/sandbox");
    const createOptions: Record<string, unknown> = {
      resources: { vcpus },
      timeout: timeoutSec * 1000,
      runtime: "node22",
      networkPolicy,
    };

    if (snapshotId) {
      createOptions.source = { type: "snapshot", snapshotId };
    }
    if (vercelTeamId) createOptions.teamId = vercelTeamId;
    if (vercelProjectId) createOptions.projectId = vercelProjectId;
    if (vercelToken) createOptions.token = vercelToken;

    sandbox = await (Sandbox.create(createOptions) as unknown as Promise<SandboxHandle>);
    sandboxId = sandbox.sandboxId;
    await onLog("stdout", `[emisso-sandbox] Sandbox created: ${sandboxId}\n`);

    // --- 2. Install Claude Code CLI (skip if snapshot) ---
    if (!snapshotId) {
      await onLog("stdout", "[emisso-sandbox] Installing Claude Code CLI...\n");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), INSTALL_TIMEOUT_MS);
      try {
        const installResult = await sandbox.runCommand({
          cmd: "npm",
          args: ["install", "-g", "@anthropic-ai/claude-code"],
          sudo: true,
          signal: controller.signal,
        });
        if (installResult.exitCode !== 0) {
          const stderr = await installResult.stderr();
          throw new Error(`Claude Code CLI install failed (exit ${installResult.exitCode}): ${stderr.substring(0, 500)}`);
        }
      } finally {
        clearTimeout(timer);
      }
      await onLog("stdout", "[emisso-sandbox] Claude Code CLI installed.\n");
    }

    // --- 3. Clone repositories ---
    await onLog("stdout", `[emisso-sandbox] Cloning ${repoUrl}...\n`);
    await sandbox.runCommand({ cmd: "mkdir", args: ["-p", WORKSPACE_DIR] });

    const gitAuth = gitToken ? { username: "x-access-token", token: gitToken } : null;
    const primaryDirName = extractRepoDirName(repoUrl);
    const primaryCloneUrl = gitAuth ? embedGitCredentials(repoUrl, gitAuth) : repoUrl;

    const repos: Array<{ url: string; dirName: string }> = [
      { url: primaryCloneUrl, dirName: primaryDirName },
    ];
    for (const extra of additionalRepos) {
      const url = gitAuth ? embedGitCredentials(extra.repoUrl, gitAuth) : extra.repoUrl;
      repos.push({ url, dirName: extra.dirName || extractRepoDirName(extra.repoUrl) });
    }

    const totalCloneTimeout = CLONE_TIMEOUT_MS + Math.max(0, repos.length - 1) * 15_000;
    const cloneController = new AbortController();
    const cloneTimer = setTimeout(() => cloneController.abort(), totalCloneTimeout);
    try {
      await Promise.all(
        repos.map(async ({ url, dirName }, index) => {
          const args = ["clone", "--depth", String(cloneDepth), "--single-branch"];
          if (revision && index === 0) args.push("--branch", revision);
          args.push(url, `${WORKSPACE_DIR}/${dirName}`);
          const result = await sandbox!.runCommand({
            cmd: "git",
            args,
            signal: cloneController.signal,
          });
          if (result.exitCode !== 0) {
            const stderr = await result.stderr();
            cloneController.abort();
            throw new Error(`Git clone failed for ${dirName} (exit ${result.exitCode}): ${stderr.substring(0, 500)}`);
          }
        }),
      );
    } finally {
      clearTimeout(cloneTimer);
    }
    await onLog("stdout", `[emisso-sandbox] Repos cloned: ${repos.map((r) => r.dirName).join(", ")}\n`);

    // --- 4. Write instructions file ---
    if (instructionsFilePath) {
      // Read instructions from the cloned repo
      const readResult = await sandbox.runCommand({
        cmd: "cat",
        args: [instructionsFilePath.startsWith("/") ? instructionsFilePath : `${WORKSPACE_DIR}/${instructionsFilePath}`],
      });
      if (readResult.exitCode === 0) {
        const content = await readResult.stdout();
        await sandbox.writeFiles([{
          path: `${WORKSPACE_DIR}/CLAUDE.md`,
          content: Buffer.from(content),
        }]);
        await onLog("stdout", `[emisso-sandbox] Instruction file written from ${instructionsFilePath}\n`);
      }
    }

    // --- 5. Write MCP config ---
    const mcpKeys = Object.keys(mcpServers);
    let mcpConfigPath: string | null = null;
    if (mcpKeys.length > 0) {
      mcpConfigPath = "/vercel/sandbox/mcp-config.json";
      await sandbox.writeFiles([{
        path: mcpConfigPath,
        content: Buffer.from(JSON.stringify({ mcpServers }, null, 2)),
      }]);
      await onLog("stdout", `[emisso-sandbox] MCP config written (${mcpKeys.length} server(s))\n`);
    }

    // --- 6. Run Claude CLI ---
    await onLog("stdout", `[emisso-sandbox] Running Claude (model=${model}, maxTurns=${maxTurns})...\n`);

    // Use a runner script to pipe the prompt via stdin to Claude's `--print -` mode,
    // since the sandbox cmd interface doesn't support direct stdin piping.
    const runnerScript = buildRunnerScript(prompt, model, maxTurns, mcpConfigPath);
    await sandbox.writeFiles([{
      path: "/vercel/sandbox/runner.mjs",
      content: Buffer.from(runnerScript),
    }]);

    const runnerCmd = await sandbox.runCommand({
      cmd: "node",
      args: ["/vercel/sandbox/runner.mjs"],
      cwd: WORKSPACE_DIR,
      env: {
        ANTHROPIC_API_KEY: anthropicApiKey,
        CI: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        PAPERCLIP_AGENT_ID: agent.id,
        PAPERCLIP_COMPANY_ID: agent.companyId,
        PAPERCLIP_RUN_ID: runId,
      },
      detached: true,
    });

    // Stream logs to the UI in real-time
    let fullStdout = "";
    for await (const log of runnerCmd.logs()) {
      if (log.stream === "stdout") {
        fullStdout += log.data;
      }
      await onLog(log.stream, log.data);
    }

    const finished = await runnerCmd.wait();

    // --- 7. Parse output ---
    const durationMs = Date.now() - startTime;
    const parsed = parseStreamJsonOutput(fullStdout);

    if (finished.exitCode !== 0 && !parsed.resultJson) {
      const stderr = await finished.stderr();
      const isTimeout = stderr.includes("ETIMEDOUT") || stderr.includes("timed out");

      return {
        exitCode: finished.exitCode,
        signal: null,
        timedOut: isTimeout,
        errorMessage: isTimeout
          ? `Sandbox execution timed out after ${timeoutSec}s`
          : `Claude exited with code ${finished.exitCode}`,
        errorCode: isTimeout ? "timeout" : "sandbox_execution_failed",
        provider: "anthropic",
        model: parsed.model || model,
        costUsd: estimateSessionCost({ durationMs, vcpus, usage: parsed.usage ?? undefined, model }).totalCost,
        resultJson: { sandboxId, stdout: fullStdout.substring(0, 10000) },
      };
    }

    // --- 8. Build result ---
    const costBreakdown = estimateSessionCost({
      durationMs,
      vcpus,
      usage: parsed.usage ?? undefined,
      model: parsed.model || model,
    });

    return {
      exitCode: finished.exitCode,
      signal: null,
      timedOut: false,
      errorMessage: finished.exitCode === 0 ? null : `Claude exited with code ${finished.exitCode}`,
      usage: parsed.usage ?? undefined,
      provider: "anthropic",
      biller: "anthropic",
      model: parsed.model || model,
      billingType: "api",
      costUsd: costBreakdown.totalCost,
      resultJson: parsed.resultJson ?? { sandboxId },
      summary: parsed.summary || null,
      sessionId: parsed.sessionId,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = message.includes("AbortError") || message.includes("timed out");

    return {
      exitCode: 1,
      signal: null,
      timedOut: isTimeout,
      errorMessage: message,
      errorCode: isTimeout ? "timeout" : "sandbox_execution_failed",
      provider: "anthropic",
      model,
      costUsd: estimateSessionCost({ durationMs, vcpus, model }).totalCost,
      resultJson: { sandboxId },
    };
  } finally {
    // Always stop the sandbox to avoid lingering costs.
    if (sandbox) {
      try {
        await sandbox.stop();
        await onLog("stdout", `[emisso-sandbox] Sandbox ${sandboxId} stopped.\n`);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Runner script builder
// ---------------------------------------------------------------------------

function buildRunnerScript(
  prompt: string,
  model: string,
  maxTurns: number,
  mcpConfigPath: string | null,
): string {
  const escapedPrompt = JSON.stringify(prompt);
  const mcpArg = mcpConfigPath ? `"--mcp-config", ${JSON.stringify(mcpConfigPath)},` : "";

  return `
import { spawn } from "node:child_process";

const prompt = ${escapedPrompt};
const model = ${JSON.stringify(model)};

const args = [
  "--print", "-",
  "--verbose",
  "--output-format", "stream-json",
  "--model", model,
  "--max-turns", "${maxTurns}",
  "--dangerously-skip-permissions",
  ${mcpArg}
];

const proc = spawn("claude", args, {
  cwd: process.cwd(),
  stdio: ["pipe", "inherit", "inherit"],
  env: {
    ...process.env,
    CI: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
  },
});

proc.stdin.write(prompt);
proc.stdin.end();
proc.on("close", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`.trim();
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
