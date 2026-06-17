import { useId } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { WorkflowPromptTemplate } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createWorkflowPromptTemplate } from "../config/workflow-run-prompts";

export type WorkflowPromptTemplateDraft = WorkflowPromptTemplate & {
  id: string;
};

function createWorkflowPromptTemplateDraftId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `workflow-prompt-template-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createWorkflowPromptTemplateDraft(
  template: WorkflowPromptTemplate = createWorkflowPromptTemplate(),
): WorkflowPromptTemplateDraft {
  return {
    id: createWorkflowPromptTemplateDraftId(),
    label: template.label,
    promptMarkdown: template.promptMarkdown,
  };
}

function moveWorkflowPromptTemplate(
  templates: WorkflowPromptTemplateDraft[],
  index: number,
  offset: -1 | 1,
) {
  const nextIndex = index + offset;
  if (nextIndex < 0 || nextIndex >= templates.length) return templates;
  const next = [...templates];
  [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
  return next;
}

export function WorkflowPromptTemplatesEditor({
  value,
  onChange,
}: {
  value: WorkflowPromptTemplateDraft[];
  onChange: (templates: WorkflowPromptTemplateDraft[]) => void;
}) {
  const titleId = useId();

  const updateTemplate = (
    index: number,
    patch: Partial<WorkflowPromptTemplateDraft>,
  ) => {
    onChange(
      value.map((template, templateIndex) =>
        templateIndex === index
          ? { ...template, ...patch }
          : template,
      ),
    );
  };

  const addTemplate = () => {
    onChange([...value, createWorkflowPromptTemplateDraft()]);
  };

  const removeTemplate = (index: number) => {
    onChange(value.filter((_template, templateIndex) => templateIndex !== index));
  };

  const moveTemplate = (index: number, offset: -1 | 1) => {
    onChange(moveWorkflowPromptTemplate(value, index, offset));
  };

  return (
    <div className="space-y-3" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div
            id={titleId}
            className="text-sm font-medium text-foreground"
          >
            Prompt templates
          </div>
          <p className="text-xs text-muted-foreground">
            These templates are saved on this workflow and shown as run pills.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addTemplate}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add template
        </Button>
      </div>

      {value.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          No prompt templates yet. Add one to enable run suggestions.
        </div>
      ) : (
        <div className="space-y-3">
          {value.map((template, index) => {
            const labelId = `workflow-prompt-template-label-${template.id}`;
            const promptId = `workflow-prompt-template-prompt-${template.id}`;
            return (
              <div
                key={template.id}
                role="group"
                aria-label={`Prompt template ${index + 1}`}
                className="space-y-3 rounded-xl border border-border/70 bg-muted/20 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Template {index + 1}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-xs"
                      aria-label={`Move template ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => moveTemplate(index, -1)}
                    >
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-xs"
                      aria-label={`Move template ${index + 1} down`}
                      disabled={index === value.length - 1}
                      onClick={() => moveTemplate(index, 1)}
                    >
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-xs"
                      aria-label={`Remove template ${index + 1}`}
                      onClick={() => removeTemplate(index)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor={labelId}>Label</Label>
                  <Input
                    id={labelId}
                    value={template.label}
                    onChange={(event) =>
                      updateTemplate(index, { label: event.target.value })
                    }
                    placeholder="Summarize"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor={promptId}>Prompt</Label>
                  <Textarea
                    id={promptId}
                    value={template.promptMarkdown}
                    onChange={(event) =>
                      updateTemplate(index, {
                        promptMarkdown: event.target.value,
                      })
                    }
                    rows={4}
                    placeholder="Summarize the workflow input in markdown."
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
