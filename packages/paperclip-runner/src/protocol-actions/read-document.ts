/** Canonical definition and documentation for `read_document`. */
export const readDocumentAction = {
  "id": "read_document",
  "canonical": {
    "operationId": "read_document",
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
    "realServiceBinding": "unbound",
    "prpEvidence": "read projection surfaced via a tool-result item event; no control-plane state diff",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Read task document",
    "description": "Read the current revision of one active-task document.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "read_document",
      "input": {
        "key": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "read_document",
      "result": {}
    }
  },
  "live": {
    "order": 3,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "read_document",
      "version": 1,
      "title": "Read task document",
      "description": "Read the current revision of one active-task document.",
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
        "properties": {
          "key": {
            "type": "string",
            "description": "Stable issue-document key.",
            "minLength": 1,
            "maxLength": 120
          }
        },
        "required": [
          "key"
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
    "order": 3,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "read_document",
      "operationResultId": "example-result",
      "value": {},
      "commandResult": null,
      "authorization": {}
    },
    "descriptor": {
      "operationId": "read_document",
      "version": 1,
      "title": "Read task document",
      "description": "Read one document on the active task by stable key.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1
          }
        },
        "required": [
          "key"
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
        "kind": "snapshot_read",
        "projection": "active_task_document"
      }
    }
  }
} as const;
