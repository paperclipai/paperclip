import { Cpu } from "lucide-react";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";

interface ChatModelSelectorProps {
  /** Empty means use the assignee's saved/default model for this one reply. */
  value: string;
  options: InlineEntityOption[];
  defaultModel?: string | null;
  onChange: (model: string) => void;
  className?: string;
  disablePortal?: boolean;
}

/**
 * A deliberately one-message model chooser for task chat. The caller clears
 * `value` after a successful send, so a costly override cannot silently become
 * the task or agent default.
 */
export function ChatModelSelector({
  value,
  options,
  defaultModel,
  onChange,
  className,
  disablePortal,
}: ChatModelSelectorProps) {
  const defaultLabel = defaultModel ? `Default · ${defaultModel}` : "Default";

  return (
    <span data-testid="chat-model-selector" className="min-w-0">
      <InlineEntitySelector
        value={value}
        options={options}
        placeholder={defaultLabel}
        noneLabel={defaultLabel}
        searchPlaceholder="Search models..."
        emptyMessage="No models found."
        onChange={onChange}
        className={className ?? "h-8 max-w-56 text-xs"}
        disablePortal={disablePortal}
        renderTriggerValue={(selected) => (
          <>
            <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="max-w-44 truncate">{selected?.label ?? defaultLabel}</span>
          </>
        )}
        renderOption={(option) => (
          <span className="min-w-0 truncate">{option.label}</span>
        )}
      />
    </span>
  );
}
