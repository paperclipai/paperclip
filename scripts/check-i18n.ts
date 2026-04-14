#!/usr/bin/env -S node --import tsx
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogs } from "../packages/shared/src/i18n.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineKeys = Object.keys(catalogs.en).sort();
const failures: string[] = [];

for (const [locale, catalog] of Object.entries(catalogs)) {
  const keys = Object.keys(catalog).sort();
  const missing = baselineKeys.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !baselineKeys.includes(key));

  if (missing.length > 0) {
    failures.push(`[catalog] ${locale} is missing keys: ${missing.join(", ")}`);
  }
  if (extra.length > 0) {
    failures.push(`[catalog] ${locale} has extra keys: ${extra.join(", ")}`);
  }
}

const bannedLiteralsByFile: Array<{ file: string; literals: string[] }> = [
  {
    file: "ui/src/pages/InstanceSettings.tsx",
    literals: [
      "Scheduler Heartbeats",
      "Loading scheduler heartbeats...",
      "Disable Timer Heartbeat",
      "Enable Timer Heartbeat",
      "No scheduler heartbeats match the current criteria.",
    ],
  },
  {
    file: "ui/src/pages/InstanceGeneralSettings.tsx",
    literals: [
      "Loading general settings...",
      "Censor username in logs",
      "Keyboard shortcuts",
      "Backup retention",
      "AI feedback sharing",
      "Sign out",
    ],
  },
  {
    file: "ui/src/pages/InviteLanding.tsx",
    literals: [
      "Invalid invite token.",
      "Loading invite...",
      "Invite not available",
      "Bootstrap complete",
      "Join request submitted",
      "Submit join request",
    ],
  },
  {
    file: "ui/src/App.tsx",
    literals: [
      "Instance setup required",
      "Failed to load app state",
      "Create your first company",
      "New Company",
      "Start Onboarding",
    ],
  },
  {
    file: "cli/src/client/board-auth.ts",
    literals: [
      "Board authentication required",
      "Opened the approval page in your browser.",
      "CLI auth challenge was cancelled.",
      "CLI auth challenge expired before approval.",
    ],
  },
  {
    file: "ui/src/components/Layout.tsx",
    literals: [
      "Skip to Main Content",
      "Documentation",
      "Close sidebar",
    ],
  },
  {
    file: "ui/src/components/IssuesList.tsx",
    literals: [
      "Search issues...",
      "Choose which issue columns stay visible",
      "No issues match the current filters or search.",
    ],
  },
  {
    file: "ui/src/components/IssueProperties.tsx",
    literals: [
      "Run review now",
      "Search assignees...",
      "Search reviewers...",
      "Search approvers...",
    ],
  },
  {
    file: "ui/src/components/CommentThread.tsx",
    literals: [
      "Copy comment as markdown",
      "No timeline entries yet.",
      "Leave a comment...",
      "Attach image",
    ],
  },
  {
    file: "ui/src/components/IssueChatThread.tsx",
    literals: [
      "Copy message",
      "What could have been better?",
      "Jump to latest",
      "This issue conversation is empty. Start with a message below.",
    ],
  },
  {
    file: "ui/src/pages/IssueDetail.tsx",
    literals: [
      "Copy issue as markdown",
      "Add a description...",
      "Load earlier comments",
      "Cost Summary",
    ],
  },
  {
    file: "ui/src/components/OnboardingWizard.tsx",
    literals: [
      "Name your company",
      "Create your first agent",
      "Adapter environment check",
      "Create & Open Issue",
    ],
  },
  {
    file: "ui/src/pages/Dashboard.tsx",
    literals: [
      "Welcome to Paperclip. Set up your first company and agent to get started.",
      "Agents Enabled",
      "Recent Activity",
      "No tasks yet.",
    ],
  },
  {
    file: "ui/src/components/NewProjectDialog.tsx",
    literals: [
      "New project",
      "Project name",
      "Repo URL",
      "Create project",
    ],
  },
  {
    file: "ui/src/components/NewGoalDialog.tsx",
    literals: [
      "New goal",
      "New sub-goal",
      "Goal title",
      "Create goal",
    ],
  },
  {
    file: "ui/src/pages/AdapterManager.tsx",
    literals: [
      "Install Adapter",
      "External Adapters",
      "Built-in Adapters",
      "Remove Adapter",
    ],
  },
  {
    file: "ui/src/components/NewIssueDialog.tsx",
    literals: [
      "New issue",
      "Issue title",
      "Add reviewer or approver",
      "Discard Draft",
    ],
  },
  {
    file: "ui/src/pages/Costs.tsx",
    literals: [
      "Inference ledger",
      "Budget control plane",
      "All providers",
    ],
  },
  {
    file: "ui/src/components/AgentConfigForm.tsx",
    literals: [
      "Unsaved changes",
      "Re-detect model",
      "Use manual model",
      "Select model (required)",
      "Wake on demand",
    ],
  },
  {
    file: "ui/src/pages/Inbox.tsx",
    literals: [
      "Search inbox",
      "Mark all as read",
      "Choose which inbox columns stay visible",
      "Disable parent-child nesting",
      "No inbox items match your search.",
      "Select a company to view inbox.",
    ],
  },
  {
    file: "ui/src/pages/RoutineDetail.tsx",
    literals: [
      "Routine title",
      "Rotate secret",
      "Advanced delivery settings",
      "No runs yet.",
      "Select a company to view routines.",
    ],
  },
  {
    file: "ui/src/pages/Routines.tsx",
    literals: [
      "Create routine",
      "Recent Runs",
      "Advanced delivery settings",
      "No routines yet. Use Create routine to define the first recurring workflow.",
      "Select a company to view routines.",
    ],
  },
  {
    file: "ui/src/pages/GoalDetail.tsx",
    literals: [
      "Show properties",
      "Add a description...",
      "No sub-goals.",
      "No linked projects.",
    ],
  },
  {
    file: "ui/src/components/IssueDocumentsSection.tsx",
    literals: [
      "New document",
      "Document key",
      "Revision history",
      "Copy document",
      "Document actions",
      "Viewing historical revision",
      "Optional title",
      "Delete this document? This cannot be undone.",
    ],
  },
  {
    file: "ui/src/pages/AgentDetail.tsx",
    literals: [
      "Instructions bundles are only available for local adapters.",
      "View company skills library",
      "No runs yet.",
      "Back to runs",
      "Loading run logs...",
      "Failure details",
      "Create API Key",
      "No active API keys.",
      "Active Keys",
      "Revoked Keys",
    ],
  },
];

for (const entry of bannedLiteralsByFile) {
  const absolutePath = path.join(repoRoot, entry.file);
  const source = fs.readFileSync(absolutePath, "utf8");

  for (const literal of entry.literals) {
    if (source.includes(literal)) {
      failures.push(`[hardcoded] ${entry.file} still contains "${literal}"`);
    }
  }
}

if (failures.length > 0) {
  console.error("i18n check failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`i18n check passed for ${baselineKeys.length} translation keys across ${Object.keys(catalogs).length} locales.`);
