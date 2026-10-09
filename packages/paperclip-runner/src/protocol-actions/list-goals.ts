/** Canonical definition and documentation for `list_goals`. */
export const listGoalsAction = {
  "id": "list_goals",
  "canonical": {
    "operationId": "list_goals",
    "surfaces": [
      "scenario"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "discovery",
    "requiredClaims": [
      "discovery:goals:read"
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
    "note": "Scenario/eval-only discovery via mock extension; no live dispatcher binding yet."
  },
  "documentation": {
    "title": "List Goals",
    "description": "List Goals through the Capability discovery capability set.",
    "note": "Scenario/eval-only discovery via mock extension; no live dispatcher binding yet."
  },
  "examples": {
    "call": {
      "operationId": "list_goals",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "list_goals",
      "result": {
        "schema": "paperclip.capability.tool-result.v1",
        "ok": true,
        "operationId": "list_goals",
        "operationResultId": "example",
        "value": "example",
        "commandResult": "example",
        "authorization": "example"
      }
    }
  },
  "live": null,
  "scenario": {
    "order": 17,
    "descriptor": {
      "operationId": "list_goals",
      "version": 1,
      "title": "List Goals",
      "description": "List Goals through the Capability discovery capability set.",
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
            "const": "list_goals"
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
      "optionalGroup": "discovery",
      "requiredClaims": [
        "discovery:goals:read"
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
        "extension": "discovery.goals"
      }
    }
  }
} as const;
