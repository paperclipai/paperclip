import { t as finalPagesT } from "@/i18n";
import { useTranslation, t as translate } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import {
  ExternalLink,
  GitPullRequest,
  MoreHorizontal,
  RefreshCw,
  Search,
} from "lucide-react";
import type {
  GitHubChatConfiguration,
  GitHubTaskReview,
} from "@paperclipai/shared";
import {
  githubChatApi,
  type GitHubConfigurationRecord,
} from "@/api/githubChat";
import {
  chatEndpointsApi,
  type ChatEndpoint,
} from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { MarkdownBody } from "@/components/MarkdownBody";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Link } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import {
  GitHubAccessEditor,
  GitHubPolicyEditor,
  GitHubToggle,
} from "./GitHubBotConfiguration";
import { ChatExecutionDefaults } from "./ChatExecutionDefaults";
import { describeError } from "@/api/errors";

export function GitHubRepositoryAccess({
  endpointId,
  companyId,
  managementUrl,
  pending,
  onRefresh,
  onChange,
  onToggleAll,
}: {
  endpointId: string;
  companyId: string;
  managementUrl: string;
  pending: boolean;
  onRefresh: () => void;
  onChange: (id: string, enabled: boolean) => void;
  onToggleAll: (enabled: boolean) => void;
}) {
  const { t } = useTranslation("connections");
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const list = useInfiniteQuery({
    queryKey: ["github-bot-repository-pages", endpointId, search],
    queryFn: ({ pageParam }) => githubChatApi.repositories(endpointId, { limit: 20, offset: pageParam, search }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  });
  const listView = useQueryView(list);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const summary = list.data?.pages[0];
  const disableAll = (summary?.enabledCount ?? 0) > 0;
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [search]);
  useEffect(() => {
    if (!list.hasNextPage || list.isFetching || list.isError || listView.kind === "error" || pending || !more.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void list.fetchNextPage({ cancelRefetch: false });
    }, { root: scroller.current });
    observer.observe(more.current);
    return () => observer.disconnect();
  }, [list.hasNextPage, list.isFetching, list.isError, listView.kind, list.fetchNextPage, pending]);
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">{t("repositories_c91e6e6")}</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("manage_repositories_0568a5a")}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <a href={managementUrl} target="_blank" rel="noreferrer">{t("manage_on_github_63db4b5")}<ExternalLink className="size-4" />
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onClick={onRefresh}>
              <RefreshCw className="size-4" />{t("refresh_repositories_9479bf5")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-xs text-muted-foreground">{t("choose_where_the_bot_can_receive_messages_bf947c1")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-48">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input aria-label={t("search_repositories_22ea133")} placeholder={t("search_repositories_22ea133")} className="pl-9"
            value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <Button variant="outline" size="sm" disabled={pending || list.isFetching || !summary || !summary.totalCount || (!disableAll && !summary.availableCount)}
          aria-label={t("all_repositories_52c8b23", { value: disableAll ? t("disable_9a7d4e0") : t("enable_20063ad") })}
          onClick={() => onToggleAll(!disableAll)}>
          {disableAll ? t("disable_all_485c590") : t("enable_all_1734db9")}
        </Button>
      </div>
      {summary && <p className="text-xs text-muted-foreground">{t("of_repositories_enabled_toggle_all_applies_across_6511d22", { enabledCount: summary.enabledCount, totalCount: summary.totalCount })}</p>}
      {listView.kind === "error" && (
        <QueryErrorState error={list.error} action="load repositories" onRetry={listView.retry} retrying={listView.isFetching} />
      )}
      <div ref={scroller} role="region" aria-label={t("repositories_c91e6e6")} tabIndex={0}
        className="max-h-96 overflow-y-auto overscroll-contain border-y border-border">
        <div className="divide-y divide-border">
        {rows.map((resource) => (
          <div key={resource.id} className="px-1 py-1">
            <GitHubToggle
              label={resource.label ?? resource.providerResourceId}
              checked={resource.enabled}
              disabled={
                pending ||
                (resource.availability !== "available" && !resource.enabled)
              }
              description={
                resource.availability === "available"
                  ? undefined
                  : t("unavailable_on_github_update_the_app_s_939bca4")
              }
              onChange={(enabled) => onChange(resource.id, enabled)}
            />
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">{t("task_defaults_e0ead87")}</summary>
              <div className="pt-3">
                <ChatExecutionDefaults
                  companyId={companyId}
                  value={resource.executionDefaults}
                  resource
                  onSave={async (executionDefaults) => {
                    await chatEndpointsApi.updateResources(endpointId, [{ id: resource.id, executionDefaults }]);
                    await client.invalidateQueries({ queryKey: ["github-bot-repositories", endpointId] });
                    await client.invalidateQueries({ queryKey: ["github-bot-repository-pages", endpointId] });
                  }}
                />
              </div>
            </details>
          </div>
        ))}
        </div>
        {list.isPending || listView.kind === "reconnecting" ? <p role="status" className="py-4 text-sm text-muted-foreground">{t("loading_repositories_a42923b")}</p> : (listView.kind === "ready" || listView.kind === "stale") && rows.length === 0 && (
          <p className="py-4 text-sm text-muted-foreground">
            {search ? t("no_repositories_match_your_search_b776903") : t("no_repositories_available_add_repository_access_on_17d5a13")}
          </p>
        )}
        {list.hasNextPage && <div ref={more} className="flex justify-center py-2">
          <Button variant="ghost" size="sm" disabled={pending || list.isFetching}
            onClick={() => void list.fetchNextPage({ cancelRefetch: false })}>
            {list.isFetchingNextPage ? t("loading_repositories_a42923b") : t("load_more_repositories_ccd19f0")}
          </Button>
        </div>}
      </div>
    </section>
  );
}

