import { t as finalPagesT } from "@/i18n";
import { useTranslation } from "@/i18n";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Building2, Loader2, Lock, RefreshCw, TriangleAlert, UserRound } from "lucide-react";
import type {
  ConnectionAudienceMember,
  ConnectionGrant,
  ConnectionGrantsResponse,
  ToolConnectionCredentialPolicy,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Identity } from "@/components/Identity";
import { GithubIcon } from "@/components/icons/github-icon";
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
  const { t } = useTranslation("connections");
  const grants = grantsQuery?.grants ?? [];
  const capabilities = grantsQuery?.capabilities;
  const currentUserId = grantsQuery?.currentUserId ?? null;
  const members = grantsQuery?.members ?? [];
  const orgGrant = useMemo(() => organizationGrant(grants), [grants, t]);
  const myGrant = useMemo(() => personalGrantFor(grants, currentUserId), [grants, currentUserId, t]);
  const personalGrant = useMemo(() => {
    const personalGrants = grants.filter((grant) => grant.kind === "user");
    return personalGrants.find((grant) => grant.subjectUserId === ownerUserId)
      ?? myGrant
      ?? personalGrants.find((grant) => grant.status === "active")
      ?? personalGrants[0]
      ?? null;
  }, [grants, myGrant, ownerUserId, t]);
  const agentGrant = useMemo(
    () => grants.find((grant) => grant.kind === "agent" && grant.subjectAgentId === dedicatedAgent?.id)
      ?? grants.find((grant) => grant.kind === "agent")
      ?? null,
    [dedicatedAgent?.id, grants, t],
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
        <InlineBanner tone="warning" compact>{t("we_couldn_t_load_who_this_connection_eb96155")}</InlineBanner>
      </section>
    );
  }

  if (credentialPolicy === "per_agent") {
    const github = agentGrant?.providerTenant?.github;
    return (
      <section className="space-y-5">
        <h2 className="text-sm font-semibold text-foreground">{t("github_identity_66ebbce")}</h2>
        <p className="text-sm text-muted-foreground">{t("this_agent_uses_this_github_account_for_0cac27a")}</p>
        <IdentityRow
          title={github ? `@${github.login}` : t("dedicated_github_account_b454c17")}
          status={agentGrant?.status ?? null}
          detail={dedicatedAgent ? (
            <Link
              to={agentUrl(dedicatedAgent)}
              className="transition-colors hover:text-foreground hover:underline"
            >{t("used_only_by_83bf799", { name: dedicatedAgent.name })}</Link>
          ) : t("dedicated_to_one_agent_989a5da")}
          actions={!agentGrant && dedicatedAgent && capabilities?.canConfigure ? (
            <Button size="sm" disabled={connectPending} onClick={() => onConnectAgent(dedicatedAgent.id)}>
              {connectPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{t("connect_dedicated_account_f6d06d6")}</Button>
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
              title={t("personal_account_5f9085b")}
              status={null}
              detail={t("personal_identity_2822542")}
              actions={capabilities?.canConnectAsCurrentUser ? (
                  <Button size="sm" disabled={connectPending} onClick={onConnectAsMe}>
                    {connectPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{t("connect_as_me_34e81d7")}</Button>
                ) : null}
            />
          )
        ) : (
          orgGrant ? (
            orgGrant.capabilities?.canEditAudience ? (
              <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => onOpenAudience(orgGrant.id)}>{t("manage_access_425957f")}</Button>
              </div>
            ) : null
          ) : (
            <IdentityRow
              title={t("organization_account_df699d6")}
              status={null}
              detail={t("organization_identity_34815d3")}
              actions={capabilities?.canCreateOrganizationGrant ? (
                  <Button size="sm" disabled={connectPending} onClick={onConnectOrganization}>{t("connect_organization_identity_b2c840a")}</Button>
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
  const { t } = useTranslation("connections");
  const github = grant.providerTenant?.github;
  if (!github) return null;
  const configurationUrl = github.appSlug
    ? `https://github.com/apps/${encodeURIComponent(github.appSlug)}/installations/new`
    : /^https:\/\/github\.com\/apps\/[a-z0-9-]+\/installations\/new$/.test(github.installationUrl ?? "")
      ? github.installationUrl
      : null;
  const repositoryWarning = github.repositorySelection === "all"
    ? t("all_current_and_future_repositories_d4b59d2")
    : github.repositorySelection === "mixed"
      ? t("mixed_access_scope_varies_by_installation_d35dee6")
      : null;
  const repositorySummary = github.repositorySelection === "none"
    ? t("no_repositories_selected_f3020a6")
    : t("selected_40940bc", { repositoryCount: github.repositoryCount, value: github.repositoryCount === 1 ? "repository" : "repositories" , count: github.repositoryCount});
  return (
    <div className="divide-y divide-border border-y border-border">
      <div className="py-3">
        <div className="text-sm font-medium text-foreground">{t("github_account_de64997")}</div>
        <a className="text-sm text-muted-foreground hover:underline" href={`https://github.com/${encodeURIComponent(github.login)}`} target="_blank" rel="noreferrer">
          @{github.login}
        </a>
      </div>
      <div className="space-y-3 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{t("repositories_c91e6e6")}</div>
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
              <Button size="icon-sm" variant="outline" aria-label={t("refresh_access_8228750")} title={t("refresh_access_8228750")} disabled={refreshPending} onClick={onRefreshAccess}>
                {refreshPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              </Button>
            ) : null}
            {configurationUrl ? (
              <Button asChild size="sm" variant="outline">
                <a href={configurationUrl} target="_blank" rel="noreferrer">{t("add_more_repos_on_github_cde880f")}</a>
              </Button>
            ) : onRefreshAccess ? (
              <Button size="sm" variant="outline" disabled={refreshPending} onClick={onRefreshAccess}>
                {refreshPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}{t("load_github_configuration_736b277")}</Button>
            ) : null}
          </div>
        </div>
        {github.repositories ? (
          github.repositories.length ? <ul aria-label={t("accessible_github_repositories_51c0095")} tabIndex={0} className="max-h-(--sz-github-repository-list) space-y-2 overflow-y-auto text-sm">
            {github.repositories.map((repository) => (
              <li key={repository.id}>
                <a className="flex items-center gap-2 text-muted-foreground hover:underline" href={`https://github.com/${repository.fullName.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noreferrer">
                  <GithubIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="break-all">{repository.fullName}</span>
                  {repository.private === true ? <Lock className="h-3 w-3 shrink-0" role="img" aria-label={t("private_repository_03e2352")} /> : null}
                </a>
              </li>
            ))}
          </ul> : <p role="status" className="text-sm text-muted-foreground">{t("no_accessible_repositories_48d1f4d")}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("refresh_access_to_load_the_current_repository_5d79a0f")}</p>
        )}
        {configurationUrl ? <p className="text-xs text-muted-foreground">{t("missing_an_organization_or_repository_4a5fcd5")}<a href={configurationUrl} target="_blank" rel="noreferrer" className="text-foreground hover:underline">{t("configure_access_on_github_10ca993")}</a>{t("then_refresh_this_list_176d914")}</p> : null}
      </div>
    </div>
  );
}

function IdentitiesHeading() {
  const { t } = useTranslation("connections");
  return <h2 className="text-sm font-semibold text-foreground">{t("which_humans_can_use_this_credential_3437907")}</h2>;
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
  const { t } = useTranslation("connections");
  return (
    <div className="space-y-3">
      <RadioCardGroup
        ariaLabel={t("which_humans_can_use_this_credential_4d2905a")}
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
            title: finalPagesT("final-pages:Just_me_3a4b4d"),
            description: finalPagesT("final-pages:Only_you_can_use_this_connection_7fb35f"),
            icon: <UserRound className="h-4 w-4" />,
          },
        ] : [
          {
            value: "selected",
            title: finalPagesT("final-pages:Humans_I_pick_733eda"),
            description: finalPagesT("final-pages:Only_selected_people_in_your_company_c4dd62"),
            icon: <UserRound className="h-4 w-4" />,
            disabled: !canEditAudience,
          },
          {
            value: "company",
            title: finalPagesT("final-pages:Any_human_in_the_company_4b9236"),
            description: finalPagesT("final-pages:Anyone_in_your_company_can_use_this_connection_066376"),
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
  const { t } = useTranslation("connections");
  const initialSelection = useMemo(() => audienceUserIds(grant), [grant, t]);
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
          <DialogTitle>{t("who_can_use_this_identity_2decf21")}</DialogTitle>
          <DialogDescription>
            {grantAccountLabel(grant)} · {appName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <RadioCardGroup
            ariaLabel={t("who_can_use_this_identity_2decf21")}
            value={scope}
            onValueChange={(next) => setScope(next as "all" | "selected")}
            options={[
              {
                value: "all",
                title: finalPagesT("final-pages:All_organization_members_eac089"),
                description: finalPagesT("final-pages:Anyone_in_this_organization_can_have_work_use_this_identity_eb1968"),
              },
              {
                value: "selected",
                title: finalPagesT("final-pages:Selected_members_78a279"),
                description: finalPagesT("final-pages:Only_the_people_you_choose_085cf1"),
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
                ? finalPagesT("final-pages:Choose_people_4929aa")
                : finalPagesT("final-pages:selectedPeople", { count: selected.size })}
            />
          ) : null}

          <p className="text-xs text-muted-foreground">{t("this_controls_whose_work_can_use_the_112630f")}</p>

          {error ? (
            <InlineBanner tone="warning" compact>
              {error}
            </InlineBanner>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>{t("cancel_1791a62")}</Button>
          <Button
            disabled={pending || !canSave}
            onClick={() => onSave(scope === "all" ? [] : [...selected])}
          >
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{t("save_audience_8192cde")}</Button>
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
  description,
  children,
  onCancel,
  onConfirm,
}: {
  grant: ConnectionGrant;
  providerName: string;
  pending: boolean;
  isOwnIdentity: boolean;
  credentialPolicy: ToolConnectionCredentialPolicy;
  description?: string;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("connections");
  const personal = grant.kind === "user";
  const title = personal
    ? isOwnIdentity
      ? t("revoke_your_identity_234861d", { providerName: providerName })
      : t("revoke_this_identity_39c9c4a", { providerName: providerName })
    : t("revoke_the_organization_identity_31297ac");
  const body = personal
    ? isOwnIdentity
      ? t("agents_will_stop_acting_as_you_work_62bc394")
      : t("agents_will_stop_acting_as_this_person_7384299")
    : credentialPolicy === "per_user"
      ? t("installed_agents_lose_this_shared_identity_immediately_bd658b7")
      : t("eligible_members_and_installed_agents_will_lose_302c0e2");

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description ?? body}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} autoFocus>{t("cancel_1791a62")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >{t("revoke_identity_ae59440")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
