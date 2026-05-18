import type Anthropic from "@anthropic-ai/sdk";

export const PARSE_APPROVAL_OVERRIDE_TOOL = "parse_approval_override";

export const parseApprovalOverrideTool: Anthropic.Tool = {
  name: PARSE_APPROVAL_OVERRIDE_TOOL,
  description:
    "Parse an approval comment and extract the reviewer's intent for Jira ticket handling. Determine whether to use the default transition, skip Jira sync, perform a specific transition, or reassign to someone.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["default", "skip", "transition", "reassign"],
        description:
          "'default' = follow the configured Jira transition; 'skip' = do not touch Jira at all; 'transition' = move to a specific status named in 'transition'; 'reassign' = change assignee to the person named in 'assignee'.",
      },
      transition: {
        type: "string",
        description:
          "The target Jira status name when action is 'transition'. Omit for other actions.",
      },
      assignee: {
        type: "string",
        description:
          "The name or username of the Jira assignee when action is 'reassign'. Omit for other actions.",
      },
      rawIntentSummary: {
        type: "string",
        description:
          "A one-sentence natural language summary of the reviewer's intent, for audit logs.",
      },
    },
    required: ["action", "rawIntentSummary"],
  },
};
