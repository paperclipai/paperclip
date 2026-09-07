import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { defaultStatusCardRefreshPolicy } from "@paperclipai/shared";
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
import { SummarizerAgentSelect } from "./SummarizerAgentSelect";

const EXAMPLES = [
  "issues about evals",
  "everything blocked this week",
  "is feature X live? if not, the exact next actions to ship it",
];

function exampleLabel(example: string): string {
  switch (example) {
    case "issues about evals": return t("localizationStatusCards.exampleLabel0");
    case "everything blocked this week": return t("localizationStatusCards.exampleLabel1");
    case "is feature X live? if not, the exact next actions to ship it": return t("localizationStatusCards.exampleLabel2");
    default: return example;
  }
}

export function CreateStatusCardDialog({
  companyId,
  open,
  onOpenChange,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");
  // "" → the built-in Summarizer; otherwise the id of the override agent.
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<{ message: string } | { key: string } | null>(null);

  function reset() {
    setPrompt("");
    setAgentId("");
    setError(null);
  }

  function close() {
    onOpenChange(false);
    // Delay reset so the closing animation does not flash cleared fields.
    window.setTimeout(reset, 200);
  }

  const createMutation = useMutation({
    mutationFn: () =>
      statusCardsApi.create(companyId, {
        interestPrompt: prompt.trim(),
        titlePinned: false,
        agentId: agentId || null,
        refreshPolicy: defaultStatusCardRefreshPolicy,
      }),
    onMutate: () => setError(null),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(companyId, false) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.statusCards.list(companyId, true) }),
      ]);
      close();
    },
    onError: (err) => setError(err instanceof Error ? { message: err.message } : { key: "localizationStatusCards.couldNotCreateTheCard3" }),
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("localizationStatusCards.newCard4")}</DialogTitle>
          <DialogDescription>{t("localizationStatusCards.oneMessageSetsUpTheWholeCardSayWhatYouWantToWatchAndWha5")}</DialogDescription>
        </DialogHeader>

        {error ? <InlineBanner tone="danger" title={t("localizationStatusCards.createFailed6")}>{"message" in error ? error.message : t(error.key)}</InlineBanner> : null}

        <div className="space-y-3">
          <label htmlFor="status-card-prompt" className="block pb-1 text-sm font-semibold">{t("localizationStatusCards.whatDoYouWantToKeepAnEyeOn7")}</label>
          <Textarea
            id="status-card-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
            autoFocus
            placeholder={t("localizationStatusCards.keepAnEyeOnTheIDAndCloudProjectsTellMeWhetherTheService8")}
            className="text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">{t("localizationStatusCards.examples9")}</span>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setPrompt(example)}
                className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/40"
              >
                {exampleLabel(example)}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-semibold">{t("pages.agentDetail.agentFallback")}</label>
          <SummarizerAgentSelect companyId={companyId} value={agentId} onChange={setAgentId} enabled={open} />
          <p className="text-xs text-muted-foreground">{t("localizationStatusCards.runsThisCardSSetupAndUpdatesLeaveOnTheDefaultUnlessAnot11")}</p>
        </div>

        <DialogFooter>
          <div className="flex gap-2">
            <Button variant="outline" onClick={close} disabled={createMutation.isPending}>{t("pages.cliAuth.cancel")}</Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={prompt.trim().length === 0 || createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 className="animate-spin" /> : null}{t("localizationStatusCards.createCard13")}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
