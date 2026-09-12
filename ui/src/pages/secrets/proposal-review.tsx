import { useCallback, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Fingerprint, KeyRound, Link2, ShieldAlert, Variable, ServerCog } from "lucide-react";
import type {
  CompanySecretProviderConfig,
  SecretProposalAgentRef,
  SecretProposalView,
} from "@paperclipai/shared";
import { AgentIcon } from "@/components/AgentIconPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToastActions } from "../../context/ToastContext";
import { secretsApi } from "../../api/secrets";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import {
  aliasFromConfigPath,
  deliveryModeForConfigPath,
} from "../../lib/secret-delivery";
import { cn } from "../../lib/utils";
import { copyTextToClipboard } from "../../lib/clipboard";
import { SecretPathName } from "./SecretPathName";
import { t, useTranslation } from "@/i18n";

/* -------------------------------------------------------------------------- */
/* Presentation helpers (shared by the tab + agent-settings surfaces)         */
/* -------------------------------------------------------------------------- */

/** Short, non-reversible fingerprint label. Never renders the value. */
export function fingerprintLabel(fingerprint: string | null, length: number | null): string {
  const digest = fingerprint
    ? `sha256:${fingerprint.slice(0, 10)}…`
    : t("pages.secrets.proposalReview.noFingerprint");
  const size = typeof length === "number"
    ? t("pages.secrets.proposalReview.bytes", { count: length })
    : null;
  return size ? `${digest} · ${size}` : digest;
}

/**
 * Fingerprint + length label. When a full digest is present the truncated form
 * is click-to-copy so an approver can verify a rotation against a known SHA-256
 * (10 hex chars isn't enough entropy to compare on sight). Never the value.
 */
export function FingerprintChip({
  fingerprint,
  length,
  className,
}: {
  fingerprint: string | null;
  length: number | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const { pushToast } = useToastActions();
  const label = fingerprintLabel(fingerprint, length);
  if (!fingerprint) {
    return (
      <span className={cn("inline-flex items-center gap-1 font-mono", className)}>
        <Fingerprint className="size-3 shrink-0" />
        {label}
      </span>
    );
  }
  const full = `sha256:${fingerprint}`;
  return (
    <button
      type="button"
      onClick={() => {
        copyTextToClipboard(full)
          .then(() =>
            pushToast({ title: t("pages.secrets.toasts.fingerprintCopied"), tone: "success" }),
          )
          .catch(() =>
            pushToast({ title: t("pages.secrets.toasts.fingerprintCopyFailed"), tone: "error" }),
          );
      }}
      title={t("pages.secrets.proposalReview.copyFullDigest", { digest: full })}
      className={cn(
        "inline-flex items-center gap-1 font-mono hover:text-foreground",
        className,
      )}
    >
      <Fingerprint className="size-3 shrink-0" />
      {label}
      <Copy className="size-3 shrink-0 opacity-60" />
    </button>
  );
}

/**
 * An agent-authored justification, framed as an *untrusted claim* rather than
 * trusted UI copy. The muted "Reason given by the agent" caption primes the
 * approver to read it skeptically — the Q0 social-engineering concern: an agent
 * can write "Pre-approved by the CEO" and otherwise inherit the interface's
 * credibility.
 */
export function ProposalJustification({
  justification,
  className,
}: {
  justification: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn("space-y-0.5", className)}>
      <p className="text-(length:--text-micro) text-muted-foreground">
        {t("pages.secrets.proposalReview.agentReason")}
      </p>
      <p className="whitespace-pre-wrap break-words text-xs text-foreground/80">
        “{justification}”
      </p>
    </div>
  );
}

/** Compact agent chip: icon + name. */
export function AgentRefChip({
  agent,
  className,
}: {
  agent: SecretProposalAgentRef;
  className?: string;
}) {
  useTranslation();
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      <AgentIcon icon={agent.icon ?? null} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{agent.name}</span>
    </span>
  );
}

