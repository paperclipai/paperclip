import { t, useTranslation } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import type { AgentPermissions, TrustPreset } from "@paperclipai/shared";
import { Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, CollapsibleSection } from "./agent-config-primitives";
import {
  buildPermissionsForTrustPreset,
  clearSingleLowTrustBoundaryTarget,
  getLowTrustBoundary,
  getSingleLowTrustBoundaryTarget,
  getTrustPreset,
  isCeLowTrustBoundaryEditable,
  lowTrustBoundaryHasScope,
  setSingleLowTrustBoundaryTarget,
  summarizeLowTrustBoundaryTarget,
  TRUST_PRESET_DESCRIPTIONS,
  TRUST_PRESET_LABELS,
  type LowTrustBoundaryTarget,
} from "../lib/trust-policy-ui";
import { cn } from "../lib/utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function formatCount(value: readonly unknown[] | undefined, entity: string) {
  const count = value?.length ?? 0;
  if (count === 0) return "-";
  return t(`localizationAgents.trustCount_${entity}`, { count });
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  useTranslation();
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 text-right", value === "-" && "text-muted-foreground")}>{value}</span>
    </div>
  );
}

export interface LowTrustBoundaryCandidate {
  id: string;
  label: string;
}

type LowTrustBoundaryTargetType = LowTrustBoundaryTarget["type"];

const BOUNDARY_TARGET_LABELS: Record<LowTrustBoundaryTargetType, string> = {
  get project() { return t("localizationAgents.boundaryType_project"); },
  get root_issue() { return t("localizationAgents.boundaryType_root_issue"); },
  get issue() { return t("localizationAgents.boundaryType_issue"); },
};

