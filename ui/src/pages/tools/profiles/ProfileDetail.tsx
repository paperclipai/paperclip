import { t, useTranslation } from "@/i18n";
import { toolRiskLabel, toolEntityLabel } from "../shared";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Copy, Pencil, PlugZap, ShieldCheck, Trash2, UserMinus } from "lucide-react";
import type {
  ToolCatalogEntry,
  ToolProfileBinding,
  ToolProfileDefaultAction,
  ToolProfileEntry,
  ToolProfileNewToolReviewDecision,
  ToolProfileNewToolReviewItem,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import { useNavigate, useSearchParams } from "@/lib/router";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatShortDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/context/ToastContext";
import { ErrorState, LoadingState, RelativeTime, ToolsPageHeader } from "../shared";
import { ProfileActionDialog, type ProfileActionDialogKind } from "./ProfileActionDialog";
import { allowsLabel, STATUS_LABEL } from "./profile-summary";
import { useProfilesData } from "./useProfilesData";

type DialogKind = "edit" | "duplicate" | "archive" | "delete" | "restore" | null;

interface AllowRow {
  id: string;
  app: string;
  tool: string;
  capabilities: string;
  source: string;
  addedByRule: boolean;
  autoAddedAt: Date | string | null;
  degraded: boolean;
  connectionId: string | null;
}

export function ProfileDetail({
  companyId,
  profileId,
  initialCreated,
  initialReviewOpen,
}: {
  companyId: string;
  profileId: string;
  initialCreated?: boolean;
  initialReviewOpen?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const data = useProfilesData(companyId);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [assignmentToRemove, setAssignmentToRemove] = useState<ToolProfileBinding | null>(null);
  const [reviewOpen, setReviewOpen] = useState(Boolean(initialReviewOpen));
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, ToolProfileNewToolReviewDecision>>({});

  const profile = (data.profiles.data?.profiles ?? []).find((p) => p.id === profileId) ?? null;
  const created = initialCreated ?? searchParams.get("created") === "1";
  const pendingNewTools = profile?.newToolsPendingCount ?? 0;
  const newTools = useQuery({
    queryKey: queryKeys.tools.profileNewTools(profileId),
    queryFn: () => toolsApi.getProfileNewTools(profileId),
    enabled: pendingNewTools > 0,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.profiles(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.testAgentAccesses() });
  };
  const errorBody = (error: unknown) => String((error as Error)?.message ?? error);

  const allowRows = useMemo(
    () => (profile ? buildAllowRows(profile, data.catalog, data.maps.applicationsById, data.maps.connectionsById, data.connections.data?.connections ?? []) : []),
    [profile, data.catalog, data.maps.applicationsById, data.maps.connectionsById, data.connections.data?.connections, t],
  );
  const reviewItems = newTools.data?.tools ?? [];

  useEffect(() => {
    if (searchParams.get("review") === "new-tools" && pendingNewTools > 0) setReviewOpen(true);
  }, [pendingNewTools, searchParams]);

  useEffect(() => {
    if (reviewItems.length === 0) return;
    setReviewDecisions((current) => {
      const next = { ...current };
      for (const tool of reviewItems) {
        if (!next[tool.catalogEntryId]) next[tool.catalogEntryId] = "keep_blocked";
      }
      return next;
    });
  }, [reviewItems]);

  const updateProfile = useMutation({
    mutationFn: (input: Parameters<typeof toolsApi.updateProfile>[1]) => toolsApi.updateProfile(profileId, input),
    onSuccess: () => {
      invalidate();
      pushToast({ title: t("localizationTools.profileUpdated102"), tone: "success" });
    },
    onError: (error: unknown) => pushToast({ title: t("localizationTools.couldNotUpdateProfile103"), body: errorBody(error), tone: "error" }),
  });

  const duplicateProfile = useMutation({
    mutationFn: (input: { name: string; includeAssignments: boolean }) => toolsApi.duplicateProfile(profileId, input),
    onSuccess: (copy) => {
      invalidate();
      pushToast({ title: t("localizationTools.profileDuplicated53"), body: t("localizationTools.theCopyIsNotAssignedToAnyoneYet54"), tone: "success" });
      navigate(`/apps/advanced/profiles/${copy.id}?created=1`);
    },
    onError: (error: unknown) => pushToast({ title: t("localizationTools.couldNotDuplicate55"), body: errorBody(error), tone: "error" }),
  });

  const deleteProfile = useMutation({
    mutationFn: () => toolsApi.deleteProfile(profileId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: t("localizationTools.profileDeleted60"), tone: "success" });
      navigate("/apps/advanced/profiles");
    },
    onError: (error: unknown) => pushToast({ title: t("localizationTools.couldNotDelete61"), body: errorBody(error), tone: "error" }),
  });

  const removeAssignment = useMutation({
    mutationFn: (binding: ToolProfileBinding) =>
      toolsApi.unbindProfile(companyId, profileId, { targetType: binding.targetType, targetId: binding.targetId }),
    onSuccess: () => {
      setAssignmentToRemove(null);
      invalidate();
      pushToast({ title: t("localizationTools.assignmentRemoved104"), tone: "success" });
    },
    onError: (error: unknown) => pushToast({ title: t("localizationTools.couldNotRemoveAssignment105"), body: errorBody(error), tone: "error" }),
  });

  const reviewNewTools = useMutation({
    mutationFn: () =>
      toolsApi.reviewProfileNewTools(profileId, {
        decisions: reviewItems.map((tool) => ({
          catalogEntryId: tool.catalogEntryId,
          decision: reviewDecisions[tool.catalogEntryId] ?? "keep_blocked",
        })),
      }),
    onSuccess: () => {
      setReviewOpen(false);
      setSearchParams({});
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.profiles(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tools.profileNewTools(profileId) });
      pushToast({ title: t("localizationTools.newToolsReviewed106"), tone: "success" });
    },
    onError: (error: unknown) => pushToast({ title: t("localizationTools.couldNotSubmitReview107"), body: errorBody(error), tone: "error" }),
  });

  if (data.profiles.isLoading) return <LoadingState label={t("pages.profile.loading")} />;
  if (data.profiles.isError) return <ErrorState error={data.profiles.error} onRetry={() => data.profiles.refetch()} />;
  if (!profile) {
    return (
      <div className="space-y-4">
        <ToolsPageHeader title={t("localizationTools.profileNotFound108")} description={t("localizationTools.thisAccessProfileMayHaveBeenDeleted109")} />
        <Button variant="outline" onClick={() => navigate("/apps/advanced/profiles")}>{t("localizationTools.backToProfiles110")}</Button>
      </div>
    );
  }

  const archived = profile.status === "archived";
  const unassigned = profile.summary.assignmentCount === 0;

  return (
    <div className="space-y-6">
      <ToolsPageHeader
        title={profile.name}
        description={profile.description ?? t("localizationRoutines.noDescriptionYet")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={archived} onClick={() => setDialog("edit")}>
              <Pencil className="mr-1.5 h-4 w-4" />{t("common.edit")}</Button>
            <Button variant="outline" disabled={archived} onClick={() => setDialog("duplicate")}>
              <Copy className="mr-1.5 h-4 w-4" />{t("localizationTools.duplicate79")}</Button>
            {archived ? (
              <Button variant="outline" onClick={() => setDialog("restore")}>
                <ArchiveRestore className="mr-1.5 h-4 w-4" />{t("pages.agentDetail.restore")}</Button>
            ) : (
              <Button variant="outline" onClick={() => setDialog("archive")}>{t("localizationRoutines.archive")}</Button>
            )}
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("delete")}>
              <Trash2 className="mr-1.5 h-4 w-4" />{t("pages.agentDetail.delete")}</Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant={archived ? "outline" : "default"}>{STATUS_LABEL[profile.status]}</Badge>
        <span className="text-muted-foreground">{t("pages.cases.columnUpdated")}<RelativeTime value={profile.updatedAt} /></span>
        <span className="text-muted-foreground">{allowsLabel(profile.summary)}</span>
      </div>

      {created ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">{t("localizationTools.profileSaved112")}</p>
            <p className="text-sm text-muted-foreground">
              {unassigned ? t("localizationTools.assignItToAgentsBeforeItChangesTheirAccess113") : t("localizationTools.assignmentsAreActiveNow114")}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => navigate(`/apps/advanced/profiles/${profile.id}/edit?step=3`)}>{t("localizationTools.assign115")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setSearchParams({})}>{t("pages.inbox.dismiss")}</Button>
          </div>
        </div>
      ) : null}

      {archived ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">{t("localizationTools.thisProfileIsArchivedItDoesNotApplyToAgentsUn117")}</div>
      ) : null}

      {pendingNewTools > 0 ? (
        <NewToolsReviewBanner
          count={pendingNewTools}
          tools={reviewItems}
          loading={newTools.isLoading}
          onReview={() => setReviewOpen(true)}
        />
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">{t("localizationTools.whatItAllows118")}</h2>
          <Button variant="outline" size="sm" disabled={archived} onClick={() => navigate(`/apps/advanced/profiles/${profile.id}/edit?step=2`)}>{t("localizationTools.editTools119")}</Button>
        </div>
        <AllowList rows={allowRows} total={profile.summary.totalToolCount} />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">{t("localizationTools.whoHasIt120")}</h2>
          <Button variant="outline" size="sm" disabled={archived} onClick={() => navigate(`/apps/advanced/profiles/${profile.id}/edit?step=3`)}>{t("localizationTools.assign115")}</Button>
        </div>
        <Assignments
          profile={profile}
          companyId={companyId}
          maps={data.maps}
          archived={archived}
          onRemove={setAssignmentToRemove}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">{t("localizationTools.newToolsThatAppearLater121")}</h2>
        <NewToolsSetting
          value={profile.defaultAction}
          disabled={archived || updateProfile.isPending}
          onChange={(defaultAction) => updateProfile.mutate({ defaultAction })}
        />
      </section>

      <Button variant="link" className="h-auto px-0" onClick={() => navigate("/apps/advanced/profiles?check=1")}>
        <ShieldCheck className="mr-1.5 h-4 w-4" />{t("localizationTools.checkWhatAnAgentCanActuallyDo122")}</Button>

      <ProfileDialogs
        kind={dialog}
        profile={profile}
        allProfiles={data.profiles.data?.profiles ?? []}
        pending={updateProfile.isPending || duplicateProfile.isPending || deleteProfile.isPending}
        onClose={() => setDialog(null)}
        onUpdate={(input) => updateProfile.mutate(input, { onSuccess: () => setDialog(null) })}
        onDuplicate={(input) => duplicateProfile.mutate(input, { onSuccess: () => setDialog(null) })}
        onArchive={() => updateProfile.mutate({ status: "archived" }, { onSuccess: () => setDialog(null) })}
        onRestore={() => updateProfile.mutate({ status: "active" }, { onSuccess: () => setDialog(null) })}
        onDelete={() => deleteProfile.mutate(undefined, { onSuccess: () => setDialog(null) })}
      />

      <RemoveAssignmentDialog
        binding={assignmentToRemove}
        label={assignmentToRemove ? assignmentLabel(assignmentToRemove, companyId, data.maps) : ""}
        pending={removeAssignment.isPending}
        onClose={() => setAssignmentToRemove(null)}
        onConfirm={() => assignmentToRemove && removeAssignment.mutate(assignmentToRemove)}
      />

      <NewToolsReviewDialog
        open={reviewOpen}
        tools={reviewItems}
        loading={newTools.isLoading}
        error={newTools.error}
        decisions={reviewDecisions}
        pending={reviewNewTools.isPending}
        onClose={() => setReviewOpen(false)}
        onRetry={() => newTools.refetch()}
        onDecision={(catalogEntryId, decision) =>
          setReviewDecisions((current) => ({ ...current, [catalogEntryId]: decision }))
        }
        onSubmit={() => reviewNewTools.mutate()}
      />
    </div>
  );
}

