import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Sparkles } from "lucide-react";

type AuthMode = "sign_in" | "sign_up";

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const nextPath = useMemo(() => searchParams.get("next") || "/", [searchParams]);
  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    if (session) {
      navigate(nextPath, { replace: true });
    }
  }, [session, navigate, nextPath]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length >= 8 &&
    (mode === "sign_in" || name.trim().length > 0);

  if (isSessionLoading) {
    return (
      <div className="paperclip-edge-shell items-center justify-center p-6">
        <div className="paperclip-edge-card w-full max-w-md px-6 py-8 text-center">
          <p className="paperclip-edge-kicker">Paperclip Access</p>
          <p className="mt-4 text-sm text-muted-foreground">Loading authentication challenge…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="paperclip-edge-shell">
      {/* Keep auth action-focused while still framing the board as an operator console. */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="mx-auto my-auto w-full max-w-xl px-6 py-10 md:px-8">
          <div className="paperclip-edge-card px-6 py-7 sm:px-8 sm:py-9">
            <div className="flex items-center gap-2 mb-8">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="paperclip-edge-kicker">Paperclip Access</span>
            </div>

            <div className="space-y-3">
              <h1 className="paperclip-edge-title">
                {mode === "sign_in" ? "Sign in to the board" : "Create your Paperclip account"}
              </h1>
              <p className="text-sm leading-6 text-muted-foreground">
                {mode === "sign_in"
                  ? "Authenticate with your operator credentials to access this instance."
                  : "Create an account for this instance. Email confirmation is not required in v1."}
              </p>
            </div>

            <form
              className="mt-8 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                mutation.mutate();
              }}
            >
              {mode === "sign_up" && (
                <div>
                  <label className="paperclip-gov-label mb-1.5 block">Name</label>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                    autoFocus
                  />
                </div>
              )}
              <div>
                <label className="paperclip-gov-label mb-1.5 block">Email</label>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  autoFocus={mode === "sign_in"}
                />
              </div>
              <div>
                <label className="paperclip-gov-label mb-1.5 block">Password</label>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button type="submit" disabled={!canSubmit || mutation.isPending} className="w-full">
                {mutation.isPending
                  ? "Working…"
                  : mode === "sign_in"
                    ? "Sign In"
                    : "Create Account"}
              </Button>
            </form>

            <div className="mt-6 flex items-center justify-between gap-3 border-t border-border/70 pt-5 text-sm text-muted-foreground">
              <span>{mode === "sign_in" ? "Need an account?" : "Already have an account?"}</span>
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => {
                  setError(null);
                  setMode(mode === "sign_in" ? "sign_up" : "sign_in");
                }}
              >
                {mode === "sign_in" ? "Create one" : "Sign in"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* The companion panel keeps the operator-console framing visible during auth. */}
      <div className="hidden md:flex md:w-1/2 md:flex-col md:overflow-hidden">
        <div className="paperclip-edge-panel flex h-full flex-col justify-between px-8 py-10">
          <div className="max-w-lg space-y-4">
            <p className="paperclip-edge-kicker">Operator Console</p>
            <h2 className="paperclip-edge-title text-4xl">Coordinate the company from one board.</h2>
            <p className="text-sm leading-6 text-muted-foreground">
              Track agents, approvals, runs, and task movement in a single command surface tuned for fast decisions.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="paperclip-gov-stat px-4 py-3">
                <p className="paperclip-gov-label">Live Runs</p>
                <p className="mt-2 text-sm font-semibold">Execution and queue state</p>
              </div>
              <div className="paperclip-gov-stat px-4 py-3">
                <p className="paperclip-gov-label">Governance</p>
                <p className="mt-2 text-sm font-semibold">Approvals, hiring, settings</p>
              </div>
            </div>
          </div>
          <div className="mt-8 overflow-hidden rounded-[1.5rem] border border-border/70">
            <AsciiArtAnimation />
          </div>
        </div>
      </div>
    </div>
  );
}
