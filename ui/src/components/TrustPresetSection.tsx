import { useEffect, useMemo, useState } from "react";
import type { AgentPermissions, TrustPreset } from "@paperclipai/shared";
import { Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, CollapsibleSection } from "./agent-config-primitives";
import { useTranslation, t } from "@/i18n";
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

function formatCount(value: readonly unknown[] | undefined, singular: string, plural: string) {
  const count = value?.length ?? 0;
  if (count === 0) return "-";
  return t("components.trustPresetSection.itemCount", {
    count,
    noun: count === 1 ? singular : plural,
    defaultValue: "{{count}} {{noun}}",
    defaultValue_other: "{{count}} {{noun}}",
  });
}

function PolicyRow({ label, value }: { label: string; value: string }) {
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

const getBoundaryTargetLabels = (): Record<LowTrustBoundaryTargetType, string> => ({
  project: t("components.trustPresetSection.boundaryTypeProject", { defaultValue: "Project" }),
  root_issue: t("components.trustPresetSection.boundaryTypeRootIssue", { defaultValue: "Root issue" }),
  issue: t("components.trustPresetSection.boundaryTypeIssue", { defaultValue: "Issue" }),
});

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
      <h3 className="mb-3 text-sm font-medium">{t("components.trustPresetSection.heading", { defaultValue: "Trust" })}</h3>
      <div className="rounded-lg border border-border p-4 space-y-3">
        <Field
          label={t("components.trustPresetSection.trustPresetLabel", { defaultValue: "Trust preset" })}
          hint={t("components.trustPresetSection.trustPresetHint", { defaultValue: "Choose how broadly this agent can read and act on Paperclip work objects." })}
        >
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
                  {hasScope
                    ? t("components.trustPresetSection.containmentActive", { defaultValue: "Containment active" })
                    : t("components.trustPresetSection.containmentNotConfigured", { defaultValue: "Containment not configured" })}
                </p>
                <p className="mt-1 text-xs leading-5">
                  {hasScope
                    ? t("components.trustPresetSection.containmentActiveDescription", { defaultValue: "This agent can only read and mutate work inside its assigned review boundary. Raw output is quarantined from higher-trust agents until a trusted reviewer promotes it." })
                    : t("components.trustPresetSection.containmentNotConfiguredDescription", { defaultValue: "This agent is set to low-trust review, but no project, root issue, or issue scope is set in the core policy. Add a scope before this agent can run without denial." })}
                </p>
              </div>
              {boundaryEditable ? (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground space-y-3">
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,0.75fr)_minmax(0,1fr)]">
                    <Field label={t("components.trustPresetSection.boundaryTypeLabel", { defaultValue: "Boundary type" })}>
                      <select
                        className={inputClass}
                        value={targetType}
                        onChange={(event) => setTargetType(event.target.value as LowTrustBoundaryTargetType)}
                        disabled={disabled}
                      >
                        <option value="project">{t("components.trustPresetSection.boundaryTypeProject", { defaultValue: "Project" })}</option>
                        <option value="root_issue">{t("components.trustPresetSection.boundaryTypeRootIssue", { defaultValue: "Root issue" })}</option>
                        <option value="issue">{t("components.trustPresetSection.boundaryTypeIssue", { defaultValue: "Issue" })}</option>
                      </select>
                    </Field>
                    <Field label={getBoundaryTargetLabels()[targetType]}>
                      <select
                        className={inputClass}
                        value={boundaryValue}
                        onChange={(event) => handleBoundaryTargetChange(event.target.value)}
                        disabled={disabled || !companyId || candidatesLoading || targetCandidates.length === 0}
                      >
                        <option value="">
                          {candidatesLoading
                            ? t("components.trustPresetSection.loading", { defaultValue: "Loading…" })
                            : targetCandidates.length === 0
                              ? t("components.trustPresetSection.noCandidatesAvailable", {
                                  items:
                                    targetType === "project"
                                      ? t("components.trustPresetSection.nounProjectPlural", { defaultValue: "projects" })
                                      : t("components.trustPresetSection.nounIssuePlural", { defaultValue: "issues" }),
                                  defaultValue: "No {{items}} available",
                                })
                              : t("components.trustPresetSection.selectBoundary", { defaultValue: "Select boundary" })}
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
                    <p className="text-xs text-muted-foreground">
                      {t("components.trustPresetSection.ceSingleBoundaryNote", { defaultValue: "CE saves one containment boundary at a time. Saved policies include this company id." })}
                    </p>
                    {boundaryTarget ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        onClick={handleClearBoundary}
                        disabled={disabled}
                      >
                        {t("components.trustPresetSection.clearBoundary", { defaultValue: "Clear boundary" })}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground">
                  <p className="text-sm font-medium">{t("components.trustPresetSection.managedByEeApi", { defaultValue: "Managed by EE/API" })}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("components.trustPresetSection.managedByEeApiDescription", {
                      summary: summarizeLowTrustBoundaryTarget(boundary).toLowerCase(),
                      defaultValue: "This policy has {{summary}} and cannot be edited by the CE single-boundary editor.",
                    })}
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t("components.trustPresetSection.multipleBoundariesPrompt", { defaultValue: "Want to set more than one containment boundary?" })}{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://paperclip.ing/ee"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("components.trustPresetSection.getPaperclipEe", { defaultValue: "Get Paperclip EE." })}
                </a>
              </p>
              <CollapsibleSection
                title={t("components.trustPresetSection.viewPolicy", { defaultValue: "View policy" })}
                open={policyOpen}
                onToggle={() => setPolicyOpen((open) => !open)}
              >
                <div className="divide-y divide-border/60 text-foreground">
                  <PolicyRow
                    label={t("components.trustPresetSection.policyRowPreset", { defaultValue: "Preset" })}
                    value={t("components.trustPresetSection.policyValuePreset", { defaultValue: "Low-trust review v1" })}
                  />
                  <PolicyRow
                    label={t("components.trustPresetSection.policyRowRawOutput", { defaultValue: "Raw output" })}
                    value={t("components.trustPresetSection.policyValueRawOutput", { defaultValue: "Quarantined from higher-trust agents" })}
                  />
                  <PolicyRow
                    label={t("components.trustPresetSection.policyRowProjects", { defaultValue: "Projects" })}
                    value={formatCount(
                      boundary?.projectIds,
                      t("components.trustPresetSection.nounProjectSingular", { defaultValue: "project" }),
                      t("components.trustPresetSection.nounProjectPlural", { defaultValue: "projects" }),
                    )}
                  />
                  <PolicyRow
                    label={t("components.trustPresetSection.policyRowRootIssue", { defaultValue: "Root issue" })}
                    value={boundary?.rootIssueId ? boundary.rootIssueId.slice(0, 8) : "-"}
                  />
                  <PolicyRow
                    label={t("components.trustPresetSection.policyRowExplicitIssues", { defaultValue: "Explicit issues" })}
                    value={formatCount(
                      boundary?.issueIds,
                      t("components.trustPresetSection.nounIssueSingular", { defaultValue: "issue" }),
                      t("components.trustPresetSection.nounIssuePlural", { defaultValue: "issues" }),
                    )}
                  />
                  <PolicyRow
                    label={t("components.trustPresetSection.policyRowAllowedAgents", { defaultValue: "Allowed agents" })}
                    value={formatCount(
                      boundary?.allowedAgentIds,
                      t("components.trustPresetSection.nounAgentSingular", { defaultValue: "agent" }),
                      t("components.trustPresetSection.nounAgentPlural", { defaultValue: "agents" }),
                    )}
                  />
                  <PolicyRow
                    label={t("components.trustPresetSection.policyRowAllowedTools", { defaultValue: "Allowed tools" })}
                    value={boundary?.allowedToolClasses?.join(" · ") || "-"}
                  />
                  <PolicyRow
                    label={t("components.trustPresetSection.policyRowAllowedSecrets", { defaultValue: "Allowed secrets" })}
                    value={formatCount(
                      boundary?.allowedSecretBindingIds,
                      t("components.trustPresetSection.nounBindingSingular", { defaultValue: "binding" }),
                      t("components.trustPresetSection.nounBindingPlural", { defaultValue: "bindings" }),
                    )}
                  />
                  <PolicyRow
                    label={t("components.trustPresetSection.policyRowPromotionTarget", { defaultValue: "Promotion target" })}
                    value={boundary?.outputPromotionTarget?.issueId?.slice(0, 8) ?? "-"}
                  />
                  <PolicyRow
                    label={t("components.trustPresetSection.policyRowEeFields", { defaultValue: "EE fields" })}
                    value={Object.keys(policy ?? {}).some((key) => !["trustPreset", "reviewPreset", "trustBoundary"].includes(key))
                      ? t("components.trustPresetSection.policyValueEeFieldsPreserved", { defaultValue: "Custom advanced policy fields preserved" })
                      : "-"}
                  />
                </div>
              </CollapsibleSection>
            </div>
          </div>
        ) : null}

        {managedPermissions.authorizationPolicy?.reviewPreset ? null : (
          <p className="text-xs text-muted-foreground">
            {t("components.trustPresetSection.advancedPermissionsEe", { defaultValue: "Advanced permissions remain editable through the EE permissions extension when installed." })}
          </p>
        )}
      </div>
    </div>
  );
}
