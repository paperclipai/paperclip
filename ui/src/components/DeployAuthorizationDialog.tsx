import { useEffect, useState } from "react";
import { Check, Copy, ShieldAlert } from "lucide-react";
import {
  DEPLOY_AUTHORIZATION_ISSUED_EVENT,
  type OneTimeDeployAuthorization,
} from "../api/issues";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function DeployAuthorizationDialog() {
  const [queue, setQueue] = useState<OneTimeDeployAuthorization[]>([]);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const authorization = queue[0] ?? null;

  useEffect(() => {
    const handleAuthorization = (event: Event) => {
      const detail = (event as CustomEvent<OneTimeDeployAuthorization>).detail;
      if (!detail?.token) return;
      setQueue((current) => [
        ...current.filter((entry) => entry.id !== detail.id),
        detail,
      ]);
    };
    window.addEventListener(DEPLOY_AUTHORIZATION_ISSUED_EVENT, handleAuthorization);
    return () => window.removeEventListener(DEPLOY_AUTHORIZATION_ISSUED_EVENT, handleAuthorization);
  }, []);

  useEffect(() => {
    setCopied(false);
    setCopyError(null);
  }, [authorization?.id]);

  if (!authorization) return null;

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(authorization.token);
      setCopied(true);
      setCopyError(null);
    } catch {
      setCopied(false);
      setCopyError("Clipboard access failed. Select and copy the token manually before continuing.");
    }
  };

  const acknowledgeSaved = () => {
    setQueue((current) => current.slice(1));
  };

  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" aria-hidden />
            Save the one-time deploy token
          </DialogTitle>
          <DialogDescription>
            Paperclip will not show this token again. Store it in the deployment agent's
            protected credential file before dismissing this dialog.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">Sequence</span>
            <span className="font-medium">{authorization.sequence}</span>
            <span className="text-muted-foreground">Target</span>
            <span className="font-medium">{authorization.targetHost}</span>
            <span className="text-muted-foreground">Expires</span>
            <span className="font-medium">{authorization.expiresAt}</span>
          </div>
          <code
            className="block max-h-40 overflow-auto break-all rounded-md border bg-muted/40 p-3 text-xs"
            data-testid="one-time-deploy-token"
          >
            {authorization.token}
          </code>
          {copyError ? (
            <p className="text-sm text-destructive" role="alert">{copyError}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => void copyToken()}>
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            {copied ? "Copied" : "Copy token"}
          </Button>
          <Button onClick={acknowledgeSaved}>I saved the token</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
