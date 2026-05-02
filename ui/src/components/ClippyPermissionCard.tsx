import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  toolName: string;
  input: unknown;
  onApprove: () => void;
  onDeny: () => void;
}

export function ClippyPermissionCard({ toolName, input, onApprove, onDeny }: Props) {
  return (
    <div className="my-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/30">
      <div className="mb-2 flex items-center gap-1.5 text-amber-900 dark:text-amber-300">
        <ShieldAlert className="h-3.5 w-3.5" />
        <span className="font-medium">Clippy wants to run a tool</span>
      </div>
      <div className="mb-2 flex items-baseline gap-1.5">
        <span className="text-[10px] uppercase text-muted-foreground">Tool</span>
        <span className="font-mono">{toolName}</span>
      </div>
      <div className="mb-3">
        <div className="mb-1 text-[10px] uppercase text-muted-foreground">Input</div>
        <pre className="max-h-40 overflow-auto rounded bg-background/60 p-1.5 text-[11px]">
          {JSON.stringify(input, null, 2)}
        </pre>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onApprove}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" onClick={onDeny}>
          Deny
        </Button>
      </div>
    </div>
  );
}
