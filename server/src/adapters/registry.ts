import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterModel,
  AdapterModelProfileDefinition,
  AdapterRuntimeCommandSpec,
  ServerAdapterModule,
} from "./types.js";
import {
  buildSandboxNpmInstallCommand,
  getAdapterSessionManagement,
} from "@paperclipai/adapter-utils";
import {
  execute as acpxExecute,
  testEnvironment as acpxTestEnvironment,
  sessionCodec as acpxSessionCodec,
  getConfigSchema as getAcpxConfigSchema,
  listAcpxSkills,
  syncAcpxSkills,
} from "@paperclipai/adapter-acpx-local/server";
import {
  agentConfigurationDoc as acpxAgentConfigurationDoc,
  models as acpxModels,
} from "@paperclipai/adapter-acpx-local";
import {
  execute as claudeExecute,
  listClaudeSkills,
  syncClaudeSkills,
  listClaudeModels,
  refreshClaudeModels,
  testEnvironment as claudeTestEnvironment,
  sessionCodec as claudeSessionCodec,
  getQuotaWindows as claudeGetQuotaWindows,
} from "@paperclipai/adapter-claude-local/server";
import {
  agentConfigurationDoc as claudeAgentConfigurationDoc,
  models as claudeModels,
  modelProfiles as claudeModelProfiles,
} from "@paperclipai/adapter-claude-local";
import {
  execute as codexExecute,
  listCodexSkills,
  syncCodexSkills,
  testEnvironment as codexTestEnvironment,
  sessionCodec as codexSessionCodec,
  getQuotaWindows as codexGetQuotaWindows,
} from "@paperclipai/adapter-codex-local/server";
import {
  agentConfigurationDoc as codexAgentConfigurationDoc,
  models as codexModels,
  modelProfiles as codexModelProfiles,
} from "@paperclipai/adapter-codex-local";
import {
  execute as cursorExecute,
  listCursorSkills,
  syncCursorSkills,
  testEnvironment as cursorTestEnvironment,
  sessionCodec as cursorSessionCodec,
} from "@paperclipai/adapter-cursor-local/server";
import {
  agentConfigurationDoc as cursorAgentConfigurationDoc,
  models as cursorModels,
  modelProfiles as cursorModelProfiles,
} from "@paperclipai/adapter-cursor-local";
import {
  execute as cursorCloudExecute,
  getConfigSchema as getCursorCloudConfigSchema,
  sessionCodec as cursorCloudSessionCodec,
  testEnvironment as cursorCloudTestEnvironment,
} from "@paperclipai/adapter-cursor-cloud/server";
import { agentConfigurationDoc as cursorCloudAgentConfigurationDoc } from "@paperclipai/adapter-cursor-cloud";
import {
  execute as geminiExecute,
  listGeminiSkills,
  syncGeminiSkills,
  testEnvironment as geminiTestEnvironment,
  sessionCodec as geminiSessionCodec,
} from "@paperclipai/adapter-gemini-local/server";
import {
  agentConfigurationDoc as geminiAgentConfigurationDoc,
  models as geminiModels,
  modelProfiles as geminiModelProfiles,
} from "@paperclipai/adapter-gemini-local";
import {
  execute as grokExecute,
  listGrokSkills,
  syncGrokSkills,
  testEnvironment as grokTestEnvironment,
  sessionCodec as grokSessionCodec,
} from "@paperclipai/adapter-grok-local/server";
import {
  agentConfigurationDoc as grokAgentConfigurationDoc,
  models as grokModels,
} from "@paperclipai/adapter-grok-local";
import {
  execute as openCodeExecute,
  listOpenCodeSkills,
  syncOpenCodeSkills,
  testEnvironment as openCodeTestEnvironment,
  sessionCodec as openCodeSessionCodec,
  listOpenCodeModels,
} from "@paperclipai/adapter-opencode-local/server";
import {
  agentConfigurationDoc as openCodeAgentConfigurationDoc,
  models as openCodeModels,
  modelProfiles as openCodeModelProfiles,
} from "@paperclipai/adapter-opencode-local";
import {
  execute as openclawGatewayExecute,
  testEnvironment as openclawGatewayTestEnvironment,
} from "@paperclipai/adapter-openclaw-gateway/server";
import {
  agentConfigurationDoc as openclawGatewayAgentConfigurationDoc,
  models as openclawGatewayModels,
} from "@paperclipai/adapter-openclaw-gateway";
import { listCodexModels, refreshCodexModels } from "./codex-models.js";
import { listCursorModels } from "./cursor-models.js";
import {
  execute as piExecute,
  listPiSkills,
  syncPiSkills,
  testEnvironment as piTestEnvironment,
  sessionCodec as piSessionCodec,
  listPiModels,
} from "@paperclipai/adapter-pi-local/server";
import {
  agentConfigurationDoc as piAgentConfigurationDoc,
  modelProfiles as piModelProfiles,
} from "@paperclipai/adapter-pi-local";
import {
  execute as hermesExecute,
  testEnvironment as hermesTestEnvironment,
  sessionCodec as hermesSessionCodec,
  listSkills as hermesListSkills,
  syncSkills as hermesSyncSkills,
  detectModel as detectModelFromHermes,
} from "hermes-paperclip-adapter/server";
import {
  agentConfigurationDoc as hermesAgentConfigurationDoc,
  models as hermesModels,
} from "hermes-paperclip-adapter";
import { BUILTIN_ADAPTER_TYPES } from "./builtin-adapter-types.js";
import { buildExternalAdapters } from "./plugin-loader.js";
import { getDisabledAdapterTypes } from "../services/adapter-plugin-store.js";
import { processAdapter } from "./process/index.js";
import { httpAdapter } from "./http/index.js";

