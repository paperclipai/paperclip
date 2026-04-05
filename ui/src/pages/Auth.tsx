import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Hammer, Eye, EyeOff } from "lucide-react";
import { usePageTitle } from "../hooks/usePageTitle";

type AuthMode = "sign_in" | "sign_up";

/* ── Password strength scoring ── */

function scorePassword(pw: string): { score: 0 | 1 | 2 | 3; label: string; color: string } {
  if (!pw || pw.length === 0) return { score: 0, label: "", color: "transparent" };
  let points = 0;
  if (pw.length >= 8) points++;
  if (pw.length >= 12) points++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) points++;
  if (/\d/.test(pw)) points++;
  if (/[^a-zA-Z0-9]/.test(pw)) points++;

  if (points <= 1) return { score: 1, label: "Weak", color: "oklch(0.63 0.24 25)" };
  if (points <= 3) return { score: 2, label: "Fair", color: "oklch(0.75 0.18 80)" };
  return { score: 3, label: "Strong", color: "oklch(0.60 0.19 145)" };
}

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tosAccepted, setTosAccepted] = useState(false);

  const firstInputRef = useRef<HTMLInputElement>(null);

  // Set page title based on mode
  usePageTitle(mode === "sign_in" ? "Sign In" : "Sign Up");

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

  // Auto-focus first input when mode changes
  useEffect(() => {
    const timer = setTimeout(() => {
      firstInputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [mode]);

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
    password.trim().length > 0 &&
    (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8 && tosAccepted));

  const passwordStrength = scorePassword(password);

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      {/* Left half - form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Hammer className="h-4 w-4 text-blue-500" aria-hidden="true" />
            <span className="text-sm font-medium">Ironworks</span>
          </div>

          <h1 className="text-xl font-semibold">
            {mode === "sign_in" ? "Sign in to Ironworks" : "Create your Ironworks account"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "sign_in"
              ? "Use your email and password to access this instance."
              : "Create an account for this instance. Email confirmation is not required in v1."}
          </p>

          <form
            className="mt-6 space-y-4"
            method="post"
            action={mode === "sign_up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email"}
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
                <label htmlFor="name" className="text-xs text-muted-foreground mb-1 block">Name</label>
                <Input
                  id="name"
                  name="name"
                  ref={mode === "sign_up" ? firstInputRef : undefined}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  autoFocus
                />
              </div>
            )}
            <div>
              <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">Email</label>
              <Input
                id="email"
                name="email"
                type="email"
                inputMode="email"
                ref={mode === "sign_in" ? firstInputRef : undefined}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                autoFocus={mode === "sign_in"}
              />
            </div>
            <div>
              <label htmlFor="password" className="text-xs text-muted-foreground mb-1 block">Password</label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                  className="pr-10"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>

              {/* Password strength meter (sign-up only) */}
              {mode === "sign_up" && password.length > 0 && (
                <div className="mt-2 space-y-1">
                  <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="password-strength-bar h-full"
                      style={{
                        width: `${(passwordStrength.score / 3) * 100}%`,
                        backgroundColor: passwordStrength.color,
                      }}
                    />
                  </div>
                  <p className="text-[11px]" style={{ color: passwordStrength.color }}>
                    {passwordStrength.label}
                  </p>
                </div>
              )}

              {/* Forgot password link (sign-in only) */}
              {mode === "sign_in" && (
                <div className="mt-1.5">
                  <Link
                    to="/auth/forgot-password"
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                  >
                    Forgot password?
                  </Link>
                </div>
              )}
            </div>
            {mode === "sign_up" && (
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
            )}

            {/* Inline error message */}
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p role="alert" className="text-xs text-destructive">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              disabled={mutation.isPending}
              aria-disabled={!canSubmit || mutation.isPending}
              className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
            >
              {mutation.isPending
                ? "Working..."
                : mode === "sign_in"
                  ? "Sign In"
                  : "Create Account"}
            </Button>
          </form>

          <div className="mt-5 text-sm text-muted-foreground">
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
        </div>
      </div>

      {/* Right half - ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
