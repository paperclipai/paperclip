/** Canonical definition for `restore_agent_instructions`. */
export const restoreAgentInstructionsAction = {
  "id": "restore_agent_instructions",
  "canonical": {
    "operationId": "restore_agent_instructions",
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
    "title": "Restore canonical agent instructions",
    "description": "Append a historical instruction revision as the current content using the current baseRevisionId. Requires the responsible user\u2019s current target edit permission. History remains intact; conflicts require an explicit resolution.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "restore_agent_instructions",
      "input": {
        "entryFile": "AGENTS.md",
        "revisionId": "00000000-0000-4000-8000-000000000001",
        "baseRevisionId": "00000000-0000-4000-8000-000000000002"
      }
    },
    "success": {
      "ok": true,
      "operationId": "restore_agent_instructions",
      "result": {}
    }
  },
  "live": {
    "order": 43,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "restore_agent_instructions",
      "version": 1,
      "title": "Restore canonical agent instructions",
      "description": "Append a historical instruction revision as the current content using the current baseRevisionId. Requires the responsible user\u2019s current target edit permission. History remains intact; conflicts require an explicit resolution.",
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
          "revisionId": {
            "type": "string",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            "description": "Historical revision whose exact content should be restored."
          },
          "baseRevisionId": {
            "type": "string",
            "description": "Current revision read before restoring. Never replace a stale base silently.",
            "pattern": "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
          }
        },
        "required": [
          "entryFile",
          "revisionId",
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
