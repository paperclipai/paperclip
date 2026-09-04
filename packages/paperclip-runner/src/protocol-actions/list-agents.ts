/** Canonical definition and documentation for `list_agents`. */
export const listAgentsAction = {
  "id": "list_agents",
  "canonical": {
    "operationId": "list_agents",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "discovery",
    "requiredClaims": [
      "discovery:agents:read"
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
    "legacyAliases": [
      "mcp:paperclipListAgents"
    ]
  },
  "documentation": {
    "title": "List company agents",
    "description": "List redacted mock actor profiles.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "list_agents",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "list_agents",
      "result": {}
    }
  },
  "live": {
    "order": 13,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "list_agents",
      "version": 1,
      "title": "List company agents",
      "description": "List redacted mock actor profiles.",
      "exposure": "optional",
      "requiredClaims": [
        "discovery:agents:read"
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
    "order": 15,
    "descriptor": {
      "operationId": "list_agents",
      "version": 1,
      "title": "List Agents",
      "description": "List Agents through the Capability discovery capability set.",
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
            "const": "list_agents"
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
        "discovery:agents:read"
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
        "projection": "company_actors"
      }
    }
  }
} as const;
