import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Sparkles, ShieldCheck } from "lucide-react";

type AuthMode = "sign_in" | "sign_up";
type AuthStep = "credentials" | "totp";

export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [step, setStep] = useState<AuthStep>("credentials");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
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

  const signInMutation = useMutation({
    mutationFn: async () => {
      if (mode === "sign_in") {
        const result = await authApi.signInEmail({ email: email.trim(), password });
        return result;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      return {};
    },
    onSuccess: async (result) => {
      setError(null);
      if (result?.twoFactorRedirect) {
        setStep("totp");
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

  const totpMutation = useMutation({
    mutationFn: async () => {
      await authApi.twoFactor.verifyTotp({ code: totpCode.trim() });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Invalid verification code");
      setTotpCode("");
    },
  });

  const backupCodeMutation = useMutation({
    mutationFn: async () => {
      await authApi.twoFactor.verifyBackupCode({ code: totpCode.trim() });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Invalid backup code");
      setTotpCode("");
    },
  });

  const [useBackupCode, setUseBackupCode] = useState(false);

  const canSubmitCredentials =
    email.trim().length > 0 &&
    password.trim().length >= 8 &&
    (mode === "sign_in" || name.trim().length > 0);

  const canSubmitTotp = totpCode.trim().length >= 6;

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      {/* Left half -- form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Paperclip</span>
          </div>

          {step === "credentials" && (
            <>
              <h1 className="text-xl font-semibold">
                {mode === "sign_in" ? "Sign in to Paperclip" : "Create your Paperclip account"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {mode === "sign_in"
                  ? "Use your email and password to access this instance."
                  : "Create an account for this instance. Email confirmation is not required in v1."}
              </p>

              <form
                className="mt-6 space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  signInMutation.mutate();
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
                    autoFocus={mode === "sign_in"}
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
                <Button type="submit" disabled={!canSubmitCredentials || signInMutation.isPending} className="w-full">
                  {signInMutation.isPending
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
            </>
          )}

          {step === "totp" && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <ShieldCheck className="h-5 w-5 text-muted-foreground" />
                <h1 className="text-xl font-semibold">Two-factor authentication</h1>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {useBackupCode
                  ? "Enter one of your backup codes to verify your identity."
                  : "Enter the 6-digit code from your authenticator app."}
              </p>

              <form
                className="mt-6 space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (useBackupCode) {
                    backupCodeMutation.mutate();
                  } else {
                    totpMutation.mutate();
                  }
                }}
              >
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    {useBackupCode ? "Backup code" : "Verification code"}
                  </label>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50 font-mono tracking-widest"
                    type="text"
                    inputMode={useBackupCode ? "text" : "numeric"}
                    pattern={useBackupCode ? undefined : "[0-9]*"}
                    maxLength={useBackupCode ? 20 : 6}
                    value={totpCode}
                    onChange={(event) => setTotpCode(event.target.value)}
                    placeholder={useBackupCode ? "xxxxxxxx" : "000000"}
                    autoFocus
                    autoComplete="one-time-code"
                  />
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <Button
                  type="submit"
                  disabled={!canSubmitTotp || totpMutation.isPending || backupCodeMutation.isPending}
                  className="w-full"
                >
                  {(totpMutation.isPending || backupCodeMutation.isPending) ? "Verifying..." : "Verify"}
                </Button>
              </form>

              <div className="mt-4 flex flex-col gap-2">
                <button
                  type="button"
                  className="text-sm text-muted-foreground underline underline-offset-2 text-left"
                  onClick={() => {
                    setError(null);
                    setTotpCode("");
                    setUseBackupCode(!useBackupCode);
                  }}
                >
                  {useBackupCode ? "Use authenticator app instead" : "Use a backup code instead"}
                </button>
                <button
                  type="button"
                  className="text-sm text-muted-foreground underline underline-offset-2 text-left"
                  onClick={() => {
                    setStep("credentials");
                    setError(null);
                    setTotpCode("");
                    setUseBackupCode(false);
                  }}
                >
                  Back to sign in
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right half -- ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
