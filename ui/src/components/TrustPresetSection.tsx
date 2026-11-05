import { useTranslation, t, i18n } from "@/i18n";
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
  TRUST_PRESET_DESCRIPTIONS,
  TRUST_PRESET_LABELS,
  type LowTrustBoundaryTarget,
} from "../lib/trust-policy-ui";
import { getAgentConfigDisplayText } from "../adapters/display-translations";
import { cn } from "../lib/utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function formatCount(value: readonly unknown[] | undefined, singular: string, plural: string) {
  const count = value?.length ?? 0;
  if (count === 0) return "-";
  return singular === "project" ? t("agent-config:countProjects", { count })
    : singular === "issue" ? t("agent-config:countIssues", { count })
    : singular === "agent" ? t("agent-config:countAgents", { count })
    : t("agent-config:countBindings", { count });
}

function PolicyRow({ label, value }: { label: string; value: string }) {
  useTranslation("agent-config");
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
  get project() { return t("agent-config:project_f6f4da8"); },
  get root_issue() { return t("agent-config:rootIssue_aa4650f"); },
  get issue() { return t("agent-config:issue_73781a1"); },
};

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
  const { t } = useTranslation("agent-config");
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
    [permissions, preset, i18n.resolvedLanguage],
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
                  {hasScope ? t("agent-config:containmentActive_363419e") : t("agent-config:containmentNotConfigured_f12feb9")}
                </p>
                <p className="mt-1 text-xs leading-5">
                  {hasScope
                    ? t("agent-config:thisAgentCanOnlyReadAndMutateWork_829fc1f")
                    : t("agent-config:thisAgentIsSetToLowTrustReview_123ec6e")}
                </p>
              </div>
              {projectAccessEditor && (boundary?.projectIds?.length ?? 0) > 1 ? null : boundaryEditable ? (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground space-y-3">
                  <div className="grid gap-3 sm:grid-cols-(--gtc-12)">
                    <Field label={t("agent-config:boundaryType_493a07d")}>
                      <select
                        className={inputClass}
                        value={targetType}
                        onChange={(event) => setTargetType(event.target.value as LowTrustBoundaryTargetType)}
                        disabled={disabled}
                      >
                        <option value="project">{t("agent-config:project_f6f4da8")}</option>
                        <option value="root_issue">{t("agent-config:rootIssue_aa4650f")}</option>
                        {allowSingleIssue && <option value="issue">{t("agent-config:issue_73781a1")}</option>}
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
                            ? t("agent-config:loading_33ce417")
                            : targetCandidates.length === 0
                              ? t("agent-config:noValueAvailable_f11a805", { value1: targetType === "project" ? "projects" : "issues" })
                              : t("agent-config:selectBoundary_4f8eb03")}
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
                    <p className="text-xs text-muted-foreground">{t("agent-config:ceSavesOneContainmentBoundaryAtATime_f45d6dc")}</p>
                    {boundaryTarget ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs"
                        onClick={handleClearBoundary}
                        disabled={disabled}
                      >{t("agent-config:clearBoundary_d680614")}</Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-border/70 bg-background/70 p-3 text-foreground">
                  <p className="text-sm font-medium">{t("agent-config:managedByEeApi_094ef82")}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("trustBoundaryManaged", { boundary: summarizeLowTrustBoundaryTarget(boundary).toLowerCase() })}</p>
                </div>
              )}
              {!projectAccessEditor && <p className="text-xs text-muted-foreground"> {t("agent-config:wantToSetMoreThanOneContainmentBoundary_2aaea83")}{" "}
                <a
                  className="underline underline-offset-2 hover:text-foreground"
                  href="https://paperclip.ing/ee"
                  target="_blank"
                  rel="noreferrer"
                >{t("agent-config:getPaperclipEe_43ce8c6")}</a>
              </p>}
              <CollapsibleSection
                title={t("agent-config:viewPolicy_7a56745")}
                open={policyOpen}
                onToggle={() => setPolicyOpen((open) => !open)}
              >
                <div className="divide-y divide-border/60 text-foreground">
                  <PolicyRow label={t("agent-config:preset_bca7887")} value={t("agent-config:lowTrustReviewV1_c4c2000")} />
                  <PolicyRow label={t("agent-config:rawOutput_4eb7eed")} value={t("agent-config:quarantinedFromHigherTrustAgents_8742f9d")} />
                  <PolicyRow label={t("agent-config:projects_53e890d")} value={formatCount(boundary?.projectIds, "project", "projects")} />
                  <PolicyRow label={t("agent-config:rootIssue_aa4650f")} value={boundary?.rootIssueId ? boundary.rootIssueId.slice(0, 8) : "-"} />
                  <PolicyRow label={t("agent-config:explicitIssues_1dc6aa3")} value={formatCount(boundary?.issueIds, "issue", "issues")} />
                  <PolicyRow label={t("agent-config:allowedAgents_955d29a")} value={formatCount(boundary?.allowedAgentIds, "agent", "agents")} />
                  <PolicyRow label={t("agent-config:allowedTools_36b4663")} value={boundary?.allowedToolClasses?.join(" · ") || "-"} />
                  <PolicyRow label={t("agent-config:allowedSecrets_dc63409")} value={formatCount(boundary?.allowedSecretBindingIds, "binding", "bindings")} />
                  <PolicyRow label={t("agent-config:promotionTarget_06f407a")} value={boundary?.outputPromotionTarget?.issueId?.slice(0, 8) ?? "-"} />
                  <PolicyRow
                    label={t("agent-config:eeFields_a00cccb")}
                    value={Object.keys(policy ?? {}).some((key) => !["trustPreset", "reviewPreset", "trustBoundary"].includes(key))
                      ? t("agent-config:customAdvancedPolicyFieldsPreserved_c2ad53d")
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
          <div role="radiogroup" aria-label={t("agent-config:trustPreset_65905bf")} className="contents">
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
                    <span className="text-sm font-semibold text-foreground">{getAgentConfigDisplayText(TRUST_PRESET_LABELS[value])}</span>
                    {selected ? <Check className="size-4 text-foreground" aria-hidden /> : null}
                  </span>
                  <span className="text-sm leading-5 text-muted-foreground">{getAgentConfigDisplayText(TRUST_PRESET_DESCRIPTIONS[value])}</span>
                </button>
              );
            })}
          </div>
          {aside}
        </div>
        {containment}
        {lowTrust ? projectAccessEditor : null}
        {managedPermissions.authorizationPolicy?.reviewPreset ? null : (
          <p className="text-xs text-muted-foreground">{t("agent-config:advancedPermissionsRemainEditableThroughTheEePermissions_77c3740")}</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <h3 className="mb-3 text-sm font-medium">{t("agent-config:trust_33a579f")}</h3>
      <div className="rounded-lg border border-border p-4 space-y-3">
        <Field label={t("agent-config:trustPreset_65905bf")} hint={t("agent-config:chooseHowBroadlyThisAgentCanReadAnd_ee3fc78")}>
          <select
            className={inputClass}
            value={preset}
            onChange={(event) => handlePresetChange(event.target.value)}
            disabled={disabled}
          >
            <option value="standard">{getAgentConfigDisplayText(TRUST_PRESET_LABELS.standard)}</option>
            <option value="low_trust_review">{getAgentConfigDisplayText(TRUST_PRESET_LABELS.low_trust_review)}</option>
          </select>
        </Field>
        <p className="text-xs text-muted-foreground">{getAgentConfigDisplayText(TRUST_PRESET_DESCRIPTIONS[preset])}</p>

        {containment}

        {lowTrust && projectAccessEditor}

        {managedPermissions.authorizationPolicy?.reviewPreset ? null : (
          <p className="text-xs text-muted-foreground">{t("agent-config:advancedPermissionsRemainEditableThroughTheEePermissions_77c3740")}</p>
        )}
      </div>
    </div>
  );
}
