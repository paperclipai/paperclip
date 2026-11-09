import { ExternalLink, RefreshCw } from "lucide-react";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { AgentAvatarDownload } from "@/components/AgentAvatarDownload";
import { GitHubSettingsDisclosure } from "./GitHubSettingsDisclosure";
import { CopyText } from "@/components/CopyText";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";

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
  const { t } = useTranslation();
  const mention = gitHubBotMention(endpoint);
  return mention ? (
    <CopyText
      text={mention}
      ariaLabel={t("apps.GitHubBotMention.copy")}
      title={t("apps.GitHubBotMention.copy")}
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
  const { t } = useTranslation();
  return (
    <GitHubSettingsDisclosure title={t("apps.GitHubAppBranding.title")}>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("apps.GitHubAppBranding.help")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {avatarUrl && (
            <>
              <img
                src={avatarUrl}
                alt={t("apps.GitHubAppBranding.avatarAlt", { name: endpoint.assignedAgentName })}
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
              aria-label={t("apps.GitHubAppBranding.editAria")}
            >
              {t("apps.GitHubAppBranding.editOnGithub")} <ExternalLink className="size-4" />
            </a>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("apps.GitHubAppBranding.renameNote")}{" "}
          <Link
            className="underline underline-offset-4"
            to={`/apps/chat/connect?provider=github&resume=${endpoint.id}&reconnect=1`}
          >
            {t("apps.GitHubAppBranding.reconnect")}
          </Link>{" "}
          {t("apps.GitHubAppBranding.reconnectHere")}
        </p>
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
  const { t } = useTranslation();
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
          aria-label={t("apps.GitHubAppIdentityActions.editAria")}
          title={t("apps.GitHubAppIdentityActions.editTitle")}
        >
          {t("apps.GitHubAppIdentityActions.editApp")} <ExternalLink className="size-3.5" />
        </a>
      </Button>
      <Button variant="ghost" size="icon" asChild>
        <Link
          to={`/apps/chat/connect?provider=github&resume=${endpoint.id}&reconnect=1`}
          aria-label={t("apps.GitHubAppIdentityActions.refreshAria")}
          title={t("apps.GitHubAppIdentityActions.refreshTitle")}
        >
          <RefreshCw className="size-3.5" />
        </Link>
      </Button>
    </div>
  );
}
