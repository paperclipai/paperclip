import type { ReactNode } from "react";
import { useTranslation } from "@/i18n";
import { slackAppValidationMessage } from "./chat-copy";
import { ChevronRight, CircleHelp } from "lucide-react";
import { slackAppConfigurationSchema, type SlackAppConfiguration } from "@paperclipai/shared";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function SlackSetupAdvanced({ children, label }: { children: ReactNode; label?: string }) {
  const { t } = useTranslation();
  return <details className="group text-sm">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground hover:text-foreground">
      <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />{label ?? t("pages.apps.tabs.advanced")}
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
  const { t, i18n } = useTranslation();
  const validation = slackAppConfigurationSchema.safeParse(value);
  return <div className="space-y-3 text-sm">
    {([
      ["appName", t("chatUi.chatEndpointSetup.slackAppName"), 35, t("oct19Apps.slackAppNameHelp")],
      ["botName", t("chatUi.chatEndpointSetup.botDisplayName"), 80, t("oct19Apps.slackBotNameHelp")],
      ["command", t("chatUi.chatEndpointDetail.slashCommand"), 32, t("oct19Apps.slackCommandHelp")],
    ] as const).map(([key, label, maxLength, help]) => <div key={key} className="grid items-center gap-2 sm:grid-cols-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor={`slack-${key}`}>{label}</label>
        <Tooltip><TooltipTrigger asChild><button type="button" aria-label={t("oct19Apps.helpWithField", { label: i18n.resolvedLanguage?.startsWith("en") ? label.toLowerCase() : label })} className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </button></TooltipTrigger><TooltipContent className="max-w-xs">{help}</TooltipContent></Tooltip>
      </div>
      <Input id={`slack-${key}`} value={value[key]} maxLength={maxLength} readOnly={readOnly}
        aria-invalid={!validation.success && validation.error.issues.some(issue => issue.path[0] === key)}
        onChange={event => onChange({ ...value, [key]: event.target.value })} onBlur={onBlur} />
    </div>)}
    {!validation.success && <p role="alert" className="text-destructive">{slackAppValidationMessage(validation.error.issues[0])}</p>}
  </div>;
}
