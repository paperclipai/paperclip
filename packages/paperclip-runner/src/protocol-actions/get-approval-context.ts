/** Canonical definition and documentation for `get_approval_context`. */
export const getApprovalContextAction = {
  "id": "get_approval_context",
  "canonical": {
    "operationId": "get_approval_context",
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
    "note": "Live-only approval-plus-linked-tasks read; no scenario counterpart."
  },
  "documentation": {
    "title": "Get approval context",
    "description": "Read one approval, its comments, and linked mock tasks.",
    "note": "Live-only approval-plus-linked-tasks read; no scenario counterpart."
  },
  "examples": {
    "call": {
      "operationId": "get_approval_context",
      "input": {
        "approvalId": "example"
      }
    },
    "success": {
      "ok": true,
      "operationId": "get_approval_context",
      "result": {}
    }
  },
  "live": {
    "order": 18,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "get_approval_context",
      "version": 1,
      "title": "Get approval context",
      "description": "Read one approval, its comments, and linked mock tasks.",
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
