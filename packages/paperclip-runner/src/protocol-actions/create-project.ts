/** Existing GitHub repository references, never arbitrary network/resource URIs. */
export const projectRepositoryUrlSchema = {
  type: "string",
  maxLength: 2000,
  pattern: "^https://github\\.com/(?!\\.{1,2}/)[A-Za-z0-9_.-]+/(?!\\.{1,2}/?$)[A-Za-z0-9_.-]+/?$",
} as const;

/** Canonical project tool definition. */
export const createProjectAction = {
  "id": "create_project",
  "canonical": {
    "operationId": "create_project",
    "surfaces": [
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "discovery",
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "company_write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "PaperclipRunnerToolAuthority",
    "prpEvidence": "Authenticated project tools, persisted projects and repository workspaces, and run-bound activity.",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Create project",
    "description": "Create a project after considering existing projects and available repositories. repositoryIds and repositoryUrls accept multiple existing repositories. Use HTTPS GitHub repositoryUrls when an accessible repo is not in the catalog; this registers project repositories, not remote GitHub repositories. Non-code projects may omit repositories. Cannot combine repositoryIds/repositoryUrls with workspace. Reuse the idempotency key on retries.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "create_project",
      "input": {
        "name": "Example",
        "repositoryIds": [
          "1",
          "2"
        ],
        "idempotencyKey": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "create_project",
      "result": {}
    }
  },
  "live": {
    "order": 43,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "create_project",
      "version": 1,
      "title": "Create project",
      "description": "Create a project after considering existing projects and available repositories. repositoryIds and repositoryUrls accept multiple existing repositories. Use HTTPS GitHub repositoryUrls when an accessible repo is not in the catalog; this registers project repositories, not remote GitHub repositories. Non-code projects may omit repositories. Cannot combine repositoryIds/repositoryUrls with workspace. Reuse the idempotency key on retries.",
      "effect": "write",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "idempotencyKey": {
            "type": "string",
            "description": "Caller-stable retry key.",
            "minLength": 1,
            "maxLength": 240
          },
          "name": {
            "type": "string",
            "description": "Project name.",
            "minLength": 1,
            "maxLength": 500
          },
          "description": {
            "type": [
              "string",
              "null"
            ],
            "description": "Project outcome and context.",
            "maxLength": 20000
          },
          "repositoryIds": {
            "type": "array",
            "description": "Authorized repository IDs from list_project_repositories; may contain multiple repositories.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          },
          "workspace": {
            "type": "object",
            "additionalProperties": true
          },
          "status": {
            "enum": [
              "backlog",
              "planned",
              "in_progress",
              "completed",
              "cancelled"
            ]
          },
          "goalId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Goal ID.",
            "maxLength": 20000
          },
          "goalIds": {
            "type": "array",
            "description": "Goal IDs.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          },
          "leadAgentId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Lead agent ID.",
            "maxLength": 20000
          },
          "targetDate": {
            "type": [
              "string",
              "null"
            ],
            "description": "Target date.",
            "maxLength": 20000
          },
          "color": {
            "type": [
              "string",
              "null"
            ],
            "description": "Project color.",
            "maxLength": 20000
          },
          "icon": {
            "type": [
              "string",
              "null"
            ],
            "description": "Project icon.",
            "maxLength": 20000
          },
          "env": {
            "type": "object",
            "additionalProperties": true
          },
          "executionWorkspacePolicy": {
            "type": "object",
            "additionalProperties": true
          },
          "archivedAt": {
            "type": [
              "string",
              "null"
            ],
            "description": "Archive timestamp.",
            "maxLength": 20000
          },
          "repositoryUrls": {
            "type": "array",
            "items": projectRepositoryUrlSchema,
            "maxItems": 100,
            "description": "Existing HTTPS GitHub repository URLs, including repos absent from the catalog."
          }
        },
        "required": [
          "idempotencyKey",
          "name"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "additionalProperties": true
      },
      "exposure": "optional"
    }
  },
  "scenario": null
} as const;
