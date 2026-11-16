import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DIFFICULTY_TIERS, type DifficultyTier, type Issue, type IssueDifficultyRouting } from "@paperclipai/shared";
import { Check } from "lucide-react";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { DIFFICULTY_TIER_LABELS, formatIssueDifficultyRouting } from "../../lib/difficulty-routing";
import { PropertyPicker } from "./property-picker";

export function IssueDifficultyRoutingRow({
  issueId,
  routing,
  inline,
}: {
  issueId: string;
  routing: IssueDifficultyRouting | null;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const choose = useMutation({
    mutationFn: (tier: DifficultyTier | null): Promise<{ difficultyRouting: IssueDifficultyRouting | null }> =>
      tier ? issuesApi.setDifficultyTier(issueId, tier) : issuesApi.clearDifficultyTier(issueId),
    onSuccess: ({ difficultyRouting }) => {
      queryClient.setQueryData<Issue>(queryKeys.issues.detail(issueId), (current) =>
        current ? { ...current, difficultyRouting } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      setOpen(false);
    },
  });
  const manualTier = routing?.source === "manual" ? routing.tier : null;
  const options: Array<{ tier: DifficultyTier | null; label: string }> = [
    { tier: null, label: "Automatic" },
    ...DIFFICULTY_TIERS.map((tier) => ({ tier, label: `${tier} · ${DIFFICULTY_TIER_LABELS[tier]}` })),
  ];
  const summary = formatIssueDifficultyRouting(routing);

  return (
    <PropertyPicker
      inline={inline}
      label="Difficulty"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) choose.reset();
      }}
      triggerContent={<span className={cn("truncate text-sm", !routing && "text-muted-foreground")} title={summary}>{summary}</span>}
      triggerClassName="min-w-0 max-w-full"
      popoverClassName="w-56"
    >
      <div role="listbox" aria-label="Difficulty">
        {options.map((option) => {
          const selected = option.tier === manualTier;
          return (
            <button
              key={option.tier ?? "auto"}
              type="button"
              role="option"
              aria-selected={selected}
              disabled={choose.isPending}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50 disabled:opacity-50",
                selected && "bg-accent",
              )}
              onClick={() => choose.mutate(option.tier)}
            >
              <span className="flex-1 truncate text-left">{option.label}</span>
              {selected ? <Check className="h-3 w-3 shrink-0" aria-hidden /> : null}
            </button>
          );
        })}
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Applies on the agent's next run.</p>
        {choose.error ? (
          <div role="alert" className="mx-2 mb-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
            {choose.error instanceof Error ? choose.error.message : "Could not change the difficulty."}
          </div>
        ) : null}
      </div>
    </PropertyPicker>
  );
}
