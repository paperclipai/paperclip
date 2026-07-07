import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SecretMessage } from "./context";

/**
 * Shown right after a webhook trigger is created/rotated, or after a
 * revision restore recreates webhook secrets. Rendered at the routine-detail
 * level (not inside a single section) so it stays visible no matter which
 * section the user was on when they triggered the action — creating a
 * trigger from the Triggers section previously left the reveal banner
 * hidden inside the Secrets section, where non-technical operators would
 * never find it.
 */
export function SecretRevealBanner({
  secretMessage,
  onDismiss,
  onCopy,
}: {
  secretMessage: SecretMessage;
  onDismiss: () => void;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div className="mx-auto mb-4 w-full max-w-3xl space-y-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">{secretMessage.title}</p>
          <p className="text-xs text-muted-foreground">
            Save this now. Paperclip will not show the secret value again — use "Rotate secret" on the
            trigger if you lose it.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="space-y-3">
        {secretMessage.entries.map((entry, index) => {
          const urlId = `secret-reveal-url-${index}`;
          const secretId = `secret-reveal-secret-${index}`;
          return (
            <div key={`${entry.webhookUrl}-${index}`} className="space-y-2">
              <div className="space-y-1">
                <Label htmlFor={urlId} className="text-xs">
                  Webhook URL
                </Label>
                <div className="flex items-center gap-2">
                  <Input id={urlId} value={entry.webhookUrl} readOnly className="flex-1 font-mono text-xs" />
                  <Button variant="outline" size="sm" onClick={() => onCopy("Webhook URL", entry.webhookUrl)}>
                    Copy
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor={secretId} className="text-xs">
                  Webhook secret
                </Label>
                <div className="flex items-center gap-2">
                  <Input id={secretId} value={entry.webhookSecret} readOnly className="flex-1 font-mono text-xs" />
                  <Button variant="outline" size="sm" onClick={() => onCopy("Webhook secret", entry.webhookSecret)}>
                    Copy
                  </Button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
