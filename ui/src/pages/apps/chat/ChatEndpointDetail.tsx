import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Unlink,
} from "lucide-react";
import {
  chatEndpointsApi,
  type ChatActivityItem,
  type ChatEndpointResource,
  type ChatProvider,
} from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { PageTabBar } from "@/components/PageTabBar";
import { StatusBadge } from "@/components/StatusBadge";
import { Tabs } from "@/components/ui/tabs";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { formatDate } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { Link, Navigate, useNavigate, useParams } from "@/lib/router";

const tabs = ["settings", "access", "conversations", "activity"] as const;
type ChatTab = (typeof tabs)[number];
const tabItems = tabs.map((value) => ({
  value,
  label: value[0].toUpperCase() + value.slice(1),
}));
const providerNames: Record<ChatProvider, string> = {
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
};

const providerLifecycleGuidance: Record<
  ChatProvider,
  { reconnect: string; remove: string }
> = {
  slack: {
    reconnect:
      "Reconnect verifies or replaces credentials for this same Slack app. It does not reinstall the app or change its workspace or channel membership.",
    remove:
      "Paperclip archives the endpoint, stops new ingress, and retires its saved Slack credentials. It does not uninstall the Slack app: the app remains installed, and its bot remains in channels, until you remove them in Slack.",
  },
  github: {
    reconnect:
      "Reconnect verifies this same GitHub App and installation. It does not reinstall the App or change repository access.",
    remove:
      "Paperclip archives the endpoint, stops new ingress, and retires its saved App key and webhook secret. It does not uninstall the GitHub App: the App, its installations, and its webhook settings remain until you remove or update them on GitHub.",
  },
  discord: {
    reconnect:
      "Reconnect verifies this same Discord application and server installation. It does not add or remove the bot from the server.",
    remove:
      "Paperclip archives the endpoint, stops its Paperclip Gateway connection, and retires its saved bot token. It does not uninstall the bot: the bot remains in the Discord server, and the application remains in the Developer Portal, until you remove them there.",
  },
  "microsoft-teams": {
    reconnect:
      "Reconnect verifies this same Microsoft app, tenant, and bot identity. It does not upload or reinstall the Teams app.",
    remove:
      "Paperclip archives the endpoint, stops new ingress, and retires its saved client secret. It does not uninstall the Teams app: the Entra app registration, Azure Bot, custom Teams app, and Teams installations remain until you remove them in Microsoft.",
  },
  telegram: {
    reconnect:
      "Reconnect verifies this same BotFather bot and automatically refreshes its Paperclip webhook and command menu.",
    remove:
      "Paperclip archives the endpoint and queues durable removal of its Telegram webhook and command menu. After Telegram confirms that cleanup, Paperclip retires the saved token. The BotFather bot and its chat memberships remain until you remove them in Telegram.",
  },
};

const activityKindLabels: Record<ChatActivityItem["kind"], string> = {
  delivery: "Inbound delivery",
  publication: "Outbound publication",
  action: "Provider action",
  health: "Connection health",
  repair: "Connection repair",
};

const replayableFailureStates = new Set(["failed"]);

export function isReplayEligible(item: ChatActivityItem): boolean {
  if (!item.replayable || !replayableFailureStates.has(item.status)) {
    return false;
  }
  if (item.kind === "delivery") return item.status === "failed";
  return item.kind === "publication";
}

export function isResolutionEligible(item: ChatActivityItem): boolean {
  return (
    (item.kind === "publication" || item.kind === "action") &&
    item.status === "delivery_unknown" &&
    (item.resolutionActions?.length ?? 0) > 0
  );
}

export function isIndividuallyToggleableResource(
  provider: ChatProvider,
  resourceType: string,
): boolean {
  return !(
    provider === "microsoft-teams" &&
    (resourceType === "direct_message" || resourceType === "group_chat")
  );
}

function activityDetailLabel(item: ChatActivityItem): string {
  return replayableFailureStates.has(item.status) ? "Reason" : "Details";
}

