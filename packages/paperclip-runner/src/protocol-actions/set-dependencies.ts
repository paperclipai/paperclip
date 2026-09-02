/** Canonical definition and documentation for `set_dependencies`. */
export const setDependenciesAction = {
  "id": "set_dependencies",
  "canonical": {
    "operationId": "set_dependencies",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "delegation_dependencies",
    "requiredClaims": [
      "dependencies:write"
    ],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "company_write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "issues.update.blockedByIssueIds",
    "prpEvidence": "semantic-operation item event plus company-entity state diff and audit record",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Set task dependencies",
    "description": "Replace the active task's first-class blocker set.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "set_dependencies",
      "input": {
        "idempotencyKey": "example",
        "blockedByTaskIds": [
          "example"
        ]
      }
    },
    "scenarioCall": {
      "operationId": "set_dependencies",
      "idempotencyKey": "example",
      "input": {
        "blockedByTaskIds": [
          "example"
        ]
      }
    },
    "success": {
      "ok": true,
      "operationId": "set_dependencies",
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
    "order": 21,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "set_dependencies",
      "version": 1,
      "title": "Set task dependencies",
      "description": "Replace the active task's first-class blocker set.",
      "exposure": "optional",
      "requiredClaims": [
        "dependencies:write"
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
          "blockedByTaskIds": {
            "type": "array",
            "description": "Replacement blocker task ids.",
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
          "blockedByTaskIds"
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
    "order": 19,
    "descriptor": {
      "operationId": "set_dependencies",
      "version": 1,
      "title": "Set Dependencies",
      "description": "Set Dependencies through the Capability delegation dependencies capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "blockedByTaskIds": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1
            }
          }
        },
        "required": [
          "blockedByTaskIds"
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
            "const": "set_dependencies"
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
      "optionalGroup": "delegation_dependencies",
      "requiredClaims": [
        "dependencies:write"
      ],
      "taskModes": [
        "standard",
        "skill_test"
      ],
      "sideEffectClass": "company_write",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "set_dependencies"
      }
    }
  }
} as const;
