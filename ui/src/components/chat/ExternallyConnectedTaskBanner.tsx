import { t, useTranslation } from "@/i18n";
import { TaskVoiceLauncher } from "@/components/voice/TaskVoiceLauncher";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Paperclip, Radio } from "lucide-react";
import type {
  ChatPublicationState,
  ChatFileTransferPhase,
  IssueAttachment,
} from "@paperclipai/shared";
import {
  chatEndpointsApi,
  type ChatProvider,
  type ChatPublicationSummary,
  type ExternalChannelBindingSummary,
} from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { useChatConnectorsEnabled, chatProviderVisible } from "@/hooks/useChatConnectorsEnabled";
import { issuesApi } from "@/api/issues";
import { describeError } from "@/api/errors";
import { classifySendFailure, type SendOutcome } from "@/lib/pending-send";
import { useAutoResend } from "@/hooks/useDurableSubmit";
import { useDraftOwner, useDraftOwnerReader } from "@/hooks/useDraftOwner";
import { useAccountBoundMutation } from "@/hooks/useAccountBoundMutation";
import { retryTransientOnly } from "@/lib/query-client";
import { useQueryView } from "@/components/QueryView";
import {
  boardSendDraftKey,
  clearBoardSendDraft,
  canDismissBoardSendBatch,
  readBoardSendDraft,
  readBoardSendRejection,
  writeBoardSendDraft,
  type BoardSendRejection,
  type RetainedBoardSend,
} from "./board-send-draft";

import { LegacyBoardSendNotice } from "./LegacyBoardSendNotice";

const providerNames: Record<ChatProvider, string> = {
  speko: "Speko",
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  agentmail: "AgentMail",
  "imessage-photon": "iMessage Photon",
};

type PublicationFeedback = {
  title: string;
  body: string;
  tone: "info" | "success" | "warn" | "error";
};

function publicationFeedback(): Record<ChatPublicationState, PublicationFeedback> {
  return {
  awaiting_consent: {
    title: t("apps.ExternallyConnectedTaskBanner.awaitingConsentTitle"),
    body: t("apps.ExternallyConnectedTaskBanner.awaitingConsentBody"),
    tone: "info",
  },
  published: {
    title: t("apps.ExternallyConnectedTaskBanner.publishedTitle"),
    body: t("apps.ExternallyConnectedTaskBanner.publishedBody"),
    tone: "success",
  },
  pending: {
    title: t("apps.ExternallyConnectedTaskBanner.pendingTitle"),
    body: t("apps.ExternallyConnectedTaskBanner.pendingBody"),
    tone: "info",
  },
  streaming: {
    title: t("apps.ExternallyConnectedTaskBanner.streamingTitle"),
    body: t("apps.ExternallyConnectedTaskBanner.streamingBody"),
    tone: "info",
  },
  retry: {
    title: t("apps.ExternallyConnectedTaskBanner.retryTitle"),
    body: t("apps.ExternallyConnectedTaskBanner.retryBody"),
    tone: "warn",
  },
  delivery_unknown: {
    title: t("apps.ExternallyConnectedTaskBanner.deliveryUnknownTitle"),
    body: t("apps.ExternallyConnectedTaskBanner.deliveryUnknownBody"),
    tone: "warn",
  },
  failed: {
    title: t("apps.ExternallyConnectedTaskBanner.failedTitle"),
    body: t("apps.ExternallyConnectedTaskBanner.failedBody"),
    tone: "error",
  },
  cancelled: {
    title: t("apps.ExternallyConnectedTaskBanner.cancelledTitle"),
    body: t("apps.ExternallyConnectedTaskBanner.cancelledBody"),
    tone: "info",
  },
  };
}

