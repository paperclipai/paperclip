import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import { Loader2 } from "lucide-react";

export function SandboxSpinup() {
  const location = useLocation();
  const navigate = useNavigate();
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Initializing sandbox environment...");

  const apiKey = location.state?.apiKey;

  useEffect(() => {
    if (!apiKey) {
      navigate("/sandbox");
      return;
    }

    const createSandbox = async () => {
      try {
        // Simulate progress updates
        const statuses = [
          "Creating demo company...",
          "Setting up agent team...",
          "Loading sample tasks...",
          "Starting agents...",
        ];

        for (let i = 0; i < statuses.length; i++) {
          setStatus(statuses[i]);
          setProgress(((i + 1) / statuses.length) * 100);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        // TODO: Call backend API to create sandbox
        // Expected: POST /api/sandbox/create
        // Body: { apiKey }
        // Response: { token, companyId, expiresAt }

        // Mock response for now
        const mockToken = "demo-" + Math.random().toString(36).substring(7);

        // Navigate to live view with demo token
        navigate(`/sandbox/live?token=${mockToken}`);
      } catch (err) {
        console.error("Sandbox creation failed:", err);
        navigate("/sandbox", {
          state: { error: "Failed to create sandbox. Please try again." },
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
