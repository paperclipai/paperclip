import { useState } from "react";
import { useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);

  const canSubmit = password.length >= 8 && password === confirmPassword && !!token;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending || !canSubmit || !token) return;
    setPending(true);
    setError(null);
    try {
      await authApi.resetPassword(password, token);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setPending(false);
    }
  };

  if (!token) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="w-full max-w-md px-8">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Paperclip</span>
          </div>
          <h1 className="text-xl font-semibold">Invalid reset link</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This password reset link is invalid or has expired.
          </p>
          <div className="mt-6">
            <Button asChild variant="outline" className="w-full">
              <a href="/auth/forgot-password">Request a new link</a>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Paperclip</span>
          </div>

          {success ? (
            <>
              <h1 className="text-xl font-semibold">Password reset</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Your password has been reset successfully. You can now sign in with your new password.
              </p>
              <div className="mt-6">
                <Button asChild className="w-full">
                  <a href="/auth">Sign in</a>
                </Button>
              </div>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">Set a new password</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Enter your new password below.
              </p>

              <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">New password</label>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    autoFocus
                  />
                  {password.length > 0 && password.length < 8 && (
                    <p className="mt-1 text-xs text-muted-foreground">Must be at least 8 characters</p>
                  )}
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Confirm password</label>
                  <input
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                  {confirmPassword.length > 0 && password !== confirmPassword && (
                    <p className="mt-1 text-xs text-muted-foreground">Passwords don't match</p>
                  )}
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <Button
                  type="submit"
                  disabled={pending || !canSubmit}
                  className={`w-full ${!canSubmit && !pending ? "opacity-50" : ""}`}
                >
                  {pending ? "Resetting..." : "Reset password"}
                </Button>
              </form>
            </>
          )}
        </div>
      </div>

      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
