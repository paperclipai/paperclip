import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  BRIEFING_ANALYST_INSTRUCTIONS,
  DISCOVER_CARDS_SKILL,
  DISCOVERY_ROUTINE_DESCRIPTION,
  MANUAL_REFRESH_ROUTINE_DESCRIPTION,
  UPDATE_CARDS_SKILL,
  UPDATE_ROUTINE_DESCRIPTION,
} from "./templates.js";

export const PLUGIN_ID = "paperclipai.plugin-briefs";
export const BRIEFS_ROUTE_PATH = "briefs";
export const BRIEFS_SIDEBAR_SLOT_ID = "briefs-sidebar";
export const BRIEFS_PAGE_SLOT_ID = "briefs-page";
export const BRIEFING_ANALYST_AGENT_KEY = "briefing-analyst";
export const BRIEFS_PROJECT_KEY = "briefs";
export const DISCOVER_CARDS_SKILL_KEY = "briefs-discover-cards";
export const UPDATE_CARDS_SKILL_KEY = "briefs-update-cards";
export const DISCOVER_CARDS_ROUTINE_KEY = "briefs-discover-cards";
export const UPDATE_CARDS_ROUTINE_KEY = "briefs-update-cards";
export const MANUAL_REFRESH_ROUTINE_KEY = "briefs-manual-refresh";
export const BRIEFS_MANAGED_SKILL_KEYS = [
  DISCOVER_CARDS_SKILL_KEY,
  UPDATE_CARDS_SKILL_KEY,
] as const;
export const BRIEFS_MANAGED_ROUTINE_KEYS = [
  DISCOVER_CARDS_ROUTINE_KEY,
  UPDATE_CARDS_ROUTINE_KEY,
  MANUAL_REFRESH_ROUTINE_KEY,
] as const;

function canonicalSkillKey(skillKey: string) {
  return `plugin/paperclipai-plugin-briefs/${skillKey}`;
}