/** Env-var vs API-access delivery badge for a binding `configPath`. */
export function DeliveryBadge({ configPath }: { configPath: string | null }) {
  const { t } = useTranslation();
  const mode = deliveryModeForConfigPath(configPath);
  const isEnv = mode === "env";
  const isApi = mode === "api";
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 gap-1 px-1.5 text-(length:--text-nano) font-normal",
        isEnv && "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
        isApi && "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
        !isEnv && !isApi && "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {isEnv ? <Variable className="size-3" /> : isApi ? <ServerCog className="size-3" /> : null}
      {t(`pages.secrets.delivery.${mode}`)}
    </Badge>
  );
}

/** Distinct "Proposed" pill used wherever a proposal is inlined among live rows. */
export function ProposedBadge({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 gap-1 px-1.5 text-(length:--text-nano) font-medium",
        "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <ShieldAlert className="size-3" /> {t("pages.secrets.status.proposed")}
    </Badge>
  );
}

/** The env KEY / access ALIAS a binding proposal delivers under, e.g. `GITHUB_TOKEN`. */
export function bindingEnvKey(proposal: SecretProposalView): string {
  return aliasFromConfigPath(proposal.configPath);
}

/** Human label for the secret a binding proposal references (live or cascade). */
export function bindingSecretLabel(proposal: SecretProposalView): {
  name: string;
  pending: boolean;
} {
  if (proposal.secretProposalId) {
    return {
      name: proposal.secretProposalName ?? t("pages.secrets.proposalReview.proposedSecret"),
      pending: true,
    };
  }
  return { name: proposal.secretName ?? t("pages.secrets.common.secret"), pending: false };
}

function readableError(error: unknown): string {
  if (error instanceof ApiError) return error.message || t("localizationSecrets.requestFailed", { status: error.status });
  if (error instanceof Error) return error.message;
  return t("pages.secrets.errors.genericRetry");
}

/* -------------------------------------------------------------------------- */
/* Review hook: approve/reject dialogs + mutations, shared across surfaces    */
/* -------------------------------------------------------------------------- */

interface ApproveDraft {
  proposal: SecretProposalView;
  // secret-kind editable fields (re-folder / rename before landing)
  folder: string;
  leaf: string;
  description: string;
  providerConfigId: string;
  // binding-kind: approve the pending dependency secret in the same transaction
  cascade: boolean;
}

export interface UseProposalReview {
  /** Open the approve confirm dialog for a proposal. */
  requestApprove: (proposal: SecretProposalView) => void;
  /** Open the reject (reason required) dialog for a proposal. */
  requestReject: (proposal: SecretProposalView) => void;
  /** True while an approve/reject request is in flight. */
  isBusy: boolean;
  /** Render once inside the surface — hosts both dialogs. */
  dialogs: React.ReactNode;
}

/**
 * Shared approve/reject workflow for secret & binding proposals. Both the
 * board Proposals tab and the agent-settings "Proposed" rows use this so the
 * confirm/reject affordances behave identically everywhere.
 */
