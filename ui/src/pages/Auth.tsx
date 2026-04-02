import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { healthApi } from "../api/health";
import { fleetosAuthApi } from "../api/fleetos";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Sparkles } from "lucide-react";

type AuthMode = "sign_in" | "sign_up";

/**
 * Renders a sign-in form that authenticates using a FleetOS API key.
 *
 * On successful authentication, clears any error, invalidates the auth session
 * and companies caches, and navigates to `nextPath` with replace behavior.
 *
 * @param nextPath - The path to navigate to after successful authentication
 */
function FleetosApiKeyForm({
  nextPath,
}: {
  nextPath: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      await fleetosAuthApi.login(apiKey.trim());
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Invalid API key");
    },
  });

  const canSubmit = apiKey.trim().length > 0;

  return (
    <>
      <h1 className="text-xl font-semibold">Sign in to Raava</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Enter your FleetOS API key to access this instance.
      </p>

      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (mutation.isPending || !canSubmit) return;
          mutation.mutate();
        }}
      >
        <div>
          <label htmlFor="apiKey" className="text-xs text-muted-foreground mb-1 block">API Key</label>
          <input
            id="apiKey"
            name="apiKey"
            className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
            type="password"
            placeholder="Enter your FleetOS API key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
            autoFocus
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button
          type="submit"
          disabled={mutation.isPending}
          aria-disabled={!canSubmit || mutation.isPending}
          className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
        >
          {mutation.isPending ? "Authenticating..." : "Sign In with API Key"}
        </Button>
      </form>
    </>
  );
}

/**
 * Renders the authentication page and handles sign-in/sign-up flows and session routing.
 *
 * Shows a loading state while session or app health are being fetched, displays a retryable error if health fails to load, and redirects to `next` when a session is present. When healthy, selects between FleetOS API-key authentication and an email/password sign-in or sign-up form, manages form state and validation, performs authentication mutations, invalidates relevant queries on success, and navigates to the configured next path.
 *
 * @returns The rendered authentication page element.
 */
export function AuthPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<AuthMode>("sign_in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const nextPath = useMemo(() => searchParams.get("next") || "/", [searchParams]);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    staleTime: 60_000,
  });

  const isFleetosMode = healthQuery.data?.deploymentMode === "fleetos";

  const { data: session, isLoading: isSessionLoading } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  useEffect(() => {
    if (session) {
      navigate(nextPath, { replace: true });
    }
  }, [session, navigate, nextPath]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate(nextPath, { replace: true });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Authentication failed");
    },
  });

  const canSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (mode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  if (isSessionLoading || healthQuery.isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (healthQuery.error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-sm text-destructive">
            {healthQuery.error instanceof Error ? healthQuery.error.message : "Failed to load app configuration"}
          </p>
          <Button variant="outline" size="sm" onClick={() => healthQuery.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex bg-background">
      {/* Left half — form */}
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Raava</span>
          </div>

          {isFleetosMode ? (
            <FleetosApiKeyForm nextPath={nextPath} />
          ) : (
            <>
              <h1 className="text-xl font-semibold">
                {mode === "sign_in" ? "Sign in to Raava" : "Create your Raava account"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {mode === "sign_in"
                  ? "Use your email and password to access this instance."
                  : "Create an account for this instance. Email confirmation is not required in v1."}
              </p>

              <form
                className="mt-6 space-y-4"
                method="post"
                action={mode === "sign_up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email"}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (mutation.isPending) return;
                  if (!canSubmit) {
                    setError("Please fill in all required fields.");
                    return;
                  }
                  mutation.mutate();
                }}
              >
                {mode === "sign_up" && (
                  <div>
                    <label htmlFor="name" className="text-xs text-muted-foreground mb-1 block">Name</label>
                    <input
                      id="name"
                      name="name"
                      className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      autoComplete="name"
                      autoFocus
                    />
                  </div>
                )}
                <div>
                  <label htmlFor="email" className="text-xs text-muted-foreground mb-1 block">Email</label>
                  <input
                    id="email"
                    name="email"
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    autoFocus={mode === "sign_in"}
                  />
                </div>
                <div>
                  <label htmlFor="password" className="text-xs text-muted-foreground mb-1 block">Password</label>
                  <input
                    id="password"
                    name="password"
                    className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                  />
                </div>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <Button
                  type="submit"
                  disabled={mutation.isPending}
                  aria-disabled={!canSubmit || mutation.isPending}
                  className={`w-full ${!canSubmit && !mutation.isPending ? "opacity-50" : ""}`}
                >
                  {mutation.isPending
                    ? "Working…"
                    : mode === "sign_in"
                      ? "Sign In"
                      : "Create Account"}
                </Button>
              </form>

              <div className="mt-5 text-sm text-muted-foreground">
                {mode === "sign_in" ? "Need an account?" : "Already have an account?"}{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-2"
                  onClick={() => {
                    setError(null);
                    setMode(mode === "sign_in" ? "sign_up" : "sign_in");
                  }}
                >
                  {mode === "sign_in" ? "Create one" : "Sign in"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right half — ASCII art animation (hidden on mobile) */}
      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
