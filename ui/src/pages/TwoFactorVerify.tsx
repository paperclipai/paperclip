import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "totp" | "backup";

export function TwoFactorVerify() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const nextPath = useMemo(() => searchParams.get("next") || "/", [searchParams]);

  const [mode, setMode] = useState<Mode>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const trimmed = code.trim();
      if (mode === "totp") {
        await authApi.twoFactor.verifyTotp({ code: trimmed, trustDevice });
      } else {
        await authApi.twoFactor.verifyBackupCode({ code: trimmed, trustDevice });
      }
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Verification failed");
    },
  });

  const canSubmit = code.trim().length >= 6 && !mutation.isPending;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold">Two-factor authentication</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "totp"
            ? "Enter the 6-digit code from your authenticator app."
            : "Enter one of your backup codes."}
        </p>

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) mutation.mutate();
          }}
        >
          <div>
            <Label htmlFor="code" className="text-xs text-muted-foreground">
              {mode === "totp" ? "Authentication code" : "Backup code"}
            </Label>
            <Input
              id="code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode={mode === "totp" ? "numeric" : "text"}
              autoFocus
              placeholder={mode === "totp" ? "123456" : "XXXX-XXXX"}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={trustDevice}
              onChange={(event) => setTrustDevice(event.target.checked)}
            />
            Trust this device for 60 days
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={!canSubmit}>
            {mutation.isPending ? "Verifying…" : "Verify"}
          </Button>
        </form>

        <div className="mt-5 text-sm text-muted-foreground">
          {mode === "totp" ? (
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => {
                setMode("backup");
                setCode("");
                setError(null);
              }}
            >
              Use a backup code instead
            </button>
          ) : (
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => {
                setMode("totp");
                setCode("");
                setError(null);
              }}
            >
              Use authenticator app instead
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