export function ChatEndpointDetail() {
  const { endpointId = "", tab = "settings" } = useParams<{
    endpointId: string;
    tab?: string;
  }>();
  const activeTab = tabs.includes(tab as ChatTab) ? (tab as ChatTab) : null;
  const navigate = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();
  const endpointQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.detail(endpointId),
    queryFn: () => chatEndpointsApi.get(endpointId),
    enabled: Boolean(endpointId && activeTab),
  });
  const endpoint = endpointQuery.data;

  useEffect(() => {
    if (!endpoint || !activeTab) return;
    setBreadcrumbs([
      { label: "Connectors", href: "/apps" },
      {
        label: `${endpoint.assignedAgentName} · ${providerNames[endpoint.provider]}`,
        href: `/apps/chat/${endpoint.id}/settings`,
      },
      {
        label:
          tabItems.find((item) => item.value === activeTab)?.label ??
          "Settings",
      },
    ]);
    return () => setBreadcrumbs([]);
  }, [activeTab, endpoint, setBreadcrumbs]);

  if (!activeTab)
    return <Navigate replace to={`/apps/chat/${endpointId}/settings`} />;
  if (endpointQuery.isLoading)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading connection…
      </div>
    );
  if (endpointQuery.isError || !endpoint)
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">
          This chat connection could not be loaded.
        </p>
        <Button variant="outline" onClick={() => endpointQuery.refetch()}>
          Try again
        </Button>
      </div>
    );

  return (
    <div className="max-w-5xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">
            {endpoint.assignedAgentName} in {providerNames[endpoint.provider]}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {endpoint.providerAccountLabel ?? "Chat connection"}
          </p>
        </div>
        <StatusBadge status={endpoint.status} />
      </header>
      <Tabs
        value={activeTab}
        onValueChange={(next) => navigate(`/apps/chat/${endpoint.id}/${next}`)}
      >
        <PageTabBar
          items={tabItems}
          value={activeTab}
          onValueChange={(next) =>
            navigate(`/apps/chat/${endpoint.id}/${next}`)
          }
          align="start"
        />
      </Tabs>
      {activeTab === "settings" && (
        <Settings endpointId={endpoint.id} endpoint={endpoint} />
      )}
      {activeTab === "access" && (
        <Access
          endpointId={endpoint.id}
          allowUnlinked={endpoint.allowUnlinkedPeople}
        />
      )}
      {activeTab === "conversations" && (
        <Conversations endpointId={endpoint.id} provider={endpoint.provider} />
      )}
      {activeTab === "activity" && (
        <Activity endpointId={endpoint.id} endpoint={endpoint} />
      )}
    </div>
  );
}

