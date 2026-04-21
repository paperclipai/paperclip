import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { LoaderCircle, ShieldCheck, ShieldOff } from "lucide-react";
import { authApi, AuthApiError } from "@/api/auth";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type EnrollmentStep = "idle" | "confirm-password" | "scan-qr" | "verify-code" | "show-backup" | "done";

export function UserSecuritySettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Instance Settings" },
      { label: "Security" },
    ]);
  }, [setBreadcrumbs]);

  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const user = sessionQuery.data?.user;
  const twoFactorEnabled = Boolean((user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled);

  const [step, setStep] = useState<EnrollmentStep>("idle");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState<string>("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [verifyCode, setVerifyCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (step !== "scan-qr") return;
    if (!totpURI || !qrCanvasRef.current) return;
    void QRCode.toCanvas(qrCanvasRef.current, totpURI, { width: 220, margin: 1 });
  }, [step, totpURI]);

  function resetEnrollment() {
    setStep("idle");
    setPassword("");
    setTotpURI("");
    setBackupCodes([]);
    setVerifyCode("");
    setError(null);
  }

  const enableMutation = useMutation({
    mutationFn: () => authApi.twoFactor.enable({ password }),
    onSuccess: (data) => {
      setTotpURI(data.totpURI);
      setBackupCodes(data.backupCodes);
      setStep("scan-qr");
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof AuthApiError ? err.message : err instanceof Error ? err.message : "Failed to start enrollment");
    },
  });

  const verifyMutation = useMutation({
    mutationFn: () => authApi.twoFactor.verifyTotp({ code: verifyCode.trim() }),
    onSuccess: async () => {
      setStep("show-backup");
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Verification failed");
    },
  });

  const disableMutation = useMutation({
    mutationFn: () => authApi.twoFactor.disable({ password }),
    onSuccess: async () => {
      resetEnrollment();
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to disable 2FA");
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: () => authApi.twoFactor.generateBackupCodes({ password }),
    onSuccess: (data) => {
      setBackupCodes(data.backupCodes);
      setStep("show-backup");
      setError(null);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to regenerate backup codes");
    },
  });

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-xl font-semibold">Security</h1>
      <p className="mt-1 text-sm text-muted-foreground">Manage your account security settings.</p>

      <section className="mt-8 rounded-lg border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-medium">
              {twoFactorEnabled ? (
                <ShieldCheck className="h-4 w-4 text-green-600" aria-hidden />
              ) : (
                <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden />
              )}
              Two-factor authentication
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {twoFactorEnabled
                ? "2FA is enabled on your account. You will be asked for a code after signing in."
                : "Add a second step to sign-in using an authenticator app like Google Authenticator, 1Password, or Authy."}
            </p>
          </div>
          <div className="shrink-0">
            {!twoFactorEnabled && step === "idle" && (
              <Button onClick={() => setStep("confirm-password")}>Enable</Button>
            )}
            {twoFactorEnabled && step === "idle" && (
              <Button variant="destructive" onClick={() => setStep("confirm-password")}>Disable</Button>
            )}
          </div>
        </div>

        {step === "confirm-password" && (
          <form
            className="mt-5 space-y-3 border-t border-border pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!password) return;
              setError(null);
              if (twoFactorEnabled) {
                disableMutation.mutate();
              } else {
                enableMutation.mutate();
              }
            }}
          >
            <Label htmlFor="sec-password" className="text-xs text-muted-foreground">
              Confirm your password to continue
            </Label>
            <Input
              id="sec-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button
                type="submit"
                disabled={!password || enableMutation.isPending || disableMutation.isPending}
              >
                {(enableMutation.isPending || disableMutation.isPending) ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                ) : twoFactorEnabled ? (
                  "Disable 2FA"
                ) : (
                  "Continue"
                )}
              </Button>
              <Button type="button" variant="ghost" onClick={resetEnrollment}>Cancel</Button>
            </div>
          </form>
        )}

        {step === "scan-qr" && (
          <div className="mt-5 space-y-4 border-t border-border pt-5">
            <div>
              <p className="text-sm font-medium">Scan this QR code with your authenticator app</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Or enter the setup key manually:{" "}
                <code className="break-all rounded bg-muted px-1 py-0.5 text-xs">{extractSecret(totpURI)}</code>
              </p>
            </div>
            <canvas ref={qrCanvasRef} className="rounded bg-white p-2" />
            <div>
              <Label htmlFor="verify-code" className="text-xs text-muted-foreground">
                Enter the 6-digit code from your app to confirm
              </Label>
              <Input
                id="verify-code"
                value={verifyCode}
                onChange={(event) => setVerifyCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                autoFocus
              />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button
                onClick={() => verifyMutation.mutate()}
                disabled={verifyCode.trim().length < 6 || verifyMutation.isPending}
              >
                {verifyMutation.isPending ? "Verifying…" : "Confirm"}
              </Button>
              <Button type="button" variant="ghost" onClick={resetEnrollment}>Cancel</Button>
            </div>
          </div>
        )}

        {step === "show-backup" && (
          <div className="mt-5 space-y-4 border-t border-border pt-5">
            <div>
              <p className="text-sm font-medium">Save your backup codes</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Each code works once. Store them somewhere safe — they will not be shown again.
              </p>
            </div>
            <pre className="rounded bg-muted p-4 text-xs font-mono leading-6">
              {backupCodes.join("\n")}
            </pre>
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(backupCodes.join("\n"));
                }}
                variant="outline"
              >
                Copy codes
              </Button>
              <Button onClick={resetEnrollment}>Done</Button>
            </div>
          </div>
        )}

        {twoFactorEnabled && step === "idle" && (
          <div className="mt-5 border-t border-border pt-5">
            <p className="text-sm font-medium">Backup codes</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Generate a new set of backup codes. Your old codes will stop working.
            </p>
            <form
              className="mt-3 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!password) return;
                regenerateMutation.mutate();
              }}
            >
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Confirm password"
                autoComplete="current-password"
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button type="submit" variant="outline" disabled={!password || regenerateMutation.isPending}>
                {regenerateMutation.isPending ? "Generating…" : "Regenerate backup codes"}
              </Button>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}

function extractSecret(totpUri: string): string {
  try {
    const url = new URL(totpUri);
    return url.searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}
