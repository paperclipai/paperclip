import { useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Copy } from "lucide-react";
import { useQueryView } from "@/components/QueryView";
import { resolveAgentAppearance, type GitHubAppWizardState } from "@paperclipai/shared";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { githubChatApi } from "@/api/githubChat";
import { AgentAvatar, type AvatarAgent } from "@/components/AgentAvatar";
import { AppLogo } from "../AppLogo";
import { CopyText } from "@/components/CopyText";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import { Link } from "@/lib/router";
import { GitHubAppBranding, gitHubBotMention } from "./GitHubAppIdentity";

export type GitHubConnectionCompleteLocationState = {
  githubConnectionComplete?: {
    endpointId: string;
    runtimeChecks?: GitHubAppWizardState["runtimeChecks"];
  };
};

export function GitHubConnectionComplete({
  endpoint,
  agent,
  runtimeChecks,
  onClose,
  onCloseAutoFocus,
}: {
  endpoint: ChatEndpoint;
  agent?: AvatarAgent;
  runtimeChecks?: GitHubAppWizardState["runtimeChecks"];
  onClose: () => void;
  onCloseAutoFocus?: () => void;
}) {
  const { t } = useTranslation("connections");
  const repositories = useQuery({
    queryKey: ["github-connected-repositories", endpoint.id],
    queryFn: () => githubChatApi.repositories(endpoint.id, { limit: 1 }),
  });
  const repositoriesView = useQueryView(repositories);
  const avatar = agent ?? { id: endpoint.assignedAgentId, name: endpoint.assignedAgentName };
  const mention = `${gitHubBotMention(endpoint) || "@your-bot"} review this pull request`;
  const count = repositories.data?.enabledCount;
  const incomplete = runtimeChecks?.filter((check) => !check.ok) ?? [];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="max-h-(--sz-85dvh) overflow-y-auto sm:max-w-xl"
        aria-describedby={undefined}
        onCloseAutoFocus={onCloseAutoFocus ? (event) => {
          event.preventDefault();
          onCloseAutoFocus();
        } : undefined}
      >
        <div className="@container space-y-6">
          <header className="space-y-5">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="size-6 shrink-0 text-(--status-task-done)" />
              <DialogTitle className="text-xl leading-normal">{t("github_connected_ba4f963")}</DialogTitle>
            </div>
            <div className="flex items-center gap-3">
              <AgentAvatar agent={avatar} size={48} />
              <div className="min-w-0 space-y-1">
                <h2 className="break-words text-base font-semibold">
                  {endpoint.botLabel ?? endpoint.botUsername ?? endpoint.assignedAgentName}
                </h2>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                  <Link to={`/agents/${endpoint.assignedAgentId}`} className="hover:text-foreground hover:underline">
                    {endpoint.assignedAgentName}
                  </Link>
                  {endpoint.providerAccountLabel && <>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1.5">
                      <AppLogo name="GitHub" brandKey="github" compact className="size-4! rounded-sm bg-transparent" />
                      {endpoint.providerAccountLabel}
                    </span>
                  </>}
                </p>
                <Link to={`/apps/chat/${endpoint.id}/access`} className="inline-block text-xs text-muted-foreground underline underline-offset-4">
                  {repositoriesView.kind === "error" ? t("repository_access_unavailable_ceb3a85") : count === undefined ? t("repository_access_707c5b6") : count === 0 ? t("no_repositories_enabled_714242c") : t("enabled_3ad874c", { count: count, value: count === 1 ? "repository" : "repositories" })}
                </Link>
              </div>
            </div>
          </header>
          {incomplete.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-medium">{t("before_your_first_review_da4b283")}</h2>
              {incomplete.map((check) => (
                <p key={check.key} className="text-sm text-muted-foreground">{check.detail}</p>
              ))}
            </section>
          )}
          <section className="space-y-3">
            <div className="space-y-1">
              <h2 className="text-base font-semibold">{t("try_your_bot_e59e676")}</h2>
              <p className="text-sm text-muted-foreground">
                {count === 0
                  ? t("enable_a_repository_in_access_to_try_1aff631")
                  : t("post_this_on_a_pull_request_in_c76a279")}
              </p>
            </div>
            <CopyText
              text={mention}
              ariaLabel={t("copy_mention_789c5ef")}
              title={t("copy_mention_789c5ef")}
              containerClassName="w-full"
              className="flex w-full items-center gap-3 rounded-md border border-border bg-muted/30 p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <code className="min-w-0 flex-1 break-words text-sm">{mention}</code>
              <Copy className="size-4 shrink-0 text-muted-foreground" />
            </CopyText>
          </section>
          <GitHubAppBranding
            endpoint={endpoint}
            avatarUrl={agentAvatarUrl(resolveAgentAppearance(avatar.appearance, endpoint.assignedAgentId), 512, 1, "rest")}
          />
          <DialogFooter>
            <Button onClick={onClose}>{t("done_e9b450d")}</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
