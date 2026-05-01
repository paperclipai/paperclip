import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_ACPX_LOCAL_AGENT,
  DEFAULT_ACPX_LOCAL_MODE,
  DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACPX_LOCAL_PERMISSION_MODE,
  DEFAULT_ACPX_LOCAL_TIMEOUT_SEC,
  acpxAgentOptions,
} from "../index.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "agent",
        label: "ACP agent",
        type: "select",
        default: DEFAULT_ACPX_LOCAL_AGENT,
        required: true,
        options: acpxAgentOptions.map((agent) => ({ value: agent.id, label: agent.label })),
        hint: "Choose the ACP agent launched through ACPX.",
      },
      {
        key: "agentCommand",
        label: "Agent command",
        type: "text",
        hint: "Required for custom agents; optional override for built-in Claude or Codex ACP commands.",
      },
      {
        key: "mode",
        label: "Session mode",
        type: "select",
        default: DEFAULT_ACPX_LOCAL_MODE,
        options: [
          { value: "persistent", label: "Persistent" },
          { value: "oneshot", label: "One shot" },
        ],
      },
      {
        key: "permissionMode",
        label: "Permission mode",
        type: "select",
        default: DEFAULT_ACPX_LOCAL_PERMISSION_MODE,
        options: [
          { value: "approve-all", label: "Approve all" },
          { value: "default", label: "Approve reads" },
        ],
        hint: "Defaults to maximum permissions. Approve reads grants read-only requests and asks for approval on writes.",
      },
      {
        key: "nonInteractivePermissions",
        label: "Non-interactive permissions",
        type: "select",
        default: DEFAULT_ACPX_LOCAL_NON_INTERACTIVE_PERMISSIONS,
        options: [
          { value: "deny", label: "Deny" },
          { value: "fail", label: "Fail" },
        ],
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute fallback directory. Paperclip execution workspaces can override this at runtime.",
      },
      {
        key: "stateDir",
        label: "State directory",
        type: "text",
        hint: "Optional ACPX session state directory. Defaults to Paperclip-managed company/agent scoped storage.",
      },
      {
        key: "instructionsFilePath",
        label: "Instructions file",
        type: "text",
        hint: "Optional absolute path to markdown instructions injected into the run prompt.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
      },
      {
        key: "bootstrapPromptTemplate",
        label: "Bootstrap prompt template",
        type: "textarea",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_ACPX_LOCAL_TIMEOUT_SEC,
      },
      {
        key: "env",
        label: "Environment JSON",
        type: "textarea",
        hint: "Optional JSON object of environment values or secret bindings.",
      },
    ],
  };
}
