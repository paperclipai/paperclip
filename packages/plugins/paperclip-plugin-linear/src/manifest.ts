import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Linear Issue Sync",
  description:
    "Bidirectional sync between Linear issues and Paperclip issues. Connect via OAuth, import issues, sync status changes, and bridge comments.",
  author: "Lucitra",
  categories: ["connector"],
  capabilities: [
    // Data access
    "companies.read",
    "users.read",
    "projects.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "goals.read",
    "milestones.read",
    "milestones.write",
    // Plugin state & entities
    "plugin.state.read",
    "plugin.state.write",
    // Events
    "events.subscribe",
    "events.emit",
    // External
    "http.outbound",
    "secrets.read-ref",
    // Webhooks & jobs
    "webhooks.receive",
    "jobs.schedule",
    // Agent tools
    "agent.tools.register",
    // UI
    "instance.settings.register",
    "ui.detailTab.register",
    // Labels & Projects write (Lucitra extension — not yet in SDK types)
    "labels.read" as any,
    "labels.create" as any,
    "projects.create" as any,
    "projects.update" as any,
    // Activity
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      linearClientId: {
        type: "string",
        title: "Linear OAuth Client ID",
        description:
          "Your Linear OAuth application client ID. Create one at https://linear.app/settings/api/applications",
      },
      linearClientSecret: {
        type: "string",
        title: "Linear OAuth Client Secret",
        description: "Your Linear OAuth application client secret.",
      },
      linearTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Linear API Key (secret reference)",
        description:
          "Alternative to OAuth: a secret UUID for a Linear personal API key. Leave blank if using OAuth.",
      },
      linearOAuthActor: {
        type: "string",
        title: "Linear OAuth actor",
        enum: ["user", "app"],
        description:
          "Tracks whether the stored OAuth token was authorized as the Linear user or as the app. OAuth connect sets this to app; leave user for manually supplied tokens.",
        default: DEFAULT_CONFIG.linearOAuthActor,
      },
      linearWebhookSigningSecret: {
        type: "string",
        title: "Linear Webhook Signing Secret",
        description:
          "Linear workspace webhook signing secret (begins with 'lin_wh_'). When set, inbound webhooks are HMAC-SHA256 verified and rejected on mismatch.",
      },
      teamId: {
        type: "string",
        title: "Default Team ID",
        description:
          "Default Linear team ID. Auto-detected during OAuth connect.",
        default: DEFAULT_CONFIG.teamId,
      },
      defaultProjectId: {
        type: "string",
        title: "Default Paperclip Project ID",
        description:
          "Paperclip project to assign Linear-imported issues to when the source Linear issue has no project (or its Linear project isn't linked yet). Leave blank to allow imports without a project.",
        default: DEFAULT_CONFIG.defaultProjectId,
      },
      syncComments: {
        type: "boolean",
        title: "Sync Comments",
        description: "Mirror comments between linked issues",
        default: true,
      },
      syncDirection: {
        type: "string",
        title: "Sync Direction",
        enum: ["bidirectional", "linear-to-paperclip", "paperclip-to-linear"],
        default: DEFAULT_CONFIG.syncDirection,
      },
      disableLinearOriginatedCreates: {
        type: "boolean",
        title: "Disable Linear-Originated Creates",
        description:
          "When true, Linear issue.create webhooks do not auto-create Paperclip issues. Use the Link Linear Issue action to pair issues explicitly. Set to false to restore auto-mirroring.",
        default: DEFAULT_CONFIG.disableLinearOriginatedCreates,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip base URL",
        description:
          "Public base URL of this Paperclip instance (no trailing slash). Used to build Linear issue attachments and project resource links pointing at the Paperclip mirror.",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
      linearBacklinkBestEffort: {
        type: "boolean",
        title: "Linear back-link: best-effort",
        description:
          "Controls how Linear `attachmentLinkURL` failures during import are handled. `false` (default) is the safer choice — failures propagate and fail the import loudly, so silent breakage surfaces immediately. Set to `true` to log-and-continue once you trust the back-link path.",
        default: false,
      },
    },
  },
  jobs: [
    {
      jobKey: JOB_KEYS.periodicSync,
      displayName: "Periodic Sync",
      description:
        "Polls linked Linear issues to catch changes missed by webhooks.",
      schedule: "0 */6 * * *",
    },
    {
      jobKey: JOB_KEYS.initialImport,
      displayName: "Initial Import",
      description:
        "Imports all open Linear issues into Paperclip on first connection.",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.linear,
      displayName: "Linear Events",
      description:
        "Receives issue, comment, project, and label events from Linear webhooks.",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.search,
      displayName: "Search Linear Issues",
      description:
        "Search Linear issues. Returns matching issues with status, labels, and assignees.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
        },
        required: ["query"],
      },
    },
    {
      name: TOOL_NAMES.create,
      displayName: "Create Linear Issue",
      description: "Create a new issue in Linear.",
      parametersSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Issue title",
          },
          description: {
            type: "string",
            description: "Issue description (markdown)",
          },
          teamId: {
            type: "string",
            description: "Team ID (omit to use default)",
          },
        },
        required: ["title"],
      },
    },
    {
      name: TOOL_NAMES.listIssueLabels,
      displayName: "List Linear Issue Labels",
      description:
        "List Linear issue labels visible to the connected workspace. Use this before setting or matching issue labels.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional case-insensitive substring filter for label name.",
          },
          teamId: {
            type: "string",
            description: "Optional Linear team ID filter.",
          },
          limit: {
            type: "number",
            description: "Maximum labels to return, capped at 500.",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.listProjectLabels,
      displayName: "List Linear Project Labels",
      description:
        "List Linear project labels visible to the connected workspace. Use this before setting or matching project labels.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional case-insensitive substring filter for label name.",
          },
          limit: {
            type: "number",
            description: "Maximum labels to return, capped at 500.",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.resolveBinding,
      displayName: "Resolve Linear Binding",
      description:
        "Resolve a Linear issue to its Paperclip mirror and project binding. Use this before assuming Linear BLO numbers match Paperclip BLO numbers.",
      parametersSchema: {
        type: "object",
        properties: {
          linearRef: {
            type: "string",
            description: "Linear issue identifier (e.g. BLO-123) or URL",
          },
        },
        required: ["linearRef"],
      },
    },
    {
      name: TOOL_NAMES.setBinding,
      displayName: "Set Linear Binding",
      description:
        "Repair or create Paperclip/Linear issue and project sync bindings, then write the Paperclip backlink into Linear.",
      parametersSchema: {
        type: "object",
        properties: {
          linearRef: {
            type: "string",
            description: "Linear issue identifier or URL to bind, when setting an issue binding.",
          },
          paperclipIssueId: {
            type: "string",
            description: "Paperclip issue UUID to bind to the Linear issue.",
          },
          linearProjectId: {
            type: "string",
            description: "Linear project UUID to bind, when setting a project binding.",
          },
          linearProjectName: {
            type: "string",
            description: "Linear project name to store in sync state when setting a project binding.",
          },
          paperclipProjectId: {
            type: "string",
            description: "Paperclip project UUID to bind to the Linear project.",
          },
          replaceExisting: {
            type: "boolean",
            description: "Replace conflicting existing Paperclip/Linear bindings.",
          },
          linkProjectFromIssue: {
            type: "boolean",
            description: "When setting an issue binding, also bind the issue's Linear project to the Paperclip issue's project.",
          },
          syncDirection: {
            type: "string",
            enum: ["bidirectional", "linear-to-paperclip", "paperclip-to-linear"],
            description: "Sync direction for newly written bindings.",
          },
        },
      },
    },
    {
      name: TOOL_NAMES.link,
      displayName: "Link Linear Issue",
      description:
        "Link a Linear issue to the current Paperclip issue for bidirectional sync.",
      parametersSchema: {
        type: "object",
        properties: {
          linearRef: {
            type: "string",
            description: "Linear issue identifier (e.g. LUC-123) or URL",
          },
        },
        required: ["linearRef"],
      },
    },
    {
      name: TOOL_NAMES.unlink,
      displayName: "Unlink Linear Issue",
      description:
        "Remove the sync link between a Linear issue and the current Paperclip issue.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: TOOL_NAMES.markDuplicate,
      displayName: "Mark Linear Duplicate",
      description:
        "Mark one Linear issue as a native duplicate of another (issueRelation type: duplicate).",
      parametersSchema: {
        type: "object",
        properties: {
          dupeRef: { type: "string", description: "Linear identifier or URL of the DUPLICATE (e.g. canceled twin), e.g. BLO-1184" },
          keeperRef: { type: "string", description: "Linear identifier or URL of the KEEPER issue, e.g. BLO-2167" },
        },
        required: ["dupeRef", "keeperRef"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "detailTab",
        id: SLOT_IDS.issueTab,
        displayName: "Linear",
        exportName: EXPORT_NAMES.issueTab,
        entityTypes: ["issue"],
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Linear Issue Sync",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