function filePhaseLabels(): Record<ChatFileTransferPhase, string> {
  return {
  consent_pending: t("apps.ExternallyConnectedTaskBanner.phaseConsentPending"),
  consent_sending: t("apps.ExternallyConnectedTaskBanner.phaseConsentSending"),
  consent_unknown: t("apps.ExternallyConnectedTaskBanner.phaseConsentUnknown"),
  awaiting_consent: t("apps.ExternallyConnectedTaskBanner.phaseAwaitingConsent"),
  upload_pending: t("apps.ExternallyConnectedTaskBanner.phaseUploadPending"),
  uploading: t("apps.ExternallyConnectedTaskBanner.phaseUploading"),
  upload_unknown: t("apps.ExternallyConnectedTaskBanner.phaseUploadUnknown"),
  file_info_pending: t("apps.ExternallyConnectedTaskBanner.phaseFileInfoPending"),
  file_info_sending: t("apps.ExternallyConnectedTaskBanner.phaseFileInfoSending"),
  file_info_unknown: t("apps.ExternallyConnectedTaskBanner.phaseFileInfoUnknown"),
  delivered: t("apps.ExternallyConnectedTaskBanner.phaseDelivered"),
  declined: t("apps.ExternallyConnectedTaskBanner.phaseDeclined"),
  expired: t("apps.ExternallyConnectedTaskBanner.phaseExpired"),
  cancelled: t("apps.ExternallyConnectedTaskBanner.phaseCancelled"),
  conflict: t("apps.ExternallyConnectedTaskBanner.phaseConflict"),
  };
}

export function useIssueChatBinding(companyId: string, issueId: string) {
  const { enabled, githubEnabled } = useChatConnectorsEnabled();
  const queryEnabled = (enabled || githubEnabled) && Boolean(companyId && issueId) && !issueId.startsWith("chat:");
  const query = useQuery({
    queryKey: ["issue-chat-binding", companyId, issueId],
    queryFn: () => chatEndpointsApi.getIssueBinding(issueId),
    enabled: queryEnabled,
  });
  return {
    binding: queryEnabled && chatProviderVisible(query.data?.provider, enabled, githubEnabled) ? (query.data ?? null) : null,
    isLoading: queryEnabled && query.isLoading,
  };
}

type ConnectedTaskProps = {
  className?: string;
  attachments?: IssueAttachment[];
  companyId: string;
  issueId: string;
  issueCacheRefs?: string[];
  assigneeAgentId?: string | null;
};

export function ExternallyConnectedTaskBanner(props: ConnectedTaskProps) {
  const { binding } = useIssueChatBinding(props.companyId, props.issueId);
  const draftOwner = useDraftOwner();
  return <>
    {draftOwner !== undefined && binding && binding.provider !== "speko" && binding.provider !== "agentmail" && <ConnectedTaskComposer
      key={boardSendDraftKey(props.companyId, props.issueId, binding.endpointId, binding.conversationId, draftOwner)}
      {...props}
      binding={binding}
      draftOwner={draftOwner}
    />}
    <TaskVoiceLauncher companyId={props.companyId} issueId={props.issueId} agentId={props.assigneeAgentId} boundEndpointId={binding?.provider === "speko" ? binding.endpointId : undefined} />
  </>;
}

