import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { ShieldCheck, ShieldOff, Copy, Check, Eye, EyeOff, RefreshCw } from "lucide-react";

type SetupStep = "idle" | "password" | "qr" | "verify" | "backup_codes";
type DisableStep = "idle" | "confirm";

export function TwoFactorSettings() {
  const queryClient = useQueryClient();

  // Fetch current session to check if 2FA is enabled
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  // Check 2FA status from the user object (better-auth adds twoFactorEnabled to user)
  const [is2FAEnabled, setIs2FAEnabled] = useState<boolean | null>(null);
  const [setupStep, setSetupStep] = useState<SetupStep>("idle");
  const [disableStep, setDisableStep] = useState<DisableStep>("idle");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [verifyCode, setVerifyCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [backupCodesCopied, setBackupCodesCopied] = useState(false);
  const [showBackupCodes, setShowBackupCodes] = useState(false);

  // Check 2FA status on mount via get-session which includes twoFactorEnabled
  // We use a separate status check since our get-session override doesn't include twoFactorEnabled
  const statusQuery = useQuery({
    queryKey: ["auth", "two-factor-status"],
    queryFn: async () => {
      // Try to get TOTP URI - if user has 2FA enabled, this will succeed
      // If not, it will fail with "Two factor isn't enabled"
      // We use a lightweight approach: just call get-session which returns the user
      const res = await fetch("/api/auth/get-session", {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return { enabled: false };
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object") return { enabled: false };
      const user = (data as Record<string, unknown>).user as Record<string, unknown> | undefined;
      const enabled = user?.twoFactorEnabled === true;
      setIs2FAEnabled(enabled);
      return { enabled };
    },
    retry: false,
  });

  const enableMutation = useMutation({
    mutationFn: async () => {
      const result = await authApi.twoFactor.enable({ password });
      return result;
    },
    onSuccess: (result) => {
      setError(null);
      setTotpURI(result.totpURI);
      setBackupCodes(result.backupCodes);
      setSetupStep("qr");
      setPassword("");
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to enable 2FA");
    },
  });

  const verifyMutation = useMutation({
    mutationFn: async () => {
      await authApi.twoFactor.verifyTotp({ code: verifyCode.trim() });
    },
    onSuccess: () => {
      setError(null);
      setSetupStep("backup_codes");
      setIs2FAEnabled(true);
      setVerifyCode("");
      queryClient.invalidateQueries({ queryKey: ["auth", "two-factor-status"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Invalid code. Please try again.");
      setVerifyCode("");
    },
  });

  const disableMutation = useMutation({
    mutationFn: async () => {
      await authApi.twoFactor.disable({ password });
    },
    onSuccess: () => {
      setError(null);
      setIs2FAEnabled(false);
      setDisableStep("idle");
      setPassword("");
      queryClient.invalidateQueries({ queryKey: ["auth", "two-factor-status"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to disable 2FA");
    },
  });

  const regenerateBackupCodesMutation = useMutation({
    mutationFn: async () => {
      return await authApi.twoFactor.generateBackupCodes({ password });
    },
    onSuccess: (result) => {
      setError(null);
      setBackupCodes(result.backupCodes);
      setShowBackupCodes(true);
      setPassword("");
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to regenerate backup codes");
    },
  });

  const handleCopyBackupCodes = async () => {
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      setBackupCodesCopied(true);
      setTimeout(() => setBackupCodesCopied(false), 2000);
    } catch {
      /* clipboard may not be available */
    }
  };

  const handleReset = () => {
    setSetupStep("idle");
    setDisableStep("idle");
    setPassword("");
    setTotpURI("");
    setBackupCodes([]);
    setVerifyCode("");
    setError(null);
    setBackupCodesCopied(false);
    setShowBackupCodes(false);
  };

  if (statusQuery.isLoading || sessionQuery.isLoading) {
    return (
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Two-Factor Authentication
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Two-Factor Authentication
      </div>
      <div className="space-y-4 rounded-md border border-border px-4 py-4">
        {/* Status indicator */}
        <div className="flex items-center gap-2">
          {is2FAEnabled ? (
            <>
              <ShieldCheck className="h-4 w-4 text-green-600" />
              <span className="text-sm font-medium text-green-600">
                Two-factor authentication is enabled
              </span>
            </>
          ) : (
            <>
              <ShieldOff className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Two-factor authentication is not enabled
              </span>
            </>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          Add an extra layer of security to your account by requiring a verification code from
          an authenticator app (such as Google Authenticator, Authy, or 1Password) when signing in.
        </p>

        {/* ENABLE FLOW */}
        {!is2FAEnabled && setupStep === "idle" && (
          <Button
            size="sm"
            onClick={() => {
              setError(null);
              setSetupStep("password");
            }}
          >
            Enable two-factor authentication
          </Button>
        )}

        {!is2FAEnabled && setupStep === "password" && (
          <div className="space-y-3">
            <p className="text-sm">Enter your password to begin setup:</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                enableMutation.mutate();
              }}
              className="space-y-3"
            >
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Current password
                </label>
                <input
                  type="password"
                  className="w-full max-w-xs rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={!password || enableMutation.isPending}
                >
                  {enableMutation.isPending ? "Setting up..." : "Continue"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleReset}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        )}

        {setupStep === "qr" && totpURI && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium mb-2">
                Scan this QR code with your authenticator app:
              </p>
              <div className="inline-block rounded-lg border border-border bg-white p-3">
                <QRCodeSVG value={totpURI} size={200} />
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Or enter this setup key manually:
              </p>
              <code className="text-xs font-mono bg-muted/30 rounded px-2 py-1 break-all select-all">
                {extractSecretFromURI(totpURI)}
              </code>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setError(null);
                setSetupStep("verify");
              }}
            >
              I have scanned the QR code
            </Button>
          </div>
        )}

        {setupStep === "verify" && (
          <div className="space-y-3">
            <p className="text-sm">
              Enter the 6-digit code from your authenticator app to confirm setup:
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                verifyMutation.mutate();
              }}
              className="space-y-3"
            >
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Verification code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  className="w-full max-w-xs rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono tracking-widest outline-none focus:ring-1 focus:ring-ring"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value)}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  autoFocus
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={verifyCode.trim().length < 6 || verifyMutation.isPending}
                >
                  {verifyMutation.isPending ? "Verifying..." : "Verify and enable"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setError(null);
                    setSetupStep("qr");
                  }}
                >
                  Back
                </Button>
              </div>
            </form>
          </div>
        )}

        {setupStep === "backup_codes" && backupCodes.length > 0 && (
          <div className="space-y-4">
            <div className="rounded-md border border-yellow-500/30 bg-yellow-50/10 px-4 py-3">
              <p className="text-sm font-medium mb-1">Save your backup codes</p>
              <p className="text-xs text-muted-foreground">
                These codes can be used to access your account if you lose access to your authenticator
                app. Each code can only be used once. Store them in a safe place.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/20 p-3 font-mono text-sm">
              {backupCodes.map((code, i) => (
                <div key={i} className="px-2 py-1 text-center">
                  {code}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={handleCopyBackupCodes}>
                {backupCodesCopied ? (
                  <>
                    <Check className="h-3 w-3 mr-1" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3 mr-1" />
                    Copy codes
                  </>
                )}
              </Button>
              <Button size="sm" onClick={handleReset}>
                Done
              </Button>
            </div>
          </div>
        )}

        {/* DISABLE FLOW */}
        {is2FAEnabled && disableStep === "idle" && setupStep === "idle" && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setError(null);
                setDisableStep("confirm");
              }}
            >
              Disable two-factor authentication
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setError(null);
                setSetupStep("password");
                // Re-purpose password step for regenerating backup codes
              }}
              title="Regenerate backup codes"
            >
              <RefreshCw className="h-3 w-3 mr-1" />
              New backup codes
            </Button>
          </div>
        )}

        {is2FAEnabled && disableStep === "confirm" && (
          <div className="space-y-3">
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm font-medium text-destructive mb-1">
                Disable two-factor authentication?
              </p>
              <p className="text-xs text-muted-foreground">
                This will remove the extra security layer from your account. You will need
                to re-enable it and scan a new QR code to turn it back on.
              </p>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                disableMutation.mutate();
              }}
              className="space-y-3"
            >
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Enter your password to confirm
                </label>
                <input
                  type="password"
                  className="w-full max-w-xs rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  variant="destructive"
                  disabled={!password || disableMutation.isPending}
                >
                  {disableMutation.isPending ? "Disabling..." : "Disable 2FA"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDisableStep("idle");
                    setPassword("");
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        )}

        {/* Regenerate backup codes flow (when 2FA is already enabled) */}
        {is2FAEnabled && setupStep === "password" && (
          <div className="space-y-3">
            <p className="text-sm">Enter your password to generate new backup codes:</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                regenerateBackupCodesMutation.mutate();
              }}
              className="space-y-3"
            >
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">
                  Current password
                </label>
                <input
                  type="password"
                  className="w-full max-w-xs rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={!password || regenerateBackupCodesMutation.isPending}
                >
                  {regenerateBackupCodesMutation.isPending ? "Generating..." : "Generate new codes"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleReset}
                >
                  Cancel
                </Button>
              </div>
            </form>

            {/* Show regenerated backup codes inline */}
            {showBackupCodes && backupCodes.length > 0 && (
              <div className="space-y-3 mt-4">
                <div className="rounded-md border border-yellow-500/30 bg-yellow-50/10 px-4 py-3">
                  <p className="text-sm font-medium mb-1">New backup codes generated</p>
                  <p className="text-xs text-muted-foreground">
                    Your previous backup codes have been invalidated. Save these new codes.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 rounded-md border border-border bg-muted/20 p-3 font-mono text-sm">
                  {backupCodes.map((code, i) => (
                    <div key={i} className="px-2 py-1 text-center">
                      {code}
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={handleCopyBackupCodes}>
                    {backupCodesCopied ? (
                      <>
                        <Check className="h-3 w-3 mr-1" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3 mr-1" />
                        Copy codes
                      </>
                    )}
                  </Button>
                  <Button size="sm" onClick={handleReset}>
                    Done
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Extract the secret key from a TOTP URI for manual entry.
 * URI format: otpauth://totp/Issuer:user@email.com?secret=XXXX&issuer=Issuer
 */
function extractSecretFromURI(uri: string): string {
  try {
    const url = new URL(uri);
    return url.searchParams.get("secret") ?? uri;
  } catch {
    // If parsing fails, try regex
    const match = uri.match(/secret=([A-Z2-7]+)/i);
    return match?.[1] ?? uri;
  }
}
