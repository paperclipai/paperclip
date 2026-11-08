import { t as finalPagesT } from "@/i18n";
import { t as translateAgentPage, useTranslation } from "@/i18n";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ExternalLink,
  Inbox,
  KeyRound,
  Link2,
  Loader2,
} from "lucide-react";
import type { CompanySecretProviderConfig, SecretProposalView } from "@paperclipai/shared";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { secretsApi } from "../../api/secrets";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { EmptyState } from "../../components/EmptyState";
import { SecretPathName } from "./SecretPathName";
import {
  AgentRefChip,
  DeliveryBadge,
  FingerprintChip,
  ProposalActions,
  ProposalJustification,
  ProposedBadge,
  bindingEnvKey,
  bindingSecretLabel,
  useProposalReview,
} from "./proposal-review";

/** ISO expiry → "expires in 12d" / "expires in 5h" / "expired". */
function expiryLabel(expiresAt: string): { text: string; urgent: boolean } {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return { text: translateAgentPage("agents:no_expiry"), urgent: false };
  if (ms <= 0) return { text: translateAgentPage("agents:expired"), urgent: true };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return { text: finalPagesT("final-pages:expires_in_hours_h_96988b", { hours }), urgent: true };
  const days = Math.floor(hours / 24);
  return { text: finalPagesT("final-pages:expires_in_days_d_73c56b", { days }), urgent: days <= 2 };
}

function ProposalRow({
  proposal,
  onApprove,
  onReject,
  disabled,
}: {
  proposal: SecretProposalView;
  onApprove: (p: SecretProposalView) => void;
  onReject: (p: SecretProposalView) => void;
  disabled: boolean;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const isSecret = proposal.kind === "secret";
  const expiry = expiryLabel(proposal.expiresAt);
  const secret = bindingSecretLabel(proposal);
  const envKey = bindingEnvKey(proposal);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-start sm:gap-3">
      <span
        className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground"
        aria-hidden="true"
      >
        {isSecret ? <KeyRound className="size-3.5" /> : <Link2 className="size-3.5" />}
      </span>

      <div className="min-w-0 flex-1 space-y-1.5">
        {/* Headline */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {isSecret ? (
            <SecretPathName name={proposal.proposedName ?? "—"} className="text-sm" />
          ) : (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
              {proposal.target ? (
                <AgentRefChip agent={proposal.target} className="font-medium" />
              ) : (
                <span className="text-muted-foreground">{translateAgentPage("agents:agent")}</span>
              )}
              <DeliveryBadge configPath={proposal.configPath} />
              <code className="font-mono text-xs">{envKey || proposal.configPath}</code>
              <ArrowRight className="size-3 text-muted-foreground" />
              <span className="inline-flex items-center gap-1">
                <KeyRound className="size-3 text-muted-foreground" />
                <span className="font-medium">{secret.name}</span>
                {secret.pending ? <ProposedBadge /> : null}
              </span>
            </span>
          )}
        </div>

        {/* Provenance meta */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">{translateAgentPage("agents:by")}{" "}<AgentRefChip agent={proposal.proposedBy} className="font-medium text-foreground" />
          </span>
          {proposal.originIssue ? (
            <>
              <span aria-hidden="true">·</span>
              <Link
                to={`/issues/${proposal.originIssue.key}`}
                className="inline-flex items-center gap-1 font-mono hover:text-foreground hover:underline"
                title={proposal.originIssue.title}
              >
                {proposal.originIssue.key}
                <ExternalLink className="size-3" />
              </Link>
            </>
          ) : null}
          {isSecret ? (
            <>
              <span aria-hidden="true">·</span>
              <FingerprintChip
                fingerprint={proposal.valueFingerprintSha256}
                length={proposal.valueLength}
              />
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span className={cn(expiry.urgent && "text-amber-600 dark:text-amber-400")}>
            {expiry.text}
          </span>
        </div>

        {/* Justification (agent-authored — framed as an untrusted claim). */}
        <ProposalJustification justification={proposal.justification} />
      </div>

      <div className="shrink-0 sm:pt-0.5">
        <ProposalActions
          proposal={proposal}
          onApprove={onApprove}
          onReject={onReject}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

export function ProposalsTab({
  companyId,
  providerConfigs,
}: {
  companyId: string;
  providerConfigs: CompanySecretProviderConfig[];
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const proposalsQuery = useQuery({
    queryKey: queryKeys.secrets.proposals(companyId, "pending"),
    queryFn: () => secretsApi.listProposals(companyId, "pending"),
    enabled: Boolean(companyId),
  });

  const proposalsView = useQueryView(proposalsQuery);
  const review = useProposalReview(companyId, providerConfigs);
  const proposals = proposalsQuery.data ?? EMPTY_PROPOSALS;

  // Secret proposals first, then bindings — an approver usually lands the
  // secret before (or alongside) the bindings that depend on it.
  const sorted = useMemo(
    () =>
      [...proposals].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === "secret" ? -1 : 1;
        return a.createdAt.localeCompare(b.createdAt);
      }),
    [proposals],
  );

  if (proposalsView.kind === "error") {
    return (
      <div className="py-4">
        <QueryErrorState
          error={proposalsQuery.error}
          action={translateAgentPage("agents:load_proposals")}
          onRetry={proposalsView.retry}
          retrying={proposalsView.isFetching}
        />
      </div>
    );
  }

  if (proposalsQuery.isPending || proposalsView.kind === "reconnecting") {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />{" "}{translateAgentPage("agents:loading_proposals")}</div>
    );
  }

  if (sorted.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title={translateAgentPage("agents:no_pending_proposals")}
        message={translateAgentPage("agents:when_an_agent_proposes_a_secret_or_an")}
      />
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{translateAgentPage("agents:agents_propose_credentials_and_access_bindings_you_approve")}</p>
      {sorted.map((proposal) => (
        <ProposalRow
          key={proposal.id}
          proposal={proposal}
          onApprove={review.requestApprove}
          onReject={review.requestReject}
          disabled={review.isBusy}
        />
      ))}
      {review.dialogs}
    </div>
  );
}

const EMPTY_PROPOSALS: SecretProposalView[] = [];
