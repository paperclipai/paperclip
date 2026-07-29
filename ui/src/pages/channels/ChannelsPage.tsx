import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import {
  Building2,
  Hash,
  Inbox,
  Loader2,
  Lock,
  MessagesSquare,
  Radio,
  Sparkles,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { ChatComposer, type ChatComposerHandle } from "@/components/ChatComposer";
import { EmptyState } from "@/components/EmptyState";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/timeAgo";
import { channelsApi, type Channel, type ChannelWorkMode } from "@/api/channels";
import {
  CHANNEL_WORK_MODE_OPTIONS,
  ChannelMessageItem,
  composerToneForMode,
} from "./ChannelMessageItem";
import { ChannelThreadPanel } from "./ChannelThreadPanel";

function channelIcon(channel: Channel) {
  if (channel.kind === "project") return Hash;
  if (channel.kind === "private") return Lock;
  if (channel.kind === "dm" || channel.kind === "group_dm") return User;
  return MessagesSquare;
}

interface ChannelGroup {
  key: string;
  label: string;
  channels: Channel[];
}

function groupChannels(channels: Channel[]): ChannelGroup[] {
  const groups: ChannelGroup[] = [
    { key: "projects", label: "Projects", channels: [] },
    { key: "channels", label: "Channels", channels: [] },
    { key: "dms", label: "Direct messages", channels: [] },
  ];
  for (const channel of channels) {
    if (channel.archivedAt) continue;
    if (channel.kind === "project") groups[0].channels.push(channel);
    else if (channel.kind === "dm" || channel.kind === "group_dm") groups[2].channels.push(channel);
    else groups[1].channels.push(channel);
  }
  return groups.filter((group) => group.channels.length > 0);
}

export function ChannelsPage() {
  const { channelId } = useParams<{ channelId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany, reloadCompanies } = useCompany();

  const composerRef = useRef<ChatComposerHandle>(null);
  const [draft, setDraft] = useState("");
  const [workMode, setWorkMode] = useState<ChannelWorkMode>("ask");
  const [showCompleted, setShowCompleted] = useState(false);

  const channelsEnabled = selectedCompany?.channelsEnabled === true;
  const openThreadId = searchParams.get("thread");

  useEffect(() => {
    setBreadcrumbs([{ label: "Channels" }]);
  }, [setBreadcrumbs]);

  const channelsQuery = useQuery({
    queryKey: queryKeys.channels.list(selectedCompanyId!),
    queryFn: () => channelsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && channelsEnabled,
  });

  const channels = useMemo(() => channelsQuery.data ?? [], [channelsQuery.data]);
  const activeChannel = useMemo(
    () => channels.find((channel) => channel.id === channelId) ?? null,
    [channels, channelId],
  );

  const messagesQuery = useQuery({
    queryKey: queryKeys.channels.messages(channelId!, showCompleted),
    queryFn: () => channelsApi.listMessages(channelId!, { includeCompleted: showCompleted }),
    enabled: !!channelId && channelsEnabled,
  });

  const presenceQuery = useQuery({
    queryKey: queryKeys.channels.presence(selectedCompanyId!),
    queryFn: () => channelsApi.presence(selectedCompanyId!),
    enabled: !!selectedCompanyId && channelsEnabled,
  });

  // Opening a channel clears its unread dot. The read receipt is best-effort:
  // the timeline stays usable if the endpoint isn't live yet.
  useEffect(() => {
    if (!channelId || !channelsEnabled) return;
    let cancelled = false;
    void channelsApi
      .markRead(channelId)
      .then(() => {
        if (cancelled || !selectedCompanyId) return;
        void queryClient.invalidateQueries({ queryKey: queryKeys.channels.list(selectedCompanyId) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [channelId, channelsEnabled, queryClient, selectedCompanyId]);

  const enableChannelsMutation = useMutation({
    mutationFn: () => channelsApi.enableChannels(selectedCompanyId!, true),
    onSuccess: async () => {
      await reloadCompanies();
    },
  });

  const postMessage = useMutation({
    mutationFn: (body: string) =>
      channelsApi.postMessage(channelId!, { body, channelWorkMode: workMode }),
    onSuccess: () => {
      setDraft("");
      void queryClient.invalidateQueries({
        queryKey: queryKeys.channels.messages(channelId!, showCompleted),
      });
      composerRef.current?.focus();
    },
  });

  const openThread = useCallback(
    (rootId: string) => {
      const next = new URLSearchParams(searchParams);
      next.set("thread", rootId);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const closeThread = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete("thread");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Building2} message="Select a company to open channels." />;
  }

  if (!channelsEnabled) {
    return (
      <EmptyState
        icon={MessagesSquare}
        title="Turn on Channels"
        message="Work your company like a chat app: every project is a channel, every task is a root message, and updates land in its thread."
        description={
          enableChannelsMutation.error
            ? `Could not enable channels. ${(enableChannelsMutation.error as Error).message}`
            : undefined
        }
        action={enableChannelsMutation.isPending ? "Enabling…" : "Enable Channels"}
        onAction={() => enableChannelsMutation.mutate()}
        hideActionIcon
      />
    );
  }

  const groups = groupChannels(channels);
  const roots = messagesQuery.data?.messages ?? [];
  const presence = presenceQuery.data ?? [];
  const isProjectChannel = activeChannel?.kind === "project";

  return (
    <div className="flex h-(--sz-calc-29) flex-col -m-6">
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        {/* Left: channel list */}
        <nav
          aria-label="Channels"
          className="hidden w-64 shrink-0 flex-col overflow-y-auto border-r border-border md:flex"
        >
          <div className="flex shrink-0 items-center gap-2 px-4 py-3">
            <MessagesSquare className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold text-foreground">Channels</h1>
          </div>
          {channelsQuery.isLoading ? (
            <div className="flex justify-center py-6 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : channelsQuery.error ? (
            <p className="px-4 py-2 text-(length:--text-micro) text-muted-foreground">
              Channels aren’t available yet on this server.
            </p>
          ) : groups.length === 0 ? (
            <p className="px-4 py-2 text-(length:--text-micro) text-muted-foreground">
              No channels yet. They appear as projects are created.
            </p>
          ) : (
            <div className="flex flex-col gap-4 px-2 pb-4">
              {groups.map((group) => (
                <div key={group.key} className="flex flex-col gap-0.5">
                  <p className="px-3 py-1 text-(length:--text-nano) font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </p>
                  {group.channels.map((channel) => {
                    const Icon = channelIcon(channel);
                    const unread = (channel.unreadCount ?? 0) > 0;
                    const active = channel.id === channelId;
                    return (
                      <button
                        key={channel.id}
                        type="button"
                        data-testid="channel-list-item"
                        onClick={() => navigate(`/channels/${channel.id}`)}
                        className={cn(
                          "flex items-center gap-2 rounded-lg px-3 py-1.5 text-left text-(length:--text-compact) transition-colors",
                          active
                            ? "bg-accent font-medium text-foreground"
                            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
                        )}
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className={cn("min-w-0 flex-1 truncate", unread && "font-semibold")}>
                          {channel.name}
                        </span>
                        {unread ? (
                          <span
                            className="h-2 w-2 shrink-0 rounded-full bg-primary"
                            aria-label={`${channel.unreadCount} unread`}
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </nav>

        {/* Center: root timeline + composer */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!activeChannel ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <EmptyState
                icon={Hash}
                title="Pick a channel"
                message="Every project is a channel. Open one to see its tasks and start a conversation."
              />
            </div>
          ) : (
            <>
              <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-foreground">
                    {activeChannel.name}
                  </h2>
                  <p className="truncate text-(length:--text-micro) text-muted-foreground">
                    {activeChannel.topic ?? "Tasks and updates for this channel"}
                  </p>
                </div>
                {isProjectChannel ? (
                  <label className="flex shrink-0 items-center gap-2 text-(length:--text-micro) text-muted-foreground">
                    <span>Show completed</span>
                    <ToggleSwitch
                      checked={showCompleted}
                      onCheckedChange={setShowCompleted}
                      aria-label="Show completed tasks"
                    />
                  </label>
                ) : null}
              </header>

              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
                {messagesQuery.isLoading ? (
                  <div className="flex justify-center py-10 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                  </div>
                ) : messagesQuery.error ? (
                  <p className="px-2 py-6 text-sm text-muted-foreground">
                    Couldn’t load this channel’s tasks yet. You can still post below.
                  </p>
                ) : roots.length === 0 ? (
                  <EmptyState
                    icon={Sparkles}
                    title="No tasks here yet"
                    message="Start one below. Ask a question, draft a plan, or kick off work — each becomes a task with its own thread."
                  />
                ) : (
                  <div className="flex flex-col gap-1">
                    {roots.map((message) => (
                      <ChannelMessageItem
                        key={message.id}
                        message={message}
                        variant="root"
                        selected={message.id === openThreadId}
                        onOpenThread={(root) => openThread(root.id)}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div className="shrink-0 border-t border-border p-3">
                {postMessage.error ? (
                  <p className="mb-2 text-(length:--text-micro) text-destructive">
                    {(postMessage.error as Error).message}
                  </p>
                ) : null}
                <ChatComposer
                  ref={composerRef}
                  value={draft}
                  onChange={setDraft}
                  onSubmit={() => postMessage.mutate(draft.trim())}
                  submitting={postMessage.isPending}
                  tone={composerToneForMode(workMode)}
                  placeholder={
                    workMode === "ask"
                      ? "Ask the team a question…"
                      : workMode === "plan"
                        ? "Describe what should be planned…"
                        : "Describe the work to start…"
                  }
                  sendLabel="Post to channel"
                  leadingTools={
                    <div
                      role="radiogroup"
                      aria-label="Composer mode"
                      className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5"
                    >
                      {CHANNEL_WORK_MODE_OPTIONS.map((option) => (
                        <button
                          key={option.mode}
                          type="button"
                          role="radio"
                          aria-checked={workMode === option.mode}
                          title={option.hint}
                          onClick={() => setWorkMode(option.mode)}
                          className={cn(
                            "rounded-sm px-2 py-0.5 text-(length:--text-micro) font-medium transition-colors",
                            workMode === option.mode
                              ? "bg-background text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  }
                />
              </div>
            </>
          )}
        </section>

        {/* Right: thread panel when open, otherwise the standing rail */}
        {activeChannel && openThreadId ? (
          <div className="hidden w-96 shrink-0 lg:block">
            <ChannelThreadPanel
              channelId={activeChannel.id}
              rootId={openThreadId}
              includeCompleted={showCompleted}
              onClose={closeThread}
            />
          </div>
        ) : (
          <aside className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l border-border px-4 py-4 xl:flex">
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                <Inbox className="h-3.5 w-3.5" />
                Needs you
              </h2>
              {/* TODO(channels): render the Attention feed inline once the
                  channels-scoped slice lands; Decisions is the same source. */}
              <p className="text-(length:--text-micro) text-muted-foreground">
                Approvals, questions, and blocked tasks waiting on a human.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-2 w-full">
                <Link to="/decisions">Open Decisions</Link>
              </Button>
            </section>

            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                <Radio className="h-3.5 w-3.5" />
                Working now
              </h2>
              {presenceQuery.isLoading ? (
                <div className="flex justify-center py-3 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : presence.length === 0 ? (
                <p className="text-(length:--text-micro) text-muted-foreground">
                  No agents are running right now.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {presence.map((agent) => (
                    <li key={agent.agentId} className="flex min-w-0 items-start gap-2">
                      <span
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-(--status-task-done)"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-(length:--text-compact) font-medium text-foreground">
                          {agent.name}
                        </p>
                        <p className="truncate text-(length:--text-micro) text-muted-foreground">
                          {agent.issueIdentifier ?? agent.status}
                          {agent.startedAt ? ` · ${timeAgo(agent.startedAt)}` : ""}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}
