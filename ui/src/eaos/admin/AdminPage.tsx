// LET-484 working-product slice — read-only `/eaos/admin` zone.
//
// Source of truth: `accessApi.listMembers(companyId)` (`GET
// /api/companies/:companyId/members`). The page surfaces:
//   - the operator's own access posture (role / capabilities derived from
//     the live response, never client-faked),
//   - the user roster with role + status + grant count,
//   - explicit truthful gap labels for the unwired admin verbs (invite
//     management UI, role mutation, audit log filter) that still live
//     inside the kernel admin pages.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldAlert, ShieldCheck, Users } from "lucide-react";
import { accessApi } from "@/api/access";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { EaosPageHeader } from "../EaosPageHeader";
import { EaosStateChip } from "../EaosStateChip";
import { redactSecretLikeText } from "../secret-redact";

export function AdminPage() {
  const { selectedCompanyId } = useCompany();

  const membersQuery = useQuery({
    queryKey: selectedCompanyId
      ? [...queryKeys.access.companyMembers(selectedCompanyId), "eaos-admin"]
      : ["access", "company-members", "__no-company__", "eaos-admin"],
    queryFn: () => accessApi.listMembers(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const members = membersQuery.data?.members ?? [];
  const access = membersQuery.data?.access ?? null;

  const counts = useMemo(() => summarizeMembers(members), [members]);

  const isLoading = Boolean(selectedCompanyId) && membersQuery.isLoading;
  const isError = Boolean(selectedCompanyId) && membersQuery.isError;
  const hasData = !isLoading && !isError && membersQuery.isSuccess;
  const dataConnected = hasData;

  return (
    <section
      aria-labelledby="eaos-admin-title"
      className="-mx-4 -my-5 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8"
      data-testid="eaos-admin-page"
      data-eaos-data-connected={dataConnected ? "true" : "false"}
    >
      <EaosPageHeader title="Admin" testId="eaos-admin-page-header" />
      <h1 id="eaos-admin-title" className="sr-only" data-testid="eaos-admin-title">
        Admin
      </h1>

      <div className="flex min-h-0 flex-1 flex-col gap-5 px-4 py-4 sm:px-6 lg:px-8">
        {!selectedCompanyId ? (
          <NoCompanyState />
        ) : isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState message={readErrorMessage(membersQuery.error)} />
        ) : (
          <>
            <AccessPostureCard access={access} />
            <SummaryStrip counts={counts} />
            {members.length === 0 ? (
              <EmptyState />
            ) : (
              <MembersList members={members} />
            )}
          </>
        )}

        <AuditPointer />
        <SecretsPointer />
      </div>
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to load admin posture.";
}

function NoCompanyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-admin-no-company"
    >
      Select a company scope from the top bar to load the admin roster.
    </div>
  );
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-admin-loading"
    >
      Loading member roster from canonical records…
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      data-testid="eaos-admin-error"
    >
      <p className="font-medium">Could not load admin posture.</p>
      <p className="mt-1 text-xs">{redactSecretLikeText(message)}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      role="status"
      className="rounded-md border border-dashed border-border bg-card p-4 text-sm text-muted-foreground"
      data-testid="eaos-admin-empty"
    >
      No members yet. Invite teammates to get started.
    </div>
  );
}

interface MembersCounts {
  total: number;
  owners: number;
  admins: number;
  operators: number;
  viewers: number;
  pending: number;
  suspended: number;
}

function summarizeMembers(
  members: ReadonlyArray<{
    status?: string;
    membershipRole?: string | null;
  }>,
): MembersCounts {
  const counts: MembersCounts = {
    total: members.length,
    owners: 0,
    admins: 0,
    operators: 0,
    viewers: 0,
    pending: 0,
    suspended: 0,
  };
  for (const member of members) {
    switch (member.membershipRole) {
      case "owner":
        counts.owners += 1;
        break;
      case "admin":
        counts.admins += 1;
        break;
      case "operator":
        counts.operators += 1;
        break;
      case "viewer":
        counts.viewers += 1;
        break;
    }
    if (member.status === "pending") counts.pending += 1;
    if (member.status === "suspended") counts.suspended += 1;
  }
  return counts;
}

function AccessPostureCard({
  access,
}: {
  access:
    | {
        currentUserRole: string | null;
        canManageMembers: boolean;
        canInviteUsers: boolean;
        canApproveJoinRequests: boolean;
      }
    | null;
}) {
  if (!access) {
    return (
      <div
        className="flex flex-col gap-1 rounded-md border border-dashed border-border bg-card p-3"
        data-testid="eaos-admin-access-posture-unknown"
      >
        <p className="text-xs text-muted-foreground">
          Backend has not yet returned an access posture for the current operator.
        </p>
      </div>
    );
  }
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid="eaos-admin-access-posture"
    >
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden="true" className="h-4 w-4 text-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Your access</h2>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground sm:grid-cols-4">
        <div className="flex flex-col" data-testid="eaos-admin-access-role">
          <dt className="uppercase tracking-wide">Current role</dt>
          <dd className="text-foreground">{access.currentUserRole ?? "—"}</dd>
        </div>
        <div className="flex flex-col" data-testid="eaos-admin-access-can-manage">
          <dt className="uppercase tracking-wide">Manage members</dt>
          <dd className="text-foreground">{access.canManageMembers ? "Yes" : "No"}</dd>
        </div>
        <div className="flex flex-col" data-testid="eaos-admin-access-can-invite">
          <dt className="uppercase tracking-wide">Invite users</dt>
          <dd className="text-foreground">{access.canInviteUsers ? "Yes" : "No"}</dd>
        </div>
        <div className="flex flex-col" data-testid="eaos-admin-access-can-approve">
          <dt className="uppercase tracking-wide">Approve joins</dt>
          <dd className="text-foreground">{access.canApproveJoinRequests ? "Yes" : "No"}</dd>
        </div>
      </dl>
    </div>
  );
}