const execFileAsync = promisify(execFile);

function quoteForCmd(arg: string) {
  if (!arg.length) return "\"\"";
  const escaped = arg.replace(/"/g, "\"\"");
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

function getConfigObject(ctx: { config?: unknown }) {
  return ctx.config && typeof ctx.config === "object" ? (ctx.config as Record<string, unknown>) : {};
}

function asConfigString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asConfigStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function buildHermesPaperclipTaskConfig(config: unknown, context: unknown) {
  const configRecord = asRecord(config);
  const contextRecord = asRecord(context);
  const issueRecord = asRecord(contextRecord.paperclipIssue);

  const taskId =
    asConfigString(configRecord.taskId) ??
    asConfigString(issueRecord.identifier) ??
    asConfigString(issueRecord.id) ??
    asConfigString(contextRecord.taskId) ??
    asConfigString(contextRecord.issueId);
  const taskTitle =
    asConfigString(configRecord.taskTitle) ??
    asConfigString(issueRecord.title);
  const taskBody =
    asConfigString(configRecord.taskBody) ??
    asConfigString(contextRecord.paperclipTaskMarkdown) ??
    asConfigString(issueRecord.description);

  return Object.fromEntries(
    Object.entries({
      taskId,
      taskTitle,
      taskBody,
    }).filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}

function getHermesDesiredSkillKeys(config: Record<string, unknown>, runtimeSkills: Array<Record<string, unknown>>) {
  const rawSync = config.paperclipSkillSync;
  const syncConfig =
    rawSync && typeof rawSync === "object" && !Array.isArray(rawSync)
      ? (rawSync as Record<string, unknown>)
      : {};
  const explicitDesired = Object.prototype.hasOwnProperty.call(syncConfig, "desiredSkills");
  const required = runtimeSkills
    .filter((entry) => entry.required === true)
    .map((entry) => asConfigString(entry.key))
    .filter((key): key is string => Boolean(key));
  if (!explicitDesired) return Array.from(new Set(required));

  const desired = asConfigStringArray(syncConfig.desiredSkills)
    .map((key) => key.trim())
    .filter(Boolean);
  return Array.from(new Set([...required, ...desired]));
}

export function buildHermesRuntimeSkillPrompt(
  config: Record<string, unknown>,
  options: { includeSkillInstructions?: boolean } = {},
) {
  const runtimeSkills = Array.isArray(config.paperclipRuntimeSkills)
    ? config.paperclipRuntimeSkills.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
  if (runtimeSkills.length === 0) return "";

  const desiredKeys = new Set(getHermesDesiredSkillKeys(config, runtimeSkills));
  if (desiredKeys.size === 0) return "";

  const selected = runtimeSkills.filter((entry) => {
    const key = asConfigString(entry.key);
    const runtimeName = asConfigString(entry.runtimeName);
    return Boolean((key && desiredKeys.has(key)) || (runtimeName && desiredKeys.has(runtimeName)));
  });
  if (selected.length === 0) return "";

  const selectedKeys = selected
    .map((entry) => asConfigString(entry.key) ?? "unknown-skill")
    .filter(Boolean);

  const sections: string[] = [
    "## Paperclip Runtime Capability Keys",
    "",
    "The following are Paperclip-injected runtime capability keys for this Hermes run. They are not Hermes internal skills, Hermes tools, or generic tool names. Use the matching capability instructions when the assigned issue matches their purpose.",
    "",
    "If, and only if, the assigned issue explicitly asks for a runtime capability-key proof, include a short `Paperclip runtime capability keys` section in the final issue comment. Copy the exact keys from the bullets below or from the PAPERCLIP_RUNTIME_CAPABILITY_KEYS line at the end of this block. Mark each key as `used` or `visible but not used`. For ordinary task work, do not let this visibility note replace the requested deliverable.",
    "",
    options.includeSkillInstructions
      ? "This run is a runtime capability proof or skill-focused task, so detailed skill instructions are included below."
      : "For ordinary task work, treat these keys as available background capabilities only. Do not follow the detailed SKILL.md workflow unless the assigned issue explicitly asks for that skill.",
  ];

  for (const entry of selected) {
    const key = asConfigString(entry.key) ?? "unknown-skill";
    const runtimeName = asConfigString(entry.runtimeName) ?? key;
    const source = asConfigString(entry.source);
    let body = "";
    if (source) {
      const skillPath = path.join(source, "SKILL.md");
      try {
        body = fs.readFileSync(skillPath, "utf8").trim();
      } catch {
        body = "";
      }
    }

    sections.push("", `### ${runtimeName}`, `- key: ${key}`);
    if (body && options.includeSkillInstructions) {
      sections.push("", body.length > 4000 ? `${body.slice(0, 4000)}\n\n[truncated]` : body);
    } else if (body) {
      sections.push("", "Detailed skill instructions are hidden for this ordinary task so the assigned issue remains primary.");
    } else {
      sections.push("", "Skill instructions could not be read from disk; use the skill name and assigned issue context conservatively.");
    }
  }

  sections.push(
    "",
    "## Runtime Capability Key Reference",
    "",
    `PAPERCLIP_RUNTIME_CAPABILITY_KEYS: ${selectedKeys.join(", ")}`,
    "",
    "If the assigned issue explicitly asks for a runtime capability-key proof, use this exact key list in the final issue comment:",
    "",
    "Paperclip runtime capability keys",
    "",
    ...selectedKeys.map((key) => `- ${key}: used OR visible but not used`),
  );

  return sections.join("\n").trim();
}

function extractHermesRuntimeSkillKeys(prompt: string) {
  return Array.from(prompt.matchAll(/^- key:\s*(.+)$/gm), (match) => match[1]?.trim())
    .filter((key): key is string => Boolean(key));
}

function shouldRequireHermesRuntimeCapabilityProof(taskBody: string) {
  return /PAPERCLIP_RUNTIME_CAPABILITY_KEYS|Paperclip runtime capability keys|runtime capability keys|runtime skill keys|exact runtime skill keys|exact keys proof|capability-key proof/i.test(taskBody);
}

function buildHermesPaperclipPromptTemplate(runtimeSkillKeys: string[], requireRuntimeCapabilityProof: boolean) {
  const finalContract = runtimeSkillKeys.length > 0 && requireRuntimeCapabilityProof
    ? [
        "## Final Required Output Contract",
        "",
        "This final section overrides any generic workflow summary style. Your final issue comment must include exactly this heading and one bullet for every key:",
        "",
        "Paperclip runtime capability keys",
        "",
        ...runtimeSkillKeys.map((key) => `- ${key}: used OR visible but not used`),
        "",
        "Do not replace these keys with Hermes internal skills or generic tool names.",
      ].join("\n")
    : "";

  return [
    'You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.',
    "",
    "Focus on the assigned issue. If the issue asks for a plan, design, analysis, or recommendation, answer directly with that deliverable.",
    "",
    "Do not use terminal or Paperclip API calls unless the assigned issue explicitly requires system changes or API operations. Paperclip will post your final response back to the issue automatically.",
    "",
    "Your Paperclip identity:",
    "  Agent ID: {{agentId}}",
    "  Company ID: {{companyId}}",
    "  API Base: {{paperclipApiUrl}}",
    "",
    "{{#taskId}}",
    "## Assigned Task",
    "",
    "Issue ID: {{taskId}}",
    "Title: {{taskTitle}}",
    "",
    "{{taskBody}}",
    "",
    "## Response Workflow",
    "",
    "1. Produce the requested deliverable from the issue text.",
    "2. Keep the final answer self-contained and reviewable.",
    "3. Do not include shell commands, curl examples, or instructions to mark the issue done unless the issue explicitly asks for operational steps.",
    "{{/taskId}}",
    "",
    "{{#commentId}}",
    "## Comment on This Issue",
    "",
    "Someone commented. Read it, reply if needed, then continue working.",
    "{{/commentId}}",
    "",
    "{{#noTask}}",
    "## Heartbeat Wake Check for Work",
    "",
    "Check for open assigned work and report briefly if nothing is available.",
    "{{/noTask}}",
    "",
    finalContract,
  ].filter((section) => section.trim().length > 0).join("\n");
}

function resolveWindowsBatchCommand(command: string) {
  if (path.isAbsolute(command)) return command;

  const candidates = [
    path.resolve(process.cwd(), command),
    path.resolve(process.cwd(), "..", command),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

async function execWindowsBatchCommand(command: string, args: string[], timeout = 10_000) {
  const resolvedCommand = resolveWindowsBatchCommand(command);
  const commandLine = [quoteForCmd(resolvedCommand), ...args.map(quoteForCmd)].join(" ");
  return execFileAsync("cmd.exe", ["/d", "/s", "/c", commandLine], { timeout });
}

async function testHermesWindowsBridge(
  ctx: AdapterEnvironmentTestContext,
  command: string,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  try {
    const { stdout } = await execWindowsBatchCommand(command, ["--version"]);
    const version = stdout.trim();
    checks.push({
      level: "info",
      message: version ? `Hermes Agent version: ${version.split(/\r?\n/)[0]}` : "Hermes bridge responded to --version",
      code: "hermes_version",
    });
    checks.push({
      level: "info",
      message: `Windows bridge: ${command}`,
      detail: "Calls Hermes inside WSL2 Ubuntu from the Windows Paperclip server.",
      code: "hermes_windows_wsl_bridge",
    });
  } catch (err) {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [
        {
          level: "error",
          message: `Hermes bridge "${command}" failed`,
          detail: err instanceof Error ? err.message : String(err),
          hint: "Confirm scripts/hermes-wsl.cmd works from PowerShell before using Hermes in Paperclip.",
          code: "hermes_windows_bridge_failed",
        },
      ],
      testedAt: new Date().toISOString(),
    };
  }

  try {
    const { stdout } = await execWindowsBatchCommand(command, ["status"], 20_000);
    const usesCustomEndpoint = /Provider:\s+Custom endpoint/i.test(stdout);
    if (/Model:\s+\(not set\)/i.test(stdout)) {
      checks.push({
        level: "warn",
        message: "Hermes model is not set",
        hint: "Run `hermes model` inside WSL2 before the first sandbox wake-up.",
        code: "hermes_model_missing",
      });
    }
    if (/\.env file:\s+✗/i.test(stdout)) {
      checks.push({
        level: "warn",
        message: "Hermes .env file is not configured",
        hint: "Configure one provider/API key inside WSL2; do not store API keys in Paperclip docs or issues.",
        code: "hermes_env_missing",
      });
    }
    if (usesCustomEndpoint) {
      let bridgeReady = false;
      const bridgeStatusPaths: string[] = [];
      let candidateDir = process.cwd();
      for (let depth = 0; depth < 6; depth += 1) {
        bridgeStatusPaths.push(path.resolve(candidateDir, ".hermes-ollama-bridge-status.json"));
        const parent = path.dirname(candidateDir);
        if (parent === candidateDir) break;
        candidateDir = parent;
      }
      for (const bridgeStatusPath of bridgeStatusPaths) {
        try {
          const bridgeStatus = JSON.parse(fs.readFileSync(bridgeStatusPath, "utf8").replace(/^\uFEFF/, "")) as {
            ok?: unknown;
            openAiCompatibleBaseUrl?: unknown;
          };
          bridgeReady = bridgeStatus.ok === true && typeof bridgeStatus.openAiCompatibleBaseUrl === "string";
          if (bridgeReady) break;
        } catch {
          // Try the next likely repo location.
        }
      }

      checks.push({
        level: bridgeReady ? "info" : "warn",
        message: bridgeReady
          ? "Hermes is configured for the local Ollama bridge"
          : "Hermes uses a custom endpoint, but the local Ollama bridge status was not confirmed",
        hint: bridgeReady
          ? "This local-model route does not require cloud API keys for the first sandbox wake-up."
          : "Run `pnpm run hermes:ollama-bridge:restart`, then return to Office and press `重新檢查`.",
        code: bridgeReady ? "hermes_local_ollama_ready" : "hermes_local_ollama_bridge_missing",
      });
    } else if (/API Keys[\s\S]*OpenRouter\s+✗/i.test(stdout) && /OpenAI\s+✗/i.test(stdout)) {
      checks.push({
        level: "warn",
        message: "No obvious Hermes API key is configured",
        hint: "Use `hermes model` or `hermes config set` inside WSL2, then return to Office and press `重新檢查`.",
        code: "hermes_api_key_missing",
      });
    }
  } catch (err) {
    checks.push({
      level: "warn",
      message: "Could not read Hermes status through the Windows bridge",
      detail: err instanceof Error ? err.message : String(err),
      hint: "The CLI bridge works, but model/API key readiness could not be confirmed.",
      code: "hermes_status_unavailable",
    });
  }

  const status = checks.some((check) => check.level === "error")
    ? "fail"
    : checks.some((check) => check.level === "warn")
      ? "warn"
      : "pass";

  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}

function readConfiguredCommand(config: Record<string, unknown>, fallback: string): string {
  const value = typeof config.command === "string" ? config.command.trim() : "";
  return value.length > 0 ? value : fallback;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildNpmRuntimeCommandSpec(
  config: Record<string, unknown>,
  fallbackCommand: string,
  packageName: string,
): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config, fallbackCommand);
  const canSelfInstall = !hasPathSeparator(command) && command === fallbackCommand;
  const installLine = buildSandboxNpmInstallCommand(packageName);
  return {
    command,
    detectCommand: command,
    installCommand: canSelfInstall
      ? `if ! command -v ${shellQuote(command)} >/dev/null 2>&1; then ${installLine}; fi`
      : null,
  };
}

function buildCursorRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const command = readConfiguredCommand(config, "agent");
  return {
    command,
    detectCommand: command,
    installCommand: null,
  };
}

function normalizeHermesConfig<T extends { config?: unknown; agent?: unknown }>(ctx: T): T {
  const config =
    ctx && typeof ctx === "object" && "config" in ctx && ctx.config && typeof ctx.config === "object"
      ? (ctx.config as Record<string, unknown>)
      : null;
  const agent =
    ctx && typeof ctx === "object" && "agent" in ctx && ctx.agent && typeof ctx.agent === "object"
      ? (ctx.agent as Record<string, unknown>)
      : null;
  const agentAdapterConfig =
    agent?.adapterConfig && typeof agent.adapterConfig === "object"
      ? (agent.adapterConfig as Record<string, unknown>)
      : null;

  const configCommand =
    typeof config?.command === "string" && config.command.length > 0 ? config.command : undefined;
  const agentCommand =
    typeof agentAdapterConfig?.command === "string" && agentAdapterConfig.command.length > 0
      ? agentAdapterConfig.command
      : undefined;

  if (config && !config.hermesCommand && configCommand) {
    config.hermesCommand = configCommand;
  }
  if (agentAdapterConfig && !agentAdapterConfig.hermesCommand && agentCommand) {
    agentAdapterConfig.hermesCommand = agentCommand;
  }

  return ctx;
}

function dedupeAdapterModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const result: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ ...model, id });
  }
  return result;
}

