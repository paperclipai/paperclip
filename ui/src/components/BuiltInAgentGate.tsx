import { useTranslation } from "@/i18n";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Clock3 } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { InlineBanner } from "@/components/InlineBanner";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { ConfigureBuiltInAgentModal } from "@/components/ConfigureBuiltInAgentModal";
import { builtInAgentsApi, type BuiltInAgentState } from "@/api/builtInAgents";
import { agentsApi } from "@/api/agents";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { agentUrl } from "@/lib/utils";
import { relativeTime } from "@/lib/utils";

export interface BuiltInAgentGateProps {
  /** Registry key of the built-in agent that powers this feature (e.g. "briefs"). */
  agentKey: string;
  companyId: string | null | undefined;
  /** Human label for the gated feature. Defaults to the agent's display name. */
  featureLabel?: string;
  children: ReactNode;
}

/**
 * Wraps a feature surface that depends on a built-in agent and renders the
 * right lifecycle state (ux-spec §4):
 *
 * - loading → skeleton
 * - not_provisioned / needs_setup → setup empty-state + configure modal CTA
 * - paused → amber banner + Resume over the (stale) children
 * - ready → children
 */
export function BuiltInAgentGate({ agentKey, companyId, featureLabel, children }: BuiltInAgentGateProps) {
  const { t } = useTranslation("agent-config");
  const queryClient = useQueryClient();
  const [configureOpen, setConfigureOpen] = useState(false);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const builtInAgentsEnabled = experimentalQuery.data?.enableBuiltInAgents === true;
  const { data: states, isLoading: statesLoading } = useQuery({
    queryKey: queryKeys.builtInAgents.list(companyId ?? "__none__"),
    queryFn: () => builtInAgentsApi.list(companyId!),
    enabled: Boolean(companyId && builtInAgentsEnabled),
  });

  const state: BuiltInAgentState | undefined = states?.find((entry) => entry.definition.key === agentKey);

  const resume = useMutation({
    mutationFn: (agentId: string) => agentsApi.resume(agentId, companyId ?? undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.builtInAgents.list(companyId ?? "__none__") });
      if (companyId) queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
    },
  });

  // Unknown key or still resolving the company — fail open to the feature.
  if (!companyId) return <>{children}</>;
  if ((experimentalQuery.isLoading || statesLoading) && !states) return <PageSkeleton variant="detail" />;
  if (!state) return <>{children}</>;

  const label = featureLabel ?? state.definition.displayName;

  if (state.status === "not_provisioned" || state.status === "needs_setup") {
    return (
      <>
        <EmptyState
          icon={Bot}
          title={t("agent-config:setUpTheValue_a591996", { value1: state.definition.displayName })}
          message={t("agent-config:valueIsGeneratedByABuiltInAgent_cd4470e", { value1: label })}
          action={t("agent-config:setUpValue_83d26d6", { value1: state.definition.displayName })}
          onAction={() => setConfigureOpen(true)}
          hideActionIcon
        />
        <ConfigureBuiltInAgentModal
          companyId={companyId}
          state={state}
          open={configureOpen}
          onOpenChange={setConfigureOpen}
        />
      </>
    );
  }

  if (state.status === "pending_approval") {
    return (
      <EmptyState
        icon={Clock3}
        title={t("agent-config:valueIsPendingApproval_c438d1f", { value1: state.definition.displayName })}
        message={t("agent-config:valueWillBeAvailableAfterTheBoardApproves_cc2dd46", { value1: label })}
      />
    );
  }

  if (state.status === "paused" && state.agent) {
    const pausedAt = state.agent.pausedAt ? relativeTime(state.agent.pausedAt) : null;
    return (
      <div className="space-y-4">
        <InlineBanner
          tone="warning"
          title={t("agent-config:valueIsPaused_9beccd9", { value1: label })}
          actions={
            <>
              <Button variant="ghost" size="sm" asChild>
                <Link to={agentUrl(state.agent)}>{t("agent-config:viewAgent_98f8d9f")}</Link>
              </Button>
              <Button
                size="sm"
                onClick={() => state.agent && resume.mutate(state.agent.id)}
                disabled={resume.isPending}
              >
                {resume.isPending ? t("agent-config:resuming_ab0bec1") : t("agent-config:resumeAgent_4bfc7e4")}
              </Button>
            </>
          }
        > {pausedAt ? t("pausedFeatureAt", { time: pausedAt, feature: label.toLowerCase() }) : t("pausedFeature", { feature: label.toLowerCase() })}</InlineBanner>
        {/* Paused ≠ hidden: keep existing content readable, marked stale. */}
        <div className="opacity-70">{children}</div>
      </div>
    );
  }

  return <>{children}</>;
}
