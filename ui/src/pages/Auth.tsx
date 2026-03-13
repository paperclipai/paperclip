import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { usersApi } from "../api/users";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Sparkles } from "lucide-react";

type AuthMode = "sign_in" | "sign_up" | "forgot";

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [forgotSent, setForgotSent] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);

  const nextPath = useMemo(() => searchParams.get("next") || "/", [searchParams]);
  const resetToken = useMemo(() => searchParams.get("token") || "", [searchParams]);
  const urlMode = useMemo(() => searchParams.get("mode") || "", [searchParams]);

  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  // Set default mode based on hasUsers
  useEffect(() => {
    if (urlMode === "reset" && resetToken) return;
    if (health && health.hasUsers === false) {
      setMode("sign_up");
    }
  }, [health, urlMode, resetToken]);

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

  const forgotMutation = useMutation({
    mutationFn: () => usersApi.forgotPassword(email.trim()),
    onSuccess: () => {
      setError(null);
      setForgotSent(true);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to send reset link");
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => usersApi.resetPassword(resetToken, newPassword),
    onSuccess: () => {
      setError(null);
      setResetSuccess(true);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    },
  });

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length >= 8 &&
    (mode === "sign_in" || name.trim().length > 0);

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  // Password reset via token
  if (urlMode === "reset" && resetToken) {
    return (
      <div className="fixed inset-0 flex bg-background">
        <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
          <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
            <div className="flex items-center gap-2 mb-8">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Paperclip</span>
            </div>

            {resetSuccess ? (
              <>
                <h1 className="text-xl font-semibold">Password reset</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your password has been updated. You can now sign in.
                </p>
                <Button className="mt-4" onClick={() => navigate("/auth", { replace: true })}>
                  Sign In
                </Button>
              </>
            ) : (
              <>
                <h1 className="text-xl font-semibold">Set a new password</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Enter your new password below.
                </p>
                <form
                  className="mt-6 space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    resetMutation.mutate();
                  }}
                >
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">New Password</label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      type="password"
                      value={newPassword}
                      onChange={(event) => setNewPassword(event.target.value)}
                      autoComplete="new-password"
                      autoFocus
                    />
                  </div>
                  {error && <p className="text-xs text-destructive">{error}</p>}
                  <Button
                    type="submit"
                    disabled={newPassword.length < 8 || resetMutation.isPending}
                    className="w-full"
                  >
                    {resetMutation.isPending ? "Resetting…" : "Reset Password"}
                  </Button>
                </form>
              </>
            )}
          </div>
        </div>
        <div className="hidden md:block w-1/2 overflow-hidden">
          <AsciiArtAnimation />
        </div>
      </div>
    );
  }

  const hasUsers = health?.hasUsers !== false;

  return (
    <div className="fixed inset-0 flex bg-background">
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Paperclip</span>
          </div>

          {mode === "forgot" ? (
            <>
              <h1 className="text-xl font-semibold">Reset your password</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Enter your email and we'll send you a reset link.
              </p>

              {forgotSent ? (
                <div className="mt-6 space-y-4">
                  <p className="text-sm text-muted-foreground">
                    If an account exists with that email, a reset link has been sent. Check your inbox.
                  </p>
                  <button
                    type="button"
                    className="text-sm font-medium text-foreground underline underline-offset-2"
                    onClick={() => {
                      setError(null);
                      setForgotSent(false);
                      setMode("sign_in");
                    }}
                  >
                    Back to sign in
                  </button>
                </div>
              ) : (
                <form
                  className="mt-6 space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    forgotMutation.mutate();
                  }}
                >
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Email</label>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      autoComplete="email"
                      autoFocus
                    />
                  </div>
                  {error && <p className="text-xs text-destructive">{error}</p>}
                  <Button
                    type="submit"
                    disabled={email.trim().length === 0 || forgotMutation.isPending}
                    className="w-full"
                  >
                    {forgotMutation.isPending ? "Sending…" : "Send Reset Link"}
                  </Button>
                </form>
              )}

              {!forgotSent && (
                <div className="mt-5 text-sm text-muted-foreground">
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-2"
                    onClick={() => {
                      setError(null);
                      setMode("sign_in");
                    }}
                  >
                    Back to sign in
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">
                {!hasUsers
                  ? "Welcome to Paperclip"
                  : mode === "sign_in"
                    ? "Sign in to Paperclip"
                    : "Create your Paperclip account"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {!hasUsers
                  ? "Create the first account to get started."
                  : mode === "sign_in"
                    ? "Use your email and password to access this instance."
                    : "Create an account for this instance."}
              </p>

              <form
                className="mt-6 space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  mutation.mutate();
                }}
              >
                {(mode === "sign_up" || !hasUsers) && (
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">Name</label>
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
                  <label className="text-xs text-muted-foreground mb-1 block">Email</label>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    autoFocus={mode === "sign_in" && hasUsers}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Password</label>
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

              <div className="mt-5 space-y-2 text-sm text-muted-foreground">
                <div>
                  {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
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
                {hasUsers && mode === "sign_in" && (
                  <div>
                    <button
                      type="button"
                      className="font-medium text-foreground underline underline-offset-2"
                      onClick={() => {
                        setError(null);
                        setMode("forgot");
                      }}
                    >
                      Forgot password?
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right half — ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
