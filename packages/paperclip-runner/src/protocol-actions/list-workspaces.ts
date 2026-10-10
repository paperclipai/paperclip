/** Canonical task workspace operation. */
export const listWorkspacesAction = {
  "id": "list_workspaces",
  "canonical": {
    "operationId": "list_workspaces",
    "surfaces": [
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "workspace_runtime",
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "ask",
      "planning",
      "skill_test"
    ],
    "sideEffectClass": "read",
    "idempotency": "none",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "PaperclipRunnerToolAuthority",
    "prpEvidence": "Authenticated task workspace routes and durable selection/repository receipts.",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "List available workspaces",
    "description": "List authorized reusable workspaces. A project is optional; choosing a workspace does not assign a project.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "list_workspaces",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "list_workspaces",
      "result": []
    }
  },
  "live": {
    "order": 81,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "list_workspaces",
      "version": 1,
      "title": "List available workspaces",
      "description": "List authorized reusable workspaces. A project is optional; choosing a workspace does not assign a project.",
      "effect": "read",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": true
        }
      },
      "exposure": "optional"
    }
  },
  "scenario": null
} as const;
