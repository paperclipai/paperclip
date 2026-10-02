/** Canonical project discovery definition. */
export const listProjectsAction = {
  "id": "list_projects",
  "canonical": {
    "operationId": "list_projects",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "discovery",
    "requiredClaims": [
      "discovery:projects:read"
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
    "prpEvidence": "Authenticated project tools, persisted projects and repository workspaces, and run-bound activity.",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "List projects",
    "description": "Inspect available company projects before selecting a project for new work.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "list_projects",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "list_projects",
      "result": {}
    }
  },
  "live": {
    "order": 45,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "list_projects",
      "version": 1,
      "title": "List projects",
      "description": "Inspect available company projects before selecting a project for new work.",
      "effect": "read",
      "requiredClaims": [
        "discovery:projects:read"
      ],
      "allowedModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {},
        "required": [],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "additionalProperties": true
      },
      "exposure": "optional"
    }
  },
  "scenario": {
    "order": 16,
    "descriptor": {
      "operationId": "list_projects",
      "version": 1,
      "title": "List Projects",
      "description": "List Projects through the Capability discovery capability set.",
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
            "const": "list_projects"
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
        "discovery:projects:read"
      ],
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
        "kind": "mock_extension",
        "extension": "discovery.projects"
      }
    }
  }
} as const;