function prefixAdapterModelLabels(models: AdapterModel[], provider: "Claude" | "Codex"): AdapterModel[] {
  const prefix = `${provider}: `;
  return models.map((model) => ({
    ...model,
    label: model.label.startsWith(prefix) ? model.label : `${prefix}${model.label}`,
  }));
}

async function listAcpxModels(): Promise<AdapterModel[]> {
  const [claude, codex] = await Promise.all([
    listClaudeModels().catch(() => claudeModels),
    listCodexModels().catch(() => codexModels),
  ]);
  return dedupeAdapterModels([
    ...acpxModels,
    ...prefixAdapterModelLabels(claude, "Claude"),
    ...prefixAdapterModelLabels(codex, "Codex"),
  ]);
}

const claudeLocalAdapter: ServerAdapterModule = {
  type: "claude_local",
  execute: claudeExecute,
  testEnvironment: claudeTestEnvironment,
  listSkills: listClaudeSkills,
  syncSkills: syncClaudeSkills,
  sessionCodec: claudeSessionCodec,
  sessionManagement: getAdapterSessionManagement("claude_local") ?? undefined,
  models: claudeModels,
  modelProfiles: claudeModelProfiles,
  listModels: listClaudeModels,
  refreshModels: refreshClaudeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "claude", "@anthropic-ai/claude-code"),
  agentConfigurationDoc: claudeAgentConfigurationDoc,
  getQuotaWindows: claudeGetQuotaWindows,
};

