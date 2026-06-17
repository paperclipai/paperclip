import { describe, expect, it } from "vitest";
import {
  updateWorkflowSchema,
  workflowPromptTemplateSchema,
  workflowRunnerConfigSchema,
} from "./workflow.js";

describe("workflow prompt template schemas", () => {
  it("accepts workflow-scoped prompt templates in runnerConfig", () => {
    expect(
      workflowPromptTemplateSchema.parse({
        label: "Summarize",
        promptMarkdown: "  Summarize the workflow input.\n\n  Keep the literal markdown.\n",
      }),
    ).toEqual({
      label: "Summarize",
      promptMarkdown: "  Summarize the workflow input.\n\n  Keep the literal markdown.\n",
    });

    expect(
      workflowRunnerConfigSchema.parse({
        agentPath: "/tmp/agent.py",
        promptTemplates: [
          {
            label: "Summarize",
            promptMarkdown: "  Summarize the workflow input.\n\n  Keep the literal markdown.\n",
          },
        ],
      }),
    ).toEqual({
      agentPath: "/tmp/agent.py",
      promptTemplates: [
        {
          label: "Summarize",
          promptMarkdown: "  Summarize the workflow input.\n\n  Keep the literal markdown.\n",
        },
      ],
    });
  });

  it("rejects blank-only prompt template bodies", () => {
    expect(() =>
      workflowPromptTemplateSchema.parse({
        label: "Summarize",
        promptMarkdown: "   ",
      }),
    ).toThrow("Prompt template body cannot be blank.");
  });

  it("allows prompt-template-only workflow updates", () => {
    expect(
      updateWorkflowSchema.parse({
        runnerConfig: {
          promptTemplates: [
            {
              label: "Checklist",
              promptMarkdown: "Turn the workflow input into a checklist.",
            },
          ],
        },
      }),
    ).toEqual({
      runnerConfig: {
        promptTemplates: [
          {
            label: "Checklist",
            promptMarkdown: "Turn the workflow input into a checklist.",
          },
        ],
      },
    });
  });
});
