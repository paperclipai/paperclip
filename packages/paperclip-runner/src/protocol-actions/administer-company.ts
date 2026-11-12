/** Canonical definition and documentation for `administer_company`. */
export const administerCompanyAction = {
  "id": "administer_company",
  "canonical": {
    "operationId": "administer_company",
    "surfaces": [
      "scenario"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "portability_admin",
    "requiredClaims": [
      "company:admin"
    ],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "allowedRoles": [
      "board",
      "ceo",
      "admin"
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
    "title": "Administer Company",
    "description": "Administer Company through the Capability portability admin capability set.",
    "note": "Scenario/eval-only mock extension."
  },
  "examples": {
    "call": {
      "operationId": "administer_company",
      "input": {
        "action": "example"
      }
    },
    "scenarioCall": {
      "operationId": "administer_company",
      "idempotencyKey": "example",
      "input": {
        "action": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "administer_company",
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
    "order": 35,
    "descriptor": {
      "operationId": "administer_company",
      "version": 1,
      "title": "Administer Company",
      "description": "Administer Company through the Capability portability admin capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "minLength": 1
          },
          "payload": {}
        },
        "required": [
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
      "optionalGroup": "portability_admin",
      "requiredClaims": [
        "company:admin"
      ],
      "allowedRoles": [
        "board",
        "ceo",
        "admin"
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
        "extension": "company.admin"
      }
    }
  }
} as const;
