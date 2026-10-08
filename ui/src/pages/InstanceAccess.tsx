import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield, ShieldCheck } from "lucide-react";
import { INSTANCE_USER_DISABLE_REASON_MAX_LENGTH } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { ApiError } from "@/api/client";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Card } from "@/components/ui/card";
import { companyDirectoryQueryOptions, useAccountIdentity } from "@/api/companies-query";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

export function InstanceAccess() {
  const { userId: accountUserId, settled: accountSettled } = useAccountIdentity();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<Set<string>>(new Set());
  const [pendingAccountAction, setPendingAccountAction] = useState<"disable" | "delete" | null>(null);
  const [disableReason, setDisableReason] = useState("");

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Instance settings", href: "/company/settings/instance/general" },
      { label: "Access" },
    ]);
  }, [setBreadcrumbs]);

  const usersQuery = useQuery({
    queryKey: queryKeys.access.adminUsers(search),
    queryFn: () => accessApi.searchAdminUsers(search),
  });

  const companiesQuery = useQuery({
    ...companyDirectoryQueryOptions(accountUserId),
    enabled: accountSettled && usersQuery.isSuccess,
  });
  const companies = companiesQuery.data ?? [];

  const selectedUser = useMemo(
    () => usersQuery.data?.find((user) => user.id === selectedUserId) ?? null,
    [selectedUserId, usersQuery.data],
  );

  const userAccessQuery = useQuery({
    queryKey: queryKeys.access.userCompanyAccess(selectedUserId ?? ""),
    queryFn: () => accessApi.getUserCompanyAccess(selectedUserId!),
    enabled: !!selectedUserId,
  });

  useEffect(() => {
    if (!selectedUserId && usersQuery.data?.[0]) {
      setSelectedUserId(usersQuery.data[0].id);
    }
  }, [selectedUserId, usersQuery.data]);

  useEffect(() => {
    if (!userAccessQuery.data) return;
    setSelectedCompanyIds(
      new Set(
        userAccessQuery.data.companyAccess
          .filter((membership) => membership.status === "active")
          .map((membership) => membership.companyId),
      ),
    );
  }, [userAccessQuery.data]);

  const updateCompanyAccessMutation = useMutation({
    mutationFn: () => accessApi.setUserCompanyAccess(selectedUserId!, [...selectedCompanyIds]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(selectedUserId!) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      pushToast({ title: "Organization access updated", tone: "success" });
    },
  });

  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : undefined);

  const setAdminMutation = useMutation({
    mutationFn: async (makeAdmin: boolean) => {
      if (!selectedUserId) throw new Error("No user selected");
      if (makeAdmin) return accessApi.promoteInstanceAdmin(selectedUserId);
      return accessApi.demoteInstanceAdmin(selectedUserId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      if (selectedUserId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.access.userCompanyAccess(selectedUserId) });
      }
      pushToast({ title: "Instance role updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Could not update instance role", body: errorMessage(error), tone: "error" });
    },
  });

  const disableUserMutation = useMutation({
    mutationFn: () => accessApi.disableUser(selectedUserId!, disableReason.trim() || null),
    onSuccess: async () => {
      setPendingAccountAction(null);
      setDisableReason("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      pushToast({ title: "User disabled", body: "Their sessions were signed out.", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Could not disable user", body: errorMessage(error), tone: "error" });
    },
  });

  const enableUserMutation = useMutation({
    mutationFn: () => accessApi.enableUser(selectedUserId!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      pushToast({ title: "User enabled", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Could not enable user", body: errorMessage(error), tone: "error" });
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: () => accessApi.deleteUser(selectedUserId!),
    onSuccess: async () => {
      setPendingAccountAction(null);
      setSelectedUserId(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.adminUsers(search) });
      pushToast({ title: "User deleted", tone: "success" });
    },
    onError: (error) => {
      setPendingAccountAction(null);
      pushToast({ title: "Could not delete user", body: errorMessage(error), tone: "error" });
    },
  });

  if (usersQuery.isLoading || !accountSettled || (usersQuery.isSuccess && companiesQuery.isPending)) {
    return <div className="text-sm text-muted-foreground">Loading instance access…</div>;
  }

  if (usersQuery.error) {
    const message =
      usersQuery.error instanceof ApiError && usersQuery.error.status === 403
        ? "Instance admin access is required to manage users."
        : usersQuery.error instanceof Error
          ? usersQuery.error.message
          : "Failed to load users.";
    return <div className="text-sm text-destructive">{message}</div>;
  }

  if (companiesQuery.error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">Failed to load organizations. Try again before changing access.</p>
        <Button onClick={() => void companiesQuery.refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Instance Access</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Search users, manage instance-admin status, and control which organizations they can access.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-(--gtc-34)">
        <Card className="block space-y-4 p-4">
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Search users</span>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or email"
            />
          </label>
          <div className="space-y-2">
            {(usersQuery.data ?? []).map((user) => (
              <button
                key={user.id}
                type="button"
                onClick={() => setSelectedUserId(user.id)}
                className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                  user.id === selectedUserId
                    ? "border-foreground bg-accent"
                    : "border-border hover:bg-accent/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{user.name || user.email || user.id}</div>
                    <div className="truncate text-sm text-muted-foreground">{user.email || user.id}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {user.status === "disabled" ? <Badge variant="outline">Disabled</Badge> : null}
                    {user.isInstanceAdmin ? (
                      <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {user.activeCompanyMembershipCount} active organization memberships
                </div>
              </button>
            ))}
          </div>
        </Card>

        <Card className="block space-y-4 p-5">
          {!selectedUserId ? (
            <div className="text-sm text-muted-foreground">Select a user to inspect instance access.</div>
          ) : userAccessQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading user access…</div>
          ) : userAccessQuery.error ? (
            <div className="text-sm text-destructive">
              {userAccessQuery.error instanceof Error ? userAccessQuery.error.message : "Failed to load user access."}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-semibold">
                    {selectedUser?.name || selectedUser?.email || selectedUserId}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {selectedUser?.email || selectedUserId}
                  </div>
                  {selectedUser?.status === "disabled" ? (
                    <div className="mt-2 space-y-1 text-sm">
                      <Badge variant="outline">Disabled</Badge>
                      <div className="text-muted-foreground">
                        {selectedUser.disabledAt
                          ? `Disabled on ${new Date(selectedUser.disabledAt).toLocaleDateString()}.`
                          : "Disabled."}{" "}
                        Cannot sign in or use API keys until enabled.
                      </div>
                      {selectedUser.disabledReason ? (
                        <div className="text-muted-foreground">Reason: {selectedUser.disabledReason}</div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant={selectedUser?.isInstanceAdmin ? "outline" : "default"}
                    onClick={() => setAdminMutation.mutate(!(selectedUser?.isInstanceAdmin ?? false))}
                    disabled={setAdminMutation.isPending}
                  >
                    {selectedUser?.isInstanceAdmin ? "Remove instance admin" : "Promote to instance admin"}
                  </Button>
                  {selectedUser && selectedUser.id !== accountUserId ? (
                    <>
                      {selectedUser.status === "disabled" ? (
                        <Button
                          variant="outline"
                          onClick={() => enableUserMutation.mutate()}
                          disabled={enableUserMutation.isPending}
                        >
                          {enableUserMutation.isPending ? "Enabling…" : "Enable user"}
                        </Button>
                      ) : (
                        <Button variant="outline" onClick={() => setPendingAccountAction("disable")}>
                          Disable user
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        className="text-destructive"
                        onClick={() => setPendingAccountAction("delete")}
                      >
                        Delete user
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <h2 className="text-sm font-semibold">Organization access</h2>
                  <p className="text-sm text-muted-foreground">
                    Toggle organization membership for this user. New access defaults to an active operator membership.
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {companies.map((company) => (
                    <label
                      key={company.id}
                      className="flex items-start gap-3 rounded-lg border border-border px-3 py-3"
                    >
                      <Checkbox
                        checked={selectedCompanyIds.has(company.id)}
                        onCheckedChange={(checked) => {
                          setSelectedCompanyIds((current) => {
                            const next = new Set(current);
                            if (checked) next.add(company.id);
                            else next.delete(company.id);
                            return next;
                          });
                        }}
                      />
                      <span className="space-y-1">
                        <span className="block text-sm font-medium">{company.name}</span>
                        <span className="block text-xs text-muted-foreground">{company.issuePrefix}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex justify-end">
                  <Button
                    onClick={() => updateCompanyAccessMutation.mutate()}
                    disabled={updateCompanyAccessMutation.isPending}
                  >
                    {updateCompanyAccessMutation.isPending ? "Saving…" : "Save organization access"}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <h2 className="text-sm font-semibold">Current memberships</h2>
                <div className="space-y-2">
                  {(userAccessQuery.data?.companyAccess ?? []).map((membership) => (
                    <div
                      key={membership.id}
                      className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
                    >
                      <div>
                        <div className="font-medium">{membership.companyName || membership.companyId}</div>
                        <div className="text-muted-foreground">
                          {membership.membershipRole || "unset"} • {membership.status}
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(membership.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </Card>
      </div>

      <AlertDialog
        open={pendingAccountAction === "disable"}
        onOpenChange={(open) => {
          if (!open && !disableUserMutation.isPending) setPendingAccountAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable {selectedUser?.name || selectedUser?.email || "user"}?</AlertDialogTitle>
            <AlertDialogDescription>
              They are signed out everywhere and cannot sign in, use board API keys, or use connected
              assistants until you enable the account again. Their organization memberships and history stay
              in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="block space-y-2 text-sm">
            <span className="font-medium">Reason (optional)</span>
            <Textarea
              value={disableReason}
              maxLength={INSTANCE_USER_DISABLE_REASON_MAX_LENGTH}
              onChange={(event) => setDisableReason(event.target.value)}
              placeholder="Visible to instance admins"
            />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disableUserMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={disableUserMutation.isPending || !selectedUserId}
              onClick={(event) => {
                event.preventDefault();
                disableUserMutation.mutate();
              }}
            >
              {disableUserMutation.isPending ? "Disabling…" : "Disable user"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingAccountAction === "delete"}
        onOpenChange={(open) => {
          if (!open && !deleteUserMutation.isPending) setPendingAccountAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedUser?.name || selectedUser?.email || "user"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the account, its sign-in methods, and its API keys. Accounts with
              organization history cannot be deleted; disable them instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteUserMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteUserMutation.isPending || !selectedUserId}
              onClick={(event) => {
                event.preventDefault();
                deleteUserMutation.mutate();
              }}
            >
              {deleteUserMutation.isPending ? "Deleting…" : "Delete user"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
