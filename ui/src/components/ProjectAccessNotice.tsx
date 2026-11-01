import { ShieldCheck, ShieldX, ArrowRight } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export interface ProjectAccessNoticeProps {
  agentName?: string;
  projectName?: string;
  ready: boolean;
  canManage: boolean;
  canRetry: boolean;
  onManage: () => void;
  onRetry: () => void;
  error?: Error | null;
  className?: string;
}

export function ProjectAccessNotice({ agentName = "This agent", projectName, ready, canManage, canRetry, onManage, onRetry, error, className }: ProjectAccessNoticeProps) {
  return <section role={ready ? "status" : "alert"} aria-label="Project access" className={cn("space-y-4 rounded-lg border border-border p-4", className)}>
    <div className="flex items-start gap-3">
      {ready ? <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden /> : <ShieldX className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />}
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold">{ready ? "Project access is ready" : `${agentName} can’t access this project`}</h3>
        <p className="text-sm text-muted-foreground">{ready
          ? "The agent can now access the required project. Retry to continue with your saved message."
          : `This task needs ${projectName ?? "a project"} outside the agent’s allowed projects. The agent hasn’t started. Your message is saved.`}</p>
        {!ready && !canManage && <p className="text-sm text-muted-foreground">A person with agent-management permission can add this project in the agent’s Permissions / Trust settings.</p>}
      </div>
    </div>
    <div className="flex flex-wrap gap-2 pl-8">
      {ready ? canRetry && <Button size="sm" onClick={onRetry}>Retry task<ArrowRight className="size-4" aria-hidden /></Button>
        : <Button size="sm" variant="outline" onClick={onManage}>{canManage ? "Manage project access" : "View agent access"}<ArrowRight className="size-4" aria-hidden /></Button>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}
    {!ready && <details className="pl-8 text-xs text-muted-foreground"><summary className="cursor-pointer">Run details</summary>
      <dl className="mt-3 grid grid-cols-2 gap-2"><dt>Stopped during</dt><dd>Workspace setup</dd><dt>Reason</dt><dd>Project outside allowed scope</dd><dt>Provider started</dt><dd>No</dd></dl>
    </details>}
  </section>;
}
