/** Canonical definition and documentation for `request_human_input`. */
export const requestHumanInputAction = {
  "id": "request_human_input",
  "canonical": {
    "operationId": "request_human_input",
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
      "ask",
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
    "title": "Request structured human input",
    "description": "Create a typed, durable interaction on the active mock task.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "request_human_input",
      "input": {
        "idempotencyKey": "example",
        "interactionKind": "confirmation",
        "title": "example",
        "prompt": "example",
        "continuationPolicy": "none"
      }
    },
    "scenarioCall": {
      "operationId": "request_human_input",
      "idempotencyKey": "example",
      "input": {
        "interactionKind": "confirmation",
        "title": "example",
        "prompt": "example",
        "continuationPolicy": "none"
      }
    },
    "success": {
      "ok": true,
      "operationId": "request_human_input",
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
    "order": 8,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "request_human_input",
      "version": 1,
      "title": "Request structured human input",
      "description": "Create a typed, durable interaction on the active mock task.",
      "exposure": "always",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "planning",
        "ask",
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
          "interactionKind": {
            "enum": [
              "confirmation",
              "checkbox",
              "questions",
              "suggest_tasks",
              "item_verdicts"
            ]
          },
          "title": {
            "type": "string",
            "description": "Interaction card title.",
            "minLength": 1,
            "maxLength": 300
          },
          "prompt": {
            "type": "string",
            "description": "Question or decision prompt.",
            "minLength": 1,
            "maxLength": 10000
          },
          "payload": {
            "type": "object",
            "description": "Kind-specific interaction data. For interactionKind='questions', use exactly {version:1, questions:[{id,prompt,selectionMode:'single'|'multi',required?,options:[{id,label,description?,freeText?}]}]}; option keys are id/label, not value, and question choice cardinality is selectionMode, not type. For confirmation, payload may be {}. Keep all ids stable across retries.",
            "additionalProperties": true
          },
          "targetRevisionId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Optional bound document revision.",
            "maxLength": 20000
          },
          "continuationPolicy": {
            "enum": [
              "none",
              "wake_assignee",
              "wake_assignee_on_accept"
            ]
          }
        },
        "required": [
          "idempotencyKey",
          "interactionKind",
          "title",
          "prompt",
          "continuationPolicy"
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
    "order": 11,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "request_human_input",
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
      "operationId": "request_human_input",
      "version": 1,
      "title": "Request human input",
      "description": "Create a typed confirmation, checkbox, question, task suggestion, or item-verdict request.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "interactionKind": {
            "type": "string",
            "enum": [
              "confirmation",
              "checkbox",
              "questions",
              "suggest_tasks",
              "item_verdicts"
            ]
          },
          "title": {
            "type": "string",
            "minLength": 1
          },
          "prompt": {
            "type": "string",
            "minLength": 1
          },
          "payload": {
            "description": "Kind-specific interaction data. Questions use {version:1, questions:[{id,prompt,selectionMode:'single'|'multi',required?,options:[{id,label,description?,freeText?}]}]}; do not use type:'single_choice' or option.value."
          },
          "targetRevisionId": {
            "oneOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "null"
              }
            ]
          },
          "continuationPolicy": {
            "type": "string",
            "enum": [
              "none",
              "wake_assignee",
              "wake_assignee_on_accept"
            ]
          }
        },
        "required": [
          "interactionKind",
          "title",
          "prompt",
          "continuationPolicy"
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
        "ask",
        "skill_test"
      ],
      "sideEffectClass": "task_write",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "request_human_input"
      }
    }
  }
} as const;
