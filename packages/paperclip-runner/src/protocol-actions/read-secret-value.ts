/** Canonical definition and documentation for `read_secret_value`. */
export const readSecretValueAction = {
  "id": "read_secret_value",
  "canonical": {
    "operationId": "read_secret_value",
    "surfaces": [
      "scenario"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "secrets",
    "requiredClaims": [
      "secrets:values:read"
    ],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "secret_read",
    "idempotency": "none",
    "disabledByDefault": false,
    "realBindingStatus": "scenario_mock",
    "realServiceBinding": "unbound",
    "prpEvidence": "redacted tool-result item event; secret value never reaches the wire",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": [],
    "note": "Scenario/eval-only mock extension; secret value redacted from every observable sink."
  },
  "documentation": {
    "title": "Read Secret Value",
    "description": "Read Secret Value through the Capability secrets capability set.",
    "note": "Scenario/eval-only mock extension; secret value redacted from every observable sink."
  },
  "examples": {
    "call": {
      "operationId": "read_secret_value",
      "input": {
        "name": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "read_secret_value",
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
    "order": 33,
    "descriptor": {
      "operationId": "read_secret_value",
      "version": 1,
      "title": "Read Secret Value",
      "description": "Read Secret Value through the Capability secrets capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "name"
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
      "optionalGroup": "secrets",
      "requiredClaims": [
        "secrets:values:read"
      ],
      "taskModes": [
        "standard",
        "skill_test"
      ],
      "sideEffectClass": "secret_read",
      "idempotency": "none",
      "redaction": [
        {
          "path": "$.value",
          "replacement": "[SECRET_VALUE]",
          "appliesTo": [
            "output",
            "error",
            "authorization_record"
          ]
        }
      ],
      "mockCommandMapping": {
        "kind": "mock_extension",
        "extension": "secrets.value"
      }
    }
  }
} as const;
