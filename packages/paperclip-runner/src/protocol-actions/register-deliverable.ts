/** Canonical definition and documentation for `register_deliverable`. */
export const registerDeliverableAction = {
  "id": "register_deliverable",
  "canonical": {
    "operationId": "register_deliverable",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "always_agent_tool",
    "optionalGroup": null,
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "planning",
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
    "title": "Register inspectable deliverable",
    "description": "Register mock attachment metadata and its artifact work product without credentials or bytes in the tool result.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "register_deliverable",
      "input": {
        "idempotencyKey": "example",
        "filename": "example",
        "contentType": "example",
        "byteSize": 1,
        "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "contentRef": "example",
        "title": "example"
      }
    },
    "scenarioCall": {
      "operationId": "register_deliverable",
      "idempotencyKey": "example",
      "input": {
        "filename": "example",
        "contentType": "example",
        "byteSize": 1,
        "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "contentRef": "example",
        "title": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "register_deliverable",
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
    "order": 9,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "register_deliverable",
      "version": 1,
      "title": "Register inspectable deliverable",
      "description": "Register mock attachment metadata and its artifact work product without credentials or bytes in the tool result.",
      "exposure": "always",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
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
          "filename": {
            "type": "string",
            "description": "Display filename.",
            "minLength": 1,
            "maxLength": 500
          },
          "contentType": {
            "type": "string",
            "description": "Media type.",
            "minLength": 1,
            "maxLength": 200
          },
          "byteSize": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100000000
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-fA-F0-9]{64}$"
          },
          "contentRef": {
            "type": "string",
            "description": "Opaque package-local content reference.",
            "minLength": 1,
            "maxLength": 2000
          },
          "title": {
            "type": "string",
            "description": "Work-product title.",
            "minLength": 1,
            "maxLength": 500
          }
        },
        "required": [
          "idempotencyKey",
          "filename",
          "contentType",
          "byteSize",
          "sha256",
          "contentRef",
          "title"
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
    "order": 12,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "register_deliverable",
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
      "operationId": "register_deliverable",
      "version": 1,
      "title": "Register deliverable",
      "description": "Register an inspectable artifact and its work product on the active task.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "filename": {
            "type": "string",
            "minLength": 1
          },
          "contentType": {
            "type": "string",
            "minLength": 1
          },
          "byteSize": {
            "type": "integer",
            "minimum": 0
          },
          "sha256": {
            "type": "string",
            "minLength": 1
          },
          "contentRef": {
            "type": "string",
            "minLength": 1
          },
          "title": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "filename",
          "contentType",
          "byteSize",
          "sha256",
          "contentRef",
          "title"
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
        "planning",
        "skill_test"
      ],
      "sideEffectClass": "task_write",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "register_deliverable"
      }
    }
  }
} as const;
