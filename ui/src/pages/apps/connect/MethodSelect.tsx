import type { AppDefinition, ConnectionMethodDef, ToolConnectionTransport } from "@paperclipai/shared";
import { ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

const TRANSPORT_LABEL: Record<ToolConnectionTransport, string> = {
  mcp_remote: "MCP",
  rest_api: "REST API",
  local_stdio: "Local",
};

const AUTH_LABEL: Record<ConnectionMethodDef["auth"], string> = {
  oauth: "OAuth",
  api_key: "API Key",
  none: "No auth",
};

/** Badge chips summarizing a method's `{transport × auth}`. */
export function MethodBadges({ method }: { method: ConnectionMethodDef }) {
  return (
    <span className="flex flex-wrap gap-1">
      <Badge>{TRANSPORT_LABEL[method.transport]}</Badge>
      {method.auth !== "none" && <Badge>{AUTH_LABEL[method.auth]}</Badge>}
    </span>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

export interface MethodSelectProps {
  def: AppDefinition;
  onSelect: (method: ConnectionMethodDef) => void;
  selectedKey?: string | null;
}

/**
 * The single method-selection mechanism (plan-wizard-ux §2.2): a flat list of
 * cards, one per `AppDefinition.methods[]` entry `{transport × auth}` with its
 * `whenToUse` copy. No radio-then-tabs-then-cards layering — variants render as
 * sibling cards inside the Configure step, not here.
 */
export function MethodSelect({ def, onSelect, selectedKey }: MethodSelectProps) {
  return (
    <div className="flex flex-col gap-2">
      {def.methods.map((method) => (
        <button
          key={method.key}
          type="button"
          onClick={() => onSelect(method)}
          className={cn(
            "group flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
            selectedKey === method.key
              ? "border-primary bg-primary/5 ring-1 ring-primary"
              : "border-border hover:border-foreground/30 hover:bg-accent/40",
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <MethodBadges method={method} />
            </div>
            <p className="text-sm text-muted-foreground">{method.whenToUse}</p>
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </button>
      ))}
    </div>
  );
}
