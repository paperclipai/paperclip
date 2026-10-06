import { githubReviewStatusLabel, chatUiErrorMessage, type ChatUiError } from "./chat-copy";
import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { GitHubChatConfiguration } from "@paperclipai/shared";
import {
  githubChatApi,
  type GitHubConfigurationRecord,
} from "@/api/githubChat";
import { chatEndpointsApi, type ChatEndpoint } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import {
  GitHubAccessEditor,
  GitHubPolicyEditor,
  GitHubToggle,
  githubSelectClass,
} from "./GitHubBotConfiguration";

export function GitHubBotManagement({
  endpoint,
  view,
}: {
  endpoint: ChatEndpoint;
  view: "settings" | "access";
}) {
  useTranslation();
  const query = useQuery({
    queryKey: ["github-bot-configuration", endpoint.id],
    queryFn: () => githubChatApi.configuration(endpoint.id),
  });
  const resources = useQuery({
    queryKey: ["github-bot-repositories", endpoint.id],
    queryFn: () => chatEndpointsApi.listResources(endpoint.id),
  });
  const [draft, setDraft] = useState<GitHubConfigurationRecord | null>(null);
  const [repository, setRepository] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<ChatUiError>("");
  const [error, setError] = useState<ChatUiError>("");
  const record = draft ?? query.data;
  const edit = (configuration: GitHubChatConfiguration) => {
    if (record) setDraft({ ...record, configuration });
    setNotice("");
  };
  const act = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : { key: "sep28Apps.copy82" });
    } finally {
      setPending(false);
    }
  };
  if (query.isError || resources.isError)
    return (
      <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy83")}{" "}
        <Button
          variant="link"
          onClick={() => {
            void query.refetch();
            void resources.refetch();
          }}
        >{t("localizationProjectRepositories.retry")}</Button>
      </p>
    );
  if (!record)
    return (
      <p className="text-sm text-muted-foreground">{t("sep28Apps.copy84")}</p>
    );
  const config = record.configuration;
  const override = repository ? config.repositories[repository] : undefined;
  return (
    <section className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">
          {view === "access"
            ? t("sep28Apps.copy85")
            : t("sep28Apps.copy86")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("sep28Apps.agentAssigned", { agent: endpoint.assignedAgentName })}
        </p>
        <Link
          className="text-sm underline"
          to={`/apps/${endpoint.connectionId}`}
        >{t("sep28Apps.copy87")}</Link>
      </div>
      {view === "access" ? (
        <GitHubAccessEditor
          endpointId={endpoint.id}
          companyId={endpoint.companyId}
          configuration={config}
          onChange={edit}
        />
      ) : (
        <>
          <GitHubToggle
            label={t("sep28Apps.copy88")}
            description={t("sep28Apps.copy89")}
            checked={config.toolsEnabled}
            onChange={(toolsEnabled) => edit({ ...config, toolsEnabled })}
          />
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{t("sep28Apps.copy90")}</h3>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    void act(async () => {
                      await githubChatApi.refreshRepositories(endpoint.id);
                      await resources.refetch();
                      setNotice(
                        { key: "sep28Apps.copy91" },
                      );
                    })
                  }
                >
                  <RefreshCw className="size-4" /> {t("common.refresh")}</Button>
                <Button variant="outline" size="sm" asChild>
                  <a
                    href={
                      endpoint.setup?.github?.managementUrl ??
                      endpoint.setup?.github?.installationUrl ??
                      "https://github.com/settings/installations"
                    }
                    target="_blank"
                    rel="noreferrer"
                  >{t("localizationApps.configureOnGitHub")}<ExternalLink className="size-4" />
                  </a>
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t("sep28Apps.copy92")}</p>
            {resources.data
              ?.filter((r) => r.type === "repository")
              .map((resource) => (
                <GitHubToggle
                  key={resource.id}
                  label={resource.label ?? resource.providerResourceId}
                  description={
                    resource.availability === "available"
                      ? undefined
                      : t("sep28Apps.copy93")
                  }
                  checked={resource.enabled}
                  onChange={(enabled) =>
                    void act(async () => {
                      await chatEndpointsApi.updateResources(endpoint.id, [
                        { id: resource.id, enabled },
                      ]);
                      await resources.refetch();
                    })
                  }
                />
              ))}
          </div>
          <div className="space-y-2">
            <label
              htmlFor="github-policy-repository"
              className="text-sm font-medium"
            >{t("sep28Apps.copy94")}</label>
            <select
              id="github-policy-repository"
              className={githubSelectClass}
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            >
              <option value="">{t("sep28Apps.copy95")}</option>
              {resources.data
                ?.filter(
                  (r) =>
                    r.type === "repository" &&
                    r.enabled &&
                    r.metadata?.providerRepositoryId,
                )
                .map((r) => (
                  <option
                    key={r.id}
                    value={String(r.metadata?.providerRepositoryId)}
                  >
                    {r.label ?? r.providerResourceId}
                  </option>
                ))}
            </select>
          </div>
          {repository && (
            <GitHubToggle
              label={t("sep28Apps.copy96")}
              description={t("sep28Apps.copy97")}
              checked={!!override}
              onChange={(enabled) => {
                const repositories = { ...config.repositories };
                if (enabled) repositories[repository] = { ...config.defaults };
                else delete repositories[repository];
                edit({ ...config, repositories });
              }}
            />
          )}
          {!repository || override ? (
            <GitHubPolicyEditor
              policy={{ ...config.defaults, ...override }}
              onChange={(policy) =>
                edit(
                  repository
                    ? {
                        ...config,
                        repositories: {
                          ...config.repositories,
                          [repository]: policy,
                        },
                      }
                    : { ...config, defaults: policy },
                )
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("sep28Apps.copy98")}</p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {chatUiErrorMessage(error)}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {chatUiErrorMessage(notice)}
        </p>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <Button
          variant="ghost"
          disabled={!draft || pending}
          onClick={() => {
            setDraft(null);
            setError("");
          }}
        >{t("localizationProjectRepositories.discardChanges")}</Button>
        <Button
          disabled={!draft || pending}
          onClick={() =>
            void act(async () => {
              const saved = await githubChatApi.save(
                endpoint.id,
                record.revision,
                config,
              );
              setDraft(saved);
              await query.refetch();
              setDraft(null);
              setNotice({ key: "localizationPlugins.configurationSaved" });
            })
          }
        >
          {pending ? t("localizationProjectRepositories.saving") : t("localizationProjectRepositories.saveChanges")}
        </Button>
      </div>
    </section>
  );
}

export function GitHubReviews({ endpointId }: { endpointId: string }) {
  useTranslation();
  const query = useQuery({
    queryKey: ["github-bot-reviews", endpointId],
    queryFn: () => githubChatApi.reviews(endpointId),
    refetchInterval: 5000,
  });
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t("sep28Chat.reviews")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("sep28Apps.copy99")}</p>
      </div>
      {query.isError && (
        <p role="alert" className="text-sm text-destructive">{t("sep28Apps.copy100")}{" "}
          <Button variant="link" onClick={() => void query.refetch()}>{t("localizationProjectRepositories.retry")}</Button>
        </p>
      )}
      {query.isLoading && (
        <p className="text-sm text-muted-foreground">{t("sep28Apps.copy101")}</p>
      )}
      {query.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("sep28Apps.copy102")}</p>
      )}
      {query.data?.map((review) => (
        <article
          key={review.id}
          className="space-y-3 rounded-lg border border-border p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <a
              className="text-sm font-medium underline"
              href={`https://github.com/${review.repository}/pull/${review.pullNumber}`}
              target="_blank"
              rel="noreferrer"
            >
              {review.repository} #{review.pullNumber}
            </a>
            <span className="text-sm">
              {review.assessment?.complete
                ? `${review.assessment.score}/5`
                : githubReviewStatusLabel(review.state)}{" "}
              ·{" "}
              {review.conclusion ? githubReviewStatusLabel(review.conclusion) : t("sep28Apps.copy103")}
            </span>
          </div>
          <p className="text-sm">
            {review.assessment?.summary ?? review.event.title}
          </p>
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <code>{review.headSha.slice(0, 12)}</code>
            <span>{formatDateTime(review.updatedAt)}</span>
            <Link className="underline" to={`/issues/${review.issueId}`}>{t("sep28Apps.copy104")}</Link>
            {review.runId && (
              <Link
                className="underline"
                to={`/issues/${review.issueId}?runId=${review.runId}`}
              >{t("pages.agentDetail.runColumn")}</Link>
            )}
            {review.summaryUrl && (
              <a
                className="underline"
                href={review.summaryUrl}
                target="_blank"
                rel="noreferrer"
              >{t("pages.pipelines.deliverableSummary")}</a>
            )}
            {review.checkUrl && (
              <a
                className="underline"
                href={review.checkUrl}
                target="_blank"
                rel="noreferrer"
              >{t("sep28Apps.copy105")}</a>
            )}
          </div>
          {review.assessment && (
            <details className="text-sm">
              <summary className="cursor-pointer">{t("sep28Apps.copy106")}</summary>
              <p className="mt-2">{review.assessment.rationale}</p>
              <p className="mt-2 text-muted-foreground">
                {t("sep28Apps.reviewCoverage", { reviewed: review.assessment.coverage.reviewedPaths.length, omitted: review.assessment.coverage.omittedPaths.length })}
              </p>
              {review.assessment.coverage.limitations.map((limit, index) => (
                <p key={index} className="mt-1 text-muted-foreground">
                  {limit}
                </p>
              ))}
            </details>
          )}
        </article>
      ))}
    </section>
  );
}