export function useProposalReview(
  companyId: string | null,
  providerConfigs: CompanySecretProviderConfig[] = [],
): UseProposalReview {
  useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [approveDraft, setApproveDraft] = useState<ApproveDraft | null>(null);
  const [rejectTarget, setRejectTarget] = useState<SecretProposalView | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const invalidate = useCallback(() => {
    if (!companyId) return;
    queryClient.invalidateQueries({ queryKey: ["secret-proposals", companyId] });
    queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
  }, [companyId, queryClient]);

  const approveMutation = useMutation({
    mutationFn: (draft: ApproveDraft) => {
      const { proposal } = draft;
      if (proposal.kind === "secret") {
        const name = draft.folder.trim()
          ? `${draft.folder.trim().replace(/\/+$/, "")}/${draft.leaf.trim()}`
          : draft.leaf.trim();
        return secretsApi.approveProposal(companyId!, proposal.id, {
          overrides: {
            name,
            description: draft.description.trim() || null,
            providerConfigId: draft.providerConfigId || null,
          },
        });
      }
      return secretsApi.approveProposal(companyId!, proposal.id, {
        cascade: draft.cascade || undefined,
      });
    },
    onSuccess: (result) => {
      pushToast({
        title:
          result.kind === "secret"
            ? t("pages.secrets.toasts.secretApproved")
            : t("pages.secrets.toasts.bindingApproved"),
        body:
          result.kind === "secret"
            ? (result.proposedName ?? t("pages.secrets.toasts.secretCreated"))
            : `${result.target?.name ?? t("pages.secrets.common.agent")} · ${bindingEnvKey(result) || t("pages.secrets.common.binding")}`,
        tone: "success",
      });
      setApproveDraft(null);
      setError(null);
      invalidate();
    },
    onError: (err) => setError(readableError(err)),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ proposal, reason }: { proposal: SecretProposalView; reason: string }) =>
      secretsApi.rejectProposal(companyId!, proposal.id, { reason: reason.trim() }),
    onSuccess: (result) => {
      pushToast({
        title: t("pages.secrets.toasts.proposalRejected"),
        body: result.kind === "secret" ? (result.proposedName ?? undefined) : undefined,
        tone: "info",
      });
      setRejectTarget(null);
      setRejectReason("");
      setError(null);
      invalidate();
    },
    onError: (err) => setError(readableError(err)),
  });

  const requestApprove = useCallback(
    (proposal: SecretProposalView) => {
      setError(null);
      const segments = (proposal.proposedName ?? "").split("/");
      const leaf = segments.pop() ?? "";
      setApproveDraft({
        proposal,
        folder: segments.join("/"),
        leaf,
        description: proposal.proposedDescription ?? "",
        // "" = deployment default vault; the dialog dropdown lets the approver pick one.
        providerConfigId:
          providerConfigs.find(
            (config) => config.provider === "local_encrypted" && config.isDefault,
          )?.id ?? "",
        // A binding on a still-pending secret proposal REQUIRES cascade to land.
        cascade: Boolean(proposal.secretProposalId),
      });
    },
    [providerConfigs],
  );

  const requestReject = useCallback((proposal: SecretProposalView) => {
    setError(null);
    setRejectReason("");
    setRejectTarget(proposal);
  }, []);

  const dialogs = (
    <>
      <ApproveDialog
        draft={approveDraft}
        error={error}
        pending={approveMutation.isPending}
        providerConfigs={providerConfigs}
        onChange={setApproveDraft}
        onCancel={() => {
          setApproveDraft(null);
          setError(null);
        }}
        onConfirm={() => approveDraft && approveMutation.mutate(approveDraft)}
      />
      <RejectDialog
        proposal={rejectTarget}
        reason={rejectReason}
        error={error}
        pending={rejectMutation.isPending}
        onReasonChange={setRejectReason}
        onCancel={() => {
          setRejectTarget(null);
          setRejectReason("");
          setError(null);
        }}
        onConfirm={() =>
          rejectTarget && rejectMutation.mutate({ proposal: rejectTarget, reason: rejectReason })
        }
      />
    </>
  );

  return {
    requestApprove,
    requestReject,
    isBusy: approveMutation.isPending || rejectMutation.isPending,
    dialogs,
  };
}

/* -------------------------------------------------------------------------- */
/* Approve dialog                                                             */
/* -------------------------------------------------------------------------- */

