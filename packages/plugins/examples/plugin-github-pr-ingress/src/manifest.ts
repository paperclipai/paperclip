import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "keegoid.plugin-github-pr-ingress",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub PR Ingress",
  description: "Sync GitHub pull request webhooks into Paperclip issues.",
  author: "Keegoid",
  categories: ["connector"],
  capabilities: [
    "webhooks.receive",
    "secrets.read-ref",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register",
    "instance.settings.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      githubWebhookSecretRef: {
        type: "string",
        title: "GitHub Webhook Secret Ref",
        format: "secret-ref",
        description: "Paperclip secret UUID containing the GitHub webhook secret."
      },
      repositories: {
        type: "array",
        title: "Repository Mappings",
        description: "GitHub repository to Paperclip company mappings.",
        items: {
          type: "object",
          properties: {
            repository: {
              type: "string",
              title: "Repository",
              description: "GitHub full name, for example keegoidllc/agentic-strategy-designer."
            },
            companyId: {
              type: "string",
              title: "Company ID"
            },
            projectId: {
              type: "string",
              title: "Project ID"
            },
            parentIssueId: {
              type: "string",
              title: "Parent Issue ID"
            },
            assigneeAgentId: {
              type: "string",
              title: "Assignee Agent ID"
            },
            priority: {
              type: "string",
              title: "Priority",
              enum: ["critical", "high", "medium", "low"],
              default: "medium"
            }
          },
          required: ["repository", "companyId"]
        },
        default: []
      }
    },
    required: ["githubWebhookSecretRef", "repositories"]
  },
  webhooks: [
    {
      endpointKey: "github-pull-request",
      displayName: "GitHub Pull Request",
      description: "Receives GitHub pull_request webhooks and syncs them into Paperclip issues."
    }
  ],
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "GitHub PR Ingress Health",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