export function TrustPresetSection({
  permissions,
  onChange,
  disabled,
  companyId,
  projectCandidates = [],
  issueCandidates = [],
  candidatesLoading,
}: {
  permissions: Partial<AgentPermissions> | null | undefined;
  onChange: (permissions: Partial<AgentPermissions>) => void;
  disabled?: boolean;
  companyId?: string | null;
  projectCandidates?: LowTrustBoundaryCandidate[];
  issueCandidates?: LowTrustBoundaryCandidate[];
  candidatesLoading?: boolean;
}) {
  const { t } = useTranslation();
  const [policyOpen, setPolicyOpen] = useState(false);
  const preset = getTrustPreset(permissions);
  const boundary = getLowTrustBoundary(permissions);
  const boundaryTarget = getSingleLowTrustBoundaryTarget(boundary);
  const [targetType, setTargetType] = useState<LowTrustBoundaryTargetType>(boundaryTarget?.type ?? "project");
  const lowTrust = preset === "low_trust_review";
  const hasScope = lowTrustBoundaryHasScope(boundary);
  const boundaryEditable = isCeLowTrustBoundaryEditable(boundary);
  const policy = permissions?.authorizationPolicy ?? null;
  const managedPermissions = useMemo(
    () => buildPermissionsForTrustPreset(permissions, preset),
    [permissions, preset],
  );

  useEffect(() => {
    if (boundaryTarget) setTargetType(boundaryTarget.type);
  }, [boundaryTarget?.type]);

  function handlePresetChange(value: string) {
    const nextPreset: TrustPreset = value === "low_trust_review" ? "low_trust_review" : "standard";
    onChange(buildPermissionsForTrustPreset(permissions, nextPreset));
  }

  function handleBoundaryTargetChange(targetId: string) {
    if (!companyId || !targetId) return;
    onChange(setSingleLowTrustBoundaryTarget(permissions, companyId, { type: targetType, id: targetId }));
  }

  function handleClearBoundary() {
    onChange(clearSingleLowTrustBoundaryTarget(permissions));
  }

  const targetCandidates = targetType === "project" ? projectCandidates : issueCandidates;
  const boundaryValue = boundaryTarget?.type === targetType ? boundaryTarget.id : "";

  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">{t("localizationAgents.ui235_Trust")}</h3>
      <div className="rounded-lg border border-border p-4 space-y-3">
        <Field label={t("localizationAgents.ui236_Trust_preset")} hint={t("localizationAgents.ui237_Choose_how_broadly_this_agent_can_read_and_act_on_Paperclip_")}>
          <select
            className={inputClass}
            value={preset}
            onChange={(event) => handlePresetChange(event.target.value)}
            disabled={disabled}
          >
            <option value="standard">{TRUST_PRESET_LABELS.standard}</option>
            <option value="low_trust_review">{TRUST_PRESET_LABELS.low_trust_review}</option>
          </select>
        </Field>
        <p className="text-xs text-muted-foreground">{TRUST_PRESET_DESCRIPTIONS[preset]}</p>

        {lowTrust ? (
          <div
            role={hasScope ? "status" : "alert"}
            aria-live="polite"
            className={cn(
              "rounded-md border px-3 py-2.5 text-sm flex gap-2",
              hasScope
                ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-100"
                : "border-destructive/30 bg-destructive/10 text-destructive",
            )}
          >
            {hasScope ? (
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <div className="min-w-0 flex-1 space-y-2">
              <div>
                <p className="font-medium">
                  {hasScope ? t("localizationAgents.ui238_Containment_active") : t("localizationAgents.ui239_Containment_not_configured")}
                </p>
                <p className="mt-1 text-xs leading-5">
                  {hasScope
                    ? t("localizationAgents.ui240_This_agent_can_only_read_and_mutate_work_inside_its_assigned")
                    : t("localizationAgents.ui241_This_agent_is_set_to_low_trust_review_but_no_project_root_is")}
                </p>
              </div>
              {boundaryEditable ? (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground space-y-3">
                  <div className="grid gap-3 sm:grid-cols-(--gtc-12)">
                    <Field label={t("localizationAgents.ui242_Boundary_type")}>
                      <select
                        className={inputClass}
                        value={targetType}
                        onChange={(event) => setTargetType(event.target.value as LowTrustBoundaryTargetType)}
                        disabled={disabled}
                      >
                        <option value="project">{t("localizationAgents.ui243_Project")}</option>
                        <option value="root_issue">{t("localizationAgents.ui244_Root_issue")}</option>
                        <option value="issue">{t("localizationAgents.ui245_Issue")}</option>
                      </select>
                    </Field>
                    <Field label={BOUNDARY_TARGET_LABELS[targetType]}>
                      <select
                        className={inputClass}
                        value={boundaryValue}
                        onChange={(event) => handleBoundaryTargetChange(event.target.value)}
                        disabled={disabled || !companyId || candidatesLoading || targetCandidates.length === 0}
                      >
                        <option value="">
                          {candidatesLoading
                            ? t("localizationAgents.ui246_Loading_")
                            : targetCandidates.length === 0
                              ? t(targetType === "project" ? "localizationAgents.noBoundaryProjects" : "localizationAgents.noBoundaryIssues")
                              : t("localizationAgents.ui248_Select_boundary")}
                        </option>
                        {targetCandidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">{t("localizationAgents.ui249_CE_saves_one_containment_boundary_at_a_time_Saved_policies_i")}</p>
                    {boundaryTarget ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        onClick={handleClearBoundary}
                        disabled={disabled}
                      >{t("localizationAgents.ui250_Clear_boundary")}</Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground">
                  <p className="text-sm font-medium">{t("localizationAgents.ui251_Managed_by_EE_API")}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("localizationAgents.boundaryManagedDescription", { boundary: summarizeLowTrustBoundaryTarget(boundary).toLowerCase() })}
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">{t("localizationAgents.ui254_Want_to_set_more_than_one_containment_boundary_")}{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://paperclip.ing/ee"
                  target="_blank"
                  rel="noreferrer"
                >{t("localizationAgents.ui255_Get_Paperclip_EE_")}</a>
              </p>
              <CollapsibleSection
                title={t("localizationAgents.ui256_View_policy")}
                open={policyOpen}
                onToggle={() => setPolicyOpen((open) => !open)}
              >
                <div className="divide-y divide-border/60 text-foreground">
                  <PolicyRow label={t("localizationAgents.ui257_Preset")} value={t("localizationAgents.lowTrustV1")} />
                  <PolicyRow label={t("localizationAgents.ui258_Raw_output")} value={t("localizationAgents.quarantined")} />
                  <PolicyRow label={t("localizationAgents.ui259_Projects")} value={formatCount(boundary?.projectIds, "project")} />
                  <PolicyRow label={t("localizationAgents.ui244_Root_issue")} value={boundary?.rootIssueId ? boundary.rootIssueId.slice(0, 8) : "-"} />
                  <PolicyRow label={t("localizationAgents.ui260_Explicit_issues")} value={formatCount(boundary?.issueIds, "issue")} />
                  <PolicyRow label={t("localizationAgents.ui261_Allowed_agents")} value={formatCount(boundary?.allowedAgentIds, "agent")} />
                  <PolicyRow label={t("localizationAgents.ui262_Allowed_tools")} value={boundary?.allowedToolClasses?.join(" · ") || "-"} />
                  <PolicyRow label={t("localizationAgents.ui263_Allowed_secrets")} value={formatCount(boundary?.allowedSecretBindingIds, "binding")} />
                  <PolicyRow label={t("localizationAgents.ui264_Promotion_target")} value={boundary?.outputPromotionTarget?.issueId?.slice(0, 8) ?? "-"} />
                  <PolicyRow
                    label={t("localizationAgents.ui265_EE_fields")}
                    value={Object.keys(policy ?? {}).some((key) => !["trustPreset", "reviewPreset", "trustBoundary"].includes(key))
                      ? t("localizationAgents.customPolicyFields")
                      : "-"}
                  />
                </div>
              </CollapsibleSection>
            </div>
          </div>
        ) : null}

        {managedPermissions.authorizationPolicy?.reviewPreset ? null : (
          <p className="text-xs text-muted-foreground">{t("localizationAgents.ui266_Advanced_permissions_remain_editable_through_the_EE_permissi")}</p>
        )}
      </div>
    </div>
  );
}
