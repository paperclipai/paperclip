import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams, useNavigate, Link } from "@/lib/router";
import { userInvitesApi } from "../api/userInvites";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

export function UserInviteAcceptPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [tosAccepted, setTosAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inviteQuery = useQuery({
    queryKey: queryKeys.userInvites.detail(token ?? ""),
    queryFn: () => userInvitesApi.getByToken(token ?? ""),
    enabled: !!token,
    retry: false,
  });

  const acceptMutation = useMutation({
    mutationFn: () =>
      userInvitesApi.accept(token ?? "", {
        name: name.trim(),
        password,
        tosAccepted,
      }),
    onSuccess: () => {
      setError(null);
      navigate("/auth?next=/dashboard", { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to accept invite");
    },
  });

  if (!token) {
    return (
      <div className="mx-auto max-w-xl py-10 text-sm text-destructive">
        Invalid invite link.
      </div>
    );
  }

  if (inviteQuery.isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading invite...</p>
      </div>
    );
  }

  if (inviteQuery.error || !inviteQuery.data) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">Invite not available</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This invite may be expired, revoked, or already used.
          </p>
        </div>
      </div>
    );
  }

  const invite = inviteQuery.data;
  const canSubmit =
    name.trim().length > 0 &&
    password.length >= 8 &&
    tosAccepted &&
    !acceptMutation.isPending;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-md px-8 py-12">
        <div className="flex items-center gap-2 mb-8">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Ironworks</span>
        </div>

        <h1 className="text-xl font-semibold">Accept your invitation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You have been invited to join as a{" "}
          <span className="font-medium text-foreground">{invite.role}</span>.
          Set up your account to get started.
        </p>

        <form
          className="mt-6 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) acceptMutation.mutate();
          }}
        >
          <div>
            <label
              htmlFor="invite-email"
              className="text-xs text-muted-foreground mb-1 block"
            >
              Email
            </label>
            <input
              id="invite-email"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground cursor-not-allowed"
              type="email"
              value={invite.email}
              disabled
            />
          </div>

          <div>
            <label
              htmlFor="invite-name"
              className="text-xs text-muted-foreground mb-1 block"
            >
              Name
            </label>
            <input
              id="invite-name"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              autoFocus
            />
          </div>

          <div>
            <label
              htmlFor="invite-password"
              className="text-xs text-muted-foreground mb-1 block"
            >
              Password (min 8 characters)
            </label>
            <input
              id="invite-password"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={tosAccepted}
              onChange={(e) => setTosAccepted(e.target.checked)}
              className="mt-1 rounded border-border"
            />
            <span className="text-xs text-muted-foreground">
              I agree to the{" "}
              <a
                href="/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-foreground"
              >
                Terms of Service
              </a>{" "}
              and{" "}
              <a
                href="/aup"
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-foreground"
              >
                Acceptable Use Policy
              </a>
            </span>
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button
            type="submit"
            disabled={!canSubmit}
            className={`w-full ${!canSubmit ? "opacity-50" : ""}`}
          >
            {acceptMutation.isPending ? "Creating account..." : "Accept & Create Account"}
          </Button>
        </form>

        <div className="mt-5 text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            to="/auth"
            className="font-medium text-foreground underline underline-offset-2"
          >
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
