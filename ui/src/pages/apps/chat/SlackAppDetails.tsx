import { useTranslation } from "@/i18n";
import type { ReactNode } from "react";
import { ChevronRight, CircleHelp } from "lucide-react";
import { slackAppConfigurationSchema, type SlackAppConfiguration } from "@paperclipai/shared";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function SlackSetupAdvanced({ children, label }: { children: ReactNode; label?: string }) {
  const { t } = useTranslation("connections");
  return <details className="group text-sm">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground hover:text-foreground">
      <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden="true" />{label ?? t("advanced_4d06472")}
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
  const { t } = useTranslation("connections");
  const validation = slackAppConfigurationSchema.safeParse(value);
  const issue = validation.success ? undefined : validation.error.issues[0];
  const fieldLabels: Record<string, string> = { appName: t("slack_app_name_31f217d"), botName: t("bot_display_name_9ffae21"), command: t("slash_command_f26624e") };
  const field = issue ? fieldLabels[String(issue.path[0])] : "";
  const validationMessage = !issue ? null
    : issue.code === "too_small" && issue.path[0] === "appName" ? t("slackValidation.appNameRequired")
    : issue.code === "too_small" ? t("slackValidation.minimum", { field, minimum: issue.minimum })
    : issue.code === "too_big" ? t("slackValidation.maximum", { field, maximum: issue.maximum })
    : issue.path[0] === "botName" ? t("slackValidation.botNameFormat")
    : issue.path[0] === "command" ? t("slackValidation.commandFormat")
    : t("slackValidation.invalid", { field });
  return <div className="space-y-3 text-sm">
    {([
      ["appName", t("slack_app_name_31f217d"), 35, t("the_name_of_your_app_in_slack_06f66ad")],
      ["botName", t("bot_display_name_9ffae21"), 80, t("the_name_people_see_when_your_bot_c13dcd5")],
      ["command", t("slash_command_f26624e"), 32, t("the_command_people_type_in_slack_to_d28ceb4")],
    ] as const).map(([key, label, maxLength, help]) => <div key={key} className="grid items-center gap-2 sm:grid-cols-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor={`slack-${key}`}>{label}</label>
        <Tooltip><TooltipTrigger asChild><button type="button" aria-label={t("help_with_8c8e9a0", { value: label.toLowerCase() })} className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <CircleHelp className="size-3.5" aria-hidden="true" />
        </button></TooltipTrigger><TooltipContent className="max-w-xs">{help}</TooltipContent></Tooltip>
      </div>
      <Input id={`slack-${key}`} value={value[key]} maxLength={maxLength} readOnly={readOnly}
        aria-invalid={!validation.success && validation.error.issues.some(issue => issue.path[0] === key)}
        onChange={event => onChange({ ...value, [key]: event.target.value })} onBlur={onBlur} />
    </div>)}
    {validationMessage && <p role="alert" className="text-destructive">{validationMessage}</p>}
  </div>;
}