function NewToolsReviewBanner({
  count,
  tools,
  loading,
  onReview,
}: {
  count: number;
  tools: ToolProfileNewToolReviewItem[];
  loading: boolean;
  onReview: () => void;
}) {
  const { t } = useTranslation();
  const appLabel = newToolsAppLabel(tools);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <div>
        <p className="font-medium">
          {loading ? t("localizationTools.newToolsNeedReview123") : t("localizationTools.appAddedNewTools", { app: appLabel, count })}
        </p>
        <p className="text-amber-900/80">{t("localizationTools.chooseWhichOnesThisProfileShouldAllow125")}</p>
      </div>
      <Button size="sm" onClick={onReview}>{t("pages.apps.tabs.review")}</Button>
    </div>
  );
}

function NewToolsReviewDialog({
  open,
  tools,
  loading,
  error,
  decisions,
  pending,
  onClose,
  onRetry,
  onDecision,
  onSubmit,
}: {
  open: boolean;
  tools: ToolProfileNewToolReviewItem[];
  loading: boolean;
  error: unknown;
  decisions: Record<string, ToolProfileNewToolReviewDecision>;
  pending: boolean;
  onClose: () => void;
  onRetry: () => void;
  onDecision: (catalogEntryId: string, decision: ToolProfileNewToolReviewDecision) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("localizationTools.reviewNewTools127")}</DialogTitle>
          <DialogDescription>{t("localizationTools.allowTheToolsThisProfileShouldUseKeepTheRestB128")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <LoadingState label={t("localizationTools.loadingNewTools129")} />
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : tools.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{t("localizationTools.thereAreNoNewToolsWaitingForReview130")}</div>
        ) : (
          <div className="max-h-(--sz-52vh) divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {tools.map((tool) => (
              <div key={tool.catalogEntryId} className="grid gap-3 px-3 py-3 sm:grid-cols-[1fr_auto]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-foreground">
                      {tool.title || tool.toolName}
                    </p>
                    <Badge variant="secondary">{capabilityText(tool)}</Badge>
                  </div>
                  {tool.description ? (
                    <p className="mt-1 text-sm text-muted-foreground">{tool.description}</p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("localizationTools.toolAddedDate", { app: tool.applicationName ?? tool.connectionName ?? t("localizationTools.appTool131"), date: formatShortDate(tool.addedAt) })}
                  </p>
                </div>
                <div className="flex items-center gap-2 sm:justify-end">
                  <label className="inline-flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name={`review-${tool.catalogEntryId}`}
                      checked={(decisions[tool.catalogEntryId] ?? "keep_blocked") === "allow"}
                      onChange={() => onDecision(tool.catalogEntryId, "allow")}
                    />{t("localizationProjects.ui_Allow")}</label>
                  <label className="inline-flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name={`review-${tool.catalogEntryId}`}
                      checked={(decisions[tool.catalogEntryId] ?? "keep_blocked") === "keep_blocked"}
                      onChange={() => onDecision(tool.catalogEntryId, "keep_blocked")}
                    />{t("localizationTools.keepBlocked133")}</label>
                </div>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t("pages.apps.common.cancel")}</Button>
          <Button disabled={pending || loading || tools.length === 0} onClick={onSubmit}>{t("localizationTools.submitReview134")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AllowList({ rows, total }: { rows: AllowRow[]; total: number }) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">{t("localizationTools.thisProfileAllows0ToolsAgentsWithOnlyThisProf135")}</div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-xs font-medium text-muted-foreground">
            <th className="px-3 py-2 font-medium">{t("localizationApps.tool180")}</th>
            <th className="px-3 py-2 font-medium">{t("pages.apps.common.app")}</th>
            <th className="px-3 py-2 font-medium">{t("pages.inviteLanding.agentForm.capabilities")}</th>
            <th className="px-3 py-2 font-medium">{t("localizationRoutines.source")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 80).map((row) => (
            <tr key={row.id} className={cn("border-b border-border last:border-0", row.degraded && "bg-muted/30 text-muted-foreground")}>
              <td className="px-3 py-2">
                <div className="flex flex-col">
                  <span className="font-medium text-foreground">{row.tool}</span>
                  {row.degraded ? (
                    <a className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline" href={`/apps/${row.connectionId}`}>
                      <PlugZap className="h-3 w-3" />{t("pages.apps.connections.reconnect")}</a>
                  ) : null}
                </div>
              </td>
              <td className="px-3 py-2">
                <span>{row.app}</span>
                {row.degraded ? <span className="ml-2 text-xs text-muted-foreground">{t("localizationTools.appDisconnected", { app: row.app })}</span> : null}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{row.capabilities}</td>
              <td className="px-3 py-2">
                {row.addedByRule ? (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-950">{row.source}</span>
                ) : (
                  <span className="text-muted-foreground">{row.source}</span>
                )}
                {row.autoAddedAt ? (
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t("localizationTools.addedAutomaticallyAt", { date: formatShortDate(row.autoAddedAt) })}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 80 ? (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {t("localizationTools.showingAllowedTools", { count: rows.length })}
        </p>
      ) : (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{t("localizationTools.allowsKnownTools", { count: rows.length, total })}
        </p>
      )}
    </div>
  );
}

function Assignments({
  profile,
  companyId,
  maps,
  archived,
  onRemove,
}: {
  profile: ToolProfileWithDetails;
  companyId: string;
  maps: ReturnType<typeof useProfilesData>["maps"];
  archived: boolean;
  onRemove: (binding: ToolProfileBinding) => void;
}) {
  const { t } = useTranslation();
  if (profile.bindings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-5">
        <p className="text-sm font-medium text-foreground">{t("localizationTools.notAssignedYet146")}</p>
        <p className="text-sm text-muted-foreground">{t("localizationTools.assignThisProfileBeforeItChangesAccess147")}</p>
      </div>
    );
  }
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {profile.bindings.map((binding) => (
        <div key={binding.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
              {binding.targetType === "company" ? t("localizationTools.or148") : binding.targetType.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{assignmentLabel(binding, companyId, maps)}</p>
              <p className="text-xs text-muted-foreground">{assignmentTypeLabel(binding.targetType)}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" disabled={archived} onClick={() => onRemove(binding)}>
            <UserMinus className="mr-1.5 h-4 w-4" />{t("pages.profile.remove")}</Button>
        </div>
      ))}
    </div>
  );
}

function NewToolsSetting({
  value,
  disabled,
  onChange,
}: {
  value: ToolProfileDefaultAction;
  disabled: boolean;
  onChange: (value: ToolProfileDefaultAction) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ value: ToolProfileDefaultAction; title: string; body: string }> = [
    { value: "deny", title: t("localizationTools.stayBlockedUntilReviewed150"), body: t("localizationTools.newToolsDoNotBecomeAvailableAutomatically151") },
    { value: "allow", title: t("localizationTools.allowedAutomatically152"), body: t("localizationTools.newToolsFromSelectedAppsBecomeAvailableRightA153") },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            "flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3",
            value === option.value ? "border-primary bg-primary/5" : "border-border",
            disabled && "cursor-not-allowed opacity-60",
          )}
        >
          <input
            type="radio"
            className="mt-1"
            disabled={disabled}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span>
            <span className="block text-sm font-medium text-foreground">{option.title}</span>
            <span className="block text-xs text-muted-foreground">{option.body}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function ProfileDialogs({
  kind,
  profile,
  allProfiles,
  pending,
  onClose,
  onUpdate,
  onDuplicate,
  onArchive,
  onRestore,
  onDelete,
}: {
  kind: DialogKind;
  profile: ToolProfileWithDetails;
  allProfiles: ToolProfileWithDetails[];
  pending: boolean;
  onClose: () => void;
  onUpdate: (input: { name: string; description: string | null; profileKey: string }) => void;
  onDuplicate: (input: { name: string; includeAssignments: boolean }) => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description ?? "");
  const [profileKey, setProfileKey] = useState(profile.profileKey);
  const [copyName, setCopyName] = useState(t("localizationTools.profileCopy", { name: profile.name }));
  const [copyAssignments, setCopyAssignments] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const duplicateName = allProfiles.some((p) => p.id !== profile.id && p.name.trim().toLowerCase() === name.trim().toLowerCase());
  const duplicateCopyName = allProfiles.some((p) => p.name.trim().toLowerCase() === copyName.trim().toLowerCase());

  if (!kind) return null;
  const open = Boolean(kind);

  if (kind === "edit") {
    return (
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("account.editProfile")}</DialogTitle>
            <DialogDescription>{t("localizationTools.updateTheProfileNameAndDescription157")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-profile-name">{t("pages.apps.connect.nameLabel")}</Label>
              <Input id="edit-profile-name" value={name} onChange={(e) => setName(e.target.value)} />
              {duplicateName ? <p className="text-xs text-destructive">{t("localizationTools.anotherProfileAlreadyUsesThisName159")}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-profile-description">{t("pages.caseDetail.description")}</Label>
              <Textarea id="edit-profile-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
            </div>
            <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => setAdvancedOpen((v) => !v)}>{t("pages.apps.tabs.advanced")}</button>
            {advancedOpen ? (
              <div className="space-y-1.5">
                <Label htmlFor="edit-profile-key">{t("localizationFilters.sourceidentifier")}</Label>
                <Input id="edit-profile-key" value={profileKey} onChange={(e) => setProfileKey(e.target.value)} className="font-mono text-xs" />
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t("pages.apps.common.cancel")}</Button>
            <Button disabled={!name.trim() || duplicateName || pending} onClick={() => onUpdate({ name: name.trim(), description: description.trim() || null, profileKey: profileKey.trim() })}>{t("pages.apps.common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (kind === "duplicate") {
    return (
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("localizationTools.duplicateProfile163")}</DialogTitle>
            <DialogDescription>{t("localizationTools.theCopyStartsUnassignedUnlessYouChooseToCopyA164")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="copy-profile-name">{t("pages.apps.connect.nameLabel")}</Label>
              <Input id="copy-profile-name" value={copyName} onChange={(e) => setCopyName(e.target.value)} />
              {duplicateCopyName ? <p className="text-xs text-destructive">{t("localizationTools.anotherProfileAlreadyUsesThisName159")}</p> : null}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={copyAssignments} onChange={(e) => setCopyAssignments(e.target.checked)} />{t("localizationTools.alsoCopyAssignments165")}</label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{t("pages.apps.common.cancel")}</Button>
            <Button disabled={!copyName.trim() || duplicateCopyName || pending} onClick={() => onDuplicate({ name: copyName.trim(), includeAssignments: copyAssignments })}>{t("localizationTools.duplicate79")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <ProfileActionDialog
      kind={kind as ProfileActionDialogKind}
      profile={profile}
      pending={pending}
      onClose={onClose}
      onArchive={onArchive}
      onRestore={onRestore}
      onDelete={onDelete}
    />
  );
}

function RemoveAssignmentDialog({
  binding,
  label,
  pending,
  onClose,
  onConfirm,
}: {
  binding: ToolProfileBinding | null;
  label: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={Boolean(binding)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("localizationTools.removeAssignment166")}</DialogTitle>
          <DialogDescription>
            {binding?.targetType === "company"
              ? t("localizationTools.removingTheOrganizationDefaultChangesAccessFo167")
              : t("localizationTools.removeProfileFrom", { label })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t("pages.apps.common.cancel")}</Button>
          <Button disabled={pending} onClick={onConfirm}>{t("pages.profile.remove")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function buildAllowRows(
  profile: ToolProfileWithDetails,
  catalog: ToolCatalogEntry[],
  appNames: Map<string, string>,
  connectionNames: Map<string, string>,
  connections: Array<{ id: string; status?: string; healthStatus?: string }>,
): AllowRow[] {
  const excluded = profile.entries.filter((entry) => entry.effect === "exclude");
  const included = profile.entries.filter((entry) => entry.effect === "include");
  const includeAllExcept = profile.summary.accessMode === "all_except";
  return catalog
    .filter((tool) => !excluded.some((entry) => entryMatchesTool(entry, tool)))
    .filter((tool) => includeAllExcept || included.some((entry) => entryMatchesTool(entry, tool)))
    .map((tool) => {
      const match = includeAllExcept ? null : included.find((entry) => entryMatchesTool(entry, tool)) ?? null;
      const app = appNames.get(tool.applicationId ?? "") ?? connectionNames.get(tool.connectionId) ?? t("localizationTools.unknownApp169");
      const connection = connections.find((item) => item.id === tool.connectionId);
      return {
        id: tool.id,
        app,
        tool: tool.title || tool.toolName,
        capabilities: capabilityLabel(tool),
        source: sourceLabel(match, app),
        addedByRule: Boolean(match && (match.selectorType === "application" || match.selectorType === "connection" || (match.selectorType === "risk_level" && match.riskLevel))),
        autoAddedAt: profile.defaultAction === "allow" && isRecentTool(tool) ? (tool.addedAt ?? tool.firstSeenAt) : null,
        degraded: Boolean(connection && (connection.status !== "active" || connection.healthStatus === "error")),
        connectionId: tool.connectionId,
      };
    });
}

function entryMatchesTool(entry: ToolProfileEntry, tool: ToolCatalogEntry): boolean {
  switch (entry.selectorType) {
    case "application":
      return Boolean(entry.applicationId && entry.applicationId === tool.applicationId);
    case "connection":
      return Boolean(entry.connectionId && entry.connectionId === tool.connectionId);
    case "catalog_entry":
      return Boolean(entry.catalogEntryId && entry.catalogEntryId === tool.id);
    case "tool_name":
      return Boolean(entry.toolName && entry.toolName === tool.toolName);
    case "risk_level":
      return Boolean(entry.riskLevel && entry.riskLevel === tool.riskLevel);
    default:
      return false;
  }
}

function sourceLabel(entry: ToolProfileEntry | null, app: string): string {
  if (!entry) return t("localizationTools.addedDirectly170");
  if (entry.selectorType === "application" || entry.selectorType === "connection") return t("localizationTools.addedByAppRule", { app });
  if (entry.selectorType === "risk_level" && entry.riskLevel) return t("localizationTools.addedByRiskRule", { risk: toolRiskLabel(entry.riskLevel) });
  return t("localizationTools.addedDirectly170");
}

function capabilityLabel(tool: ToolCatalogEntry): string {
  if (tool.isDestructive) return t("localizationTools.destructive87");
  if (tool.isWrite) return t("localizationTools.write173");
  return t("localizationTools.read174");
}

function capabilityText(tool: ToolProfileNewToolReviewItem): string {
  if (tool.riskLevel === "destructive") return t("localizationTools.destructive87");
  if (tool.riskLevel === "write") return t("localizationTools.write173");
  if (tool.riskLevel === "read") return t("localizationTools.read174");
  return tool.capability;
}

function newToolsAppLabel(tools: ToolProfileNewToolReviewItem[]): string {
  const names = [...new Set(tools.map((tool) => tool.applicationName ?? tool.connectionName).filter(Boolean))] as string[];
  if (names.length === 0) return t("localizationTools.anApp175");
  if (names.length === 1) return names[0] ?? t("localizationTools.anApp175");
  if (names.length === 2) return t("localizationTools.twoApps", { first: names[0], second: names[1] });
  return t("localizationTools.appsAndMore", { name: names[0], count: names.length - 1 });
}

function isRecentTool(tool: ToolCatalogEntry): boolean {
  const value = tool.addedAt ?? tool.firstSeenAt;
  const added = new Date(value).getTime();
  if (!Number.isFinite(added)) return false;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  return Date.now() - added <= thirtyDaysMs;
}

function assignmentLabel(
  binding: ToolProfileBinding,
  companyId: string,
  maps: ReturnType<typeof useProfilesData>["maps"],
): string {
  if (binding.targetType === "company") return t("pages.companySettings.policyOption.companyDefault");
  if (binding.targetType === "agent") return maps.agentsById.get(binding.targetId) ?? t("pages.routines.unknownAgent");
  if (binding.targetType === "project") return maps.projectsById.get(binding.targetId) ?? t("pages.cases.unknownProject");
  if (binding.targetType === "routine") return maps.routinesById.get(binding.targetId) ?? t("localizationTools.unknownRoutine181");
  if (binding.targetId === companyId) return t("nav.company");
  return binding.targetId;
}

function assignmentTypeLabel(type: ToolProfileBinding["targetType"]): string {
  if (type === "company") return t("pages.companySettings.policyOption.companyDefault");
  if (type === "agent") return t("localizationFilters.agent");
  if (type === "project") return t("pages.routines.project");
  if (type === "routine") return t("localizationActivity.routine");
  return t("localizationTools.scopedAssignment187");
}
