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
    "description": "Search mock tasks by text and status within the run company.",
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
      "result": {}
    }
  },
  "live": {
    "order": 15,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "search_tasks",
      "version": 1,
      "title": "Search company tasks",
      "description": "Search mock tasks by text and status within the run company.",
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
          }
        },
        "required": [],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
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
