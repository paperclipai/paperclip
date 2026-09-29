/** Canonical definition and documentation for `reassign_task`. */
export const reassignTaskAction = {
  "id": "reassign_task",
  "canonical": {
    "operationId": "reassign_task",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "delegation_dependencies",
    "requiredClaims": [
      "delegation:tasks:assign"
    ],
    "taskModes": [
      "standard"
    ],
    "sideEffectClass": "company_write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "PaperclipRunnerToolAuthority.reassign_task",
    "prpEvidence": "semantic-operation item event plus company-entity state diff and audit record",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Reassign task",
    "description": "Reassign an existing task to another company agent. Read search_tasks first and supply its current assignee and statusVersion to prevent overwriting a concurrent change. Preserve the task, documents, dependencies, and blocked/backlog status. Active work is stopped before handoff. Use a stable idempotency key for retries. Cannot reassign this run\u2019s own task, conversations, completed tasks, or pending reviews; use create_task for delegation from the current task.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "reassign_task",
      "input": {
        "idempotencyKey": "reassign-example",
        "taskId": "task-delegated",
        "assigneeActorId": "actor-manager",
        "expectedAssigneeActorId": "actor-engineer",
        "expectedStatusVersion": 0,
        "reason": "The manager owns the next step."
      }
    },
    "scenarioCall": {
      "operationId": "reassign_task",
      "idempotencyKey": "reassign-example",
      "input": {
        "taskId": "task-delegated",
        "assigneeActorId": "actor-manager",
        "expectedAssigneeActorId": "actor-engineer",
        "expectedStatusVersion": 0,
        "reason": "The manager owns the next step."
      }
    },
    "success": {
      "ok": true,
      "operationId": "reassign_task",
      "result": {
        "commandId": "reassign-example",
        "disposition": "applied",
        "stateRevision": 1,
        "entityRefs": [
          "task-delegated"
        ],
        "scheduledWakeIds": [
          "wake-example"
        ]
      }
    }
  },
  "live": {
    "order": 46,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "reassign_task",
      "version": 1,
      "title": "Reassign task",
      "description": "Reassign an existing task to another company agent. Read search_tasks first and supply its current assignee and statusVersion to prevent overwriting a concurrent change. Preserve the task, documents, dependencies, and blocked/backlog status. Active work is stopped before handoff. Use a stable idempotency key for retries. Cannot reassign this run\u2019s own task, conversations, completed tasks, or pending reviews; use create_task for delegation from the current task.",
      "exposure": "optional",
      "requiredClaims": [
        "delegation:tasks:assign"
      ],
      "allowedModes": [
        "standard"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "idempotencyKey": {
            "type": "string",
            "minLength": 1,
            "maxLength": 240,
            "description": "Caller-stable retry key."
          },
          "taskId": {
            "type": "string",
            "minLength": 1,
            "description": "Existing task ID from search_tasks."
          },
          "assigneeActorId": {
            "type": "string",
            "minLength": 1,
            "description": "New company agent ID from list_agents."
          },
          "expectedAssigneeActorId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Current assigneeAgentId from search_tasks; null means unassigned."
          },
          "expectedStatusVersion": {
            "type": "integer",
            "minimum": 0,
            "description": "Current statusVersion from search_tasks."
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 20000,
            "description": "Why the task should move and context for the new owner."
          }
        },
        "required": [
          "idempotencyKey",
          "taskId",
          "assigneeActorId",
          "expectedAssigneeActorId",
          "expectedStatusVersion",
          "reason"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "commandId": {
            "type": "string",
            "description": "Stable command identifier.",
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
            "description": "Entities affected by the operation.",
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
    "order": 40,
    "descriptor": {
      "operationId": "reassign_task",
      "version": 1,
      "title": "Reassign task",
      "description": "Reassign an existing task to another company agent. Read search_tasks first and supply its current assignee and statusVersion to prevent overwriting a concurrent change. Preserve the task, documents, dependencies, and blocked/backlog status. Active work is stopped before handoff. Use a stable idempotency key for retries. Cannot reassign this run\u2019s own task, conversations, completed tasks, or pending reviews; use create_task for delegation from the current task.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "taskId": {
            "type": "string",
            "minLength": 1,
            "description": "Existing task ID from search_tasks."
          },
          "assigneeActorId": {
            "type": "string",
            "minLength": 1,
            "description": "New company agent ID from list_agents."
          },
          "expectedAssigneeActorId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Current assigneeAgentId from search_tasks; null means unassigned."
          },
          "expectedStatusVersion": {
            "type": "integer",
            "minimum": 0,
            "description": "Current statusVersion from search_tasks."
          },
          "reason": {
            "type": "string",
            "minLength": 1,
            "maxLength": 20000,
            "description": "Why the task should move and context for the new owner."
          }
        },
        "required": [
          "taskId",
          "assigneeActorId",
          "expectedAssigneeActorId",
          "expectedStatusVersion",
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
            "const": "reassign_task"
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
        "delegation:tasks:assign"
      ],
      "taskModes": [
        "standard"
      ],
      "sideEffectClass": "company_write",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "reassign_task"
      }
    }
  }
} as const;
