/** Canonical definition and documentation for `comment_on_approval`. */
export const commentOnApprovalAction = {
  "id": "comment_on_approval",
  "canonical": {
    "operationId": "comment_on_approval",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "governance",
    "requiredClaims": [
      "governance:approvals:comment"
    ],
    "taskModes": [
      "standard",
      "ask",
      "planning",
      "skill_test"
    ],
    "sideEffectClass": "governance",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "unbound",
    "prpEvidence": "approval lifecycle plus governed-wait continuation and audit events",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Comment on approval",
    "description": "Add a durable comment to a mock approval.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "comment_on_approval",
      "input": {
        "idempotencyKey": "example",
        "approvalId": "example",
        "body": "example"
      }
    },
    "scenarioCall": {
      "operationId": "comment_on_approval",
      "idempotencyKey": "example",
      "input": {
        "approvalId": "example",
        "body": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "comment_on_approval",
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
    "order": 25,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "comment_on_approval",
      "version": 1,
      "title": "Comment on approval",
      "description": "Add a durable comment to a mock approval.",
      "exposure": "optional",
      "requiredClaims": [
        "governance:approvals:comment"
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
          "idempotencyKey": {
            "type": "string",
            "description": "Caller-stable retry key.",
            "minLength": 1,
            "maxLength": 240
          },
          "approvalId": {
            "type": "string",
            "description": "Mock approval id.",
            "minLength": 1,
            "maxLength": 200
          },
          "body": {
            "type": "string",
            "description": "Approval comment.",
            "minLength": 1,
            "maxLength": 20000
          }
        },
        "required": [
          "idempotencyKey",
          "approvalId",
          "body"
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
    "order": 23,
    "descriptor": {
      "operationId": "comment_on_approval",
      "version": 1,
      "title": "Comment On Approval",
      "description": "Comment On Approval through the Capability governance capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "approvalId": {
            "type": "string",
            "minLength": 1
          },
          "body": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "approvalId",
          "body"
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
            "const": "comment_on_approval"
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
      "optionalGroup": "governance",
      "requiredClaims": [
        "governance:approvals:comment"
      ],
      "taskModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "sideEffectClass": "governance",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "comment_on_approval"
      }
    }
  }
} as const;
