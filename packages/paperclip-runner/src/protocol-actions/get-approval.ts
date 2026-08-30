/** Canonical definition and documentation for `get_approval`. */
export const getApprovalAction = {
  "id": "get_approval",
  "canonical": {
    "operationId": "get_approval",
    "surfaces": [
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": null,
    "requiredClaims": [
      "governance:approvals:read"
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
    "legacyAliases": [],
    "note": "Live-only single-approval read; the scenario suite covers approvals through list_approvals."
  },
  "documentation": {
    "title": "Get approval",
    "description": "Read one mock approval without protected data.",
    "note": "Live-only single-approval read; the scenario suite covers approvals through list_approvals."
  },
  "examples": {
    "call": {
      "operationId": "get_approval",
      "input": {
        "approvalId": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "get_approval",
      "result": {}
    }
  },
  "live": {
    "order": 17,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "get_approval",
      "version": 1,
      "title": "Get approval",
      "description": "Read one mock approval without protected data.",
      "exposure": "optional",
      "requiredClaims": [
        "governance:approvals:read"
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
          "approvalId": {
            "type": "string",
            "description": "Mock approval id.",
            "minLength": 1,
            "maxLength": 200
          }
        },
        "required": [
          "approvalId"
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