export const BRIEFS_MANAGED_SKILL_CANONICAL_KEYS = BRIEFS_MANAGED_SKILL_KEYS.map(canonicalSkillKey);

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Briefs",
  description: "Company-scoped briefing cards backed by deterministic Paperclip work-state analysis.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "companies.read",
    "projects.read",
    "projects.managed",
    "goals.read",
    "agents.read",
    "agents.resume",
    "agents.managed",
    "issues.read",
    "issue.subtree.read",
    "issue.relations.read",
    "issue.comments.read",
    "issue.documents.read",
    "issues.orchestration.read",
    "skills.managed",
    "routines.managed",
    "agent.tools.register",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write",
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  database: {
    namespaceSlug: "briefs",
    migrationsDir: "migrations",
    coreReadTables: ["companies", "issues"]
  },
  agents: [
    {
      agentKey: BRIEFING_ANALYST_AGENT_KEY,
      displayName: "Briefing Analyst",
      role: "analyst",
      title: "Briefing Analyst",
      icon: "newspaper",
      capabilities: "Maintains source-linked Briefing cards, refreshes deterministic card state, and writes grounded card titles and descriptions from source rows.",
      adapterType: "codex_local",
      adapterPreference: ["codex_local", "claude_local", "gemini_local", "opencode_local", "cursor", "pi_local"],
      adapterConfig: {
        dangerouslyBypassApprovalsAndSandbox: true,
        extraArgs: ["--skip-git-repo-check"],
        paperclipSkillSync: {
          desiredSkills: BRIEFS_MANAGED_SKILL_CANONICAL_KEYS
        }
      },
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            purpose: "one-paragraph Briefing card summaries from compact source-linked inputs"
          }
        }
      },
      permissions: {
        pluginTools: [PLUGIN_ID]
      },
      status: "paused",
      budgetMonthlyCents: 500,
      instructions: {
        entryFile: "AGENTS.md",
        content: BRIEFING_ANALYST_INSTRUCTIONS,
        assetPath: "agents/briefing-analyst"
      }
    }
  ],
  projects: [
    {
      projectKey: BRIEFS_PROJECT_KEY,
      displayName: "Briefs",
      description: "Plugin-managed operation area for Briefing card discovery, update, and manual refresh routine issues.",
      status: "in_progress",
      color: "#0f766e"
    }
  ],
  skills: [
    {
      skillKey: DISCOVER_CARDS_SKILL_KEY,
      displayName: "Briefs Discover Cards",
      slug: DISCOVER_CARDS_SKILL_KEY,
      description: "Discover user-relevant Paperclip issue trees and refresh deterministic Briefing cards.",
      markdown: DISCOVER_CARDS_SKILL
    },
    {
      skillKey: UPDATE_CARDS_SKILL_KEY,
      displayName: "Briefs Update Cards",
      slug: UPDATE_CARDS_SKILL_KEY,
      description: "Update existing Briefing cards with budget-aware summary fallback.",
      markdown: UPDATE_CARDS_SKILL
    }
  ],
  routines: [
    {
      routineKey: DISCOVER_CARDS_ROUTINE_KEY,
      title: "Discover Briefing cards for {{userId}}",
      description: DISCOVERY_ROUTINE_DESCRIPTION,
      status: "paused",
      priority: "low",
      assigneeRef: { resourceKind: "agent", resourceKey: BRIEFING_ANALYST_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: BRIEFS_PROJECT_KEY },
      concurrencyPolicy: "skip_if_active",
      catchUpPolicy: "skip_missed",
      variables: [
        { name: "userId", label: "User ID", type: "text", defaultValue: null, required: true, options: [] }
      ],
      triggers: [
        {
          kind: "schedule",
          label: "Every 6 hours",
          enabled: false,
          cronExpression: "0 */6 * * *",
          timezone: "UTC",
          signingMode: null,
          replayWindowSec: null
        }
      ],
      issueTemplate: {
        surfaceVisibility: "plugin_operation",
        originId: "routine:briefs-discover-cards",
        billingCode: "plugin-briefs:discovery"
      }
    },
    {
      routineKey: UPDATE_CARDS_ROUTINE_KEY,
      title: "Update Briefing cards for {{userId}}",
      description: UPDATE_ROUTINE_DESCRIPTION,
      status: "paused",
      priority: "low",
      assigneeRef: { resourceKind: "agent", resourceKey: BRIEFING_ANALYST_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: BRIEFS_PROJECT_KEY },
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [
        { name: "userId", label: "User ID", type: "text", defaultValue: null, required: true, options: [] }
      ],
      triggers: [
        {
          kind: "schedule",
          label: "Hourly",
          enabled: false,
          cronExpression: "0 * * * *",
          timezone: "UTC",
          signingMode: null,
          replayWindowSec: null
        }
      ],
      issueTemplate: {
        surfaceVisibility: "plugin_operation",
        originId: "routine:briefs-update-cards",
        billingCode: "plugin-briefs:update"
      }
    },
    {
      routineKey: MANUAL_REFRESH_ROUTINE_KEY,
      title: "Refresh Briefing card {{rootIssueId}}",
      description: MANUAL_REFRESH_ROUTINE_DESCRIPTION,
      status: "paused",
      priority: "medium",
      assigneeRef: { resourceKind: "agent", resourceKey: BRIEFING_ANALYST_AGENT_KEY },
      projectRef: { resourceKind: "project", resourceKey: BRIEFS_PROJECT_KEY },
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      variables: [
        { name: "userId", label: "User ID", type: "text", defaultValue: null, required: true, options: [] },
        { name: "rootIssueId", label: "Root issue ID", type: "text", defaultValue: null, required: true, options: [] }
      ],
      triggers: [
        {
          kind: "api",
          label: "Manual refresh",
          enabled: true,
          cronExpression: null,
          timezone: null,
          signingMode: null,
          replayWindowSec: null
        }
      ],
      issueTemplate: {
        surfaceVisibility: "plugin_operation",
        originId: "routine:briefs-manual-refresh",
        billingCode: "plugin-briefs:manual-refresh"
      }
    }
  ],
  tools: [
    {
      name: "briefs_list_cards",
      displayName: "List Briefing Cards",
      description: "List current Briefing cards for a company/user pair.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          userId: { type: "string" },
          includeHidden: { type: "boolean" },
          limit: { type: "number" }
        },
        required: ["companyId", "userId"]
      }
    },
    {
      name: "briefs_save_card",
      displayName: "Save Briefing Card",
      description: "Save a deterministic or generated Briefing card from a source bundle.",
      parametersSchema: {
        type: "object",
        properties: {
          bundle: { type: "object" },
          options: { type: "object" }
        },
        required: ["bundle"]
      }
    },
    {
      name: "briefs_refresh_issue_tree",
      displayName: "Refresh Briefing Issue Tree",
      description: "Build and save a Briefing card for one Paperclip issue tree. Call once to inspect deterministic rows, then again with title, summary, and allowGeneratedSummary: true.",
      parametersSchema: {
        type: "object",
        properties: {
          companyId: { type: "string" },
          userId: { type: "string" },
          rootIssueId: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          summaryModel: { type: "string" },
          summaryTokensIn: { type: "number" },
          summaryTokensOut: { type: "number" },
          summaryFailureReason: { type: "string" },
          allowGeneratedSummary: { type: "boolean" },
          budgetCapped: { type: "boolean" }
        },
        required: ["companyId", "userId", "rootIssueId"]
      }
    }
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: BRIEFS_SIDEBAR_SLOT_ID,
        displayName: "Briefing",
        exportName: "SidebarLink",
        order: 15
      },
      {
        type: "page",
        id: BRIEFS_PAGE_SLOT_ID,
        displayName: "Briefing",
        exportName: "BriefingPage",
        routePath: BRIEFS_ROUTE_PATH
      },
      {
        type: "settingsPage",
        id: "briefs-settings",
        displayName: "Briefing",
        exportName: "SettingsPage"
      }
    ]
  }
};

export default manifest;
