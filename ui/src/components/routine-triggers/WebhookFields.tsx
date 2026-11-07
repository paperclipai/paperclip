import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { copyTextToClipboard } from "@/lib/clipboard";
import { AgentSetupPrompt } from "@/components/AgentSetupPrompt";

export function CopyField({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  help?: string;
}) {
  useTranslation("task-components");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
        <code title={value} className="min-w-0 flex-1 truncate text-xs">
          {value}
        </code>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("task-components:copy_9776bafb", { value1: label })}
          onClick={async () => {
            try {
              await copyTextToClipboard(value);
              setCopied(true);
              setError(false);
            } catch {
              setError(true);
            }
          }}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? t("task-components:copied_8d525e5f") : t("task-components:copy_e21f935f")}
        </Button>
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      {error && (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">{t("task-components:copyFailedSelectAndCopyTheText_7a858143")}</p>
          <textarea
            readOnly
            aria-label={t("task-components:text_44454725", { value1: label })}
            value={value}
            rows={5}
            className="w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
          />
        </div>
      )}
    </div>
  );
}

export function AgentInstructions({ value }: { value: string }) {
  useTranslation("task-components");
  return (
    <section
      aria-label={t("task-components:agentInstructions_dc390e18")}
      className="space-y-3 rounded-md bg-muted/40 p-4"
    >
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t("task-components:agentInstructions_dc390e18")}</h2>
        <p className="text-sm text-muted-foreground">{t("task-components:giveYourAgentEverythingItNeedsTo_ea90b46a")}</p>
      </div>
      <AgentSetupPrompt
        prompt={value}
        label={t("task-components:copyForYourAgent_64d2d48d")}
        title={t("task-components:webhookSetup_25f5e2b7")}
        description={t("task-components:pasteThisIntoYourAgentToConnect_9c0e1f1b")}
      />
    </section>
  );
}
