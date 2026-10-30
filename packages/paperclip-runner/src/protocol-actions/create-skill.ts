/** Canonical definition and documentation for `create_skill`. */
export const createSkillAction = {
  "id": "create_skill",
  "canonical": {
    "operationId": "create_skill",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "company_skills",
    "requiredClaims": [],
    "taskModes": [
      "standard",
      "skill_test"
    ],
    "sideEffectClass": "company_write",
    "idempotency": "required",
    "disabledByDefault": false,
    "realBindingStatus": "live_codex",
    "realServiceBinding": "PaperclipRunnerToolAuthority",
    "prpEvidence": "Authenticated company skill API, saved skill and initial version, and task-bound creation activity.",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "Create skill",
    "description": "Create a reusable single-file skill in the company library. Supply a complete SKILL.md whose name and description match the inputs. This saves the skill and shows a card; it does not assign the skill to any agent. Reuse idempotencyKey on retries.",
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "create_skill",
      "input": {
        "idempotencyKey": "example",
        "name": "release-review",
        "description": "Review release notes.",
        "markdown": "---\nname: release-review\ndescription: Review release notes.\n---\n\n# Review\nCheck each note against the change.\n"
      }
    },
    "scenarioCall": {
      "operationId": "create_skill",
      "idempotencyKey": "example",
      "input": {
        "name": "release-review",
        "description": "Review release notes.",
        "markdown": "---\nname: release-review\ndescription: Review release notes.\n---\n\n# Review\nCheck each note against the change.\n"
      }
    },
    "success": {
      "ok": true,
      "operationId": "create_skill",
      "result": {
        "id": "skill-example",
        "name": "release-review",
        "slug": "release-review",
        "description": "Review release notes.",
        "versionId": "version-example",
        "studioPath": "/skills/studio/skill-example"
      }
    }
  },
  "live": {
    "order": 46,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "create_skill",
      "version": 1,
      "title": "Create skill",
      "description": "Create a reusable single-file skill in the company library. Supply a complete SKILL.md whose name and description match the inputs. This saves the skill and shows a card; it does not assign the skill to any agent. Reuse idempotencyKey on retries.",
      "exposure": "optional",
      "requiredClaims": [],
      "allowedModes": [
        "standard",
        "skill_test"
      ],
      "inputSchema": {
        "type": "object",
        "properties": {
          "idempotencyKey": {
            "type": "string",
            "minLength": 1,
            "maxLength": 240
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120,
            "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            "description": "Lowercase skill name, matching SKILL.md frontmatter."
          },
          "slug": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120,
            "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            "description": "Optional; must equal name."
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          },
          "markdown": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200000,
            "description": "Complete SKILL.md including name and description frontmatter and substantive instructions."
          }
        },
        "required": [
          "idempotencyKey",
          "name",
          "description",
          "markdown"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "scenario": {
    "order": 46,
    "successExample": {
      "schema": "paperclip.capability.tool-result.v1",
      "ok": true,
      "operationId": "create_skill",
      "operationResultId": "example-result",
      "value": {
        "commandId": "example",
        "disposition": "applied",
        "stateRevision": 1,
        "entityRefs": [
          "example"
        ],
        "scheduledWakeIds": [
          "example"
        ]
      },
      "commandResult": null,
      "authorization": {}
    },
    "descriptor": {
      "operationId": "create_skill",
      "version": 1,
      "title": "Create skill",
      "description": "Create a reusable single-file skill in the company library. Supply a complete SKILL.md whose name and description match the inputs. This saves the skill and shows a card; it does not assign the skill to any agent. Reuse idempotencyKey on retries.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120,
            "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            "description": "Lowercase skill name, matching SKILL.md frontmatter."
          },
          "slug": {
            "type": "string",
            "minLength": 1,
            "maxLength": 120,
            "pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$",
            "description": "Optional; must equal name."
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000
          },
          "markdown": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200000,
            "description": "Complete SKILL.md including name and description frontmatter and substantive instructions."
          }
        },
        "required": [
          "name",
          "description",
          "markdown"
        ],
        "additionalProperties": false
      },
      "outputSchema": {
        "type": "object",
        "properties": {
          "schema": {
            "type": "string",
            "enum": [
              "paperclip.capability.tool-result.v1"
            ]
          },
          "ok": {
            "type": "boolean"
          },
          "operationId": {
            "type": "string",
            "minLength": 1
          },
          "operationResultId": {
            "type": "string",
            "minLength": 1
          },
          "value": {},
          "commandResult": {},
          "authorization": {}
        },
        "required": [
          "schema",
          "ok",
          "operationId",
          "operationResultId",
          "value",
          "commandResult",
          "authorization"
        ],
        "additionalProperties": false
      },
      "disposition": "optional_agent_tool",
      "optionalGroup": "company_skills",
      "requiredClaims": [],
      "taskModes": [
        "standard",
        "skill_test"
      ],
      "sideEffectClass": "company_write",
      "idempotency": "required",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "semantic_command",
        "commandKind": "create_skill"
      }
    }
  }
} as const;
