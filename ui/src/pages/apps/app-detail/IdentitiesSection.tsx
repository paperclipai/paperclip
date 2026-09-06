import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Building2, Loader2, TriangleAlert, UserRound } from "lucide-react";
import type {
  ConnectionAudienceMember,
  ConnectionGrant,
  ConnectionGrantsResponse,
  ToolConnectionCredentialPolicy,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Identity } from "@/components/Identity";
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
        <InlineBanner tone="warning" compact>
          We couldn't load who this connection acts as. Reload the page to try again.
        </InlineBanner>
      </section>
    );
  }

  if (credentialPolicy === "per_agent") {
    const github = agentGrant?.providerTenant?.github;
    return (
      <section className="space-y-5">
        <h2 className="text-sm font-semibold text-foreground">GitHub identity</h2>
        <IdentityRow
          title={github ? `@${github.login}` : "Dedicated GitHub account"}
          status={agentGrant?.status ?? null}
          detail={dedicatedAgent ? (
            <Link
              to={agentUrl(dedicatedAgent)}
              className="transition-colors hover:text-foreground hover:underline"
            >
              Used only by {dedicatedAgent.name}
            </Link>
          ) : "Dedicated to one agent"}
          actions={!agentGrant && dedicatedAgent && capabilities?.canConfigure ? (
            <Button size="sm" disabled={connectPending} onClick={() => onConnectAgent(dedicatedAgent.id)}>
              {connectPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Connect dedicated account
            </Button>
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
              title="Personal account"
              status={null}
              detail="Personal identity"
              actions={capabilities?.canConnectAsCurrentUser ? (
                  <Button size="sm" disabled={connectPending} onClick={onConnectAsMe}>
                    {connectPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    Connect as me
                  </Button>
                ) : null}
            />
          )
        ) : (
          orgGrant ? (
            orgGrant.capabilities?.canEditAudience ? (
              <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => onOpenAudience(orgGrant.id)}>
                    Manage access
                  </Button>
              </div>
            ) : null
          ) : (
            <IdentityRow
              title="Organization account"
              status={null}
              detail="Organization identity"
              actions={capabilities?.canCreateOrganizationGrant ? (
                  <Button size="sm" disabled={connectPending} onClick={onConnectOrganization}>
                    Connect organization identity
                  </Button>
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
  const github = grant.providerTenant?.github;
  if (!github) return null;
  const repositoryWarning = github.repositorySelection === "all"
    ? "All current and future repositories"
    : github.repositorySelection === "mixed"
      ? "Mixed access; scope varies by installation"
      : null;
  const repositorySummary = github.repositorySelection === "none"
    ? "No repositories selected"
    : `${github.repositoryCount} selected repositories`;
  return (
    <div className="divide-y divide-border border-y border-border">
      <div className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Repositories</div>
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
        {github.managementUrl ? (
          <Button asChild size="sm" variant="outline">
            <a href={github.managementUrl} target="_blank" rel="noreferrer">Manage repositories on GitHub</a>
          </Button>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Refresh access</div>
          <div className="text-xs text-muted-foreground">Sync repository access from GitHub.</div>
        </div>
        {onRefreshAccess ? (
          <Button size="sm" variant="outline" disabled={refreshPending} onClick={onRefreshAccess}>
            {refreshPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Refresh access
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function IdentitiesHeading() {
  return <h2 className="text-sm font-semibold text-foreground">Which humans can use this credential?</h2>;
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
  return (
    <div className="space-y-3">
      <RadioCardGroup
        ariaLabel="Which humans can use this credential"
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
            title: "Just me",
            description: "Only you can use this connection.",
            icon: <UserRound className="h-4 w-4" />,
          },
        ] : [
          {
            value: "selected",
            title: "Humans I pick",
            description: "Only selected people in your company.",
            icon: <UserRound className="h-4 w-4" />,
            disabled: !canEditAudience,
          },
          {
            value: "company",
            title: "Any human in the company",
            description: "Anyone in your company can use this connection.",
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
          <DialogTitle>Who can use this identity</DialogTitle>
          <DialogDescription>
            {grantAccountLabel(grant)} · {appName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <RadioCardGroup
            ariaLabel="Who can use this identity"
            value={scope}
            onValueChange={(next) => setScope(next as "all" | "selected")}
            options={[
              {
                value: "all",
                title: "All organization members",
                description: "Anyone in this organization can have work use this identity.",
              },
              {
                value: "selected",
                title: "Selected members",
                description: "Only the people you choose.",
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
                ? "Choose people"
                : `${selected.size} ${selected.size === 1 ? "person" : "people"} selected`}
            />
          ) : null}

          <p className="text-xs text-muted-foreground">
            This controls whose work can use the identity. It does not change which agents have the
            connection.
          </p>

          {error ? (
            <InlineBanner tone="warning" compact>
              {error}
            </InlineBanner>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || !canSave}
            onClick={() => onSave(scope === "all" ? [] : [...selected])}
          >
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save audience
          </Button>
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
  const personal = grant.kind === "user";
  const title = personal
    ? isOwnIdentity
      ? `Revoke your ${providerName} identity?`
      : `Revoke this ${providerName} identity?`
    : "Revoke the organization identity?";
  const body = personal
    ? isOwnIdentity
      ? "Agents will stop acting as you. Work that needs this identity can ask you to connect again."
      : "Agents will stop acting as this person. They can connect again themselves; no one else can do it for them."
    : credentialPolicy === "per_user"
      ? "Installed agents lose this shared identity immediately."
      : "Eligible members and installed agents will lose this shared identity immediately.";

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} autoFocus>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            Revoke identity
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
