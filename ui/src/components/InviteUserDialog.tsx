import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { userInvitesApi, type UserInviteCreated, type UserInviteRecord } from "../api/userInvites";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Copy, Check, UserPlus, X, Clock, RotateCcw } from "lucide-react";
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
  const [multiMode, setMultiMode] = useState(false);
  const [multiEmails, setMultiEmails] = useState("");
  const [role, setRole] = useState<MembershipRole>("member");
  const [lastCreated, setLastCreated] = useState<UserInviteCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [multiResults, setMultiResults] = useState<{ email: string; ok: boolean; error?: string }[]>([]);
  const [isSendingMulti, setIsSendingMulti] = useState(false);

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

  const resendMutation = useMutation({
    mutationFn: (invite: UserInviteRecord) =>
      userInvitesApi.create(selectedCompanyId!, { email: invite.email, role: invite.role as MembershipRole }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.userInvites.list(selectedCompanyId!),
      });
      pushToast({ title: "Invite resent", tone: "success" });
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
          onSubmit={async (e) => {
            e.preventDefault();
            if (multiMode) {
              // Multi-invite mode
              const emails = multiEmails
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && line.includes("@"));
              if (emails.length === 0) return;
              setIsSendingMulti(true);
              setMultiResults([]);
              const results: { email: string; ok: boolean; error?: string }[] = [];
              for (const addr of emails) {
                try {
                  await userInvitesApi.create(selectedCompanyId!, { email: addr, role });
                  results.push({ email: addr, ok: true });
                } catch (err) {
                  results.push({
                    email: addr,
                    ok: false,
                    error: err instanceof Error ? err.message : "Failed",
                  });
                }
              }
              setMultiResults(results);
              setIsSendingMulti(false);
              queryClient.invalidateQueries({
                queryKey: queryKeys.userInvites.list(selectedCompanyId!),
              });
              const successCount = results.filter((r) => r.ok).length;
              if (successCount > 0) {
                pushToast({ title: `${successCount} invite(s) created`, tone: "success" });
                setMultiEmails("");
              }
            } else {
              if (email.trim() && !createMutation.isPending) {
                setLastCreated(null);
                createMutation.mutate();
              }
            }
          }}
        >
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="invite-email" className="text-xs text-muted-foreground">
              {multiMode ? "Email addresses (one per line)" : "Email address"}
            </label>
            <button
              type="button"
              onClick={() => { setMultiMode(!multiMode); setMultiResults([]); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {multiMode ? "Single invite" : "Invite multiple"}
            </button>
          </div>

          <div>
            {multiMode ? (
              <textarea
                id="invite-email"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 placeholder:text-muted-foreground/50"
                placeholder={"user1@example.com\nuser2@example.com\nuser3@example.com"}
                rows={4}
                value={multiEmails}
                onChange={(e) => setMultiEmails(e.target.value)}
                autoFocus
              />
            ) : (
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
            )}
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
            disabled={
              multiMode
                ? isSendingMulti || !multiEmails.trim()
                : !email.trim() || createMutation.isPending
            }
            className="w-full"
          >
            {multiMode
              ? isSendingMulti
                ? "Sending invites..."
                : `Send ${multiEmails.split("\n").filter((l) => l.trim().includes("@")).length || 0} Invite(s)`
              : createMutation.isPending
                ? "Creating..."
                : "Send Invite"}
          </Button>
        </form>

        {multiResults.length > 0 && (
          <div className="mt-3 space-y-1 rounded-md border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground mb-2">Multi-invite results</p>
            {multiResults.map((r) => (
              <div key={r.email} className="flex items-center gap-2 text-xs">
                {r.ok ? (
                  <Check className="h-3 w-3 text-green-500 shrink-0" />
                ) : (
                  <X className="h-3 w-3 text-destructive shrink-0" />
                )}
                <span className={r.ok ? "text-foreground" : "text-destructive"}>{r.email}</span>
                {r.error && <span className="text-muted-foreground">- {r.error}</span>}
              </div>
            ))}
          </div>
        )}

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
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => resendMutation.mutate(inv)}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      disabled={resendMutation.isPending}
                      title="Resend invite"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
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
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
