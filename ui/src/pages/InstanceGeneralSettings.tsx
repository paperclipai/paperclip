import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SlidersHorizontal, Users, KeyRound } from "lucide-react";
import { instanceSettingsApi, type InstanceUser } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";

export function InstanceGeneralSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "General" },
    ]);
  }, [setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) =>
      instanceSettingsApi.updateGeneral({ censorUsernameInLogs: enabled }),
    onSuccess: async () => {
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  if (generalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading general settings...</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : "Failed to load general settings."}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">General</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Configure instance-wide defaults that affect how operator-visible logs are displayed.
        </p>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">Censor username in logs</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Hide the username segment in home-directory paths and similar operator-visible log output. Standalone
              username mentions outside of paths are not yet masked in the live transcript view. This is off by
              default.
            </p>
          </div>
          <button
            type="button"
            data-slot="toggle"
            aria-label="Toggle username log censoring"
            disabled={toggleMutation.isPending}
            className={cn(
              "relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              censorUsernameInLogs ? "bg-green-600" : "bg-muted",
            )}
            onClick={() => toggleMutation.mutate(!censorUsernameInLogs)}
          >
            <span
              className={cn(
                "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                censorUsernameInLogs ? "translate-x-4.5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </section>

      <UserManagementSection />
    </div>
  );
}

function UserManagementSection() {
  const usersQuery = useQuery({
    queryKey: ["instance", "users"],
    queryFn: () => instanceSettingsApi.listUsers(),
  });

  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetSuccess, setResetSuccess] = useState<string | null>(null);

  const resetMutation = useMutation({
    mutationFn: async () => {
      if (!resetUserId) throw new Error("No user selected");
      await instanceSettingsApi.resetUserPassword(resetUserId, newPassword);
    },
    onSuccess: () => {
      const user = usersQuery.data?.find((u) => u.id === resetUserId);
      setResetSuccess(`Password reset for ${user?.email ?? "user"}.`);
      setResetError(null);
      setNewPassword("");
      setResetUserId(null);
    },
    onError: (err) => {
      setResetError(err instanceof Error ? err.message : "Failed to reset password");
      setResetSuccess(null);
    },
  });

  if (usersQuery.isLoading) return null;
  if (usersQuery.error || !usersQuery.data?.length) return null;

  return (
    <>
      <div className="space-y-2 pt-4">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">User Management</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Reset passwords for board users. Useful for self-hosted deployments without email configured.
        </p>
      </div>

      {resetSuccess && (
        <div className="rounded-md border border-green-600/40 bg-green-600/5 px-3 py-2 text-sm text-green-700 dark:text-green-400">
          {resetSuccess}
        </div>
      )}
      {resetError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {resetError}
        </div>
      )}

      <section className="rounded-xl border border-border bg-card p-5">
        <div className="space-y-3">
          {usersQuery.data.map((user: InstanceUser) => (
            <div key={user.id} className="flex items-center justify-between gap-4 py-1.5">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{user.name}</p>
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              </div>
              {resetUserId === user.id ? (
                <div className="flex items-center gap-2">
                  <input
                    className="w-48 rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
                    type="password"
                    placeholder="New password (8+ chars)"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoFocus
                  />
                  <Button
                    size="sm"
                    disabled={resetMutation.isPending || newPassword.length < 8}
                    onClick={() => resetMutation.mutate()}
                  >
                    {resetMutation.isPending ? "…" : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { setResetUserId(null); setNewPassword(""); setResetError(null); }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setResetUserId(user.id); setNewPassword(""); setResetError(null); setResetSuccess(null); }}
                >
                  <KeyRound className="h-3.5 w-3.5 mr-1.5" />
                  Reset Password
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
