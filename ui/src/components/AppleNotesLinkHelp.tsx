import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function AppleNotesLinkHelp() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="h-7 w-7 text-muted-foreground"
            aria-label="Apple Notes link help"
          >
            <Info className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs space-y-1.5 text-left leading-4">
          <p>For the most reliable shareable link, use Apple Notes share/collaborate and copy an iCloud note link.</p>
          <p>iCloud links may open in Notes on signed-in Apple devices, but can fall back to iCloud/web depending on OS, browser, and account state.</p>
          <p>For native app-opening behavior, paste a Notes-compatible deep link from the tool/workflow that generated it. Paperclip stores and opens the link but does not synthesize private Apple Notes IDs.</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
