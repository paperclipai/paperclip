import { useEffect, useState } from "react";
import { useNavigate } from "@/lib/router";
import { providerAuthApi, type AnthropicAuthState, type OpenAiAuthState } from "../api/provider-auth";
import { Button } from "@/components/ui/button";
import { AsciiArtAnimation } from "@/components/AsciiArtAnimation";
import { Cpu, CheckCircle2, XCircle, Loader2, ExternalLink } from "lucide-react";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: "bg-muted text-muted-foreground",
    starting: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
    waiting: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    complete: "bg-green-500/10 text-green-600 dark:text-green-400",
    failed: "bg-red-500/10 text-red-600 dark:text-red-400",
    canceled: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] || colors.idle}`}>
      {status}
    </span>
  );
}

function ClaudeCodeCard({
  state,
  onRefresh,
}: {
  state: AnthropicAuthState | null;
  onRefresh: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isActive = state?.status === "starting" || state?.status === "waiting";
  const isComplete = state?.status === "complete" || state?.authDetected;

  async function handleStart() {
    setError(null);
    setLoading(true);
    try {
      const result = await providerAuthApi.startAnthropic();
      if (result.verificationUrl) {
        window.open(result.verificationUrl, "_blank", "noopener");
      }
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitCode() {
    if (!code.trim()) return;
    setError(null);
    setLoading(true);
    try {
      await providerAuthApi.submitAnthropicCode(code.trim());
      setCode("");
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit code");
    } finally {
      setLoading(false);
    }
  }

  async function handleCancel() {
    setError(null);
    try {
      await providerAuthApi.cancelAnthropic();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel");
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Claude Code</h3>
        {state && <StatusBadge status={state.status} />}
      </div>

      {isComplete && (
        <div className="flex items-start gap-2 text-sm text-green-600 dark:text-green-400 mb-3">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Connected</p>
            {state?.email && <p className="text-xs text-muted-foreground">{state.email}</p>}
            {state?.organizationName && (
              <p className="text-xs text-muted-foreground">Org: {state.organizationName}</p>
            )}
            {state?.subscriptionType && (
              <p className="text-xs text-muted-foreground">Plan: {state.subscriptionType}</p>
            )}
          </div>
        </div>
      )}

      {isActive && (
        <div className="space-y-3 mb-3">
          <p className="text-xs text-muted-foreground">
            A sign-in window should have opened. Complete the authorization, then paste the callback URL or code below.
          </p>
          {state?.verificationUrl && (
            <a
              href={state.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 underline"
            >
              Open sign-in page <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md border border-border bg-transparent px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground/50"
              placeholder="Paste callback URL or code#state"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button size="sm" onClick={handleSubmitCode} disabled={!code.trim() || loading}>
              Submit
            </Button>
          </div>
        </div>
      )}

      {(state?.error || error) && (
        <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 mb-3">
          <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
          <p>{state?.error || error}</p>
        </div>
      )}

      <div className="flex gap-2">
        {!isComplete && !isActive && (
          <Button size="sm" onClick={handleStart} disabled={loading}>
            {loading ? <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Starting...</> : "Connect Claude Code"}
          </Button>
        )}
        {isActive && (
          <Button size="sm" variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
        )}
        {isComplete && (
          <Button size="sm" variant="outline" onClick={handleStart}>
            Reconnect
          </Button>
        )}
      </div>
    </div>
  );
}

function CodexCard({
  state,
  onRefresh,
}: {
  state: OpenAiAuthState | null;
  onRefresh: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isActive = state?.status === "starting" || state?.status === "waiting";
  const isComplete = state?.status === "complete" || state?.authDetected;

  async function handleStart() {
    setError(null);
    setLoading(true);
    try {
      await providerAuthApi.startOpenAi();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setLoading(false);
    }
  }

  async function handleCancel() {
    setError(null);
    try {
      await providerAuthApi.cancelOpenAi();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel");
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Codex CLI</h3>
        {state && <StatusBadge status={state.status} />}
      </div>

      {isComplete && (
        <div className="flex items-start gap-2 text-sm text-green-600 dark:text-green-400 mb-3">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <p className="font-medium">Connected</p>
        </div>
      )}

      {isActive && state?.userCode && (
        <div className="space-y-3 mb-3">
          <p className="text-xs text-muted-foreground">
            Enter this code at the OpenAI verification page:
          </p>
          <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-center">
            <code className="text-lg font-mono font-bold tracking-widest">{state.userCode}</code>
          </div>
          {state.verificationUrl && (
            <a
              href={state.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 underline"
            >
              Open verification page <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <p className="text-xs text-muted-foreground">
            Waiting for authorization... This will update automatically.
          </p>
        </div>
      )}

      {isActive && !state?.userCode && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
          <Loader2 className="h-3 w-3 animate-spin" />
          <p>Starting Codex login...</p>
        </div>
      )}

      {(state?.error || error) && (
        <div className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 mb-3">
          <XCircle className="h-3 w-3 mt-0.5 shrink-0" />
          <p>{state?.error || error}</p>
        </div>
      )}

      <div className="flex gap-2">
        {!isComplete && !isActive && (
          <Button size="sm" onClick={handleStart} disabled={loading}>
            {loading ? <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Starting...</> : "Connect Codex"}
          </Button>
        )}
        {isActive && (
          <Button size="sm" variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
        )}
        {isComplete && (
          <Button size="sm" variant="outline" onClick={handleStart}>
            Reconnect
          </Button>
        )}
      </div>
    </div>
  );
}

export function ProviderAuthPage({ showSkip = false }: { showSkip?: boolean }) {
  const navigate = useNavigate();
  const [anthropic, setAnthropic] = useState<AnthropicAuthState | null>(null);
  const [openai, setOpenai] = useState<OpenAiAuthState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function loadStatus() {
    try {
      const status = await providerAuthApi.getStatus();
      setAnthropic(status.anthropic);
      setOpenai(status.openai);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load provider status");
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  // Poll while any auth flow is active
  useEffect(() => {
    const isActive =
      anthropic?.status === "starting" ||
      anthropic?.status === "waiting" ||
      openai?.status === "starting" ||
      openai?.status === "waiting";

    if (!isActive) return;

    const interval = setInterval(loadStatus, 2000);
    return () => clearInterval(interval);
  }, [anthropic?.status, openai?.status]);

  return (
    <div className="fixed inset-0 flex bg-background">
      <div className="w-full md:w-1/2 flex flex-col overflow-y-auto">
        <div className="w-full max-w-lg mx-auto my-auto px-8 py-12">
          <div className="flex items-center gap-2 mb-8">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Paperclip Provider Setup</span>
          </div>

          <h1 className="text-xl font-semibold">Connect AI providers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to Claude Code and/or Codex CLI so Paperclip agents can run on this server.
            You need at least one provider connected.
          </p>

          {loadError && (
            <p className="mt-4 text-xs text-destructive">{loadError}</p>
          )}

          <div className="mt-6 space-y-4">
            <ClaudeCodeCard state={anthropic} onRefresh={loadStatus} />
            <CodexCard state={openai} onRefresh={loadStatus} />
          </div>

          {showSkip && (
            <div className="mt-8 pt-6 border-t border-border flex items-center justify-between">
              <div>
                <button
                  type="button"
                  className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
                  onClick={() => navigate("/", { replace: true })}
                >
                  Skip — set up providers later
                </button>
                <p className="mt-1 text-xs text-muted-foreground">
                  You can connect providers from Instance Settings at any time.
                </p>
              </div>
              {(anthropic?.authDetected || openai?.authDetected) && (
                <Button onClick={() => navigate("/", { replace: true })}>
                  Continue
                </Button>
              )}
            </div>
          )}

          {!showSkip && (
            <div className="mt-8 pt-6 border-t border-border">
              <Button variant="outline" onClick={() => navigate(-1)}>
                Back
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="hidden md:block w-1/2 overflow-hidden">
        <AsciiArtAnimation />
      </div>
    </div>
  );
}
