import { useTranslation, t, i18n } from "@/i18n";
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

const inviteRoleOptions = [
  {
    value: "viewer",
    get label() { return t("agent-config:viewer_dbad9f1"); },
    get description() { return t("agent-config:canViewOrganizationWorkAndFollowAlong_c350196"); },
    get gets() { return t("agent-config:viewOnlyOrganizationMembership_9c84d8c"); },
  },
  {
    value: "operator",
    get label() { return t("agent-config:operator_d0e687b"); },
    get description() { return t("agent-config:canEditOrganizationWorkAndInvitePeople_be66e7a"); },
    get gets() { return t("agent-config:fullEditingAndAuditAccessCannotApproveJoin_2bc4cf7"); },
  },
  {
    value: "admin",
    get label() { return t("agent-config:admin_4e7afeb"); },
    get description() { return t("agent-config:recommendedForOperatorsWhoNeedToInvitePeople_3542cc4"); },
    get gets() { return t("agent-config:canCreateAgentsInviteUsersAssignTasksAnd_4d2bcd6"); },
  },
  {
    value: "owner",
    get label() { return t("agent-config:owner_89ff312"); },
    get description() { return t("agent-config:fullOrganizationAccessIncludingMembershipManagement_0eb4a07"); },
    get gets() { return t("agent-config:everythingInAdminPlusManagingMembers_befed5f"); },
  },
] as const;

const INVITE_HISTORY_PAGE_SIZE = 5;

function isInviteHistoryRow(value: unknown): value is Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number] {
  if (!value || typeof value !== "object") return false;
  return "id" in value && "state" in value && "createdAt" in value;
}

/** The Invites tab of the Members page (extracted from the former standalone Invites page). */
export function InvitesSection() {
  const { t } = useTranslation("agent-config");
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
      title: t("agent-config:clipboardUnavailable_bec46a2"),
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  async function copyInviteUrl(url: string) {
    return copyText(url, t("agent-config:theInviteUrlIsSelectedCopyItManually_6ab59fd"), selectLatestInviteUrl);
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
    [invitesQuery.data?.pages, i18n.resolvedLanguage],
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
      const copied = await copyText(invite.inviteUrl, t("agent-config:copyTheInviteUrlManuallyFromTheField_fc75224"));

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: t("agent-config:inviteCreated_043e58c"),
        body: copied ? t("agent-config:inviteReadyBelowAndCopiedToClipboard_5733cb2") : t("agent-config:inviteReadyBelow_a9e6eb8"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("agent-config:failedToCreateInvite_f934ca2"),
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({ title: t("agent-config:inviteRevoked_4e6cdd5"), tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: t("agent-config:failedToRevokeInvite_23b030e"),
        body: describeError(error).body,
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("agent-config:selectAnOrganizationToManageInvites_b2e7b00")}</div>;
  }

  if (invitesQuery.isLoading || invitesView.kind === "reconnecting") {
    return <div className="text-sm text-muted-foreground">{t("agent-config:loadingInvites_ef01aba")}</div>;
  }

  if (invitesView.kind === "error") {
    if (invitesView.errorKind === "forbidden") {
      return <div className="text-sm text-destructive">{t("agent-config:youDoNotHavePermissionToManageOrganization_ca4d8de")}</div>;
    }
    return (
      <QueryErrorState
        size="page"
        error={invitesQuery.error}
        action={t("agent-config:loadInvites_f41e020")}
        onRetry={invitesView.retry}
        retrying={invitesView.isFetching}
      />
    );
  }

  return (
    <div className="max-w-6xl space-y-8">
      <p className="max-w-3xl text-sm text-muted-foreground">{t("agent-config:invitePeopleToRequestAccessToThisOrganization_b0ebe2a")}</p>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t("agent-config:inviteAPerson_62d12c3")}</h2>
          <p className="text-sm text-muted-foreground">{t("agent-config:generateAHumanInviteLinkAndChooseThe_9b3ad49")}</p>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("agent-config:chooseARole_215ccf6")}</legend>
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
                        <Badge variant="outline" className="border-border text-muted-foreground">{t("agent-config:default_808d7dc")}</Badge>
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

        <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">{t("agent-config:eachInviteLinkIsSingleUseHumanInvitees_ab5c705")}</div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending ? t("agent-config:creating_94d7d8e") : t("agent-config:createInvite_a840462")}
          </Button>
          <span className="text-sm text-muted-foreground">{t("agent-config:inviteHistoryBelowKeepsTheAuditTrail_aaf0a30")}</span>
        </div>

        {latestInviteUrl ? (
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{t("agent-config:latestInviteLink_ee61f28")}</div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />{t("agent-config:copied_8e3df45")}</div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">{t("agent-config:thisUrlIncludesTheCurrentPaperclipDomainReturned_1639d61")}</div>
            </div>
            <label className="block space-y-1">
              <span className="sr-only">{t("agent-config:latestInviteUrl_fca7998")}</span>
              <input
                ref={latestInviteInputRef}
                readOnly
                value={latestInviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground focus:border-ring"
                aria-label={t("agent-config:latestInviteUrl_fca7998")}
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
                <Copy className="h-4 w-4" />{t("agent-config:copyLink_2f84eea")}</Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("agent-config:inviteHistory_cbc505f")}</h2>
            <p className="text-sm text-muted-foreground">{t("agent-config:reviewInviteStatusAudienceInviterAndAnyLinked_e0c2fd3")}</p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">{t("agent-config:openJoinRequestQueue_33d927b")}</Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">{t("agent-config:noInvitesHaveBeenCreatedForThisOrganization_5f60f36")}</div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("agent-config:state_a725020")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("agent-config:for_f788060")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("agent-config:invitedBy_2902cf3")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("agent-config:created_accf40c")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("agent-config:joinRequest_83934b9")}</th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">{t("agent-config:action_97c89a4")}</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteHistory.map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <Badge variant="outline" className="border-border text-muted-foreground">
                          {formatInviteState(invite.state)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3 align-top">{formatInviteAudience(invite)}</td>
                      <td className="px-5 py-3 align-top">
                        <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || t("agent-config:unknownInviter_d7fa446")}</div>
                        {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                          <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 align-top text-muted-foreground">
                        {new Date(invite.createdAt).toLocaleString()}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {invite.relatedJoinRequestId ? (
                          <Link to="/inbox/requests" className="underline underline-offset-4">{t("agent-config:reviewRequest_525f174")}</Link>
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
                          >{t("agent-config:revoke_0be7207")}</Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("agent-config:inactive_09af574")}</span>
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
                  {invitesQuery.isFetchingNextPage ? t("agent-config:loadingMore_713bdc0") : t("agent-config:viewMore_e3c5fa8")}
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
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function formatInviteAudience(invite: Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number]) {
  if (invite.allowedJoinTypes === "agent") return t("agent-config:agent_5ce2e6f");
  if (invite.allowedJoinTypes === "both") return invite.humanRole ? t("agent-config:humanOrAgentValue_95b3abf", { value1: invite.humanRole }) : t("agent-config:humanOrAgent_cb6bad4");
  return invite.humanRole ?? t("agent-config:human_e31663b");
}
