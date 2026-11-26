/** Canonical project tool definition. */
export const listProjectRepositoriesAction = {
  "id": "list_project_repositories",
  "canonical": {
    "operationId": "list_project_repositories",
    "surfaces": [
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "discovery",
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
    "realBindingStatus": "live_codex",
    "realServiceBinding": "PaperclipRunnerToolAuthority",
    "prpEvidence": "Authenticated project tools, persisted projects and repository workspaces, and run-bound activity.",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "List available repositories",
    "description": "List authorized repositories with stable IDs and names. Consider appropriate repositories before creating a project; never invent IDs.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "list_project_repositories",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "list_project_repositories",
      "result": {}
    }
  },
  "live": {
    "order": 44,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "list_project_repositories",
      "version": 1,
      "title": "List available repositories",
      "description": "List authorized repositories with stable IDs and names. Consider appropriate repositories before creating a project; never invent IDs.",
      "effect": "read",
      "requiredClaims": [],
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
  "scenario": null
} as const;
