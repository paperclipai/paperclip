import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-paperclip-github";
export const PLUGIN_VERSION = "0.1.0";

/**
 * Tool name prefix used when registering with ctx.tools.register().
 * Names are namespaced by plugin ID at the host edge; this prefix is the
 * local-scope name agents address.
 */
export const TOOL = {
  OPEN_PR: "github_open_pr",
  GET_PR: "github_get_pr",
  GET_CHECK_RUNS: "github_get_check_runs",
  CREATE_CHECK_RUN: "github_create_check_run",
  ENQUEUE_MERGE: "github_enqueue_merge",
  LIST_ISSUES: "github_list_issues",
  CREATE_ISSUE: "github_create_issue",
  UPDATE_ISSUE: "github_update_issue",
  LABEL_ISSUE: "github_label_issue",
  UPDATE_PR: "github_update_pr",
  CLOSE_PR: "github_close_pr",
  UPDATE_PR_BODY: "github_update_pr_body",
  CONVERT_PR_TO_DRAFT: "github_convert_pr_to_draft",
  MARK_PR_READY_FOR_REVIEW: "github_mark_pr_ready_for_review",
  REPAIR_PR_HEAD: "github_repair_pr_head",
} as const;

const REPO_DESCRIPTION =
  "GitHub repository in `owner/name` form. Comes from plugin instance config; do not pass per-call.";

const issueNumber = { type: "number" } as const;
const labelArray = { type: "array", items: { type: "string" } } as const;

