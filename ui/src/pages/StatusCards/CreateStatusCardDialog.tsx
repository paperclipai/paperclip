import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { StatusCard } from "@paperclipai/shared";
import { Loader2 } from "lucide-react";

import { statusCardsApi } from "@/api/statusCards";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { InlineBanner } from "@/components/InlineBanner";
import { queryKeys } from "@/lib/queryKeys";
import { StatusCardSettingsForm, defaultSettingsValue, type StatusCardSettingsValue } from "./StatusCardSettingsForm";

const EXAMPLES = ["issues about evals", "everything blocked this week", "ship feature X"];

export function CreateStatusCardDialog({
  companyId,
  open,
  onOpenChange,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<1 | 2>(1);
  const [interest, setInterest] = useState("");
  const [createdCard, setCreatedCard] = useState<StatusCard | null>(null);
  const [settings, setSettings] = useState<StatusCardSettingsValue>(defaultSettingsValue());
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep(1);
    setInterest("");
    setCreatedCard(null);
    setSettings(defaultSettingsValue());
    setError(null);
  }

  function close() {
    onOpenChange(false);
    // Delay reset so the closing animation does not flash step 1.
    window.setTimeout(reset, 200);
  }

  const invalidateBoard = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(companyId, false) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(companyId, true) }),
    ]);

  const createMutation = useMutation({
    mutationFn: () =>
      statusCardsApi.create(companyId, {
        interestPrompt: interest.trim(),
        titlePinned: false,
        instructionsMode: "none",
        instructions: null,
        refreshPolicy: settings.refreshPolicy,
      }),
    onMutate: () => setError(null),
    onSuccess: async (card) => {
      setCreatedCard(card);
      setStep(2);
      await invalidateBoard();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not create the card."),
  });

  const saveSettingsMutation = useMutation({
    mutationFn: () =>
      statusCardsApi.patch(createdCard!.id, {
        instructionsMode: settings.instructionsMode,
        instructions: settings.instructionsMode === "none" ? null : settings.instructions.trim() || null,
        refreshPolicy: settings.refreshPolicy,
      }),
    onMutate: () => setError(null),
    onSuccess: async () => {
      await invalidateBoard();
      close();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Could not save settings."),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-2xl">
        {step === 1 ? (
          <>
            <DialogHeader>
              <DialogTitle>New status card</DialogTitle>
              <DialogDescription>Step 1 of 2 — describe what you want to watch</DialogDescription>
            </DialogHeader>

            {error ? <InlineBanner tone="danger" title="Create failed">{error}</InlineBanner> : null}

            <div className="space-y-3">
              <label htmlFor="status-card-interest" className="text-sm font-semibold">
                What do you want to keep an eye on?
              </label>
              <Textarea
                id="status-card-interest"
                value={interest}
                onChange={(event) => setInterest(event.target.value)}
                rows={5}
                autoFocus
                placeholder="Issues in the Cloud, ID and Content projects that were recently updated. Tell me what I need to do next and what your advice is."
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Plain language is fine. The summary agent turns this into a saved issue query and keeps it up to date.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Examples</span>
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => setInterest(example)}
                    className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>

            <DialogFooter className="items-center sm:justify-between">
              <span className="hidden text-xs text-muted-foreground sm:block">
                Creates the card immediately; the query builds in the background.
              </span>
              <div className="flex gap-2">
                <Button variant="outline" onClick={close} disabled={createMutation.isPending}>
                  Cancel
                </Button>
                <Button
                  onClick={() => createMutation.mutate()}
                  disabled={interest.trim().length === 0 || createMutation.isPending}
                >
                  {createMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                  Create →
                </Button>
              </div>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Configure card</DialogTitle>
              <DialogDescription>
                Step 2 of 2 — optional; the card already exists and is building in the background
              </DialogDescription>
            </DialogHeader>

            {error ? <InlineBanner tone="danger" title="Save failed">{error}</InlineBanner> : null}

            <div className="rounded-md bg-muted px-3 py-2 text-xs">
              <div className="flex items-center gap-2 text-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-pulse text-muted-foreground" />
                Building query… the first summary will follow automatically.
              </div>
              <p className="mt-1 text-muted-foreground">“{createdCard?.interestPrompt}”</p>
            </div>

            <div className="max-h-[60vh] overflow-y-auto pr-1">
              <StatusCardSettingsForm value={settings} onChange={setSettings} />
            </div>

            <DialogFooter className="items-center sm:justify-between">
              <span className="hidden text-xs text-muted-foreground sm:block">
                You can change all of this later from the card’s ⋯ menu.
              </span>
              <div className="flex gap-2">
                <Button variant="outline" onClick={close} disabled={saveSettingsMutation.isPending}>
                  Skip
                </Button>
                <Button onClick={() => saveSettingsMutation.mutate()} disabled={saveSettingsMutation.isPending}>
                  {saveSettingsMutation.isPending ? <Loader2 className="animate-spin" /> : null}
                  Done
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
