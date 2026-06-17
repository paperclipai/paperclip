import { describe, expect, it } from "vitest";
import {
  buildWorkflowRunnerConfig,
  hasIncompleteWorkflowPromptTemplates,
} from "./workflow-run-prompts";

describe("workflow prompt templates config", () => {
  it("treats partially filled templates as incomplete", () => {
    expect(
      hasIncompleteWorkflowPromptTemplates([
        {
          label: "Summarize",
          promptMarkdown: "",
        },
      ]),
    ).toBe(true);

    expect(
      hasIncompleteWorkflowPromptTemplates([
        {
          label: "",
          promptMarkdown: "Summarize the workflow input.",
        },
      ]),
    ).toBe(true);

    expect(
      hasIncompleteWorkflowPromptTemplates([
        {
          label: "Summarize",
          promptMarkdown: "Summarize the workflow input.",
        },
      ]),
    ).toBe(false);

    expect(hasIncompleteWorkflowPromptTemplates([])).toBe(false);
  });

  it("preserves literal markdown when building the workflow runner config", () => {
    expect(
      buildWorkflowRunnerConfig(
        {
          cwd: "/tmp/workspace",
          customFlag: "keep-me",
        },
        {
          agentPath: "/tmp/agent.py",
          cwd: "",
          command: "",
          model: "",
          promptTemplates: [
            {
              label: "Summarize",
              promptMarkdown: "  Summarize the workflow input.\n\n  Keep the literal markdown.\n",
            },
          ],
        },
      ),
    ).toEqual({
      cwd: "/tmp/workspace",
      customFlag: "keep-me",
      agentPath: "/tmp/agent.py",
      promptTemplates: [
        {
          label: "Summarize",
          promptMarkdown: "  Summarize the workflow input.\n\n  Keep the literal markdown.\n",
        },
      ],
    });
  });
});
