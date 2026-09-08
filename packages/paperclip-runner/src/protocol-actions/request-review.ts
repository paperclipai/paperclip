/** Canonical definition and documentation for `request_review`. */
export const requestReviewAction = {
  "id": "request_review",
  "canonical": {
    "operationId": "request_review",
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
    "title": "Request task review",
    "description": "Move the active mock task to review with a durable summary.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "request_review",
      "input": {
        "idempotencyKey": "example",
        "summary": "example"
      }
    },
    "scenarioCall": {
      "operationId": "request_review",
      "idempotencyKey": "example",
      "input": {
        "summary": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "request_review",
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
    "order": 12,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "request_review",
      "version": 1,
      "title": "Request task review",
      "description": "Move the active mock task to review with a durable summary.",
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
          "summary": {
            "type": "string",
            "description": "Review handoff summary.",
            "minLength": 1,
            "maxLength": 20000
          }
        },
        "required": [
          "idempotencyKey",
          "summary"
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
    "order": 9,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "request_review",
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
      "operationId": "request_review",
      "version": 1,
      "title": "Request task review",
      "description": "Move the active task to review with a durable summary.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "summary": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "summary"
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
        "commandKind": "request_review"
      }
    }
  }
} as const;
