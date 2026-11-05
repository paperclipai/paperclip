import { t as translateAgentPage, useTranslation } from "@/i18n";
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
import { QueryErrorState, useQueryView } from "@/components/QueryView";
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
import { LoadingState, RelativeTime, ToolsPageHeader } from "../shared";
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
  sourceIsRule: boolean;
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
  const { t: translateAgentPage } = useTranslation("agents");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const data = useProfilesData(companyId);
  const profilesView = useQueryView(data.profiles);
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
  const newToolsView = useQueryView(newTools);
  const newToolsLoading = newTools.isLoading || newToolsView.kind === "reconnecting";

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.profiles(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.testAgentAccesses() });
  };
  const errorBody = (error: unknown) => String((error as Error)?.message ?? error);

  const allowRows = useMemo(
    () => (profile ? buildAllowRows(profile, data.catalog, data.maps.applicationsById, data.maps.connectionsById, data.connections.data?.connections ?? []) : []),
    [profile, data.catalog, data.maps.applicationsById, data.maps.connectionsById, data.connections.data?.connections, translateAgentPage],
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
      pushToast({ title: translateAgentPage("agents:profile_updated"), tone: "success" });
    },
    onError: (error: unknown) => pushToast({ title: translateAgentPage("agents:could_not_update_profile"), body: errorBody(error), tone: "error" }),
  });

  const duplicateProfile = useMutation({
    mutationFn: (input: { name: string; includeAssignments: boolean }) => toolsApi.duplicateProfile(profileId, input),
    onSuccess: (copy) => {
      invalidate();
      pushToast({ title: translateAgentPage("agents:profile_duplicated"), body: translateAgentPage("agents:the_copy_is_not_assigned_to_anyone_yet"), tone: "success" });
      navigate(`/apps/advanced/profiles/${copy.id}?created=1`);
    },
    onError: (error: unknown) => pushToast({ title: translateAgentPage("agents:could_not_duplicate"), body: errorBody(error), tone: "error" }),
  });

  const deleteProfile = useMutation({
    mutationFn: () => toolsApi.deleteProfile(profileId),
    onSuccess: () => {
      invalidate();
      pushToast({ title: translateAgentPage("agents:profile_deleted"), tone: "success" });
      navigate("/apps/advanced/profiles");
    },
    onError: (error: unknown) => pushToast({ title: translateAgentPage("agents:could_not_delete"), body: errorBody(error), tone: "error" }),
  });

  const removeAssignment = useMutation({
    mutationFn: (binding: ToolProfileBinding) =>
      toolsApi.unbindProfile(companyId, profileId, { targetType: binding.targetType, targetId: binding.targetId }),
    onSuccess: () => {
      setAssignmentToRemove(null);
      invalidate();
      pushToast({ title: translateAgentPage("agents:assignment_removed"), tone: "success" });
    },
    onError: (error: unknown) => pushToast({ title: translateAgentPage("agents:could_not_remove_assignment"), body: errorBody(error), tone: "error" }),
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
      pushToast({ title: translateAgentPage("agents:new_tools_reviewed"), tone: "success" });
    },
    onError: (error: unknown) => pushToast({ title: translateAgentPage("agents:could_not_submit_review"), body: errorBody(error), tone: "error" }),
  });

  if (data.profiles.isLoading || profilesView.kind === "reconnecting") return <LoadingState label={translateAgentPage("agents:loading_profile")} />;
  if (profilesView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={data.profiles.error}
        action={translateAgentPage("agents:load_the_profile")}
        onRetry={profilesView.retry}
        retrying={profilesView.isFetching}
      />
    );
  }
  if (!profile) {
    return (
      <div className="space-y-4">
        <ToolsPageHeader title={translateAgentPage("agents:profile_not_found")} description={translateAgentPage("agents:this_access_profile_may_have_been_deleted")} />
        <Button variant="outline" onClick={() => navigate("/apps/advanced/profiles")}>{translateAgentPage("agents:back_to_profiles")}</Button>
      </div>
    );
  }

  const archived = profile.status === "archived";
  const unassigned = profile.summary.assignmentCount === 0;

  return (
    <div className="space-y-6">
      <ToolsPageHeader
        title={profile.name}
        description={profile.description ?? translateAgentPage("agents:no_description_yet")}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={archived} onClick={() => setDialog("edit")}>
              <Pencil className="mr-1.5 h-4 w-4" />{translateAgentPage("agents:edit_530164")}</Button>
            <Button variant="outline" disabled={archived} onClick={() => setDialog("duplicate")}>
              <Copy className="mr-1.5 h-4 w-4" />{translateAgentPage("agents:duplicate")}</Button>
            {archived ? (
              <Button variant="outline" onClick={() => setDialog("restore")}>
                <ArchiveRestore className="mr-1.5 h-4 w-4" />{translateAgentPage("agents:restore")}</Button>
            ) : (
              <Button variant="outline" onClick={() => setDialog("archive")}>{translateAgentPage("agents:archive")}</Button>
            )}
            <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDialog("delete")}>
              <Trash2 className="mr-1.5 h-4 w-4" />{translateAgentPage("agents:delete_f6fdbe")}</Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant={archived ? "outline" : "default"}>{STATUS_LABEL[profile.status]}</Badge>
        <span className="text-muted-foreground">{translateAgentPage("agents:updated_f2f857")}{" "}<RelativeTime value={profile.updatedAt} /></span>
        <span className="text-muted-foreground">{allowsLabel(profile.summary)}</span>
      </div>

      {created ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">{translateAgentPage("agents:profile_saved")}</p>
            <p className="text-sm text-muted-foreground">
              {unassigned ? translateAgentPage("agents:assign_it_to_agents_before_it_changes_their") : translateAgentPage("agents:assignments_are_active_now")}
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => navigate(`/apps/advanced/profiles/${profile.id}/edit?step=3`)}>{translateAgentPage("agents:assign")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setSearchParams({})}>{translateAgentPage("agents:dismiss")}</Button>
          </div>
        </div>
      ) : null}

      {archived ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">{translateAgentPage("agents:this_profile_is_archived_it_does_not_apply")}</div>
      ) : null}

      {pendingNewTools > 0 ? (
        <NewToolsReviewBanner
          count={pendingNewTools}
          tools={reviewItems}
          loading={newToolsLoading}
          onReview={() => setReviewOpen(true)}
        />
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">{translateAgentPage("agents:what_it_allows")}</h2>
          <Button variant="outline" size="sm" disabled={archived} onClick={() => navigate(`/apps/advanced/profiles/${profile.id}/edit?step=2`)}>{translateAgentPage("agents:edit_tools")}</Button>
        </div>
        <AllowList rows={allowRows} total={profile.summary.totalToolCount} />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-foreground">{translateAgentPage("agents:who_has_it")}</h2>
          <Button variant="outline" size="sm" disabled={archived} onClick={() => navigate(`/apps/advanced/profiles/${profile.id}/edit?step=3`)}>{translateAgentPage("agents:assign")}</Button>
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
        <h2 className="text-base font-semibold text-foreground">{translateAgentPage("agents:new_tools_that_appear_later")}</h2>
        <NewToolsSetting
          value={profile.defaultAction}
          disabled={archived || updateProfile.isPending}
          onChange={(defaultAction) => updateProfile.mutate({ defaultAction })}
        />
      </section>

      <Button variant="link" className="h-auto px-0" onClick={() => navigate("/apps/advanced/profiles?check=1")}>
        <ShieldCheck className="mr-1.5 h-4 w-4" />{translateAgentPage("agents:check_what_an_agent_can_actually_do")}</Button>

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
        loading={newToolsLoading}
        error={newToolsView.kind === "error" ? newTools.error : null}
        decisions={reviewDecisions}
        pending={reviewNewTools.isPending}
        onClose={() => setReviewOpen(false)}
        onRetry={newToolsView.retry}
        retrying={newToolsView.isFetching}
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
  const { t: translateAgentPage } = useTranslation("agents");
  const appLabel = newToolsAppLabel(tools);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <div>
        <p className="font-medium">
          {loading ? translateAgentPage("agents:new_tools_need_review") : translateAgentPage("agents:added_new_since_your_last_review", { value1: appLabel, value2: count, value3: count === 1 ? translateAgentPage("agents:tool") : translateAgentPage("agents:tools_0284c6") })}
        </p>
        <p className="text-amber-900/80">{translateAgentPage("agents:choose_which_ones_this_profile_should_allow")}</p>
      </div>
      <Button size="sm" onClick={onReview}>{translateAgentPage("agents:review")}</Button>
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
  retrying,
  onDecision,
  onSubmit,
}: {
  open: boolean;
  tools: ToolProfileNewToolReviewItem[];
  loading: boolean;
  /** Set only for a real (non-transient) failure with nothing to show. */
  error: unknown;
  decisions: Record<string, ToolProfileNewToolReviewDecision>;
  pending: boolean;
  onClose: () => void;
  onRetry: () => void;
  retrying: boolean;
  onDecision: (catalogEntryId: string, decision: ToolProfileNewToolReviewDecision) => void;
  onSubmit: () => void;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{translateAgentPage("agents:review_new_tools")}</DialogTitle>
          <DialogDescription>{translateAgentPage("agents:allow_the_tools_this_profile_should_use_keep")}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <LoadingState label={translateAgentPage("agents:loading_new_tools")} />
        ) : error ? (
          <QueryErrorState error={error} action={translateAgentPage("agents:load_new_tools")} onRetry={onRetry} retrying={retrying} />
        ) : tools.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">{translateAgentPage("agents:there_are_no_new_tools_waiting_for_review")}</div>
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
                    {tool.applicationName ?? tool.connectionName ?? translateAgentPage("agents:app_tool")}{" "}{translateAgentPage("agents:added")}{" "}{formatShortDate(tool.addedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2 sm:justify-end">
                  <label className="inline-flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name={`review-${tool.catalogEntryId}`}
                      checked={(decisions[tool.catalogEntryId] ?? "keep_blocked") === "allow"}
                      onChange={() => onDecision(tool.catalogEntryId, "allow")}
                    />{translateAgentPage("agents:allow")}</label>
                  <label className="inline-flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      name={`review-${tool.catalogEntryId}`}
                      checked={(decisions[tool.catalogEntryId] ?? "keep_blocked") === "keep_blocked"}
                      onChange={() => onDecision(tool.catalogEntryId, "keep_blocked")}
                    />{translateAgentPage("agents:keep_blocked")}</label>
                </div>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{translateAgentPage("agents:cancel")}</Button>
          <Button disabled={pending || loading || tools.length === 0} onClick={onSubmit}>{translateAgentPage("agents:submit_review")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AllowList({ rows, total }: { rows: AllowRow[]; total: number }) {
  const { t: translateAgentPage } = useTranslation("agents");
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">{translateAgentPage("agents:this_profile_allows_0_tools_agents_with_only")}</div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-xs font-medium text-muted-foreground">
            <th className="px-3 py-2 font-medium">{translateAgentPage("agents:tool_9a830c")}</th>
            <th className="px-3 py-2 font-medium">{translateAgentPage("agents:app")}</th>
            <th className="px-3 py-2 font-medium">{translateAgentPage("agents:capabilities")}</th>
            <th className="px-3 py-2 font-medium">{translateAgentPage("agents:source")}</th>
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
                      <PlugZap className="h-3 w-3" />{translateAgentPage("agents:reconnect")}</a>
                  ) : null}
                </div>
              </td>
              <td className="px-3 py-2">
                <span>{row.app}</span>
                {row.degraded ? <span className="ml-2 text-xs text-muted-foreground">{row.app}{" "}{translateAgentPage("agents:is_disconnected")}</span> : null}
              </td>
              <td className="px-3 py-2 text-muted-foreground">{row.capabilities}</td>
              <td className="px-3 py-2">
                {row.sourceIsRule ? (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-950">{row.source}</span>
                ) : (
                  <span className="text-muted-foreground">{row.source}</span>
                )}
                {row.autoAddedAt ? (
                  <div className="mt-0.5 text-xs text-muted-foreground">{translateAgentPage("agents:added_automatically")}{" "}{formatShortDate(row.autoAddedAt)}
                  </div>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 80 ? (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{translateAgentPage("agents:showing_80_of")}{" "}{rows.length}{" "}{translateAgentPage("agents:allowed_tools_78b6de")}</p>
      ) : (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{translateAgentPage("agents:allows")}{" "}{rows.length}{" "}{translateAgentPage("agents:of")}{" "}{total}{" "}{translateAgentPage("agents:known_tools")}</p>
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
  const { t: translateAgentPage } = useTranslation("agents");
  if (profile.bindings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-5">
        <p className="text-sm font-medium text-foreground">{translateAgentPage("agents:not_assigned_yet")}</p>
        <p className="text-sm text-muted-foreground">{translateAgentPage("agents:assign_this_profile_before_it_changes_access")}</p>
      </div>
    );
  }
  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {profile.bindings.map((binding) => (
        <div key={binding.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
              {binding.targetType === "company" ? translateAgentPage("agents:or") : binding.targetType.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{assignmentLabel(binding, companyId, maps)}</p>
              <p className="text-xs text-muted-foreground">{assignmentTypeLabel(binding.targetType)}</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" disabled={archived} onClick={() => onRemove(binding)}>
            <UserMinus className="mr-1.5 h-4 w-4" />{translateAgentPage("agents:remove")}</Button>
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
  const { t: translateAgentPage } = useTranslation("agents");
  const options: Array<{ value: ToolProfileDefaultAction; title: string; body: string }> = [
    { value: "deny", title: translateAgentPage("agents:stay_blocked_until_reviewed"), body: translateAgentPage("agents:new_tools_do_not_become_available_automatically") },
    { value: "allow", title: translateAgentPage("agents:allowed_automatically"), body: translateAgentPage("agents:new_tools_from_selected_apps_become_available_right") },
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
  const { t: translateAgentPage } = useTranslation("agents");
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description ?? "");
  const [profileKey, setProfileKey] = useState(profile.profileKey);
  const [copyName, setCopyName] = useState(`${profile.name} copy`);
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
            <DialogTitle>{translateAgentPage("agents:edit_profile")}</DialogTitle>
            <DialogDescription>{translateAgentPage("agents:update_the_profile_name_and_description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-profile-name">{translateAgentPage("agents:name")}</Label>
              <Input id="edit-profile-name" value={name} onChange={(e) => setName(e.target.value)} />
              {duplicateName ? <p className="text-xs text-destructive">{translateAgentPage("agents:another_profile_already_uses_this_name")}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-profile-description">{translateAgentPage("agents:description")}</Label>
              <Textarea id="edit-profile-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
            </div>
            <button type="button" className="text-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => setAdvancedOpen((v) => !v)}>{translateAgentPage("agents:advanced")}</button>
            {advancedOpen ? (
              <div className="space-y-1.5">
                <Label htmlFor="edit-profile-key">{translateAgentPage("agents:identifier")}</Label>
                <Input id="edit-profile-key" value={profileKey} onChange={(e) => setProfileKey(e.target.value)} className="font-mono text-xs" />
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{translateAgentPage("agents:cancel")}</Button>
            <Button disabled={!name.trim() || duplicateName || pending} onClick={() => onUpdate({ name: name.trim(), description: description.trim() || null, profileKey: profileKey.trim() })}>{translateAgentPage("agents:save")}</Button>
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
            <DialogTitle>{translateAgentPage("agents:duplicate_profile")}</DialogTitle>
            <DialogDescription>{translateAgentPage("agents:the_copy_starts_unassigned_unless_you_choose_to")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="copy-profile-name">{translateAgentPage("agents:name")}</Label>
              <Input id="copy-profile-name" value={copyName} onChange={(e) => setCopyName(e.target.value)} />
              {duplicateCopyName ? <p className="text-xs text-destructive">{translateAgentPage("agents:another_profile_already_uses_this_name")}</p> : null}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={copyAssignments} onChange={(e) => setCopyAssignments(e.target.checked)} />{translateAgentPage("agents:also_copy_assignments")}</label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>{translateAgentPage("agents:cancel")}</Button>
            <Button disabled={!copyName.trim() || duplicateCopyName || pending} onClick={() => onDuplicate({ name: copyName.trim(), includeAssignments: copyAssignments })}>{translateAgentPage("agents:duplicate")}</Button>
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
  const { t: translateAgentPage } = useTranslation("agents");
  return (
    <Dialog open={Boolean(binding)} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{translateAgentPage("agents:remove_assignment")}</DialogTitle>
          <DialogDescription>
            {binding?.targetType === "company"
              ? translateAgentPage("agents:removing_the_organization_default_changes_access_for_every")
              : translateAgentPage("agents:remove_this_profile_from", { value1: label })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{translateAgentPage("agents:cancel")}</Button>
          <Button disabled={pending} onClick={onConfirm}>{translateAgentPage("agents:remove")}</Button>
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
      const app = appNames.get(tool.applicationId ?? "") ?? connectionNames.get(tool.connectionId) ?? translateAgentPage("agents:unknown_app");
      const connection = connections.find((item) => item.id === tool.connectionId);
      return {
        id: tool.id,
        app,
        tool: tool.title || tool.toolName,
        capabilities: capabilityLabel(tool),
        source: sourceLabel(match, app),
        sourceIsRule: Boolean(match && ["application", "connection", "risk_level"].includes(match.selectorType)),
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
  if (!entry) return translateAgentPage("agents:added_directly");
  if (entry.selectorType === "application" || entry.selectorType === "connection") return translateAgentPage("agents:added_by_rule_all", { value1: app });
  if (entry.selectorType === "risk_level" && entry.riskLevel) return translateAgentPage("agents:added_by_rule_tools", { value1: entry.riskLevel });
  return translateAgentPage("agents:added_directly");
}

function capabilityLabel(tool: ToolCatalogEntry): string {
  if (tool.isDestructive) return translateAgentPage("agents:destructive");
  if (tool.isWrite) return translateAgentPage("agents:write_4a4893");
  return translateAgentPage("agents:read_852b43");
}

function capabilityText(tool: ToolProfileNewToolReviewItem): string {
  if (tool.riskLevel === "destructive") return translateAgentPage("agents:destructive");
  if (tool.riskLevel === "write") return translateAgentPage("agents:write_4a4893");
  if (tool.riskLevel === "read") return translateAgentPage("agents:read_852b43");
  return tool.capability;
}

function newToolsAppLabel(tools: ToolProfileNewToolReviewItem[]): string {
  const names = [...new Set(tools.map((tool) => tool.applicationName ?? tool.connectionName).filter(Boolean))] as string[];
  if (names.length === 0) return translateAgentPage("agents:an_app");
  if (names.length === 1) return names[0] ?? translateAgentPage("agents:an_app");
  if (names.length === 2) return translateAgentPage("agents:and_38c2f9", { value1: names[0], value2: names[1] });
  return translateAgentPage("agents:and_more_apps", { value1: names[0], value2: names.length - 1 });
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
  if (binding.targetType === "company") return translateAgentPage("agents:organization_default");
  if (binding.targetType === "agent") return maps.agentsById.get(binding.targetId) ?? translateAgentPage("agents:unknown_agent");
  if (binding.targetType === "project") return maps.projectsById.get(binding.targetId) ?? translateAgentPage("agents:unknown_project");
  if (binding.targetType === "routine") return maps.routinesById.get(binding.targetId) ?? translateAgentPage("agents:unknown_routine");
  if (binding.targetId === companyId) return translateAgentPage("agents:organization");
  return binding.targetId;
}

function assignmentTypeLabel(type: ToolProfileBinding["targetType"]): string {
  if (type === "company") return translateAgentPage("agents:organization_default");
  if (type === "agent") return translateAgentPage("agents:agent_5ce2e6");
  if (type === "project") return translateAgentPage("agents:project_f6f4da");
  if (type === "routine") return translateAgentPage("agents:routine_482273");
  return translateAgentPage("agents:scoped_assignment");
}
