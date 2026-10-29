import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

type ChallengeMode = "totp" | "backup";

/** Shown when the session exists but loading the signed-in app failed. */
export function signInCompletionErrorMessage(err: unknown): string {
  return `You are signed in, but Paperclip could not finish loading: ${
    err instanceof Error ? err.message : "Unknown error"
  }`;
}

/**
 * Errors after which the server has spent the challenge, so no further code can
 * succeed and sign-in must restart from the password step.
 */
const SPENT_CHALLENGE_MESSAGES: Record<string, string> = {
  // The challenge cookie lapsed (10 minutes) or was already consumed.
  INVALID_TWO_FACTOR_COOKIE: "Your sign-in timed out. Enter your password again.",
  // Better Auth consumes the challenge and expires its cookie after too many wrong codes.
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "Too many incorrect codes. Enter your password again.",
};

export function TwoFactorChallenge({
  onVerified,
  onCancel,
  onExpired,
}: {
  onVerified: () => Promise<void> | void;
  onCancel: () => void;
  /** The challenge is spent, so no code can succeed; restart sign-in and show `message`. */
  onExpired: (message: string) => void;
}) {
  const codeId = useId();
  const trustId = useId();
  const errorId = useId();
  const [mode, setMode] = useState<ChallengeMode>("totp");
  const [code, setCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Authenticator apps often display codes as "123 456"; codes never contain whitespace.
  const normalizedCode = code.replace(/\s+/g, "");

  // Kept apart from verification: once the server accepts a code the challenge
  // cookie is spent, so a failure here must offer a retry, not another code.
  const completion = useMutation({
    mutationFn: async () => {
      await onVerified();
    },
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const input = { code: normalizedCode, trustDevice };
      if (mode === "totp") {
        await authApi.verifyTotp(input);
        return;
      }
      await authApi.verifyBackupCode(input);
    },
    onSuccess: () => {
      setError(null);
      completion.mutate();
    },
    onError: (err) => {
      const code = (err as { code?: unknown } | null)?.code;
      const spentMessage = typeof code === "string" ? SPENT_CHALLENGE_MESSAGES[code] : undefined;
      if (spentMessage) {
        onExpired(spentMessage);
        return;
      }
      setError(err instanceof Error ? err.message : "Verification failed");
    },
  });

  if (mutation.isSuccess) {
    if (!completion.error) {
      return <p className="mt-6 text-sm text-muted-foreground">Signing you in…</p>;
    }
    return (
      <div className="mt-6 space-y-4">
        <p role="alert" className="text-xs text-destructive">
          {signInCompletionErrorMessage(completion.error)}
        </p>
        <Button
          type="button"
          className="w-full"
          disabled={completion.isPending}
          onClick={() => completion.mutate()}
        >
          {completion.isPending ? "Retrying…" : "Try again"}
        </Button>
      </div>
    );
  }

  const canSubmit = normalizedCode.length > 0;

  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (mutation.isPending) return;
        if (!canSubmit) {
          setError("Enter a code to continue.");
          return;
        }
        mutation.mutate();
      }}
    >
      <div>
        <label htmlFor={codeId} className="text-xs text-muted-foreground mb-1 block">
          {mode === "totp" ? "Authenticator code" : "Backup code"}
        </label>
        <input
          id={codeId}
          name="code"
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          inputMode={mode === "totp" ? "numeric" : "text"}
          autoComplete="one-time-code"
          placeholder={mode === "totp" ? "123456" : "xxxxx-xxxxx"}
          required
          aria-required="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoFocus
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={trustId}
          checked={trustDevice}
          onCheckedChange={(checked) => setTrustDevice(checked === true)}
        />
        <label htmlFor={trustId} className="text-sm text-muted-foreground">
          Trust this device for 30 days
        </label>
      </div>
      <div className="text-sm text-muted-foreground">
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-2"
          onClick={() => {
            setError(null);
            setCode("");
            setMode(mode === "totp" ? "backup" : "totp");
          }}
        >
          {mode === "totp" ? "Use a backup code" : "Use authenticator code"}
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Back to sign in
        </Button>
        <Button
          type="submit"
          disabled={mutation.isPending}
          aria-disabled={!canSubmit || mutation.isPending}
          className={!canSubmit && !mutation.isPending ? "opacity-50" : undefined}
        >
          {mutation.isPending ? "Verifying…" : "Verify"}
        </Button>
      </div>
    </form>
  );
}
