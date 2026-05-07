import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { Loader2 } from "lucide-react";

export function SandboxSpinup() {
  const location = useLocation();
  const navigate = useNavigate();
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Initializing sandbox environment...");
  const startedRef = useRef(false);

  const apiKey = location.state?.apiKey;

  useEffect(() => {
    if (!apiKey) {
      navigate("/sandbox");
      return;
    }

    if (startedRef.current) return;
    startedRef.current = true;

    const createSandbox = async () => {
      try {
        // Show initial progress while calling the API
        setStatus("Creating demo company...");
        setProgress(20);

        const response = await fetch("/api/demo/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ anthropicApiKey: apiKey }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          const message =
            response.status === 429
              ? "You already have an active demo session. Please wait for it to expire."
              : response.status === 400
                ? (body.error ?? "Invalid Anthropic API key. Please check your key and try again.")
                : (body.error ?? "Failed to create sandbox. Please try again.");
          navigate("/sandbox", { state: { error: message } });
          return;
        }

        setStatus("Setting up agent team...");
        setProgress(60);

        const data = await response.json();
        const { companyId, agentId, agentApiKey, apiUrl, expiresAt } = data;

        setStatus("Starting agents...");
        setProgress(90);

        // Brief pause to show completion before navigating
        await new Promise((resolve) => setTimeout(resolve, 500));
        setProgress(100);

        // Navigate to live view with sandbox credentials
        navigate("/sandbox/live", {
          state: { companyId, agentId, agentApiKey, apiUrl, expiresAt },
        });
      } catch (err) {
        console.error("Sandbox creation failed:", err);
        navigate("/sandbox", {
          state: { error: "Failed to create sandbox. Please check your connection and try again." },
        });
      }
    };

    createSandbox();
  }, [apiKey, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-6 max-w-md">
        <div className="relative">
          <Loader2 className="w-16 h-16 mx-auto animate-spin text-primary" />
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl font-semibold">Setting up your sandbox...</h2>
          <p className="text-muted-foreground">{status}</p>
        </div>

        <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
          <div
            className="bg-primary h-full transition-all duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>

        <p className="text-sm text-muted-foreground">
          This usually takes less than 30 seconds
        </p>
      </div>
    </div>
  );
}
