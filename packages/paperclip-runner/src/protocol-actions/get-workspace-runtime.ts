/** Canonical definition and documentation for `get_workspace_runtime`. */
export const getWorkspaceRuntimeAction = {
  "id": "get_workspace_runtime",
  "canonical": {
    "operationId": "get_workspace_runtime",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "workspace_runtime",
    "requiredClaims": [
      "workspace:read"
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
    "realServiceBinding": "unbound",
    "prpEvidence": "read projection surfaced via a tool-result item event; no control-plane state diff",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Get workspace runtime",
    "description": "Read active-task mock workspace services.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "get_workspace_runtime",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "get_workspace_runtime",
      "result": {}
    }
  },
  "live": {
    "order": 19,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "get_workspace_runtime",
      "version": 1,
      "title": "Get workspace runtime",
      "description": "Read active-task mock workspace services.",
      "exposure": "optional",
      "requiredClaims": [
        "workspace:read"
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
      }
    }
  },
  "scenario": {
    "order": 26,
    "descriptor": {
      "operationId": "get_workspace_runtime",
      "version": 1,
      "title": "Get Workspace Runtime",
      "description": "Get Workspace Runtime through the Capability workspace runtime capability set.",
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
      "optionalGroup": "workspace_runtime",
      "requiredClaims": [
        "workspace:read"
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
        "kind": "snapshot_read",
        "projection": "active_task_workspace"
      }
    }
  }
} as const;
