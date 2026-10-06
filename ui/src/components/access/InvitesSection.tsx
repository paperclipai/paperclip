import { i18n, t, useTranslation } from "@/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Badge } from "@/components/ui/badge";

const inviteRoleOptions = [
  {
    value: "viewer",
    get label() { return t("localizationAccessBootstrap.viewer"); },
    get description() { return t("localizationAccessBootstrap.viewerDescription"); },
    get gets() { return t("localizationAccessBootstrap.viewerGets"); },
  },
  {
    value: "operator",
    get label() { return t("localizationAccessBootstrap.operator"); },
    get description() { return t("localizationAccessBootstrap.operatorDescription"); },
    get gets() { return t("localizationAccessBootstrap.operatorGets"); },
  },
  {
    value: "admin",
    get label() { return t("localizationAccessBootstrap.admin"); },
    get description() { return t("localizationAccessBootstrap.adminDescription"); },
    get gets() { return t("localizationAccessBootstrap.adminGets"); },
  },
  {
    value: "owner",
    get label() { return t("localizationAccessBootstrap.owner"); },
    get description() { return t("localizationAccessBootstrap.ownerDescription"); },
    get gets() { return t("localizationAccessBootstrap.ownerGets"); },
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
      title: t("localizationAccessBootstrap.clipboardUnavailable"),
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  async function copyInviteUrl(url: string) {
    return copyText(url, t("localizationAccessBootstrap.copySelectedUrl"), selectLatestInviteUrl);
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
      const copied = await copyText(invite.inviteUrl, t("localizationAccessBootstrap.copyUrlBelow"));

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: t("localizationAccessBootstrap.inviteCreated"),
        body: copied ? t("localizationAccessBootstrap.inviteCopied") : t("localizationAccessBootstrap.inviteReady"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("localizationAccessBootstrap.createFailed"),
        body: error instanceof Error ? error.message : t("localizationAccessBootstrap.unknownError"),
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({ title: t("localizationAccessBootstrap.inviteRevoked"), tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: t("localizationAccessBootstrap.revokeFailed"),
        body: error instanceof Error ? error.message : t("localizationAccessBootstrap.unknownError"),
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("localizationAccessBootstrap.selectOrganization")}</div>;
  }

  if (invitesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("localizationAccessBootstrap.loadingInvites")}</div>;
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? t("localizationAccessBootstrap.permissionDenied")
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : t("localizationAccessBootstrap.loadFailed");
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-6xl space-y-8">
      <p className="max-w-3xl text-sm text-muted-foreground">{t("localizationAccessBootstrap.inviteIntro")}</p>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t("localizationAccessBootstrap.invitePerson")}</h2>
          <p className="text-sm text-muted-foreground">{t("localizationAccessBootstrap.invitePersonDescription")}</p>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("localizationAccessBootstrap.chooseRole")}</legend>
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
                        <Badge variant="outline" className="border-border text-muted-foreground">{t("localizationAccessBootstrap.default")}</Badge>
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

        <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">{t("localizationAccessBootstrap.singleUse")}</div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending ? t("localizationAccessBootstrap.creating") : t("localizationAccessBootstrap.createInvite")}
          </Button>
          <span className="text-sm text-muted-foreground">{t("localizationAccessBootstrap.historyTrail")}</span>
        </div>

        {latestInviteUrl ? (
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{t("localizationAccessBootstrap.latestLink")}</div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />{t("localizationAccessBootstrap.copied")}</div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">{t("localizationAccessBootstrap.urlDomain")}</div>
            </div>
            <label className="block space-y-1">
              <span className="sr-only">{t("localizationAccessBootstrap.latestUrl")}</span>
              <input
                ref={latestInviteInputRef}
                readOnly
                value={latestInviteUrl}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.currentTarget.select()}
                className="w-full rounded-md border border-border bg-muted/60 px-3 py-2 text-sm text-foreground outline-none transition-colors selection:bg-primary selection:text-primary-foreground focus:border-ring"
                aria-label={t("localizationAccessBootstrap.latestUrl")}
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
                <Copy className="h-4 w-4" />{t("localizationAccessBootstrap.copyLink")}</Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("localizationAccessBootstrap.history")}</h2>
            <p className="text-sm text-muted-foreground">{t("localizationAccessBootstrap.historyDescription")}</p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">{t("localizationAccessBootstrap.joinQueue")}</Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">{t("localizationAccessBootstrap.noInvites")}</div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("localizationAccessBootstrap.state")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("localizationAccessBootstrap.for")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("localizationAccessBootstrap.invitedBy")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("localizationAccessBootstrap.created")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("localizationAccessBootstrap.joinRequest")}</th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">{t("localizationAccessBootstrap.action")}</th>
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
                        <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || t("localizationAccessBootstrap.unknownInviter")}</div>
                        {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                          <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 align-top text-muted-foreground">
                        {new Date(invite.createdAt).toLocaleString(i18n.resolvedLanguage)}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {invite.relatedJoinRequestId ? (
                          <Link to="/inbox/requests" className="underline underline-offset-4">{t("localizationAccessBootstrap.reviewRequest")}</Link>
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
                          >{t("localizationAccessBootstrap.revoke")}</Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("localizationAccessBootstrap.inactive")}</span>
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
                  {invitesQuery.isFetchingNextPage ? t("localizationAccessBootstrap.loadingMore") : t("localizationAccessBootstrap.viewMore")}
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
  return t(`localizationAccessBootstrap.${state}`, { defaultValue: state });
}

function formatInviteAudience(invite: Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number]) {
  const role = invite.humanRole
    ? t(`localizationAccessBootstrap.audience_${invite.humanRole}`, { defaultValue: invite.humanRole })
    : null;
  if (invite.allowedJoinTypes === "agent") return t("localizationAccessBootstrap.agent");
  if (invite.allowedJoinTypes === "both") return role
    ? t("localizationAccessBootstrap.humanOrAgentRole", { role })
    : t("localizationAccessBootstrap.humanOrAgent");
  return role ?? t("localizationAccessBootstrap.human");
}
