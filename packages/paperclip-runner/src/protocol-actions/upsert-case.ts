/** Canonical definition and documentation for `upsert_case`. */
export const upsertCaseAction = {
  "id": "upsert_case",
  "canonical": {
    "operationId": "upsert_case",
    "surfaces": [
      "scenario"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "cases",
    "requiredClaims": [
      "cases:write"
    ],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "company_write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "scenario_mock",
    "realServiceBinding": "unbound",
    "prpEvidence": "semantic-operation item event plus company-entity state diff and audit record",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": [],
    "note": "Scenario/eval-only mock extension."
  },
  "documentation": {
    "title": "Upsert Case",
    "description": "Upsert Case through the Capability cases capability set.",
    "note": "Scenario/eval-only mock extension."
  },
  "examples": {
    "call": {
      "operationId": "upsert_case",
      "input": {
        "key": "example",
        "body": "example"
      }
    },
    "scenarioCall": {
      "operationId": "upsert_case",
      "idempotencyKey": "example",
      "input": {
        "key": "example",
        "body": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "upsert_case",
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
    "order": 25,
    "descriptor": {
      "operationId": "upsert_case",
      "version": 1,
      "title": "Upsert Case",
      "description": "Upsert Case through the Capability cases capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1
          },
          "body": {
            "type": "string"
          }
        },
        "required": [
          "key",
          "body"
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
      "optionalGroup": "cases",
      "requiredClaims": [
        "cases:write"
      ],
      "taskModes": [
        "standard",
        "skill_test"
      ],
      "sideEffectClass": "company_write",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "mock_extension",
        "extension": "cases.upsert"
      }
    }
  }
} as const;
