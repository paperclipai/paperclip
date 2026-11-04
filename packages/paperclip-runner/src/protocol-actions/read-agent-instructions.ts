/** Canonical definition for `read_agent_instructions`. */
export const readAgentInstructionsAction = {
  "id": "read_agent_instructions",
  "canonical": {
    "operationId": "read_agent_instructions",
    "surfaces": [
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
    "realServiceBinding": "agentInstructionRevisionService",
    "prpEvidence": "tool-result item event plus canonical revision receipt for writes; no scenario mock coverage",
    "prpBindingStatus": "bound",
    "legacyAliases": [],
    "note": "Live canonical instruction service; company scope and current responsible-user authorization are checked at invocation."
  },
  "documentation": {
    "title": "Read canonical agent instructions",
    "description": "Read the current canonical instruction entry and its revision, or inspect a historical revision by supplying both entryFile and revisionId. Read before updating; do not edit shared instruction caches.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "read_agent_instructions",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "read_agent_instructions",
      "result": {}
    }
  },
  "live": {
    "order": 40,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "read_agent_instructions",
      "version": 1,
      "title": "Read canonical agent instructions",
      "description": "Read the current canonical instruction entry and its revision, or inspect a historical revision by supplying both entryFile and revisionId. Read before updating; do not edit shared instruction caches.",
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
          "targetAgentId": {
            "type": "string",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            "description": "Same-company target agent. Omit to use the calling agent."
          },
          "entryFile": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096,
            "description": "Configured relative entry filename returned by read_agent_instructions; retain it with the revision."
          },
          "revisionId": {
            "type": "string",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            "description": "Historical revision to inspect; also provide its entryFile."
          }
        },
        "required": [],
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
