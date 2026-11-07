import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentPermissions, TrustPreset } from "@paperclipai/shared";
import { Check, Lock, ShieldAlert } from "lucide-react";
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
  trustPresetDescriptions,
  trustPresetLabels,
  type LowTrustBoundaryTarget,
} from "../lib/trust-policy-ui";
import { cn } from "../lib/utils";
import { t, useTranslation } from "@/i18n";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function formatCount(value: readonly unknown[] | undefined, key: string) {
  const count = value?.length ?? 0;
  if (count === 0) return "-";
  return t(key, { count });
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

function boundaryTargetLabels(): Record<LowTrustBoundaryTargetType, string> {
  return {
    project: t("settings.TrustPresetSection.targetProject"),
    root_issue: t("settings.TrustPresetSection.targetRootIssue"),
    issue: t("settings.TrustPresetSection.targetIssue"),
  };
}

export function TrustPresetSection({
  permissions,
  onChange,
  disabled,
  companyId,
  projectCandidates = [],
  issueCandidates = [],
  candidatesLoading,
  allowSingleIssue = true,
  projectAccessEditor,
  layout = "select",
  aside,
}: {
  permissions: Partial<AgentPermissions> | null | undefined;
  onChange: (permissions: Partial<AgentPermissions>) => void;
  disabled?: boolean;
  companyId?: string | null;
  projectCandidates?: LowTrustBoundaryCandidate[];
  issueCandidates?: LowTrustBoundaryCandidate[];
  candidatesLoading?: boolean;
  allowSingleIssue?: boolean;
  projectAccessEditor?: ReactNode;
  /** "cards" shows the presets as selectable cards beside `aside` (the agent page). */
  layout?: "select" | "cards";
  aside?: ReactNode;
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

  const containment = lowTrust ? (
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
                  {hasScope ? t("settings.TrustPresetSection.containmentActive") : t("settings.TrustPresetSection.containmentNotConfigured")}
                </p>
                <p className="mt-1 text-xs leading-5">
                  {hasScope
                    ? t("settings.TrustPresetSection.scopeActiveNotice")
                    : t("settings.TrustPresetSection.scopeMissingNotice")}
                </p>
              </div>
              {projectAccessEditor && (boundary?.projectIds?.length ?? 0) > 1 ? null : boundaryEditable ? (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground space-y-3">
                  <div className="grid gap-3 sm:grid-cols-(--gtc-12)">
                    <Field label={t("settings.TrustPresetSection.boundaryType")}>
                      <select
                        className={inputClass}
                        value={targetType}
                        onChange={(event) => setTargetType(event.target.value as LowTrustBoundaryTargetType)}
                        disabled={disabled}
                      >
                        <option value="project">{t("settings.TrustPresetSection.targetProject")}</option>
                        <option value="root_issue">{t("settings.TrustPresetSection.targetRootIssue")}</option>
                        {allowSingleIssue && <option value="issue">{t("settings.TrustPresetSection.targetIssue")}</option>}
                      </select>
                    </Field>
                    <Field label={boundaryTargetLabels()[targetType]}>
                      <select
                        className={inputClass}
                        value={boundaryValue}
                        onChange={(event) => handleBoundaryTargetChange(event.target.value)}
                        disabled={disabled || !companyId || candidatesLoading || targetCandidates.length === 0}
                      >
                        <option value="">
                          {candidatesLoading
                            ? t("settings.TrustPresetSection.loading")
                            : targetCandidates.length === 0
                              ? (targetType === "project" ? t("settings.TrustPresetSection.noProjects") : t("settings.TrustPresetSection.noIssues"))
                              : t("settings.TrustPresetSection.selectBoundary")}
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
                      {t("settings.TrustPresetSection.ceNotice")}
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
                        {t("settings.TrustPresetSection.clearBoundary")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground">
                  <p className="text-sm font-medium">{t("settings.TrustPresetSection.managedByEe")}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {t("settings.TrustPresetSection.managedNotice", { summary: summarizeLowTrustBoundaryTarget(boundary).toLowerCase() })}
                  </p>
                </div>
              )}
              {!projectAccessEditor && <p className="text-xs text-muted-foreground">
                {t("settings.TrustPresetSection.moreBoundaries")}{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://paperclip.ing/ee"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("settings.TrustPresetSection.getEe")}
                </a>
              </p>}
              <CollapsibleSection
                title={t("settings.TrustPresetSection.viewPolicy")}
                open={policyOpen}
                onToggle={() => setPolicyOpen((open) => !open)}
              >
                <div className="divide-y divide-border/60 text-foreground">
                  <PolicyRow label={t("settings.TrustPresetSection.policyPreset")} value={t("settings.TrustPresetSection.policyPresetValue")} />
                  <PolicyRow label={t("settings.TrustPresetSection.policyRawOutput")} value={t("settings.TrustPresetSection.policyRawOutputValue")} />
                  <PolicyRow label={t("settings.TrustPresetSection.policyProjects")} value={formatCount(boundary?.projectIds, "settings.TrustPresetSection.projectCount")} />
                  <PolicyRow label={t("settings.TrustPresetSection.targetRootIssue")} value={boundary?.rootIssueId ? boundary.rootIssueId.slice(0, 8) : "-"} />
                  <PolicyRow label={t("settings.TrustPresetSection.policyIssues")} value={formatCount(boundary?.issueIds, "settings.TrustPresetSection.issueCount")} />
                  <PolicyRow label={t("settings.TrustPresetSection.policyAgents")} value={formatCount(boundary?.allowedAgentIds, "settings.TrustPresetSection.agentCount")} />
                  <PolicyRow label={t("settings.TrustPresetSection.policyTools")} value={boundary?.allowedToolClasses?.join(" · ") || "-"} />
                  <PolicyRow label={t("settings.TrustPresetSection.policySecrets")} value={formatCount(boundary?.allowedSecretBindingIds, "settings.TrustPresetSection.bindingCount")} />
                  <PolicyRow label={t("settings.TrustPresetSection.policyPromotion")} value={boundary?.outputPromotionTarget?.issueId?.slice(0, 8) ?? "-"} />
                  <PolicyRow
                    label={t("settings.TrustPresetSection.policyEeFields")}
                    value={Object.keys(policy ?? {}).some((key) => !["trustPreset", "reviewPreset", "trustBoundary"].includes(key))
                      ? t("settings.TrustPresetSection.policyEeFieldsValue")
                      : "-"}
                  />
                </div>
              </CollapsibleSection>
            </div>
          </div>
        ) : null;

  if (layout === "cards") {
    return (
      <div className="flex flex-col gap-(--agent-detail-module-gap)">
        <div className="grid gap-(--agent-detail-module-gap) sm:grid-cols-3">
          <div role="radiogroup" aria-label={t("settings.TrustPresetSection.presetLabel")} className="contents">
            {(["low_trust_review", "standard"] as const).map((value) => {
              const selected = preset === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-agent-tile=""
                  disabled={disabled}
                  onClick={() => (selected ? undefined : handlePresetChange(value))}
                  className={cn(
                    "flex min-h-(--agent-detail-tile-min-h) flex-col gap-2 rounded-lg border bg-(--agent-detail-tile) p-(--agent-detail-module-inset) text-left transition-colors outline-none hover:bg-(--agent-detail-tile-hover) focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                    selected ? "border-foreground" : "border-transparent",
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{trustPresetLabels()[value]}</span>
                    {selected ? <Check className="size-4 text-foreground" aria-hidden /> : null}
                  </span>
                  <span className="text-sm leading-5 text-muted-foreground">{trustPresetDescriptions()[value]}</span>
                </button>
              );
            })}
          </div>
          {aside}
        </div>
        {containment}
        {lowTrust ? projectAccessEditor : null}
        {managedPermissions.authorizationPolicy?.reviewPreset ? null : (
          <p className="text-xs text-muted-foreground">
            {t("settings.TrustPresetSection.advancedNotice")}
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">{t("settings.TrustPresetSection.title")}</h3>
      <div className="rounded-lg border border-border p-4 space-y-3">
        <Field label={t("settings.TrustPresetSection.presetField")} hint={t("settings.TrustPresetSection.presetHint")}>
          <select
            className={inputClass}
            value={preset}
            onChange={(event) => handlePresetChange(event.target.value)}
            disabled={disabled}
          >
            <option value="standard">{trustPresetLabels().standard}</option>
            <option value="low_trust_review">{trustPresetLabels().low_trust_review}</option>
          </select>
        </Field>
        <p className="text-xs text-muted-foreground">{trustPresetDescriptions()[preset]}</p>

        {containment}

        {lowTrust && projectAccessEditor}

        {managedPermissions.authorizationPolicy?.reviewPreset ? null : (
          <p className="text-xs text-muted-foreground">
            {t("settings.TrustPresetSection.advancedNotice")}
          </p>
        )}
      </div>
    </div>
  );
}
