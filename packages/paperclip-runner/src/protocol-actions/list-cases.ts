/** Canonical definition and documentation for `list_cases`. */
export const listCasesAction = {
  "id": "list_cases",
  "canonical": {
    "operationId": "list_cases",
    "surfaces": [
      "scenario"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "cases",
    "requiredClaims": [
      "cases:read"
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
    "title": "List Cases",
    "description": "List Cases through the Capability cases capability set.",
    "note": "Scenario/eval-only mock extension."
  },
  "examples": {
    "call": {
      "operationId": "list_cases",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "list_cases",
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
    "order": 24,
    "descriptor": {
      "operationId": "list_cases",
      "version": 1,
      "title": "List Cases",
      "description": "List Cases through the Capability cases capability set.",
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
      "optionalGroup": "cases",
      "requiredClaims": [
        "cases:read"
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
        "extension": "cases.list"
      }
    }
  }
} as const;
