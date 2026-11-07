import { useTranslation } from "@/i18n";
import { useId, useState } from "react";
import {
  Download,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export interface SlackAvatarProps {
  agentName: string;
  appName: string;
  avatarUrl: string;
}

/** Manual fallback shared by Slack onboarding and its Settings page. */
export function SlackAvatarContent({
  agentName,
  appName,
  avatarUrl,
  compact = false,
}: SlackAvatarProps & { compact?: boolean }) {
  const { t } = useTranslation("connections");
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
        throw new Error(t("avatar_unavailable_af3ddab"));
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
          alt={t("s_cliptoon_avatar_6018d4a", { agentName: agentName })}
          className="size-40 shrink-0 rounded-lg bg-muted object-contain"
        />
        <div className="space-y-3">
          <div className="space-y-1">
            <h2 id={`${id}-download`} className="text-sm font-semibold">
              {compact
                ? t("download_your_agent_s_avatar_5748647")
                : t("1_download_your_agent_s_avatar_af2561f")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("png_512_512_ready_for_slack_8b54fc8")}</p>
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
              )}{t("download_avatar_42c81f6")}</a>
          </Button>
          {downloadError && (
            <p role="alert" className="text-sm text-destructive">{t("couldn_t_download_the_avatar_try_downloading_a950e06")}</p>
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
        >{t("how_to_upload_in_slack_d1220e6")}</summary>
        <section aria-labelledby={`${id}-upload`} className="space-y-4">
          <div className="space-y-1">
            <h2 id={`${id}-upload`} className="text-sm font-semibold">
              {compact ? t("upload_it_in_slack_9d128e2") : t("2_upload_it_in_slack_b98f46c")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("you_ll_upload_the_downloaded_image_directly_aecf9ab")}</p>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              <a
                href="https://api.slack.com/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4"
              >{t("open_slack_app_settings_33e0795")}{" "}
                <ExternalLink className="inline size-3" />
              </a>{" "}{t("and_choose_39fb1fa")}<strong>{appName}</strong>.
            </li>
            <li>{t("choose_bcf399c")}<strong>{t("basic_information_b0d5be3")}</strong>{t("then_scroll_to_0041027")}{" "}
              <strong>{t("display_information_ca0b29b")}</strong>.
            </li>
            <li>{t("under_d0654cb")}<strong>{t("app_icon_preview_ff1cc7e")}</strong>{t("click_the_app_icon_and_upload_b805fec")}{" "}
              <span className="break-all font-mono text-xs">{filename}</span>.
            </li>
            <li>{t("confirm_the_crop_then_click_dc1343f")}<strong>{t("save_changes_fa2984b")}</strong>{t("in_slack_adcd64b")}</li>
          </ol>
        </section>
      </details>
    </div>
  );
}


export function SlackAvatarSettings(props: SlackAvatarProps) {
  const { t } = useTranslation("connections");
  return (
    <section className="space-y-4" aria-label={t("slack_avatar_b0c9b74")}>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("agent_avatar_a3fe01c")}</h2>
        <p className="text-sm text-muted-foreground">{t("use_s_avatar_so_your_team_recognizes_e887bb7", { agentName: props.agentName })}</p>
      </div>
      <SlackAvatarContent {...props} compact />
    </section>
  );
}
