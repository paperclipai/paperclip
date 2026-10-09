import { DecisionModelSettingsSection } from "../components/decision-models/DecisionModelSettings";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  type Company,
  type InteractionResolverGovernance,
  type IssueThreadInteractionKind,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useOptionalToastActions } from "../context/ToastContext";
import { useCloudInstance } from "../hooks/useCloudInstance";
import { resolveCompanyArchiveDeparture } from "../lib/company-selection";
import { cloudPortfolioManageUrl } from "../lib/cloudLinks";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { companiesApi } from "../api/companies";
import { type CompanyListResult } from "../api/companies-query";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { SlidersHorizontal } from "lucide-react";
import {
  InteractionGovernancePanel,
  applyGovernanceChange,
  type GovernanceField,
  type GovernanceSelectValue,
} from "../components/InteractionGovernancePanel";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import {
  Field,
  ToggleField,
} from "../components/agent-config-primitives";
import { InstanceGeneralSettings } from "./InstanceGeneralSettings";

export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toastActions = useOptionalToastActions();
  const cloud = useCloudInstance();
  // Managed instances derive the task ID prefix from the company name, so a
  // rename here also renumbers the existing task IDs.
  const isCloudManaged = Boolean(cloud);
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);
  const [governance, setGovernance] = useState<InteractionResolverGovernance>({});
  const [defaultExecutionPolicyText, setDefaultExecutionPolicyText] = useState("");
  const [defaultExecutionPolicyError, setDefaultExecutionPolicyError] = useState<string | null>(null);

  // Whether the draft has unsaved edits since it was last synced from the
  // server. Set on every textarea keystroke, cleared whenever the draft is
  // freshly synced from selectedCompany.defaultExecutionPolicy or right
  // after a successful save. This (not the companyId check below) is what
  // protects an in-progress edit from being clobbered by an unrelated
  // background refetch (e.g. after toggling requireBoardApprovalForNewAgents).
  const [defaultExecutionPolicyDirty, setDefaultExecutionPolicyDirty] = useState(false);

  // The text of the most recent save that actually completed for the
  // selected company, regardless of what the draft looks like now. Backs the
  // "Saved" label below: `mutation.isSuccess` alone only means a request
  // once settled, not that the visible draft is what it saved -- the user
  // may have kept typing (or the company may have changed) after clicking
  // Save but before the response landed, in which case the draft holds a
  // newer, still-unsaved edit and must not be labeled "Saved".
  const lastSavedDefaultExecutionPolicyTextRef = useRef<string | null>(null);

  // Tracks which company's defaultExecutionPolicy is currently loaded into
  // the draft textarea. A company switch always re-syncs (and discards any
  // unsaved draft for the company being left) regardless of dirty state --
  // otherwise an edited-but-unsaved draft for the previous company would
  // keep showing under the newly-selected company.
  const [defaultExecutionPolicySyncedCompanyId, setDefaultExecutionPolicySyncedCompanyId] =
    useState<string | null>(null);

  // Which company's name/description/logo/governance are currently loaded
  // into local state. selectedCompany's object identity changes on every
  // refetch of the company list -- including one triggered by saving the
  // unrelated defaultExecutionPolicy draft below (its onSuccess calls
  // invalidateQueries) -- not just when the user switches companies. Without
  // this, any such refetch would re-run the sync effect and stomp an
  // unsaved name/description edit even though nothing the user typed here
  // caused it.
  const [generalSyncedCompanyId, setGeneralSyncedCompanyId] = useState<
    string | null
  >(null);

  // Whether the user has edited name/description since the last sync from
  // selectedCompany or a successful save. Tracked explicitly (not derived
  // by diffing companyName/description against selectedCompany) so an
  // unrelated refetch that changes selectedCompany's own name/description
  // (e.g. another tab saved first) isn't misread as a local edit -- that
  // would both block the resync below and offer to write our stale draft
  // back over the other tab's change. Mirrors defaultExecutionPolicyDirty
  // above.
  const [generalDirty, setGeneralDirty] = useState(false);

  // Sync general (name/description/logo/governance) local state from the
  // selected company. Refresh on a company switch (even if the outgoing
  // draft was dirty), or whenever the draft is clean -- so an external
  // update (e.g. the policy save's refetch above) is reflected. Never
  // overwrite a dirty, same-company draft.
  useEffect(() => {
    if (!selectedCompany) return;
    const companyChanged = selectedCompany.id !== generalSyncedCompanyId;
    if (companyChanged || !generalDirty) {
      setCompanyName(selectedCompany.name);
      setDescription(selectedCompany.description ?? "");
      setLogoUrl(selectedCompany.logoUrl ?? "");
      setGovernance(selectedCompany.interactionResolverGovernance ?? {});
      setGeneralSyncedCompanyId(selectedCompany.id);
      setGeneralDirty(false);
    }
  }, [selectedCompany, generalSyncedCompanyId, generalDirty]);

  // Sync the default execution policy draft from the selected company.
  useEffect(() => {
    if (!selectedCompany) return;
    const companyChanged = selectedCompany.id !== defaultExecutionPolicySyncedCompanyId;
    // Refresh the draft on a company switch (even if the outgoing draft was
    // dirty), or whenever the draft is clean -- so an external update to the
    // same company's policy (e.g. a background refetch after another tab
    // changed it) is reflected. Never overwrite a dirty, same-company draft.
    if (companyChanged || !defaultExecutionPolicyDirty) {
      setDefaultExecutionPolicyText(
        selectedCompany.defaultExecutionPolicy
          ? JSON.stringify(selectedCompany.defaultExecutionPolicy, null, 2)
          : ""
      );
      setDefaultExecutionPolicyError(null);
      setDefaultExecutionPolicyDirty(false);
      setDefaultExecutionPolicySyncedCompanyId(selectedCompany.id);
    }
  }, [selectedCompany, defaultExecutionPolicySyncedCompanyId, defaultExecutionPolicyDirty]);

  const generalMutation = useMutation({
    mutationFn: (data: {
      companyId: string;
      name: string;
      description: string | null;
    }) => companiesApi.update(data.companyId, { name: data.name, description: data.description }),
    onSuccess: (result, variables) => {
      // Patch the company-list cache synchronously, same as the
      // default-execution-policy save below: the sync effect above treats
      // "clean" as license to re-copy selectedCompany.name/description into
      // local state, and invalidateQueries only schedules a refetch rather
      // than resolving one in this tick. Clearing generalDirty without first
      // updating the cache would let that effect fire against the still-
      // stale pre-save entry and revert the just-saved text back to it.
      queryClient.setQueriesData<CompanyListResult>(
        { queryKey: queryKeys.companies.all },
        (current) =>
          current && Array.isArray(current.companies)
            ? {
                ...current,
                companies: current.companies.map((company) =>
                  company.id === variables.companyId
                    ? { ...company, name: result.name, description: result.description }
                    : company
                ),
              }
            : current
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // The user may have switched to a different company while this save
      // was in flight, or kept typing after clicking Save -- in either case
      // the live draft no longer represents what this response confirms was
      // saved, so clearing dirty here would make an unsaved (or
      // already-superseded) edit look saved. Only clear it when the draft
      // still matches exactly what was submitted, mirroring the same guard
      // on the default-execution-policy save above.
      if (variables.companyId !== selectedCompanyId) return;
      if (
        companyName.trim() !== variables.name ||
        (description.trim() || null) !== variables.description
      ) {
        return;
      }
      setGeneralDirty(false);
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const governanceMutation = useMutation({
    mutationFn: (next: InteractionResolverGovernance) =>
      companiesApi.update(selectedCompanyId!, { interactionResolverGovernance: next }),
    onSuccess: (company) => {
      setGovernance(company.interactionResolverGovernance ?? {});
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  function handleGovernanceChange(
    kind: IssueThreadInteractionKind,
    field: GovernanceField,
    value: GovernanceSelectValue,
  ) {
    const next = applyGovernanceChange(governance, kind, field, value);
    setGovernance(next);
    governanceMutation.mutate(next);
  }

  // Minimal editor for now: a raw-JSON textarea validated against
  // issueExecutionPolicySchema server-side on save. The per-issue
  // executionPolicy editor (IssueProperties.tsx) is tightly coupled to a
  // single Issue (participant pickers keyed off issue.companyId,
  // issue.createdByUserId, etc.) and adapting it to a company-wide template
  // with no issue in scope would be a much larger change; this ships the
  // setting without blocking on that rework.
  const defaultExecutionPolicyMutation = useMutation({
    mutationFn: ({
      companyId,
      policy
    }: {
      companyId: string;
      policy: Company["defaultExecutionPolicy"];
      submittedText: string;
    }) => companiesApi.putDefaultExecutionPolicy(companyId, policy),
    onSuccess: (result, variables) => {
      // Patch the company-list cache with the save result *synchronously*,
      // in the same tick as the dirty-flag clear below. The draft-sync
      // effect further down treats "clean" as license to re-copy
      // selectedCompany.defaultExecutionPolicy into the draft (so background
      // refetches of this company get picked up); clearing dirty without
      // also updating the cache would let that effect re-run against the
      // still-stale pre-save cache entry (invalidateQueries only schedules a
      // refetch, it does not resolve one) and stomp the just-saved text back
      // to what it replaced. Writing the result in directly removes the lag
      // instead of racing it. invalidateQueries still runs after, so any
      // server-side normalization beyond what `result` reports is picked up
      // too.
      // queryKeys.companies.all is a prefix ["companies"], so this also
      // matches the stats/directory/detail cache entries, which don't carry
      // a `companies` array -- skip those rather than crash this callback
      // (a crash here would abort before the dirty flag clears below, so a
      // save that actually succeeded on the server would read as failed).
      queryClient.setQueriesData<CompanyListResult>(
        { queryKey: queryKeys.companies.all },
        (current) =>
          current && Array.isArray(current.companies)
            ? {
                ...current,
                companies: current.companies.map((company) =>
                  company.id === variables.companyId
                    ? { ...company, defaultExecutionPolicy: result.defaultExecutionPolicy }
                    : company
                ),
              }
            : current
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // The user may have switched to a different company while this save
      // was in flight; only the still-selected company's draft should be
      // overwritten with the save result, or it clobbers the other
      // company's unsaved (or already-saved) text.
      if (variables.companyId !== selectedCompanyId) return;
      // Recorded even if a newer draft has since superseded it (checked
      // below): the "Saved" label compares the *live* draft against this at
      // render time, so it still correctly reads "not saved" once a later
      // edit moves the draft away from what this save persisted.
      lastSavedDefaultExecutionPolicyTextRef.current = variables.submittedText;
      // The user may have kept typing in the textarea after clicking Save,
      // while this request was in flight. If the draft no longer matches
      // what was actually submitted, it holds a newer, unsaved edit --
      // overwriting it with the (now-stale) save result would silently
      // discard that edit, and clearing dirty would make it look saved.
      if (defaultExecutionPolicyText !== variables.submittedText) return;
      setDefaultExecutionPolicyText(
        result.defaultExecutionPolicy
          ? JSON.stringify(result.defaultExecutionPolicy, null, 2)
          : ""
      );
      setDefaultExecutionPolicyError(null);
      setDefaultExecutionPolicyDirty(false);
    }
  });

  function handleSaveDefaultExecutionPolicy() {
    if (!selectedCompanyId) return;
    const companyId = selectedCompanyId;
    const submittedText = defaultExecutionPolicyText;
    const trimmed = submittedText.trim();
    if (!trimmed) {
      setDefaultExecutionPolicyError(null);
      defaultExecutionPolicyMutation.mutate({ companyId, policy: null, submittedText });
      return;
    }
    let parsed: Company["defaultExecutionPolicy"];
    try {
      parsed = JSON.parse(trimmed) as Company["defaultExecutionPolicy"];
    } catch {
      setDefaultExecutionPolicyError("Invalid JSON");
      return;
    }
    setDefaultExecutionPolicyError(null);
    defaultExecutionPolicyMutation.mutate({ companyId, policy: parsed, submittedText });
  }

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    }
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  const archiveMutation = useMutation({
    mutationFn: ({ companyId }: { companyId: string }) =>
      companiesApi.archive(companyId),
    onSuccess: async (_result, { companyId }) => {
      // Never stay on the archived company's settings: the only visible
      // change would be the archive button going inert. Leave for wherever
      // still makes sense (another active company, the Cloud portfolio, or
      // the companies list), with a toast naming what happened.
      const archived = companies.find((company) => company.id === companyId);
      const archivedName = archived?.name ?? "Organization";
      const departure = resolveCompanyArchiveDeparture({
        archivedCompanyId: companyId,
        companies,
        cloudPortfolioUrl: cloudPortfolioManageUrl(cloud?.cloudBaseUrl),
      });
      if (departure.kind === "cloud_portfolio") {
        // The whole organization is on its way to being archived by the
        // control plane; a full navigation to the Cloud portfolio replaces
        // this document, so cache invalidation below would never run.
        navigateTopLevel(departure.url);
        return;
      }
      if (departure.kind === "company") {
        toastActions?.pushToast({
          title: `${archivedName} is archived`,
          body: `Switched to ${departure.company.name}.`,
          tone: "info",
          dedupeKey: `company-archive-departure:${companyId}`,
        });
        setSelectedCompanyId(departure.company.id);
        navigate(`/${departure.company.issuePrefix}/dashboard`, { replace: true });
      } else {
        toastActions?.pushToast({
          title: `${archivedName} is archived`,
          body: "You can unarchive it from this list.",
          tone: "info",
          dedupeKey: `company-archive-departure:${companyId}`,
        });
        navigate(`/${archived?.issuePrefix ?? ""}/companies`, { replace: true });
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings" }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No organization selected. Select an organization from the switcher above.
      </div>
    );
  }

  function handleSaveGeneral() {
    if (!selectedCompanyId) return;
    generalMutation.mutate({
      companyId: selectedCompanyId,
      name: companyName.trim(),
      description: description.trim() || null
    });
  }

  return (
    <div className="max-w-6xl space-y-8">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">General</h1>
      </div>

      {/* General */}
      <div className="max-w-2xl space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          General
        </div>
        <div className="space-y-3">
          <Field label="Organization name" hint="The display name for your organization.">
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => {
                setCompanyName(e.target.value);
                setGeneralDirty(true);
              }}
            />
            {isCloudManaged && (
              <p className="mt-1 text-xs text-muted-foreground">
                Renaming can change this company's task ID prefix. Existing task IDs are
                renumbered and old task links stop resolving.
              </p>
            )}
          </Field>
          <Field
            label="Description"
            hint="Optional description shown in the organization profile."
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder="Optional organization description"
              onChange={(e) => {
                setDescription(e.target.value);
                setGeneralDirty(true);
              }}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="max-w-2xl space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Appearance
        </div>
        <div className="space-y-3">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                logoUrl={logoUrl || null}
                className="rounded-(--rad-14)"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label="Logo"
                hint="Upload a PNG, JPEG, WEBP, GIF, or SVG logo image."
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending ? "Removing..." : "Remove logo"}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : "Logo upload failed")}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">Uploading logo...</span>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim()}
          >
            {generalMutation.isPending ? "Saving..." : "Save changes"}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">Saved</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : "Failed to save"}
            </span>
          )}
        </div>
      )}

      {/* Hiring */}
      <div className="max-w-2xl space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Hiring
        </div>
        <div>
          <ToggleField
            label="Require board approval for new hires"
            hint="New agent hires stay pending until approved by board."
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </div>

      {/* Interaction governance */}
      {selectedCompanyId && <DecisionModelSettingsSection key={selectedCompanyId} companyId={selectedCompanyId} />}

      <InteractionGovernancePanel
        governance={governance}
        onChange={handleGovernanceChange}
        isPending={governanceMutation.isPending}
        errorMessage={
          governanceMutation.isError
            ? governanceMutation.error instanceof Error
              ? governanceMutation.error.message
              : "Failed to save interaction governance"
            : null
        }
      />

      {/* Default execution policy */}
      <div className="max-w-2xl space-y-4" data-testid="company-settings-default-execution-policy-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Default execution policy
        </div>
        <Field
          label="Applied to new tasks that don't set one"
          hint={
            "Raw JSON matching an issue's executionPolicy shape (stages, reviewPreset, " +
            "maxReviewRounds, ...). Leave blank to clear the default. Does not apply to " +
            "routine-generated or chat-thread tasks, and never overrides a task's own " +
            "explicit executionPolicy."
          }
        >
          <textarea
            className="w-full min-h-32 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
            placeholder={'{\n  "stages": [\n    { "type": "approval", "participants": [...] }\n  ]\n}'}
            value={defaultExecutionPolicyText}
            onChange={(e) => {
              setDefaultExecutionPolicyText(e.target.value);
              setDefaultExecutionPolicyDirty(true);
            }}
            data-testid="company-settings-default-execution-policy-textarea"
          />
        </Field>
        {!!selectedCompany && defaultExecutionPolicyDirty && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSaveDefaultExecutionPolicy}
              disabled={defaultExecutionPolicyMutation.isPending}
              data-testid="company-settings-default-execution-policy-save"
            >
              {defaultExecutionPolicyMutation.isPending ? "Saving..." : "Save changes"}
            </Button>
            {defaultExecutionPolicyMutation.isSuccess &&
              defaultExecutionPolicyText === lastSavedDefaultExecutionPolicyTextRef.current && (
                <span className="text-xs text-muted-foreground">Saved</span>
              )}
          </div>
        )}
        {defaultExecutionPolicyError && (
          <span className="text-xs text-destructive">{defaultExecutionPolicyError}</span>
        )}
        {defaultExecutionPolicyMutation.isError && (
          <span className="text-xs text-destructive">
            {defaultExecutionPolicyMutation.error instanceof Error
              ? defaultExecutionPolicyMutation.error.message
              : "Failed to save default execution policy"}
          </span>
        )}
      </div>

      <InstanceGeneralSettings embedded />

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          Danger Zone
        </div>
        <div className="space-y-3 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Archive this organization to hide it from the sidebar. This persists in
            the database.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                archiveMutation.isPending ||
                selectedCompany.status === "archived"
              }
              onClick={() => {
                if (!selectedCompanyId) return;
                const confirmed = window.confirm(
                  `Archive organization "${selectedCompany.name}"? It will be hidden from the sidebar.`
                );
                if (!confirmed) return;
                archiveMutation.mutate({ companyId: selectedCompanyId });
              }}
            >
              {archiveMutation.isPending
                ? "Archiving..."
                : selectedCompany.status === "archived"
                ? "Already archived"
                : "Archive organization"}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : "Failed to archive organization"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
