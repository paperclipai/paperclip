/** Canonical production API fallback contract. */
export const searchApiAction = {
  "id": "search_api",
  "canonical": {
    "operationId": "search_api",
    "surfaces": [
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "discovery",
    "requiredClaims": [
      "api:discover"
    ],
    "taskModes": [
      "standard",
      "ask",
      "planning",
      "skill_test"
    ],
    "sideEffectClass": "read",
    "idempotency": "none",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "PaperclipRunnerToolAuthority",
    "prpEvidence": "Authenticated PRP tool input/result and existing HTTP route authorization/activity records.",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Search the Paperclip API",
    "description": "Fallback only: discover Paperclip API operations when the available dedicated tools cannot express the task. Prefer dedicated tools for common operations; do not search before using them.",
    "note": "Production HTTP fallback; does not grant privileges or replace dedicated tools."
  },
  "examples": {
    "call": {
      "operationId": "search_api",
      "input": {
        "query": "create project"
      }
    },
    "success": {
      "ok": true,
      "operationId": "search_api",
      "result": {}
    }
  },
  "live": {
    "order": 40,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "search_api",
      "version": 1,
      "title": "Search the Paperclip API",
      "description": "Fallback only: discover Paperclip API operations when the available dedicated tools cannot express the task. Prefer dedicated tools for common operations; do not search before using them.",
      "exposure": "optional",
      "requiredClaims": [
        "api:discover"
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
          "query": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 10,
            "default": 5
          },
          "cursor": {
            "type": "string",
            "maxLength": 200
          }
        },
        "required": [
          "query"
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
