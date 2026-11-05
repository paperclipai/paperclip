import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.egm-gate";
const TOOL_KEY_LEVEL = "egm_level";
const DEFAULT_FULL_DIFF_LINES = 300;
const DEFAULT_FULL_DIFF_FILES = 8;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "EGM Gate",
  description:
    "Gate nativo de entrega: una issue no se cierra sin evidencia (PR, parche, medición o decisión documentada) y la revisión EGM sólo se pide cuando hay un diff que revisar.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "issues.read",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "issue.documents.read",
    "issue.attachments.read",
    "projects.read",
    "project.workspaces.read",
    "agents.read",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "agent.tools.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      fullDiffLines: {
        type: "number",
        title: "Líneas de diff para revisión completa",
        default: DEFAULT_FULL_DIFF_LINES,
      },
      fullDiffFiles: {
        type: "number",
        title: "Archivos de diff para revisión completa",
        default: DEFAULT_FULL_DIFF_FILES,
      },
    },
  },
  tools: [
    {
      name: TOOL_KEY_LEVEL,
      displayName: "Nivel de revisión EGM",
      description:
        "Devuelve el nivel de revisión que necesita una tarea (off | lite | full | human) según la entrega verificable que tiene.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "UUID de la issue" },
        },
        required: ["issueId"],
      },
    },
  ],
};

export default manifest;
export { TOOL_KEY_LEVEL, PLUGIN_ID };
