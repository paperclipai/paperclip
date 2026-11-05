/** Canonical definition and documentation for `search_tasks`. */
export const searchTasksAction = {
  "id": "search_tasks",
  "canonical": {
    "operationId": "search_tasks",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "discovery",
    "requiredClaims": [
      "discovery:tasks:read"
    ],
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
    "realServiceBinding": "unbound",
    "prpEvidence": "read projection surfaced via a tool-result item event; no control-plane state diff",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": [
      "mcp:paperclipListIssues"
    ]
  },
  "documentation": {
    "title": "Search company tasks",
    "description": "Search tasks by text and status within the run company in ascending task-ID order. Returns tasks, effective limit, returnedCount, hasMore and nextCursor. Follow nextCursor with the same query and statuses until null before treating an inventory as complete. Each page checks current access; concurrent task changes require a fresh scan.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "search_tasks",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "search_tasks",
      "result": { "tasks": [], "limit": 50, "returnedCount": 0, "hasMore": false, "nextCursor": null }
    }
  },
  "live": {
    "order": 15,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "search_tasks",
      "version": 1,
      "title": "Search company tasks",
      "description": "Search tasks by text and status within the run company in ascending task-ID order. Returns tasks, effective limit, returnedCount, hasMore and nextCursor. Follow nextCursor with the same query and statuses until null before treating an inventory as complete. Each page checks current access; concurrent task changes require a fresh scan.",
      "exposure": "optional",
      "requiredClaims": [
        "discovery:tasks:read"
      ],
      "allowedModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "maxLength": 500
          },
          "statuses": {
            "type": "array",
            "items": {
              "enum": [
                "backlog",
                "todo",
                "in_progress",
                "in_review",
                "done",
                "blocked",
                "cancelled"
              ]
            },
            "maxItems": 7,
            "uniqueItems": true
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 200,
            "default": 50
          },
          "cursor": {
            "type": "string",
            "format": "uuid",
            "description": "The nextCursor from the previous page. Keep query and statuses unchanged. Omit for the first page."
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "tasks": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
          "limit": { "type": "integer", "minimum": 1, "maximum": 200 },
          "returnedCount": { "type": "integer", "minimum": 0, "maximum": 200 },
          "hasMore": { "type": "boolean" },
          "nextCursor": { "type": ["string", "null"] }
        },
        "required": ["tasks", "limit", "returnedCount", "hasMore", "nextCursor"],
        "additionalProperties": true
      }
    }
  },
  "scenario": {
    "order": 14,
    "descriptor": {
      "operationId": "search_tasks",
      "version": 1,
      "title": "Search Tasks",
      "description": "Search Tasks through the Capability discovery capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string"
          },
          "status": {
            "type": "string"
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "schema": {
            "type": "string",
            "enum": [
              "paperclip.capability.tool-result.v1"
            ]
          },
          "ok": {
            "type": "boolean"
          },
          "operationId": {
            "const": "search_tasks"
          },
          "operationResultId": {
            "type": "string",
            "minLength": 1
          },
          "value": {},
          "commandResult": {},
          "authorization": {}
        },
        "required": [
          "schema",
          "ok",
          "operationId",
          "operationResultId",
          "value",
          "commandResult",
          "authorization"
        ],
        "additionalProperties": false
      },
      "disposition": "optional_agent_tool",
      "optionalGroup": "discovery",
      "requiredClaims": [
        "discovery:tasks:read"
      ],
      "taskModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "sideEffectClass": "read",
      "idempotency": "none",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "snapshot_read",
        "projection": "company_tasks"
      }
    }
  }
} as const;