const acpxLocalAdapter: ServerAdapterModule = {
  type: "acpx_local",
  execute: acpxExecute,
  testEnvironment: acpxTestEnvironment,
  listSkills: listAcpxSkills,
  syncSkills: syncAcpxSkills,
  sessionCodec: acpxSessionCodec,
  sessionManagement: getAdapterSessionManagement("acpx_local") ?? undefined,
  models: dedupeAdapterModels([
    ...prefixAdapterModelLabels(claudeModels, "Claude"),
    ...prefixAdapterModelLabels(codexModels, "Codex"),
  ]),
  listModels: listAcpxModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: acpxAgentConfigurationDoc,
  getConfigSchema: getAcpxConfigSchema,
};

const codexLocalAdapter: ServerAdapterModule = {
  type: "codex_local",
  execute: codexExecute,
  testEnvironment: codexTestEnvironment,
  listSkills: listCodexSkills,
  syncSkills: syncCodexSkills,
  sessionCodec: codexSessionCodec,
  sessionManagement: getAdapterSessionManagement("codex_local") ?? undefined,
  models: codexModels,
  modelProfiles: codexModelProfiles,
  listModels: listCodexModels,
  refreshModels: refreshCodexModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  getRuntimeCommandSpec: (config) => buildNpmRuntimeCommandSpec(config, "codex", "@openai/codex"),
  agentConfigurationDoc: codexAgentConfigurationDoc,
  getQuotaWindows: codexGetQuotaWindows,
};

