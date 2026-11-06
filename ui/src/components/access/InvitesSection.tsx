import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { accessApi } from "@/api/access";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";
import { describeError } from "@/api/errors";
import { useTranslation } from "@/i18n";

const inviteRoleOptions = [
  {
    value: "viewer",
    label: "Viewer",
    description: "Can view organization work and follow along.",
    gets: "View-only organization membership.",
  },
  {
    value: "operator",
    label: "Operator",
    description: "Can edit organization work and invite people.",
    gets: "Full editing and audit access. Cannot approve join requests or manage member permissions.",
  },
  {
    value: "admin",
    label: "Admin",
    description: "Recommended for operators who need to invite people, create agents, and approve joins.",
    gets: "Can create agents, invite users, assign tasks, and approve join requests.",
  },
  {
    value: "owner",
    label: "Owner",
    description: "Full organization access, including membership management.",
    gets: "Everything in Admin, plus managing members.",
  },
] as const;

const INVITE_HISTORY_PAGE_SIZE = 5;

function isInviteHistoryRow(value: unknown): value is Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number] {
  if (!value || typeof value !== "object") return false;
  return "id" in value && "state" in value && "createdAt" in value;
}

/** The Invites tab of the Members page (extracted from the former standalone Invites page). */
export function InvitesSection() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
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
      await copyTextToClipboard(text);
      return true;
    } catch {
      afterFallback?.();
    }
    pushToast({
      title: t("settings.invites.clipboardUnavailable", { defaultValue: "Clipboard unavailable" }),
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  async function copyInviteUrl(url: string) {
    return copyText(url, t("settings.invites.clipboardManualCopy", { defaultValue: "The invite URL is selected. Copy it manually from the field." }), selectLatestInviteUrl);
  }

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
  const invitesView = useQueryView(invitesQuery);
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
      const copied = await copyText(invite.inviteUrl, t("settings.invites.clipboardManualCopy", { defaultValue: "The invite URL is selected. Copy it manually from the field." }));

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: t("settings.invites.inviteCreatedToast", { defaultValue: "Invite created" }),
        body: copied ? t("settings.invites.inviteReadyAndCopied", { defaultValue: "Invite ready below and copied to clipboard." }) : t("settings.invites.inviteReady", { defaultValue: "Invite ready below." }),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("settings.invites.failedCreateInvite", { defaultValue: "Failed to create invite" }),
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({ title: t("settings.invites.toastInviteRevoked", { defaultValue: "Invite revoked" }), tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: t("settings.invites.toastFailedRevokeInvite", { defaultValue: "Failed to revoke invite" }),
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("settings.invites.selectOrgPrompt", { defaultValue: "Select an organization to manage invites." })}</div>;
  }

  if (invitesQuery.isLoading || invitesView.kind === "reconnecting") {
    return <div className="text-sm text-muted-foreground">{t("settings.invites.loadingHistory", { defaultValue: "Loading invite history…" })}</div>;
  }

  if (invitesView.kind === "error") {
    if (invitesView.errorKind === "forbidden") {
      return <div className="text-sm text-destructive">{t("settings.invites.forbidden", { defaultValue: "You do not have permission to manage organization invites." })}</div>;
    }
    return (
      <QueryErrorState
        size="page"
        error={invitesQuery.error}
        action={t("settings.invites.loadInvitesAction", { defaultValue: "load invites" })}
        onRetry={invitesView.retry}
        retrying={invitesView.isFetching}
      />
    );
  }

  return (
    <div className="max-w-6xl space-y-8">
      <p className="max-w-3xl text-sm text-muted-foreground">
        {t("settings.invites.description", { defaultValue: "Generate join links to invite people into this organization." })}
      </p>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t("settings.invites.inviteAPerson", { defaultValue: "Invite a person" })}</h2>
          <p className="text-sm text-muted-foreground">
            {t("settings.invites.inviteAPersonDescription", { defaultValue: "Generate a human invite link and choose the default access it should request." })}
          </p>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("settings.invites.chooseARole", { defaultValue: "Choose a role" })}</legend>
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
                      <span className="text-sm font-medium">{t(`settings.invites.roles.${option.value}.label`, { defaultValue: option.label })}</span>
                      {option.value === "operator" ? (
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {t("settings.invites.defaultRoleBadge", { defaultValue: "Default" })}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="block max-w-2xl text-sm text-muted-foreground">{t(`settings.invites.roles.${option.value}.description`, { defaultValue: option.description })}</span>
                    <span className="block text-sm text-foreground">{t(`settings.invites.roles.${option.value}.gets`, { defaultValue: option.gets })}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          {t("settings.invites.singleUseNotice", { defaultValue: "Each invite link is single-use. Human invitees get the selected role immediately after sign-in; agent invites still create a join request for approval." })}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending ? t("settings.invites.creating", { defaultValue: "Creating…" }) : t("settings.invites.createInvite", { defaultValue: "Create invite" })}
          </Button>
          <span className="text-sm text-muted-foreground">{t("settings.invites.auditTrailHint", { defaultValue: "Invite history below keeps the audit trail." })}</span>
        </div>

        {latestInviteUrl ? (
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{t("settings.invites.latestInviteLink", { defaultValue: "Latest invite link" })}</div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    {t("settings.invites.copiedShort", { defaultValue: "Copied" })}
                  </div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">
                {t("settings.invites.domainNotice", { defaultValue: "This URL includes the current Paperclip domain returned by the server." })}
              </div>
            </div>
            <label className="block space-y-1">
              <span className="sr-only">{t("settings.invites.latestInviteUrl", { defaultValue: "Latest invite URL" })}</span>
              <input
                ref={latestInviteInputRef}
                readOnly
                value={latestInviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground focus:border-ring"
                aria-label={t("settings.invites.latestInviteUrl", { defaultValue: "Latest invite URL" })}
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
                {t("settings.invites.copyLink", { defaultValue: "Copy link" })}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("settings.invites.historyTitle", { defaultValue: "Invite history" })}</h2>
            <p className="text-sm text-muted-foreground">
              {t("settings.invites.historyDescription", { defaultValue: "Review invite status, audience, inviter, and any linked join request." })}
            </p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">
            {t("settings.invites.openJoinRequestQueue", { defaultValue: "Open join request queue" })}
          </Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">
            {t("settings.invites.noHistory", { defaultValue: "No invites created yet." })}
          </div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("settings.invites.thState", { defaultValue: "State" })}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("settings.invites.thFor", { defaultValue: "For" })}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("settings.invites.thInvitedBy", { defaultValue: "Invited by" })}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("settings.invites.thCreated", { defaultValue: "Created" })}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("settings.invites.thJoinRequest", { defaultValue: "Join request" })}</th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">{t("settings.invites.thAction", { defaultValue: "Action" })}</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteHistory.map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {formatInviteState(invite.state, t)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 align-top">{formatInviteAudience(invite, t)}</td>
                      <td className="px-5 py-3 align-top">
                        <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || t("settings.invites.unknownInviter", { defaultValue: "Unknown inviter" })}</div>
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
                            {t("settings.invites.reviewRequest", { defaultValue: "Review request" })}
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
                            {t("settings.invites.revoke", { defaultValue: "Revoke" })}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("settings.invites.inactive", { defaultValue: "Inactive" })}</span>
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
                  {invitesQuery.isFetchingNextPage ? t("settings.invites.loadingMore", { defaultValue: "Loading more…" }) : t("settings.invites.viewMore", { defaultValue: "View more" })}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function formatInviteState(state: "active" | "accepted" | "expired" | "revoked", t: (key: string, options?: Record<string, unknown>) => string) {
  if (state === "active") return t("settings.invites.stateActive", { defaultValue: "Active" });
  if (state === "revoked") return t("settings.invites.stateRevoked", { defaultValue: "Revoked" });
  if (state === "expired") return t("settings.invites.stateExpired", { defaultValue: "Expired" });
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function formatInviteAudience(
  invite: Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number],
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (invite.allowedJoinTypes === "agent") return t("settings.invites.audienceAgent", { defaultValue: "Agent" });
  if (invite.allowedJoinTypes === "both") {
    return invite.humanRole
      ? t("settings.invites.audienceHumanOrAgentRole", { role: invite.humanRole })
      : t("settings.invites.audienceHumanOrAgent", { defaultValue: "Human or agent" });
  }
  return invite.humanRole ?? t("settings.invites.audienceHuman", { defaultValue: "Human" });
}
