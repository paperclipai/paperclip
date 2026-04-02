import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const tokenError = searchParams.get("error");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(
    tokenError === "INVALID_TOKEN" ? "This reset link is invalid or has expired." : null,
  );
  const [success, setSuccess] = useState(false);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error("Missing reset token");
      if (password.length < 8) throw new Error("Password must be at least 8 characters");
      if (password !== confirmPassword) throw new Error("Passwords do not match");
      await authApi.resetPassword({ newPassword: password, token });
    },
    onSuccess: () => {
      setError(null);
      setSuccess(true);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    },
  });

  const hasToken = !!token && !tokenError;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-md px-8">
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
              <Button className="w-full" onClick={() => navigate("/auth")}>
                Sign in
              </Button>
            </div>
          </>
        ) : !hasToken ? (
          <>
            <h1 className="text-xl font-semibold">Invalid reset link</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {error || "This password reset link is invalid or has expired. Please request a new one."}
            </p>
            <div className="mt-6 space-y-3">
              <Button className="w-full" onClick={() => navigate("/auth/forgot-password")}>
                Request new link
              </Button>
              <Button variant="outline" className="w-full" onClick={() => navigate("/auth")}>
                Back to sign in
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">Set new password</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter your new password below.
            </p>

            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (mutation.isPending) return;
                mutation.mutate();
              }}
            >
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">New password</label>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  autoFocus
                  placeholder="At least 8 characters"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Confirm password</label>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button
                type="submit"
                disabled={mutation.isPending || password.length < 8 || !confirmPassword}
                className={`w-full ${password.length < 8 ? "opacity-50" : ""}`}
              >
                {mutation.isPending ? "Resetting…" : "Reset Password"}
              </Button>
            </form>

            <div className="mt-5 text-sm text-muted-foreground">
              Remember your password?{" "}
              <button
                type="button"
                className="font-medium text-foreground underline underline-offset-2"
                onClick={() => navigate("/auth")}
              >
                Sign in
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