const cursorLocalAdapter: ServerAdapterModule = {
  type: "cursor",
  execute: cursorExecute,
  testEnvironment: cursorTestEnvironment,
  listSkills: listCursorSkills,
  syncSkills: syncCursorSkills,
  sessionCodec: cursorSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor") ?? undefined,
  models: cursorModels,
  modelProfiles: cursorModelProfiles,
  listModels: listCursorModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: buildCursorRuntimeCommandSpec,
  agentConfigurationDoc: cursorAgentConfigurationDoc,
};

const cursorCloudAdapter: ServerAdapterModule = {
  type: "cursor_cloud",
  execute: cursorCloudExecute,
  testEnvironment: cursorCloudTestEnvironment,
  sessionCodec: cursorCloudSessionCodec,
  sessionManagement: getAdapterSessionManagement("cursor_cloud") ?? undefined,
  models: [],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: cursorCloudAgentConfigurationDoc,
  getConfigSchema: getCursorCloudConfigSchema,
};

const geminiLocalAdapter: ServerAdapterModule = {
  type: "gemini_local",
  execute: geminiExecute,
  testEnvironment: geminiTestEnvironment,
  listSkills: listGeminiSkills,
  syncSkills: syncGeminiSkills,
  sessionCodec: geminiSessionCodec,
  sessionManagement: getAdapterSessionManagement("gemini_local") ?? undefined,
  models: geminiModels,
  modelProfiles: geminiModelProfiles,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "gemini", "@google/gemini-cli"),
  agentConfigurationDoc: geminiAgentConfigurationDoc,
};

const grokLocalAdapter: ServerAdapterModule = {
  type: "grok_local",
  execute: grokExecute,
  testEnvironment: grokTestEnvironment,
  listSkills: listGrokSkills,
  syncSkills: syncGrokSkills,
  sessionCodec: grokSessionCodec,
  sessionManagement: getAdapterSessionManagement("grok_local") ?? undefined,
  models: grokModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => ({
    command: readConfiguredCommand(config, "grok"),
    detectCommand: readConfiguredCommand(config, "grok"),
    installCommand: null,
  }),
  agentConfigurationDoc: grokAgentConfigurationDoc,
};

const openclawGatewayAdapter: ServerAdapterModule = {
  type: "openclaw_gateway",
  execute: openclawGatewayExecute,
  testEnvironment: openclawGatewayTestEnvironment,
  models: openclawGatewayModels,
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: openclawGatewayAgentConfigurationDoc,
};

const openCodeLocalAdapter: ServerAdapterModule = {
  type: "opencode_local",
  execute: openCodeExecute,
  testEnvironment: openCodeTestEnvironment,
  listSkills: listOpenCodeSkills,
  syncSkills: syncOpenCodeSkills,
  sessionCodec: openCodeSessionCodec,
  models: openCodeModels,
  modelProfiles: openCodeModelProfiles,
  sessionManagement: getAdapterSessionManagement("opencode_local") ?? undefined,
  listModels: listOpenCodeModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) => buildNpmRuntimeCommandSpec(config, "opencode", "opencode-ai"),
  agentConfigurationDoc: openCodeAgentConfigurationDoc,
};

