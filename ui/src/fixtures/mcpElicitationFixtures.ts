import { questionSetToAskUserQuestionsPayload, type AskUserQuestionsInteraction, type PaperclipQuestionSetPayload } from "@paperclipai/shared";
import { issueThreadInteractionFixtureMeta } from "./issueThreadInteractionFixtures";

/*
 * Question cards an MCP app's form question becomes (MCP elicitation). The
 * question sets are the exact output of the server's mapper
 * (server/src/services/mcp-elicitation.ts, buildElicitationQuestionSet) for
 * the schemas in doc/connections/MCP-ELICITATION.md, so these stories show
 * the card people really see.
 */

/** Every spec field type: text with a default, titled single select, multi select, yes/no, integer. */
export const mcpTicketQuestionSet: PaperclipQuestionSetPayload = {
  "schema": "paperclip.question_set.v1",
  "title": "Linear needs your input",
  "description": "Linear needs a few details to file this ticket.",
  "submitLabel": "Send to Linear",
  "questions": [
    {
      "id": "title",
      "prompt": "Ticket title",
      "required": true,
      "answerMode": "text",
      "initialText": "Login button does nothing",
      "textValidation": {
        "minLength": 3,
        "maxLength": 80
      }
    },
    {
      "id": "priority",
      "prompt": "Priority",
      "required": true,
      "answerMode": "single_select",
      "options": [
        {
          "id": "choice_1",
          "label": "Urgent"
        },
        {
          "id": "choice_2",
          "label": "Normal",
          "recommended": true
        },
        {
          "id": "choice_3",
          "label": "Later"
        }
      ]
    },
    {
      "id": "labels",
      "prompt": "Labels",
      "required": false,
      "helpText": "Choose at most 2.",
      "answerMode": "multi_select",
      "options": [
        {
          "id": "choice_1",
          "label": "Bug",
          "recommended": true
        },
        {
          "id": "choice_2",
          "label": "Design"
        },
        {
          "id": "choice_3",
          "label": "Speed"
        }
      ]
    },
    {
      "id": "page",
      "prompt": "Page the on-call engineer?",
      "required": false,
      "answerMode": "single_select",
      "options": [
        {
          "id": "choice_1",
          "label": "Yes"
        },
        {
          "id": "choice_2",
          "label": "No",
          "recommended": true
        }
      ]
    },
    {
      "id": "estimate",
      "prompt": "Estimate (points)",
      "required": false,
      "answerMode": "text",
      "textValidation": {
        "inputType": "integer",
        "minimum": 1,
        "maximum": 8
      }
    }
  ]
};

/** A plain single-choice question. */
export const mcpTeamQuestionSet: PaperclipQuestionSetPayload = {
  "schema": "paperclip.question_set.v1",
  "title": "Linear needs your input",
  "description": "Which team should own this?",
  "submitLabel": "Send to Linear",
  "questions": [
    {
      "id": "team",
      "prompt": "Team",
      "required": true,
      "answerMode": "single_select",
      "options": [
        {
          "id": "choice_1",
          "label": "Platform"
        },
        {
          "id": "choice_2",
          "label": "Growth"
        }
      ]
    }
  ]
};

/** A form with no fields: the app asks to go ahead. */
export const mcpConfirmQuestionSet: PaperclipQuestionSetPayload = {
  "schema": "paperclip.question_set.v1",
  "title": "Linear needs your input",
  "description": "Create the ticket now?",
  "submitLabel": "Send to Linear",
  "questions": [
    {
      "id": "continue",
      "prompt": "Create the ticket now?",
      "required": true,
      "answerMode": "single_select",
      "options": [
        {
          "id": "continue",
          "label": "Continue"
        }
      ]
    }
  ]
};

function mcpQuestionCard(id: string, questionSet: PaperclipQuestionSetPayload, overrides: Partial<AskUserQuestionsInteraction> = {}): AskUserQuestionsInteraction {
  return {
    id,
    companyId: issueThreadInteractionFixtureMeta.companyId,
    issueId: issueThreadInteractionFixtureMeta.issueId,
    kind: "ask_user_questions",
    title: questionSet.title ?? null,
    summary: questionSet.description ?? null,
    status: "pending",
    continuationPolicy: "wake_assignee",
    createdByAgentId: "agent-codex",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date("2026-11-13T15:02:00.000Z"),
    updatedAt: new Date("2026-11-13T15:02:00.000Z"),
    resolvedAt: null,
    payload: { ...questionSetToAskUserQuestionsPayload(questionSet), supersedeOnUserComment: false },
    result: null,
    ...overrides,
  } as AskUserQuestionsInteraction;
}

const resolvedAt = new Date("2026-11-13T15:06:00.000Z");

export const mcpAskingCard = mcpQuestionCard("mcp-elicit-asking", mcpTicketQuestionSet);

export const mcpAnsweredCard = mcpQuestionCard("mcp-elicit-answered", mcpTicketQuestionSet, {
  status: "answered",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt,
  updatedAt: resolvedAt,
  result: {
    version: 1,
    answers: [
      { questionId: "title", optionIds: ["paperclip_text_answer"], otherText: "Login button does nothing on Safari" },
      { questionId: "priority", optionIds: ["choice_1"] },
      { questionId: "labels", optionIds: ["choice_1", "choice_3"] },
      { questionId: "page", optionIds: ["choice_2"] },
      { questionId: "estimate", optionIds: ["paperclip_text_answer"], otherText: "3" },
    ],
  },
});

/** Skip sends "decline" to the app. */
export const mcpSkippedCard = mcpQuestionCard("mcp-elicit-skipped", mcpTeamQuestionSet, {
  status: "cancelled",
  resolvedByUserId: issueThreadInteractionFixtureMeta.currentUserId,
  resolvedAt,
  updatedAt: resolvedAt,
  result: { version: 1, answers: [], outcome: "skipped" },
});

/** Nobody answered within a day: the card is withdrawn and the app is asked again. */
export const mcpExpiredCard = mcpQuestionCard("mcp-elicit-expired", mcpConfirmQuestionSet, {
  status: "cancelled",
  resolvedByAgentId: "agent-codex",
  resolvedAt,
  updatedAt: resolvedAt,
  result: { version: 1, answers: [], outcome: "withdrawn", reason: "The app's question expired before it was answered." },
});

/** Two questions in one round: each is its own card, and both answers go back together. */
export const mcpTwoQuestionCards = [
  mcpQuestionCard("mcp-elicit-two-a", mcpTeamQuestionSet),
  mcpQuestionCard("mcp-elicit-two-b", mcpConfirmQuestionSet),
];
