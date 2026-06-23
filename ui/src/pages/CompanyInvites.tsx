import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, MailPlus } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { t, useTranslation } from "@/i18n";

const inviteRoleOptions = [
  {
    value: "viewer",
    label: t("pages.companyInvites.roleViewerLabel", { defaultValue: "Viewer" }),
    description: t("pages.companyInvites.roleViewerDescription", {
      defaultValue: "Can view company work and follow along.",
    }),
    gets: t("pages.companyInvites.roleViewerGets", { defaultValue: "View-only company membership." }),
  },
  {
    value: "operator",
    label: t("pages.companyInvites.roleOperatorLabel", { defaultValue: "Operator" }),
    description: t("pages.companyInvites.roleOperatorDescription", {
      defaultValue: "Recommended for people who need to help run work without managing access.",
    }),
    gets: t("pages.companyInvites.roleOperatorGets", { defaultValue: "Can assign tasks." }),
  },
  {
    value: "admin",
    label: t("pages.companyInvites.roleAdminLabel", { defaultValue: "Admin" }),
    description: t("pages.companyInvites.roleAdminDescription", {
      defaultValue: "Recommended for operators who need to invite people, create agents, and approve joins.",
    }),
    gets: t("pages.companyInvites.roleAdminGets", {
      defaultValue: "Can create agents, invite users, assign tasks, and approve join requests.",
    }),
  },
  {
    value: "owner",
    label: t("pages.companyInvites.roleOwnerLabel", { defaultValue: "Owner" }),
    description: t("pages.companyInvites.roleOwnerDescription", {
      defaultValue: "Full company access, including membership management.",
    }),
    gets: t("pages.companyInvites.roleOwnerGets", { defaultValue: "Everything in Admin, plus managing members." }),
  },
] as const;

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
  const latestInviteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!latestInviteCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestInviteCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestInviteCopied]);

  function selectLatestInviteUrl() {
    latestInviteInputRef.current?.focus();
    latestInviteInputRef.current?.select();
  }

  async function copyText(text: string, unavailableBody: string, afterFallback?: () => void) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to the unavailable message below.
    }

    const canUseLegacyCopy =
      typeof document !== "undefined" &&
      typeof document.execCommand === "function" &&
      (typeof document.queryCommandSupported !== "function" || document.queryCommandSupported("copy"));
    if (canUseLegacyCopy) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.top = "0";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);

      try {
        const copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        afterFallback?.();
        if (copied) return true;
      } catch {
        document.body.removeChild(textarea);
      }
    }

    afterFallback?.();
    pushToast({
      title: t("pages.companyInvites.toastClipboardUnavailableTitle", { defaultValue: "Clipboard unavailable" }),
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  async function copyInviteUrl(url: string) {
    return copyText(
      url,
      t("pages.companyInvites.copyInviteUrlManual", {
        defaultValue: "The invite URL is selected. Copy it manually from the field.",
      }),
      selectLatestInviteUrl,
    );
  }

  useEffect(() => {
    setBreadcrumbs([
      {
        label: selectedCompany?.name ?? t("pages.companyInvites.breadcrumbCompany", { defaultValue: "Company" }),
        href: "/dashboard",
      },
      { label: t("pages.companyInvites.breadcrumbSettings", { defaultValue: "Settings" }), href: "/company/settings" },
      { label: t("pages.companyInvites.breadcrumbInvites", { defaultValue: "Invites" }) },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

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
      const copied = await copyText(
        invite.inviteUrl,
        t("pages.companyInvites.copyInviteUrlManualBelow", {
          defaultValue: "Copy the invite URL manually from the field below.",
        }),
      );

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: t("pages.companyInvites.toastInviteCreatedTitle", { defaultValue: "Invite created" }),
        body: copied
          ? t("pages.companyInvites.toastInviteCreatedBodyCopied", {
              defaultValue: "Invite ready below and copied to clipboard.",
            })
          : t("pages.companyInvites.toastInviteCreatedBody", { defaultValue: "Invite ready below." }),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("pages.companyInvites.toastInviteCreateFailedTitle", { defaultValue: "Failed to create invite" }),
        body: error instanceof Error ? error.message : t("pages.companyInvites.unknownError", { defaultValue: "Unknown error" }),
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({ title: t("pages.companyInvites.toastInviteRevokedTitle", { defaultValue: "Invite revoked" }), tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: t("pages.companyInvites.toastInviteRevokeFailedTitle", { defaultValue: "Failed to revoke invite" }),
        body: error instanceof Error ? error.message : t("pages.companyInvites.unknownError", { defaultValue: "Unknown error" }),
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("pages.companyInvites.selectCompany", { defaultValue: "Select a company to manage invites." })}
      </div>
    );
  }

  if (invitesQuery.isLoading) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("pages.companyInvites.loadingInvites", { defaultValue: "Loading invites…" })}
      </div>
    );
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? t("pages.companyInvites.errorNoPermission", {
            defaultValue: "You do not have permission to manage company invites.",
          })
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : t("pages.companyInvites.errorLoadFailed", { defaultValue: "Failed to load invites." });
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-5xl space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MailPlus className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("pages.companyInvites.pageTitle", { defaultValue: "Company Invites" })}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("pages.companyInvites.pageIntro", {
            defaultValue:
              "Invite people to request access to this company. New invite links are copied to your clipboard when they are generated.",
          })}
        </p>
      </div>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">
            {t("pages.companyInvites.inviteSectionTitle", { defaultValue: "Invite a person" })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("pages.companyInvites.inviteSectionDescription", {
              defaultValue: "Generate a human invite link and choose the default access it should request.",
            })}
          </p>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">
            {t("pages.companyInvites.chooseRole", { defaultValue: "Choose a role" })}
          </legend>
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
                          {t("pages.companyInvites.defaultBadge", { defaultValue: "Default" })}
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
          {t("pages.companyInvites.inviteLinkNote", {
            defaultValue:
              "Each invite link is single-use. Human invitees get the selected role immediately after sign-in; agent invites still create a join request for approval.",
          })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending
              ? t("pages.companyInvites.creating", { defaultValue: "Creating…" })
              : t("pages.companyInvites.createInvite", { defaultValue: "Create invite" })}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t("pages.companyInvites.auditTrailNote", { defaultValue: "Invite history below keeps the audit trail." })}
          </span>
        </div>

        {latestInviteUrl ? (
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">
                  {t("pages.companyInvites.latestInviteLink", { defaultValue: "Latest invite link" })}
                </div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    {t("pages.companyInvites.copied", { defaultValue: "Copied" })}
                  </div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">
                {t("pages.companyInvites.inviteUrlDomainNote", {
                  defaultValue: "This URL includes the current Paperclip domain returned by the server.",
                })}
              </div>
            </div>
            <label className="block space-y-1">
              <span className="sr-only">
                {t("pages.companyInvites.latestInviteUrlLabel", { defaultValue: "Latest invite URL" })}
              </span>
              <input
                ref={latestInviteInputRef}
                readOnly
                value={latestInviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground focus:border-ring"
                aria-label={t("pages.companyInvites.latestInviteUrlLabel", { defaultValue: "Latest invite URL" })}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={async () => {
                  const copied = await copyInviteUrl(latestInviteUrl);
                  setLatestInviteCopied(copied);
                }}
              >
                <Copy className="h-4 w-4" />
                {t("pages.companyInvites.copyLink", { defaultValue: "Copy link" })}
              </Button>
              <Button size="sm" variant="outline" asChild>
                <a href={latestInviteUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("pages.companyInvites.openInvite", { defaultValue: "Open invite" })}
                </a>
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">
              {t("pages.companyInvites.inviteHistoryTitle", { defaultValue: "Invite history" })}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("pages.companyInvites.inviteHistoryDescription", {
                defaultValue: "Review invite status, audience, inviter, and any linked join request.",
              })}
            </p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">
            {t("pages.companyInvites.openJoinRequestQueue", { defaultValue: "Open join request queue" })}
          </Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">
            {t("pages.companyInvites.emptyHistory", {
              defaultValue: "No invites have been created for this company yet.",
            })}
          </div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">
                      {t("pages.companyInvites.columnState", { defaultValue: "State" })}
                    </th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">
                      {t("pages.companyInvites.columnFor", { defaultValue: "For" })}
                    </th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">
                      {t("pages.companyInvites.columnInvitedBy", { defaultValue: "Invited by" })}
                    </th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">
                      {t("pages.companyInvites.columnCreated", { defaultValue: "Created" })}
                    </th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">
                      {t("pages.companyInvites.columnJoinRequest", { defaultValue: "Join request" })}
                    </th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">
                      {t("pages.companyInvites.columnAction", { defaultValue: "Action" })}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {inviteHistory.map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {formatInviteState(invite.state)}
                        </span>
                      </td>
                      <td className="px-5 py-3 align-top">{formatInviteAudience(invite)}</td>
                      <td className="px-5 py-3 align-top">
                        <div>
                          {invite.invitedByUser?.name ||
                            invite.invitedByUser?.email ||
                            t("pages.companyInvites.unknownInviter", { defaultValue: "Unknown inviter" })}
                        </div>
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
                            {t("pages.companyInvites.reviewRequest", { defaultValue: "Review request" })}
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
                            {t("pages.companyInvites.revoke", { defaultValue: "Revoke" })}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t("pages.companyInvites.inactive", { defaultValue: "Inactive" })}
                          </span>
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
                    ? t("pages.companyInvites.loadingMore", { defaultValue: "Loading more…" })
                    : t("pages.companyInvites.viewMore", { defaultValue: "View more" })}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function formatInviteState(state: "active" | "accepted" | "expired" | "revoked") {
  switch (state) {
    case "active":
      return t("pages.companyInvites.stateActive", { defaultValue: "Active" });
    case "accepted":
      return t("pages.companyInvites.stateAccepted", { defaultValue: "Accepted" });
    case "expired":
      return t("pages.companyInvites.stateExpired", { defaultValue: "Expired" });
    case "revoked":
      return t("pages.companyInvites.stateRevoked", { defaultValue: "Revoked" });
    default:
      return state;
  }
}

function formatInviteAudience(invite: Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number]) {
  if (invite.allowedJoinTypes === "agent") return t("pages.companyInvites.audienceAgent", { defaultValue: "Agent" });
  if (invite.allowedJoinTypes === "both")
    return invite.humanRole
      ? t("pages.companyInvites.audienceHumanOrAgentWithRole", {
          role: invite.humanRole,
          defaultValue: "Human or agent · {{role}}",
        })
      : t("pages.companyInvites.audienceHumanOrAgent", { defaultValue: "Human or agent" });
  return invite.humanRole ?? t("pages.companyInvites.audienceHuman", { defaultValue: "Human" });
}
