import { t, useTranslation, Trans } from "@/i18n";
import { EmailMessageCard } from "./EmailMessageCard";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { emailApi } from "@/api/email";
import { useEmailThread } from "@/hooks/useEmailThread";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeError } from "@/api/errors";
import { QueryErrorState, useQueryView } from "./QueryView";
import type { EmailPublicationSummary } from "@paperclipai/shared";

// Email actions belong to the agent's task conversation. Only surface mail
// without a task comment yet and delivery outcomes that need attention here.
export function EmailTaskActivity({
  companyId,
  issueId,
}: {
  companyId: string;
  issueId: string;
}) {
  useTranslation("task-components");
  const cache = useQueryClient();
  const threadKey = ["email-thread", companyId, issueId];
  const queryEnabled = Boolean(companyId && issueId) && !issueId.startsWith("chat:");
  const thread = useEmailThread(companyId, issueId);
  const threadView = useQueryView(thread);
  if (!queryEnabled) return null;
  if (threadView.kind === "stale" || threadView.kind === "ready") {
    const data = threadView.data;
    const messages = data?.messages.filter((m) => !m.commentId) ?? [];
    const publications = data?.publications.filter(
      (p) => !p.providerMessageId || p.outcome === "uncertain",
    ) ?? [];
    if (!messages.length && !publications.length) return null;
    return (
      <div className="space-y-3">
        {messages.map((m) => (
          <EmailMessageCard
            contextNotice
            key={m.id}
            issueId={issueId}
            message={m}
            publication={data?.publications.find(
              (p) => p.providerMessageId === m.providerMessageId,
            )}
          />
        ))}
        {publications.map((p) => (
          <EmailDelivery
            key={p.id}
            companyId={companyId}
            publication={p}
            onResolved={() => {
              void cache.invalidateQueries({ queryKey: threadKey });
            }}
          />
        ))}
      </div>
    );
  }
  // A quiet section while the initial read is still settling;a no-data read
  // failure gets readable copy with Retry instead of a raw error line.
  if (threadView.kind === "error") {
    return (
      <QueryErrorState
        size="inline"
        error={threadView.error}
        action="load email activity"
        onRetry={threadView.retry}
        retrying={threadView.isFetching}
      />
    );
  }
  return null;
}

function EmailDelivery({
  companyId,
  publication: p,
  onResolved,
}: {
  companyId: string;
  publication: EmailPublicationSummary;
  onResolved: () => void;
}) {
  useTranslation("task-components");
  const [messageId, setMessageId] = useState("");
  const resolve = useMutation({
    mutationFn: (outcome: "sent" | "failed") =>
      emailApi.resolve(companyId, p.id, outcome, messageId || undefined),
    onSuccess: onResolved,
  });
  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      {p.request && !p.providerMessageId && (
        <article
          aria-label={t("task-components:emailSendIntent_5cd55844")}
          className="task-context-notice space-y-3"
        >
          <p className="font-semibold">{p.request.subject ?? t("task-components:emailReply_ef902e38")}</p>
          {p.request.to && <p><Trans ns="task-components" i18nKey="sentence_bdc0ca7a0024" components={{ part1: <>{p.request.to.join(", ")}</> }} /></p>}
          <div className="whitespace-pre-wrap break-words text-sm text-foreground">
            {p.request.text}
          </div>
        </article>
      )}
      <p><Trans ns="task-components" i18nKey="sentence_e35f311f1170" components={{ part1: <>{p.outcome}</>, part2: <>{p.error ? ` — ${p.error}` : ""}</> }} /></p>
      {p.outcome === "uncertain" && (
        <details>
          <summary className="cursor-pointer">{t("task-components:resolveDeliveryAfterCheckingAgentmail_45731872")}</summary>
          <div className="space-y-2 py-2">
            <p>{t("task-components:confirmTheOutcomeInAgentmailBeforeResolving_0e870401")}</p>
            <Input
              aria-label={t("task-components:providerMessageId_c250cfdf")}
              value={messageId}
              onChange={(e) => setMessageId(e.target.value)}
              placeholder={t("task-components:providerMessageId_c250cfdf")}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!messageId || resolve.isPending}
                onClick={() => resolve.mutate("sent")}
              >{t("task-components:confirmSent_a1913b58")}</Button>
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate("failed")}
              >{t("task-components:confirmNotSent_e948b4c3")}</Button>
            </div>
            {resolve.isError && ( // query-error-ok: mutation result
              <p role="alert" className="text-destructive">
                {describeError(resolve.error).body}
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
