import { useEffect, useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Hammer, AlertCircle, Loader2, CheckCircle } from "lucide-react";

interface SetupResponse {
  companyId: string;
  userId: string;
  redirectUrl: string;
}

async function postSetup(body: {
  checkoutId: string;
  companyName: string;
  userName: string;
  email: string;
  password: string;
  tosAccepted: boolean;
}): Promise<SetupResponse> {
  const res = await fetch("/api/setup", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (payload as { error?: string } | null)?.error ?? `Setup failed (${res.status})`;
    throw new Error(message);
  }
  return payload as SetupResponse;
}

export function SetupPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const checkoutId = useMemo(() => searchParams.get("checkout_id") ?? "", [searchParams]);

  const [companyName, setCompanyName] = useState("");
  const [userName, setUserName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [tosAccepted, setTosAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  // If user already has a session, redirect them
  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    if (session) {
      navigate("/dashboard", { replace: true });
    }
  }, [session, navigate]);

  // Validation
  const validationError = useMemo(() => {
    if (!checkoutId) return "Missing checkout_id. Please complete checkout first.";
    if (password && password.length < 8) return "Password must be at least 8 characters.";
    if (password && confirmPassword && password !== confirmPassword) return "Passwords do not match.";
    return null;
  }, [checkoutId, password, confirmPassword]);

  const canSubmit =
    checkoutId.length > 0 &&
    companyName.trim().length > 0 &&
    userName.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= 8 &&
    password === confirmPassword &&
    tosAccepted;

  const mutation = useMutation({
    mutationFn: () =>
      postSetup({
        checkoutId,
        companyName: companyName.trim(),
        userName: userName.trim(),
        email: email.trim(),
        password,
        tosAccepted,
      }),
    onSuccess: async (data) => {
      setError(null);
      setCompleted(true);
      // Invalidate session cache so the app picks up the new session cookie
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      // Brief pause so the user sees the success state
      setTimeout(() => {
        navigate(data.redirectUrl || "/dashboard", { replace: true });
      }, 800);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Setup failed. Please try again.");
    },
  });

  if (isSessionLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!checkoutId) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="max-w-md px-8 text-center">
          <AlertCircle className="mx-auto h-8 w-8 text-destructive mb-4" />
          <h1 className="text-xl font-semibold">Invalid Setup Link</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page requires a valid checkout. Please start from the pricing page.
          </p>
        </div>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <div className="max-w-md px-8 text-center">
          <CheckCircle className="mx-auto h-8 w-8 text-green-500 mb-4" />
          <h1 className="text-xl font-semibold">You're all set!</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Redirecting you to your dashboard...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      {/* Left half -- form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Hammer className="h-4 w-4 text-blue-500" aria-hidden="true" />
            <span className="text-sm font-medium">Ironworks</span>
          </div>

          <h1 className="text-xl font-semibold">Set up your company</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Payment confirmed. Create your account to get started.
          </p>

          <form
            className="mt-6 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (mutation.isPending) return;
              if (!canSubmit) {
                setError(validationError ?? "Please fill in all required fields.");
                return;
              }
              setError(null);
              mutation.mutate();
            }}
          >
            <div>
              <label htmlFor="companyName" className="text-xs text-muted-foreground mb-1 block">
                Company Name
              </label>
              <Input
                id="companyName"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Acme Corp"
                autoFocus
                maxLength={100}
              />
            </div>

            <div>
              <label htmlFor="userName" className="text-xs text-muted-foreground mb-1 block">
                Your Name
              </label>
              <Input
                id="userName"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Jane Smith"
                autoComplete="name"
                maxLength={100}
              />
            </div>

            <div>
              <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">
                Email
              </label>
              <Input
                id="email"
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@acme.com"
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="password" className="text-xs text-muted-foreground mb-1 block">
                Password
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                autoComplete="new-password"
                minLength={8}
              />
            </div>

            <div>
              <label htmlFor="confirmPassword" className="text-xs text-muted-foreground mb-1 block">
                Confirm Password
              </label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repeat your password"
                autoComplete="new-password"
              />
            </div>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={tosAccepted}
                onChange={(e) => setTosAccepted(e.target.checked)}
                className="mt-1 rounded border-border"
              />
              <span className="text-xs text-muted-foreground">
                I agree to the{" "}
                <a
                  href="/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-foreground"
                >
                  Terms of Service
                </a>{" "}
                and{" "}
                <a
                  href="/aup"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-foreground"
                >
                  Acceptable Use Policy
                </a>
              </span>
            </label>

            {(error || validationError) && (
              <p role="alert" className="text-xs text-destructive">
                {error ?? validationError}
              </p>
            )}

            <Button
              type="submit"
              disabled={mutation.isPending}
              aria-disabled={!canSubmit || mutation.isPending}
              className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
            >
              {mutation.isPending ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating your company...
                </span>
              ) : (
                "Create Your Company"
              )}
            </Button>
          </form>

          <div className="mt-5 text-sm text-muted-foreground">
            Already have an account?{" "}
            <a
              href="/auth"
              className="font-medium text-foreground underline underline-offset-2"
            >
              Sign in
            </a>
          </div>
        </div>
      </div>

      {/* Right half -- ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