function Settings({
  endpointId,
  endpoint,
}: {
  endpointId: string;
  endpoint: Awaited<ReturnType<typeof chatEndpointsApi.get>>;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const resourcesQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.resources(endpointId),
    queryFn: () => chatEndpointsApi.listResources(endpointId),
  });
  const saveResources = useMutation({
    mutationFn: (resources: ChatEndpointResource[]) =>
      chatEndpointsApi.updateResources(
        endpointId,
        resources.map(({ id, enabled }) => ({ id, enabled })),
      ),
    onSuccess: (resources) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.resources(endpointId),
        resources,
      ),
    onError: (error) =>
      pushToast({
        title: "Couldn't update destination",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      }),
  });
  const updateEndpoint = useMutation({
    mutationFn: chatEndpointsApi.update.bind(null, endpointId),
    onSuccess: (next) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      ),
    onError: (error) =>
      pushToast({
        title: "Couldn't update settings",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      }),
  });
  const resources = resourcesQuery.data ?? [];
  const destinationResources = resources.filter((resource) =>
    isIndividuallyToggleableResource(endpoint.provider, resource.type),
  );
  const toggleResource = (resource: ChatEndpointResource, enabled: boolean) =>
    saveResources.mutate(
      resources.map((item) =>
        item.id === resource.id ? { ...item, enabled } : item,
      ),
    );
  return (
    <section className="max-w-3xl space-y-7">
      {endpoint.provider === "slack" && endpoint.setup?.command && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Slack command</h2>
          <div className="rounded-lg border border-border p-3 text-sm">
            <code>{endpoint.setup.command}</code>
            <p className="mt-2 text-muted-foreground">
              Start work with{" "}
              <code>{endpoint.setup.command} investigate this</code>. In a
              direct message, use <code>{endpoint.setup.command} status</code>,{" "}
              <code>{endpoint.setup.command} new</code>, or{" "}
              <code>{endpoint.setup.command} close</code>. Slack&apos;s bare{" "}
              <code>/status</code> command is not a Paperclip control.
            </p>
          </div>
        </div>
      )}
      {endpoint.provider === "telegram" && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">Telegram group command</h2>
          <div className="rounded-lg border border-border p-3 text-sm">
            <code>
              /task@
              {endpoint.botUsername?.replace(/^@/, "") ?? "bot_username"}{" "}
              &lt;request&gt;
            </code>
            <p className="mt-2 text-muted-foreground">
              Telegram&apos;s default privacy mode does not deliver ordinary
              mentions to bots. Use this command to start or continue group
              work, or reply directly to a message from the bot.
            </p>
          </div>
        </div>
      )}
      <div>
        <h2 className="text-lg font-semibold">Where this agent can work</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Provider membership makes a destination available. Paperclip responds
          only where you enable it.
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Destinations</h3>
        {resourcesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading destinations…</p>
        ) : destinationResources.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No provider destinations have been discovered yet.
          </p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {destinationResources.map((resource) => (
              <div key={resource.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {resource.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {resource.availability === "available"
                      ? (resource.detail ?? resource.type)
                      : "Unavailable at the provider"}
                  </p>
                </div>
                <ToggleSwitch
                  aria-label={`Enable ${resource.label}`}
                  checked={resource.enabled}
                  disabled={
                    resource.availability !== "available" ||
                    saveResources.isPending
                  }
                  onCheckedChange={(enabled) =>
                    toggleResource(resource, enabled)
                  }
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {endpoint.provider !== "github" && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Private conversations</h3>
          <SettingToggle
            label="Allow direct messages"
            detail="People can start or continue a task in a direct conversation."
            checked={endpoint.allowDirectMessages ?? false}
            pending={updateEndpoint.isPending}
            onChange={(allowDirectMessages) =>
              updateEndpoint.mutate({ allowDirectMessages })
            }
          />
          {endpoint.provider === "microsoft-teams" && (
            <SettingToggle
              label="Allow group chats"
              detail="The bot may participate in group chats where it is installed."
              checked={endpoint.allowGroupChats ?? false}
              pending={updateEndpoint.isPending}
              onChange={(allowGroupChats) =>
                updateEndpoint.mutate({ allowGroupChats })
              }
            />
          )}
        </div>
      )}
    </section>
  );
}

function SettingToggle({
  label,
  detail,
  checked,
  pending,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  pending: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-y border-border py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <ToggleSwitch
        aria-label={label}
        checked={checked}
        disabled={pending}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function Access({
  endpointId,
  allowUnlinked,
}: {
  endpointId: string;
  allowUnlinked: boolean;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [confirmationUrl, setConfirmationUrl] = useState<string | null>(null);
  const linksQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
  });
  const updatePolicy = useMutation({
    mutationFn: (value: boolean) =>
      chatEndpointsApi.update(endpointId, { allowUnlinkedPeople: value }),
    onSuccess: (next) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      ),
  });
  const createIntent = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.createLinkIntent(endpointId, principalId),
    onSuccess: ({ confirmationUrl }) => {
      setConfirmationUrl(
        new URL(confirmationUrl, window.location.origin).toString(),
      );
      pushToast({
        title: "Private identity-link URL created",
        body: "Send it only to the person whose provider identity is shown.",
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't create identity link",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      }),
  });
  const revoke = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.revokeLink(endpointId, principalId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.principals(endpointId),
      }),
  });
  const links = linksQuery.data ?? [];
  return (
    <section className="max-w-3xl space-y-7">
      <div>
        <h2 className="text-lg font-semibold">External identity access</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Linked identities act as their current Paperclip user. Unlinked
          people, when allowed, receive a fixed restricted profile.
        </p>
      </div>
      <SettingToggle
        label="Allow unlinked people"
        detail="They may converse and attach safe files, but cannot approve, hire, spend, manage access, or reassign agents."
        checked={allowUnlinked}
        pending={updatePolicy.isPending}
        onChange={(value) => updatePolicy.mutate(value)}
      />
      {confirmationUrl && (
        <div className="space-y-2 border-y border-border py-3">
          <p className="text-sm font-medium">Private confirmation link</p>
          <p className="break-all text-xs text-muted-foreground">
            {confirmationUrl}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(confirmationUrl).then(
                () =>
                  pushToast({
                    title: "Confirmation link copied",
                    tone: "success",
                  }),
                () =>
                  pushToast({
                    title: "Couldn't copy the link",
                    body: "Select and copy it manually.",
                    tone: "error",
                  }),
              );
            }}
          >
            <Copy />
            Copy link
          </Button>
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Identity links</h3>
        {links.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            External people appear here after they message the agent.
          </p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {links.map((link) => (
              <div
                key={link.id}
                className="flex flex-wrap items-center gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{link.externalLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    {link.paperclipUserLabel
                      ? `Linked to ${link.paperclipUserLabel}`
                      : (link.externalDetail ?? "Not linked")}
                  </p>
                </div>
                {link.status === "linked" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(link.principalId)}
                  >
                    <Unlink />
                    Revoke
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={createIntent.isPending}
                    onClick={() => createIntent.mutate(link.principalId)}
                  >
                    Create private link
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Conversations({
  endpointId,
  provider,
}: {
  endpointId: string;
  provider: ChatProvider;
}) {
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.conversations(endpointId),
    queryFn: () => chatEndpointsApi.listConversations(endpointId),
  });
  const rows = query.data ?? [];
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Conversations</h2>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          No conversations yet. Address the agent in an enabled destination to
          start one.
        </p>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {rows.map((row) => (
            <div key={row.id} className="grid gap-3 py-4 md:grid-cols-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {row.externalLabel}
                </p>
                <p className="text-xs text-muted-foreground">
                  {providerNames[provider]}
                </p>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {row.issueIdentifier ? `${row.issueIdentifier} · ` : ""}
                  {row.issueTitle ?? "Waiting for task"}
                </p>
                <StatusBadge status={row.state} />
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                {row.externalUrl && (
                  <Button asChild size="sm" variant="outline">
                    <a href={row.externalUrl} target="_blank" rel="noreferrer">
                      Open {providerNames[provider]} <ExternalLink />
                    </a>
                  </Button>
                )}
                {row.issueId && (
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/issues/${row.issueId}`}>Open task</Link>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Activity({
  endpointId,
  endpoint,
}: {
  endpointId: string;
  endpoint: Awaited<ReturnType<typeof chatEndpointsApi.get>>;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [resolutionItem, setResolutionItem] = useState<ChatActivityItem | null>(
    null,
  );
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.activity(endpointId),
    queryFn: () => chatEndpointsApi.listActivity(endpointId),
  });
  const replay = useMutation({
    mutationFn: (item: ChatActivityItem) =>
      item.kind === "publication"
        ? chatEndpointsApi.replayPublication(endpointId, item.id)
        : chatEndpointsApi.replayDelivery(endpointId, item.id),
    onSuccess: async (_result, item) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.activity(endpointId),
      });
      pushToast({
        title: `${item.kind === "publication" ? "Publication" : "Delivery"} queued for replay`,
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't replay activity",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      }),
  });
  const resolveActivity = useMutation({
    mutationFn: (input: {
      item: ChatActivityItem;
      action: "mark_delivered" | "retry_anyway" | "cancel";
    }) => {
      if (input.item.kind === "publication") {
        return chatEndpointsApi.resolvePublication(
          endpointId,
          input.item.id,
          input.action,
        );
      }
      return chatEndpointsApi.resolveAction(
        endpointId,
        input.item.id,
        input.action,
      );
    },
    onSuccess: async (_result, input) => {
      setResolutionItem(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.activity(endpointId),
      });
      pushToast({
        title:
          input.item.actionType === "slash_task_start" &&
          input.action === "retry_anyway"
            ? "Task start retried"
            : input.item.actionType === "slash_task_start"
              ? "Task start cancelled"
              : input.item.actionType === "provider_effect" &&
                  input.action === "mark_delivered"
                ? "Provider reply marked delivered"
                : input.item.actionType === "provider_effect" &&
                    input.action === "retry_anyway"
                  ? "Provider reply retried"
                  : input.item.actionType === "provider_effect"
                    ? "Provider reply cancelled"
                    : input.action === "mark_delivered"
                      ? "Publication marked delivered"
                      : input.action === "retry_anyway"
                        ? "Publication queued for retry"
                        : "Publication cancelled",
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't resolve activity",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      }),
  });
  const lifecycle = useMutation({
    mutationFn: (action: "pause" | "resume" | "remove") =>
      chatEndpointsApi.setup(endpointId, { action }),
    onSuccess: async (next, action) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.list(next.companyId),
      });
      if (action === "remove") {
        navigate("/apps");
        return;
      }
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      );
      pushToast({
        title: action === "pause" ? "Connection paused" : "Connection resumed",
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Couldn't update connection",
        body: error instanceof Error ? error.message : "Try again.",
        tone: "error",
      }),
  });
  const rows = query.data ?? [];
  const { status, healthMessage, lastError } = endpoint;
  const lifecycleAction = lifecycle.variables;
  const callbackSurfaceRows = endpoint.setup?.callbackSurfaces
    ? ([
        ["Events API", endpoint.setup.callbackSurfaces.events],
        ["Interactivity", endpoint.setup.callbackSurfaces.interactivity],
        ["Slash command", endpoint.setup.callbackSurfaces.slashCommands],
      ] as const)
    : [];
  return (
    <section className="space-y-5">
      <h2 className="text-lg font-semibold">Connection activity</h2>
      {(healthMessage || lastError) && (
        <div
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${status === "attention" || status === "revoked" ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-border bg-muted/30 text-foreground"}`}
        >
          {(status === "attention" || status === "revoked") && (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div>
            {healthMessage && <p>{healthMessage}</p>}
            {lastError && (
              <p className="mt-1 text-xs opacity-80">
                <span className="font-medium">Reason:</span> {lastError}
              </p>
            )}
          </div>
        </div>
      )}
      {endpoint.provider === "slack" && callbackSurfaceRows.length > 0 && (
        <div
          className={`rounded-lg border p-3 text-sm ${endpoint.setup?.callbacksNeedUpdate ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/30"}`}
        >
          <p className="font-medium">Slack callback health</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {endpoint.setup?.callbacksNeedUpdate
              ? "Slack callback URLs need an update. Save the current App Manifest, then exercise Events, Interactivity, and the registered command again."
              : "Paperclip records each callback surface independently after Slack successfully calls it."}
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {callbackSurfaceRows.map(([label, surface]) => (
              <div key={label} className="rounded-md border border-border p-2">
                <p className="text-xs font-medium">{label}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {surface.status === "current"
                    ? "Current"
                    : surface.status === "stale"
                      ? "Stale URL"
                      : "Not observed"}
                </p>
                {surface.observedAt && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Last observed {formatDate(surface.observedAt)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {status !== "archived" && (
        <div className="space-y-2 border-y border-border py-3">
          <div className="flex flex-wrap items-center gap-2">
            {status === "active" && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() => lifecycle.mutate("pause")}
              >
                {lifecycle.isPending && lifecycleAction === "pause" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Pause />
                )}
                Pause
              </Button>
            )}
            {status === "paused" && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() => lifecycle.mutate("resume")}
              >
                {lifecycle.isPending && lifecycleAction === "resume" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play />
                )}
                Resume
              </Button>
            )}
            {[
              "active",
              "paused",
              "attention",
              "revoked",
              "draft",
              "verifying",
            ].includes(status) && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() =>
                  navigate(
                    `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}&reconnect=1`,
                  )
                }
              >
                <RefreshCw />
                {status === "draft" || status === "verifying"
                  ? "Finish setup"
                  : "Reconnect"}
              </Button>
            )}
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={lifecycle.isPending}
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 />
              Remove connection
            </Button>
          </div>
          {status !== "draft" && status !== "verifying" && (
            <p className="text-xs text-muted-foreground">
              {providerLifecycleGuidance[endpoint.provider].reconnect}
            </p>
          )}
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          Delivery and publication history
        </h3>
        <div className="divide-y divide-border border-y border-border">
          {query.isLoading && (
            <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading activity…
            </div>
          )}
          {query.isError && (
            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <p className="text-sm text-destructive" role="alert">
                Connection activity could not be loaded.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => query.refetch()}
              >
                Try again
              </Button>
            </div>
          )}
          {!query.isLoading &&
            !query.isError &&
            rows.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-start gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {activityKindLabels[item.kind]}
                    </span>
                    <StatusBadge status={item.status} />
                    <span className="text-xs text-muted-foreground">
                      {formatDate(item.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm font-medium">{item.summary}</p>
                  {item.detail && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {activityDetailLabel(item)}:
                      </span>{" "}
                      {item.detail}
                    </p>
                  )}
                </div>
                {isReplayEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Replay failed ${item.kind}`}
                    disabled={replay.isPending}
                    onClick={() => replay.mutate(item)}
                  >
                    {replay.isPending && replay.variables?.id === item.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    Replay
                  </Button>
                )}
                {isResolutionEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setResolutionItem(item)}
                  >
                    Resolve
                  </Button>
                )}
              </div>
            ))}
          {!query.isLoading && !query.isError && rows.length === 0 && (
            <p className="py-5 text-sm text-muted-foreground">
              No connection activity yet.
            </p>
          )}
        </div>
      </div>
      <AlertDialog
        open={resolutionItem !== null}
        onOpenChange={(open) => !open && setResolutionItem(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resolutionItem?.actionType === "slash_task_start"
                ? "Resolve unconfirmed task start"
                : resolutionItem?.actionType === "provider_effect"
                  ? "Resolve unconfirmed provider reply"
                  : "Resolve unconfirmed delivery"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resolutionItem?.actionType === "slash_task_start"
                ? "Paperclip lost confirmation after asking Slack to start the task. Check Slack first. Retrying can create a duplicate starter message and task."
                : resolutionItem?.actionType === "provider_effect"
                  ? "Paperclip lost confirmation after sending this provider reply. Check the provider first. Marking it delivered applies any pending Paperclip state change; retrying can create a duplicate message."
                  : "Paperclip lost confirmation after sending. Check the provider conversation first. Retrying can create a duplicate message."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel disabled={resolveActivity.isPending}>
              Keep unresolved
            </AlertDialogCancel>
            {resolutionItem?.resolutionActions?.includes("cancel") && (
              <Button
                variant="outline"
                disabled={resolveActivity.isPending}
                onClick={() =>
                  resolutionItem &&
                  resolveActivity.mutate({
                    item: resolutionItem,
                    action: "cancel",
                  })
                }
              >
                {resolutionItem.actionType === "slash_task_start"
                  ? "Cancel task start"
                  : resolutionItem.actionType === "provider_effect"
                    ? "Cancel provider reply"
                    : "Cancel publication"}
              </Button>
            )}
            {resolutionItem?.resolutionActions?.includes("retry_anyway") && (
              <Button
                variant="outline"
                disabled={resolveActivity.isPending}
                onClick={() =>
                  resolutionItem &&
                  resolveActivity.mutate({
                    item: resolutionItem,
                    action: "retry_anyway",
                  })
                }
              >
                Retry anyway
              </Button>
            )}
            {resolutionItem?.resolutionActions?.includes("mark_delivered") && (
              <AlertDialogAction
                disabled={resolveActivity.isPending}
                onClick={(event) => {
                  event.preventDefault();
                  if (resolutionItem) {
                    resolveActivity.mutate({
                      item: resolutionItem,
                      action: "mark_delivered",
                    });
                  }
                }}
              >
                Mark delivered
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this connection?</AlertDialogTitle>
            <AlertDialogDescription>
              {endpoint.assignedAgentName} will stop receiving new work from
              {` ${providerNames[endpoint.provider]}`}. Existing Paperclip tasks
              remain available.{" "}
              {providerLifecycleGuidance[endpoint.provider].remove}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={lifecycle.isPending}
              onClick={() => lifecycle.mutate("remove")}
            >
              {lifecycle.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Remove connection
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
