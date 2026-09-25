import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { copyTextToClipboard } from "@/lib/clipboard";

export function buildSetupPrompt(instanceUrl: string, instructions: string) {
  let instanceOrigin: string | null = null;
  try {
    const url = new URL(instanceUrl);
    if (url.protocol === "http:" || url.protocol === "https:") instanceOrigin = url.origin;
  } catch {
    // A preview can have no configured instance. Do not substitute its own URL.
  }
  const context = instanceOrigin
    ? `Paperclip instance URL: ${instanceOrigin}\nUse this instance for setup. Do not ask me for its URL again unless it is unavailable or I ask to use a different instance.`
    : "Paperclip instance URL is unavailable. Ask me for it before starting setup.";
  return `${context}\n\n${instructions}`;
}

export function SetupPrompt({ prompt }: { prompt: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="gap-2 border-dashed text-muted-foreground"
        onClick={async () => {
          try {
            await copyTextToClipboard(prompt);
            setStatus("copied");
          } catch {
            setStatus("failed");
          }
        }}
      >
        <span className="flex -space-x-1" aria-hidden="true">
          <img src="/brands/claude-color.svg" alt="" className="size-4 rounded-full bg-background ring-2 ring-background" />
          <img src="/brands/codex-color.svg" alt="" className="size-4 rounded-full bg-background ring-2 ring-background" />
        </span>
        {status === "copied" ? "Copied setup prompt" : "Copy setup prompt"}
        {status === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      <span className="sr-only" role="status">{status === "copied" ? "Setup prompt copied. Paste it into Codex or Claude with browser tools." : ""}</span>
      {status === "failed" && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-muted-foreground">Could not copy automatically. Select and copy the setup prompt below.</p>
          <Textarea aria-label="Setup prompt" readOnly value={prompt} onFocus={(event) => event.currentTarget.select()} rows={8} />
        </div>
      )}
    </div>
  );
}
