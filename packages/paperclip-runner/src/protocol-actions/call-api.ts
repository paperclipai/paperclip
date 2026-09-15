/** Canonical production API fallback contract. */
export const callApiAction = {
  "id": "call_api",
  "canonical": {
    "operationId": "call_api",
    "surfaces": [
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "discovery",
    "requiredClaims": [
      "api:call"
    ],
    "taskModes": [
      "standard",
      "ask",
      "planning",
      "skill_test"
    ],
    "sideEffectClass": "company_write",
    "idempotency": "none",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "PaperclipRunnerToolAuthority",
    "prpEvidence": "Authenticated PRP tool input/result and existing HTTP route authorization/activity records.",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Call the Paperclip API",
    "description": "Fallback only: call a discovered Paperclip API operation when dedicated tools lack the required operation or parameters. Uses your existing permissions. Prefer dedicated tools; never bypass a denial or runner lifecycle tool.",
    "note": "Production HTTP fallback; does not grant privileges or replace dedicated tools."
  },
  "examples": {
    "call": {
      "operationId": "call_api",
      "input": {
        "operationId": "GET /api/companies/{companyId}/projects"
      }
    },
    "success": {
      "ok": true,
      "operationId": "call_api",
      "result": {}
    }
  },
  "live": {
    "order": 41,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "call_api",
      "version": 1,
      "title": "Call the Paperclip API",
      "description": "Fallback only: call a discovered Paperclip API operation when dedicated tools lack the required operation or parameters. Uses your existing permissions. Prefer dedicated tools; never bypass a denial or runner lifecycle tool.",
      "exposure": "optional",
      "requiredClaims": [
        "api:call"
      ],
      "allowedModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "operationId": {
            "description": "Exact operationId returned by search_api, for example GET /api/projects/{id}. Do not guess identifiers.",
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "pathParams": {
            "type": "object",
            "additionalProperties": {
              "type": "string"
            }
          },
          "query": {
            "type": "object",
            "additionalProperties": true
          },
          "body": {
            "description": "Request value matching the discovered schema. For JSON object or array requests, pass the object or array directly, never a JSON-encoded string. Strings are for text bodies or endpoints whose schema explicitly accepts a string.",
            "anyOf": [
              { "type": "object", "additionalProperties": true },
              { "type": "array", "items": {} },
              { "type": "string" },
              { "type": "number" },
              { "type": "boolean" },
              { "type": "null" }
            ]
          },
          "contentType": {
            "type": "string",
            "maxLength": 120
          },
          "files": {
            "type": "array",
            "maxItems": 10,
            "items": {
              "type": "object",
              "properties": {
                "field": {
                  "type": "string"
                },
                "artifactId": {
                  "type": "string"
                },
                "path": {
                  "type": "string",
                  "description": "File relative to the active issue workspace. Remote files must first be uploaded as an artifact."
                }
              },
              "additionalProperties": false,
              "oneOf": [
                {
                  "properties": { "artifactId": {} },
                  "required": [
                    "artifactId"
                  ]
                },
                {
                  "properties": { "path": {} },
                  "required": [
                    "path"
                  ]
                }
              ]
            }
          }
        },
        "required": [
          "operationId"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "scenario": null
} as const;
