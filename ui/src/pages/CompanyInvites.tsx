import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, MailPlus } from "lucide-react";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useI18n } from "@/context/LocaleContext";
import { useToast } from "@/context/ToastContext";
import { type AppLocale, formatDateTimeForLocale } from "@/lib/i18n";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

const INVITE_HISTORY_PAGE_SIZE = 5;
type InviteRole = "owner" | "admin" | "operator" | "viewer";
type InviteRoleOption = {
  value: InviteRole;
  label: string;
  description: string;
  gets: string;
};

function isInviteHistoryRow(value: unknown): value is Awaited<ReturnType<typeof accessApi.listInvites>>["invites"][number] {
  if (!value || typeof value !== "object") return false;
  return "id" in value && "state" in value && "createdAt" in value;
}

export function CompanyInvites() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { locale, t } = useI18n();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [humanRole, setHumanRole] = useState<InviteRole>("operator");
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);
  const [latestInviteCopied, setLatestInviteCopied] = useState(false);
  const inviteRoleOptions = useMemo(() => getInviteRoleOptions(locale), [locale]);

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
      title: t("companyInvites.clipboardUnavailable"),
      body: t("companyInvites.clipboardUnavailableDesc"),
      tone: "warn",
    });
    return false;
  }

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("companyMenu.company"), href: "/dashboard" },
      { label: t("companySettings.title"), href: "/company/settings" },
      { label: t("companyInvites.breadcrumb") },
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
      const copied = await copyInviteUrl(invite.inviteUrl);
      setLatestInviteCopied(copied);

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: t("companyInvites.inviteCreated"),
        body: copied ? t("companyInvites.inviteCreatedCopied") : t("companyInvites.inviteCreatedReady"),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: t("companyInvites.inviteCreateFailed"),
        body: error instanceof Error ? error.message : t("common.unknown"),
        tone: "error",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) => accessApi.revokeInvite(inviteId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({ title: t("companyInvites.inviteRevoked"), tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: t("companyInvites.inviteRevokeFailed"),
        body: error instanceof Error ? error.message : t("common.unknown"),
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">{t("companyInvites.noCompany")}</div>;
  }

  if (invitesQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("companyInvites.loading")}</div>;
  }

  if (invitesQuery.error) {
    const message =
      invitesQuery.error instanceof ApiError && invitesQuery.error.status === 403
        ? t("companyInvites.noPermission")
        : invitesQuery.error instanceof Error
          ? invitesQuery.error.message
          : t("companyInvites.loadFailed");
    return <div className="text-sm text-destructive">{message}</div>;
  }

  return (
    <div className="max-w-5xl space-y-8">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MailPlus className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("companyInvites.title")}</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t("companyInvites.description")}
        </p>
      </div>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{t("companyInvites.createInviteTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("companyInvites.createInviteDesc")}
          </p>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("companyInvites.chooseRole")}</legend>
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
                          {t("common.default")}
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
          {t("companyInvites.singleUseHint")}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => createInviteMutation.mutate()} disabled={createInviteMutation.isPending}>
            {createInviteMutation.isPending ? t("common.saving") : t("companyInvites.createInviteTitle")}
          </Button>
          <span className="text-sm text-muted-foreground">{t("companyInvites.auditTrailHint")}</span>
        </div>

        {latestInviteUrl ? (
          <div className="space-y-3 rounded-lg border border-border px-4 py-4">
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{t("companyInvites.latestInviteLink")}</div>
                {latestInviteCopied ? (
                  <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                    <Check className="h-3.5 w-3.5" />
                    {t("companySettings.copied")}
                  </div>
                ) : null}
              </div>
              <div className="text-sm text-muted-foreground">
                {t("companyInvites.latestInviteLinkDesc")}
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
                  {t("companyInvites.openInvite")}
                </a>
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-border">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("companyInvites.historyTitle")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("companyInvites.historyDesc")}
            </p>
          </div>
          <Link to="/inbox/requests" className="text-sm underline underline-offset-4">
            {t("companyInvites.openJoinQueue")}
          </Link>
        </div>

        {inviteHistory.length === 0 ? (
          <div className="border-t border-border px-5 py-8 text-sm text-muted-foreground">
            {t("companyInvites.empty")}
          </div>
        ) : (
          <div className="border-t border-border">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.tableState")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.tableRole")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.tableInvitedBy")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.tableCreated")}</th>
                    <th className="px-5 py-3 font-medium text-muted-foreground">{t("companyInvites.tableJoinRequest")}</th>
                    <th className="px-5 py-3 text-right font-medium text-muted-foreground">{t("companyInvites.tableAction")}</th>
                  </tr>
                </thead>
                <tbody>
                  {inviteHistory.map((invite) => (
                    <tr key={invite.id} className="border-b border-border last:border-b-0">
                      <td className="px-5 py-3 align-top">
                        <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {formatInviteState(invite.state, locale)}
                        </span>
                      </td>
                      <td className="px-5 py-3 align-top">{invite.humanRole ? getInviteRoleShortLabel(invite.humanRole, locale) : "—"}</td>
                      <td className="px-5 py-3 align-top">
                        <div>{invite.invitedByUser?.name || invite.invitedByUser?.email || t("companyInvites.unknownInviter")}</div>
                        {invite.invitedByUser?.email && invite.invitedByUser.name ? (
                          <div className="text-xs text-muted-foreground">{invite.invitedByUser.email}</div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 align-top text-muted-foreground">
                        {formatDateTimeForLocale(invite.createdAt, locale)}
                      </td>
                      <td className="px-5 py-3 align-top">
                        {invite.relatedJoinRequestId ? (
                          <Link to="/inbox/requests" className="underline underline-offset-4">
                            {t("companyInvites.reviewRequest")}
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
                            {t("common.remove")}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">{t("common.inactive")}</span>
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
                  {invitesQuery.isFetchingNextPage ? t("companyInvites.loadingMore") : t("companyInvites.loadMore")}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

function getInviteRoleOptions(locale: AppLocale): InviteRoleOption[] {
  return locale === "zh-CN"
    ? [
        {
          value: "viewer",
          label: "查看者",
          description: "可以查看公司工作内容并跟进进展，但没有操作权限。",
          gets: "不自带任何权限。",
        },
        {
          value: "operator",
          label: "执行者",
          description: "推荐给需要协助推进工作、但不需要管理访问权限的成员。",
          gets: "可以分配任务。",
        },
        {
          value: "admin",
          label: "管理员",
          description: "推荐给需要邀请成员、创建 Agent 并审批加入请求的执行者。",
          gets: "可以创建 Agent、邀请用户、分配任务并审批加入请求。",
        },
        {
          value: "owner",
          label: "所有者",
          description: "拥有完整公司访问权限，包括成员和权限管理。",
          gets: "包含管理员全部能力，并可管理成员与权限授予。",
        },
      ]
    : [
        {
          value: "viewer",
          label: "Viewer",
          description: "Can view company work and follow along without operational permissions.",
          gets: "No built-in grants.",
        },
        {
          value: "operator",
          label: "Operator",
          description: "Recommended for people who need to help run work without managing access.",
          gets: "Can assign tasks.",
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
          description: "Full company access, including membership and permission management.",
          gets: "Everything in Admin, plus managing members and permission grants.",
        },
      ] as const;
}

function getInviteRoleShortLabel(role: InviteRole, locale: AppLocale) {
  const labels =
    locale === "zh-CN"
      ? { owner: "所有者", admin: "管理员", operator: "执行者", viewer: "查看者" }
      : { owner: "Owner", admin: "Admin", operator: "Operator", viewer: "Viewer" };
  return labels[role];
}

function formatInviteState(state: "active" | "accepted" | "expired" | "revoked", locale: AppLocale) {
  const labels =
    locale === "zh-CN"
      ? { active: "生效中", accepted: "已接受", expired: "已过期", revoked: "已撤销" }
      : { active: "Active", accepted: "Accepted", expired: "Expired", revoked: "Revoked" };
  return labels[state];
}
