import {
  ADAPTER_LABEL,
  ADAPTER_TYPE,
  DEFAULT_ENDPOINT_MODE,
  DEFAULT_HEARTBEAT_SEC,
  DEFAULT_HERMES_API_BASE_URL,
  DEFAULT_TIMEOUT_SEC,
} from "./shared/constants.js";
import { models as hermesModels } from "hermes-paperclip-adapter";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

export const models = hermesModels;

export const agentConfigurationDoc = `# Hermes Observable Configuration

Hermes Observable uses the Hermes gateway API instead of CLI stdout parsing, so
Paperclip receives structured assistant deltas, tool lifecycle events, and
watchdog status lines during the run.

## Required

| Field | Type | Default | Description |
|---|---|---|---|
| hermesApiBaseUrl | string | ${DEFAULT_HERMES_API_BASE_URL} | Base URL for the Hermes gateway API server. |
| endpointMode | string | ${DEFAULT_ENDPOINT_MODE} | Prefer \`responses\`; falls back to \`chat_completions\` when the gateway does not expose streaming Responses support. |

## Optional

| Field | Type | Default | Description |
|---|---|---|---|
| model | string | gateway default | Optional request model override. |
| provider | string | auto | Provider hint returned in Paperclip metadata. |
| timeoutSec | number | ${DEFAULT_TIMEOUT_SEC} | Whole-run timeout for the gateway request. |
| heartbeatSec | number | ${DEFAULT_HEARTBEAT_SEC} | Watchdog interval for \`[hermes] still running...\` lines. |
| debugEvents | boolean | false | Log unknown SSE events and fallback decisions. |
| allowCliFallback | boolean | false | Only fall back to the legacy CLI adapter when the API is unreachable. |
| hermesCommand | string | hermes | CLI command used only when \`allowCliFallback\` is enabled. |

## Notes

- The Hermes gateway executes tools on the gateway host.
- Paperclip API identity is passed through the prompt/runtime context so Hermes
  can continue using terminal + curl against the Paperclip API.
- Managed instructions bundles are supported through \`instructionsFilePath\`.
`;