export function GitHubBotManagement({
  endpoint,
  view,
}: {
  endpoint: ChatEndpoint;
  view: "settings" | "access";
}) {
  const { t } = useTranslation("connections");
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["github-bot-configuration", endpoint.id],
    queryFn: () => githubChatApi.configuration(endpoint.id),
  });
  const configurationView = useQueryView(query);
  const [draft, setDraft] = useState<GitHubConfigurationRecord | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const [scoreText, setScoreText] = useState<string | null>(null);
  const [automaticMode, setAutomaticMode] = useState<"linked_authors" | "allowed_authors" | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const record = draft ?? query.data;
  const currentScoreText = scoreText ?? String(record?.configuration.defaults.ratingThreshold ?? 5);
  const score = Number(currentScoreText);
  const scoreValid = record?.configuration.defaults.ratingThreshold === null ||
    (currentScoreText.trim() !== "" && Number.isInteger(score) && score >= 1 && score <= 5);
  const dirty = Boolean(
    draft &&
      JSON.stringify(draft.configuration) !==
        JSON.stringify(query.data?.configuration),
  );
  const edit = (configuration: GitHubChatConfiguration) => {
    if (record) {
      if (configuration.defaults.invocation !== "mentions_only")
        setAutomaticMode(configuration.defaults.invocation);
      else if (record.configuration.defaults.invocation !== "mentions_only")
        setAutomaticMode(record.configuration.defaults.invocation);
      setDraft({ ...record, configuration });
    }
    setNotice("");
  };
  const act = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(describeError(e).body);
    } finally {
      setPending(false);
    }
  };
  if (configurationView.kind === "error")
    return (
      <QueryErrorState
        error={query.error}
        action="load the bot configuration"
        onRetry={configurationView.retry}
        retrying={configurationView.isFetching}
      />
    );
  if (!record)
    return (
      <p role="status" className="text-sm text-muted-foreground">{t("loading_configuration_24dc18a")}</p>
    );
  const config = record.configuration;
  return (
    <section className="max-w-3xl space-y-8">
      <fieldset disabled={pending} className="min-w-0 space-y-8">
        {view === "access" ? (
          <>
            <GitHubRepositoryAccess
              endpointId={endpoint.id}
              companyId={endpoint.companyId}
              pending={pending}
              managementUrl={
                endpoint.setup?.github?.managementUrl ??
                endpoint.setup?.github?.installationUrl ??
                "https://github.com/settings/installations"
              }
              onRefresh={() =>
                void act(async () => {
                  await githubChatApi.refreshRepositories(endpoint.id);
                  await client.invalidateQueries({ queryKey: ["github-bot-repositories", endpoint.id] });
                  await client.invalidateQueries({ queryKey: ["github-bot-repository-pages", endpoint.id] });
                  setNotice(
                    "final-pages:Repository_access_refreshed_New_repositories_stay_disabled_1b9f71",
                  );
                })
              }
              onChange={(id, enabled) =>
                void act(async () => {
                  await chatEndpointsApi.updateResources(endpoint.id, [
                    { id, enabled },
                  ]);
                  await client.invalidateQueries({ queryKey: ["github-bot-repositories", endpoint.id] });
                  await client.invalidateQueries({ queryKey: ["github-bot-repository-pages", endpoint.id] });
                })
              }
              onToggleAll={(enabled) => void act(async () => {
                await githubChatApi.toggleAllRepositories(endpoint.id, enabled);
                await client.invalidateQueries({ queryKey: ["github-bot-repositories", endpoint.id] });
                await client.invalidateQueries({ queryKey: ["github-bot-repository-pages", endpoint.id] });
              })}
            />
            <GitHubAccessEditor
              endpointId={endpoint.id}
              companyId={endpoint.companyId}
              configuration={config}
              onChange={edit}
            />
            {!config.toolsEnabled && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t("this_saved_bot_has_github_tools_disabled_ebbbd15")}</p>
                <Button
                  variant="outline"
                  onClick={() => edit({ ...config, toolsEnabled: true })}
                >{t("enable_bot_tools_f57064c")}</Button>
              </div>
            )}
            {endpoint.connectionId && (
              <Link
                className="text-xs text-muted-foreground underline underline-offset-4"
                to={`/apps/${endpoint.connectionId}`}
              >{t("manage_tool_permissions_1b2dfc7")}</Link>
            )}
          </>
        ) : (
          <>
            <GitHubPolicyEditor key={editorVersion}
              readOnly={pending}
              scoreText={currentScoreText}
              onScoreTextChange={setScoreText}
              rememberedAutomaticMode={automaticMode ?? (config.defaults.invocation === "mentions_only" ? "linked_authors" : config.defaults.invocation)}
              accessHref={`/apps/chat/${endpoint.id}/access`}
              policy={config.defaults}
              onChange={(defaults) => edit({ ...config, defaults })}
            />
          </>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {finalPagesT(notice)}
        </p>
      )}
      {(dirty || !scoreValid) && (
        <div className="sticky bottom-(--tc-composer-bottom) z-10 flex items-center justify-between gap-3 border-t border-border bg-background py-4 md:bottom-0">
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setDraft(null);
              setScoreText(null);
              setAutomaticMode(null);
              setEditorVersion((value) => value + 1);
              setError("");
            }}
          >{t("discard_changes_6ec9056")}</Button>
          <Button
            disabled={pending || !scoreValid}
            onClick={() =>
              void act(async () => {
                const saved = await githubChatApi.save(
                  endpoint.id,
                  record.revision,
                  config,
                );
                client.setQueryData(
                  ["github-bot-configuration", endpoint.id],
                  saved,
                );
                setDraft(null);
                setScoreText(null);
                setAutomaticMode(null);
                setNotice("final-pages:Changes_saved_12b3f1");
              })
            }
          >
            {pending ? t("saving_56a2285") : t("save_changes_179359b")}
          </Button>
        </div>
      )}
    </section>
  );
}

