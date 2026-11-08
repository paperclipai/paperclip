import { resolveUiMessage, describeUiError, type UiMessageDescriptor, type ToastPresentation } from "@/lib/localized-ui-error";
import { t, useTranslation, Trans } from "@/i18n";
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
  presentation?: ToastPresentation;
};

const publicationFeedback: Record<ChatPublicationState, PublicationFeedback> = {
  awaiting_consent: {
    get title() { return t("task-components:waitingForFileConsent_56991603"); },
    body: "The recipient must accept the file card in Microsoft Teams. The file is not delivered yet; this send identity is kept while Paperclip waits.",
    presentation: { title: { key: "task-components:waitingForFileConsent_56991603" }, body: { key: "final-components-b:delivery.The_recipient_must_accept_the_file_card_in_Microsoft_Teams_The_file_is_b13212" } },
    tone: "info",
  },
  published: {
    get title() { return t("task-components:sentToChannel_255e7030"); },
    body: "The board update was published to the connected conversation.",
    presentation: { title: { key: "task-components:sentToChannel_255e7030" }, body: { key: "final-components-b:delivery.The_board_update_was_published_to_the_connected_conversation_a82e4a" } },
    tone: "success",
  },
  pending: {
    get title() { return t("task-components:queuedForChannel_cf7ce8fc"); },
    body: "Delivery is still pending. Your draft is kept until Paperclip confirms publication.",
    presentation: { title: { key: "task-components:queuedForChannel_cf7ce8fc" }, body: { key: "final-components-b:delivery.Delivery_is_still_pending_Your_draft_is_kept_until_Paperclip_confirms__d20e14" } },
    tone: "info",
  },
  streaming: {
    get title() { return t("task-components:publishingToChannel_c303056d"); },
    body: "Delivery is still in progress. Your draft is kept until Paperclip confirms publication.",
    presentation: { title: { key: "task-components:publishingToChannel_c303056d" }, body: { key: "final-components-b:delivery.Delivery_is_still_in_progress_Your_draft_is_kept_until_Paperclip_confi_0535ff" } },
    tone: "info",
  },
  retry: {
    get title() { return t("task-components:deliveryRetryScheduled_d4db8f71"); },
    body: "Paperclip will retry this publication. Your draft and retry identity are kept.",
    presentation: { title: { key: "task-components:deliveryRetryScheduled_d4db8f71" }, body: { key: "final-components-b:delivery.Paperclip_will_retry_this_publication_Your_draft_and_retry_identity_ar_1ca403" } },
    tone: "warn",
  },
  delivery_unknown: {
    get title() { return t("task-components:deliveryNotConfirmed_521724ca"); },
    body: "The provider may have accepted this update. Resolve it in Activity before trying again to avoid a duplicate.",
    presentation: { title: { key: "task-components:deliveryNotConfirmed_521724ca" }, body: { key: "final-components-b:delivery.The_provider_may_have_accepted_this_update_Resolve_it_in_Activity_befo_656006" } },
    tone: "warn",
  },
  failed: {
    get title() { return t("task-components:channelDeliveryFailed_ce13a3ab"); },
    body: "Your draft is kept. Open Activity to retry this same publication safely.",
    presentation: { title: { key: "task-components:channelDeliveryFailed_ce13a3ab" }, body: { key: "final-components-b:delivery.Your_draft_is_kept_Open_Activity_to_retry_this_same_publication_safely_832b3d" } },
    tone: "error",
  },
  cancelled: {
    get title() { return t("task-components:channelDeliveryCancelled_c918fc9f"); },
    body: "Your draft is kept. Some parts may already have been published; check Activity before starting a new send.",
    presentation: { title: { key: "task-components:channelDeliveryCancelled_c918fc9f" }, body: { key: "final-components-b:delivery.Your_draft_is_kept_Some_parts_may_already_have_been_published_check_Ac_c56595" } },
    tone: "info",
  },
};

