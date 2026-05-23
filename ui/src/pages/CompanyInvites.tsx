import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, MailPlus } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/i18n";

const INVITE_HISTORY_PAGE_SIZE = 5;

function isInviteHistoryRow(value: unknown): value is Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number] {
  if (!value || typeof value !== "object") return false;
  return "id" in value && "state" in value && "createdAt" in value;
}

export function CompanyInvites() {
  const { t } = useTranslation();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [humanRole, setHumanRole] = useState<"owner" | "admin" | "operator" | "viewer">("operator");
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [latestInviteCopied, setLatestInviteCopied] = useState(false);

  const inviteRoleOptions = useMemo(() => [
    {
      value: "viewer" as const,
      label: t("companyInvites.roles.viewer.label", { defaultValue: "Viewer" }),
      description: t("companyInvites.roles.viewer.description", { defaultValue: "Can view company work and follow along." }),
      gets: t("companyInvites.roles.viewer.gets", { defaultValue: "View-only company membership." }),
    },
    {
      value: "operator" as const,
      label: t("companyInvites.roles.operator.label", { defaultValue: "Operator" }),
      description: t("companyInvites.roles.operator.description", { defaultValue: "Recommended for people who need to help run work without managing access." }),
      gets: t("companyInvites.roles.operator.gets", { defaultValue: "Can assign tasks." }),
    },
    {
      value: "admin" as const,
      label: t("companyInvites.roles.admin.label", { defaultValue: "Admin" }),
      description: t("companyInvites.roles.admin.description", { defaultValue: "Recommended for operators who need to invite people, create agents, and approve joins." }),
      gets: t("companyInvites.roles.admin.gets", { defaultValue: "Can create agents, invite users, assign tasks, and approve join requests." }),
    },
    {
      value: "owner" as const,
      label: t("companyInvites.roles.owner.label", { defaultValue: "Owner" }),
      description: t("companyInvites.roles.owner.description", { defaultValue: "Full company access, including membership management." }),
      gets: t("companyInvites.roles.owner.gets", { defaultValue: "Everything in Admin, plus managing members." }),
    },
  ], [t]);

  useEffect(() => {
    if (!latestInviteCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestInviteCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestInviteCopied]);

  async function copyInviteUrl(url: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        return true;
      }
    } catch {
      // Fall through to the unavailable message below.
    }

    pushToast({
      title: t("companyInvites.clipboardUnavailable", { defaultValue: "Clipboard unavailable" }),
      body: t("companyInvites.clipboardUnavailableBody", { defaultValue: "Copy the invite URL manually from the field below." }),
      tone: "warn",
    });
    return false;
  }

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("companySettings.company", { defaultValue: "Company" }), href: "/dashboard" },
      { label: t("companySettings.settings", { defaultValue: "Settings" }), href: "/company/settings" },
      { label: t("companyInvites.title", { defaultValue: "Invites" }) },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs, t]);

  const inviteHistoryQueryKey = queryKeys.access.invites(selectedCompanyId ?? "", "all", INVITE_HISTORY_PAGE_SIZE);
  const invitesQuery = useInfiniteQuery({
    queryKey: inviteHistoryQueryKey,
    queryFn: ({ pageParam }) =>
      accessApi.listInvites(selectedCompanyId!, {
        limit: INVITE_HISTORY_PAGE_SIZE,
        offset: pageParam,
      }),
    enabled: !!selectedCompanyId,
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
  const inviteHistory = useMemo(
    () =>
      invitesQuery.data?.pages.flatMap((page) =>
        Array.isArray(page?.invites) ? page.invites.filter(isInviteHistoryRow) : [],
      ) ?? [],
    [invitesQuery.data?.pages],
  );

  const createInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "human",
        humanRole,
        agentMessage: null,
      }),
    onSuccess: async (invite) => {
      setLatestInviteUrl(invite.inviteUrl);
      setLatestInviteCopied(false);
      const copied = await copyInviteUrl(invite.inviteUrl);

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: t("companyInvites.toast.created.title", { defaultValue: "Invite created" }),
        body: copied
          ? t("companyInvites.toast.created.bodyCopied", { defaultValue: "Invite ready below and copied to clipboard." })
          : t("companyInvites.toast.created.body", { defaultValue: "Invite ready below." }),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyInvites.toast.createFailed", { defaultValue: "Failed to create invite" }),
        body: error instanceof Error ? error.message : t("companyInvites.unknownError", { defaultValue: "Unknown error" }),
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({ title: t("companyInvites.toast.revoked", { defaultValue: "Invite revoked" }), tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: t("companyInvites.toast.revokeFailed", { defaultValue: "Failed to revoke invite" }),
        body: error instanceof Error ? error.message : t("companyInvites.unknownError", { defaultValue: "Unknown error" }),
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("companyInvites.selectCompany", { defaultValue: "Select a company to manage invites." })}</div>;
  }

  if (invitesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("companyInvites.loading", { defaultValue: "Loading invites…" })}</div>;
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? t("companyInvites.forbidden", { defaultValue: "You do not have permission to manage company invites." })
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : t("companyInvites.loadFailed", { defaultValue: "Failed to load invites." });
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-5xl space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MailPlus className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("companyInvites.heading", { defaultValue: "Company Invites" })}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("companyInvites.intro", { defaultValue: "Create human invite links for company access. New invite links are copied to your clipboard when they are generated." })}
        </p>
      </div>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t("companyInvites.create.heading", { defaultValue: "Create invite" })}</h2>
          <p className="text-sm text-muted-foreground">
            {t("companyInvites.create.description", { defaultValue: "Generate a human invite link and choose the default access it should request." })}
          </p>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("companyInvites.create.chooseRole", { defaultValue: "Choose a role" })}</legend>
          <div className="rounded-xl border border-border">
            {inviteRoleOptions.map((option, index) => {
              const checked = humanRole === option.value;
              return (
                <label
                  key={option.value}
                  className={`flex cursor-pointer gap-3 px-4 py-4 ${index > 0 ? "border-t border-border" : ""}`}
                >
                  <input
                    type="radio"
                    name="invite-role"
                    value={option.value}
                    checked={checked}
                    onChange={() => setHumanRole(option.value)}
                    className="mt-1 h-4 w-4 border-border text-foreground"
                  />
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      {option.value === "operator" ? (
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {t("companyInvites.create.default", { defaultValue: "Default" })}
                        </span>
                      ) : null}
                    </span>
                    <span className="block max-w-2xl text-sm text-muted-foreground">{option.description}</span>
                    <span className="block text-sm text-foreground">{option.gets}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          {t("companyInvites.create.singleUse", { defaultValue: "Each invite link is single-use. The first successful use consumes the link and creates or reuses the matching join request before approval." })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending
              ? t("companyInvites.create.creating", { defaultValue: "Creating…" })
              : t("companyInvites.create.heading", { defaultValue: "Create invite" })}
          </Button>
          <span className="text-sm text-muted-foreground">{t("companyInvites.create.auditNote", { defaultValue: "Invite history below keeps the audit trail." })}</span>
        </div>

        {latestInviteUrl ? (
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{t("companyInvites.latest.title", { defaultValue: "Latest invite link" })}</div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    {t("companyInvites.latest.copied", { defaultValue: "Copied" })}
                  </div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">
                {t("companyInvites.latest.urlNote", { defaultValue: "This URL includes the current Paperclip domain returned by the server." })}
              </div>
            </div>
            <button
              type="button"
              onClick={async () => {
                const copied = await copyInviteUrl(latestInviteUrl);
                setLatestInviteCopied(copied);
              }}
              className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-left text-sm break-all transition-colors hover:bg-background"
            >
              {latestInviteUrl}
            </button>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" asChild>
                <a href={latestInviteUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("companyInvites.latest.open", { defaultValue: "Open invite" })}
                </a>
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("companyInvites.history.heading", { defaultValue: "Invite history" })}</h2>
            <p className="text-sm text-muted-foreground">
              {t("companyInvites.history.description", { defaultValue: "Review invite status, role, inviter, and any linked join request." })}
            </p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">
            {t("companyInvites.history.openQueue", { defaultValue: "Open join request queue" })}
          </Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">
            {t("companyInvites.history.empty", { defaultValue: "No invites have been created for this company yet." })}
          </div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.history.col.state", { defaultValue: "State" })}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.history.col.role", { defaultValue: "Role" })}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.history.col.invitedBy", { defaultValue: "Invited by" })}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.history.col.created", { defaultValue: "Created" })}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.history.col.joinRequest", { defaultValue: "Join request" })}</th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">{t("companyInvites.history.col.action", { defaultValue: "Action" })}</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteHistory.map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {formatInviteState(invite.state, t)}
                        </span>
                      </td>
                      <td className="px-5 py-3 align-top">{invite.humanRole ?? "—"}</td>
                      <td className="px-5 py-3 align-top">
                        <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || t("companyInvites.history.unknownInviter", { defaultValue: "Unknown inviter" })}</div>
                        {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                          <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 align-top text-muted-foreground">
                        {new Date(invite.createdAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {invite.relatedJoinRequestId ? (
                          <Link to="/inbox/requests" className="underline underline-offset-4">
                            {t("companyInvites.history.reviewRequest", { defaultValue: "Review request" })}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right align-top">
                        {invite.state === "active" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => revokeMutation.mutate(invite.id)}
                            disabled={revokeMutation.isPending}
                          >
                            {t("companyInvites.history.revoke", { defaultValue: "Revoke" })}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("companyInvites.history.inactive", { defaultValue: "Inactive" })}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {invitesQuery.hasNextPage ? (
              <div className="flex justify-center border-t border-border px-5 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => invitesQuery.fetchNextPage()}
                  disabled={invitesQuery.isFetchingNextPage}
                >
                  {invitesQuery.isFetchingNextPage
                    ? t("companyInvites.history.loadingMore", { defaultValue: "Loading more…" })
                    : t("companyInvites.history.viewMore", { defaultValue: "View more" })}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function formatInviteState(
  state: "active" | "accepted" | "expired" | "revoked",
  t: (key: string, opts?: { defaultValue?: string }) => string,
) {
  switch (state) {
    case "active":
      return t("companyInvites.state.active", { defaultValue: "Active" });
    case "accepted":
      return t("companyInvites.state.accepted", { defaultValue: "Accepted" });
    case "expired":
      return t("companyInvites.state.expired", { defaultValue: "Expired" });
    case "revoked":
      return t("companyInvites.state.revoked", { defaultValue: "Revoked" });
  }
}
