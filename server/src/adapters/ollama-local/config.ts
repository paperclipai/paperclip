import path from "node:path";
import type { AdapterConfigSchema } from "../types.js";
import { asBoolean, asNumber, asString } from "../utils.js";

export const DEFAULT_OLLAMA_LOCAL_BASE_URL =
  (typeof process.env.OLLAMA_BASE_URL === "string" && process.env.OLLAMA_BASE_URL.trim()) ||
  "http://127.0.0.1:11434";

export const OLLAMA_SKILL_SELECTION_MODES = ["deterministic", "llm"] as const;
export type OllamaSkillSelectionMode = (typeof OLLAMA_SKILL_SELECTION_MODES)[number];

export type OllamaThinkingLevel = false | "low" | "medium" | "high";

export interface OllamaLocalConfig extends Record<string, unknown> {
  model: string;
  baseUrl: string;
  timeoutSec: number;
  ollamaTimeoutSec: number;
  logging: boolean;
  streaming: boolean;
  enableCommandExecution: boolean;
  commandCwd: string | null;
  commandTimeoutSec: number;
  maxToolCalls: number;
  think: OllamaThinkingLevel;
  skillSelectionMode: OllamaSkillSelectionMode;
  instructions: string | null;
  promptTemplate: string | null;
}

export function normalizeOllamaLocalBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CONFIG_INVALID: baseUrl must be an absolute http/https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("CONFIG_INVALID: baseUrl must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function parseThinkingLevel(value: unknown): OllamaThinkingLevel {
  const normalized = asString(value, "").trim().toLowerCase();
  if (!normalized || normalized === "auto") return false;
  if (normalized === "false" || normalized === "off" || normalized === "none") return false;
  if (normalized === "low" || normalized === "medium" || normalized === "high") return normalized;
  throw new Error('CONFIG_INVALID: think must be one of "low", "medium", "high", or false');
}

export function parseOllamaLocalConfig(raw: Record<string, unknown>): OllamaLocalConfig {
  const model = asString(raw.model, "").trim();
  if (!model) {
    throw new Error("CONFIG_INVALID: model is required");
  }

  const baseUrl = normalizeOllamaLocalBaseUrl(asString(raw.baseUrl, DEFAULT_OLLAMA_LOCAL_BASE_URL).trim());
  const commandCwd = asString(raw.commandCwd, "").trim() || null;
  if (commandCwd && !path.isAbsolute(commandCwd)) {
    throw new Error("CONFIG_INVALID: commandCwd must be an absolute path");
  }

  const skillSelectionMode = asString(raw.skillSelectionMode, "deterministic").trim() as OllamaSkillSelectionMode;
  if (!OLLAMA_SKILL_SELECTION_MODES.includes(skillSelectionMode)) {
    throw new Error(
      `CONFIG_INVALID: skillSelectionMode must be one of ${OLLAMA_SKILL_SELECTION_MODES.join(", ")}`,
    );
  }

  const timeoutSec = Math.max(1, asNumber(raw.timeoutSec, 180));
  const ollamaTimeoutSec = Math.max(1, asNumber(raw.ollamaTimeoutSec, 90));
  const commandTimeoutSec = Math.max(1, asNumber(raw.commandTimeoutSec, 120));
  const maxToolCalls = Math.max(1, Math.trunc(asNumber(raw.maxToolCalls, 8)));

  return {
    model,
    baseUrl,
    timeoutSec,
    ollamaTimeoutSec,
    logging: asBoolean(raw.logging, false),
    streaming: asBoolean(raw.streaming, true),
    enableCommandExecution: asBoolean(raw.enableCommandExecution, false),
    commandCwd,
    commandTimeoutSec,
    maxToolCalls,
    think: parseThinkingLevel(raw.think),
    skillSelectionMode,
    instructions: asString(raw.instructions, "").trim() || null,
    promptTemplate: asString(raw.promptTemplate, "").trim() || null,
  };
}

export function getOllamaLocalConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "baseUrl",
        label: "Base URL",
        type: "text",
        required: true,
        default: DEFAULT_OLLAMA_LOCAL_BASE_URL,
        hint: "Absolute HTTP or HTTPS base URL for the Ollama server",
      },
      {
        key: "timeoutSec",
        label: "Run Timeout (seconds)",
        type: "number",
        default: 180,
        hint: "Overall adapter timeout including tool calls",
      },
      {
        key: "ollamaTimeoutSec",
        label: "Ollama Request Timeout (seconds)",
        type: "number",
        default: 90,
        hint: "Timeout for a single Ollama API request",
      },
      {
        key: "logging",
        label: "Verbose Logging",
        type: "toggle",
        default: false,
      },
      {
        key: "streaming",
        label: "Stream Responses",
        type: "toggle",
        default: true,
      },
      {
        key: "think",
        label: "Thinking Effort",
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: "Auto / Off" },
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        hint: "Passed through to Ollama servers that support Qwen thinking levels",
      },
      {
        key: "enableCommandExecution",
        label: "Enable Command Execution",
        type: "toggle",
        default: false,
        hint: "Allow the model to call the built-in run_command tool",
      },
      {
        key: "commandCwd",
        label: "Command Working Directory",
        type: "text",
        hint: "Optional absolute default cwd for run_command tool calls",
      },
      {
        key: "commandTimeoutSec",
        label: "Command Timeout (seconds)",
        type: "number",
        default: 120,
      },
      {
        key: "maxToolCalls",
        label: "Max Tool Calls",
        type: "number",
        default: 8,
      },
      {
        key: "skillSelectionMode",
        label: "Skill Selection Mode",
        type: "select",
        default: "deterministic",
        options: [
          { value: "deterministic", label: "Deterministic" },
          { value: "llm", label: "LLM-assisted" },
        ],
        hint: "Choose how Paperclip selects which desired skills to expand into the prompt",
      },
      {
        key: "instructions",
        label: "Instructions",
        type: "textarea",
        hint: "Optional adapter-level system instructions prepended before the Paperclip wake prompt",
      },
      {
        key: "promptTemplate",
        label: "Prompt Template",
        type: "textarea",
        hint: "Optional Paperclip wake prompt template appended after the rendered wake context",
      },
    ],
  };
}
