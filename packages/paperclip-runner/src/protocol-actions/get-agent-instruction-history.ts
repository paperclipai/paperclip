/** Canonical definition for `get_agent_instruction_history`. */
export const getAgentInstructionHistoryAction = {
  "id": "get_agent_instruction_history",
  "canonical": {
    "operationId": "get_agent_instruction_history",
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
    "title": "Get agent instruction history",
    "description": "List bounded canonical instruction revision metadata, including actor, source run, and restore origin. Use read_agent_instructions with entryFile and revisionId to inspect exact historical content.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "get_agent_instruction_history",
      "input": {
        "entryFile": "AGENTS.md"
      }
    },
    "success": {
      "ok": true,
      "operationId": "get_agent_instruction_history",
      "result": {}
    }
  },
  "live": {
    "order": 42,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "get_agent_instruction_history",
      "version": 1,
      "title": "Get agent instruction history",
      "description": "List bounded canonical instruction revision metadata, including actor, source run, and restore origin. Use read_agent_instructions with entryFile and revisionId to inspect exact historical content.",
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
          "cursor": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2048
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          }
        },
        "required": [
          "entryFile"
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
