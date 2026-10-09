/** Canonical task workspace operation. */
export const prepareRepositoryAction = {
  "id": "prepare_repository",
  "canonical": {
    "operationId": "prepare_repository",
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
    "title": "Prepare task repository",
    "description": "Request an authorized repository inside task files at the next normal admission, without creating a project. Discover repository IDs first. Does not interrupt or wake the current run. Reuse requestKey; a conflicting ref never resets existing work.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "prepare_repository",
      "input": { "repository": { "kind": "catalog", "id": "123" }, "requestKey": "example" }
    },
    "success": {
      "ok": true,
      "operationId": "prepare_repository",
      "result": {}
    }
  },
  "live": {
    "order": 83,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "prepare_repository",
      "version": 1,
      "title": "Prepare task repository",
      "description": "Request an authorized repository inside task files at the next normal admission, without creating a project. Discover repository IDs first. Does not interrupt or wake the current run. Reuse requestKey; a conflicting ref never resets existing work.",
      "effect": "write",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "repository": {
            "oneOf": [
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "catalog"
                  },
                  "id": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Authorized ID from list_project_repositories."
                  }
                },
                "required": [
                  "kind",
                  "id"
                ],
                "additionalProperties": false
              },
              {
                "type": "object",
                "properties": {
                  "kind": {
                    "const": "url"
                  },
                  "url": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Existing HTTPS GitHub repository URL; uncataloged URLs use public anonymous access only."
                  }
                },
                "required": [
                  "kind",
                  "url"
                ],
                "additionalProperties": false
              }
            ]
          },
          "ref": {
            "type": "string",
            "minLength": 1,
            "description": "Optional Git branch, tag, or commit. Default HEAD is pinned once."
          },
          "requestKey": {
            "type": "string",
            "minLength": 1,
            "description": "Stable retry key."
          }
        },
        "required": [
          "repository",
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