export const ISSUE_TOOL_SCHEMA = {
  CREATE: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, labels: labelArray }, required: ["title", "body"] },
  UPDATE: { type: "object", properties: { issueNumber, title: { type: "string" }, body: { type: "string" }, state: { type: "string", enum: ["open", "closed"] } }, required: ["issueNumber"] },
  LABEL: { type: "object", properties: { issueNumber, labels: labelArray }, required: ["issueNumber", "labels"] },
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GitHub",
  description:
    "Typed GitHub operations for paperclip agents — opens PRs, reads check status, files check runs, enqueues merges, and lists issues against a per-company GitHub App identity. Replaces ad-hoc `gh` shell calls.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "agent.tools.register",
    "secrets.read-ref",
    "activity.log.write",
    "metrics.write",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  tools: [
    {
      name: TOOL.OPEN_PR,
      displayName: "Open Pull Request",
      description:
        "Open a pull request from `branch` against the configured default branch. Refuses self-review and PRs without an issue reference.",
      parametersSchema: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "Paperclip task or GitHub issue number this PR closes" },
          branch: { type: "string", description: "Head branch name (already pushed)" },
          title: { type: "string" },
          body: { type: "string" },
          draft: { type: "boolean", default: true },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["issueId", "branch", "title", "body"],
      },
    },
    {
      name: TOOL.GET_PR,
      displayName: "Get Pull Request Status",
      description:
        "Aggregate read for Merge Director: returns state, mergeable, mergeStateStatus, head SHA, required checks, failing checks, and last review state in one call.",
      parametersSchema: {
        type: "object",
        properties: {
          prNumber: { type: "number" },
        },
        required: ["prNumber"],
      },
    },
    {
      name: TOOL.GET_CHECK_RUNS,
      displayName: "Get Check Runs",
      description: "List check runs on a PR's head commit, filtered optionally by name.",
      parametersSchema: {
        type: "object",
        properties: {
          prNumber: { type: "number" },
          name: { type: "string" },
        },
        required: ["prNumber"],
      },
    },
    {
      name: TOOL.CREATE_CHECK_RUN,
      displayName: "Create Check Run",
      description:
        "Create or update a check run attached to a head SHA. Used by Build Verifier to publish evidence (binary hash, test summary).",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          headSha: { type: "string" },
          status: { type: "string", enum: ["queued", "in_progress", "completed"] },
          conclusion: {
            type: "string",
            enum: ["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped"],
          },
          summary: { type: "string" },
          details: { type: "string", description: "Evidence detail. ≥200 chars required for completed runs." },
          externalId: { type: "string" },
        },
        required: ["name", "headSha", "status"],
      },
    },
    {
      name: TOOL.ENQUEUE_MERGE,
      displayName: "Enqueue PR into Merge Queue",
      description:
        "Add a PR to the repository merge queue. Refuses if failing checks exist or merge queue is disabled.",
      parametersSchema: {
        type: "object",
        properties: {
          prNumber: { type: "number" },
        },
        required: ["prNumber"],
      },
    },
    {
      name: TOOL.LIST_ISSUES,
      displayName: "List Issues",
      description:
        "List issues with optional label and state filters. Used by Delivery Lead to pull single-concept fix tasks.",
      parametersSchema: {
        type: "object",
        properties: {
          labels: { type: "array", items: { type: "string" } },
          state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
          since: { type: "string", description: "ISO 8601 timestamp" },
          perPage: { type: "number", default: 30, maximum: 100 },
        },
      },
    },
    {
      name: TOOL.CREATE_ISSUE,
      displayName: "Create Issue",
      description:
        "Create a GitHub issue in the configured repository, optionally with labels, then read it back for audit.",
      parametersSchema: ISSUE_TOOL_SCHEMA.CREATE,
    },
    {
      name: TOOL.UPDATE_ISSUE,
      displayName: "Update Issue",
      description:
        "Update an existing GitHub issue title, body, or state in the configured repository, then read it back for audit.",
      parametersSchema: ISSUE_TOOL_SCHEMA.UPDATE,
    },
    {
      name: TOOL.LABEL_ISSUE,
      displayName: "Label Issue",
      description:
        "Apply labels to an existing GitHub issue in the configured repository, then read it back to prove labels are present.",
      parametersSchema: ISSUE_TOOL_SCHEMA.LABEL,
    },
    {
      name: TOOL.UPDATE_PR,
      displayName: "Update Pull Request",
      description:
        "Update an existing PR title, body, and/or base branch after verifying repository, PR number, current head SHA, current base SHA, and optional current title/body readback.",
      parametersSchema: {
        type: "object",
        properties: {
          ...mutationGuardProperties(),
          title: { type: "string" },
          body: { type: "string" },
          base: { type: "string", description: "New base branch name. Raw refs are rejected." },
          expectedCurrentTitle: { type: "string" },
          expectedCurrentBody: { type: "string" },
        },
        required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha"],
      },
    },
    {
      name: TOOL.CLOSE_PR,
      displayName: "Close Pull Request",
      description:
        "Close an existing PR after verifying repository, PR number, current head SHA, current base SHA, writing an audit comment with reason/run metadata, and state readback.",
      parametersSchema: {
        type: "object",
        properties: {
          ...mutationGuardProperties(),
          reason: { type: "string", description: "Explicit disposal reason recorded in the PR comment trail." },
          commentBody: { type: "string", description: "Optional additional operator-readable close note." },
        },
        required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha", "reason"],
      },
    },
    {
      name: TOOL.UPDATE_PR_BODY,
      displayName: "Update Pull Request Body",
      description:
        "Update an existing PR body after verifying repository, PR number, current head SHA, current base SHA, and optional current body readback.",
      parametersSchema: {
        type: "object",
        properties: {
          repository: { type: "string", description: REPO_DESCRIPTION },
          prNumber: { type: "number" },
          expectedHeadSha: { type: "string", description: "Full current 40-character PR head SHA" },
          expectedBaseSha: { type: "string", description: "Full current 40-character PR base SHA" },
          body: { type: "string" },
          expectedCurrentBody: { type: "string" },
        },
        required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha", "body"],
      },
    },
    {
      name: TOOL.CONVERT_PR_TO_DRAFT,
      displayName: "Convert Pull Request To Draft",
      description:
        "Convert an existing PR to draft after verifying repository, PR number, current head SHA, and current base SHA.",
      parametersSchema: {
        type: "object",
        properties: mutationGuardProperties(),
        required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha"],
      },
    },
    {
      name: TOOL.MARK_PR_READY_FOR_REVIEW,
      displayName: "Mark Pull Request Ready For Review",
      description:
        "Mark an existing PR ready for review after verifying repository, PR number, current head SHA, and current base SHA.",
      parametersSchema: {
        type: "object",
        properties: mutationGuardProperties(),
        required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha"],
      },
    },
    {
      name: TOOL.REPAIR_PR_HEAD,
      displayName: "Repair Pull Request Head",
      description:
        "Publish or repair an existing PR head branch after verifying current head/base SHAs, authorized source repository, target commit existence, and readback.",
      parametersSchema: {
        type: "object",
        properties: {
          ...mutationGuardProperties(),
          targetHeadSha: { type: "string", description: "Full 40-character target commit SHA" },
          sourceRepository: {
            type: "string",
            description: "Authorized source repository containing targetHeadSha. Defaults to configured repository.",
          },
          force: { type: "boolean", default: false },
        },
        required: ["repository", "prNumber", "expectedHeadSha", "expectedBaseSha", "targetHeadSha"],
      },
    },
  ],
};

export const __REPO_DESCRIPTION = REPO_DESCRIPTION; // exported for tests
export default manifest;

function mutationGuardProperties() {
  return {
    repository: { type: "string", description: REPO_DESCRIPTION },
    prNumber: { type: "number" },
    expectedHeadSha: { type: "string", description: "Full current 40-character PR head SHA" },
    expectedBaseSha: { type: "string", description: "Full current 40-character PR base SHA" },
  } as const;
}
