/** Canonical definition and documentation for `list_secret_metadata`. */
export const listSecretMetadataAction = {
  "id": "list_secret_metadata",
  "canonical": {
    "operationId": "list_secret_metadata",
    "surfaces": [
      "scenario"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "secrets",
    "requiredClaims": [
      "secrets:metadata:read"
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
    "note": "Scenario/eval-only mock extension; metadata only."
  },
  "documentation": {
    "title": "List Secret Metadata",
    "description": "List Secret Metadata through the Capability secrets capability set.",
    "note": "Scenario/eval-only mock extension; metadata only."
  },
  "examples": {
    "call": {
      "operationId": "list_secret_metadata",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "list_secret_metadata",
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
    "order": 32,
    "descriptor": {
      "operationId": "list_secret_metadata",
      "version": 1,
      "title": "List Secret Metadata",
      "description": "List Secret Metadata through the Capability secrets capability set.",
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
      "optionalGroup": "secrets",
      "requiredClaims": [
        "secrets:metadata:read"
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
        "extension": "secrets.metadata"
      }
    }
  }
} as const;
