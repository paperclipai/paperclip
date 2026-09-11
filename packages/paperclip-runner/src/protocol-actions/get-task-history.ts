/** Canonical definition and documentation for `get_task_history`. */
export const getTaskHistoryAction = {
  "id": "get_task_history",
  "canonical": {
    "operationId": "get_task_history",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "always_agent_tool",
    "optionalGroup": null,
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
    "realServiceBinding": "unbound",
    "prpEvidence": "read projection surfaced via a tool-result item event; no control-plane state diff",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Get active task history",
    "description": "Read bounded comments on the active mock task.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "get_task_history",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "get_task_history",
      "result": {}
    }
  },
  "live": {
    "order": 1,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "get_task_history",
      "version": 1,
      "title": "Get active task history",
      "description": "Read bounded comments on the active mock task.",
      "exposure": "always",
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
    "order": 1,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "get_task_history",
      "operationResultId": "example-result",
      "value": {},
      "commandResult": null,
      "authorization": {}
    },
    "descriptor": {
      "operationId": "get_task_history",
      "version": 1,
      "title": "Get task history",
      "description": "Read comments and audit-visible history for the active task only.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "limit": {
            "type": "integer",
            "minimum": 1
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
            "type": "string",
            "minLength": 1
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
      "disposition": "always_agent_tool",
      "optionalGroup": null,
      "requiredClaims": [],
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
        "projection": "active_task_history"
      }
    }
  }
} as const;
