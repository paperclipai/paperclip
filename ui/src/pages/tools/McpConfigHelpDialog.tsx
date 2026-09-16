import { useEffect, useRef, useState } from "react";
import { Check, Copy, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { copyTextToClipboard } from "@/lib/clipboard";
import { MCP_CONFIG_HELP_INSTRUCTIONS, MCP_CONFIG_HELP_PROMPT } from "@paperclipai/shared";

const COPIED_RESET_MS = 2_000;

/**
 * Compact question-mark help beside the Paste-a-config copy (PAP-17087, plan 3A).
 *
 * Purely static: it renders a constant prompt and copies it. It deliberately has
 * no props, no company id, and no access to the textarea, so opening or copying
 * it cannot create a connection, call an agent, submit the pasted config, or leak
 * anything the operator has typed.
 */
export function McpConfigHelpDialog() {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  // Reset the copy affordance each time the dialog opens, so a stale "Copied"
  // from a previous visit never reads as confirmation of this one.
  useEffect(() => {
    if (open) setCopyState("idle");
  }, [open]);

  const copyPrompt = async () => {
    try {
      await copyTextToClipboard(MCP_CONFIG_HELP_PROMPT);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), COPIED_RESET_MS);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Get help creating an MCP config"
        >
          <HelpCircle className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-(--sz-85vh) overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Ask an agent for an MCP config</DialogTitle>
          <DialogDescription>
            Don't know the URL or headers a tool needs? Hand this request to an agent and paste back what it
            gives you.
          </DialogDescription>
        </DialogHeader>

        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
          {MCP_CONFIG_HELP_INSTRUCTIONS.map((instruction) => (
            <li key={instruction}>{instruction}</li>
          ))}
        </ol>

        <div className="space-y-2">
          <label htmlFor="mcp-config-help-prompt" className="text-sm font-medium text-foreground">
            Prompt to send
          </label>
          <Textarea
            id="mcp-config-help-prompt"
            readOnly
            value={MCP_CONFIG_HELP_PROMPT}
            rows={12}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-(--sz-220px) font-mono text-(length:--text-compact) leading-relaxed"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void copyPrompt()}>
            {copyState === "copied" ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
            Copy prompt
          </Button>
          {/* aria-live so a screen reader hears the outcome without moving focus
              off the button the operator just pressed. */}
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {copyState === "copied"
              ? "Copied to clipboard."
              : copyState === "failed"
                ? "Couldn't copy automatically — select the text above and copy it."
                : null}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
