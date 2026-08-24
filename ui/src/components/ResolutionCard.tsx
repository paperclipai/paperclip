import {
  CheckCircle2,
  ExternalLink,
  FileText,
  GitBranch,
  StickyNote,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * A resolution action emitted by the board skill through the SSE stream.
 * The skill wraps created work objects in `%%ACTIONS%%{...}%%/ACTIONS%%`
 * blocks so the UI can render clickable resolution cards.
 */
export interface BoardResolutionAction {
  /** A single created/updated Paperclip object. */
  resolution?: {
    type: "issue" | "plan" | "approval" | "knowledge" | "memory";
    action: "create" | "update";
    data: {
      title?: string;
      id?: string;
      url?: string;
      [key: string]: unknown;
    };
  };
  /** A recorded decision with rationale. */
  decision?: {
    summary?: string;
    rationale?: string;
  };
}

const typeConfig: Record<
  string,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    color: string;
  }
> = {
  issue: {
    label: "Issue",
    icon: FileText,
    color: "bg-blue-500/10 text-blue-600 border-blue-200 dark:border-blue-800",
  },
  plan: {
    label: "Plan",
    icon: GitBranch,
    color:
      "bg-purple-500/10 text-purple-600 border-purple-200 dark:border-purple-800",
  },
  approval: {
    label: "Approval",
    icon: CheckCircle2,
    color:
      "bg-green-500/10 text-green-600 border-green-200 dark:border-green-800",
  },
  knowledge: {
    label: "Knowledge",
    icon: StickyNote,
    color:
      "bg-amber-500/10 text-amber-600 border-amber-200 dark:border-amber-800",
  },
  memory: {
    label: "Memory",
    icon: StickyNote,
    color:
      "bg-teal-500/10 text-teal-600 border-teal-200 dark:border-teal-800",
  },
};

const actionLabel: Record<string, string> = {
  create: "Created",
  update: "Updated",
};

interface ResolutionCardProps {
  action: BoardResolutionAction;
  className?: string;
}

/**
 * A compact inline card showing that the board assistant created or updated a
 * Paperclip work object (issue, plan, approval, memory record, etc.). Rendered
 * below the agent's text bubble in the conference room chat.
 */
export function ResolutionCard({ action, className }: ResolutionCardProps) {
  const resolution = action.resolution;
  const decision = action.decision;

  // Prefer displaying a resolution object; fall back to decision-only display.
  if (resolution) {
    const type = resolution.type;
    const config = typeConfig[type] ?? typeConfig.issue;
    const Icon = config.icon;
    const actionText = actionLabel[resolution.action] ?? resolution.action;

    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border bg-card p-3 text-sm shadow-sm",
          config.color,
          className,
        )}
      >
        <div className="mt-0.5 shrink-0">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {type}
            </Badge>
            <span className="text-xs text-muted-foreground">{actionText}</span>
          </div>
          {resolution.data.title && (
            <p className="mt-1 text-sm font-medium leading-snug">
              {resolution.data.title}
            </p>
          )}
          {resolution.data.url && (
            <a
              href={resolution.data.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              View
            </a>
          )}
        </div>
      </div>
    );
  }

  // Decision-only display (no attached resolution object)
  if (decision) {
    return (
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border bg-card p-3 text-sm shadow-sm",
          "border-yellow-200 dark:border-yellow-800 bg-yellow-500/5",
          className,
        )}
      >
        <div className="mt-0.5 shrink-0">
          <CheckCircle2 className="h-4 w-4 text-yellow-600" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="text-[10px] uppercase tracking-wider"
            >
              Decision
            </Badge>
          </div>
          {decision.summary && (
            <p className="mt-1 text-sm font-medium leading-snug">
              {decision.summary}
            </p>
          )}
          {decision.rationale && (
            <p className="mt-1 text-xs text-muted-foreground">
              {decision.rationale}
            </p>
          )}
        </div>
      </div>
    );
  }

  return null;
}