export function orderedGitHubReviews(reviews: GitHubTaskReview[]) {
  return [...reviews].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

export function gitHubReviewResultLabel(review: GitHubTaskReview) {
  const completed = review.state === "completed" && review.assessment?.complete;
  const conclusion = review.conclusion
    ? {
        success: translate("connections:passed_271d60f"),
        failure: translate("connections:below_threshold_064474a"),
        neutral: translate("connections:report_only_f08b1e3"),
        action_required: translate("connections:action_required_a5f995a"),
      }[review.conclusion]
    : translate("connections:awaiting_check_822f57b");
  const state = {
    queued: translate("connections:queued_6a59987"),
    running: translate("connections:reviewing_166ea85"),
    completed: translate("connections:incomplete_387fd1b"),
    incomplete: translate("connections:incomplete_387fd1b"),
    error: translate("connections:review_failed_5522c93"),
    superseded: translate("connections:superseded_8b462d9"),
    manual_required: translate("connections:action_required_a5f995a"),
  }[review.state];
  return completed ? `${review.assessment!.score}/5 · ${conclusion}` : state;
}

function ReviewResult({ review }: { review: GitHubTaskReview }) {
  const { t } = useTranslation("connections");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-sm font-medium">
          {gitHubReviewResultLabel(review)}
        </span>
        <span className="text-xs text-muted-foreground">{t("commit_0104968")}<code>{review.headSha.slice(0, 7)}</code> ·{" "}
          {formatDateTime(review.updatedAt)}
        </span>
      </div>
      {review.assessment ? (
        <MarkdownBody className="text-sm">
          {review.assessment.summary}
        </MarkdownBody>
      ) : (
        <p className="text-sm text-muted-foreground">{t("no_assessment_has_been_submitted_yet_9b67b96")}</p>
      )}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <Link
          className="underline underline-offset-4"
          to={`/issues/${review.issueId}`}
        >{t("paperclip_task_255d50c")}</Link>
        {review.summaryUrl && (
          <a
            className="underline underline-offset-4"
            href={review.summaryUrl}
            target="_blank"
            rel="noreferrer"
          >{t("github_comment_43b7adf")}</a>
        )}
        {review.checkUrl && (
          <a
            className="underline underline-offset-4"
            href={review.checkUrl}
            target="_blank"
            rel="noreferrer"
          >{t("check_5599a83")}</a>
        )}
      </div>
      <section className="space-y-4 text-sm" aria-label={t("review_evidence_ab34d96")}>
        <div className="space-y-3">
          {review.runId && (
            <Link
              className="text-xs underline underline-offset-4"
              to={`/issues/${review.issueId}?runId=${review.runId}`}
            >{t("agent_run_f9df715")}</Link>
          )}
          {review.assessment && (
            <>
              <h3 className="font-medium">{t("rationale_98365ab")}</h3>
              <MarkdownBody>{review.assessment.rationale}</MarkdownBody>
              {review.assessment.findings.length > 0 && (
                <section className="space-y-3">
                  <h3 className="font-medium">{t("findings_ca9b7e7")}</h3>
                  {review.assessment.findings.map((finding) => (
                    <div
                      key={finding.key}
                      className="space-y-2 border-l border-border pl-4"
                    >
                      <p className="break-all font-mono text-xs">
                        {finding.path}:{finding.line} · {finding.severity}
                      </p>
                      <MarkdownBody>{finding.body}</MarkdownBody>
                    </div>
                  ))}
                </section>
              )}
              <h3 className="font-medium">{t("coverage_80e1354")}</h3>
              <p className="text-xs text-muted-foreground">{t("files_reviewed_omitted_9e2c9a6", { length: review.assessment.coverage.reviewedPaths.length, length2: review.assessment.coverage.omittedPaths.length })}</p>
              {review.assessment.coverage.limitations.map((limit, index) => (
                <p key={index} className="text-xs text-muted-foreground">
                  {limit}
                </p>
              ))}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

export function GitHubReviewList({
  endpointId,
  reviews,
}: {
  endpointId: string;
  reviews: GitHubTaskReview[];
}) {
  const { t } = useTranslation("connections");
  if (!reviews.length)
    return (
      <EmptyState
        icon={GitPullRequest}
        message={t("no_reviews_yet_e4d2123")}
        description={t("mention_the_bot_on_a_pull_request_d33d256")}
      />
    );
  return (
    <ul
      aria-label={t("reviews_b83c4cd")}
      className="divide-y divide-border border-y border-border"
    >
      {orderedGitHubReviews(reviews).map((review) => (
        <li key={review.id}>
          <Link
            to={`/apps/chat/${endpointId}/reviews/${review.id}`}
            className="flex flex-wrap items-center gap-x-6 gap-y-2 py-4 text-sm hover:bg-accent/50"
          >
            <div className="min-w-0 flex-1 basis-48 space-y-1">
              <p className="break-words font-medium">
                {review.event.title || t("pull_request_4770f36", { pullNumber: review.pullNumber })}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {review.repository} #{review.pullNumber} ·{" "}
                <code>{review.headSha.slice(0, 7)}</code>
              </p>
            </div>
            <div className="space-y-1 text-right">
              <p className="font-medium">{gitHubReviewResultLabel(review)}</p>
              <time
                className="text-xs text-muted-foreground"
                dateTime={review.createdAt}
              >
                {formatDateTime(review.createdAt)}
              </time>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function GitHubReviewDetail({
  endpointId,
  review,
}: {
  endpointId: string;
  review: GitHubTaskReview;
}) {
  const { t } = useTranslation("connections");
  return (
    <article className="max-w-3xl space-y-6">
      <Link
        className="text-sm text-muted-foreground hover:underline"
        to={`/apps/chat/${endpointId}/reviews`}
      >{t("all_reviews_933023e")}</Link>
      <header className="space-y-2">
        <h2 className="text-lg font-semibold">
          {review.event.title || t("pull_request_4770f36", { pullNumber: review.pullNumber })}
        </h2>
        <a
          className="break-all text-sm text-muted-foreground hover:underline"
          href={`https://github.com/${review.repository}/pull/${review.pullNumber}`}
          target="_blank"
          rel="noreferrer"
        >
          {review.repository} #{review.pullNumber}
        </a>
      </header>
      <ReviewResult review={review} />
    </article>
  );
}

export function GitHubReviews({
  endpointId,
  reviewId,
}: {
  endpointId: string;
  reviewId?: string;
}) {
  const { t } = useTranslation("connections");
  const query = useQuery({
    queryKey: ["github-bot-reviews", endpointId, reviewId ?? "list"],
    queryFn: async () => reviewId ? [await githubChatApi.review(endpointId, reviewId)] : githubChatApi.reviews(endpointId),
    refetchInterval: 5000,
  });
  const view = useQueryView(query);
  const missingReview = (
    <div className="space-y-3">
      <p role="alert" className="text-sm text-muted-foreground">{t("this_review_was_not_found_in_this_f5fb9c4")}</p>
      <Link
        to={`/apps/chat/${endpointId}/reviews`}
        className="text-sm underline"
      >{t("all_reviews_0bdfef1")}</Link>
    </div>
  );
  if (view.kind === "error") {
    if (reviewId && view.errorKind === "not_found") return missingReview;
    return (
      <QueryErrorState
        error={query.error}
        action={reviewId ? "load the review" : "load reviews"}
        onRetry={view.retry}
        retrying={view.isFetching}
      />
    );
  }
  if (query.isPending || view.kind === "reconnecting")
    return (
      <p role="status" className="text-sm text-muted-foreground">{t("loading_reviews_ceaf918")}</p>
    );
  if (reviewId) {
    const review = query.data?.find((review) => review.id === reviewId);
    return review ? (
      <GitHubReviewDetail endpointId={endpointId} review={review} />
    ) : missingReview;
  }
  return <GitHubReviewList endpointId={endpointId} reviews={query.data ?? []} />;
}
