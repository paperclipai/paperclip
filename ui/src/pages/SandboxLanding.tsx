import { useState } from "react";
import { useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles } from "lucide-react";

export function SandboxLanding() {
  const navigate = useNavigate();
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStartSandbox = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!apiKey.trim()) {
      setError("Please enter your Anthropic API key");
      return;
    }

    if (!apiKey.startsWith("sk-ant-")) {
      setError("Invalid API key format. Anthropic keys start with 'sk-ant-'");
      return;
    }

    setLoading(true);

    try {
      // TODO: Call backend API endpoint to create demo company
      // Expected: POST /api/sandbox/create with { apiKey }
      // Response: { token, companyId, expiresAt }

      // For now, navigate to spinup with API key in state
      navigate("/sandbox/spinup", { state: { apiKey } });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start sandbox");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted/20 px-4">
      <div className="w-full max-w-2xl">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
            <Sparkles className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-4">
            Watch AI agents work on real software tasks — live
          </h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Paperclip is an AI agent company platform. See autonomous agents collaborate,
            write code, and complete tasks in real-time. This sandbox gives you a live view
            into a working agent team.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-card p-8 shadow-lg">
          <form onSubmit={handleStartSandbox} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="apiKey" className="text-base">
                Your Anthropic API key
              </Label>
              <Input
                id="apiKey"
                type="password"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={loading}
                className="h-12 text-base"
                autoComplete="off"
                autoFocus
              />
              <p className="text-sm text-muted-foreground">
                Your key is used only for this session and never stored.
                Get a key at{" "}
                <a
                  href="https://console.anthropic.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  console.anthropic.com
                </a>
              </p>
            </div>

            {error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              className="w-full h-12 text-base"
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Starting sandbox...
                </>
              ) : (
                "Start sandbox"
              )}
            </Button>
          </form>
        </div>

        <div className="mt-6 text-center">
          <p className="text-sm text-muted-foreground">
            This demo creates a temporary company that expires in 60 minutes
          </p>
        </div>
      </div>
    </div>
  );
}
