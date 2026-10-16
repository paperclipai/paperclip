import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, KeyRound, LoaderCircle, ShieldCheck, ShieldOff } from "lucide-react";
import { authApi, type EnableTotpResult } from "@/api/auth";
import { queryKeys } from "../lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type TwoFactorState = "idle" | "enroll" | "disable" | "verify-enroll";

/**
 * Two-factor (TOTP) settings surface. Reads `twoFactorEnabled` from the
 * session profile and exposes enroll / disable flows.
 *
 * Enrollment is a two-step flow:
 *  1. "Enable two-factor" → password input → enableTotp() → show totpURI + backup codes
 *  2. "Verify and confirm" → TOTP code input → verifyTotp() → twoFactorEnabled becomes true
 *
 * Disable is a single step: password input → disableTotp() → twoFactorEnabled becomes false.
 */
export function TwoFactorSettings({
  enabled,
  onStateChanged,
}: {
  enabled: boolean;
  /** Called after a successful verify or disable so the parent can refresh the session flag. */
  onStateChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<TwoFactorState>("idle");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [enrollResult, setEnrollResult] = useState<EnableTotpResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"uri" | "codes" | null>(null);

  function reset() {
    setState("idle");
    setPassword("");
    setTotpCode("");
    setEnrollResult(null);
    setActionError(null);
  }

  const enableMutation = useMutation({
    mutationFn: () => authApi.enableTotp(password),
    onSuccess: (result) => {
      setActionError(null);
      setEnrollResult(result);
      setState("verify-enroll");
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to enable two-factor.");
    },
  });

  const verifyEnrollMutation = useMutation({
    mutationFn: () => authApi.verifyTotp(totpCode.trim()),
    onSuccess: () => {
      setActionError(null);
      // Invalidate the session so the parent picks up the updated twoFactorEnabled flag.
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      onStateChanged();
      reset();
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Verification failed.");
    },
  });

  const disableMutation = useMutation({
    mutationFn: () => authApi.disableTotp(password),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      onStateChanged();
      reset();
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to disable two-factor.");
    },
  });

  async function copyText(text: string, which: "uri" | "codes") {
    try {
      await copyTextToClipboard(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard can be unavailable in some contexts (non-secure, non-localhost);
      // the button feedback simply does not flip.
    }
  }

  const isPending = enableMutation.isPending || verifyEnrollMutation.isPending || disableMutation.isPending;

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-1">
        {enabled ? (
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
        ) : (
          <ShieldOff className="h-5 w-5 text-muted-foreground" />
        )}
        <h2 className="text-sm font-semibold">Two-factor authentication</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        {enabled
          ? "Two-factor is on. At sign-in, a 6-digit code from your authenticator app (or a one-time backup code) is required after the password."
          : "Enable two-factor to require a 6-digit code from an authenticator app at sign-in, in addition to your password."}
      </p>

      {actionError ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </div>
      ) : null}

      {/* Idle — status + CTA */}
      {state === "idle" && (
        <div className="space-y-3">
          {enabled ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setState("disable");
                setActionError(null);
              }}
            >
              <ShieldOff className="h-4 w-4" />
              Disable two-factor
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setState("enroll");
                setActionError(null);
              }}
            >
              <ShieldCheck className="h-4 w-4" />
              Enable two-factor
            </Button>
          )}
          {enabled && (
            <p className="text-xs text-muted-foreground">
              Disabling requires your account password. Keep your backup codes safe — you will
              lose access to them after disabling.
            </p>
          )}
        </div>
      )}

      {/* Enroll step 1 — password to initiate enrollment */}
      {state === "enroll" && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="2faEnrollPassword">Password</Label>
            <Input
              id="enroll2faPassword"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="Enter your password"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Enter your password to start two-factor enrollment. A one-time code from your
              authenticator app will then be required to confirm.
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => reset()}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!password.trim() || enableMutation.isPending}
              onClick={() => enableMutation.mutate()}
            >
              {enableMutation.isPending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="h-4 w-4" />
              )}
              {enableMutation.isPending ? "Enabling…" : "Continue"}
            </Button>
          </div>
        </div>
      )}

      {/* Enroll step 2 — verify TOTP + show backup codes */}
      {state === "verify-enroll" && enrollResult && (
        <div className="space-y-4">
          {/* totpURI — the otpauth:// URI to scan or copy into an authenticator app */}
          <div className="space-y-1.5">
            <Label>Authenticator app URI</Label>
            <div className="flex gap-2 items-center">
              <code className="flex-1 truncate rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
                {enrollResult.totpURI}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void copyText(enrollResult.totpURI, "uri")}
                aria-label="Copy authenticator URI"
              >
                {copied === "uri" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Add this URI to an authenticator app (e.g. Google Authenticator, 1Password,
              Authy). You can also scan the QR code if your app supports it.
            </p>
          </div>

          {/* Backup codes */}
          <div className="space-y-1.5">
            <Label>Backup codes</Label>
            <div className="flex gap-2 items-center">
              <div className="flex-1 rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs text-foreground break-all">
                {enrollResult.backupCodes.join("  ")}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => void copyText(enrollResult.backupCodes.join("\n"), "codes")}
                aria-label="Copy backup codes"
              >
                {copied === "codes" ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Backup codes are one-time use. Each code can only be used once, and repeated wrong
                entries can temporarily lock your account. Store them somewhere safe.
              </span>
            </div>
          </div>

          {/* TOTP verify input */}
          <div className="space-y-1.5">
            <Label htmlFor="2faVerifyCode">Confirm with a code</Label>
            <div className="flex gap-2">
              <Input
                id="verify2faCode"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value)}
                placeholder="000000"
                autoComplete="one-time-code"
                className="w-32"
              />
              <Button
                type="button"
                size="sm"
                disabled={!totpCode.trim() || verifyEnrollMutation.isPending}
                onClick={() => verifyEnrollMutation.mutate()}
              >
                {verifyEnrollMutation.isPending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                {verifyEnrollMutation.isPending ? "Verifying…" : "Verify and enable"}
              </Button>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => reset()}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Disable — password required */}
      {state === "disable" && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="2faDisablePassword">Password</Label>
            <Input
              id="disable2faPassword"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="Enter your password to confirm"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Two-factor will be immediately disabled. You will no longer be asked for a code at
              sign-in.
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => reset()}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={!password.trim() || disableMutation.isPending}
              onClick={() => disableMutation.mutate()}
            >
              {disableMutation.isPending ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldOff className="h-4 w-4" />
              )}
              {disableMutation.isPending ? "Disabling…" : "Disable two-factor"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

