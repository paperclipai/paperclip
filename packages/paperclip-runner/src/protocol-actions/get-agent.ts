/** Canonical definition and documentation for `get_agent`. */
export const getAgentAction = {
  "id": "get_agent",
  "canonical": {
    "operationId": "get_agent",
    "surfaces": [
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": null,
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
      "mcp:paperclipGetAgent"
    ],
    "note": "Live-only single-actor read; the scenario suite covers actor discovery through list_agents."
  },
  "documentation": {
    "title": "Get company agent",
    "description": "Read one redacted mock actor profile.",
    "note": "Live-only single-actor read; the scenario suite covers actor discovery through list_agents."
  },
  "examples": {
    "call": {
      "operationId": "get_agent",
      "input": {
        "actorId": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "get_agent",
      "result": {}
    }
  },
  "live": {
    "order": 14,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "get_agent",
      "version": 1,
      "title": "Get company agent",
      "description": "Read one redacted mock actor profile.",
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
        "properties": {
          "actorId": {
            "type": "string",
            "description": "Mock actor id.",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "required": [
          "actorId"
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
