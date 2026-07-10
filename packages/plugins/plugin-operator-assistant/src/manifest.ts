import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-operator-assistant";
export const ASSISTANT_AGENT_KEY = "operator-assistant";
export const ASSISTANT_EXPORT_NAME = "OperatorAssistantDrawer";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Operator Assistant",
  description: "Read-only conversational answers grounded in recent work and historical Paperclip issues.",
  author: "Paperclip",
  categories: ["ui", "automation"],
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "companies.read",
    "agents.managed",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "ui.action.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "operator_assistant",
    migrationsDir: "migrations",
    coreReadTables: [
      "companies",
      "projects",
      "agents",
      "issues",
      "issue_comments",
      "issue_relations",
      "heartbeat_runs",
    ],
  },
  agents: [
    {
      agentKey: ASSISTANT_AGENT_KEY,
      displayName: "Operator Assistant",
      role: "general",
      title: "Read-only company assistant",
      icon: "message-circle",
      capabilities: "Answers questions from pre-retrieved company evidence without changing Paperclip data.",
      adapterType: "codex_local",
      adapterPreference: ["codex_local"],
      adapterConfig: {
        modelReasoningEffort: "medium",
        promptTemplate: "{{context.paperclipSessionMessageMarkdown}}",
        dangerouslyBypassApprovalsAndSandbox: false,
        extraArgs: ["--skip-git-repo-check", "--sandbox", "read-only"],
        paperclipSkillSync: { desiredSkills: [] },
      },
      permissions: {
        canCreateAgents: false,
      },
      executionAccess: "readOnly",
      status: "idle",
      budgetMonthlyCents: 0,
      instructions: {
        entryFile: "AGENTS.md",
        content: `# Operator Assistant

You are the company's read-only Paperclip assistant. Answer the operator's
question using only the evidence bundle included in the prompt and the earlier
conversation. Do not call tools, shell commands, or APIs. Do not create or
change issues, comments, agents, projects, files, or configuration.

Be concise but specific. For recent-work questions, organize the answer by the
work actually observed and state the requested time window. Cite relevant issue
identifiers inline. Explain blockers and relationships when the evidence shows
them. If the evidence is incomplete or ambiguous, say exactly what is missing
instead of guessing. Never claim a side effect occurred.`,
      },
    },
  ],
  ui: {
    launchers: [
      {
        id: "operator-assistant-chat",
        displayName: "Ask assistant",
        description: "Ask about recent work, decisions, blockers, or old issues.",
        placementZone: "globalToolbarButton",
        action: {
          type: "openDrawer",
          target: ASSISTANT_EXPORT_NAME,
        },
        render: {
          environment: "hostOverlay",
          bounds: "wide",
        },
      },
    ],
  },
};

export default manifest;
