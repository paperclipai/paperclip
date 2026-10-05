export const listProjectsInputSchema = {
  type: "object",
  properties: {
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Page size (default 50)." },
    cursor: { type: "string", pattern: "^(0|[1-9][0-9]{0,14})$", description: "The nextCursor returned by the previous page." },
  },
  required: [],
  additionalProperties: false,
} as const;

export const listProjectsDescription = "List company project summaries (IDs, names, status, and up to 1,000 characters of description). Returns up to 50 projects and nextCursor; continue with cursor until it is null, even if a page is empty after permission filtering. Read a project's API resource for full details.";

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
    "description": listProjectsDescription,
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
      "description": listProjectsDescription,
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
      "inputSchema": listProjectsInputSchema,
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
      "description": listProjectsDescription,
      "inputSchema": listProjectsInputSchema,
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
