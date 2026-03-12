import { Command } from "commander";
import pc from "picocolors";
import { spawn, type ChildProcess } from "node:child_process";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface NodeRegisterOptions extends BaseClientOptions {
  companyId: string;
  capabilities?: string;
}

interface NodeListOptions extends BaseClientOptions {
  companyId: string;
}

interface NodeStatusOptions extends BaseClientOptions {
  companyId?: string;
}

interface NodeRunOptions {
  nodeId?: string;
  apiUrl?: string;
  apiKey?: string;
  maxConcurrent?: string;
}

export function registerNodeCommands(program: Command): void {
  const node = program.command("node").description("Remote node operations");

  // ---- register ----
  addCommonClientOptions(
    node
      .command("register")
      .argument("<name>", "Human-readable name for the node")
      .description("Register a new remote node and create an API key")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--capabilities <json>", "JSON object of node capabilities")
      .action(async (name: string, opts: NodeRegisterOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const capabilities = opts.capabilities ? JSON.parse(opts.capabilities) : {};

          const result = await ctx.api.post<{
            node: { id: string; name: string; status: string };
            apiKey: { id: string; key: string };
          }>(`/api/companies/${ctx.companyId}/nodes`, {
            name,
            capabilities,
          });

          if (!result) {
            console.error(pc.red("Failed to register node — no response from server."));
            process.exit(1);
          }

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`Node registered: ${result.node.name} (${result.node.id})`));
          console.log();
          console.log(pc.bold("API Key (shown only once):"));
          console.log(result.apiKey.key);
          console.log();
          console.log(pc.bold("Environment variables for the runner:"));
          console.log(`  export PAPERCLIP_NODE_ID=${result.node.id}`);
          console.log(`  export PAPERCLIP_NODE_KEY=${result.apiKey.key}`);
          console.log(`  export PAPERCLIP_API_URL=${ctx.api.apiBase}`);
          console.log();
          console.log(pc.dim("Start the runner with: paperclipai node run"));
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ---- list ----
  addCommonClientOptions(
    node
      .command("list")
      .description("List registered nodes for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: NodeListOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<Record<string, unknown>[]>(
            `/api/companies/${ctx.companyId}/nodes`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ---- status ----
  addCommonClientOptions(
    node
      .command("status")
      .argument("<nodeId>", "Node ID")
      .description("Show details for a specific node")
      .option("-C, --company-id <id>", "Company ID")
      .action(async (nodeId: string, opts: NodeStatusOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const detail = await ctx.api.get<Record<string, unknown>>(
            `/api/companies/${ctx.companyId}/nodes/${nodeId}`,
          );
          printOutput(detail, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ---- run ----
  node
    .command("run")
    .description("Run the node daemon — claims and executes remote agent runs")
    .option("--node-id <id>", "Node ID (or PAPERCLIP_NODE_ID env)")
    .option("--api-url <url>", "Paperclip API URL (or PAPERCLIP_API_URL env)")
    .option("--api-key <key>", "Node API key (or PAPERCLIP_NODE_KEY env)")
    .option("--max-concurrent <n>", "Max concurrent runs", "1")
    .action(async (opts: NodeRunOptions) => {
      const nodeId = opts.nodeId || process.env.PAPERCLIP_NODE_ID;
      const apiUrl = opts.apiUrl || process.env.PAPERCLIP_API_URL;
      const apiKey = opts.apiKey || process.env.PAPERCLIP_NODE_KEY;
      const maxConcurrent = Math.max(1, parseInt(opts.maxConcurrent || "1", 10));

      if (!nodeId || !apiUrl || !apiKey) {
        console.error(
          pc.red(
            "Missing required configuration. Provide --node-id, --api-url, --api-key " +
              "or set PAPERCLIP_NODE_ID, PAPERCLIP_API_URL, PAPERCLIP_NODE_KEY.",
          ),
        );
        process.exit(1);
        return; // unreachable but helps TS narrow types
      }

      // Narrowed to string after the guard above
      const _nodeId: string = nodeId;
      const _apiUrl: string = apiUrl;
      const _apiKey: string = apiKey;

      console.log(pc.blue(`Starting node runner for ${_nodeId}`));
      console.log(pc.dim(`  API: ${_apiUrl}`));
      console.log(pc.dim(`  Max concurrent: ${maxConcurrent}`));

      let activeRuns = 0;
      let shuttingDown = false;

      const headers = { Authorization: `Bearer ${_apiKey}`, "Content-Type": "application/json" };

      async function sendHeartbeat() {
        try {
          const res = await fetch(`${_apiUrl}/api/nodes/${_nodeId}/heartbeat`, {
            method: "POST",
            headers,
            body: "{}",
          });
          if (!res.ok) {
            console.error(pc.yellow(`Heartbeat failed: ${res.status}`));
            return { ok: false, pendingRuns: 0 };
          }
          return (await res.json()) as { ok: boolean; pendingRuns: number };
        } catch (err) {
          console.error(pc.yellow(`Heartbeat error: ${err}`));
          return { ok: false, pendingRuns: 0 };
        }
      }

      async function claimRun() {
        try {
          const res = await fetch(`${_apiUrl}/api/nodes/${_nodeId}/claim`, {
            method: "POST",
            headers,
            body: "{}",
          });
          if (res.status === 204) return null;
          if (!res.ok) {
            console.error(pc.yellow(`Claim failed: ${res.status}`));
            return null;
          }
          return (await res.json()) as {
            runId: string;
            agentId: string;
            companyId: string;
            contextSnapshot: Record<string, unknown>;
            adapterConfig: Record<string, unknown>;
            sessionIdBefore: string | null;
            runtime: Record<string, unknown>;
          };
        } catch (err) {
          console.error(pc.yellow(`Claim error: ${err}`));
          return null;
        }
      }

      async function sendLog(runId: string, stream: string, chunk: string) {
        try {
          const res = await fetch(`${_apiUrl}/api/nodes/${_nodeId}/runs/${runId}/log`, {
            method: "POST",
            headers,
            body: JSON.stringify({ stream, chunk }),
          });
          if (res.status === 409) {
            return { cancelled: true };
          }
          return { cancelled: false };
        } catch {
          return { cancelled: false };
        }
      }

      async function sendReport(runId: string, result: Record<string, unknown>) {
        try {
          await fetch(`${_apiUrl}/api/nodes/${_nodeId}/runs/${runId}/report`, {
            method: "POST",
            headers,
            body: JSON.stringify(result),
          });
        } catch (err) {
          console.error(pc.yellow(`Report error for run ${runId}: ${err}`));
        }
      }

      async function executeClaimedRun(claim: NonNullable<Awaited<ReturnType<typeof claimRun>>>) {
        activeRuns++;
        const { runId, adapterConfig, contextSnapshot } = claim;
        console.log(pc.green(`Claimed run ${runId} for agent ${claim.agentId}`));

        const localAdapterType = (adapterConfig.localAdapterType as string) || "claude_local";
        const localConfig = (adapterConfig.localAdapterConfig as Record<string, unknown>) || {};
        const cwd = (localConfig.cwd as string) || process.cwd();

        // Build env for the local adapter
        const childEnv: Record<string, string> = { ...process.env as Record<string, string> };
        childEnv.PAPERCLIP_API_URL = _apiUrl;
        childEnv.PAPERCLIP_AGENT_ID = claim.agentId;
        childEnv.PAPERCLIP_COMPANY_ID = claim.companyId;
        childEnv.PAPERCLIP_RUN_ID = runId;

        // Build Claude Code command args
        const args: string[] = [
          "--output-format", "stream-json",
          "--verbose",
        ];

        if (localConfig.model) args.push("--model", String(localConfig.model));
        if (localConfig.chrome) args.push("--chrome");
        if (localConfig.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
        if (localConfig.instructionsFilePath) {
          args.push("--append-system-prompt", String(localConfig.instructionsFilePath));
        }

        // Resume session if available
        const sessionId = claim.sessionIdBefore;
        if (sessionId) {
          args.push("--resume", sessionId);
        }

        // Build prompt from context
        const prompt = buildPromptFromContext(contextSnapshot);
        if (prompt && !sessionId) {
          args.push("--print", prompt);
        } else if (prompt && sessionId) {
          args.push("--print", prompt);
        }

        let cancelled = false;
        let stdout = "";
        let stderr = "";

        const result: Record<string, unknown> = {
          exitCode: null,
          signal: null,
          timedOut: false,
        };

        try {
          const command = localAdapterType === "claude_local" ? "claude" : localAdapterType;
          const child: ChildProcess = spawn(command, args, {
            cwd,
            env: childEnv,
            stdio: ["pipe", "pipe", "pipe"],
          });

          // Stream stdout
          child.stdout?.on("data", async (data: Buffer) => {
            const chunk = data.toString();
            stdout += chunk;
            const logResult = await sendLog(runId, "stdout", chunk);
            if (logResult.cancelled) {
              cancelled = true;
              child.kill("SIGTERM");
            }
          });

          // Stream stderr
          child.stderr?.on("data", async (data: Buffer) => {
            const chunk = data.toString();
            stderr += chunk;
            await sendLog(runId, "stderr", chunk);
          });

          // Wait for completion
          const exitCode = await new Promise<number | null>((resolve) => {
            child.on("close", (code, signal) => {
              result.exitCode = code;
              result.signal = signal ?? null;
              resolve(code);
            });
            child.on("error", (err) => {
              result.errorMessage = err.message;
              result.errorCode = "spawn_error";
              resolve(null);
            });
          });

          // Parse result from stdout (last line of stream-json is usually the result)
          const parsed = parseStreamJsonResult(stdout);
          if (parsed) {
            if (parsed.usage) result.usage = parsed.usage;
            if (parsed.sessionId) result.sessionId = parsed.sessionId;
            if (parsed.sessionParams) result.sessionParams = parsed.sessionParams;
            if (parsed.sessionDisplayId) result.sessionDisplayId = parsed.sessionDisplayId;
            if (parsed.model) result.model = parsed.model;
            if (parsed.provider) result.provider = parsed.provider;
            if (parsed.costUsd !== undefined) result.costUsd = parsed.costUsd;
            if (parsed.summary) result.summary = parsed.summary;
            if (parsed.resultJson) result.resultJson = parsed.resultJson;
          }

          if (cancelled) {
            result.errorMessage = "Cancelled by server";
            result.errorCode = "cancelled";
          }
        } catch (err) {
          result.errorMessage = err instanceof Error ? err.message : String(err);
          result.errorCode = "runner_error";
        }

        await sendReport(runId, result);
        console.log(pc.blue(`Run ${runId} completed (exit=${result.exitCode})`));
        activeRuns--;
      }

      // Main loop
      async function pollAndClaim() {
        if (shuttingDown) return;
        if (activeRuns >= maxConcurrent) return;

        const claim = await claimRun();
        if (claim) {
          // Fire and forget — the run executes in the background
          executeClaimedRun(claim).catch((err) => {
            console.error(pc.red(`Run execution error: ${err}`));
            activeRuns--;
          });
        }
      }

      // Send initial heartbeat
      await sendHeartbeat();

      // Heartbeat + poll interval
      const heartbeatInterval = setInterval(async () => {
        if (shuttingDown) return;
        const hb = await sendHeartbeat();
        if (hb.pendingRuns > 0) {
          await pollAndClaim();
        }
      }, 30_000);

      // Also poll more frequently for work
      const pollInterval = setInterval(() => {
        if (!shuttingDown) pollAndClaim();
      }, 5_000);

      // Graceful shutdown
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(pc.yellow("\nShutting down... waiting for active runs to finish."));
        clearInterval(heartbeatInterval);
        clearInterval(pollInterval);

        // Send offline heartbeat
        fetch(`${_apiUrl}/api/nodes/${_nodeId}/heartbeat`, {
          method: "POST",
          headers,
          body: "{}",
        }).catch(() => {});

        // Wait for active runs
        const checkDone = setInterval(() => {
          if (activeRuns <= 0) {
            clearInterval(checkDone);
            console.log(pc.blue("Node runner stopped."));
            process.exit(0);
          }
        }, 1000);

        // Force exit after 5 minutes
        setTimeout(() => {
          console.error(pc.red("Forced shutdown after timeout."));
          process.exit(1);
        }, 5 * 60 * 1000);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      console.log(pc.green("Node runner started. Waiting for runs..."));

      // Initial claim attempt
      await pollAndClaim();

      // Keep alive
      await new Promise(() => {});
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPromptFromContext(ctx: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof ctx.wakeReason === "string") parts.push(ctx.wakeReason);
  if (typeof ctx.issueTitle === "string") parts.push(`Issue: ${ctx.issueTitle}`);
  if (typeof ctx.issueBody === "string") parts.push(ctx.issueBody);
  if (typeof ctx.prompt === "string") parts.push(ctx.prompt);
  if (typeof ctx.message === "string") parts.push(ctx.message);
  return parts.join("\n\n");
}

function parseStreamJsonResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === "result") {
        const usage = obj.usage as Record<string, unknown> | undefined;
        return {
          usage: usage
            ? {
                inputTokens: Number(usage.input_tokens ?? 0),
                outputTokens: Number(usage.output_tokens ?? 0),
                cachedInputTokens: Number(usage.cache_read_input_tokens ?? 0),
              }
            : undefined,
          sessionId: typeof obj.session_id === "string" ? obj.session_id : undefined,
          sessionParams: obj.session_id
            ? { sessionId: obj.session_id }
            : undefined,
          sessionDisplayId: typeof obj.session_id === "string" ? obj.session_id : undefined,
          model: typeof obj.model === "string" ? obj.model : undefined,
          provider: "anthropic",
          costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : undefined,
          summary: typeof obj.result === "string" ? obj.result : undefined,
          resultJson: obj.result !== undefined ? { result: obj.result } : undefined,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}
