/** Canonical definition and documentation for `sync_company_skills`. */
export const syncCompanySkillsAction = {
  "id": "sync_company_skills",
  "canonical": {
    "operationId": "sync_company_skills",
    "surfaces": [
      "scenario"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "company_skills",
    "requiredClaims": [
      "company_skills:write"
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
    "title": "Sync Company Skills",
    "description": "Sync Company Skills through the Capability company skills capability set.",
    "note": "Scenario/eval-only mock extension."
  },
  "examples": {
    "call": {
      "operationId": "sync_company_skills",
      "input": {}
    },
    "scenarioCall": {
      "operationId": "sync_company_skills",
      "idempotencyKey": "example",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "sync_company_skills",
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
    "order": 31,
    "descriptor": {
      "operationId": "sync_company_skills",
      "version": 1,
      "title": "Sync Company Skills",
      "description": "Sync Company Skills through the Capability company skills capability set.",
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
      "optionalGroup": "company_skills",
      "requiredClaims": [
        "company_skills:write"
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
        "extension": "company_skills.sync"
      }
    }
  }
} as const;
