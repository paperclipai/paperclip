import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import type {
  ConnectionAudienceMember,
  ConnectionGrant,
  ConnectionGrantsResponse,
  ToolConnectionCredentialPolicy,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InlineBanner } from "@/components/InlineBanner";
import { MemberMultiSelect } from "@/components/MemberMultiSelect";
import { AgentMultiSelect } from "@/components/AgentMultiSelect";
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
import { cn } from "@/lib/utils";
import { brandChipBadge } from "@/lib/status-colors";
import {
  audienceSummary,
  audienceUserIds,
  grantAccountLabel,
  grantStatusLabel,
  grantStatusTone,
  memberLabel,
  organizationGrant,
  otherPersonalGrants,
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

function formatLastUsed(value: ConnectionGrant["lastUsedAt"]): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `Last used ${parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/**
 * Identity rows for the connection Setup tab (PAP-17835 Surface B).
 *
 * Rows are separated by space and a rule, not wrapped in one card each: "space
 * separates; lines contain". Every action here is rendered from a server
 * capability — a policy-forbidden action is absent rather than disabled, so a
 * viewer sees the same legible state with no controls at all.
 */
export function IdentitiesSection({
  appName,
  providerName,
  credentialPolicy,
  grantsQuery,
  agents,
  agentsLoading,
  agentsError,
  loading,
  error,
  onConnectAsMe,
  onConnectOrganization,
  onReconnectOrganization,
  onRevokeGrant,
  onReplaceAudience,
  connectPending,
  revokePending,
  delegationPending,
  audiencePending,
  audienceError,
  audienceGrantId,
  onOpenAudience,
  onCloseAudience,
  onReplaceDelegations,
}: {
  appName: string;
  providerName: string;
  credentialPolicy: ToolConnectionCredentialPolicy;
  grantsQuery: ConnectionGrantsResponse | undefined;
  agents: Array<{
    id: string;
    name: string;
    title?: string | null;
    icon?: string | null;
    status: string;
  }>;
  agentsLoading: boolean;
  agentsError: boolean;
  loading: boolean;
  error: boolean;
  onConnectAsMe: () => void;
  onConnectOrganization: () => void;
  onReconnectOrganization: () => void;
  onRevokeGrant: (grant: ConnectionGrant) => void;
  onReplaceAudience: (grant: ConnectionGrant, memberUserIds: string[]) => void;
  connectPending: boolean;
  revokePending: boolean;
  delegationPending: boolean;
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
  onReplaceDelegations: (grant: ConnectionGrant, agentIds: string[]) => void;
}) {
  const [revokeTarget, setRevokeTarget] = useState<ConnectionGrant | null>(null);
  const [othersExpanded, setOthersExpanded] = useState(false);

  const grants = grantsQuery?.grants ?? [];
  const capabilities = grantsQuery?.capabilities;
  const currentUserId = grantsQuery?.currentUserId ?? null;
  const members = grantsQuery?.members ?? [];
  const orgGrant = useMemo(() => organizationGrant(grants), [grants]);
  const myGrant = useMemo(() => personalGrantFor(grants, currentUserId), [grants, currentUserId]);
  const others = useMemo(() => otherPersonalGrants(grants, currentUserId), [grants, currentUserId]);
  const myLabel = memberLabel(members, currentUserId);
  const audienceGrant = audienceGrantId
    ? grants.find((grant) => grant.id === audienceGrantId) ?? null
    : null;

  if (loading) {
    return (
      <section className="space-y-3" aria-busy="true">
        <IdentitiesHeading />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </section>
    );
  }

  if (error) {
    return (
      <section className="space-y-3">
        <IdentitiesHeading />
        <InlineBanner tone="warning" compact>
          We couldn't load who this connection acts as. Reload the page to try again.
        </InlineBanner>
      </section>
    );
  }

  return (
    <section>
      <IdentitiesHeading />

      {agentsError ? (
        <div className="mt-3">
          <InlineBanner tone="warning" compact>
            We couldn't load agents for autonomous access. Reload the page to try again.
          </InlineBanner>
        </div>
      ) : null}

      <div className="mt-4 divide-y divide-border">
        {/* Organization identity — always visible, including when missing, so the
            shared-vs-personal distinction never has to be inferred from absence. */}
        <IdentityRow
          title="Organization identity"
          secondary={grantAccountLabel(orgGrant)}
          status={orgGrant?.status ?? null}
          detail={orgGrant
            ? audienceSummary(orgGrant)
            : "Used when the connection policy allows a shared identity."}
          actions={
            <>
              {orgGrant?.capabilities?.canEditAudience ? (
                <Button size="sm" variant="outline" onClick={() => onOpenAudience(orgGrant.id)}>
                  Manage audience
                </Button>
              ) : null}
              {orgGrant && capabilities?.canConfigure ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={connectPending}
                  onClick={onReconnectOrganization}
                >
                  Reconnect
                </Button>
              ) : null}
              {orgGrant?.capabilities?.canRevoke && orgGrant.status !== "revoked" ? (
                <Button size="sm" variant="outline" onClick={() => setRevokeTarget(orgGrant)}>
                  Revoke
                </Button>
              ) : null}
              {!orgGrant && capabilities?.canCreateOrganizationGrant ? (
                <Button size="sm" disabled={connectPending} onClick={onConnectOrganization}>
                  Connect organization identity
                </Button>
              ) : null}
            </>
          }
        />

        {/* Your identity — the signed-in user only. Audience is never shown here:
            a personal identity is consent-bound to the person who granted it. */}
        {capabilities?.canConnectAsCurrentUser || myGrant ? (
          <IdentityRow
            id="personal-identity"
            title="Your identity"
            secondary={myGrant ? grantAccountLabel(myGrant, { subjectLabel: myLabel }) : null}
            status={myGrant?.status ?? null}
            detail={myGrant
              ? formatLastUsed(myGrant.lastUsedAt) ?? "Only work running for you can use this identity."
              : "You have not connected your account."}
            actions={
              <>
                {myGrant && myGrant.status !== "revoked" ? (
                  <>
                    <Button size="sm" variant="outline" disabled={connectPending} onClick={onConnectAsMe}>
                      Reconnect
                    </Button>
                    {myGrant.capabilities?.canRevoke ? (
                      <Button size="sm" variant="outline" onClick={() => setRevokeTarget(myGrant)}>
                        Revoke
                      </Button>
                    ) : null}
                    {myGrant.status === "active" ? (
                      <AgentMultiSelect
                        agents={agents.filter((agent) => agent.status !== "terminated")}
                        loading={agentsLoading}
                        selectedAgentIds={new Set(
                          (myGrant.delegations ?? []).map((delegation) => delegation.agentId),
                        )}
                        pending={delegationPending}
                        triggerLabel={(myGrant.delegations?.length ?? 0) === 0
                          ? "Allow autonomous access"
                          : `${myGrant.delegations?.length ?? 0} ${myGrant.delegations?.length === 1 ? "agent" : "agents"} allowed for autonomous runs`}
                        triggerSize="sm"
                        triggerFullWidth={false}
                        showSelectionPreview={false}
                        headerContent={(
                          <p className="mt-2 text-xs text-muted-foreground">
                            Select the named agents that may use your identity in autonomous runs.
                          </p>
                        )}
                        onSave={(agentIds) => onReplaceDelegations(myGrant, [...agentIds])}
                      />
                    ) : null}
                  </>
                ) : capabilities?.canConnectAsCurrentUser ? (
                  <Button size="sm" disabled={connectPending} onClick={onConnectAsMe}>
                    {connectPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    Connect as me
                  </Button>
                ) : null}
              </>
            }
          />
        ) : null}
      </div>

      {/* Manager oversight. A regular member never sees this list — the server
          omits the grants entirely, so there is nothing to hide client-side. */}
      {capabilities?.canViewOtherPersonalIdentities && others.length > 0 ? (
        <div className="mt-4 border-t border-border pt-3">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={othersExpanded}
            onClick={() => setOthersExpanded((open) => !open)}
          >
            <span className="flex-1">Other personal identities · {others.length}</span>
            <ChevronRight
              className={cn("h-4 w-4 transition-transform", othersExpanded && "rotate-90")}
            />
          </button>
          {othersExpanded ? (
            <div className="mt-2 divide-y divide-border">
              {others.map((grant) => (
                <div key={grant.id} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">
                      {grantAccountLabel(grant, {
                        subjectLabel: memberLabel(members, grant.subjectUserId),
                      })}
                    </div>
                    {formatLastUsed(grant.lastUsedAt) ? (
                      <div className="text-xs text-muted-foreground">{formatLastUsed(grant.lastUsedAt)}</div>
                    ) : null}
                  </div>
                  <StatusText status={grant.status} />
                  {grant.capabilities?.canRevoke && grant.status !== "revoked" ? (
                    <Button size="sm" variant="outline" onClick={() => setRevokeTarget(grant)}>
                      Revoke
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

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

      {revokeTarget ? (
        <RevokeGrantDialog
          grant={revokeTarget}
          providerName={providerName}
          pending={revokePending}
          credentialPolicy={credentialPolicy}
          isOwnIdentity={revokeTarget.kind === "user" && revokeTarget.subjectUserId === currentUserId}
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => {
            onRevokeGrant(revokeTarget);
            setRevokeTarget(null);
          }}
        />
      ) : null}
    </section>
  );
}

function IdentitiesHeading() {
  return (
    <div>
      <h2 className="text-sm font-bold text-foreground">Identities</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Who agents act as when they use this connection.
      </p>
    </div>
  );
}

function IdentityRow({
  id,
  title,
  secondary,
  status,
  detail,
  actions,
}: {
  id?: string;
  title: string;
  secondary: string | null;
  status: ConnectionGrant["status"] | null;
  detail: string | null;
  actions: ReactNode;
}) {
  return (
    <div id={id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          <StatusText status={status} />
        </div>
        {secondary ? <div className="mt-0.5 truncate text-sm text-foreground">{secondary}</div> : null}
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