function ApproveDialog({
  draft,
  error,
  pending,
  providerConfigs,
  onChange,
  onCancel,
  onConfirm,
}: {
  draft: ApproveDraft | null;
  error: string | null;
  pending: boolean;
  providerConfigs: CompanySecretProviderConfig[];
  onChange: (next: ApproveDraft) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const isSecret = draft?.proposal.kind === "secret";
  const previewName = draft
    ? draft.folder.trim()
      ? `${draft.folder.trim().replace(/\/+$/, "")}/${draft.leaf.trim()}`
      : draft.leaf.trim()
    : "";
  const localConfigs = providerConfigs.filter((config) => config.provider === "local_encrypted");
  const canConfirm = isSecret ? Boolean(draft && draft.leaf.trim()) : true;

  return (
    <Dialog open={Boolean(draft)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        {draft ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {isSecret
                  ? t("pages.secrets.proposalReview.approveCreateTitle")
                  : t("pages.secrets.proposalReview.approveBindingTitle")}
              </DialogTitle>
              <DialogDescription>
                {isSecret
                  ? t("pages.secrets.proposalReview.approveCreateDescription")
                  : t("pages.secrets.proposalReview.approveBindingDescription")}
              </DialogDescription>
            </DialogHeader>

            {/* Provenance recap — keeps the social-engineering surface visible. */}
            <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <span>{t("pages.secrets.proposalReview.proposedBy")}</span>
                <AgentRefChip agent={draft.proposal.proposedBy} className="font-medium text-foreground" />
              </div>
              <ProposalJustification justification={draft.proposal.justification} />
            </div>

            {isSecret ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="approve-folder">{t("pages.secrets.fields.folder")}</Label>
                    <Input
                      id="approve-folder"
                      value={draft.folder}
                      onChange={(event) => onChange({ ...draft, folder: event.target.value })}
                      placeholder="dev/github"
                      className="font-mono text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="approve-name">{t("pages.secrets.fields.name")}</Label>
                    <Input
                      id="approve-name"
                      value={draft.leaf}
                      onChange={(event) => onChange({ ...draft, leaf: event.target.value })}
                      placeholder="client-secret"
                      autoFocus
                      aria-invalid={!draft.leaf.trim()}
                      className="font-mono text-xs"
                    />
                  </div>
                </div>
                <p className="text-(length:--text-micro) text-muted-foreground">
                  {t("pages.secrets.proposalReview.landsAs")} {" "}
                  {previewName ? (
                    <SecretPathName name={previewName} className="font-mono" />
                  ) : (
                    <span className="italic">{t("pages.secrets.proposalReview.enterName")}</span>
                  )}
                </p>

                <div className="space-y-1">
                  <Label htmlFor="approve-description">
                    {t("pages.secrets.fields.description")}
                  </Label>
                  <Input
                    id="approve-description"
                    value={draft.description}
                    onChange={(event) => onChange({ ...draft, description: event.target.value })}
                    placeholder={t("pages.secrets.common.optionalPlain")}
                  />
                </div>

                {localConfigs.length > 0 ? (
                  <div className="space-y-1">
                    <Label htmlFor="approve-provider-config">
                      {t("pages.secrets.fields.providerVault")}
                    </Label>
                    <select
                      id="approve-provider-config"
                      value={draft.providerConfigId}
                      onChange={(event) =>
                        onChange({ ...draft, providerConfigId: event.target.value })
                      }
                      className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <option value="">{t("pages.secrets.common.deploymentDefault")}</option>
                      {localConfigs.map((config) => (
                        <option key={config.id} value={config.id}>
                          {config.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <div className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground">
                  <FingerprintChip
                    fingerprint={draft.proposal.valueFingerprintSha256}
                    length={draft.proposal.valueLength}
                  />
                </div>
              </div>
            ) : (
              <BindingApproveBody draft={draft} onChange={onChange} />
            )}

            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button variant="ghost" onClick={onCancel} disabled={pending}>
                {t("pages.secrets.actions.cancel")}
              </Button>
              <Button onClick={onConfirm} disabled={pending || !canConfirm}>
                {pending
                  ? t("pages.secrets.status.approving")
                  : isSecret
                    ? t("pages.secrets.actions.approveCreate")
                    : draft.cascade
                      ? t("pages.secrets.actions.approveSecretBind")
                      : t("pages.secrets.actions.approveBinding")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function BindingApproveBody({
  draft,
  onChange,
}: {
  draft: ApproveDraft;
  onChange: (next: ApproveDraft) => void;
}) {
  const { t } = useTranslation();
  const { proposal } = draft;
  const secret = bindingSecretLabel(proposal);
  const envKey = bindingEnvKey(proposal);
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t("pages.secrets.fields.targetAgent")}
          </span>
          {proposal.target ? (
            <AgentRefChip agent={proposal.target} className="text-sm font-medium" />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t("pages.secrets.fields.deliveredAs")}
          </span>
          <span className="flex items-center gap-1.5">
            <DeliveryBadge configPath={proposal.configPath} />
            <code className="font-mono text-xs">{envKey || proposal.configPath}</code>
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t("pages.secrets.common.secret")}
          </span>
          <span className="flex items-center gap-1.5">
            <KeyRound className="size-3.5 text-muted-foreground" />
            <span className="font-medium">{secret.name}</span>
            {secret.pending ? <ProposedBadge /> : null}
          </span>
        </div>
      </div>

      {/* Cascade pairing: the secret is itself still a pending proposal. */}
      {proposal.secretProposalId ? (
        <label className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs">
          <Checkbox
            checked={draft.cascade}
            onCheckedChange={(checked) => onChange({ ...draft, cascade: checked === true })}
            className="mt-0.5"
            aria-label={t("pages.secrets.proposalReview.alsoApproveAria")}
          />
          <span className="text-foreground/90">
            {t("pages.secrets.proposalReview.alsoApprovePrefix")} {" "}
            <span className="font-medium">{secret.name}</span>{" "}
            {t("pages.secrets.proposalReview.alsoApproveSuffix")}
          </span>
        </label>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Reject dialog                                                              */
/* -------------------------------------------------------------------------- */

function RejectDialog({
  proposal,
  reason,
  error,
  pending,
  onReasonChange,
  onCancel,
  onConfirm,
}: {
  proposal: SecretProposalView | null;
  reason: string;
  error: string | null;
  pending: boolean;
  onReasonChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const canConfirm = reason.trim().length > 0;
  return (
    <Dialog open={Boolean(proposal)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md">
        {proposal ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("pages.secrets.proposalReview.rejectTitle")}</DialogTitle>
              <DialogDescription>
                {t("pages.secrets.proposalReview.rejectDescriptionPrefix")} {" "}
                <AgentRefChip agent={proposal.proposedBy} className="text-foreground" />. {" "}
                {t("pages.secrets.proposalReview.rejectDescriptionSuffix")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <Label htmlFor="reject-reason">{t("pages.secrets.fields.reason")}</Label>
              <Textarea
                id="reject-reason"
                value={reason}
                onChange={(event) => onReasonChange(event.target.value)}
                rows={3}
                autoFocus
                placeholder={t("pages.secrets.proposalReview.rejectPlaceholder")}
              />
            </div>
            {error ? (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="ghost" onClick={onCancel} disabled={pending}>
                {t("pages.secrets.actions.cancel")}
              </Button>
              <Button variant="destructive" onClick={onConfirm} disabled={pending || !canConfirm}>
                {pending
                  ? t("pages.secrets.status.rejecting")
                  : t("pages.secrets.actions.reject")}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared approve/reject action buttons (with permission preflight)           */
/* -------------------------------------------------------------------------- */

export function ProposalActions({
  proposal,
  onApprove,
  onReject,
  disabled,
  size = "sm",
}: {
  proposal: SecretProposalView;
  onApprove: (proposal: SecretProposalView) => void;
  onReject: (proposal: SecretProposalView) => void;
  disabled?: boolean;
  size?: "sm" | "xs";
}) {
  const { t } = useTranslation();
  const blocked = !proposal.viewerCanApprove;
  const heightClass = size === "xs" ? "h-7 px-2 text-xs" : "";
  const approveButton = (
    <Button
      size="sm"
      className={heightClass}
      disabled={disabled || blocked}
      onClick={() => onApprove(proposal)}
    >
      {t("pages.secrets.actions.approve")}
    </Button>
  );
  return (
    <div className="flex items-center gap-1.5">
      {blocked ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{approveButton}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              {proposal.approveBlockReason ?? t("pages.secrets.proposalReview.noApprovePermission")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        approveButton
      )}
      <Button
        size="sm"
        variant="outline"
        className={heightClass}
        disabled={disabled}
        onClick={() => onReject(proposal)}
      >
        {t("pages.secrets.actions.reject")}
      </Button>
    </div>
  );
}
