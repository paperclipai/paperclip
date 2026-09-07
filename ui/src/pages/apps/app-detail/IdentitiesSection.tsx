import { useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Building2, Loader2, Lock, RefreshCw, Search, TriangleAlert, UserRound } from "lucide-react";
import type {
  ConnectionAudienceMember,
  ConnectionGrant,
  ConnectionGrantsResponse,
  ToolConnectionCredentialPolicy,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Identity } from "@/components/Identity";
import { GithubIcon } from "@/components/icons/github-icon";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineBanner } from "@/components/InlineBanner";
import { MemberMultiSelect } from "@/components/MemberMultiSelect";
import { RadioCardGroup } from "@/components/ui/radio-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Link } from "@/lib/router";
import { brandBanner, brandChipBadge } from "@/lib/status-colors";
import { agentUrl, cn } from "@/lib/utils";
import {
  audienceUserIds,
  grantAccountLabel,
  grantStatusLabel,
  grantStatusTone,
  memberLabel,
  organizationGrant,
  personalGrantFor,
  type GrantStatusTone,
} from "../connection-identity";

const STATUS_CHIP: Record<GrantStatusTone, string> = {
  connected: brandChipBadge.green,
  attention: brandChipBadge.amber,
  inactive: brandChipBadge.gray,
  missing: brandChipBadge.gray,
};

function StatusText({ status }: { status: ConnectionGrant["status"] | null }) {
  useTranslation();
  const tone = grantStatusTone(status);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        STATUS_CHIP[tone],
      )}
    >
      {grantStatusLabel(status)}
    </span>
  );
}

/**
 * Fixed identity for the connection Setup tab.
 *
 * The chosen personal/organization type comes from the connection policy and
 * the alternative is not rendered after setup. Every action is rendered from
 * a server capability — a policy-forbidden action is absent rather than
 * disabled, so a viewer sees the same legible state with no controls at all.
 */
