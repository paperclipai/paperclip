import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "@paperclipai/adapter-utils/acpx-engine/constants";

const acpVisible = { visibleWhen: { key: "engine", values: ["acp"] } };

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "engine",
        label: "Execution engine",
        type: "select",
        default: "auto",
        options: [
          { value: "auto", label: "Auto (ACP preferred)" },
          { value: "cli", label: "Codex CLI" },
          { value: "acp", label: "ACP" },
        ],
        hint: "Auto uses ACP when prerequisites pass and falls back to Codex CLI with diagnostics.",
      },
      {
        key: "agentCommand",
        label: "ACP server command",
        type: "text",
        hint: "Optional override for the Codex ACP server command. Defaults to the package-local codex-acp binary.",
        meta: acpVisible,
      },
      {
        key: "mode",
        label: "ACP session mode",
        type: "select",
        default: DEFAULT_ACP_ENGINE_MODE,
        options: [
          { value: "persistent", label: "Persistent" },
          { value: "oneshot", label: "One-shot" },
        ],
        hint: "Persistent keeps ACP session state between runs. One-shot starts fresh each run.",
        meta: acpVisible,
      },
      {
        key: "nonInteractivePermissions",
        label: "ACP non-interactive permissions",
        type: "select",
        default: DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
        options: [
          { value: "deny", label: "Deny" },
          { value: "fail", label: "Fail" },
        ],
        hint: "Fallback if the ACP agent asks for input outside an interactive session.",
        meta: acpVisible,
      },
      {
        key: "stateDir",
        label: "ACP state directory",
        type: "text",
        hint: "Optional ACP session state directory. Defaults to Paperclip-managed company/agent scoped storage.",
        meta: acpVisible,
      },
      {
        key: "warmHandleIdleMs",
        label: "ACP warm process idle ms",
        type: "number",
        default: DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
        hint: "Defaults to 0, which closes the ACP process after each run while retaining persistent session state.",
        meta: acpVisible,
      },
    ],
  };
}
