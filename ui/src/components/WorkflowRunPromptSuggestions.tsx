import type { WorkflowPromptTemplate } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";

export function WorkflowRunPromptSuggestions({
  promptTemplates,
  onSelectPrompt,
}: {
  promptTemplates: readonly WorkflowPromptTemplate[];
  onSelectPrompt: (prompt: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Prompt templates
      </div>
      {promptTemplates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No prompt templates configured.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {promptTemplates.map((prompt, index) => (
            <Button
              key={`${prompt.label}-${index}`}
              type="button"
              variant="outline"
              size="xs"
              className="rounded-full px-3 shadow-none"
              onClick={() => onSelectPrompt(prompt.promptMarkdown)}
            >
              {prompt.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
