/** Canonical definition and documentation for `block_task`. */
export const blockTaskAction = {
  "id": "block_task",
  "canonical": {
    "operationId": "block_task",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "always_agent_tool",
    "optionalGroup": null,
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "task_write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "unbound",
    "prpEvidence": "semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Block active task",
    "description": "Block the active mock task with a durable reason and optional first-class dependencies.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "block_task",
      "input": {
        "idempotencyKey": "example",
        "reason": "example"
      }
    },
    "scenarioCall": {
      "operationId": "block_task",
      "idempotencyKey": "example",
      "input": {
        "reason": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "block_task",
      "result": {
        "commandId": "example",
        "disposition": "applied",
        "stateRevision": 1,
        "entityRefs": [
          "example"
        ],
        "scheduledWakeIds": [
          "example"
        ]
      }
    }
  },
  "live": {
    "order": 11,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "block_task",
      "version": 1,
      "title": "Block active task",
      "description": "Block the active mock task with a durable reason and optional first-class dependencies.",
      "exposure": "always",
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
          "reason": {
            "type": "string",
            "description": "Block reason.",
            "minLength": 1,
            "maxLength": 20000
          },
          "blockedByTaskIds": {
            "type": "array",
            "description": "Internal mock task ids that block this task.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          }
        },
        "required": [
          "idempotencyKey",
          "reason"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "commandId": {
            "type": "string",
            "description": "Stable mock command identifier.",
            "minLength": 1,
            "maxLength": 200
          },
          "disposition": {
            "enum": [
              "applied",
              "duplicate"
            ]
          },
          "stateRevision": {
            "type": "integer",
            "minimum": 0
          },
          "entityRefs": {
            "type": "array",
            "description": "Mock entities affected by the operation.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          },
          "scheduledWakeIds": {
            "type": "array",
            "description": "Wake identifiers scheduled by the operation.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          }
        },
        "required": [
          "commandId",
          "disposition",
          "stateRevision",
          "entityRefs",
          "scheduledWakeIds"
        ],
        "additionalProperties": false
      }
    }
  },
  "scenario": {
    "order": 8,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "block_task",
      "operationResultId": "example-result",
      "value": {
        "commandId": "example",
        "disposition": "applied",
        "stateRevision": 1,
        "entityRefs": ["example"],
        "scheduledWakeIds": ["example"]
      },
      "commandResult": null,
      "authorization": {}
    },
    "descriptor": {
      "operationId": "block_task",
      "version": 1,
      "title": "Block task",
      "description": "Block the active task with a reason and optional first-class dependencies.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "reason": {
            "type": "string",
            "minLength": 1
          },
          "blockedByTaskIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "required": [
          "reason"
        ],
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
        "skill_test"
      ],
      "sideEffectClass": "task_write",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "block_task"
      }
    }
  }
} as const;
