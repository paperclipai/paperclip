/** Canonical definition and documentation for `request_approval`. */
export const requestApprovalAction = {
  "id": "request_approval",
  "canonical": {
    "operationId": "request_approval",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "governance",
    "requiredClaims": [
      "governance:approvals:request"
    ],
    "taskModes": [
      "standard",
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
    "title": "Request approval",
    "description": "Create a governed mock approval and waiting posture.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "request_approval",
      "input": {
        "idempotencyKey": "example",
        "approvalType": "example",
        "payload": {}
      }
    },
    "scenarioCall": {
      "operationId": "request_approval",
      "idempotencyKey": "example",
      "input": {
        "approvalType": "example",
        "payload": {}
      }
    },
    "success": {
      "ok": true,
      "operationId": "request_approval",
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
    "order": 23,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "request_approval",
      "version": 1,
      "title": "Request approval",
      "description": "Create a governed mock approval and waiting posture.",
      "exposure": "optional",
      "requiredClaims": [
        "governance:approvals:request"
      ],
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
          "approvalType": {
            "type": "string",
            "description": "Stable approval type.",
            "minLength": 1,
            "maxLength": 200
          },
          "payload": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "required": [
          "idempotencyKey",
          "approvalType",
          "payload"
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
    "order": 21,
    "descriptor": {
      "operationId": "request_approval",
      "version": 1,
      "title": "Request Approval",
      "description": "Request Approval through the Capability governance capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "approvalType": {
            "type": "string",
            "minLength": 1
          },
          "payload": {}
        },
        "required": [
          "approvalType",
          "payload"
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
            "const": "request_approval"
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
        "governance:approvals:request"
      ],
      "taskModes": [
        "standard",
        "skill_test"
      ],
      "sideEffectClass": "governance",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "request_approval"
      }
    }
  }
} as const;
