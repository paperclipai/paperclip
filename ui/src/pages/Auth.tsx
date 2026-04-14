import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

  const nextPath = useMemo(
    () => searchParams.get("next") || "/",
    [searchParams],
  );
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
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all,
      });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (mode === "sign_in" ||
      (name.trim().length > 0 && password.trim().length >= 8));

  if (isSessionLoading) {
    return (
      <main className="flex h-full items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 flex bg-background">
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Paperclip</span>
          </div>

          <div className="bg-card rounded-xl shadow-sm border border-border p-8">
            <h1 className="text-xl font-bold tracking-tight">
              {mode === "sign_in"
                ? "Sign in to Paperclip"
                : "Create your account"}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {mode === "sign_in"
                ? "Sign in to manage your agents"
                : "Create your account to get started"}
            </p>

            <form
              className="mt-6 space-y-4"
              method="post"
              action={
                mode === "sign_up"
                  ? "/api/auth/sign-up/email"
                  : "/api/auth/sign-in/email"
              }
              onSubmit={(event) => {
                event.preventDefault();
                if (mutation.isPending) return;
                if (!canSubmit) {
                  setError("Please fill in all required fields.");
                  return;
                }
                mutation.mutate();
              }}
            >
              {mode === "sign_up" && (
                <div>
                  <Label
                    htmlFor="name"
                    className="text-sm font-medium mb-1.5 block"
                  >
                    Name
                  </Label>
                  <Input
                    id="name"
                    name="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    autoComplete="name"
                    autoFocus
                    aria-describedby={error ? "auth-error" : undefined}
                  />
                </div>
              )}
              <div>
                <Label
                  htmlFor="email"
                  className="text-sm font-medium mb-1.5 block"
                >
                  Email
                </Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  autoFocus={mode === "sign_in"}
                  aria-describedby={error ? "auth-error" : undefined}
                />
              </div>
              <div>
                <Label
                  htmlFor="password"
                  className="text-sm font-medium mb-1.5 block"
                >
                  Password
                </Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={
                    mode === "sign_in" ? "current-password" : "new-password"
                  }
                  aria-describedby={error ? "auth-error" : undefined}
                />
                {mode === "sign_up" && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Minimum 8 characters
                  </p>
                )}
              </div>
              {error && (
                <p
                  id="auth-error"
                  className="text-xs text-destructive"
                  role="alert"
                >
                  {error}
                </p>
              )}
              <Button
                type="submit"
                disabled={!canSubmit || mutation.isPending}
                className="w-full"
              >
                {mutation.isPending
                  ? "Working…"
                  : mode === "sign_in"
                    ? "Sign In"
                    : "Create Account"}
              </Button>
            </form>

            <div className="mt-5 text-sm text-muted-foreground">
              {mode === "sign_in"
                ? "Need an account?"
                : "Already have an account?"}{" "}
              <button
                type="button"
                className="font-medium text-primary hover:text-primary/80 underline underline-offset-2"
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

      {/* Right half — ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </main>
  );
}