const piLocalAdapter: ServerAdapterModule = {
  type: "pi_local",
  execute: piExecute,
  testEnvironment: piTestEnvironment,
  listSkills: listPiSkills,
  syncSkills: syncPiSkills,
  sessionCodec: piSessionCodec,
  sessionManagement: getAdapterSessionManagement("pi_local") ?? undefined,
  models: [],
  modelProfiles: piModelProfiles,
  listModels: listPiModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: true,
  getRuntimeCommandSpec: (config) =>
    buildNpmRuntimeCommandSpec(config, "pi", "@mariozechner/pi-coding-agent"),
  agentConfigurationDoc: piAgentConfigurationDoc,
};

// hermes-paperclip-adapter v0.2.0 predates the authToken field; cast is
// intentional until hermes ships a matching AdapterExecutionContext type.
const executeHermesLocal = hermesExecute as unknown as ServerAdapterModule["execute"];

const hermesLocalAdapter: ServerAdapterModule = {
  type: "hermes_local",
  execute: async (ctx) => {
    const normalizedCtx = normalizeHermesConfig(ctx);

    const existingConfig = (normalizedCtx.agent.adapterConfig ?? {}) as Record<string, unknown>;
    const existingEnv =
      typeof existingConfig.env === "object" && existingConfig.env !== null && !Array.isArray(existingConfig.env)
        ? (existingConfig.env as Record<string, string>)
        : {};
    const explicitApiKey =
      typeof existingEnv.PAPERCLIP_API_KEY === "string" && existingEnv.PAPERCLIP_API_KEY.trim().length > 0;
    const promptTemplate =
      typeof existingConfig.promptTemplate === "string" && existingConfig.promptTemplate.trim().length > 0
        ? existingConfig.promptTemplate
        : "";
    const authGuardPrompt = [
      "Paperclip API safety rule:",
      "Use Authorization: Bearer $PAPERCLIP_API_KEY on every Paperclip API request.",
      "Use X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID on every Paperclip API request that writes or mutates data, including comments and issue updates.",
      "Never use a board, browser, or local-board session for Paperclip API writes.",
    ].join("\n");

    const patchedConfig: Record<string, unknown> = {
      ...existingConfig,
      env: {
        ...existingEnv,
        ...(!explicitApiKey && normalizedCtx.authToken ? { PAPERCLIP_API_KEY: normalizedCtx.authToken } : {}),
        PAPERCLIP_RUN_ID: normalizedCtx.runId,
      },
    };

    // Move agent-specific instructions into taskBody so Paperclip can own the
    // final prompt ordering for runtime capability-key checks.
    // When no custom template is set, Hermes uses its built-in default heartbeat/task prompt —
    // overwriting it with only the auth guard text would strip the assigned issue/workflow instructions.
    if (promptTemplate) {
      delete patchedConfig.promptTemplate;
    }

    const paperclipTaskConfig = buildHermesPaperclipTaskConfig(normalizedCtx.config, normalizedCtx.context);
    const existingTaskBody =
      typeof paperclipTaskConfig.taskBody === "string" && paperclipTaskConfig.taskBody.trim().length > 0
        ? paperclipTaskConfig.taskBody
        : "";
    const promptTemplateTaskBody =
      promptTemplate.length > 0
        ? [
            "## Hermes Agent Instructions",
            "",
            "The following agent-specific instructions were moved into the task body so Hermes keeps its built-in Paperclip task context.",
            "",
            promptTemplate,
          ].join("\n")
        : "";
    const requireRuntimeCapabilityProof = shouldRequireHermesRuntimeCapabilityProof(
      [existingTaskBody, promptTemplateTaskBody].filter((section) => section.trim().length > 0).join("\n\n"),
    );
    const runtimeSkillPrompt = buildHermesRuntimeSkillPrompt(
      {
        ...existingConfig,
        ...(normalizedCtx.config ?? {}),
      },
      { includeSkillInstructions: requireRuntimeCapabilityProof },
    );
    const taskBodySections = [
      existingTaskBody,
      normalizedCtx.authToken || explicitApiKey ? authGuardPrompt : "",
      promptTemplateTaskBody,
      runtimeSkillPrompt,
    ].filter((section) => section.trim().length > 0);
    const patchedRuntimeConfig =
      taskBodySections.length > 0
        ? {
            ...normalizedCtx.config,
            ...paperclipTaskConfig,
            taskBody: taskBodySections.join("\n\n"),
          }
        : {
            ...normalizedCtx.config,
            ...paperclipTaskConfig,
          };

    const patchedTaskBody =
      typeof (patchedRuntimeConfig as Record<string, unknown>).taskBody === "string"
        ? ((patchedRuntimeConfig as Record<string, unknown>).taskBody as string)
        : "";
    const agentInstructionsIndex = patchedTaskBody.indexOf("## Hermes Agent Instructions");
    const runtimeSkillsIndex = patchedTaskBody.indexOf("## Paperclip Runtime Capability Keys");
    const runtimeSkillsAfterAgentInstructions =
      runtimeSkillsIndex >= 0 && (agentInstructionsIndex < 0 || runtimeSkillsIndex > agentInstructionsIndex);
    const runtimeSkillKeys = extractHermesRuntimeSkillKeys(runtimeSkillPrompt);
    if (runtimeSkillKeys.length > 0) {
      patchedConfig.promptTemplate = buildHermesPaperclipPromptTemplate(
        runtimeSkillKeys,
        requireRuntimeCapabilityProof,
      );
    }

    const patchedCtx = {
      ...normalizedCtx,
      config: patchedRuntimeConfig,
      agent: {
        ...normalizedCtx.agent,
        adapterConfig: patchedConfig,
      },
    };

    await normalizedCtx.onLog?.(
      "stdout",
      `[paperclip] Hermes prompt routing: taskId=${Boolean((patchedRuntimeConfig as Record<string, unknown>).taskId)} taskBody=${Boolean((patchedRuntimeConfig as Record<string, unknown>).taskBody)} taskBodyChars=${patchedTaskBody.length} runtimeSkills=${Boolean(runtimeSkillPrompt)} runtimeSkillsAfterAgentInstructions=${runtimeSkillsAfterAgentInstructions} runtimeSkillKeys=${runtimeSkillKeys.join(",")} runtimeCapabilityProofRequired=${requireRuntimeCapabilityProof} movedPromptTemplate=${Boolean(promptTemplate)} authToken=${Boolean(normalizedCtx.authToken)} explicitApiKey=${explicitApiKey}\n`,
    );

    return executeHermesLocal(patchedCtx);
  },
  testEnvironment: (ctx) => {
    const normalizedCtx = normalizeHermesConfig(ctx);
    const config = getConfigObject(normalizedCtx);
    const command = asConfigString(config.hermesCommand) ?? asConfigString(config.command);
    if (process.platform === "win32" && command && /\.(cmd|bat)$/i.test(command)) {
      return testHermesWindowsBridge(normalizedCtx as AdapterEnvironmentTestContext, command);
    }
    return hermesTestEnvironment(normalizedCtx as never);
  },
  sessionCodec: hermesSessionCodec,
  listSkills: hermesListSkills,
  syncSkills: hermesSyncSkills,
  models: hermesModels,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc: hermesAgentConfigurationDoc,
  detectModel: () => detectModelFromHermes(),
};

