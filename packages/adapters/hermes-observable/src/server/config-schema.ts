import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_ENDPOINT_MODE,
  DEFAULT_HEARTBEAT_SEC,
  DEFAULT_HERMES_API_BASE_URL,
  DEFAULT_TIMEOUT_SEC,
  PROVIDER_OPTIONS,
} from "../shared/constants.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "hermesApiBaseUrl",
        label: "Hermes API base URL",
        type: "text",
        default: DEFAULT_HERMES_API_BASE_URL,
        required: true,
        hint: "Hermes gateway root URL. The adapter probes /health and /v1/capabilities here.",
      },
      {
        key: "endpointMode",
        label: "Endpoint mode",
        type: "select",
        default: DEFAULT_ENDPOINT_MODE,
        options: [
          { label: "Responses API", value: "responses" },
          { label: "Chat Completions", value: "chat_completions" },
        ],
        hint: "Responses is preferred. Older Hermes builds can use chat completions streaming instead.",
      },
      {
        key: "model",
        label: "Model override",
        type: "text",
        hint: "Optional request model. Leave blank to use the Hermes gateway default.",
      },
      {
        key: "provider",
        label: "Provider",
        type: "select",
        default: "auto",
        options: PROVIDER_OPTIONS.map((provider) => ({
          label: provider,
          value: provider,
        })),
        hint: "Provider hint returned in Paperclip result metadata.",
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
      },
      {
        key: "heartbeatSec",
        label: "Watchdog seconds",
        type: "number",
        default: DEFAULT_HEARTBEAT_SEC,
        hint: "Interval for [hermes] still running... watchdog messages.",
      },
      {
        key: "debugEvents",
        label: "Debug SSE events",
        type: "toggle",
        default: false,
        hint: "Log unknown or adapter-internal SSE events as Paperclip system lines.",
      },
      {
        key: "allowCliFallback",
        label: "Allow CLI fallback",
        type: "toggle",
        default: false,
        hint: "Only use the legacy hermes CLI path when the API server is unreachable.",
      },
      {
        key: "hermesCommand",
        label: "Hermes CLI command",
        type: "text",
        hint: "Used only when allowCliFallback is enabled.",
        meta: {
          visibleWhen: {
            key: "allowCliFallback",
            values: [true],
          },
        },
      },
    ],
  };
}
