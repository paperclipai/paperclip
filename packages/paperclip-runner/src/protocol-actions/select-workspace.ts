/** Canonical task workspace operation. */
export const selectWorkspaceAction = {
  "id": "select_workspace",
  "canonical": {
    "operationId": "select_workspace",
    "surfaces": [
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "workspace_runtime",
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "PaperclipRunnerToolAuthority",
    "prpEvidence": "Authenticated task workspace routes and durable selection/repository receipts.",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Select task workspace",
    "description": "Request a different task workspace at the next normal admission. Does not interrupt or wake the current run. Inspect the binding revision first and reuse requestKey on retries; existing files stay in their current folder.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "select_workspace",
      "input": { "selection": { "kind": "task_directory" }, "expectedBindingRevision": 0, "requestKey": "example" }
    },
    "success": {
      "ok": true,
      "operationId": "select_workspace",
      "result": {}
    }
  },
  "live": {
    "order": 82,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "select_workspace",
      "version": 1,
      "title": "Select task workspace",
      "description": "Request a different task workspace at the next normal admission. Does not interrupt or wake the current run. Inspect the binding revision first and reuse requestKey on retries; existing files stay in their current folder.",
      "effect": "write",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "selection": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "task_directory"
                  }
                },
                "required": [
                  "kind"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "existing"
                  },
                  "workspaceId": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Existing authorized workspace ID."
                  }
                },
                "required": [
                  "kind",
                  "workspaceId"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "configured_source"
                  },
                  "projectWorkspaceId": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Configured source workspace ID."
                  },
                  "mode": {
                    "enum": [
                      "shared",
                      "managed_isolated"
                    ]
                  }
                },
                "required": [
                  "kind",
                  "projectWorkspaceId",
                  "mode"
                ],
                "additionalProperties": false
              }
            ]
          },
          "expectedBindingRevision": {
            "type": "integer",
            "minimum": 0
          },
          "requestKey": {
            "type": "string",
            "minLength": 1,
            "description": "Stable retry key."
          }
        },
        "required": [
          "selection",
          "expectedBindingRevision",
          "requestKey"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "additionalProperties": true
      },
      "exposure": "optional"
    }
  },
  "scenario": null
} as const;
