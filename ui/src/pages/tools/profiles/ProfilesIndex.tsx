import { useTranslation } from "@/i18n";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, MoreHorizontal, Plus, ShieldCheck, Users } from "lucide-react";
import type { ToolProfileWithDetails } from "@paperclipai/shared";
import { useNavigate } from "@/lib/router";
import { toolsApi } from "@/api/tools";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/context/ToastContext";
import { EffectiveAgentPanel } from "../ProfilesTab";
import { LoadingState, RelativeTime, ToolsPageHeader } from "../shared";
import { ProfileActionDialog, type ProfileActionDialogKind } from "./ProfileActionDialog";
import { TEMPLATES, type TemplateKey } from "./profile-model";
import { useProfilesData } from "./useProfilesData";
import { allowsLabel, assignedLabel, isDraft, STATUS_LABEL } from "./profile-summary";

/** The wizard route for a fresh profile, optionally seeded with a template. */
function newProfileHref(template?: TemplateKey): string {
  return template
    ? `/apps/advanced/profiles/new?template=${encodeURIComponent(template)}`
    : "/apps/advanced/profiles/new";
}

function statusVariant(status: ToolProfileWithDetails["status"]): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "draft") return "secondary";
  return "outline";
}

export function ProfilesIndex({
  companyId,
  initialStatusFilter,
  initialResolverOpen,
}: {
  companyId: string;
  initialStatusFilter?: "active" | "archived";
  initialResolverOpen?: boolean;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { profiles, agents } = useProfilesData(companyId);
  const profilesView = useQueryView(profiles);
  const [resolverOpen, setResolverOpen] = useState(Boolean(initialResolverOpen));
  const [statusFilter, setStatusFilter] = useState<"active" | "archived">(initialStatusFilter ?? "active");
  const [actionDialog, setActionDialog] = useState<{
    kind: ProfileActionDialogKind;
    profile: ToolProfileWithDetails;
  } | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("check") === "1") setResolverOpen(true);
  }, []);

  const agentOptions = useMemo(
    () => (agents.data ?? []).map((a) => ({ id: a.id, name: a.name })),
    [agents.data],
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.profiles(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.testAgentAccesses() });
  };

  const errorBody = (error: unknown) => String((error as Error)?.message ?? error);

  const duplicate = useMutation({
    mutationFn: (profile: ToolProfileWithDetails) =>
      toolsApi.duplicateProfile(profile.id, { name: `${profile.name} (copy)` }),
    onSuccess: () => {
      pushToast({ title: translateAgentPage("agents:profile_duplicated"), body: translateAgentPage("agents:the_copy_is_not_assigned_to_anyone_yet"), tone: "success" });
      invalidate();
    },
    onError: (error: unknown) =>
      pushToast({ title: translateAgentPage("agents:could_not_duplicate"), body: errorBody(error), tone: "error" }),
  });

  const archive = useMutation({
    mutationFn: (profile: ToolProfileWithDetails) =>
      toolsApi.updateProfile(profile.id, { status: "archived" }),
    onSuccess: () => {
      pushToast({ title: translateAgentPage("agents:profile_archived"), tone: "success" });
      invalidate();
    },
    onError: (error: unknown) => pushToast({ title: translateAgentPage("agents:could_not_archive"), body: errorBody(error), tone: "error" }),
  });

  const restore = useMutation({
    mutationFn: (profile: ToolProfileWithDetails) =>
      toolsApi.updateProfile(profile.id, { status: "active" }),
    onSuccess: () => {
      pushToast({ title: translateAgentPage("agents:profile_restored"), tone: "success" });
      invalidate();
    },
    onError: (error: unknown) => pushToast({ title: translateAgentPage("agents:could_not_restore"), body: errorBody(error), tone: "error" }),
  });

  const remove = useMutation({
    mutationFn: (profile: ToolProfileWithDetails) => toolsApi.deleteProfile(profile.id),
    onSuccess: () => {
      pushToast({ title: translateAgentPage("agents:profile_deleted"), tone: "success" });
      invalidate();
    },
    onError: (error: unknown) => pushToast({ title: translateAgentPage("agents:could_not_delete"), body: errorBody(error), tone: "error" }),
  });

  const header = (
    <ToolsPageHeader
      title={translateAgentPage("agents:access_profiles")}
      description={translateAgentPage("agents:decide_which_tools_your_agents_can_use_build")}
      actions={
        <>
          <Button variant="outline" onClick={() => setResolverOpen(true)}>
            <ShieldCheck className="mr-1.5 h-4 w-4" />{translateAgentPage("agents:check_an_agent_s_access")}</Button>
          <Button onClick={() => navigate(newProfileHref())}>
            <Plus className="mr-1.5 h-4 w-4" />{translateAgentPage("agents:new_profile")}</Button>
        </>
      }
    />
  );

  const resolverDialog = (
    <Sheet open={resolverOpen} onOpenChange={setResolverOpen}>
      <SheetContent className="w-full gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border">
          <SheetTitle>{translateAgentPage("agents:check_an_agent_s_access")}</SheetTitle>
          <SheetDescription>{translateAgentPage("agents:see_exactly_which_tools_an_agent_can_use")}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <EffectiveAgentPanel companyId={companyId} agentOptions={agentOptions} />
        </div>
      </SheetContent>
    </Sheet>
  );

  if (profiles.isLoading || profilesView.kind === "reconnecting") {
    return (
      <div className="space-y-5">
        {header}
        <LoadingState label={translateAgentPage("agents:loading_profiles_b8f34c")} />
      </div>
    );
  }
  if (profilesView.kind === "error") {
    return (
      <div className="space-y-5">
        {header}
        <QueryErrorState
          error={profiles.error}
          action={translateAgentPage("agents:load_profiles")}
          onRetry={profilesView.retry}
          retrying={profilesView.isFetching}
        />
      </div>
    );
  }

  const allRows = profiles.data?.profiles ?? [];
  const rows = allRows.filter((p) => (statusFilter === "archived" ? p.status === "archived" : p.status !== "archived"));

  return (
    <div className="space-y-5">
      {header}

      <div className="inline-flex rounded-md border border-border p-0.5">
        {(["active", "archived"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setStatusFilter(key)}
            className={cn(
              "rounded px-3 py-1 text-sm font-medium",
              statusFilter === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {key === "active" ? translateAgentPage("agents:active") : translateAgentPage("agents:archived")}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        statusFilter === "archived" ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">{translateAgentPage("agents:no_archived_profiles")}</div>
        ) : (
          <EmptyTemplatePicker onPick={(key) => navigate(newProfileHref(key))} />
        )
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-(--sz-30pct)" />
              <col className="w-(--sz-18pct)" />
              <col className="w-(--sz-24pct)" />
              <col className="w-(--sz-12pct)" />
              <col className="w-(--sz-12pct)" />
              <col className="w-10" />
            </colgroup>
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs font-medium text-muted-foreground">
                <th className="px-3 py-2 font-medium">{translateAgentPage("agents:profile")}</th>
                <th className="px-3 py-2 font-medium">{translateAgentPage("agents:allows")}</th>
                <th className="px-3 py-2 font-medium">{translateAgentPage("agents:assigned_to")}</th>
                <th className="px-3 py-2 font-medium">{translateAgentPage("agents:status")}</th>
                <th className="px-3 py-2 font-medium">{translateAgentPage("agents:updated_f2f857")}</th>
                <th className="w-10 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((profile) => {
                const assigned = assignedLabel(profile.summary);
                const draft = isDraft(profile);
                const open = () => navigate(draft ? `/apps/advanced/profiles/${profile.id}/edit` : `/apps/advanced/profiles/${profile.id}`);
                return (
                  <tr
                    key={profile.id}
                    className="group h-10 border-b border-border last:border-0 hover:bg-accent/40"
                  >
                    <td className="min-w-0 px-3 py-1.5">
                      <button
                        type="button"
                        onClick={open}
                        title={profile.name}
                        className="block w-full truncate text-left font-medium text-foreground hover:underline"
                      >
                        {profile.name}
                      </button>
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <span>{allowsLabel(profile.summary)}</span>
                        {(profile.newToolsPendingCount ?? 0) > 0 ? (
                          <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-200">
                            {profile.newToolsPendingCount}{" "}{translateAgentPage("agents:new_c2a6b0")}</Badge>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      {assigned.unassigned ? (
                        <span className="text-muted-foreground">
                          {assigned.text}
                          <span className="ml-1 text-xs text-muted-foreground/70">{translateAgentPage("agents:does_not_change_access")}</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-foreground">
                          {profile.summary.isCompanyDefault ? null : (
                            <Users className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          {assigned.text}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="inline-flex items-center gap-2">
                        <Badge variant={statusVariant(profile.status)}>{STATUS_LABEL[profile.status]}</Badge>
                        {draft ? (
                          <button
                            type="button"
                            onClick={open}
                            className="text-xs font-medium text-primary hover:underline"
                          >{translateAgentPage("agents:resume")}</button>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <RelativeTime value={profile.updatedAt} />
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <RowMenu
                        onEdit={open}
                        onDuplicate={() => duplicate.mutate(profile)}
                        onArchive={() => archive.mutate(profile)}
                        onRestore={profile.status === "archived" ? () => setActionDialog({ kind: "restore", profile }) : undefined}
                        onDelete={() => setActionDialog({ kind: "delete", profile })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {resolverDialog}
      <ProfileActionDialog
        kind={actionDialog?.kind ?? null}
        profile={actionDialog?.profile ?? null}
        pending={restore.isPending || remove.isPending}
        onClose={() => setActionDialog(null)}
        onArchive={() => {
          if (!actionDialog) return;
          archive.mutate(actionDialog.profile, { onSuccess: () => setActionDialog(null) });
        }}
        onRestore={() => {
          if (!actionDialog) return;
          restore.mutate(actionDialog.profile, { onSuccess: () => setActionDialog(null) });
        }}
        onDelete={() => {
          if (!actionDialog) return;
          remove.mutate(actionDialog.profile, { onSuccess: () => setActionDialog(null) });
        }}
      />
    </div>
  );
}

function RowMenu({
  onEdit,
  onDuplicate,
  onArchive,
  onRestore,
  onDelete,
}: {
  onEdit: () => void;
  onDuplicate: () => void;
  onArchive: () => void;
  onRestore?: () => void;
  onDelete: () => void;
}) {
  const { t: translateAgentPage } = useTranslation("agents");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={translateAgentPage("agents:profile_actions")}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onEdit}>{translateAgentPage("agents:edit_530164")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onDuplicate}>{translateAgentPage("agents:duplicate")}</DropdownMenuItem>
        {onRestore ? (
          <DropdownMenuItem onSelect={onRestore}>
            <ArchiveRestore className="mr-1.5 h-4 w-4" />{translateAgentPage("agents:restore")}</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={onArchive}>{translateAgentPage("agents:archive")}</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">{translateAgentPage("agents:delete_f6fdbe")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Empty state (AP2): the same five step-1 template cards the wizard opens with. */
function EmptyTemplatePicker({ onPick }: { onPick: (key: TemplateKey) => void }) {
  const { t: translateAgentPage } = useTranslation("agents");
  return (
    <div className="rounded-lg border border-dashed border-border p-6">
      <div className="mb-4 max-w-2xl">
        <h3 className="text-base font-semibold text-foreground">{translateAgentPage("agents:create_your_first_access_profile")}</h3>
        <p className="text-sm text-muted-foreground">{translateAgentPage("agents:pick_a_starting_point_you_can_fine_tune")}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {TEMPLATES.map((template) => (
          <button
            key={template.key}
            type="button"
            onClick={() => onPick(template.key)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-md border border-border bg-card px-4 py-3 text-left transition-colors",
              "hover:border-primary hover:bg-primary/5",
            )}
          >
            <span className="text-sm font-medium text-foreground">{template.title}</span>
            <span className="text-xs text-muted-foreground">{template.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
