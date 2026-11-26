/** Canonical definition and documentation for `generic_api_request`. */
export const genericApiRequestAction = {
  "id": "generic_api_request",
  "canonical": {
    "operationId": "generic_api_request",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "test_escape_hatch",
    "requiredClaims": [
      "test:generic_api_request"
    ],
    "taskModes": [
      "skill_test"
    ],
    "sideEffectClass": "test_escape_hatch",
    "idempotency": "required",
    "disabledByDefault": true,
    "realBindingStatus": "test_only",
    "realServiceBinding": "unbound",
    "prpEvidence": "test-only; excluded from product PRP evidence",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": [],
    "note": "Test-only escape hatch; explicitly cannot count as product capability coverage. Single unified claim test:generic_api_request."
  },
  "documentation": {
    "title": "Generic API request",
    "description": "Test-only escape hatch. Disabled unless the scenario and explicit claim both enable it.",
    "note": "Test-only escape hatch; explicitly cannot count as product capability coverage. Single unified claim test:generic_api_request."
  },
  "examples": {
    "call": {
      "operationId": "generic_api_request",
      "input": {
        "method": "GET",
        "path": "/mock/example"
      }
    },
    "scenarioCall": {
      "operationId": "generic_api_request",
      "idempotencyKey": "example",
      "input": {
        "method": "GET",
        "path": "/mock/example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "generic_api_request",
      "result": {}
    }
  },
  "live": {
    "order": 27,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "generic_api_request",
      "version": 1,
      "title": "Generic API request",
      "description": "Test-only escape hatch. Disabled unless the scenario and explicit claim both enable it.",
      "exposure": "optional",
      "requiredClaims": [
        "test:generic_api_request"
      ],
      "allowedModes": [
        "skill_test"
      ],
      "disabledByDefault": true,
      "inputSchema": {
        "type": "object",
        "properties": {
          "method": {
            "enum": [
              "GET",
              "POST",
              "PATCH"
            ]
          },
          "path": {
            "type": "string",
            "pattern": "^/mock/",
            "maxLength": 500
          },
          "body": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "required": [
          "method",
          "path"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "scenario": {
    "order": 36,
    "descriptor": {
      "operationId": "generic_api_request",
      "version": 1,
      "title": "Generic Api Request",
      "description": "Generic Api Request through the Capability test escape hatch capability set.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "method": {
            "type": "string",
            "minLength": 1
          },
          "path": {
            "type": "string",
            "minLength": 1
          },
          "headers": {
            "type": "object",
            "additionalProperties": {
              "type": "string"
            }
          },
          "body": {}
        },
        "required": [
          "method",
          "path"
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
      "optionalGroup": "test_escape_hatch",
      "requiredClaims": [
        "test:generic_api_request"
      ],
      "taskModes": [
        "skill_test"
      ],
      "sideEffectClass": "test_escape_hatch",
      "idempotency": "required",
      "redaction": [
        {
          "path": "$.headers.authorization",
          "replacement": "[REDACTED]",
          "appliesTo": [
            "input",
            "output",
            "error",
            "authorization_record"
          ]
        },
        {
          "path": "$.headers.cookie",
          "replacement": "[REDACTED]",
          "appliesTo": [
            "input",
            "output",
            "error",
            "authorization_record"
          ]
        }
      ],
      "mockCommandMapping": {
        "kind": "mock_extension",
        "extension": "test.generic_api"
      }
    }
  }
} as const;
