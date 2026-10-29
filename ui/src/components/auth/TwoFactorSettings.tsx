import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { authApi, type TwoFactorEnrollment } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type PasswordAction = "enable" | "disable" | "regenerate";

const PASSWORD_ACTION_LABELS: Record<PasswordAction, string> = {
  enable: "Continue",
  disable: "Turn off two-factor",
  regenerate: "Generate new codes",
};

function totpSecretFromUri(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get("secret");
  } catch {
    return null;
  }
}

function BackupCodeList({ codes }: { codes: string[] }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Save these backup codes in a safe place. Each code works once. They are shown only now.
      </p>
      <ul className="grid max-w-md grid-cols-2 gap-2 rounded-md border border-border p-3 font-mono text-sm">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
    </div>
  );
}

function TotpQrCode({ uri }: { uri: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("qrcode")
      .then(({ default: QRCode }) => QRCode.toDataURL(uri, { margin: 1, width: 192 }))
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  if (!dataUrl) return null;
  return <img src={dataUrl} alt="Authenticator setup QR code" className="size-48 rounded-md border border-border" />;
}

export function TwoFactorSettings() {
  const queryClient = useQueryClient();
  const passwordId = useId();
  const codeId = useId();
  const [action, setAction] = useState<PasswordAction | null>(null);
  const [password, setPassword] = useState("");
  const [enrollment, setEnrollment] = useState<TwoFactorEnrollment | null>(null);
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const securityQuery = useQuery({
    queryKey: queryKeys.auth.accountSecurity,
    queryFn: () => authApi.getAccountSecurity(),
    retry: false,
  });

  function reset() {
    setAction(null);
    setPassword("");
    setEnrollment(null);
    setCode("");
    setError(null);
  }

  const passwordMutation = useMutation({
    mutationFn: async (input: { action: PasswordAction; password: string }) => {
      if (input.action === "enable") {
        return { enrollment: await authApi.enableTwoFactor({ password: input.password }) };
      }
      if (input.action === "regenerate") {
        return { backupCodes: await authApi.regenerateBackupCodes({ password: input.password }) };
      }
      await authApi.disableTwoFactor({ password: input.password });
      return {};
    },
    onSuccess: async (result) => {
      setAction(null);
      setPassword("");
      setError(null);
      if ("enrollment" in result && result.enrollment) {
        setEnrollment(result.enrollment);
        setBackupCodes(null);
        return;
      }
      if ("backupCodes" in result && result.backupCodes) {
        setBackupCodes(result.backupCodes);
        return;
      }
      setBackupCodes(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.accountSecurity });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Request failed");
    },
  });

  const confirmMutation = useMutation({
    mutationFn: () => authApi.verifyTotp({ code: code.replace(/\s+/g, ""), trustDevice: false }),
    onSuccess: async () => {
      const codes = enrollment?.backupCodes ?? [];
      reset();
      setBackupCodes(codes);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.accountSecurity });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Verification failed");
    },
  });

  if (securityQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading two-factor settings…</div>;
  }
  if (securityQuery.error || !securityQuery.data) {
    return (
      <div className="text-sm text-destructive">
        {securityQuery.error instanceof Error ? securityQuery.error.message : "Failed to load two-factor settings."}
      </div>
    );
  }

  const enabled = securityQuery.data.twoFactorEnabled;
  // Every two-factor change re-checks the password, so an account without one cannot make any.
  const hasPassword = securityQuery.data.hasPassword;
  const manualKey = enrollment ? totpSecretFromUri(enrollment.totpURI) : null;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Authenticator app</h3>
          <span className="text-xs text-muted-foreground">{enabled ? "On" : "Off"}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {!hasPassword
            ? "Authenticator codes protect password sign-in. This account signs in without a password, so there is nothing to set up."
            : enabled
              ? "Sign-in with your password also asks for a code from your authenticator app."
              : "Ask for a code from an authenticator app after you sign in with your password."}
        </p>
      </div>

      {enrollment ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!code.trim() || confirmMutation.isPending) return;
            confirmMutation.mutate();
          }}
        >
          <p className="text-sm text-muted-foreground">
            Scan this QR code with your authenticator app, then enter the 6-digit code it shows.
          </p>
          <TotpQrCode uri={enrollment.totpURI} />
          {manualKey ? (
            <p className="text-xs text-muted-foreground">
              Setup key: <span className="font-mono text-foreground break-all">{manualKey}</span>
            </p>
          ) : null}
          <BackupCodeList codes={enrollment.backupCodes} />
          <div className="max-w-xs space-y-2">
            <Label htmlFor={codeId}>Authenticator code</Label>
            <Input
              id={codeId}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="outline" onClick={reset} disabled={confirmMutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!code.trim() || confirmMutation.isPending}>
              {confirmMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              Turn on two-factor
            </Button>
          </div>
        </form>
      ) : action ? (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!password || passwordMutation.isPending) return;
            passwordMutation.mutate({ action, password });
          }}
        >
          <div className="max-w-xs space-y-2">
            <Label htmlFor={passwordId}>Confirm your password</Label>
            <Input
              id={passwordId}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Button type="button" variant="outline" onClick={reset} disabled={passwordMutation.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={action === "disable" ? "destructive" : "default"}
              disabled={!password || passwordMutation.isPending}
            >
              {passwordMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              {PASSWORD_ACTION_LABELS[action]}
            </Button>
          </div>
        </form>
      ) : !hasPassword ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {enabled ? (
            <>
              <Button type="button" variant="outline" onClick={() => setAction("regenerate")}>
                New backup codes
              </Button>
              <Button type="button" variant="outline" onClick={() => setAction("disable")}>
                Turn off
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => setAction("enable")}>
              Set up authenticator app
            </Button>
          )}
        </div>
      )}

      {!enrollment && backupCodes && backupCodes.length > 0 ? <BackupCodeList codes={backupCodes} /> : null}

      {error ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
