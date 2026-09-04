/** Canonical definition and documentation for `schedule_wake`. */
export const scheduleWakeAction = {
  "id": "schedule_wake",
  "canonical": {
    "operationId": "schedule_wake",
    "surfaces": [
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": null,
    "requiredClaims": [
      "control_plane:wakes"
    ],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "task_write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "unbound",
    "prpEvidence": "semantic-operation item event plus active-task state diff, work-assessment, and issue-status-decision events",
    "prpBindingStatus": "audit_pending",
    "legacyAliases": [],
    "note": "Bounded, deterministic mock wake scheduling; requires the control_plane:wakes claim. Live-only continuation primitive."
  },
  "documentation": {
    "title": "Schedule bounded wake",
    "description": "Schedule a deterministic mock continuation wake.",
    "note": "Bounded, deterministic mock wake scheduling; requires the control_plane:wakes claim. Live-only continuation primitive."
  },
  "examples": {
    "call": {
      "operationId": "schedule_wake",
      "input": {
        "idempotencyKey": "example",
        "reason": "manual",
        "delayTicks": 1
      }
    },
    "success": {
      "ok": true,
      "operationId": "schedule_wake",
      "result": {
        "commandId": "example",
        "disposition": "applied",
        "stateRevision": 1,
        "entityRefs": [
          "example"
        ],
        "scheduledWakeIds": [
          "example"
        ]
      }
    }
  },
  "live": {
    "order": 26,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "schedule_wake",
      "version": 1,
      "title": "Schedule bounded wake",
      "description": "Schedule a deterministic mock continuation wake.",
      "exposure": "optional",
      "requiredClaims": [
        "control_plane:wakes"
      ],
      "allowedModes": [
        "standard",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "idempotencyKey": {
            "type": "string",
            "description": "Caller-stable retry key.",
            "minLength": 1,
            "maxLength": 240
          },
          "reason": {
            "enum": [
              "manual",
              "issue_commented",
              "interaction_resolved",
              "approval_resolved",
              "blockers_resolved",
              "scheduled_retry",
              "resume"
            ]
          },
          "payload": {
            "type": "object",
            "additionalProperties": true
          },
          "delayTicks": {
            "type": "integer",
            "minimum": 1,
            "maximum": 10000
          }
        },
        "required": [
          "idempotencyKey",
          "reason",
          "delayTicks"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "commandId": {
            "type": "string",
            "description": "Stable mock command identifier.",
            "minLength": 1,
            "maxLength": 200
          },
          "disposition": {
            "enum": [
              "applied",
              "duplicate"
            ]
          },
          "stateRevision": {
            "type": "integer",
            "minimum": 0
          },
          "entityRefs": {
            "type": "array",
            "description": "Mock entities affected by the operation.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          },
          "scheduledWakeIds": {
            "type": "array",
            "description": "Wake identifiers scheduled by the operation.",
            "items": {
              "type": "string",
              "minLength": 1
            },
            "maxItems": 200,
            "uniqueItems": true
          }
        },
        "required": [
          "commandId",
          "disposition",
          "stateRevision",
          "entityRefs",
          "scheduledWakeIds"
        ],
        "additionalProperties": false
      }
    }
  },
  "scenario": null
} as const;
