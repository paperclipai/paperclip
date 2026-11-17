/** Canonical definition for `update_agent_instructions`. */
export const updateAgentInstructionsAction = {
  "id": "update_agent_instructions",
  "canonical": {
    "operationId": "update_agent_instructions",
    "surfaces": [
      "live"
    ],
    "placement": "always_agent_tool",
    "optionalGroup": null,
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "planning"
    ],
    "sideEffectClass": "company_write",
    "idempotency": "recommended",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "agentInstructionRevisionService",
    "prpEvidence": "tool-result item event plus canonical revision receipt for writes; no scenario mock coverage",
    "prpBindingStatus": "bound",
    "legacyAliases": [],
    "note": "Live canonical instruction service; company scope and current responsible-user authorization are checked at invocation."
  },
  "documentation": {
    "title": "Update canonical agent instructions",
    "description": "Commit instruction content with the exact entryFile and baseRevisionId from a prior read. Requires the responsible user\u2019s current target edit permission. On conflict, preserve your candidate and explicitly resolve it; never overwrite the newer head.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "update_agent_instructions",
      "input": {
        "entryFile": "AGENTS.md",
        "content": "# Instructions\n",
        "baseRevisionId": null
      }
    },
    "success": {
      "ok": true,
      "operationId": "update_agent_instructions",
      "result": {}
    }
  },
  "live": {
    "order": 41,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "update_agent_instructions",
      "version": 1,
      "title": "Update canonical agent instructions",
      "description": "Commit instruction content with the exact entryFile and baseRevisionId from a prior read. Requires the responsible user\u2019s current target edit permission. On conflict, preserve your candidate and explicitly resolve it; never overwrite the newer head.",
      "exposure": "always",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "planning"
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
          "content": {
            "type": "string",
            "maxLength": 1048576,
            "description": "Complete UTF-8 instruction content, at most 1 MiB; empty content is valid."
          },
          "baseRevisionId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Revision read before editing; null only when no canonical entry exists. Never replace a stale base silently.",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
          }
        },
        "required": [
          "entryFile",
          "content",
          "baseRevisionId"
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
