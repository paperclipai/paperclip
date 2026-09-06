import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Paperclip, Radio } from "lucide-react";
import type {
  ChatPublicationState,
  IssueAttachment,
} from "@paperclipai/shared";
import {
  chatEndpointsApi,
  type ChatProvider,
  type ChatPublicationSummary,
} from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

const providerNames: Record<ChatProvider, string> = {
  slack: "Slack",
  github: "GitHub",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
};

type PublicationFeedback = {
  title: string;
  body: string;
  tone: "info" | "success" | "warn" | "error";
};

const publicationFeedback: Record<ChatPublicationState, PublicationFeedback> = {
  published: {
    title: "Sent to channel",
    body: "The board update was published to the connected conversation.",
    tone: "success",
  },
  pending: {
    title: "Queued for channel",
    body: "Delivery is still pending. Your draft is kept until Paperclip confirms publication.",
    tone: "info",
  },
  streaming: {
    title: "Publishing to channel",
    body: "Delivery is still in progress. Your draft is kept until Paperclip confirms publication.",
    tone: "info",
  },
  retry: {
    title: "Delivery retry scheduled",
    body: "Paperclip will retry this publication. Your draft and retry identity are kept.",
    tone: "warn",
  },
  delivery_unknown: {
    title: "Delivery not confirmed",
    body: "The provider may have accepted this update. Resolve it in Activity before trying again to avoid a duplicate.",
    tone: "warn",
  },
  failed: {
    title: "Channel delivery failed",
    body: "Your draft is kept. Open Activity to retry this same publication safely.",
    tone: "error",
  },
  cancelled: {
    title: "Channel delivery cancelled",
    body: "Nothing was confirmed as published. Your draft is kept if you want to start a new send.",
    tone: "info",
  },
};

export function useIssueChatBinding(companyId: string, issueId: string) {
  const query = useQuery({
    queryKey: ["issue-chat-binding", companyId, issueId],
    queryFn: () => chatEndpointsApi.getIssueBinding(issueId),
    enabled: Boolean(companyId && issueId),
  });
  return { binding: query.data ?? null, isLoading: query.isLoading };
}

