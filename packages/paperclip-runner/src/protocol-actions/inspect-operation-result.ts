/** Canonical definition and documentation for `inspect_operation_result`. */
export const inspectOperationResultAction = {
  "id": "inspect_operation_result",
  "canonical": {
    "operationId": "inspect_operation_result",
    "surfaces": [
      "scenario"
    ],
    "placement": "always_agent_tool",
    "optionalGroup": null,
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "ask",
      "planning",
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
    "note": "Scenario/eval-only re-read of a prior operation result; the live dispatcher returns results inline."
  },
  "documentation": {
    "title": "Inspect operation result",
    "description": "Read a prior semantic operation result from this run.",
    "note": "Scenario/eval-only re-read of a prior operation result; the live dispatcher returns results inline."
  },
  "examples": {
    "call": {
      "operationId": "inspect_operation_result",
      "input": {
        "operationResultId": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "inspect_operation_result",
      "result": {
        "schema": "paperclip.capability.tool-result.v1",
        "ok": true,
        "operationId": "inspect_operation_result",
        "operationResultId": "example",
        "value": "example",
        "commandResult": "example",
        "authorization": "example"
      }
    }
  },
  "live": null,
  "scenario": {
    "order": 13,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "inspect_operation_result",
      "operationResultId": "example",
      "value": "example",
      "commandResult": "example",
      "authorization": "example"
    },
    "descriptor": {
      "operationId": "inspect_operation_result",
      "version": 1,
      "title": "Inspect operation result",
      "description": "Read a prior semantic operation result from this run.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "operationResultId": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "operationResultId"
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
            "const": "inspect_operation_result"
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
      "disposition": "always_agent_tool",
      "optionalGroup": null,
      "requiredClaims": [],
      "taskModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "sideEffectClass": "read",
      "idempotency": "none",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "operation_result"
      }
    }
  }
} as const;
