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
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
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
      setError(e instanceof Error ? e.message : "Could not save changes.");
    } finally {
      setPending(false);
    }
  };
  if (query.isError || resources.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load the bot configuration.{" "}
        <Button
          variant="link"
          onClick={() => {
            void query.refetch();
            void resources.refetch();
          }}
        >
          Try again
        </Button>
      </p>
    );
  if (!record)
    return (
      <p className="text-sm text-muted-foreground">Loading configuration…</p>
    );
  const config = record.configuration;
  const override = repository ? config.repositories[repository] : undefined;
  return (
    <section className="max-w-3xl space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">
          {view === "access"
            ? "Who can start work"
            : "Agent and review behavior"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {endpoint.assignedAgentName} is permanently assigned to this bot.
          GitHub messages create or continue Paperclip tasks; reviews are
          results of those runs.
        </p>
        <Link
          className="text-sm underline"
          to={`/apps/${endpoint.connectionId}`}
        >
          Bot’s GitHub tool connection
        </Link>
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
            label="Agent can use this bot’s GitHub tools"
            description="Uses the same GitHub App, limited to this bot’s enabled repositories and bound tasks. Tool policies still apply."
            checked={config.toolsEnabled}
            onChange={(toolsEnabled) => edit({ ...config, toolsEnabled })}
          />
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium">Repository access</h3>
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
                        "Repository access refreshed. New repositories stay disabled.",
                      );
                    })
                  }
                >
                  <RefreshCw className="size-4" />
                  Refresh
                </Button>
                <Button variant="outline" size="sm" asChild>
                  <a
                    href={
                      endpoint.setup?.github?.managementUrl ??
                      endpoint.setup?.github?.installationUrl ??
                      "https://github.com/settings/installations"
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    Configure on GitHub
                    <ExternalLink className="size-4" />
                  </a>
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              These repositories come from the bot App’s installation. Choose
              where this bot can receive messages and use tools in Paperclip.
            </p>
            {resources.data
              ?.filter((r) => r.type === "repository")
              .map((resource) => (
                <GitHubToggle
                  key={resource.id}
                  label={resource.label ?? resource.providerResourceId}
                  description={
                    resource.availability === "available"
                      ? undefined
                      : "Installation access is unavailable. Update access on GitHub and refresh."
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
            >
              Review configuration
            </label>
            <select
              id="github-policy-repository"
              className={githubSelectClass}
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            >
              <option value="">Connection defaults</option>
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
              label="Override connection defaults"
              description="This repository can have its own prompts, filters, and publication permissions."
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
            <p className="text-sm text-muted-foreground">
              This repository follows the connection defaults.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
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
        >
          Discard changes
        </Button>
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
              setNotice("Configuration saved.");
            })
          }
        >
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </section>
  );
}

export function GitHubReviews({ endpointId }: { endpointId: string }) {
  const query = useQuery({
    queryKey: ["github-bot-reviews", endpointId],
    queryFn: () => githubChatApi.reviews(endpointId),
    refetchInterval: 5000,
  });
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Reviews</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review activity from the agent’s Paperclip tasks. Open a task for the
          conversation and execution history.
        </p>
      </div>
      {query.isError && (
        <p role="alert" className="text-sm text-destructive">
          Reviews could not be loaded.{" "}
          <Button variant="link" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </p>
      )}
      {query.isLoading && (
        <p className="text-sm text-muted-foreground">Loading reviews…</p>
      )}
      {query.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No reviews yet. Mention the bot on an enabled repository’s PR, or
          enable automatic review events in Settings.
        </p>
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
                : review.state.replaceAll("_", " ")}{" "}
              ·{" "}
              {review.conclusion?.replaceAll("_", " ") ?? "Awaiting assessment"}
            </span>
          </div>
          <p className="text-sm">
            {review.assessment?.summary ?? review.event.title}
          </p>
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <code>{review.headSha.slice(0, 12)}</code>
            <span>{formatDateTime(review.updatedAt)}</span>
            <Link className="underline" to={`/issues/${review.issueId}`}>
              Paperclip task
            </Link>
            {review.runId && (
              <Link
                className="underline"
                to={`/issues/${review.issueId}?runId=${review.runId}`}
              >
                Run
              </Link>
            )}
            {review.summaryUrl && (
              <a
                className="underline"
                href={review.summaryUrl}
                target="_blank"
                rel="noreferrer"
              >
                Summary
              </a>
            )}
            {review.checkUrl && (
              <a
                className="underline"
                href={review.checkUrl}
                target="_blank"
                rel="noreferrer"
              >
                Check
              </a>
            )}
          </div>
          {review.assessment && (
            <details className="text-sm">
              <summary className="cursor-pointer">
                Rationale and coverage
              </summary>
              <p className="mt-2">{review.assessment.rationale}</p>
              <p className="mt-2 text-muted-foreground">
                {review.assessment.coverage.reviewedPaths.length} files reviewed
                · {review.assessment.coverage.omittedPaths.length} omitted
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