function SummaryStrip({ counts }: { counts: MembersCounts }) {
  const items: Array<{ id: string; label: string; value: number }> = [
    { id: "total", label: "Total", value: counts.total },
    { id: "owners", label: "Owners", value: counts.owners },
    { id: "admins", label: "Admins", value: counts.admins },
    { id: "operators", label: "Operators", value: counts.operators },
    { id: "viewers", label: "Viewers", value: counts.viewers },
    { id: "pending", label: "Pending", value: counts.pending },
    { id: "suspended", label: "Suspended", value: counts.suspended },
  ];
  return (
    <dl
      data-testid="eaos-admin-summary"
      className="grid grid-cols-2 gap-2 rounded-md border border-border bg-card p-3 sm:grid-cols-4 lg:grid-cols-7"
    >
      {items.map((item) => (
        <div
          key={item.id}
          data-testid={`eaos-admin-summary-${item.id}`}
          className="flex flex-col gap-0.5"
        >
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{item.label}</dt>
          <dd className="text-lg font-semibold text-foreground tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function MembersList({
  members,
}: {
  members: ReadonlyArray<{
    id: string;
    status?: string;
    membershipRole?: string | null;
    user?: { id: string; name?: string | null; email?: string | null; slug?: string | null } | null;
    grants?: ReadonlyArray<unknown>;
  }>;
}) {
  return (
    <section
      aria-label="Company members"
      className="flex flex-col gap-2"
      data-testid="eaos-admin-members"
    >
      <header className="flex items-center gap-2">
        <Users aria-hidden="true" className="h-4 w-4 text-foreground" />
        <h2 className="text-sm font-semibold text-foreground">
          Members{" "}
          <span className="text-xs font-normal text-muted-foreground">({members.length})</span>
        </h2>
      </header>
      <ul
        className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
        data-testid="eaos-admin-members-rows"
      >
        {members.map((member) => {
          const displayName =
            member.user?.name?.trim() && member.user.name.trim().length > 0
              ? member.user.name
              : member.user?.email ?? "(unnamed member)";
          return (
            <li
              key={member.id}
              className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
              data-testid="eaos-admin-member-row"
              data-member-id={member.id}
              data-member-status={member.status}
              data-member-role={member.membershipRole ?? "none"}
            >
              <div className="flex flex-wrap items-center gap-2">
                <EaosStateChip
                  label={(member.membershipRole ?? "member").toUpperCase()}
                  prefix="Role"
                  title={`Role: ${member.membershipRole ?? "member"}`}
                />
                {member.status && member.status !== "active" ? (
                  <span
                    data-testid="eaos-admin-member-status"
                    className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                  >
                    {member.status}
                  </span>
                ) : null}
              </div>
              <p className="text-sm font-medium text-foreground" data-testid="eaos-admin-member-name">
                {redactSecretLikeText(displayName)}
              </p>
              {member.user?.email ? (
                <p className="text-xs text-muted-foreground" data-testid="eaos-admin-member-email">
                  {redactSecretLikeText(member.user.email)}
                </p>
              ) : null}
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Grants ·{" "}
                <span className="tabular-nums text-foreground">{member.grants?.length ?? 0}</span>
              </p>
              {member.user?.slug ? (
                <Link
                  to={`/u/${member.user.slug}`}
                  className="font-medium text-xs text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  data-testid="eaos-admin-member-profile-link"
                >
                  Open profile →
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AuditPointer() {
  return (
    <section
      aria-label="Audit log"
      className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-card p-3"
      data-testid="eaos-admin-audit-pointer"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert aria-hidden="true" className="h-4 w-4 text-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Audit log</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        The activity feed lives under{" "}
        <Link
          to="/eaos/runs"
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-admin-audit-runs-link"
        >
          Runs
        </Link>
        . A security-filtered audit view is coming soon.
      </p>
    </section>
  );
}

function SecretsPointer() {
  return (
    <section
      aria-label="Secrets and policies"
      className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-card p-3"
      data-testid="eaos-admin-secrets-pointer"
    >
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden="true" className="h-4 w-4 text-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Secrets &amp; policies</h2>
      </div>
      <p className="text-xs text-muted-foreground">
        Secrets and policies are managed in{" "}
        <Link
          to="/company/settings/secrets"
          className="font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-admin-secrets-link"
        >
          Settings → Secrets
        </Link>
        .
      </p>
    </section>
  );
}
