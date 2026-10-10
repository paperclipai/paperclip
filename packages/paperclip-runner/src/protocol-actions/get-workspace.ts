/** Canonical task workspace operation. */
export const getWorkspaceAction = {
  "id": "get_workspace",
  "canonical": {
    "operationId": "get_workspace",
    "surfaces": [
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "workspace_runtime",
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
    "prpEvidence": "Authenticated task workspace routes and durable selection/repository receipts.",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Inspect task workspace",
    "description": "Inspect current task files, repositories, pending selection, binding revision, and preparation capabilities. AGENT_HOME is personal instructions and memory; task outputs belong in the workspace.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "get_workspace",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "get_workspace",
      "result": {}
    }
  },
  "live": {
    "order": 80,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "get_workspace",
      "version": 1,
      "title": "Inspect task workspace",
      "description": "Inspect current task files, repositories, pending selection, binding revision, and preparation capabilities. AGENT_HOME is personal instructions and memory; task outputs belong in the workspace.",
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
