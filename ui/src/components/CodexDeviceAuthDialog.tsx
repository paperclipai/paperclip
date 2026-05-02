import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  XCircle,
} from "lucide-react";

// Shared shape mirroring both the agent-scoped poll response
// (CodexLoginPollResponse from api/agents.ts) and the credential-scoped one
// (CodexCredDeviceAuthPollResponse from api/credentials.ts). The dialog only
// reads the fields it needs and is provider-agnostic.
export interface CodexDeviceAuthState {
  status: "starting" | "awaiting_user" | "success" | "error";
  verificationUrl: string | null;
  userCode: string | null;
  error: string | null;
  errorCode: "timeout" | "denied" | "device_code_disabled" | "infra" | null;
  stderr?: string;
}

export interface CodexDeviceAuthDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: CodexDeviceAuthState | null;
  // Success message body (e.g. "Refreshing agent..." or "Captured. Saving...").
  successMessage?: string;
  // Footer button label override (defaults to "Cancel" / "Close" based on status).
  cancelLabel?: string;
}

export function CodexDeviceAuthDialog({
  open,
  onOpenChange,
  state,
  successMessage = "Login successful.",
  cancelLabel,
}: CodexDeviceAuthDialogProps) {
  const close = () => onOpenChange(false);

  const copyCode = async () => {
    const code = state?.userCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // best-effort; clipboard may be blocked in non-secure contexts
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in with ChatGPT</DialogTitle>
          <DialogDescription>
            First time? Enable <span className="font-medium">Device Code Login</span> in your ChatGPT
            account security settings before continuing.
          </DialogDescription>
        </DialogHeader>
        {state?.status === "starting" || !state ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Requesting a device code...
          </div>
        ) : state.status === "awaiting_user" ? (
          <div className="space-y-4 py-2">
            <ol className="list-decimal pl-5 text-sm space-y-2">
              <li>
                Open the verification URL:
                {state.verificationUrl && (
                  <div className="mt-1 flex items-center gap-2">
                    <a
                      href={state.verificationUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 underline underline-offset-2 break-all dark:text-blue-400 inline-flex items-center gap-1"
                    >
                      {state.verificationUrl}
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  </div>
                )}
              </li>
              <li>
                Enter this code:
                {state.userCode && (
                  <div className="mt-1 flex items-center gap-2">
                    <code className="rounded bg-muted px-2 py-1 font-mono text-base tracking-widest">
                      {state.userCode}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      onClick={copyCode}
                      aria-label="Copy code"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </li>
              <li>Approve the request in your browser.</li>
            </ol>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Waiting for you to approve in browser...
            </div>
          </div>
        ) : state.status === "success" ? (
          <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400 py-4">
            <CheckCircle2 className="h-4 w-4" />
            {successMessage}
          </div>
        ) : (
          <div className="space-y-2 py-2">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{state.error ?? "Login failed."}</span>
            </div>
            {state.errorCode === "device_code_disabled" && (
              <p className="text-xs text-muted-foreground">
                Open ChatGPT, go to Settings &rarr; Security, and enable "Device Code Login". Then
                try again.
              </p>
            )}
            {!!state.stderr && (
              <pre className="bg-neutral-100 dark:bg-neutral-950 rounded-md p-2 text-xs font-mono text-red-700 dark:text-red-300 overflow-x-auto whitespace-pre-wrap max-h-32">
                {state.stderr}
              </pre>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={close}>
            {cancelLabel ?? (state?.status === "success" ? "Close" : "Cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
