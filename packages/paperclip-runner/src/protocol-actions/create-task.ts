/** Canonical definition and documentation for `create_task`. */
export const createTaskAction = {
  "id": "create_task",
  "canonical": {
    "operationId": "create_task",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "delegation_dependencies",
    "requiredClaims": [
      "delegation:tasks:create"
    ],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "company_write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "issues.createChild",
    "prpEvidence": "semantic-operation item event plus company-entity state diff and audit record",
    "prpBindingStatus": "bound",
    "legacyAliases": [
      "mcp:paperclipCreateIssue"
    ]
  },
  "documentation": {
    "title": "Create child task",
    "description": "Create one durable standard child under the active task.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "create_task",
      "input": {
        "idempotencyKey": "example",
        "title": "example"
      }
    },
    "scenarioCall": {
      "operationId": "create_task",
      "idempotencyKey": "example",
      "input": {
        "title": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "create_task",
      "result": {
        "commandId": "example",
        "disposition": "applied",
        "stateRevision": 1,
        "entityRefs": [
          "example"
        ],
        "scheduledWakeIds": [
          "example"
        ],
        "task": {
          "id": "example",
          "identifier": "EX-2",
          "parentId": "example-parent",
          "status": "todo",
          "assigneeActorId": "example-agent"
        }
      }
    }
  },
  "live": {
    "order": 22,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "create_task",
      "version": 1,
      "title": "Create child task",
      "description": "Create one durable standard child under the active task. Use only when a real ownership, parallelism, dependency, review, or lifecycle boundary justifies delegation.",
      "exposure": "optional",
      "requiredClaims": [
        "delegation:tasks:create"
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
          "title": {
            "type": "string",
            "description": "Child task title.",
            "minLength": 1,
            "maxLength": 500
          },
          "description": {
            "type": [
              "string",
              "null"
            ],
            "description": "Child task description.",
            "maxLength": 20000
          },
          "assigneeActorId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Optional agent assignee. Omit to assign the current agent.",
            "maxLength": 20000
          },
          "priority": {
            "enum": [
              "critical",
              "high",
              "medium",
              "low"
            ]
          },
          "blockedByTaskIds": {
            "type": "array",
            "description": "Initial blocker task ids.",
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
          },
          "task": {
            "type": "object",
            "properties": {
              "id": { "type": "string", "minLength": 1 },
              "identifier": { "type": ["string", "null"] },
              "parentId": { "type": "string", "minLength": 1 },
              "status": { "type": "string", "minLength": 1 },
              "assigneeActorId": { "type": ["string", "null"] }
            },
            "required": ["id", "identifier", "parentId", "status", "assigneeActorId"],
            "additionalProperties": false
          }
        },
        "required": [
          "commandId",
          "disposition",
          "stateRevision",
          "entityRefs",
          "scheduledWakeIds",
          "task"
        ],
        "additionalProperties": false
      }
    }
  },
  "scenario": {
    "order": 18,
    "descriptor": {
      "operationId": "create_task",
      "version": 1,
      "title": "Create Task",
      "description": "Create Task through the Capability delegation dependencies capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "minLength": 1
          },
          "description": {
            "type": "string"
          },
          "assigneeActorId": {
            "type": "string"
          },
          "priority": {
            "type": "string"
          },
          "blockedByTaskIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": [
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
            "const": "create_task"
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
        "delegation:tasks:create"
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
        "commandKind": "create_task"
      }
    }
  }
} as const;
