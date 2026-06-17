import type { WorkflowPromptTemplate } from "@paperclipai/shared";

export type { WorkflowPromptTemplate } from "@paperclipai/shared";

type WorkflowPromptTemplateInput = {
  label?: unknown;
  promptMarkdown?: unknown;
};

function coerceWorkflowPromptTemplate(value: unknown): WorkflowPromptTemplate | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as WorkflowPromptTemplateInput;
  const label = typeof candidate.label === "string" ? candidate.label.trim() : "";
  const promptMarkdown = typeof candidate.promptMarkdown === "string"
    ? candidate.promptMarkdown
    : "";
  if (!label || promptMarkdown.trim().length === 0) return null;
  return { label, promptMarkdown };
}

function isIncompleteWorkflowPromptTemplate(value: unknown) {
  return coerceWorkflowPromptTemplate(value) === null;
}

export function createWorkflowPromptTemplate(): WorkflowPromptTemplate {
  return {
    label: "",
    promptMarkdown: "",
  };
}

export function normalizeWorkflowPromptTemplates(
  promptTemplates: readonly WorkflowPromptTemplateInput[] | null | undefined,
): WorkflowPromptTemplate[] {
  return (promptTemplates ?? []).flatMap((template) => {
    const normalized = coerceWorkflowPromptTemplate(template);
    return normalized ? [normalized] : [];
  });
}

export function readWorkflowPromptTemplates(
  runnerConfig: Record<string, unknown> | null | undefined,
): WorkflowPromptTemplate[] {
  const rawTemplates = runnerConfig?.promptTemplates;
  if (!Array.isArray(rawTemplates)) return [];
  return normalizeWorkflowPromptTemplates(rawTemplates as WorkflowPromptTemplateInput[]);
}

export function hasIncompleteWorkflowPromptTemplates(
  promptTemplates: readonly WorkflowPromptTemplateInput[] | null | undefined,
) {
  return (promptTemplates ?? []).some((template) => isIncompleteWorkflowPromptTemplate(template));
}

export function buildWorkflowRunnerConfig(
  existingRunnerConfig: Record<string, unknown> | null | undefined,
  input: {
    agentPath: string;
    cwd: string;
    command: string;
    model: string;
    promptTemplates: readonly WorkflowPromptTemplateInput[];
  },
): Record<string, unknown> {
  const nextRunnerConfig: Record<string, unknown> = {
    ...(existingRunnerConfig ?? {}),
  };
  nextRunnerConfig.agentPath = input.agentPath.trim();
  const cwd = input.cwd.trim();
  const command = input.command.trim();
  const model = input.model.trim();

  if (cwd) {
    nextRunnerConfig.cwd = cwd;
  } else {
    delete nextRunnerConfig.cwd;
  }

  if (command) {
    nextRunnerConfig.command = command;
  } else {
    delete nextRunnerConfig.command;
  }

  if (model) {
    nextRunnerConfig.model = model;
  } else {
    delete nextRunnerConfig.model;
  }

  nextRunnerConfig.promptTemplates = normalizeWorkflowPromptTemplates(input.promptTemplates);
  return nextRunnerConfig;
}
