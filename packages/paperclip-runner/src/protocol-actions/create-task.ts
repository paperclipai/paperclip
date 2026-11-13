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
    "realServiceBinding": "issues.create / issues.createChild",
    "prpEvidence": "semantic-operation item event plus company-entity state diff and audit record",
    "prpBindingStatus": "bound",
    "legacyAliases": [
      "mcp:paperclipCreateIssue"
    ]
  },
  "documentation": {
    "title": "Create task",
    "description": "Create a task. When the user names an existing teammate or project, resolve their IDs with list_agents or list_projects and set assigneeActorId or projectId in this creation call. A todo task can start its assignee immediately; creating it for yourself and reassigning later can start the wrong agent. Persist initialPlan before execution. Use backlog to save or plan without starting work; backlog tasks never wake an agent. Omitted status means todo, subject to blockers. Include required inputs and constraints in self-contained task instructions.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "create_task",
      "input": {
        "idempotencyKey": "delegate-api-change-v1",
        "title": "Implement the approved API change",
        "description": "Implement the agreed API change in this project. Run the relevant tests and report the result.",
        "assigneeActorId": "example-agent",
        "projectId": "example-project",
        "initialPlan": "1. Implement the agreed change.\n2. Run the relevant tests.\n3. Report the verified result."
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
      "title": "Create task",
      "description": "Create a task. When the user names an existing teammate or project, resolve their IDs with list_agents or list_projects and set assigneeActorId or projectId in this creation call. A todo task can start its assignee immediately; creating it for yourself and reassigning later can start the wrong agent. Persist initialPlan before execution. Use backlog to save or plan without starting work; backlog tasks never wake an agent. Omitted status means todo, subject to blockers. Include required inputs and constraints in self-contained task instructions.",
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
            "description": "Task title.",
            "minLength": 1,
            "maxLength": 500
          },
          "description": {
            "type": [
              "string",
              "null"
            ],
            "description": "Self-contained task instructions with actual required inputs, exact payloads or accessible authorized source references, constraints, and requested outputs. The new task does not inherit this conversation. Do not use unresolved references such as provided above, or copy credentials or secrets.",
            "maxLength": 20000
          },
          "assigneeUserId": { "type": ["string", "null"], "description": "Company person ID from list_people. Mutually exclusive with assigneeActorId." },
          "assigneeActorId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Existing company agent ID from list_agents. Set the requested teammate here during creation. Omit or use null to assign the current agent; a todo task can start that agent before a later reassignment. Mutually exclusive with assigneeUserId.",
            "maxLength": 20000
          },
          "status": {
            "enum": ["backlog", "todo"],
            "description": "Initial status. Use backlog to save work without executing it. Defaults to todo (blocked when dependencies are unresolved)."
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
            "description": "Tasks that must finish before this new task can execute. Parent-child linkage is not a blocker; do not list a parent that is waiting for this child.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          },
          "projectId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Project ID from list_projects. Set the requested project in this creation call so the task does not inherit a different project."
          },
          "parentTaskId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Optional parent task ID. Omit it to create a child of the current task, or a top-level task from a conversation. Agents nest one level: a child of a child is placed beside it, and the result reports the parent actually used. A conversation is never a parent.",
            "minLength": 1,
            "maxLength": 200
          },
          "initialPlan": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 200000,
            "description": "Relevant markdown plan saved on the new task before execution starts."
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
          },
          "task": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "minLength": 1
              },
              "identifier": {
                "type": [
                  "string",
                  "null"
                ]
              },
              "parentId": {
                "type": ["string", "null"],
                "minLength": 1
              },
              "projectId": {
                "type": ["string", "null"],
                "minLength": 1
              },
              "status": {
                "type": "string",
                "minLength": 1
              },
              "assigneeUserId": { "type": ["string", "null"], "description": "Company person ID from list_people. Mutually exclusive with assigneeActorId." },
          "assigneeActorId": {
                "type": [
                  "string",
                  "null"
                ]
              }
            },
            "required": [
              "id",
              "identifier",
              "parentId",
              "status",
              "assigneeActorId"
            ],
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
            "type": "string",
            "description": "Self-contained task instructions with actual required inputs, exact payloads or accessible authorized source references, constraints, and requested outputs. The new task does not inherit this conversation. Do not use unresolved references such as provided above, or copy credentials or secrets."
          },
          "assigneeUserId": { "type": ["string", "null"], "description": "Company person ID from list_people. Mutually exclusive with assigneeActorId." },
          "assigneeActorId": {
            "type": "string"
          },
          "status": {
            "enum": ["backlog", "todo"],
            "description": "Initial status. Use backlog to save work without executing it. Defaults to todo (blocked when dependencies are unresolved)."
          },
          "priority": {
            "type": "string"
          },
          "blockedByTaskIds": {
            "type": "array",
            "description": "Tasks that must finish before this new task can execute. Parent-child linkage is not a blocker; do not list a parent that is waiting for this child.",
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
