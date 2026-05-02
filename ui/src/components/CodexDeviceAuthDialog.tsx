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
            Three steps. Takes about 20 seconds.
          </DialogDescription>
        </DialogHeader>
        {state?.status === "starting" || !state ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />
            Generating a one-time code...
          </div>
        ) : state.status === "awaiting_user" ? (
          <div className="space-y-4 py-2">
            <ol className="space-y-4 text-sm">
              <li className="space-y-2">
                <div>
                  <span className="font-medium">1.</span> Click the link below (opens openai.com in
                  a new tab).
                </div>
                {state.verificationUrl && (
                  <a
                    href={state.verificationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open openai.com
                  </a>
                )}
              </li>
              <li className="space-y-2">
                <div>
                  <span className="font-medium">2.</span> Paste this code on the openai.com page.
                </div>
                {state.userCode && (
                  <div className="group relative flex items-center justify-between rounded-md border border-border bg-muted px-4 py-3">
                    <code className="font-mono text-2xl font-semibold tracking-[0.3em]">
                      {state.userCode}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                      onClick={copyCode}
                      aria-label="Copy code"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </li>
              <li>
                <span className="font-medium">3.</span> Click "Approve" on the openai.com page.
              </li>
            </ol>
            <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              Once you click Approve at openai.com, this dialog will close automatically.
            </div>
            <p className="text-[11px] text-muted-foreground/80 leading-relaxed">
              Setup once: open ChatGPT &rarr; Settings &rarr; Security &rarr; enable "Device Code
              Login". Required only the first time.
            </p>
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