export function IdentitiesSection({
  appName,
  credentialPolicy,
  ownerUserId,
  connectedUser,
  dedicatedAgent,
  grantsQuery,
  loading,
  error,
  onConnectAsMe,
  onConnectOrganization,
  onConnectAgent,
  onRefreshAccess,
  refreshAccessPending = false,
  onReplaceAudience,
  connectPending,
  audiencePending,
  audienceError,
  audienceGrantId,
  onOpenAudience,
  onCloseAudience,
}: {
  appName: string;
  credentialPolicy: ToolConnectionCredentialPolicy;
  ownerUserId: string | null;
  connectedUser: { label: string; image: string | null } | null;
  dedicatedAgent: { id: string; name: string; urlKey?: string | null } | null;
  grantsQuery: ConnectionGrantsResponse | undefined;
  loading: boolean;
  error: boolean;
  onConnectAsMe: () => void;
  onConnectOrganization: () => void;
  onConnectAgent: (agentId: string) => void;
  onRefreshAccess?: () => void;
  refreshAccessPending?: boolean;
  onReplaceAudience: (grant: ConnectionGrant, memberUserIds: string[]) => void;
  connectPending: boolean;
  audiencePending: boolean;
  audienceError: string | null;
  /**
   * The audience dialog is controlled by the page, not this section: a save that
   * the server rejects has to keep the dialog open with the selection intact,
   * which only the mutation's outcome knows.
   */
  audienceGrantId: string | null;
  onOpenAudience: (grantId: string) => void;
  onCloseAudience: () => void;
}) {
  const { t } = useTranslation();
  const grants = grantsQuery?.grants ?? [];
  const capabilities = grantsQuery?.capabilities;
  const currentUserId = grantsQuery?.currentUserId ?? null;
  const members = grantsQuery?.members ?? [];
  const orgGrant = useMemo(() => organizationGrant(grants), [grants]);
  const myGrant = useMemo(() => personalGrantFor(grants, currentUserId), [grants, currentUserId]);
  const personalGrant = useMemo(() => {
    const personalGrants = grants.filter((grant) => grant.kind === "user");
    return personalGrants.find((grant) => grant.subjectUserId === ownerUserId)
      ?? myGrant
      ?? personalGrants.find((grant) => grant.status === "active")
      ?? personalGrants[0]
      ?? null;
  }, [grants, myGrant, ownerUserId]);
  const agentGrant = useMemo(
    () => grants.find((grant) => grant.kind === "agent" && grant.subjectAgentId === dedicatedAgent?.id)
      ?? grants.find((grant) => grant.kind === "agent")
      ?? null,
    [dedicatedAgent?.id, grants],
  );
  const personalSubjectLabel = memberLabel(
    members,
    personalGrant?.subjectUserId ?? ownerUserId ?? currentUserId,
  );
  const usesPersonalIdentity = credentialPolicy === "per_user"
    || (credentialPolicy === "per_user_with_fallback" && Boolean(myGrant));
  const audienceGrant = audienceGrantId
    ? grants.find((grant) => grant.id === audienceGrantId) ?? null
    : null;

  if (loading) {
    return (
      <section className="space-y-5" aria-busy="true">
        <IdentitiesHeading />
        <Skeleton className="h-14 w-full" />
      </section>
    );
  }

  if (error) {
    return (
      <section className="space-y-5">
        <IdentitiesHeading />
        <InlineBanner tone="warning" compact>{t("localizationApps.weCouldnTLoadWhoThisConnectionActsAsReloadThe369")}</InlineBanner>
      </section>
    );
  }

  if (credentialPolicy === "per_agent") {
    const github = agentGrant?.providerTenant?.github;
    return (
      <section className="space-y-5">
        <h2 className="text-sm font-semibold text-foreground">{t("localizationApps.gitHubIdentity370")}</h2>
        <IdentityRow
          title={github ? `@${github.login}` : t("localizationApps.dedicatedGitHubAccount371")}
          status={agentGrant?.status ?? null}
          detail={dedicatedAgent ? (
            <Link
              to={agentUrl(dedicatedAgent)}
              className="transition-colors hover:text-foreground hover:underline"
            >
              {t("localizationApps.usedOnlyBy", { agent: dedicatedAgent.name })}
            </Link>
          ) : t("localizationApps.dedicatedToOneAgent373")}
          actions={!agentGrant && dedicatedAgent && capabilities?.canConfigure ? (
            <Button size="sm" disabled={connectPending} onClick={() => onConnectAgent(dedicatedAgent.id)}>
              {connectPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{t("localizationApps.connectDedicatedAccount374")}</Button>
          ) : null}
        />
        {github ? <GitHubConnectionSummary grant={agentGrant} onRefreshAccess={onRefreshAccess} refreshPending={refreshAccessPending} /> : null}
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <IdentitiesHeading />

      <HumanAccessCards
        personal={usesPersonalIdentity}
        restricted={!usesPersonalIdentity && Boolean(orgGrant?.members?.length)}
        connectedName={usesPersonalIdentity ? personalSubjectLabel ?? connectedUser?.label ?? null : null}
        connectedImage={usesPersonalIdentity ? connectedUser?.image ?? null : null}
        status={(usesPersonalIdentity ? personalGrant : orgGrant)?.status ?? null}
        canEditAudience={orgGrant?.capabilities?.canEditAudience ?? false}
        onChooseAll={() => {
          if (orgGrant) onReplaceAudience(orgGrant, []);
        }}
        onChooseSelected={() => {
          if (orgGrant) onOpenAudience(orgGrant.id);
        }}
      />

      {(usesPersonalIdentity ? personalGrant : orgGrant)?.providerTenant?.github ? (
        <GitHubConnectionSummary
          grant={(usesPersonalIdentity ? personalGrant : orgGrant)!}
          onRefreshAccess={onRefreshAccess}
          refreshPending={refreshAccessPending}
        />
      ) : null}

      <div>
        {usesPersonalIdentity ? (
          personalGrant ? null : (
            <IdentityRow
              id="personal-identity"
              title={t("localizationApps.personalAccount375")}
              status={null}
              detail={t("localizationApps.personalIdentity376")}
              actions={capabilities?.canConnectAsCurrentUser ? (
                  <Button size="sm" disabled={connectPending} onClick={onConnectAsMe}>
                    {connectPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{t("localizationApps.connectAsMe377")}</Button>
                ) : null}
            />
          )
        ) : (
          orgGrant ? (
            orgGrant.capabilities?.canEditAudience ? (
              <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => onOpenAudience(orgGrant.id)}>{t("localizationApps.manageAccess378")}</Button>
              </div>
            ) : null
          ) : (
            <IdentityRow
              title={t("localizationApps.organizationAccount379")}
              status={null}
              detail={t("localizationConnections.organizationIdentity201")}
              actions={capabilities?.canCreateOrganizationGrant ? (
                  <Button size="sm" disabled={connectPending} onClick={onConnectOrganization}>{t("localizationApps.connectOrganizationIdentity381")}</Button>
                ) : null}
            />
          )
        )}
      </div>

      {audienceGrant ? (
        <AudienceDialog
          appName={appName}
          grant={audienceGrant}
          members={members}
          pending={audiencePending}
          error={audienceError}
          onCancel={onCloseAudience}
          onSave={(memberUserIds) => onReplaceAudience(audienceGrant, memberUserIds)}
        />
      ) : null}

    </section>
  );
}

function GitHubConnectionSummary({
  grant,
  onRefreshAccess,
  refreshPending,
}: {
  grant: ConnectionGrant;
  onRefreshAccess?: () => void;
  refreshPending: boolean;
}) {
  const { t } = useTranslation();
  const [repositoryOwner, setRepositoryOwner] = useState("*");
  const [repositorySearch, setRepositorySearch] = useState("");
  useEffect(() => {
    setRepositoryOwner("*");
    setRepositorySearch("");
  }, [grant.id]);
  const github = grant.providerTenant?.github;
  if (!github) return null;
  const owners = [...new Set([
    ...(github.installationOwnerLogins ?? []),
    ...(github.repositories ?? []).map((repository) => repository.fullName.split("/")[0]),
  ])].sort((a, b) => a.localeCompare(b));
  const selectedOwner = owners.includes(repositoryOwner) ? repositoryOwner : "*";
  const search = repositorySearch.trim().toLowerCase();
  const visibleRepositories = github.repositories?.filter((repository) => (
    (selectedOwner === "*" || repository.fullName.split("/")[0] === selectedOwner)
    && repository.fullName.toLowerCase().includes(search)
  ));
  const configurationUrl = github.appSlug
    ? `https://github.com/apps/${encodeURIComponent(github.appSlug)}/installations/new`
    : /^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/.test(github.installationUrl ?? "")
      ? github.installationUrl
      : null;
  const repositoryWarning = github.repositorySelection === "all"
    ? t("localizationApps.allCurrentAndFutureRepositories382")
    : github.repositorySelection === "mixed"
      ? t("localizationApps.mixedAccessScopeVariesByInstallation383")
      : null;
  const repositorySummary = github.repositorySelection === "none"
    ? t("localizationApps.noRepositoriesSelected384")
    : t("localizationApps.selectedRepositories", { count: github.repositoryCount });
  return (
    <div className="divide-y divide-border border-y border-border">
      <div className="py-3">
        <div className="text-sm font-medium text-foreground">{t("localizationApps.githubAccount")}</div>
        <a className="text-sm text-muted-foreground hover:underline" href={`https://github.com/${encodeURIComponent(github.login)}`} target="_blank" rel="noreferrer">
          @{github.login}
        </a>
      </div>
      <div className="space-y-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{t("localizationApps.repositories386")}</div>
            {repositoryWarning ? (
              <div
                role="note"
                className={cn(
                  "mt-1 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                  brandBanner.warning,
                )}
              >
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {repositoryWarning}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">{repositorySummary}</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onRefreshAccess && configurationUrl ? (
              <Button size="icon-sm" variant="outline" aria-label={t("localizationApps.refreshAccess387")} title={t("localizationApps.refreshAccess387")} disabled={refreshPending} onClick={onRefreshAccess}>
                {refreshPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              </Button>
            ) : null}
            {configurationUrl ? (
              <Button asChild size="sm" variant="outline">
                <a href={configurationUrl} target="_blank" rel="noreferrer">{t("localizationApps.configureOnGitHub")}</a>
              </Button>
            ) : onRefreshAccess ? (
              <Button size="sm" variant="outline" disabled={refreshPending} onClick={onRefreshAccess}>
                {refreshPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                {t("localizationApps.loadGitHubConfiguration")}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={selectedOwner} onValueChange={setRepositoryOwner}>
            <SelectTrigger aria-label={t("localizationApps.filterRepositoriesByOwner")} className="w-full">
              <span className="flex min-w-0 items-center gap-2">
                <GithubIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <SelectValue />
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="*">{t("localizationApps.allRepositoryAccounts")}</SelectItem>
              {owners.map((owner) => <SelectItem key={owner} value={owner}>{owner}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input aria-label={t("localizationApps.searchGitHubRepositories")} placeholder={t("localizationApps.searchRepositories")} className="pl-9" value={repositorySearch} onChange={(event) => setRepositorySearch(event.target.value)} />
          </div>
        </div>
        {github.repositories ? (
          visibleRepositories?.length ? <ul aria-label={t("localizationApps.accessibleGitHubRepositories")} tabIndex={0} className="max-h-(--sz-github-repository-list) space-y-2 overflow-y-auto text-sm">
            {visibleRepositories.map((repository) => (
              <li key={repository.id}>
                <a className="flex items-center gap-2 text-muted-foreground hover:underline" href={`https://github.com/${repository.fullName.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noreferrer">
                  <GithubIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="break-all">{repository.fullName}</span>
                  {repository.private === true ? <Lock className="h-3 w-3 shrink-0" role="img" aria-label={t("localizationApps.privateRepository")} /> : null}
                </a>
              </li>
            ))}
          </ul> : <p role="status" className="text-sm text-muted-foreground">
            {search ? t("localizationApps.noMatchingRepositories") : t("localizationApps.noAccessibleRepositoriesForOwner")}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("localizationApps.refreshRepositoryList")}</p>
        )}
        {configurationUrl ? <p className="text-xs text-muted-foreground">
          <Trans i18nKey="localizationApps.missingRepositoryHint" components={{ githubLink: <a href={configurationUrl} target="_blank" rel="noreferrer" className="text-foreground hover:underline" /> }} />
        </p> : null}
      </div>
    </div>
  );
}

function IdentitiesHeading() {
  const { t } = useTranslation();
  return <h2 className="text-sm font-semibold text-foreground">{t("localizationConnections.whichHumansCanUseThisCredential167")}</h2>;
}

function HumanAccessCards({
  personal,
  restricted,
  connectedName,
  connectedImage,
  status,
  canEditAudience,
  onChooseAll,
  onChooseSelected,
}: {
  personal: boolean;
  restricted: boolean;
  connectedName: string | null;
  connectedImage: string | null;
  status: ConnectionGrant["status"] | null;
  canEditAudience: boolean;
  onChooseAll: () => void;
  onChooseSelected: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <RadioCardGroup
        ariaLabel={t("localizationApps.whichHumansCanUseThisCredential389")}
        value={personal ? "personal" : restricted ? "selected" : "company"}
        className="sm:grid-cols-2"
        onValueChange={(next) => {
          if (!canEditAudience || personal) return;
          if (next === "company") onChooseAll();
          if (next === "selected") onChooseSelected();
        }}
        options={personal ? [
          {
            value: "personal",
            title: t("localizationConnections.justMe174"),
            description: t("localizationApps.onlyYouCanUseThisConnection391"),
            icon: <UserRound className="h-4 w-4" />,
          },
        ] : [
          {
            value: "selected",
            title: t("localizationApps.humansIPick392"),
            description: t("localizationApps.onlySelectedPeopleInYourCompany393"),
            icon: <UserRound className="h-4 w-4" />,
            disabled: !canEditAudience,
          },
          {
            value: "company",
            title: t("localizationConnections.anyHumanInTheCompany177"),
            description: t("localizationApps.anyoneInYourCompanyCanUseThisConnection395"),
            icon: <Building2 className="h-4 w-4" />,
            disabled: !canEditAudience,
          },
        ]}
      />
      {connectedName && status !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <Identity name={connectedName} avatarUrl={connectedImage} />
          {status === "active" ? null : <StatusText status={status} />}
        </div>
      ) : null}
    </div>
  );
}

function IdentityRow({
  id,
  title,
  status,
  detail,
  actions,
}: {
  id?: string;
  title: string;
  status: ConnectionGrant["status"] | null;
  detail: ReactNode;
  actions: ReactNode;
}) {
  useTranslation();
  return (
    <div id={id} className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {status === "active" ? null : <StatusText status={status} />}
        </div>
        {detail ? <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

/**
 * "Who can use this identity" (PAP-17835 Surface C). Scope is a two-option
 * radio: all organization members, persisted as no audience members, or a
 * selected set. The dialog stays open on a denial so the selection survives.
 */
export function AudienceDialog({
  appName,
  grant,
  members,
  pending,
  error,
  onCancel,
  onSave,
}: {
  appName: string;
  grant: ConnectionGrant;
  members: ConnectionAudienceMember[];
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (memberUserIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const initialSelection = useMemo(() => audienceUserIds(grant), [grant]);
  const [scope, setScope] = useState<"all" | "selected">(initialSelection.size === 0 ? "all" : "selected");
  const [selected, setSelected] = useState<Set<string>>(initialSelection);

  useEffect(() => {
    setSelected(initialSelection);
    setScope(initialSelection.size === 0 ? "all" : "selected");
  }, [initialSelection]);

  const canSave = scope === "all" || selected.size > 0;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("localizationApps.whoCanUseThisIdentity396")}</DialogTitle>
          <DialogDescription>
            {grantAccountLabel(grant)} · {appName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <RadioCardGroup
            ariaLabel={t("localizationApps.whoCanUseThisIdentity396")}
            value={scope}
            onValueChange={(next) => setScope(next as "all" | "selected")}
            options={[
              {
                value: "all",
                title: t("localizationApps.allOrganizationMembers397"),
                description: t("localizationApps.anyoneInThisOrganizationCanHaveWorkUseThisIde398"),
              },
              {
                value: "selected",
                title: t("localizationApps.selectedMembers399"),
                description: t("localizationApps.onlyThePeopleYouChoose400"),
              },
            ]}
          />

          {scope === "selected" ? (
            <MemberMultiSelect
              members={members.map((member) => ({
                userId: member.userId,
                name: member.name,
                email: member.email,
              }))}
              selectedUserIds={selected}
              onChange={setSelected}
              triggerLabel={selected.size === 0
                ? t("localizationApps.choosePeople401")
                : t("localizationApps.selectedPeople", { count: selected.size })}
            />
          ) : null}

          <p className="text-xs text-muted-foreground">{t("localizationApps.thisControlsWhoseWorkCanUseTheIdentityItDoesN403")}</p>

          {error ? (
            <InlineBanner tone="warning" compact>
              {error}
            </InlineBanner>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>{t("pages.apps.common.cancel")}</Button>
          <Button
            disabled={pending || !canSave}
            onClick={() => onSave(scope === "all" ? [] : [...selected])}
          >
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{t("localizationApps.saveAudience404")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Revoke confirmation (PAP-17835 Surface D). Revoke breaks active and future
 * runs, so it is an `AlertDialog` and the destructive action is not the initial
 * focus. The row survives afterwards showing Revoked, which keeps the context
 * and the reconnect path.
 */
export function RevokeGrantDialog({
  grant,
  providerName,
  pending,
  isOwnIdentity,
  credentialPolicy,
  onCancel,
  onConfirm,
}: {
  grant: ConnectionGrant;
  providerName: string;
  pending: boolean;
  isOwnIdentity: boolean;
  credentialPolicy: ToolConnectionCredentialPolicy;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const personal = grant.kind === "user";
  const title = personal
    ? isOwnIdentity
      ? t("localizationApps.revokeYourIdentity", { provider: providerName })
      : t("localizationApps.revokeThisIdentity", { provider: providerName })
    : t("localizationApps.revokeTheOrganizationIdentity407");
  const body = personal
    ? isOwnIdentity
      ? t("localizationApps.agentsWillStopActingAsYouWorkThatNeedsThisIde408")
      : t("localizationApps.agentsWillStopActingAsThisPersonTheyCanConnec409")
    : credentialPolicy === "per_user"
      ? t("localizationApps.installedAgentsLoseThisSharedIdentityImmediat410")
      : t("localizationApps.eligibleMembersAndInstalledAgentsWillLoseThis411");

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} autoFocus>{t("pages.apps.common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >{t("localizationApps.revokeIdentity359")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