const adaptersByType = new Map<string, ServerAdapterModule>();

// For builtin types that are overridden by an external adapter, we keep the
// original builtin so it can be restored when the override is deactivated.
const builtinFallbacks = new Map<string, ServerAdapterModule>();

// Tracks which override types are currently deactivated (paused).  When
// paused, `getServerAdapter()` returns the builtin fallback instead of the
// external.  Persisted across reloads via the same disabled-adapters store.
const pausedOverrides = new Set<string>();

function registerBuiltInAdapters() {
  for (const adapter of [
    acpxLocalAdapter,
    claudeLocalAdapter,
    codexLocalAdapter,
    openCodeLocalAdapter,
    piLocalAdapter,
    cursorCloudAdapter,
    cursorLocalAdapter,
    geminiLocalAdapter,
    grokLocalAdapter,
    openclawGatewayAdapter,
    hermesLocalAdapter,
    processAdapter,
    httpAdapter,
  ]) {
    adaptersByType.set(adapter.type, adapter);
  }
}

registerBuiltInAdapters();

// ---------------------------------------------------------------------------
// Load external adapter plugins (e.g. droid_local)
//
// External adapter packages export createServerAdapter() which returns a
// ServerAdapterModule. When the module provides its own sessionManagement
// it is preserved; otherwise the host falls back to the built-in registry
// lookup (so externals that override a built-in type inherit the builtin's
// policy). This brings init-time registration to at-least-as-good behavior
// as the hot-install path (routes/adapters.ts:179 -> registerServerAdapter):
// both preserve module-provided sessionManagement, and init-time additionally
// applies the registry fallback for externals overriding a built-in type.
// ---------------------------------------------------------------------------

/** Cached sync wrapper — the store is a simple JSON file read, safe to call frequently. */
function getDisabledAdapterTypesFromStore(): string[] {
  return getDisabledAdapterTypes();
}

/**
 * Merge an external adapter module with host-provided session management.
 *
 * Module-provided `sessionManagement` takes precedence. When absent, fall
 * back to the hardcoded registry keyed by adapter type (so externals that
 * override a built-in — same `type` — inherit the builtin's policy). If
 * neither is available, `sessionManagement` remains `undefined`.
 *
 * Used by both the init-time IIFE below (external-adapter load pass on
 * server start) and the hot-install path in `routes/adapters.ts`
 * (`registerWithSessionManagement`), so the two load paths resolve
 * `sessionManagement` identically.
 */
export function resolveExternalAdapterRegistration(
  externalAdapter: ServerAdapterModule,
): ServerAdapterModule {
  return {
    ...externalAdapter,
    sessionManagement:
      externalAdapter.sessionManagement
        ?? getAdapterSessionManagement(externalAdapter.type)
        ?? undefined,
  };
}

/**
 * Load external adapters from the plugin store and hardcoded sources.
 * Called once at module initialization. The promise is exported so that
 * callers (e.g. assertKnownAdapterType, app startup) can await completion
 * and avoid racing against the loading window.
 */
const externalAdaptersReady: Promise<void> = (async () => {
  try {
    const externalAdapters = await buildExternalAdapters();
    for (const externalAdapter of externalAdapters) {
      const overriding = BUILTIN_ADAPTER_TYPES.has(externalAdapter.type);
      if (overriding) {
        console.log(
          `[paperclip] External adapter "${externalAdapter.type}" overrides built-in adapter`,
        );
        // Save the original builtin for later restoration.
        const existing = adaptersByType.get(externalAdapter.type);
        if (existing && !builtinFallbacks.has(externalAdapter.type)) {
          builtinFallbacks.set(externalAdapter.type, existing);
        }
      }
      adaptersByType.set(
        externalAdapter.type,
        resolveExternalAdapterRegistration(externalAdapter),
      );
    }
  } catch (err) {
    console.error("[paperclip] Failed to load external adapters:", err);
  }
})();