function ConnectedTaskComposer({
  className,
  attachments = [],
  companyId,
  issueId,
  issueCacheRefs,
  binding,
  draftOwner,
}: ConnectedTaskProps & { binding: ExternalChannelBindingSummary; draftOwner: string }) {
  const { t } = useTranslation();
  const readOwner = useDraftOwnerReader();
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
  const retainedSend = useRef<RetainedBoardSend | null>(null);
  const retainedScopeKey = useRef<string | null>(null);
  const [unconfirmedRequest, setUnconfirmedRequest] = useState(false);
  const [rejection, setRejection] = useState<BoardSendRejection | null>(null);
  const [excludedAttachmentIds, setExcludedAttachmentIds] = useState<string[]>(
    [],
  );
  const [selectionNotice, setSelectionNotice] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [unownedRequest, setUnownedRequest] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadInFlight = useRef(false);
  const mounted = useRef(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedAttachments, setUploadedAttachments] = useState<
    IssueAttachment[]
  >([]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const storageKey = binding
    ? boardSendDraftKey(
        companyId,
        issueId,
        binding.endpointId,
        binding.conversationId,
        draftOwner,
      )
    : null;
  const legacyStorageKey = boardSendDraftKey(companyId, issueId, binding.endpointId, binding.conversationId);
  const loadedStorageKey = useRef<string | null>(null);
  useEffect(() => {
    if (!storageKey || loadedStorageKey.current === storageKey) return;
    loadedStorageKey.current = storageKey;
    try {
      if (sessionStorage.getItem(legacyStorageKey) !== null) {
        setUnownedRequest(true);
        setStorageError(t("apps.ExternallyConnectedTaskBanner.unknownSender"));
        setComposing(true);
        return;
      }
      const saved = readBoardSendDraft(storageKey);
      retainedScopeKey.current = storageKey;
      retainedSend.current = saved;
      idempotencyKey.current = saved?.idempotencyKey ?? null;
      setBody(saved?.body ?? "");
      setSelectedAttachmentIds(saved?.attachmentIds ?? []);
      setPublication(saved?.publication ?? null);
      setUnconfirmedRequest(
        Boolean(saved && !saved.publication && !saved.rejection),
      );
      setRejection(saved?.rejection ?? null);
      setComposing(Boolean(saved));
      setStorageError(null);
    } catch {
      setStorageError(
        t("apps.ExternallyConnectedTaskBanner.readFailed"),
      );
      setComposing(true);
    }
  }, [legacyStorageKey, storageKey, unownedRequest]);
  const deliveryScopeReady = Boolean(
    storageKey &&
    loadedStorageKey.current === storageKey &&
    retainedScopeKey.current === storageKey,
  );
  const invalidateTask = useCallback(() => {
    for (const ref of new Set([issueId, ...(issueCacheRefs ?? [])])) {
      for (const queryKey of [
        queryKeys.issues.comments(ref),
        queryKeys.issues.attachments(ref),
        queryKeys.issues.detail(ref),
        queryKeys.issues.activity(ref),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }
  }, [issueId, issueCacheRefs, queryClient]);
  const finishPublication = useCallback(() => {
    if (storageKey) {
      try {
        clearBoardSendDraft(storageKey);
      } catch {
        /* The retained anchor remains safe to recheck after reload. */
      }
    }
    retainedSend.current = null;
    setUnconfirmedRequest(false);
    setRejection(null);
    setSelectionNotice(false);
    setPublication(null);
    idempotencyKey.current = null;
    setBody("");
    setSelectedAttachmentIds([]);
    setUploadedAttachments([]);
    setUploadError(null);
    setComposing(false);
    invalidateTask();
    pushToast(publicationFeedback().published);
  }, [invalidateTask, pushToast, storageKey]);
  // Keep the first returned ID as the anchor. A batch's blocking row may
  // change as text and files finish; no read is allowed to submit another send.
  const publicationStatus = useQuery({
    queryKey: [
      "chat-publication-batch",
      draftOwner,
      companyId,
      binding?.endpointId,
      binding?.conversationId,
      publication?.id,
    ],
    queryFn: () =>
      chatEndpointsApi.getPublicationBatchStatus(
        binding!.endpointId,
        binding!.conversationId,
        publication!.id,
      ),
    enabled: deliveryScopeReady && Boolean(publication),
    staleTime: 0,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
    retry: retryTransientOnly(0),
  });
  // Read publication status through the shared view: the receipt render uses
  // the cached batch during transient refetch failures,and a no-data failure
  // drops into readable copy.
  const publicationStatusView = useQueryView(publicationStatus);
  useEffect(() => {
    const batch = publicationStatus.data;
    if (
      publication &&
      batch &&
      batch.total > 0 &&
      batch.published === batch.total &&
      batch.publication.state === "published"
    ) {
      finishPublication();
    }
  }, [publication, publicationStatus.data, finishPublication]);
  const publish = useAccountBoundMutation({
    mutationFn: (input: {
      attachmentIds: string[];
      body: string;
      idempotencyKey: string;
      endpointId: string;
      conversationId: string;
    }) => {
      if (readOwner() !== draftOwner) throw new DOMException(t("apps.ExternallyConnectedTaskBanner.accountChanged"), "AbortError");
      return chatEndpointsApi.publishBoardMessage(
        input.endpointId,
        input.conversationId,
        input.body,
        input.idempotencyKey,
        input.attachmentIds,
      );
    },
    onSuccess: (result) => {
      invalidateTask();
      const feedback = publicationFeedback()[result.state];
      setPublication(result.state === "published" ? null : result);
      if (result.state === "published") {
        finishPublication();
        return;
      }
      setUnconfirmedRequest(false);
      if (storageKey && retainedSend.current) {
        retainedSend.current = {
          ...retainedSend.current,
          publication: {
            id: result.id,
            state: result.state,
            attempts: result.attempts,
          },
        };
        try {
          writeBoardSendDraft(storageKey, retainedSend.current);
        } catch {
          // The pre-POST payload/key is already persisted. It remains a safe,
          // explicit same-request retry when the publication ID cannot be saved.
        }
      }
      pushToast({
        ...feedback,
        action: {
          label: t("apps.ExternallyConnectedTaskBanner.viewActivity"),
          href: `/apps/chat/${binding!.endpointId}/activity`,
        },
      });
    },
    onError: (error, request) => {
      const rejected = readBoardSendRejection(error, request);
      if (rejected && retainedSend.current && storageKey) {
        const saved = { ...retainedSend.current, rejection: rejected };
        try {
          // Keep the negative receipt through reload before offering a new key.
          writeBoardSendDraft(storageKey, saved);
        } catch {
          setStorageError(
            t("apps.ExternallyConnectedTaskBanner.rejectedNotSaved"),
          );
          return;
        }
        retainedSend.current = saved;
        setRejection(rejected);
        setUnconfirmedRequest(false);
        invalidateTask();
        pushToast({
          title: t("apps.ExternallyConnectedTaskBanner.updateNotSent"),
          body: t("apps.ExternallyConnectedTaskBanner.rejectedToast"),
          tone: "error",
        });
        return;
      }
      // Outages and lost receipts resend on their own with the same request
      // identity; the inline notice covers them.
      if (classifySendFailure(error) === "pending") return;
      pushToast({
        title: t("apps.ExternallyConnectedTaskBanner.confirmFailedTitle"),
        body: t("apps.ExternallyConnectedTaskBanner.confirmFailedBody", { detail: describeError(error).body }),
        tone: "error",
      });
    },
  });
  // A send that failed with an outage or a lost receipt in this session
  // resends with its saved key; the server returns the original publication
  // instead of queueing another message. A send restored after reload has an
  // unknown outcome and waits for an explicit retry.
  const resendWaiting = Boolean(
    deliveryScopeReady &&
    unconfirmedRequest &&
    retainedSend.current &&
    !rejection &&
    !publication &&
    !storageError &&
    publish.status === "error" &&
    classifySendFailure(publish.error) === "pending",
  );
  const autoResend = useAutoResend({
    sourceId: `board-send:${storageKey ?? issueId}`,
    active: resendWaiting,
    resend: async (): Promise<SendOutcome> => {
      const input = retainedSend.current;
      if (!input || readOwner() !== draftOwner) return "rejected";
      try {
        await publish.mutateAsync({
          ...input,
          endpointId: binding.endpointId,
          conversationId: binding.conversationId,
        });
        return "sent";
      } catch (error) {
        return classifySendFailure(error);
      }
    },
  });
  // Automatic resends gave up while online; only Resend now tries again.
  const resendStalled = resendWaiting && autoResend.stalled && !autoResend.resending;
  const uploadDisabled = Boolean(
    retainedSend.current ||
    publication ||
    publish.isPending ||
    publish.isError ||
    unconfirmedRequest ||
    storageError ||
    !deliveryScopeReady ||
    uploading,
  );
  async function uploadFile(file: File) {
    if (uploadDisabled || uploadInFlight.current || retainedSend.current)
      return;
    uploadInFlight.current = true;
    setUploading(true);
    setUploadError(null);
    try {
      const attachment = await issuesApi.uploadAttachment(
        companyId,
        issueId,
        file,
      );
      if (!mounted.current) return;
      setUploadedAttachments((current) => [...current, attachment]);
      setSelectedAttachmentIds((current) => [...current, attachment.id]);
      idempotencyKey.current = null;
    } catch (error) {
      if (mounted.current) {
        setUploadError(
          t("apps.ExternallyConnectedTaskBanner.uploadFailed", { detail: describeError(error).body }),
        );
      }
    } finally {
      uploadInFlight.current = false;
      if (mounted.current) setUploading(false);
      // An interrupted response may still have stored the file on this task.
      invalidateTask();
    }
  }
  // Keep newly uploaded files usable before the task refetch completes. Once
  // present, server metadata wins (especially a file bound to a sent comment).
  const taskAttachments = [
    ...new Map(
      [...uploadedAttachments, ...attachments].map((attachment) => [
        attachment.id,
        attachment,
      ]),
    ).values(),
  ];
  useEffect(() => {
    // Metadata may arrive after this file was selected but before Send. Never
    // silently keep a now-hidden selection, and never rewrite a retained send.
    if (retainedSend.current) return;
    const newlyBound = attachments
      .filter((file) => file.issueCommentId !== null)
      .map((file) => file.id);
    if (!selectedAttachmentIds.some((id) => newlyBound.includes(id))) return;
    setSelectedAttachmentIds((current) =>
      current.filter((id) => !newlyBound.includes(id)),
    );
    setSelectionNotice(true);
    idempotencyKey.current = null;
  }, [attachments, selectedAttachmentIds]);
  const showingRetainedFiles = Boolean(retainedSend.current);
  // Comment binding removes files from new-send eligibility, not from the
  // immutable receipt for the current send. Saved names survive reload while
  // task metadata is loading (or a selected attachment has since been removed).
  const visibleAttachments = retainedSend.current
    ? retainedSend.current.attachmentIds.map((id) => ({
        id,
        originalFilename:
          retainedSend.current?.attachmentNames?.find((file) => file.id === id)
            ?.name ??
          taskAttachments.find((attachment) => attachment.id === id)
            ?.originalFilename ??
          t("apps.ExternallyConnectedTaskBanner.fileUnavailable"),
      }))
    : taskAttachments.filter(
        (attachment) =>
          attachment.issueCommentId === null &&
          !excludedAttachmentIds.includes(attachment.id),
      );
  const currentPublication = publicationStatus.data?.publication ?? publication;
  const batch = publicationStatus.data;
  const dismissible =
    Boolean(publicationStatus.data) &&
    !publicationStatus.isFetching &&
    canDismissBoardSendBatch(batch);
  const mixedTerminal =
    canDismissBoardSendBatch(batch) && batch!.published < batch!.total;
  const currentFeedback = mixedTerminal
    ? {
        title: t("apps.ExternallyConnectedTaskBanner.mixedTitle"),
        body: t("apps.ExternallyConnectedTaskBanner.mixedBody"),
        tone: "info" as const,
      }
    : currentPublication?.state === "cancelled" &&
        (batch?.awaitingConsent ?? 0) > 0
      ? {
          title: t("apps.ExternallyConnectedTaskBanner.waitingTitle"),
          body: t("apps.ExternallyConnectedTaskBanner.waitingBody"),
          tone: "info" as const,
        }
      : currentPublication
        ? publicationFeedback()[currentPublication.state]
        : null;
  const activityPath = `/apps/chat/${binding.endpointId}/activity`;
  return (
    <section
      aria-label={t("apps.ExternallyConnectedTaskBanner.externalConversation")}
      className={cn("task-context-notice space-y-3", className)}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <Radio className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {t("apps.ExternallyConnectedTaskBanner.connectedTo", { provider: providerNames[binding.provider] })}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {binding.externalLabel} · {binding.provider === "slack"
                ? t("apps.ExternallyConnectedTaskBanner.slackNote")
                : t("apps.ExternallyConnectedTaskBanner.fixedNote")}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {binding.externalUrl && (
            <Button asChild size="sm" variant="outline">
              <a href={binding.externalUrl} target="_blank" rel="noreferrer">
                {t("apps.ExternallyConnectedTaskBanner.open", { provider: providerNames[binding.provider] })} <ExternalLink />
              </a>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setComposing((value) => !value)}
          >
            {t("apps.ExternallyConnectedTaskBanner.sendToChannel")}
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link to={`/apps/chat/${binding.endpointId}/conversations`}>
              {t("apps.ExternallyConnectedTaskBanner.connection")}
            </Link>
          </Button>
        </div>
      </div>
      {composing && (
        <div className="space-y-2 border-t border-border pt-3">
          <label
            className="text-xs font-medium"
            htmlFor="external-board-update"
          >
            {t("apps.ExternallyConnectedTaskBanner.boardUpdate")}
          </label>
          <Textarea
            id="external-board-update"
            value={body}
            disabled={
              Boolean(publication) ||
              Boolean(rejection) ||
              publish.isError ||
              unconfirmedRequest ||
              Boolean(storageError) ||
              !deliveryScopeReady
            }
            onChange={(event) => {
              setBody(event.target.value);
              idempotencyKey.current = null;
              publish.reset();
            }}
            placeholder={t("apps.ExternallyConnectedTaskBanner.placeholderWrite")}
          />
          {selectedAttachmentIds.length > 0 && !body.trim() && (
            <p className="text-xs text-muted-foreground">
              {t("apps.ExternallyConnectedTaskBanner.addMessage")}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              aria-label={t("apps.ExternallyConnectedTaskBanner.attachLabel")}
              disabled={uploadDisabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void uploadFile(file);
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={uploadDisabled}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip />
              {uploading ? t("apps.ExternallyConnectedTaskBanner.uploading") : t("apps.ExternallyConnectedTaskBanner.attachFile")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("apps.ExternallyConnectedTaskBanner.filesStay")}
            </p>
          </div>
          {uploadError && (
            <p role="alert" className="text-xs text-destructive">
              {uploadError}
            </p>
          )}
          {selectionNotice && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("apps.ExternallyConnectedTaskBanner.selectionNotice")}
            </p>
          )}
          {visibleAttachments.length > 0 && (
            <fieldset
              className="space-y-2 rounded-md border border-border bg-background p-3"
              disabled={
                showingRetainedFiles ||
                Boolean(publication) ||
                publish.isError ||
                unconfirmedRequest ||
                Boolean(storageError) ||
                !deliveryScopeReady
              }
            >
              <legend className="px-1 text-xs font-medium">
                {showingRetainedFiles
                  ? t("apps.ExternallyConnectedTaskBanner.filesInSend")
                  : t("apps.ExternallyConnectedTaskBanner.includeFiles")}
              </legend>
              <p className="text-xs text-muted-foreground">
                {binding.provider === "github"
                  ? t("apps.ExternallyConnectedTaskBanner.githubHelp")
                  : binding.provider === "microsoft-teams" &&
                      !showingRetainedFiles
                    ? t("apps.ExternallyConnectedTaskBanner.teamsHelp")
                    : showingRetainedFiles
                      ? t("apps.ExternallyConnectedTaskBanner.filesSelectedHelp")
                      : t("apps.ExternallyConnectedTaskBanner.onlyChecked")}
              </p>
              <div className="space-y-2">
                {visibleAttachments.map((attachment) => {
                  const label =
                    attachment.originalFilename ?? t("apps.ExternallyConnectedTaskBanner.unnamedAttachment");
                  return (
                    <label
                      className="flex items-center gap-2 text-xs"
                      key={attachment.id}
                    >
                      <Checkbox
                        disabled={showingRetainedFiles}
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
          {storageError && (
            <p role="alert" className="text-xs text-destructive">
              {storageError}{" "}
              <Link className="underline underline-offset-4" to={activityPath}>{t("apps.ExternallyConnectedTaskBanner.openActivity")}</Link>
            </p>
          )}
          {unownedRequest && <LegacyBoardSendNotice onDiscard={() => {
            if (readOwner() !== draftOwner) return;
            try { clearBoardSendDraft(legacyStorageKey); }
            catch {
              setStorageError(t("apps.ExternallyConnectedTaskBanner.discardFailed"));
              return;
            }
            loadedStorageKey.current = null;
            setUnownedRequest(false);
            setStorageError(null);
          }} />}
          {rejection && (
            <div
              role="alert"
              className="space-y-1 rounded-md border border-border bg-background p-3 text-xs"
            >
              <p className="font-medium">{t("apps.ExternallyConnectedTaskBanner.updateNotSent")}</p>
              <p className="text-muted-foreground">
                {t("apps.ExternallyConnectedTaskBanner.rejectedBody")}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={Boolean(storageError)}
                onClick={() => {
                  if (!storageKey || !retainedSend.current?.rejection) return;
                  try {
                    clearBoardSendDraft(storageKey);
                  } catch {
                    setStorageError(
                      t("apps.ExternallyConnectedTaskBanner.rejectionClearFailed"),
                    );
                    return;
                  }
                  const invalidIds =
                    retainedSend.current.rejection.attachmentIds;
                  setExcludedAttachmentIds((current) => [
                    ...new Set([...current, ...invalidIds]),
                  ]);
                  setSelectedAttachmentIds((current) =>
                    current.filter((id) => !invalidIds.includes(id)),
                  );
                  setUploadedAttachments((current) =>
                    current.filter((file) => !invalidIds.includes(file.id)),
                  );
                  retainedSend.current = null;
                  idempotencyKey.current = null;
                  setRejection(null);
                  setUnconfirmedRequest(false);
                  setSelectionNotice(true);
                  publish.reset();
                }}
              >
                {t("apps.ExternallyConnectedTaskBanner.editRejected")}
              </Button>
            </div>
          )}
          {!rejection &&
            (publish.isError || unconfirmedRequest) &&
            // An automatic resend keeps the waiting notice up while it runs.
            (!publish.isPending || autoResend.resending) &&
            !publication && (
              <div
                role="alert"
                className="space-y-1 rounded-md border border-border bg-background p-3 text-xs"
              >
                <p className="font-medium">
                  {resendStalled
                    ? t("apps.ExternallyConnectedTaskBanner.couldntSend")
                    : resendWaiting || autoResend.resending
                      ? t("apps.ExternallyConnectedTaskBanner.sendingReconnected")
                      : t("apps.ExternallyConnectedTaskBanner.resultNotConfirmed")}
                </p>
                <p className="text-muted-foreground">
                  {resendStalled
                    ? t("apps.ExternallyConnectedTaskBanner.exactDraftStalled")
                    : resendWaiting || autoResend.resending
                      ? t("apps.ExternallyConnectedTaskBanner.exactDraftAuto")
                      : t("apps.ExternallyConnectedTaskBanner.exactDraftRetry")}
                </p>
                <Link
                  className="inline-block font-medium underline underline-offset-4"
                  to={activityPath}
                >
                  {t("apps.ExternallyConnectedTaskBanner.openActivity")}
                </Link>
              </div>
            )}
          {publication && currentPublication && currentFeedback && (
            <div
              role={
                currentPublication.state === "failed" ||
                currentPublication.state === "delivery_unknown"
                  ? "alert"
                  : "status"
              }
              className="space-y-1 rounded-md border border-border bg-background p-3 text-xs"
            >
              <p className="font-medium">{currentFeedback.title}</p>
              <p className="text-muted-foreground">{currentFeedback.body}</p>
              {batch && (
                <p className="text-muted-foreground">
                  {batch.declined !== undefined &&
                  batch.expired !== undefined &&
                  batch.cancelled !== undefined &&
                  batch.awaitingConsent !== undefined
                    ? [
                        t("apps.ExternallyConnectedTaskBanner.partPublished", { n: batch.published }),
                        ...(batch.awaitingConsent
                          ? [t("apps.ExternallyConnectedTaskBanner.partAwaiting", { n: batch.awaitingConsent })]
                          : []),
                        ...(batch.declined
                          ? [t("apps.ExternallyConnectedTaskBanner.partDeclined", { n: batch.declined })]
                          : []),
                        ...(batch.expired ? [t("apps.ExternallyConnectedTaskBanner.partExpired", { n: batch.expired })] : []),
                        ...(batch.cancelled
                          ? [t("apps.ExternallyConnectedTaskBanner.partCancelled", { n: batch.cancelled })]
                          : []),
                      ].join(" · ")
                    : t("apps.ExternallyConnectedTaskBanner.partsOf", { published: batch.published, total: batch.total })}
                </p>
              )}
              {batch?.parts?.some((part) => part.fileTransfer) && (
                <ul
                  className="space-y-1 text-muted-foreground"
                  aria-label={t("apps.ExternallyConnectedTaskBanner.fileDeliveryOutcomes")}
                >
                  {batch.parts
                    .filter((part) => part.fileTransfer)
                    .map((part) => (
                      <li key={part.id}>
                        {part.fileTransfer!.filename} —{" "}
                        {filePhaseLabels()[part.fileTransfer!.phase]}
                      </li>
                    ))}
                </ul>
              )}
              {publicationStatusView.kind === "error" && (
                <p role="alert" className="text-muted-foreground">
                  {t("apps.ExternallyConnectedTaskBanner.statusRefreshFailed")}
                </p>
              )}
              {currentPublication.redactedError && (
                <p className="text-muted-foreground">
                  {t("apps.ExternallyConnectedTaskBanner.providerDetail", { detail: currentPublication.redactedError })}
                </p>
              )}
              <Link
                className="inline-block font-medium underline underline-offset-4"
                to={activityPath}
              >
                {t("apps.ExternallyConnectedTaskBanner.openActivity")}
              </Link>
              {dismissible && (
                <Button
                  className="ml-3"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (storageKey) {
                      try {
                        clearBoardSendDraft(storageKey);
                      } catch {
                        setStorageError(
                          t("apps.ExternallyConnectedTaskBanner.clearFailed"),
                        );
                        return;
                      }
                    }
                    setStorageError(null);
                    retainedSend.current = null;
                    setUnconfirmedRequest(false);
                    setPublication(null);
                    setBody("");
                    setSelectedAttachmentIds([]);
                    setUploadedAttachments([]);
                    setUploadError(null);
                    idempotencyKey.current = null;
                    publish.reset();
                  }}
                >
                  {t("apps.ExternallyConnectedTaskBanner.dismissReceipt")}
                </Button>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {binding.provider === "slack"
                ? t("apps.ExternallyConnectedTaskBanner.slackPosted")
                : t("apps.ExternallyConnectedTaskBanner.ordinaryComments")}
            </p>
            <Button
              size="sm"
              disabled={
                !body.trim() ||
                publish.isPending ||
                uploading ||
                Boolean(publication) ||
                Boolean(rejection) ||
                Boolean(storageError) ||
                !deliveryScopeReady
              }
              onClick={() => {
                if (
                  uploadInFlight.current ||
                  readOwner() !== draftOwner ||
                  !storageKey ||
                  loadedStorageKey.current !== storageKey ||
                  retainedScopeKey.current !== storageKey
                )
                  return;
                if (resendWaiting) {
                  // Same saved request; also restarts the automatic resends.
                  autoResend.resendNow();
                  return;
                }
                idempotencyKey.current ??= crypto.randomUUID();
                const input = retainedSend.current ?? {
                  attachmentIds: selectedAttachmentIds,
                  attachmentNames: selectedAttachmentIds.map((id) => ({
                    id,
                    name:
                      taskAttachments.find((attachment) => attachment.id === id)
                        ?.originalFilename ?? t("apps.ExternallyConnectedTaskBanner.unnamedAttachment"),
                  })),
                  body: body.trim(),
                  idempotencyKey: idempotencyKey.current,
                  publication: null,
                };
                try {
                  if (!storageKey) throw new Error("Missing delivery scope");
                  writeBoardSendDraft(storageKey, input);
                } catch {
                  setStorageError(
                    t("apps.ExternallyConnectedTaskBanner.storageWriteFailed"),
                  );
                  return;
                }
                retainedSend.current = input;
                setUnconfirmedRequest(true);
                publish.mutate({
                  ...input,
                  endpointId: binding.endpointId,
                  conversationId: binding.conversationId,
                });
              }}
            >
              {publish.isPending
                ? t("apps.ExternallyConnectedTaskBanner.sending")
                : resendWaiting
                  ? t("apps.ExternallyConnectedTaskBanner.resendNow")
                  : !rejection && (publish.isError || unconfirmedRequest)
                  ? t("apps.ExternallyConnectedTaskBanner.retrySafely")
                  : t("apps.ExternallyConnectedTaskBanner.sendToChannel")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
