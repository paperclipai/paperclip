const uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export const listRoutinesInputSchema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 200, description: "Words in the title or instructions." },
    status: { type: "string", enum: ["active", "paused", "archived"] },
    assigneeAgentId: { type: "string", pattern: uuidPattern, description: "Only routines this agent runs." },
    projectId: { type: "string", pattern: uuidPattern },
    responsibleUserId: { type: "string", minLength: 1, maxLength: 200, description: "Only routines this person is responsible for." },
    responsibilityId: { type: "string", pattern: uuidPattern, description: "Only routines under this responsibility, filed directly or through its project. Needs Responsibilities on." },
    unfiled: { type: "boolean", description: "Only routines filed under no proposed or active responsibility, directly or through their project. Combine with status, such as active. Needs Responsibilities on." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50." },
  },
  required: [],
  additionalProperties: false,
} as const;

export const listRoutinesDescription = "List the company's routines (recurring work an agent runs on a schedule, webhook or request) with their agent, project, responsible person, schedules and last run. Filter by words, status, agent, project, person, a responsibility, or unfiled for routines under no responsibility; every filter applies before the limit.";

/** Canonical definition and documentation for `list_routines`. */
export const listRoutinesAction = {
  "id": "list_routines",
  "canonical": {
    "operationId": "list_routines",
    "surfaces": [
      "scenario",
      "live"
    ],
    "placement": "optional_agent_tool",
    "optionalGroup": "routines",
    "requiredClaims": [
      "routines:read"
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
    "realServiceBinding": "callRoutineTool",
    "prpEvidence": "Authenticated routine and responsibility routes read with the run's agent token.",
    "prpBindingStatus": "bound",
    "legacyAliases": []
  },
  "documentation": {
    "title": "List routines",
    "description": listRoutinesDescription,
    "note": null
  },
  "examples": {
    "call": {
      "operationId": "list_routines",
      "input": {}
    },
    "success": {
      "ok": true,
      "operationId": "list_routines",
      "result": {
        "schema": "paperclip.capability.tool-result.v1",
        "ok": true,
        "operationId": "example",
        "operationResultId": "example",
        "value": "example",
        "commandResult": "example",
        "authorization": "example"
      }
    }
  },
  "live": {
    "order": 95,
    "descriptor": {
      "schema": "paperclip.semantic-tool.v1",
      "operationId": "list_routines",
      "version": 1,
      "title": "List routines",
      "description": listRoutinesDescription,
      "effect": "read",
      "requiredClaims": [
        "routines:read"
      ],
      "allowedModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "inputSchema": listRoutinesInputSchema,
      "outputSchema": {
        "type": "object",
        "additionalProperties": true
      },
      "exposure": "optional"
    }
  },
  "scenario": {
    "order": 28,
    "descriptor": {
      "operationId": "list_routines",
      "version": 1,
      "title": "List routines",
      "description": listRoutinesDescription,
      "inputSchema": listRoutinesInputSchema,
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
      "optionalGroup": "routines",
      "requiredClaims": [
        "routines:read"
      ],
      "taskModes": [
        "standard",
        "ask",
        "planning",
        "skill_test"
      ],
      "sideEffectClass": "read",
      "idempotency": "none",
      "redaction": [],
      "mockCommandMapping": {
        "kind": "mock_extension",
        "extension": "routines.list"
      }
    }
  }
} as const;
