/** Canonical definition and documentation for `manage_routine`. */
export const manageRoutineAction = {
  "id": "manage_routine",
  "canonical": {
    "operationId": "manage_routine",
    "surfaces": [
      "scenario"
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
    "realBindingStatus": "scenario_mock",
    "realServiceBinding": "unbound",
    "prpEvidence": "company admin/portability item event plus audit record",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": [],
    "note": "Scenario/eval-only mock extension."
  },
  "documentation": {
    "title": "Manage Routine",
    "description": "Manage Routine through the Capability routines capability set.",
    "note": "Scenario/eval-only mock extension."
  },
  "examples": {
    "call": {
      "operationId": "manage_routine",
      "input": {}
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
  "live": null,
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
