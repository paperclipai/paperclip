import type {
  AdapterConfigSchema,
  AdapterRuntimeCommandSpec,
  AdapterSessionCodec,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  ADAPTER_TYPE,
  DEFAULT_AIDER_CHAT_HISTORY_FILE,
  DEFAULT_AIDER_LOCAL_MODEL,
  models,
} from "../shared/constants.js";
import { agentConfigurationDoc } from "../shared/agent-configuration-doc.js";
import { execute } from "./execute.js";
import { listAiderSkills, syncAiderSkills } from "./skills.js";
import { testEnvironment } from "./test.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSession(record: Record<string, unknown>): Record<string, unknown> | null {
  const chatHistoryFile =
    readNonEmptyString(record.chatHistoryFile) ?? readNonEmptyString(record.chat_history_file);
  if (!chatHistoryFile) return null;
  const cwd = readNonEmptyString(record.cwd) ?? readNonEmptyString(record.workdir);
  const workspaceId = readNonEmptyString(record.workspaceId) ?? readNonEmptyString(record.workspace_id);
  const repoUrl = readNonEmptyString(record.repoUrl) ?? readNonEmptyString(record.repo_url);
  const repoRef = readNonEmptyString(record.repoRef) ?? readNonEmptyString(record.repo_ref);
  const remoteExecution =
    typeof record.remoteExecution === "object" && record.remoteExecution !== null
      ? (record.remoteExecution as Record<string, unknown>)
      : null;
  return {
    chatHistoryFile,
    ...(cwd ? { cwd } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoRef ? { repoRef } : {}),
    ...(remoteExecution ? { remoteExecution } : {}),
  };
}

/**
 * Aider has no server-side session id — continuity is the chat transcript file
 * plus the cwd it was written in, so that pair is what persists.
 */
export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    return readSession(raw as Record<string, unknown>);
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readSession(params);
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.chatHistoryFile) ?? readNonEmptyString(params.chat_history_file);
  },
};

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "text",
        default: DEFAULT_AIDER_LOCAL_MODEL,
        hint: "Aider model alias (sonnet, gpt-5) or a full litellm model id. Leave as aider-default to use Aider's own configuration.",
      },
      {
        key: "chatHistoryFile",
        label: "Chat history file",
        type: "text",
        default: DEFAULT_AIDER_CHAT_HISTORY_FILE,
        hint: "Transcript Aider restores on the next heartbeat. Relative paths resolve inside the run working directory.",
      },
      {
        key: "autoCommits",
        label: "Let Aider commit",
        type: "toggle",
        default: false,
        hint: "Off passes --no-auto-commits so Paperclip's workspace sync decides what gets committed.",
      },
      {
        key: "alwaysApprove",
        label: "Unattended approvals",
        type: "toggle",
        default: true,
        hint: "Passes --yes-always. Turn off for Aider builds that still spell the flag --yes, and add it to extra args.",
      },
      {
        key: "stream",
        label: "Stream model output",
        type: "toggle",
        default: true,
        hint: "Off passes --no-stream, which prints the reply only once the turn completes.",
      },
      {
        key: "mapTokens",
        label: "Repo map tokens",
        type: "number",
        hint: "Optional --map-tokens budget for Aider's repository map.",
      },
    ],
  };
}

export function getRuntimeCommandSpec(config: Record<string, unknown>): AdapterRuntimeCommandSpec {
  const configured = typeof config.command === "string" ? config.command.trim() : "";
  const command = configured.length > 0 ? configured : "aider";
  return {
    command,
    detectCommand: command,
    // Aider installs through pip/uv, not npm, and the install path varies per
    // host, so remote provisioning stays an operator decision.
    installCommand: null,
  };
}

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    listSkills: listAiderSkills,
    syncSkills: syncAiderSkills,
    sessionCodec,
    models,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: true,
    getRuntimeCommandSpec,
    agentConfigurationDoc,
    getConfigSchema,
  };
}

export { execute } from "./execute.js";
export { listAiderSkills, syncAiderSkills } from "./skills.js";
export { testEnvironment, parseAiderVersion } from "./test.js";
export { parseAiderOutput, isAiderQuotaError, stripAnsi } from "./parse.js";
