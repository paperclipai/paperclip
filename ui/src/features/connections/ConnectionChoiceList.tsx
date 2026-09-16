import type { ReactNode } from "react";
import { Check, ChevronRight, Loader2 } from "lucide-react";

/** The account-reuse rows shared by connection setup and agent bindings. */
export function ConnectionChoiceList({ choices, selectedId, pendingId, disabled, onSelect }: {
  choices: { id: string; name: string; description: ReactNode; disabled?: boolean }[];
  selectedId?: string;
  pendingId?: string | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
}) {
  return <div className="space-y-2">
    {choices.map((choice) => <button
      key={choice.id}
      type="button"
      className="flex w-full items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
      aria-label={choice.name}
      aria-pressed={selectedId === undefined ? undefined : selectedId === choice.id}
      disabled={disabled || Boolean(pendingId) || choice.disabled}
      onClick={() => onSelect(choice.id)}
    >
      <span className="min-w-0">
        <span className="block font-medium text-foreground">{choice.name}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{choice.description}</span>
      </span>
      {pendingId === choice.id ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        : selectedId === choice.id ? <Check className="h-4 w-4 shrink-0 text-muted-foreground" />
        : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
    </button>)}
  </div>;
}