const filePhaseLabels: Record<ChatFileTransferPhase, string> = {
  get consent_pending() { return t("final-components-b:fileTransfer.Consent_card_queued_4a04f6"); },
  get consent_sending() { return t("final-components-b:fileTransfer.Sending_consent_card_c8dbda"); },
  get consent_unknown() { return t("final-components-b:fileTransfer.Consent_card_delivery_not_confirmed_c02d22"); },
  get awaiting_consent() { return t("final-components-b:fileTransfer.Awaiting_consent_7fc08a"); },
  get upload_pending() { return t("final-components-b:fileTransfer.Upload_queued_3c5f2c"); },
  get uploading() { return t("final-components-b:fileTransfer.Uploading_file_d6456b"); },
  get upload_unknown() { return t("final-components-b:fileTransfer.File_upload_not_confirmed_6d7c9d"); },
  get file_info_pending() { return t("final-components-b:fileTransfer.File_notification_queued_bfa424"); },
  get file_info_sending() { return t("final-components-b:fileTransfer.Sending_file_notification_9905b4"); },
  get file_info_unknown() { return t("final-components-b:fileTransfer.File_notification_not_confirmed_037362"); },
  get delivered() { return t("final-components-b:fileTransfer.Delivered_514ec5"); },
  get declined() { return t("final-components-b:fileTransfer.Declined_22f8a8"); },
  get expired() { return t("final-components-b:fileTransfer.Consent_expired_ed5a3b"); },
  get cancelled() { return t("final-components-b:fileTransfer.Cancelled_remote_bytes_may_remain_053def"); },
  get conflict() { return t("final-components-b:fileTransfer.File_delivery_needs_review_eb55f1"); },
};

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
  useTranslation("task-components");
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
  useTranslation("task-components");
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
  const [storageError, setStorageError] = useState<UiMessageDescriptor | null>(null);
  const [unownedRequest, setUnownedRequest] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadInFlight = useRef(false);
  const mounted = useRef(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<UiMessageDescriptor | null>(null);
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
        setStorageError({ key: "final-components-b:storage.An_earlier_update_has_an_unknown_sender_Open_Activity_to_check_its_del_a30328" });
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
        { key: "final-components-b:storage.Saved_delivery_identity_could_not_be_read_Check_Activity_and_restore_b_376fe3" },
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
    pushToast(publicationFeedback.published);
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
      if (readOwner() !== draftOwner) throw new DOMException("Your account changed. Reopen this task to send from your current account.", "AbortError");
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
      const feedback = publicationFeedback[result.state];
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
        presentation: { ...feedback.presentation, action: { key: "task-components:viewActivity_4bf3f8dd" } },
        ...feedback,
        action: {
          label: t("task-components:viewActivity_4bf3f8dd"),
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
            { key: "final-components-b:storage.The_rejected_send_could_not_be_saved_Restore_browser_storage_then_retr_d4df72" },
          );
          return;
        }
        retainedSend.current = saved;
        setRejection(rejected);
        setUnconfirmedRequest(false);
        invalidateTask();
        pushToast({
          title: t("task-components:updateWasNotSent_313813f3"),
          body: "A selected file already belongs to another comment. Edit the rejected send to correct the selection.",
    presentation: { ...({ title: { key: "task-components:updateWasNotSent_313813f3" }, body: { key: "final-components-b:delivery.A_selected_file_already_belongs_to_another_comment_Edit_the_rejected_s_24aba6" } }) },
          tone: "error",
        });
        return;
      }
      // Outages and lost receipts resend on their own with the same request
      // identity; the inline notice covers them.
      if (classifySendFailure(error) === "pending") return;
      pushToast({
        title: t("task-components:couldnTConfirmChannelDelivery_c3e0510d"),
        body: `${describeError(error).body} Your draft is kept; retrying here reuses the same request identity.`,
        presentation: { ...({ title: { key: "task-components:couldnTConfirmChannelDelivery_c3e0510d" }, body: { key: "final-components-b:delivery.diagnostic_Your_draft_is_kept_retrying_here_reuses_the_same_request_id_62feb1", get values() { return { diagnostic: describeUiError(error).body }; } } }) },
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
          { key: "final-components-b:upload.diagnostic_No_channel_message_was_sent_Check_task_files_before_retryin_895c4b", get values() { return { diagnostic: describeUiError(error).body }; } },
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
          "Selected task file (details unavailable)",
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
        title: t("task-components:deliverySettledWithMixedOutcomes_308794c8"),
        body: "Not every part was confirmed delivered. Review the outcomes below; dismissing this receipt does not resend anything.",
    presentation: { title: { key: "task-components:deliverySettledWithMixedOutcomes_308794c8" }, body: { key: "final-components-b:delivery.Not_every_part_was_confirmed_delivered_Review_the_outcomes_below_dismi_7cc8ce" } },
        tone: "info" as const,
      }
    : currentPublication?.state === "cancelled" &&
        (batch?.awaitingConsent ?? 0) > 0
      ? {
          title: t("task-components:waitingForRemainingFileConsent_15cf5433"),
          body: "Some parts have settled. The remaining file cards still need the recipient's response; this send stays locked until the whole batch is resolved.",
    presentation: { title: { key: "task-components:waitingForRemainingFileConsent_15cf5433" }, body: { key: "final-components-b:delivery.Some_parts_have_settled_The_remaining_file_cards_still_need_the_recipi_eda840" } },
          tone: "info" as const,
        }
      : currentPublication
        ? publicationFeedback[currentPublication.state]
        : null;
  const activityPath = `/apps/chat/${binding.endpointId}/activity`;
  return (
    <section
      aria-label={t("task-components:externalConversation_051d5bb3")}
      className={cn("task-context-notice space-y-3", className)}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <Radio className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-medium"><Trans ns="task-components" i18nKey="sentence_c891dcc91c23" components={{ part1: <>{providerNames[binding.provider]}</> }} /></p>
            <p className="truncate text-xs text-muted-foreground">
              {binding.externalLabel} · {binding.provider === "slack"
                ? t("task-components:messagesYouSendHereAndAgentReplies_900b0ca4")
                : t("task-components:agentAssignmentIsFixedForThisExternal_74099745")}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {binding.externalUrl && (
            <Button asChild size="sm" variant="outline">
              <a href={binding.externalUrl} target="_blank" rel="noreferrer">
                {t("final-components-b:Open_providerName_31ff8b", { providerName: providerNames[binding.provider] })} <ExternalLink />
              </a>
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setComposing((value) => !value)}
          >{t("task-components:sendToChannel_dface7aa")}</Button>
          <Button asChild size="sm" variant="ghost">
            <Link to={`/apps/chat/${binding.endpointId}/conversations`}>{t("task-components:connection_639a40e8")}</Link>
          </Button>
        </div>
      </div>
      {composing && (
        <div className="space-y-2 border-t border-border pt-3">
          <label
            className="text-xs font-medium"
            htmlFor="external-board-update"
          >{t("task-components:boardUpdate_6e1dcf6a")}</label>
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
            placeholder={t("task-components:writeOnlyWhatShouldBeVisibleIn_c5a8ffd5")}
          />
          {selectedAttachmentIds.length > 0 && !body.trim() && (
            <p className="text-xs text-muted-foreground">{t("task-components:addAMessageToSendWithYour_680f3ab6")}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              aria-label={t("task-components:attachFileToChannelUpdate_59a735f6")}
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
              {uploading ? t("task-components:uploading_5ce44dd7") : t("task-components:attachFile_87fbe4fb")}
            </Button>
            <p className="text-xs text-muted-foreground">{t("task-components:filesStayOnThisTaskUntilYou_c68a82b0")}</p>
          </div>
          {uploadError && (
            <p role="alert" className="text-xs text-destructive">
              {resolveUiMessage(uploadError)}
            </p>
          )}
          {selectionNotice && (
            <p role="status" className="text-xs text-muted-foreground">{t("task-components:aFileAlreadyAttachedToAnotherComment_15717288")}</p>
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
                  ? t("task-components:filesInThisSend_7674c3b4")
                  : t("task-components:includeTaskFiles_47c29c1f")}
              </legend>
              <p className="text-xs text-muted-foreground">
                {binding.provider === "github"
                  ? t("task-components:githubAppsCannotUploadFileBytesIn_82e71ca7")
                  : binding.provider === "microsoft-teams" &&
                      !showingRetainedFiles
                    ? t("task-components:inPersonalTeamsChatsRecipientsAcceptEach_53b1a2a8")
                    : showingRetainedFiles
                      ? t("task-components:theseAreTheFilesSelectedForThis_3b09f256")
                      : t("task-components:onlyCheckedFilesWillBePublishedTo_53a7b5b7")}
              </p>
              <div className="space-y-2">
                {visibleAttachments.map((attachment) => {
                  const label =
                    attachment.originalFilename ?? t("final-components-b:Unnamed_attachment_a90dd5");
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
              {resolveUiMessage(storageError)}{" "}
              <Link className="underline underline-offset-4" to={activityPath}>{t("task-components:openActivity_b2a97706")}</Link>
            </p>
          )}
          {unownedRequest && <LegacyBoardSendNotice onDiscard={() => {
            if (readOwner() !== draftOwner) return;
            try { clearBoardSendDraft(legacyStorageKey); }
            catch {
              setStorageError({ key: "final-components-b:storage.Saved_delivery_record_could_not_be_discarded_Restore_browser_storage_t_890a6a" });
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
              <p className="font-medium">{t("task-components:updateWasNotSent_313813f3")}</p>
              <p className="text-muted-foreground">{t("task-components:aSelectedFileAlreadyBelongsToAnother_c22adf15")}</p>
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
                      { key: "final-components-b:storage.Saved_rejection_could_not_be_cleared_Restore_browser_storage_before_ed_c235b5" },
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
              >{t("task-components:editRejectedSend_c342fb93")}</Button>
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
                    ? t("final-components-b:Couldn_t_send_this_update_yet_0df18d")
                    : resendWaiting || autoResend.resending
                      ? t("final-components-b:Sending_when_reconnected_8639e6")
                      : t("task-components:deliveryResultNotConfirmed_68d563e3")}
                </p>
                <p className="text-muted-foreground">
                  {resendStalled
                    ? t("final-components-b:Your_exact_draft_and_request_identity_are_kept_Automatic_resends_stopp_227ee7")
                    : resendWaiting || autoResend.resending
                      ? t("final-components-b:Your_exact_draft_and_request_identity_are_kept_It_resends_on_its_own_w_debcdc")
                      : t("task-components:yourExactDraftAndRequestIdentityAre_876c543e")}
                </p>
                <Link
                  className="inline-block font-medium underline underline-offset-4"
                  to={activityPath}
                >{t("task-components:openActivity_b2a97706")}</Link>
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
              <p className="text-muted-foreground">{currentFeedback.presentation?.body ? resolveUiMessage(currentFeedback.presentation.body) : currentFeedback.body}</p>
              {batch && (
                <p className="text-muted-foreground">
                  {batch.declined !== undefined &&
                  batch.expired !== undefined &&
                  batch.cancelled !== undefined &&
                  batch.awaitingConsent !== undefined
                    ? [
                        `${batch.published} published`,
                        ...(batch.awaitingConsent
                          ? [`${batch.awaitingConsent} awaiting consent`]
                          : []),
                        ...(batch.declined
                          ? [`${batch.declined} declined`]
                          : []),
                        ...(batch.expired ? [`${batch.expired} expired`] : []),
                        ...(batch.cancelled
                          ? [`${batch.cancelled} cancelled`]
                          : []),
                      ].join(" · ")
                    : t("task-components:ofPartsPublished_4ee4fef5", { value1: batch.published, value2: batch.total })}
                </p>
              )}
              {batch?.parts?.some((part) => part.fileTransfer) && (
                <ul
                  className="space-y-1 text-muted-foreground"
                  aria-label={t("task-components:fileDeliveryOutcomes_e0229aa5")}
                >
                  {batch.parts
                    .filter((part) => part.fileTransfer)
                    .map((part) => (
                      <li key={part.id}>
                        {part.fileTransfer!.filename} —{" "}
                        {filePhaseLabels[part.fileTransfer!.phase]}
                      </li>
                    ))}
                </ul>
              )}
              {publicationStatusView.kind === "error" && (
                <p role="alert" className="text-muted-foreground">{t("task-components:deliveryStatusCouldNotBeRefreshedYour_2c58b83f")}</p>
              )}
              {currentPublication.redactedError && (
                <p className="text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_55e4e624da99" components={{ part1: <>{currentPublication.redactedError}</> }} /></p>
              )}
              <Link
                className="inline-block font-medium underline underline-offset-4"
                to={activityPath}
              >{t("task-components:openActivity_b2a97706")}</Link>
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
                          { key: "final-components-b:storage.Saved_delivery_identity_could_not_be_cleared_Restore_browser_storage_b_a77f3f" },
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
                >{t("task-components:dismissDeliveryReceipt_e6d60fbc")}</Button>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {binding.provider === "slack"
                ? t("task-components:yourMessageIsPostedToSlackWith_fe11e393")
                : t("task-components:ordinaryBoardCommentsRemainPaperclipOnly_9add3834")}
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
                        ?.originalFilename ?? t("final-components-b:Unnamed_attachment_a90dd5"),
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
                    { key: "final-components-b:storage.Browser_storage_could_not_preserve_this_delivery_identity_No_update_wa_c45369" },
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
                ? t("task-components:sending_b8ed5279")
                : resendWaiting
                  ? t("task-components:resendNow_a4fab5c8")
                  : !rejection && (publish.isError || unconfirmedRequest)
                  ? t("task-components:retrySafely_aea7359d")
                  : t("task-components:sendToChannel_dface7aa")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
