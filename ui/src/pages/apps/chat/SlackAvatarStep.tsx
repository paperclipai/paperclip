import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
import { useId, useState } from "react";
import {
  ArrowRight,
  Check,
  Download,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SetupWizardFooter } from "@/components/SetupWizard";

export interface SlackAvatarProps {
  agentName: string;
  appName: string;
  avatarUrl: string;
}

/** Shared by Slack onboarding and its Settings page. Slack upload is manual. */
export function SlackAvatarContent({
  agentName,
  appName,
  avatarUrl,
  compact = false,
}: SlackAvatarProps & { compact?: boolean }) {
  useTranslation();
  const id = useId();
  const filename = `${appName.replace(/[^a-zA-Z0-9_-]+/g, "-") || "agent"}-avatar.png`;
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    setDownloadError(false);
    try {
      const response = await fetch(avatarUrl);
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("image/png")
      )
        throw new Error(t("sep28Apps.copy181"));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch {
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <div className="space-y-8">
      <section
        aria-labelledby={`${id}-download`}
        className="flex flex-col items-start gap-6 sm:flex-row sm:items-center"
      >
        <img
          src={avatarUrl}
          width={512}
          height={512}
          alt={t("sep28Apps.avatarAlt", { agent: agentName })}
          className="size-40 shrink-0 rounded-lg bg-muted object-contain"
        />
        <div className="space-y-3">
          <div className="space-y-1">
            <h2 id={`${id}-download`} className="text-sm font-semibold">
              {compact
                ? t("sep28Apps.copy182")
                : t("sep28Apps.copy183")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("sep28Apps.copy184")}</p>
          </div>
          <Button variant="outline" asChild>
            <a
              href={avatarUrl}
              download={filename}
              aria-disabled={downloading}
              onClick={(event) => {
                event.preventDefault();
                void download();
              }}
            >
              {downloading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )} {t("sep28Apps.copy185")}</a>
          </Button>
          {downloadError && (
            <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy186")}</p>
          )}
        </div>
      </section>

      <details open={compact ? undefined : true} className="space-y-4">
        <summary
          className={
            compact
              ? "cursor-pointer text-sm underline underline-offset-4"
              : "hidden"
          }
        >{t("sep28Apps.copy187")}</summary>
        <section aria-labelledby={`${id}-upload`} className="space-y-4">
          <div className="space-y-1">
            <h2 id={`${id}-upload`} className="text-sm font-semibold">
              {compact ? t("sep28Apps.copy188") : t("sep28Apps.copy189")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("sep28Apps.copy190")}</p>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li><Trans i18nKey="sep28Apps.openSlackSettings" values={{ app: appName }} components={{ settings: <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4" />, app: <strong /> }} /></li>
            <li><Trans i18nKey="sep28Apps.avatarBasic" components={{ basic: <strong />, display: <strong /> }} /></li>
            <li><Trans i18nKey="sep28Apps.avatarUpload" values={{ file: filename }} components={{ icon: <strong />, file: <span className="break-all font-mono text-xs" /> }} /></li>
            <li><Trans i18nKey="sep28Apps.avatarCrop" components={{ save: <strong /> }} /></li>
          </ol>
        </section>
      </details>
    </div>
  );
}

export function SlackAvatarStep({
  uploaded,
  onUploaded,
  onSkip,
  onSaveExit,
  ...props
}: SlackAvatarProps & {
  uploaded: boolean;
  onUploaded: () => void;
  onSkip: () => void;
  onSaveExit: () => void;
}) {
  useTranslation();
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">
            {t("sep28Apps.avatarTitle", { agent: props.agentName })}
          </h1>
          <span className="text-xs text-muted-foreground">{t("pages.secrets.common.optionalPlain")}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("sep28Apps.avatarDescription", { agent: props.agentName })}
        </p>
      </div>
      <SlackAvatarContent {...props} />
      {uploaded && (
        <p
          role="status"
          className="flex items-center gap-2 rounded-lg bg-(--status-task-done)/10 p-3 text-sm"
        >
          <Check className="size-4 text-(--status-task-done)" />{t("sep28Apps.copy192")}</p>
      )}
      <SetupWizardFooter onSaveExit={onSaveExit}>
        <Button variant="ghost" onClick={onSkip}>{t("sep28Apps.copy193")}</Button>
        <Button onClick={onUploaded}>
          {uploaded ? t("pages.inviteLanding.actions.continue") : t("sep28Apps.copy194")}
          <ArrowRight className="size-4" />
        </Button>
      </SetupWizardFooter>
    </div>
  );
}

export function SlackAvatarSettings(props: SlackAvatarProps) {
  useTranslation();
  return (
    <section className="space-y-4" aria-label={t("sep28Apps.copy195")}>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("sep28Apps.copy196")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("sep28Apps.avatarDescription", { agent: props.agentName })}
        </p>
      </div>
      <SlackAvatarContent {...props} compact />
    </section>
  );
}
