import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import type { PersistenceOptions } from "./k8s-client.js";
import { K8sClient } from "./k8s-client.js";
import { renderTemplate, asString } from "../utils.js";

/** Shell-escape a string for use inside sh -c (single-quote wrapping). */
export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Join non-empty prompt sections with double-newline separators.
 * Mirrors joinPromptSections from adapter-utils.
 */
function joinPromptSections(sections: Array<string | null | undefined>): string {
  return sections
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Build a rich prompt from the adapter context and config.
 *
 * Mirrors the local opencode adapter's prompt composition:
 *   1. Bootstrap prompt (rendered from config.bootstrapPromptTemplate)
 *   2. Session handoff markdown (from context.paperclipSessionHandoffMarkdown)
 *   3. Heartbeat / main prompt (rendered from config.promptTemplate)
 *
 * Falls back to issueTitle + issueDescription when no templates are configured.
 */
export function buildPrompt(
  ctx: AdapterExecutionContext,
): string | undefined {
  const { agent, runId, config, context } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();

  // Build issue context section from enriched heartbeat fields
  const issueTitle = asString(context.issueTitle, "");
  const issueDescription = asString(context.issueDescription, "");
  const issueSection =
    issueTitle || issueDescription
      ? joinPromptSections([
          issueTitle ? `## Current Task\n${issueTitle}` : null,
          issueDescription || null,
        ])
      : "";

  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    sessionHandoffNote,
    issueSection,
    renderedPrompt,
  ]);

  return prompt.length > 0 ? prompt : undefined;
}

/**
 * Extracts the result event from stream-json stdout output.
 * The CLI emits one JSON object per line; the result event has type "result".
 */
export function extractStreamJsonResult(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "result") return parsed;
    } catch {
      // Not valid JSON, skip
    }
  }
  return null;
}

let sharedClient: K8sClient | null = null;

function getClient(): K8sClient {
  if (!sharedClient) sharedClient = new K8sClient();
  return sharedClient;
}

interface ParsedConfig {
  runtime: string;
  model: string;
  image: string;
  isolation: string;
  namespace: string;
  multiNamespace: boolean;
  timeoutSec: number;
  resources: { cpu?: string; memory?: string } | undefined;
  env: Record<string, string>;
  persistenceEnabled: boolean;
  persistenceStorageClass: string;
  persistenceSize: string;
  nodeSelector: Record<string, string> | undefined;
  tolerations: Array<{ key: string; operator?: string; value?: string; effect?: string }> | undefined;
}

function parseConfig(config: Record<string, unknown>): ParsedConfig {
  return {
    runtime: (config.runtime as string) || "multi",
    model: (config.model as string) || "",
    image: (config.runtimeImage as string) || process.env.PAPERCLIP_CLOUD_SANDBOX_DEFAULT_IMAGE || "ghcr.io/paperclipinc/agent-multi:latest",
    isolation: (config.isolation as string) || "shared",
    namespace: process.env.PAPERCLIP_CLOUD_SANDBOX_NAMESPACE || "default",
    multiNamespace: process.env.PAPERCLIP_CLOUD_SANDBOX_MULTI_NAMESPACE === "true",
    timeoutSec: (config.timeoutSec as number) || 600,
    resources: config.resources as { cpu?: string; memory?: string } | undefined,
    env: (config.env as Record<string, string>) || {},
    persistenceEnabled: process.env.PAPERCLIP_CLOUD_SANDBOX_PERSISTENCE_ENABLED === "true",
    persistenceStorageClass: process.env.PAPERCLIP_CLOUD_SANDBOX_PERSISTENCE_STORAGE_CLASS || "",
    persistenceSize: process.env.PAPERCLIP_CLOUD_SANDBOX_PERSISTENCE_SIZE || "10Gi",
    nodeSelector: process.env.PAPERCLIP_CLOUD_SANDBOX_NODE_SELECTOR ? JSON.parse(process.env.PAPERCLIP_CLOUD_SANDBOX_NODE_SELECTOR) : undefined,
    tolerations: process.env.PAPERCLIP_CLOUD_SANDBOX_TOLERATIONS ? JSON.parse(process.env.PAPERCLIP_CLOUD_SANDBOX_TOLERATIONS) : undefined,
  };
}

