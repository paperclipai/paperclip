import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { ChangeEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { AgentObservabilitySettingsSection } from "../components/observability/AgentObservabilitySettings";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import { describeError } from "@/api/errors";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/select";
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
  HintIcon,
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

  const [defaultExecutionPolicyDirty, setDefaultExecutionPolicyDirty] = useState(false);

  const lastSavedDefaultExecutionPolicyTextRef = useRef<string | null>(null);

  const [defaultExecutionPolicySyncedCompanyId, setDefaultExecutionPolicySyncedCompanyId] =
    useState<string | null>(null);

  const [generalSyncedCompanyId, setGeneralSyncedCompanyId] = useState<
    string | null
  >(null);

  const [generalDirty, setGeneralDirty] = useState(false);

  useEffect(() => {
    if (!selectedCompany) return;
    const companyChanged = selectedCompany.id !== generalSyncedCompanyId;
    if (companyChanged || !generalDirty) {
      setCompanyName(selectedCompany.name);
      setDescription(selectedCompany.description ?? "");
      setGeneralSyncedCompanyId(selectedCompany.id);
      setGeneralDirty(false);
    }
  }, [selectedCompany, generalSyncedCompanyId, generalDirty]);

  useEffect(() => {
    if (!selectedCompany) return;
    setLogoUrl(selectedCompany.logoUrl ?? "");
    setGovernance(selectedCompany.interactionResolverGovernance ?? {});
  }, [selectedCompany?.id, selectedCompany?.logoUrl, selectedCompany?.interactionResolverGovernance]);

  const generalMutation = useMutation({
    mutationFn: (data: {
      companyId: string;
      name: string;
      description: string | null;
    }) => companiesApi.update(data.companyId, { name: data.name, description: data.description }),
    onSuccess: (result, variables) => {
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

  // Members populate the default decision owner and budget owner pickers.
  // Ownerless "Needs You" cards route to the default decision owner's "For
  // you" list; clearing it sends them to the claimable Unassigned pool
  // (PAP-749 task 1d-lite). A budget hard stop also goes to the budget owner,
  // and Company keeps showing it (task 1d).
  const membersQuery = useQuery({
    queryKey: queryKeys.access.companyMembers(selectedCompanyId ?? ""),
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Each owner saves on change with only its own field, so neither belongs to
  // the General draft or its "Save changes" button. Waiting for the refetch
  // keeps the picker on the new owner instead of flashing back to the old one.
  async function saveDefaultDecisionOwner(defaultDecisionOwnerUserId: string | null) {
    const company = await companiesApi.update(selectedCompanyId!, { defaultDecisionOwnerUserId });
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    return company;
  }

  async function saveBudgetOwner(budgetOwnerUserId: string | null) {
    const company = await companiesApi.update(selectedCompanyId!, { budgetOwnerUserId });
    await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    return company;
  }

  const membersView = useQueryView(membersQuery);
  const memberOptions = (membersQuery.data?.members ?? [])
    .filter((member) => member.user?.id)
    .map((member) => (
      <option key={member.user!.id} value={member.user!.id}>
        {member.user!.name || member.user!.email || member.user!.id}
      </option>
    ));

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
      if (variables.companyId !== selectedCompanyId) return;
      lastSavedDefaultExecutionPolicyTextRef.current = variables.submittedText;
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

  useEffect(() => {
    if (!selectedCompany) return;
    const companyChanged = selectedCompany.id !== defaultExecutionPolicySyncedCompanyId;
    if (companyChanged) {
      defaultExecutionPolicyMutation.reset();
    }
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
                  {(logoUploadMutation.error || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ?? describeError(logoUploadMutation.error).body}
                    </span>
                  )}
                  {clearLogoMutation.error && (
                    <span className="text-xs text-destructive">
                      {describeError(clearLogoMutation.error).body}
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
          {generalMutation.error && (
            <span className="text-xs text-destructive">
              {describeError(generalMutation.error).body}
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

      {/* Decisions */}
      <div className="max-w-2xl space-y-4" data-testid="company-settings-decisions-section">
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Decisions
          </div>
          <p className="text-xs text-muted-foreground">
            Each owner saves as soon as you choose it.
          </p>
        </div>
        {membersView.kind === "error" ? <QueryErrorState error={membersView.error} onRetry={membersView.retry} /> : null}
        <DecisionOwnerField
          label="Default decision owner"
          hint="When a card needs a person but has no explicit owner, it goes to this user's For you list. Leave as Unassigned to keep ownerless cards in the claimable pool."
          testId="company-settings-default-decision-owner"
          unsetLabel="Unassigned (no default owner)"
          savedUserId={selectedCompany.defaultDecisionOwnerUserId ?? null}
          memberOptions={memberOptions}
          membersLoading={membersQuery.isLoading}
          fallbackError="Couldn't save the default decision owner."
          save={saveDefaultDecisionOwner}
        />
        <DecisionOwnerField
          label="Budget owner"
          hint="A budget hard stop also goes to this user's For you list, with Raise limit and Keep paused. The Company view still shows it to every operator."
          testId="company-settings-budget-owner"
          unsetLabel="No budget owner (Company view only)"
          savedUserId={selectedCompany.budgetOwnerUserId ?? null}
          memberOptions={memberOptions}
          membersLoading={membersQuery.isLoading}
          fallbackError="Couldn't save the budget owner."
          save={saveBudgetOwner}
        />
      </div>

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

      {/* Interaction governance. Held to the form column like the sections
          above; the wrapper scrolls rather than letting the policy grid push
          past the column when the content area is narrow. The padding keeps
          the selects' focus rings inside the scroll box, and the negative
          inline margin keeps the panel aligned with the other sections. */}
      <div
        className="-mx-1 min-w-0 max-w-2xl overflow-x-auto p-1"
        data-testid="company-settings-interaction-governance-frame"
      >
        <InteractionGovernancePanel
          governance={governance}
          onChange={handleGovernanceChange}
          isPending={governanceMutation.isPending}
          errorMessage={governanceMutation.error ? describeError(governanceMutation.error).body : null}
        />
      </div>
      <AgentObservabilitySettingsSection companyId={selectedCompanyId!} />

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
            {archiveMutation.error && (
              <span className="text-xs text-destructive">
                {describeError(archiveMutation.error).body}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One Decisions owner picker. It saves on change, on its own, so the page's
 * General "Save changes" never carries it. A real `<label htmlFor>` names the
 * select, and the line under it reports saving, saved, or the server's error
 * (for example the 422 for an owner who is not an active member).
 */
function DecisionOwnerField({
  label,
  hint,
  testId,
  unsetLabel,
  savedUserId,
  memberOptions,
  membersLoading,
  fallbackError,
  save,
}: {
  label: string;
  hint: string;
  testId: string;
  unsetLabel: string;
  savedUserId: string | null;
  memberOptions: ReactNode;
  membersLoading: boolean;
  fallbackError: string;
  save: (userId: string | null) => Promise<unknown>;
}) {
  const controlId = useId();
  const errorId = `${controlId}-error`;
  const mutation = useMutation({
    mutationFn: save,
    // Quick successive picks save in order, so the last choice is what sticks.
    scope: { id: `company-settings:${testId}` },
  });
  // Show the choice while it saves. Otherwise show what the server holds, so
  // a rejected owner snaps back beside its error.
  const value = mutation.isPending ? (mutation.variables ?? "") : (savedUserId ?? "");
  const errorMessage = mutation.error ? describeError(mutation.error).body ?? fallbackError : null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <label htmlFor={controlId} className="text-xs text-muted-foreground">
          {label}
        </label>
        <HintIcon text={hint} />
      </div>
      <NativeSelect
        id={controlId}
        data-testid={testId}
        value={value}
        // Not disabled while saving: disabling would drop keyboard focus.
        disabled={membersLoading}
        aria-busy={mutation.isPending || undefined}
        aria-invalid={errorMessage ? true : undefined}
        aria-describedby={errorMessage ? errorId : undefined}
        onChange={(event) => mutation.mutate(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">{unsetLabel}</option>
        {memberOptions}
      </NativeSelect>
      {errorMessage ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      ) : (
        <p role="status" className="min-h-4 text-xs text-muted-foreground">
          {mutation.isPending ? "Saving…" : mutation.isSuccess ? "Saved" : null}
        </p>
      )}
    </div>
  );
}