export function ExternallyConnectedTaskBanner({
  attachments = [],
  companyId,
  issueId,
}: {
  attachments?: IssueAttachment[];
  companyId: string;
  issueId: string;
}) {
  const { binding } = useIssueChatBinding(companyId, issueId);
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [body, setBody] = useState("");
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState<string[]>(
    [],
  );
  const [publication, setPublication] = useState<ChatPublicationSummary | null>(
    null,
  );
  const idempotencyKey = useRef<string | null>(null);
  const publish = useMutation({
    mutationFn: (input: {
      attachmentIds: string[];
      body: string;
      idempotencyKey: string;
    }) =>
      chatEndpointsApi.publishBoardMessage(
        binding!.endpointId,
        binding!.conversationId,
        input.body,
        input.idempotencyKey,
        input.attachmentIds,
      ),
    onSuccess: (result) => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.attachments(issueId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) }),
      ]);
      const feedback = publicationFeedback[result.state];
      setPublication(result.state === "published" ? null : result);
      if (result.state === "published") {
        idempotencyKey.current = null;
        setBody("");
        setSelectedAttachmentIds([]);
        setComposing(false);
      }
      pushToast({
        ...feedback,
        ...(result.state === "published"
          ? {}
          : {
              action: {
                label: "View activity",
                href: `/apps/chat/${binding!.endpointId}/activity`,
              },
            }),
      });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't confirm channel delivery",
        body:
          error instanceof Error
            ? `${error.message} Your draft is kept; retrying here reuses the same request identity.`
            : "Your draft is kept; retrying here reuses the same request identity.",
        tone: "error",
      }),
  });
  if (!binding) return null;
  const selectableAttachments = attachments.filter(
    (attachment) => attachment.issueCommentId === null,
  );
  const currentFeedback = publication
    ? publicationFeedback[publication.state]
    : null;
  const activityPath = `/apps/chat/${binding.endpointId}/activity`;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <Radio className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Connected to {providerNames[binding.provider]}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {binding.externalLabel} · Agent assignment is fixed for this
            external task.
          </p>
        </div>
        {binding.externalUrl && (
          <Button asChild size="sm" variant="outline">
            <a href={binding.externalUrl} target="_blank" rel="noreferrer">
              Open {providerNames[binding.provider]} <ExternalLink />
            </a>
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setComposing((value) => !value)}
        >
          Send to channel
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to={`/apps/chat/${binding.endpointId}/conversations`}>
            Connection
          </Link>
        </Button>
      </div>
      {composing && (
        <div className="space-y-2 border-t border-border pt-3">
          <label
            className="text-xs font-medium"
            htmlFor="external-board-update"
          >
            Board update
          </label>
          <Textarea
            id="external-board-update"
            value={body}
            disabled={Boolean(publication) || publish.isError}
            onChange={(event) => {
              setBody(event.target.value);
              idempotencyKey.current = null;
              publish.reset();
            }}
            placeholder="Write only what should be visible in the provider conversation."
          />
          {selectableAttachments.length > 0 && (
            <fieldset
              className="space-y-2 rounded-md border border-border bg-background p-3"
              disabled={Boolean(publication) || publish.isError}
            >
              <legend className="px-1 text-xs font-medium">
                Include task files
              </legend>
              <p className="text-xs text-muted-foreground">
                Only checked files will be published to the external
                conversation.
              </p>
              <div className="space-y-2">
                {selectableAttachments.map((attachment) => {
                  const label =
                    attachment.originalFilename ?? "Unnamed attachment";
                  return (
                    <label
                      className="flex items-center gap-2 text-xs"
                      key={attachment.id}
                    >
                      <Checkbox
                        checked={selectedAttachmentIds.includes(attachment.id)}
                        onCheckedChange={(checked) => {
                          setSelectedAttachmentIds((current) =>
                            checked === true
                              ? [...current, attachment.id]
                              : current.filter((id) => id !== attachment.id),
                          );
                          idempotencyKey.current = null;
                          publish.reset();
                        }}
                      />
                      <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="truncate">{label}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
          {publish.isError && !publication && (
            <div
              role="alert"
              className="space-y-1 rounded-md border border-border bg-background p-3 text-xs"
            >
              <p className="font-medium">Delivery result not confirmed</p>
              <p className="text-muted-foreground">
                Your exact draft and request identity are kept. Retry safely to
                learn the authoritative publication state without creating a
                duplicate.
              </p>
              <Link
                className="inline-block font-medium underline underline-offset-4"
                to={activityPath}
              >
                Open Activity
              </Link>
            </div>
          )}
          {publication && currentFeedback && (
            <div
              role={
                publication.state === "failed" ||
                publication.state === "delivery_unknown"
                  ? "alert"
                  : "status"
              }
              className="space-y-1 rounded-md border border-border bg-background p-3 text-xs"
            >
              <p className="font-medium">{currentFeedback.title}</p>
              <p className="text-muted-foreground">{currentFeedback.body}</p>
              {publication.redactedError && (
                <p className="text-muted-foreground">
                  Provider detail: {publication.redactedError}
                </p>
              )}
              <Link
                className="inline-block font-medium underline underline-offset-4"
                to={activityPath}
              >
                Open Activity
              </Link>
              {publication.state === "cancelled" && (
                <Button
                  className="ml-3"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPublication(null);
                    setSelectedAttachmentIds([]);
                    idempotencyKey.current = null;
                    publish.reset();
                  }}
                >
                  Start a new send
                </Button>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Ordinary board comments remain Paperclip-only.
            </p>
            <Button
              size="sm"
              disabled={
                !body.trim() || publish.isPending || Boolean(publication)
              }
              onClick={() => {
                idempotencyKey.current ??= crypto.randomUUID();
                publish.mutate({
                  attachmentIds: selectedAttachmentIds,
                  body: body.trim(),
                  idempotencyKey: idempotencyKey.current,
                });
              }}
            >
              {publish.isPending
                ? "Sending…"
                : publish.isError
                  ? "Retry safely"
                  : "Send to channel"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
