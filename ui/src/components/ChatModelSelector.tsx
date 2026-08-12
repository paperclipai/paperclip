import { Cpu, Gauge } from "lucide-react";
import { formatChatThinkingEffort } from "@paperclipai/shared";
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

interface ChatThinkingEffortSelectorProps {
  /** Empty means use the assignee's saved/default effort for this one reply. */
  value: string;
  options: InlineEntityOption[];
  defaultEffort?: string | null;
  onChange: (effort: string) => void;
  className?: string;
  disablePortal?: boolean;
}

/**
 * A deliberately one-message reasoning-effort chooser for task chat. Like
 * the model selector, the caller clears the value after a successful send.
 */
export function ChatThinkingEffortSelector({
  value,
  options,
  defaultEffort,
  onChange,
  className,
  disablePortal,
}: ChatThinkingEffortSelectorProps) {
  const defaultLabel = defaultEffort
    ? `Default · ${formatChatThinkingEffort(defaultEffort)}`
    : "Default";

  return (
    <span data-testid="chat-thinking-effort-selector" className="min-w-0">
      <InlineEntitySelector
        value={value}
        options={options}
        placeholder={defaultLabel}
        noneLabel={defaultLabel}
        searchPlaceholder="Search effort levels..."
        emptyMessage="No effort levels found."
        onChange={onChange}
        className={className ?? "h-8 max-w-44 text-xs"}
        disablePortal={disablePortal}
        renderTriggerValue={(selected) => (
          <>
            <Gauge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="max-w-32 truncate">{selected?.label ?? defaultLabel}</span>
          </>
        )}
        renderOption={(option) => (
          <span className="min-w-0 truncate">{option.label}</span>
        )}
      />
    </span>
  );
}