function podName(companyId: string, agentId: string, isolation: string): string {
  const id = isolation === "isolated" ? agentId : companyId;
  return `pci-sandbox-${id.slice(0, 8)}`;
}

function resolveNamespace(config: ParsedConfig, companyId: string): string {
  if (config.multiNamespace) {
    return `pci-sandbox-${companyId.slice(0, 8)}`;
  }
  return config.namespace;
}

export function resolveRuntimeCommand(runtime: string, model: string, stdinPrompt?: string): string[] {
  switch (runtime) {
    case "codex":
      return ["codex", "--full-auto",
        ...(model ? ["--model", model] : [])];
    case "opencode":
      // opencode requires -p for non-interactive mode (no TTY in containers).
      // -q suppresses the spinner (no TTY available).
      // -f json for structured output.
      if (stdinPrompt) {
        return ["opencode", "-p", shellEscape(stdinPrompt), "-f", "json", "-q"];
      }
      return ["opencode", "-p", shellEscape("Complete your assigned tasks."), "-f", "json", "-q"];
    case "gemini":
      return ["gemini",
        ...(model ? ["--model", model] : [])];
    case "pi":
      return ["pi-pods",
        ...(model ? ["--model", model] : [])];
    default:
      return ["codex", "--full-auto",
        ...(model ? ["--model", model] : [])];
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const client = getClient();
  const config = parseConfig(ctx.config);
  const companyId = ctx.agent.companyId;
  const agentId = ctx.agent.id;
  const name = podName(companyId, agentId, config.isolation);

  // Determine workspace cwd inside the pod
  const workspace = ctx.context.paperclipWorkspace as { cwd?: string; projectId?: string } | undefined;
  const projectId = workspace?.projectId || "default";
  const podCwd = `/workspaces/${projectId}`;

  // Labels for pod management
  const labels: Record<string, string> = {
    "paperclip.inc/role": "agent-sandbox",
    "paperclip.inc/company-id": companyId,
  };
  if (config.isolation === "isolated") {
    labels["paperclip.inc/agent-id"] = agentId;
  }

  // Company-level env vars (shared by all agents in the pod)
  const podEnv: Array<{ name: string; value: string }> = [
    { name: "PAPERCLIP_API_URL", value: process.env.PAPERCLIP_API_URL || "" },
    { name: "PAPERCLIP_COMPANY_ID", value: companyId },
  ];
  // Add resolved env config (LLM keys, connection tokens, secrets)
  for (const [key, value] of Object.entries(config.env)) {
    if (typeof value === "string") {
      podEnv.push({ name: key, value });
    }
  }

  // Inject platform-managed inference API keys when inferenceMode is "managed"
  // Each provider has its own env var: PAPERCLIP_MANAGED_ANTHROPIC_API_KEY, etc.
  // The adapter injects all available platform keys so agents can use any provider.
  const inferenceMode = ctx.context.inferenceMode as string | undefined;
  if (inferenceMode === "managed") {
    const existingKeys = new Set(podEnv.map((e) => e.name));
    const managedKeys: Array<{ envKey: string; source: string }> = [
      { envKey: "ANTHROPIC_API_KEY", source: "PAPERCLIP_MANAGED_ANTHROPIC_API_KEY" },
      { envKey: "OPENAI_API_KEY", source: "PAPERCLIP_MANAGED_OPENAI_API_KEY" },
      { envKey: "GEMINI_API_KEY", source: "PAPERCLIP_MANAGED_GEMINI_API_KEY" },
      { envKey: "OPENROUTER_API_KEY", source: "PAPERCLIP_MANAGED_OPENROUTER_API_KEY" },
    ];
    for (const { envKey, source } of managedKeys) {
      const value = process.env[source]?.trim();
      if (value && !existingKeys.has(envKey)) {
        podEnv.push({ name: envKey, value });
      }
    }
    // Legacy single-key fallback
    const legacyKey = process.env.PAPERCLIP_MANAGED_INFERENCE_API_KEY?.trim();
    if (legacyKey) {
      const legacyProvider = process.env.PAPERCLIP_MANAGED_INFERENCE_PROVIDER || "anthropic";
      const legacyEnvMap: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY",
        google: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY",
      };
      const legacyEnvKey = legacyEnvMap[legacyProvider] ?? "ANTHROPIC_API_KEY";
      if (!existingKeys.has(legacyEnvKey) && !podEnv.some(e => e.name === legacyEnvKey)) {
        podEnv.push({ name: legacyEnvKey, value: legacyKey });
      }
    }
  }

  // Resolve target namespace (per-company namespace when multi-namespace is enabled)
  const namespace = resolveNamespace(config, companyId);

  // Ensure the target namespace exists when multi-namespace isolation is enabled
  if (config.multiNamespace) {
    try {
      await client.ensureNamespace(namespace, {
        "paperclip.inc/role": "sandbox-namespace",
        "paperclip.inc/company-id": companyId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to ensure sandbox namespace";
      await ctx.onLog("stderr", `[cloud-sandbox] ${message}\n`);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: message,
      };
    }
  }

  // Ensure NetworkPolicy restricts sandbox pod network access
  await client.ensureSandboxNetworkPolicy(namespace, "paperclip").catch(() => {
    // Non-critical — may lack NetworkPolicy RBAC in some clusters
  });

  // Build persistence options when PVC-backed workspaces are enabled
  const persistence: PersistenceOptions | undefined = config.persistenceEnabled
    ? {
      pvcName: `pci-ws-${name}`,
      storageClass: config.persistenceStorageClass || undefined,
      size: config.persistenceSize,
    }
    : undefined;

  // Ensure the sandbox pod exists
  try {
    await client.ensurePod({
      name,
      namespace,
      labels,
      image: config.image,
      env: podEnv,
      resources: config.resources ? {
        requests: { cpu: config.resources.cpu || "500m", memory: config.resources.memory || "1Gi" },
        limits: { cpu: config.resources.cpu || "4", memory: config.resources.memory || "8Gi" },
      } : undefined,
      persistence,
      nodeSelector: config.nodeSelector,
      tolerations: config.tolerations,
    });

    await client.waitForReady(name, namespace);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create sandbox pod";
    await ctx.onLog("stderr", `[cloud-sandbox] ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
    };
  }

  // Per-exec env overrides (agent-specific, not shared)
  const execEnv: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agentId,
    PAPERCLIP_RUN_ID: ctx.runId,
    HOME: `/home/agents/${agentId}`,
  };

  // Build the CLI command
  // Build rich prompt for CLIs that need it (mirrors the local adapter's prompt composition)
  const stdinPrompt = (ctx.context.prompt as string | undefined) ?? buildPrompt(ctx);
  const command = resolveRuntimeCommand(config.runtime, config.model, stdinPrompt);

  // Ensure agent home and workspace directories exist, then exec the CLI
  const setupAndRun = [
    `mkdir -p /home/agents/${agentId}`,
    `mkdir -p ${podCwd}`,
    `cd ${podCwd}`,
    command.join(" "),
  ].join(" && ");

  await ctx.onLog("stdout", `[cloud-sandbox] Executing in pod ${name} (ns: ${namespace})\n`);

  let exitCode = -1;
  let timedOut = false;
  let stdoutBuffer = "";
  let lineBuffer = "";

  /**
   * Parse stdout from the CLI and surface meaningful content to the transcript.
   *
   * Supports multiple output formats:
   * - opencode JSONL: {"type":"text","part":{"text":"..."}} (opencode `run --format json`)
   * - Claude Code stream-json: {"type":"assistant","message":{"content":[...]}} (claude/codex)
   * - Non-JSON plaintext lines (passed through as-is)
   *
   * Note: opencode `-p -f json` outputs a single pretty-printed JSON object
   * ({"response":"..."}) which spans multiple lines — that format is handled
   * after exec completes by parsing the full stdoutBuffer.
   */
  function handleStdout(data: string): void {
    stdoutBuffer += data;
    lineBuffer += data;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? ""; // keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const eventType = typeof event.type === "string" ? event.type : "";

        // opencode JSONL format (type: "text", "step_finish", "tool_use", "error")
        if (eventType === "text") {
          const text = event.part?.text;
          if (typeof text === "string" && text.trim()) {
            void ctx.onLog("stdout", text + "\n");
          }
          continue;
        }
        if (eventType === "error") {
          const errText = typeof event.error === "string" ? event.error
            : event.error?.message ?? event.message ?? "";
          if (errText) void ctx.onLog("stderr", `[opencode] ${errText}\n`);
          continue;
        }

        // Claude Code stream-json format
        if (eventType === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              void ctx.onLog("stdout", block.text + "\n");
            } else if (block.type === "tool_use") {
              void ctx.onLog("stdout", `[tool: ${block.name}]\n`);
            }
          }
          continue;
        }
        if (eventType === "result") {
          if (event.is_error && event.result) {
            // Error result is handled separately via cliError extraction
          } else if (event.result) {
            void ctx.onLog("stdout", event.result + "\n");
          }
          continue;
        }

        // Skip known non-content events (step_finish, tool_use status, init, etc.)
      } catch {
        // Line is not valid JSON on its own. It may be a fragment of a
        // pretty-printed JSON object (e.g. opencode `-p -f json` output).
        // Don't log these fragments — the full stdoutBuffer is parsed
        // after exec completes and the response is surfaced then.
      }
    }
  }

  try {
    const result = await client.exec({
      podName: name,
      namespace,
      command: ["sh", "-c", setupAndRun],
      env: execEnv,
      stdin: stdinPrompt,
      onStdout: handleStdout,
      onStderr: (data) => { void ctx.onLog("stderr", data); },
      timeoutMs: config.timeoutSec * 1000,
    });
    exitCode = result.exitCode;
    timedOut = result.timedOut;
  } catch (err) {
    let message: string;
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === "object" && err !== null) {
      // K8s WebSocket ErrorEvent - extract the underlying error
      const inner = (err as { error?: Error }).error;
      message = inner?.message ?? (JSON.stringify(err) || "Exec failed");
    } else {
      message = String(err) || "Exec failed";
    }
    await ctx.onLog("stderr", `[cloud-sandbox] Exec error: ${message}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: message,
    };
  }

  // Extract error and response from CLI output.
  // Supports both JSONL stream format and opencode's single-object `-p -f json` format.
  let cliError: string | null = null;
  let simpleResponse: string | null = null;

  // First try: parse as JSONL (one JSON object per line)
  for (const line of stdoutBuffer.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "result" && parsed.is_error) {
        cliError = parsed.result || null;
      } else if (parsed.error === "authentication_failed" && parsed.message?.content) {
        const text = parsed.message.content.find((c: { type: string; text?: string }) => c.type === "text");
        if (text?.text) cliError = text.text;
      } else if (parsed.type === "error") {
        const errText = typeof parsed.error === "string" ? parsed.error
          : parsed.error?.message ?? parsed.message ?? null;
        if (errText && !cliError) cliError = errText;
      }
    } catch {
      // Not valid JSON line — skip
    }
  }

  // Second try: parse entire buffer as a single JSON object (opencode `-p -f json` format)
  // This format outputs pretty-printed JSON like: {"response": "..."}
  if (!cliError) {
    try {
      const fullParsed = JSON.parse(stdoutBuffer.trim());
      if (typeof fullParsed.response === "string" && fullParsed.response.trim()) {
        simpleResponse = fullParsed.response.trim();
        // Surface the response to the transcript
        await ctx.onLog("stdout", simpleResponse + "\n");
      }
      if (typeof fullParsed.error === "string" && fullParsed.error.trim()) {
        cliError = fullParsed.error.trim();
      }
    } catch {
      // Not a single JSON object — that's fine, it was JSONL or plaintext
    }
  }

  if (exitCode !== 0 && cliError) {
    await ctx.onLog("stderr", `[cloud-sandbox] CLI error: ${cliError}\n`);
  }

  // Update last-exec annotation for idle reaper
  void client.updateLastExecAnnotation(name, namespace);

  return {
    exitCode,
    signal: null,
    timedOut,
    errorMessage: timedOut ? `Execution timed out after ${config.timeoutSec}s` : cliError,
  };
}
