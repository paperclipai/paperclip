import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import { authApi } from "@/api/auth";
import { isPasskeyOriginCurrent, passkeyErrorMessage } from "@/lib/passkeys";
import { queryKeys } from "@/lib/queryKeys";
import { formatDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PasskeySettings() {
  const queryClient = useQueryClient();
  const nameId = useId();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const signInOptionsQuery = useQuery({
    queryKey: queryKeys.auth.signInOptions,
    queryFn: () => authApi.getSignInOptions(),
    retry: false,
  });
  const passkeyOrigin = signInOptionsQuery.data?.passkeyOrigin ?? null;
  const passkeysEnabled = isPasskeyOriginCurrent(passkeyOrigin);
  const passkeysQuery = useQuery({
    queryKey: queryKeys.auth.passkeys,
    queryFn: () => authApi.listPasskeys(),
    retry: false,
    enabled: passkeysEnabled,
  });

  const addMutation = useMutation({
    mutationFn: () => authApi.addPasskey({ name: name.trim() || "Passkey" }),
    onSuccess: async () => {
      setAdding(false);
      setName("");
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.passkeys });
    },
    onError: (err) => {
      setError(passkeyErrorMessage(err, "Could not add the passkey"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => authApi.deletePasskey(id),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.passkeys });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Could not remove the passkey");
    },
  });

  if (signInOptionsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading passkey settings…</div>;
  }
  if (signInOptionsQuery.error) {
    return <div className="text-sm text-destructive">Failed to load passkey settings.</div>;
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Passkeys</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          {passkeysEnabled ? (
            "Sign in with your fingerprint, face, device PIN, or a security key instead of a password."
          ) : passkeyOrigin ? (
            <>
              Passkeys work only at{" "}
              <a className="font-medium text-foreground underline underline-offset-2" href={passkeyOrigin}>
                {passkeyOrigin}
              </a>
              . Open Paperclip there to add or use one.
            </>
          ) : (
            "Passkeys are not available on this instance. An operator must set a public HTTPS URL for it."
          )}
        </p>
      </div>

      {passkeysEnabled ? (
        <>
          {passkeysQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading passkeys…</div>
          ) : passkeysQuery.error ? (
            <div className="text-sm text-destructive">Failed to load passkeys.</div>
          ) : passkeysQuery.data && passkeysQuery.data.length > 0 ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {passkeysQuery.data.map((passkey) => (
                <li key={passkey.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{passkey.name ?? "Passkey"}</div>
                    {passkey.createdAt ? (
                      <div className="text-xs text-muted-foreground">Added {formatDate(passkey.createdAt)}</div>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${passkey.name ?? "passkey"}`}
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(passkey.id)}
                  >
                    <Trash2 className="size-4" />
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">You have no passkeys yet.</p>
          )}

          {adding ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (addMutation.isPending) return;
                setError(null);
                addMutation.mutate();
              }}
            >
              <div className="max-w-xs space-y-2">
                <Label htmlFor={nameId}>Passkey name</Label>
                <Input
                  id={nameId}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Work laptop"
                  maxLength={80}
                  autoFocus
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setAdding(false);
                    setError(null);
                  }}
                  disabled={addMutation.isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={addMutation.isPending}>
                  {addMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
                  Create passkey
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" variant="outline" onClick={() => setAdding(true)}>
              Add a passkey
            </Button>
          )}
        </>
      ) : null}

      {error ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
