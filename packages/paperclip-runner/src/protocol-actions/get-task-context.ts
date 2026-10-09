/** Canonical definition and documentation for `get_task_context`. */
export const getTaskContextAction = {
  "id": "get_task_context",
  "canonical": {
    "operationId": "get_task_context",
    "surfaces": [
      "scenario",
      "live"
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
    "realBindingStatus": "live_codex",
    "realServiceBinding": "PaperclipRunnerToolAuthority active issue/run + accepted plan revision",
    "prpEvidence": "bound company/assignment query plus exact accepted document revision projection",
    "prpBindingStatus": "bound",
    "legacyAliases": [
      "mcp:paperclipMe"
    ]
  },
  "documentation": {
    "title": "Get active task context",
    "description": "Read the active task and actor, including the exact approved Markdown revision when this issue has an accepted plan.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "get_task_context",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "get_task_context",
      "result": {}
    }
  },
  "live": {
    "order": 0,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "get_task_context",
      "version": 1,
      "title": "Get active task context",
      "description": "Read the active task and actor, including the exact approved Markdown revision when this issue has an accepted plan.",
      "exposure": "always",
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
      }
    }
  },
  "scenario": {
    "order": 0,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "get_task_context",
      "operationResultId": "example-result",
      "value": {},
      "commandResult": null,
      "authorization": {}
    },
    "descriptor": {
      "operationId": "get_task_context",
      "version": 1,
      "title": "Get task context",
      "description": "Read the active task, ancestors, wake context, linked results, and budget summary.",
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
        "kind": "context_read",
        "projection": "active_task"
      }
    }
  }
} as const;
