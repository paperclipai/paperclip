import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { userInvitesApi, type UserInviteCreated, type UserInviteRecord } from "../api/userInvites";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Copy, Check, UserPlus, X, Clock } from "lucide-react";
import type { MembershipRole } from "@ironworksai/shared";

const ROLE_OPTIONS: { value: MembershipRole; label: string; description: string }[] = [
  { value: "owner", label: "Owner", description: "Full access including billing" },
  { value: "admin", label: "Admin", description: "Everything except billing" },
  { value: "member", label: "Member", description: "Create issues, edit KB, comment" },
  { value: "viewer", label: "Viewer", description: "Read-only, can comment" },
];

function dateTimeRelative(value: string) {
  const date = new Date(value);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  if (diffMs < 0) return "Expired";
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return `${hours}h`;
}

export function InviteUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MembershipRole>("member");
  const [lastCreated, setLastCreated] = useState<UserInviteCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existingInvites = useQuery({
    queryKey: queryKeys.userInvites.list(selectedCompanyId ?? ""),
    queryFn: () => userInvitesApi.list(selectedCompanyId!),
    enabled: open && !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      userInvitesApi.create(selectedCompanyId!, { email: email.trim(), role }),
    onSuccess: (created) => {
      setError(null);
      setLastCreated(created);
      setEmail("");
      queryClient.invalidateQueries({
        queryKey: queryKeys.userInvites.list(selectedCompanyId!),
      });
      pushToast({ title: "Invite created", tone: "success" });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to create invite");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (inviteId: string) =>
      userInvitesApi.revoke(selectedCompanyId!, inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.userInvites.list(selectedCompanyId!),
      });
      pushToast({ title: "Invite revoked", tone: "success" });
    },
  });

  function handleCopy() {
    if (!lastCreated) return;
    navigator.clipboard.writeText(lastCreated.inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const pendingInvites = (existingInvites.data ?? []).filter(
    (inv: UserInviteRecord) => !inv.acceptedAt && !inv.revokedAt && new Date(inv.expiresAt) > new Date(),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Invite User
          </DialogTitle>
          <DialogDescription>
            Invite a user to join this company. They will receive a link to set up their account.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4 mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim() && !createMutation.isPending) {
              setLastCreated(null);
              createMutation.mutate();
            }
          }}
        >
          <div>
            <label htmlFor="invite-email" className="text-xs text-muted-foreground mb-1 block">
              Email address
            </label>
            <input
              id="invite-email"
              type="email"
              inputMode="email"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 placeholder:text-muted-foreground/50"
              placeholder="user@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Role</label>
            <div className="grid grid-cols-2 gap-2">
              {ROLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setRole(opt.value)}
                  className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                    role === opt.value
                      ? "border-foreground bg-foreground/5"
                      : "border-border hover:border-foreground/30"
                  }`}
                >
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-xs text-muted-foreground">{opt.description}</div>
                </button>
              ))}
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button
            type="submit"
            disabled={!email.trim() || createMutation.isPending}
            className="w-full"
          >
            {createMutation.isPending ? "Creating..." : "Send Invite"}
          </Button>
        </form>

        {lastCreated && (
          <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground mb-1">Invite link (share this URL):</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-muted-foreground break-all">{lastCreated.inviteUrl}</code>
              <Button variant="ghost" size="icon-sm" onClick={handleCopy}>
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Expires: {new Date(lastCreated.expiresAt).toLocaleString()}
            </p>
          </div>
        )}

        {pendingInvites.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-medium text-muted-foreground mb-2">Pending invites</h3>
            <div className="space-y-1">
              {pendingInvites.map((inv: UserInviteRecord) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-foreground">{inv.email}</span>
                    <span className="text-muted-foreground capitalize">{inv.role}</span>
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {dateTimeRelative(inv.expiresAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => revokeMutation.mutate(inv.id)}
                    className="text-muted-foreground hover:text-destructive transition-colors"
                    disabled={revokeMutation.isPending}
                    title="Revoke invite"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
