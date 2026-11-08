import { useTranslation } from "@/i18n";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { AgentAvatarDownload } from "@/components/AgentAvatarDownload";
import { GitHubSettingsDisclosure } from "./GitHubSettingsDisclosure";
import { CopyText } from "@/components/CopyText";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";

export function gitHubBotMention(endpoint: Pick<ChatEndpoint, "botUsername">) {
  const slug = endpoint.botUsername?.replace(/^@/, "").replace(/\[bot\]$/, "");
  return slug ? `@${slug}` : null;
}

export function gitHubAppSettingsUrl(endpoint: ChatEndpoint) {
  const github = endpoint.setup?.github;
  const slug = gitHubBotMention(endpoint)?.slice(1);
  if (!slug) return "https://github.com/settings/apps";
  if (github?.appOwnerType === "organization" && github.appOwnerLogin)
    return `https://github.com/organizations/${encodeURIComponent(github.appOwnerLogin)}/settings/apps/${encodeURIComponent(slug)}`;
  if (github?.appOwnerType === "personal")
    return `https://github.com/settings/apps/${encodeURIComponent(slug)}`;
  // Legacy manual connections may not record ownership type. Never assume it.
  return "https://github.com/settings/apps";
}

export function GitHubBotMention({ endpoint }: { endpoint: ChatEndpoint }) {
  const { t } = useTranslation("connections");
  const mention = gitHubBotMention(endpoint);
  return mention ? (
    <CopyText
      text={mention}
      ariaLabel={t("copy_github_mention_78ae532")}
      title={t("copy_github_mention_78ae532")}
      className="break-all font-mono text-xs"
    >
      {mention}
    </CopyText>
  ) : null;
}

/** Optional provider-owned branding, shared by completion and management. */
export function GitHubAppBranding({
  endpoint,
  avatarUrl,
}: {
  endpoint: ChatEndpoint;
  avatarUrl?: string;
}) {
  const { t } = useTranslation("connections");
  return (
    <GitHubSettingsDisclosure title={t("github_app_name_and_logo_bf54a51")}>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-muted-foreground">{t("change_the_name_or_upload_a_logo_494125a")}</p>
        <div className="flex flex-wrap items-center gap-3">
          {avatarUrl && (
            <>
              <img
                src={avatarUrl}
                alt={t("s_avatar_for_download_448824f", { assignedAgentName: endpoint.assignedAgentName })}
                className="size-12 shrink-0 object-contain"
              />
              <AgentAvatarDownload
                avatarUrl={avatarUrl}
                name={endpoint.botLabel ?? endpoint.assignedAgentName}
              />
            </>
          )}
          <Button variant="outline" asChild>
            <a
              href={gitHubAppSettingsUrl(endpoint)}
              target="_blank"
              rel="noreferrer"
              aria-label={t("edit_app_name_and_logo_on_github_41cbbbc")}
            >{t("edit_on_github_b0b8b88")}<ExternalLink className="size-4" />
            </a>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("renaming_also_changes_its_mention_7c9401b")}{" "}
          <Link
            className="underline underline-offset-4"
            to={`/apps/chat/connect?provider=github&resume=${endpoint.id}&reconnect=1`}
          >{t("reconnect_afterward_79a0387")}</Link>{" "}{t("to_update_it_here_c64df4e")}</p>
      </div>
    </GitHubSettingsDisclosure>
  );
}

/** Provider-owned branding actions live beside the App identity, not among review rules. */
export function GitHubAppIdentityActions({
  endpoint,
  avatarUrl,
}: {
  endpoint: ChatEndpoint;
  avatarUrl?: string;
}) {
  const { t } = useTranslation("connections");
  return (
    <div className="flex flex-wrap items-center gap-1">
      {avatarUrl && (
        <AgentAvatarDownload
          avatarUrl={avatarUrl}
          name={endpoint.botLabel ?? endpoint.assignedAgentName}
          iconOnly
        />
      )}
      <Button variant="ghost" size="sm" asChild>
        <a
          href={gitHubAppSettingsUrl(endpoint)}
          target="_blank"
          rel="noreferrer"
          aria-label={t("edit_app_name_and_logo_on_github_41cbbbc")}
          title={t("change_the_app_name_or_upload_its_dedbc33")}
        >{t("edit_app_47b1534")}<ExternalLink className="size-3.5" />
        </a>
      </Button>
      <Button variant="ghost" size="icon" asChild>
        <Link
          to={`/apps/chat/connect?provider=github&resume=${endpoint.id}&reconnect=1`}
          aria-label={t("refresh_github_app_identity_48428a1")}
          title={t("reconnect_after_renaming_the_app_to_refresh_6a3abdf")}
        >
          <RefreshCw className="size-3.5" />
        </Link>
      </Button>
    </div>
  );
}
