import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { authApi } from "../api/auth";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      await authApi.requestPasswordReset({
        email: email.trim(),
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });
    },
    onSuccess: () => {
      setError(null);
      setSubmitted(true);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to request password reset");
    },
  });

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-md px-8">
        <div className="flex items-center gap-2 mb-8">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Paperclip</span>
        </div>

        {submitted ? (
          <>
            <h1 className="text-xl font-semibold">Check your email</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              If an account exists for <strong>{email}</strong>, a password reset link has been sent.
              Check your inbox or contact your instance admin if email is not configured.
            </p>
            <div className="mt-6">
              <Button variant="outline" className="w-full" onClick={() => navigate("/auth")}>
                Back to sign in
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold">Reset your password</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter your email address and we'll send you a link to reset your password.
            </p>

            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (mutation.isPending || !email.trim()) return;
                mutation.mutate();
              }}
            >
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Email</label>
                <input
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  autoFocus
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <Button
                type="submit"
                disabled={mutation.isPending || !email.trim()}
                className={`w-full ${!email.trim() ? "opacity-50" : ""}`}
              >
                {mutation.isPending ? "Sending…" : "Send Reset Link"}
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
