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
    "description": "List authorized reusable workspaces in ascending workspace-ID order. Returns workspaces, limit, returnedCount, hasMore and nextCursor. Follow nextCursor until null before treating the inventory as complete. Each page checks current access; concurrent changes require a fresh scan. Choosing a workspace does not assign a project.",
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
      "result": { "workspaces": [], "limit": 50, "returnedCount": 0, "hasMore": false, "nextCursor": null }
    }
  },
  "live": {
    "order": 81,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "list_workspaces",
      "version": 1,
      "title": "List available workspaces",
      "description": "List authorized reusable workspaces in ascending workspace-ID order. Returns workspaces, limit, returnedCount, hasMore and nextCursor. Follow nextCursor until null before treating the inventory as complete. Each page checks current access; concurrent changes require a fresh scan. Choosing a workspace does not assign a project.",
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
        "properties": {
          "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 50 },
          "cursor": { "type": "string", "format": "uuid", "description": "The nextCursor from the previous page. Omit for the first page." }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "workspaces": { "type": "array", "maxItems": 100, "items": { "type": "object", "additionalProperties": true } },
          "limit": { "type": "integer", "minimum": 1, "maximum": 100 },
          "returnedCount": { "type": "integer", "minimum": 0, "maximum": 100 },
          "hasMore": { "type": "boolean" },
          "nextCursor": { "type": ["string", "null"], "format": "uuid" }
        },
        "required": ["workspaces", "limit", "returnedCount", "hasMore", "nextCursor"],
        "additionalProperties": false
      },
      "exposure": "optional"
    }
  },
  "scenario": null
} as const;
