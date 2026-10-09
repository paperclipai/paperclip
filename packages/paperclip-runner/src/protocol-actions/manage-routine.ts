/** Canonical definition and documentation for `manage_routine`. */
export const manageRoutineAction = {
  "id": "manage_routine",
  "canonical": {
    "operationId": "manage_routine",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "routines",
    "requiredClaims": [
      "routines:write"
    ],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "admin",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "routineService.create/update/createTrigger/updateTrigger",
    "prpEvidence": "company admin/portability item event plus audit record",
    "prpBindingStatus": "bound",
    "legacyAliases": [],
    "note": "Agent mutations are restricted to self-assigned routines."
  },
  "documentation": {
    "title": "Manage Routine",
    "description": "Create, update, pause, or resume a Paperclip routine assigned to you. Read existing routines and revisions using the authorized read API before changing them. Reuse the idempotency key on retry. Paperclip owns scheduling, budgets, concurrency and task creation.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "manage_routine",
      "input": {
        "idempotencyKey": "daily-research",
        "action": "create",
        "title": "Daily research",
        "schedule": {
          "cronExpression": "0 9 * * 1-5",
          "timezone": "America/Chicago"
        }
      }
    },
    "scenarioCall": {
      "operationId": "manage_routine",
      "idempotencyKey": "example",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "manage_routine",
      "result": {
        "schema": "paperclip.capability.tool-result.v1",
        "ok": true,
        "operationId": "example",
        "operationResultId": "example",
        "value": "example",
        "commandResult": "example",
        "authorization": "example"
      }
    }
  },
  "live": {
    "order": 60,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "manage_routine",
      "version": 1,
      "title": "Manage routine",
      "description": "Create, update, pause, or resume a Paperclip routine assigned to you. Read existing routines and revisions using the authorized read API before changing them. Reuse the idempotency key on retry. Paperclip owns scheduling, budgets, concurrency and task creation.",
      "effect": "write",
      "exposure": "optional",
      "requiredClaims": [
        "routines:write"
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
            "minLength": 1,
            "maxLength": 240
          },
          "action": {
            "enum": [
              "create",
              "update",
              "pause",
              "resume"
            ]
          },
          "routineId": {
            "type": "string",
            "format": "uuid"
          },
          "baseRevisionId": {
            "type": "string",
            "format": "uuid"
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "description": {
            "type": "string",
            "maxLength": 200000
          },
          "projectId": {
            "type": "string",
            "format": "uuid"
          },
          "schedule": {
            "type": "object",
            "properties": {
              "triggerId": {
                "type": "string",
                "format": "uuid"
              },
              "cronExpression": {
                "type": "string",
                "minLength": 1,
                "maxLength": 240
              },
              "timezone": {
                "type": "string",
                "minLength": 1,
                "maxLength": 120
              }
            },
            "required": [
              "cronExpression",
              "timezone"
            ],
            "additionalProperties": false
          }
        },
        "required": [
          "idempotencyKey",
          "action"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "scenario": {
    "order": 29,
    "descriptor": {
      "operationId": "manage_routine",
      "version": 1,
      "title": "Manage Routine",
      "description": "Manage Routine through the Capability routines capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "required": [],
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
      "optionalGroup": "routines",
      "requiredClaims": [
        "routines:write"
      ],
      "taskModes": [
        "standard",
        "skill_test"
      ],
      "sideEffectClass": "admin",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "mock_extension",
        "extension": "routines.manage"
      }
    }
  }
} as const;
