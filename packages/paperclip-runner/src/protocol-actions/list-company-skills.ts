/** Canonical definition and documentation for `list_company_skills`. */
export const listCompanySkillsAction = {
  "id": "list_company_skills",
  "canonical": {
    "operationId": "list_company_skills",
    "surfaces": [
      "scenario"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "company_skills",
    "requiredClaims": [
      "company_skills:read"
    ],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "read",
    "idempotency": "none",
    "disabledByDefault": false,
    "realBindingStatus": "scenario_mock",
    "realServiceBinding": "unbound",
    "prpEvidence": "read projection surfaced via a tool-result item event; no control-plane state diff",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": [],
    "note": "Scenario/eval-only mock extension."
  },
  "documentation": {
    "title": "List Company Skills",
    "description": "List Company Skills through the Capability company skills capability set.",
    "note": "Scenario/eval-only mock extension."
  },
  "examples": {
    "call": {
      "operationId": "list_company_skills",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "list_company_skills",
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
    "order": 30,
    "descriptor": {
      "operationId": "list_company_skills",
      "version": 1,
      "title": "List Company Skills",
      "description": "List Company Skills through the Capability company skills capability set.",
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
        "company_skills:read"
      ],
      "taskModes": [
        "standard",
        "skill_test"
      ],
      "sideEffectClass": "read",
      "idempotency": "none",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "mock_extension",
        "extension": "company_skills.list"
      }
    }
  }
} as const;
