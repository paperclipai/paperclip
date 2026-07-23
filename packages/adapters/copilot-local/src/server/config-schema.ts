import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_ACP_ENGINE_MODE,
  DEFAULT_ACP_ENGINE_NON_INTERACTIVE_PERMISSIONS,
  DEFAULT_ACP_ENGINE_PERMISSION_MODE,
  DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
} from "@paperclipai/adapter-utils/acpx-engine/constants";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "agentCommand",
        label: "ACP server command",
        type: "text",
        hint: "Optional full command override. Defaults to a managed `copilot --acp --stdio` invocation.",
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
        hint: "Persistent retains the Copilot ACP session between heartbeats.",
      },
      {
        key: "permissionMode",
        label: "ACP permission mode",
        type: "select",
        default: DEFAULT_ACP_ENGINE_PERMISSION_MODE,
        options: [
          { value: "approve-all", label: "Approve all" },
          { value: "approve-reads", label: "Approve reads" },
          { value: "deny-all", label: "Deny all" },
        ],
        hint: "Controls how Paperclip answers Copilot tool permission requests.",
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
        hint: "Fallback when Copilot requests input outside an interactive session.",
      },
      {
        key: "stateDir",
        label: "ACP state directory",
        type: "text",
        hint: "Optional ACP runtime state directory. Defaults to Paperclip-managed storage.",
      },
      {
        key: "warmHandleIdleMs",
        label: "ACP warm process idle ms",
        type: "number",
        default: DEFAULT_ACP_ENGINE_WARM_HANDLE_IDLE_MS,
        hint: "Defaults to 0, closing the process after each run while retaining session state.",
      },
    ],
  };
}
