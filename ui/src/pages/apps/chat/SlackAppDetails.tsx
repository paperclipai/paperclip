import type { ReactNode } from "react";
import { ChevronRight, CircleHelp } from "lucide-react";
import { slackAppConfigurationSchema, type SlackAppConfiguration } from "@paperclipai/shared";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function SlackSetupAdvanced({ children, label = "Advanced" }: { children: ReactNode; label?: string }) {
  return <details className="group text-sm">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground hover:text-foreground">
      <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />{label}
    </summary>
    <div className="mt-4 space-y-4">{children}</div>
  </details>;
}

export function SlackAppDetails({ value, readOnly, onChange, onBlur }: {
  value: SlackAppConfiguration;
  readOnly: boolean;
  onChange: (value: SlackAppConfiguration) => void;
  onBlur: () => void;
}) {
  const validation = slackAppConfigurationSchema.safeParse(value);
  return <div className="space-y-3 text-sm">
    {([
      ["appName", "Slack app name", 35, "The name of your app in Slack’s app directory and settings."],
      ["botName", "Bot display name", 80, "The name people see when your bot sends a message."],
      ["command", "Slash command", 32, "The command people type in Slack to talk to this agent."],
    ] as const).map(([key, label, maxLength, help]) => <div key={key} className="grid items-center gap-2 sm:grid-cols-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor={`slack-${key}`}>{label}</label>
        <Tooltip><TooltipTrigger asChild><button type="button" aria-label={`Help with ${label.toLowerCase()}`} className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </button></TooltipTrigger><TooltipContent className="max-w-xs">{help}</TooltipContent></Tooltip>
      </div>
      <Input id={`slack-${key}`} value={value[key]} maxLength={maxLength} readOnly={readOnly}
        aria-invalid={!validation.success && validation.error.issues.some(issue => issue.path[0] === key)}
        onChange={event => onChange({ ...value, [key]: event.target.value })} onBlur={onBlur} />
    </div>)}
    {!validation.success && <p role="alert" className="text-destructive">{validation.error.issues[0].message}</p>}
  </div>;
}
