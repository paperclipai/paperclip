import { useEffect, useState } from "react";
import { useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const email = searchParams.get("email");
  const [status, setStatus] = useState<"verifying" | "success" | "error" | "check-inbox">(
    token ? "verifying" : "check-inbox",
  );
  const [error, setError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (!token) return;
    authApi
      .verifyEmail(token)
      .then(() => setStatus("success"))
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Verification failed");
        setStatus("error");
      });
  }, [token]);

  const handleResend = async () => {
    if (!email || resending) return;
    setResending(true);
    try {
      await authApi.resendVerificationEmail(email);
      setResent(true);
    } catch {
      setError("Failed to resend verification email.");
    } finally {
      setResending(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-md px-8">
        <div className="flex items-center gap-2 mb-8">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Paperclip</span>
        </div>

        {status === "verifying" && (
          <>
            <h1 className="text-xl font-semibold">Verifying your email</h1>
            <p className="mt-2 text-sm text-muted-foreground">Please wait...</p>
          </>
        )}

        {status === "success" && (
          <>
            <h1 className="text-xl font-semibold">Email verified</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Your email has been verified. You can now sign in.
            </p>
            <div className="mt-6">
              <Button asChild className="w-full">
                <a href="/auth">Sign in</a>
              </Button>
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <h1 className="text-xl font-semibold">Verification failed</h1>
            <p className="mt-2 text-sm text-destructive">{error}</p>
            <div className="mt-6">
              <Button asChild variant="outline" className="w-full">
                <a href="/auth">Back to sign in</a>
              </Button>
            </div>
          </>
        )}

        {status === "check-inbox" && (
          <>
            <h1 className="text-xl font-semibold">Check your email</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              We sent a verification link to{" "}
              {email ? <strong>{email}</strong> : "your email address"}.
              Click the link to verify your account.
            </p>
            {email && (
              <div className="mt-6">
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={resending || resent}
                  onClick={handleResend}
                >
                  {resent ? "Email sent" : resending ? "Sending..." : "Resend verification email"}
                </Button>
              </div>
            )}
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
            <div className="mt-3 text-sm text-muted-foreground">
              <a href="/auth" className="font-medium text-foreground underline underline-offset-2">
                Back to sign in
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
