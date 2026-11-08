import { t, useTranslation, Trans } from "@/i18n";
import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, Paperclip } from "lucide-react";
import type {
  EmailMessage,
  EmailPublicationSummary,
  EmailThreadSummary,
} from "@paperclipai/shared";
import { useEmailThread } from "@/hooks/useEmailThread";
import { issuesApi } from "@/api/issues";
const EmailContext = createContext<EmailThreadSummary | null>(null);
export function EmailThreadProvider({
  companyId,
  issueId,
  children,
}: {
  companyId: string;
  issueId: string;
  children: ReactNode;
}) {
  useTranslation("task-components");
  const thread = useEmailThread(companyId, issueId);
  return (
    <EmailContext.Provider value={thread.data ?? null}>
      {children}
    </EmailContext.Provider>
  );
}
export function useEmailComment(commentId: string) {
  const thread = useContext(EmailContext);
  const message = thread?.messages.find((m) => m.commentId === commentId);
  return message && thread ? (
    <EmailMessageCard
      message={message}
      publication={thread.publications.find(
        (p) => p.providerMessageId === message.providerMessageId,
      )}
      issueId={thread.issueId}
    />
  ) : null;
}
export function EmailMessageCard({
  message,
  publication,
  issueId,
  contextNotice = false,
}: {
  contextNotice?: boolean;
  message: EmailMessage;
  publication?: EmailPublicationSummary;
  issueId: string;
}) {
  useTranslation("task-components");
  const attachments = useQuery({
    queryKey: ["email-attachments", issueId],
    queryFn: () => issuesApi.listAttachments(issueId),
    enabled: message.attachmentIds.length > 0,
  });
  return (
    <article
      aria-label={
        message.direction === "inbound" ? t("task-components:emailReceived_1bd1d0b5") : t("task-components:emailSent_a5e14a58")
      }
      className={contextNotice ? "task-context-notice space-y-3" : "space-y-4 rounded-xl border border-border bg-card p-5"}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Mail className="size-4" />
          {message.direction === "inbound" ? t("task-components:emailReceived_1bd1d0b5") : t("task-components:emailSent_a5e14a58")}
        </span>
        <span className="text-xs text-muted-foreground">
          {new Date(message.timestamp).toLocaleString()}
        </span>
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {message.from}
          {message.direction === "inbound" && (
            <span className="ml-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{t("task-components:external_68c114ea")}</span>
          )}
        </p>
        <p className="break-words text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_bdc0ca7a0024" components={{ part1: <>{message.to.join(", ")}</> }} /></p>
        {!!message.cc?.length && (
          <p className="break-words text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_39f3887428e1" components={{ part1: <>{message.cc.join(", ")}</> }} /></p>
        )}
        <p className="text-sm font-semibold">{message.subject}</p>
      </div>
      <div className="whitespace-pre-wrap break-words text-sm">
        {message.text || t("task-components:noTextBody_b47872fc")}
      </div>
      {!!message.attachmentIds.length && (
        <div className="flex flex-wrap gap-2">
          {message.attachmentIds.map((id) => {
            const attachment = attachments.data?.find((a) => a.id === id);
            return (
              <a
                key={id}
                href={`/api/attachments/${id}/content`}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"
              >
                <Paperclip className="size-3.5" />
                {attachment?.originalFilename ?? t("task-components:openAttachment_9aeeab93")}
              </a>
            );
          })}
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">{t("task-components:emailDetails_2f33e40a")}</summary>
        <div className="space-y-2 pt-3">
          {!!message.bcc?.length && <p><Trans ns="task-components" i18nKey="sentence_ef786f212268" components={{ part1: <>{message.bcc.join(", ")}</> }} /></p>}
          <p className="break-all"><Trans ns="task-components" i18nKey="sentence_bb4592e18bf2" components={{ part1: <>{message.providerMessageId}</> }} /></p>
          {message.fullText !== message.text && (
            <div className="whitespace-pre-wrap break-words">
              {message.fullText}
            </div>
          )}
        </div>
      </details>
      {publication && (
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          {publication.outcome === "delivered"
            ? t("task-components:delivered_90611565")
            : publication.outcome === "failed"
              ? t("task-components:deliveryFailed_b4865220")
              : publication.outcome === "uncertain"
                ? t("task-components:deliveryUncertain_0308cc74")
                : publication.outcome === "queued"
                  ? t("task-components:queued_661ff40a")
                  : t("task-components:sent_c16bc82b")}
          {publication.error ? ` · ${publication.error}` : ""}
        </p>
      )}
      {attachments.error && (
        <p role="alert" className="text-xs text-destructive">{t("task-components:attachmentsCouldNotBeLoaded_0d3fe627")}</p>
      )}
    </article>
  );
}