/**
 * Await this before validating adapter types to avoid race conditions
 * during server startup. External adapters are loaded asynchronously;
 * calling assertKnownAdapterType before this resolves will reject
 * valid external adapter types.
 */
export function waitForExternalAdapters(): Promise<void> {
  return externalAdaptersReady;
}

export function registerServerAdapter(adapter: ServerAdapterModule): void {
  if (BUILTIN_ADAPTER_TYPES.has(adapter.type) && !builtinFallbacks.has(adapter.type)) {
    const existing = adaptersByType.get(adapter.type);
    if (existing) {
      builtinFallbacks.set(adapter.type, existing);
    }
  }
  adaptersByType.set(adapter.type, adapter);
}

export function unregisterServerAdapter(type: string): void {
  if (type === processAdapter.type || type === httpAdapter.type) return;
  if (builtinFallbacks.has(type)) {
    pausedOverrides.delete(type);
    const fallback = builtinFallbacks.get(type);
    if (fallback) {
      adaptersByType.set(type, fallback);
    }
    return;
  }
  if (BUILTIN_ADAPTER_TYPES.has(type)) {
    return;
  }
  adaptersByType.delete(type);
}

export function requireServerAdapter(type: string): ServerAdapterModule {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) {
    throw new Error(`Unknown adapter type: ${type}`);
  }
  return adapter;
}

export function getServerAdapter(type: string): ServerAdapterModule {
  return findActiveServerAdapter(type) ?? processAdapter;
}

export async function listAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function refreshAdapterModels(type: string): Promise<{ id: string; label: string }[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.refreshModels) {
    const refreshed = await adapter.refreshModels();
    if (refreshed.length > 0) return refreshed;
  }
  if (adapter.listModels) {
    const discovered = await adapter.listModels();
    if (discovered.length > 0) return discovered;
  }
  return adapter.models ?? [];
}

export async function listAdapterModelProfiles(type: string): Promise<AdapterModelProfileDefinition[]> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter) return [];
  if (adapter.listModelProfiles) {
    const discovered = await adapter.listModelProfiles();
    if (discovered.length > 0) return discovered;
  }
  return adapter.modelProfiles ?? [];
}

export function listServerAdapters(): ServerAdapterModule[] {
  return Array.from(adaptersByType.values());
}

/**
 * List adapters excluding those that are disabled in settings.
 * Used for menus and agent creation flows — disabled adapters remain
 * functional for existing agents but hidden from selection.
 */
export function listEnabledServerAdapters(): ServerAdapterModule[] {
  const disabled = getDisabledAdapterTypesFromStore();
  const disabledSet = disabled.length > 0 ? new Set(disabled) : null;
  return disabledSet
    ? Array.from(adaptersByType.values()).filter((a) => !disabledSet.has(a.type))
    : Array.from(adaptersByType.values());
}

export async function detectAdapterModel(
  type: string,
): Promise<{ model: string; provider: string; source: string; candidates?: string[] } | null> {
  const adapter = findActiveServerAdapter(type);
  if (!adapter?.detectModel) return null;
  const detected = await adapter.detectModel();
  if (!detected) return null;
  return {
    model: detected.model,
    provider: detected.provider,
    source: detected.source,
    ...(detected.candidates?.length ? { candidates: detected.candidates } : {}),
  };
}

// ---------------------------------------------------------------------------
// Override pause / resume
// ---------------------------------------------------------------------------

/**
 * Pause or resume an external override for a builtin adapter type.
 *
 * - `paused = true`  → subsequent calls to `getServerAdapter(type)` return
 *   the builtin fallback instead of the external adapter.  Already-running
 *   agent sessions are unaffected (they hold a reference to the module they
 *   started with).
 *
 * - `paused = false` → the external adapter is active again.
 *
 * Returns `true` if the state actually changed, `false` if the type is not
 * an override or was already in the requested state.
 */
export function setOverridePaused(type: string, paused: boolean): boolean {
  if (!builtinFallbacks.has(type)) return false;
  const wasPaused = pausedOverrides.has(type);
  if (paused && !wasPaused) {
    pausedOverrides.add(type);
    console.log(`[paperclip] Override paused for "${type}" — builtin adapter restored`);
    return true;
  }
  if (!paused && wasPaused) {
    pausedOverrides.delete(type);
    console.log(`[paperclip] Override resumed for "${type}" — external adapter active`);
    return true;
  }
  return false;
}

/** Check whether the external override for a builtin type is currently paused. */
export function isOverridePaused(type: string): boolean {
  return pausedOverrides.has(type);
}

/** Get the set of types whose overrides are currently paused. */
export function getPausedOverrides(): Set<string> {
  return pausedOverrides;
}

export function findServerAdapter(type: string): ServerAdapterModule | null {
  return adaptersByType.get(type) ?? null;
}

export function findActiveServerAdapter(type: string): ServerAdapterModule | null {
  if (pausedOverrides.has(type)) {
    const fallback = builtinFallbacks.get(type);
    if (fallback) return fallback;
  }
  return adaptersByType.get(type) ?? null;
}
