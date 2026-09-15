import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

import { DEFAULT_GRACE_SEC, DEFAULT_TIMEOUT_SEC } from "../../shared/constants.js";
import { DEFAULT_GOOGLE_VERTEX_REGION } from "../shared/constants.js";

export function getGoogleVertexConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "projectId",
        label: "Google Cloud project ID",
        type: "text",
        hint: "Optional when the credential contains a project ID; otherwise required.",
      },
      {
        key: "region",
        label: "Vertex region",
        type: "text",
        default: DEFAULT_GOOGLE_VERTEX_REGION,
        hint: "Use global for Gemini 3 preview models; pin a region only when your deployment requires it.",
      },
      {
        key: "credentialsPath",
        label: "Service-account JSON path",
        type: "text",
        hint: "Optional absolute path on the execution host. Leave blank to use Application Default Credentials.",
        meta: { path: true },
      },
      {
        key: "timeoutSec",
        label: "Timeout seconds",
        type: "number",
        default: DEFAULT_TIMEOUT_SEC,
      },
      {
        key: "graceSec",
        label: "Grace seconds",
        type: "number",
        default: DEFAULT_GRACE_SEC,
      },
      {
        key: "maxTurnsPerRun",
        label: "Max turns per run",
        type: "number",
        hint: "Optional Hermes tool-calling iteration limit.",
      },
      {
        key: "persistSession",
        label: "Persist session",
        type: "toggle",
        default: true,
      },
      {
        key: "toolsets",
        label: "Toolsets",
        type: "text",
        hint: "Optional comma-separated Hermes toolsets, such as terminal,file,web.",
      },
    ],
  };
}
