import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BoardApiKeySummary } from "@paperclipai/shared";
import { Copy, KeyRound, Plus, ShieldAlert, Trash2 } from "lucide-react";
import { boardApiKeysApi } from "@/api/boardApiKeys";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";

const EXPIRY_OPTIONS = [
  { label: "Never", value: null },
  { label: "30 days", value: 30 },
  { label: "90 days", value: 90 },
  { label: "1 year", value: 365 },
] as const;

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function InstanceApiKeys() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<BoardApiKeySummary | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyExpiry, setNewKeyExpiry] = useState<number | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "API Keys" }]);
  }, [setBreadcrumbs]);

  const keysQuery = useQuery({
    queryKey: queryKeys.boardApiKeys.list,
    queryFn: () => boardApiKeysApi.list(),
  });

  const generalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });

  const enabled = generalSettingsQuery.data?.boardApiKeysEnabled ?? false;

  const createMutation = useMutation({
    mutationFn: ({ name, expiresInDays }: { name: string; expiresInDays: number | null }) =>
      boardApiKeysApi.create(name, expiresInDays),
    onSuccess: (data) => {
      setCreatedToken(data.token);
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.boardApiKeys.list });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to create API key.");
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => boardApiKeysApi.revoke(id),
    onSuccess: () => {
      setRevokeTarget(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.boardApiKeys.list });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to revoke API key.");
    },
  });

  function handleCreate() {
    if (!newKeyName.trim()) return;
    createMutation.mutate({ name: newKeyName.trim(), expiresInDays: newKeyExpiry });
  }

  function handleCloseCreate() {
    setCreateOpen(false);
    setCreatedToken(null);
    setNewKeyName("");
    setNewKeyExpiry(null);
    setCopied(false);
    setError(null);
  }

  async function handleCopy() {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const textarea = document.createElement("textarea");
      textarea.value = createdToken;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const keys = keysQuery.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">API Keys</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Create API keys to access the Paperclip API from external services.
            Keys inherit your permissions and company access.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          disabled={!enabled}
          title={enabled ? undefined : "Board API keys are disabled in instance general settings"}
        >
          <Plus className="h-4 w-4 mr-1" />
          Create key
        </Button>
      </div>

      {!enabled && !generalSettingsQuery.isLoading && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm flex gap-3">
          <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-amber-900 dark:text-amber-100">
              Board API keys are disabled
            </p>
            <p className="text-amber-800 dark:text-amber-200 mt-0.5">
              Creation is blocked and existing keys cannot authenticate. Enable the
              <span className="font-mono"> Board API keys </span>
              toggle in Instance Settings &rarr; General to turn this feature on. Existing
              keys shown below can still be revoked for cleanup.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {keysQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : keys.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <KeyRound className="mx-auto h-8 w-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">No API keys yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Create a key to start making API calls.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border">
          {keys.map((key) => (
            <div key={key.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium truncate">{key.name}</span>
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>Created {formatDate(key.createdAt)}</span>
                  <span>Last used {relativeTime(key.lastUsedAt)}</span>
                  <span>Expires {formatDate(key.expiresAt)}</span>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive shrink-0"
                onClick={() => setRevokeTarget(key)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) handleCloseCreate(); }}>
        <DialogContent>
          {createdToken ? (
            <>
              <DialogHeader>
                <DialogTitle>API key created</DialogTitle>
                <DialogDescription>
                  Copy this token now. You won't be able to see it again.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs font-mono break-all select-all">
                  {createdToken}
                </code>
                <Button variant="outline" size="sm" onClick={handleCopy} className="shrink-0">
                  <Copy className="h-4 w-4 mr-1" />
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={handleCloseCreate}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create API key</DialogTitle>
                <DialogDescription>
                  The key will have the same permissions as your account.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="key-name" className="text-sm font-medium">
                    Name
                  </label>
                  <Input
                    id="key-name"
                    placeholder="e.g. CI pipeline, monitoring service"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                    maxLength={120}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && newKeyName.trim()) handleCreate();
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="key-expiry" className="text-sm font-medium">
                    Expiration
                  </label>
                  <select
                    id="key-expiry"
                    className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={newKeyExpiry ?? ""}
                    onChange={(e) =>
                      setNewKeyExpiry(e.target.value === "" ? null : Number(e.target.value))
                    }
                  >
                    {EXPIRY_OPTIONS.map((opt) => (
                      <option key={opt.label} value={opt.value ?? ""}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={handleCloseCreate}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={!newKeyName.trim() || createMutation.isPending}
                >
                  {createMutation.isPending ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation dialog */}
      <Dialog open={!!revokeTarget} onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key</DialogTitle>
            <DialogDescription>
              Are you sure you want to revoke <strong>{revokeTarget?.name}</strong>?
              Any service using this key will immediately lose access.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
              disabled={revokeMutation.isPending}
            >
              {revokeMutation.isPending ? "Revoking..." : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
