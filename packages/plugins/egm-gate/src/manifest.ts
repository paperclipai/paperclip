import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclip.egm-gate";
const JOB_KEY_RECONCILE = "reconcile-closures";
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
    "agents.read",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "jobs.schedule",
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
  jobs: [
    {
      jobKey: JOB_KEY_RECONCILE,
      displayName: "Reconciliar cierres sin evidencia",
      description:
        "Repasa las issues cerradas sin evidencia de entrega y devuelve a `in_review` las que no la tienen. Sustituye al gate en shell.",
      schedule: "17 * * * *",
    },
  ],
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
export { JOB_KEY_RECONCILE, TOOL_KEY_LEVEL, PLUGIN_ID };
