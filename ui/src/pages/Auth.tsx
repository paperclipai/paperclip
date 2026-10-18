import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi, type SignWithEmailResult } from "../api/auth";
import { healthApi } from "../api/health";
import { CloudSignIn } from "@/components/CloudSignIn";
import { clearCloudSignInAttempt } from "@/lib/cloud-sign-in";
import { tenantSignInReturnPath } from "@/lib/cloudLinks";
import { queryKeys } from "../lib/queryKeys";
import { getRememberedInvitePath } from "../lib/invite-memory";
import { isSafeReturnTo } from "../lib/google-sso";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { PaperclipLoading } from "@/components/AnimatedPaperclipIcon";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PaperclipLockup } from "../components/PaperclipLockup";

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
  // When the Google OAuth callback fails, Better Auth redirects back to the
  // sign-in page with `google_error=callback_failed`. Surface a banner.
  const googleCallbackError = searchParams.get("google_error") === "callback_failed";
  const googleCallbackErrorMsg = "Google sign-in failed. Try again.";
  // Two-factor step: set when sign-in returns a twoFactorRedirect challenge.
  const [twoFactorStep, setTwoFactorStep] = useState<SignWithEmailResult | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const errorId = "auth-error";

  const nextPath = useMemo(
    () => tenantSignInReturnPath(searchParams.get("next") || getRememberedInvitePath() || "/"),
    [searchParams],
  );
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const { data: session, isLoading: isSessionLoading, error: sessionError } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const providersQuery = useQuery({
    queryKey: queryKeys.auth.providers,
    queryFn: () => authApi.getProviders(),
    retry: false,
  });
  const googleSsoEnabled = mode === "sign_in" && !twoFactorStep && providersQuery.data?.googleSsoEnabled === true;

  useEffect(() => {
    if (session) {
      clearCloudSignInAttempt();
      navigate(nextPath, { replace: true });
    }
  }, [session, navigate, nextPath]);

  const mutation = useMutation({
    mutationFn: async (): Promise<SignWithEmailResult | null> => {
      if (mode === "sign_in") {
        const result = await authApi.signInEmail({ email: email.trim(), password });
        // A twoFactorRedirect means no session was issued: stop at the TOTP step.
        setTwoFactorStep(result.twoFactorRedirect ? result : null);
        setTotpCode("");
        setUseBackupCode(false);
        return result;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      return null;
    },
    onSuccess: async (result) => {
      setError(null);
      // A two-factor challenge defers completion to the TOTP/backup-code
      // mutations; only the password-only path (no twoFactorRedirect) continues here.
      if (result?.twoFactorRedirect) return;
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      // Reset rather than invalidate: the `["companies"]` entry is shared app-wide and
      // is not account-scoped, so invalidating leaves the previous account's list
      // readable (and any fetch for that session in flight) until the refetch lands.
      // Sign-in can change accounts, so drop the list outright.
      await queryClient.resetQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const completeTwoFactor = async () => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    // Reset rather than invalidate: the `["companies"]` entry is shared app-wide and
    // is not account-scoped, so invalidating leaves the previous account's list
    // readable (and any fetch for that session in flight) until the refetch lands.
    // Sign-in can change accounts, so drop the list outright.
    await queryClient.resetQueries({ queryKey: queryKeys.companies.all });
    navigate(nextPath, { replace: true });
  };

  const verifyTotpMutation = useMutation({
    mutationFn: () => authApi.verifyTotp(totpCode.trim()),
    onSuccess: completeTwoFactor,
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Verification failed");
    },
  });

  const verifyBackupCodeMutation = useMutation({
    mutationFn: () => authApi.verifyBackupCode(totpCode.trim()),
    onSuccess: completeTwoFactor,
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Verification failed");
    },
  });

  const handleGoogleSignIn = async () => {
    try {
      const safeReturn = isSafeReturnTo(nextPath);
      const result = await authApi.signInGoogle({ successRedirectUrl: safeReturn ?? "/" });
      if (result.url) {
        window.location.assign(result.url);
      } else {
        setError("Google sign-in could not start. Try again.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Google sign-in failed");
    }
  };

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  if (healthQuery.isLoading || isSessionLoading || session) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <PaperclipLoading className="min-h-0" />
      </div>
    );
  }

  // A health/session failure must not be mistaken for a self-hosted instance.
  if (healthQuery.error || sessionError) {
    return <p role="alert" className="p-6 text-sm text-destructive">Unable to check sign-in. Refresh and try again.</p>;
  }

  if (healthQuery.data?.cloud) {
    return <CloudSignIn cloud={healthQuery.data.cloud} returnTo={nextPath} />;
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="mb-8">
            <PaperclipLockup className="h-5 w-auto" />
          </div>

          <h1 className="text-xl font-semibold">
            {twoFactorStep
              ? "Two-factor verification"
              : mode === "sign_in"
                ? "Sign in to Paperclip"
                : "Create your Paperclip account"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {twoFactorStep
              ? "Enter the code from your authenticator app, or use a one-time backup code."
              : mode === "sign_in"
                ? "Use your email and password to access this instance."
                : "Create an account for this instance. Email confirmation is not required in v1."}
          </p>

          {twoFactorStep ? (
            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (verifyTotpMutation.isPending || verifyBackupCodeMutation.isPending) return;
                const code = totpCode.trim();
                if (code.length === 0) {
                  setError("Enter a code to continue.");
                  return;
                }
                (useBackupCode ? verifyBackupCodeMutation : verifyTotpMutation).mutate();
              }}
            >
              <div>
                <label htmlFor="two-factor-code" className="text-xs text-muted-foreground mb-1 block">
                  {useBackupCode ? "Backup code" : "6-digit code"}
                </label>
                <input
                  id="two-factor-code"
                  name="two-factor-code"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9A-Za-z\-]{4,32}"
                  maxLength={32}
                  placeholder={useBackupCode ? "Backup code" : "000000"}
                  value={totpCode}
                  onChange={(event) => setTotpCode(event.target.value)}
                  autoComplete="one-time-code"
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus
                />
                {!useBackupCode && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Backup codes are one-time use — a wrong code consumes one and
                    repeated failures can temporarily lock your account.
                  </p>
                )}
              </div>
              <Button
                type="submit"
                disabled={verifyTotpMutation.isPending || verifyBackupCodeMutation.isPending}
                aria-disabled={!totpCode.trim() || verifyTotpMutation.isPending || verifyBackupCodeMutation.isPending}
                className={`w-full ${(!totpCode.trim() && !verifyTotpMutation.isPending && !verifyBackupCodeMutation.isPending) ? "opacity-50" : ""}`}
              >
                {useBackupCode
                  ? verifyBackupCodeMutation.isPending
                    ? "Verifying…"
                    : "Sign in with backup code"
                  : verifyTotpMutation.isPending
                    ? "Verifying…"
                    : "Verify and sign in"}
              </Button>
            </form>
          ) : (
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
                <input
                  id="name"
                  name="name"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  autoComplete="name"
                  required
                  aria-required="true"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  autoFocus
                />
              </div>
            )}
            <div>
              <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">Email</label>
              <input
                id="email"
                name="email"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                autoFocus={mode === "sign_in"}
              />
            </div>
            <div>
              <label htmlFor="password" className="text-xs text-muted-foreground mb-1 block">Password</label>
              <input
                id="password"
                name="password"
                className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                required
                aria-required="true"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
              />
            </div>
            {(error || googleCallbackError) && (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {googleCallbackError ? googleCallbackErrorMsg : error}
              </p>
            )}
            {googleSsoEnabled && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleGoogleSignIn}
              >
                Sign in with Google
              </Button>
            )}
            <Button
              type="submit"
              disabled={mutation.isPending}
              aria-disabled={!canSubmit || mutation.isPending}
              className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
            >
              {mutation.isPending
                ? "Working…"
                : mode === "sign_in"
                  ? "Sign In"
                  : "Create Account"}
            </Button>
          </form>
          )}

          {twoFactorStep && (
            <button
              type="button"
              className="mt-5 text-sm font-medium text-foreground underline underline-offset-2"
              onClick={() => {
                setError(null);
                setTotpCode("");
                setUseBackupCode((value) => !value);
              }}
            >
              {useBackupCode ? "Use my authenticator app instead" : "Use a backup code instead"}
            </button>
          )}

          <div className="mt-5 text-sm text-muted-foreground">
            {twoFactorStep ? null : mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
            {!twoFactorStep && (
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => {
                  setError(null);
                  setTwoFactorStep(null);
                  setTotpCode("");
                  setUseBackupCode(false);
                  setMode(mode === "sign_in" ? "sign_up" : "sign_in");
                }}
              >
                {mode === "sign_in" ? "Create one" : "Sign in"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Right half — ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
