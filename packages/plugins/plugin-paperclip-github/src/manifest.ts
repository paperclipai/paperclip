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
} as const;

const REPO_DESCRIPTION =
  "GitHub repository in `owner/name` form. Comes from plugin instance config; do not pass per-call.";

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
  ],
};

export const __REPO_DESCRIPTION = REPO_DESCRIPTION; // exported for tests
export default manifest;
