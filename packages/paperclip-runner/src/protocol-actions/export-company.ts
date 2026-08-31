/** Canonical definition and documentation for `export_company`. */
export const exportCompanyAction = {
  "id": "export_company",
  "canonical": {
    "operationId": "export_company",
    "surfaces": [
      "scenario"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "portability_admin",
    "requiredClaims": [
      "portability:export"
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
    "title": "Export Company",
    "description": "Export Company through the Capability portability admin capability set.",
    "note": "Scenario/eval-only mock extension."
  },
  "examples": {
    "call": {
      "operationId": "export_company",
      "input": {}
    },
    "scenarioCall": {
      "operationId": "export_company",
      "idempotencyKey": "example",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "export_company",
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
    "order": 34,
    "descriptor": {
      "operationId": "export_company",
      "version": 1,
      "title": "Export Company",
      "description": "Export Company through the Capability portability admin capability set.",
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
      "optionalGroup": "portability_admin",
      "requiredClaims": [
        "portability:export"
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
        "extension": "portability.export"
      }
    }
  }
} as const;
