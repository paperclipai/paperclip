import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Sparkles } from "lucide-react";

type AuthMode = "sign_in" | "sign_up" | "forgot_password";

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [resetRequested, setResetRequested] = useState(false);

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
      if (mode === "forgot_password") {
        await authApi.requestPasswordReset(email.trim());
        return;
      }
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
      if (mode === "forgot_password") {
        setResetRequested(true);
        return;
      }
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
    (mode === "forgot_password" ||
      (password.trim().length >= 8 && (mode === "sign_in" || name.trim().length > 0)));

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Paperclip</span>
          </div>

          <h1 className="text-xl font-semibold">
            {mode === "sign_in"
              ? "Sign in to Paperclip"
              : mode === "sign_up"
                ? "Create your Paperclip account"
                : "Reset your password"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "sign_in"
              ? "Use your email and password to access this instance."
              : mode === "sign_up"
                ? "Create an account for this instance. Email confirmation is not required in v1."
                : "Enter your email and a reset link will be printed to the server logs."}
          </p>

          {mode === "forgot_password" && resetRequested ? (
            <div className="mt-6 rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Check your server logs</p>
              <p className="mt-1">A password reset URL has been printed to the Paperclip server console. Open that URL to set a new password.</p>
              <button
                type="button"
                className="mt-4 font-medium text-foreground underline underline-offset-2 text-sm"
                onClick={() => {
                  setResetRequested(false);
                  setError(null);
                  setMode("sign_in");
                }}
              >
                Back to sign in
              </button>
            </div>
          ) : (
            <>
              <form
                className="mt-6 space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  mutation.mutate();
                }}
              >
                {mode === "sign_up" && (
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
                    autoFocus={mode === "sign_in" || mode === "forgot_password"}
                  />
                </div>
                {mode !== "forgot_password" && (
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs text-muted-foreground">Password</label>
                      {mode === "sign_in" && (
                        <button
                          type="button"
                          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                          onClick={() => {
                            setError(null);
                            setResetRequested(false);
                            setMode("forgot_password");
                          }}
                        >
                          Forgot password?
                        </button>
                      )}
                    </div>
                    <input
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                    />
                  </div>
                )}
                {error && <p className="text-xs text-destructive">{error}</p>}
                <Button type="submit" disabled={!canSubmit || mutation.isPending} className="w-full">
                  {mutation.isPending
                    ? "Working…"
                    : mode === "sign_in"
                      ? "Sign In"
                      : mode === "sign_up"
                        ? "Create Account"
                        : "Send Reset Link"}
                </Button>
              </form>

              <div className="mt-5 text-sm text-muted-foreground">
                {mode === "forgot_password" ? (
                  <>
                    Remember your password?{" "}
                    <button
                      type="button"
                      className="font-medium text-foreground underline underline-offset-2"
                      onClick={() => {
                        setError(null);
                        setResetRequested(false);
                        setMode("sign_in");
                      }}
                    >
                      Sign in
                    </button>
                  </>
                ) : (
                  <>
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
                  </>
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
