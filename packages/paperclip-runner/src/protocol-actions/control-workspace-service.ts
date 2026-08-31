/** Canonical definition and documentation for `control_workspace_service`. */
export const controlWorkspaceServiceAction = {
  "id": "control_workspace_service",
  "canonical": {
    "operationId": "control_workspace_service",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "workspace_runtime",
    "requiredClaims": [
      "workspace:control"
    ],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "workspace_control",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "unbound",
    "prpEvidence": "workspace service lifecycle event",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Control workspace service",
    "description": "Start, stop, or fault one active-task mock workspace service.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "control_workspace_service",
      "input": {
        "idempotencyKey": "example",
        "serviceId": "example",
        "action": "start"
      }
    },
    "scenarioCall": {
      "operationId": "control_workspace_service",
      "idempotencyKey": "example",
      "input": {
        "serviceId": "example",
        "action": "start"
      }
    },
    "success": {
      "ok": true,
      "operationId": "control_workspace_service",
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
    "order": 20,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "control_workspace_service",
      "version": 1,
      "title": "Control workspace service",
      "description": "Start, stop, or fault one active-task mock workspace service.",
      "exposure": "optional",
      "requiredClaims": [
        "workspace:control"
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
          "serviceId": {
            "type": "string",
            "description": "Mock workspace service id.",
            "minLength": 1,
            "maxLength": 200
          },
          "action": {
            "enum": [
              "start",
              "stop",
              "fail"
            ]
          },
          "url": {
            "type": [
              "string",
              "null"
            ],
            "description": "Optional mock service URL.",
            "maxLength": 20000
          }
        },
        "required": [
          "idempotencyKey",
          "serviceId",
          "action"
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
    "order": 27,
    "descriptor": {
      "operationId": "control_workspace_service",
      "version": 1,
      "title": "Control Workspace Service",
      "description": "Control Workspace Service through the Capability workspace runtime capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "serviceId": {
            "type": "string",
            "minLength": 1
          },
          "action": {
            "type": "string",
            "enum": [
              "start",
              "stop",
              "fail"
            ]
          },
          "url": {
            "type": "string"
          }
        },
        "required": [
          "serviceId",
          "action"
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
      "disposition": "optional_agent_tool",
      "optionalGroup": "workspace_runtime",
      "requiredClaims": [
        "workspace:control"
      ],
      "taskModes": [
        "standard",
        "skill_test"
      ],
      "sideEffectClass": "workspace_control",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "control_workspace_service"
      }
    }
  }
} as const;
