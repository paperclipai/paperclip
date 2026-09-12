import { useTranslation } from "@/i18n";
import { EmailMessageCard } from "./EmailMessageCard";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { emailApi } from "@/api/email";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const cache = useQueryClient();
  const threadKey = ["email-thread", companyId, issueId];
  const thread = useQuery({
    queryKey: threadKey,
    queryFn: () => emailApi.thread(companyId, issueId),
    refetchInterval: 3000,
  });
  const data = thread.data;
  const messages = data?.messages.filter((m) => !m.commentId) ?? [];
  const publications = data?.publications.filter(
    (p) => !p.providerMessageId || p.outcome === "uncertain",
  ) ?? [];
  if (!thread.error && !messages.length && !publications.length) return null;
  return (
    <div className="space-y-3">
      {thread.error && (
        <p role="alert" className="text-sm text-destructive">
          {thread.error.message}
        </p>
      )}
      {messages.map((m) => (
        <EmailMessageCard
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

function EmailDelivery({
  companyId,
  publication: p,
  onResolved,
}: {
  companyId: string;
  publication: EmailPublicationSummary;
  onResolved: () => void;
}) {
  const { t } = useTranslation();
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
          aria-label={t("sep12Connections.emailSendIntent")}
          className="space-y-3 rounded-lg border border-border p-4"
        >
          <p className="font-semibold">{p.request.subject ?? t("sep12Connections.emailReply")}</p>
          {p.request.to && <p>{t("sep12Connections.to", { recipients: p.request.to.join(", ") })}</p>}
          <div className="whitespace-pre-wrap break-words text-sm text-foreground">
            {p.request.text}
          </div>
        </article>
      )}
      <p>
        {t(`sep12Connections.emailOutcome.${p.outcome}`, { defaultValue: `Email ${p.outcome}` })}
        {p.error ? ` — ${p.error}` : ""}
      </p>
      {p.outcome === "uncertain" && (
        <details>
          <summary className="cursor-pointer">
            {t("sep12Connections.resolveDelivery")}
          </summary>
          <div className="space-y-2 py-2">
            <p>
              {t("sep12Connections.resolveDeliveryNotice")}
            </p>
            <Input
              aria-label={t("sep12Connections.providerMessageId")}
              value={messageId}
              onChange={(e) => setMessageId(e.target.value)}
              placeholder={t("sep12Connections.providerMessageId")}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!messageId || resolve.isPending}
                onClick={() => resolve.mutate("sent")}
              >
                {t("sep12Connections.confirmSent")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate("failed")}
              >
                {t("sep12Connections.confirmNotSent")}
              </Button>
            </div>
            {resolve.error && (
              <p role="alert" className="text-destructive">
                {resolve.error.message}
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
