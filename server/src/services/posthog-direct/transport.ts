import type {
  TelemetryOutgoingBatch,
  TelemetrySendResult,
  TelemetryTransport,
} from "@paperclipai/shared/telemetry";
import {
  cloudTrialInferenceCohort,
  type CloudPostHogConfig,
} from "../cloud-posthog-config.js";
import {
  getResolvedCloudTrialInferenceEnabled,
  onCloudTrialInferenceCohortChange,
} from "../cloud-posthog-cohort.js";
import {
  buildCloudDirectEvent,
  buildPostHogDirectEvent,
  buildWorkspaceStartedEvent,
  POSTHOG_WORKSPACE_GROUP_TYPE,
  type PostHogDirectEvent,
} from "./event-shape.js";
import { capturePostHogEventContext, type PostHogEventContext } from "./request-context.js";

const POSTHOG_SHUTDOWN_TIMEOUT_MS = 3_000;

/** The slice of the posthog-node client this transport uses. */
export type PostHogNodeClient = {
  capture(message: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    timestamp?: Date;
    uuid?: string;
    groups?: Record<string, string>;
    disableGeoip?: boolean;
    sendFeatureFlags?: boolean;
  }): void;
  groupIdentify(message: {
    groupType: string;
    groupKey: string;
    properties?: Record<string, unknown>;
    disableGeoip?: boolean;
  }): void;
  flush(): Promise<void>;
  shutdown(shutdownTimeoutMs?: number): Promise<void> | void;
};

export type PostHogNodeFactory = (config: CloudPostHogConfig) => Promise<PostHogNodeClient>;

/**
 * Loads posthog-node only when a Cloud stack actually sends. A self-hosted
 * server never reaches this function, so it never loads the package.
 */
export const loadPostHogNode: PostHogNodeFactory = async (config) => {
  const { PostHog } = await import("posthog-node");
  return new PostHog(config.token, {
    host: config.host,
    // The telemetry client already batches; send each flushed batch promptly.
    flushAt: 50,
    flushInterval: 10_000,
    disableGeoip: true,
  }) as unknown as PostHogNodeClient;
};

export type WorkspaceStartup = {
  stackSlug: string | null;
  primaryHost: string | null;
  app: string;
  schemaVersion: string;
  version: string;
  installId: string;
  /**
   * sha256 hex of the raw install id: the same canonical install_id the
   * telemetry backend computes. Not secret. An offline operator job derives
   * the pre-switch PostHog id from it, so history stays joinable. Sent only on
   * `cloud.workspace_started`, never on the group or on ordinary events.
   */
  installHash: string;
};

export type PostHogDirectTransport = TelemetryTransport & {
  /** Whether the stack has the Cloud starter-inference experiment enabled. */
  readonly cloudTrialInferenceEnabled: boolean;
  /** Syncs the resolved instance setting (including staging overrides) into all future events. */
  setCloudTrialInferenceEnabled(enabled: boolean): void;
  /** Sends `$groupidentify` and `cloud.workspace_started` for this start. */
  announceWorkspace(startup: WorkspaceStartup): Promise<void>;
  /** Captures a Cloud-only direct PostHog event (not in the self-hosted collector contract). */
  captureCloudEvent(input: {
    event: string;
    properties?: Record<string, unknown>;
    contextOverride?: Partial<PostHogEventContext>;
    setOncePersonProperties?: Record<string, unknown>;
  }): Promise<void>;
  shutdown(): Promise<void>;
};

export function createPostHogDirectTransport(
  config: CloudPostHogConfig,
  options: { factory?: PostHogNodeFactory; now?: () => Date } = {},
): PostHogDirectTransport {
  const factory = options.factory ?? loadPostHogNode;
  const now = options.now ?? (() => new Date());
  let clientPromise: Promise<PostHogNodeClient> | null = null;
  let pendingAnnouncement: { startup: WorkspaceStartup; occurredAt: string } | null = null;
  let announcedCohort: boolean | null = null;
  let explicitCloudTrialInferenceEnabled: boolean | null = null;

  const effectiveCloudTrialInferenceEnabled = (): boolean =>
    explicitCloudTrialInferenceEnabled ??
    getResolvedCloudTrialInferenceEnabled() ??
    config.cloudTrialInferenceEnabled;

  const syncWorkspaceGroupCohort = (enabled: boolean) => {
    if (announcedCohort === null || announcedCohort === enabled || !clientPromise) return;
    announcedCohort = enabled;
    void clientPromise
      .then((client) => {
        client.groupIdentify({
          groupType: POSTHOG_WORKSPACE_GROUP_TYPE,
          groupKey: config.stackId,
          disableGeoip: true,
          properties: {
            environment: config.environment,
            cloud_trial_inference_enabled: enabled,
            cloud_trial_inference_cohort: cloudTrialInferenceCohort(enabled),
          },
        });
      })
      .catch(() => {
        // Best-effort analytics must never interrupt settings reads.
      });
  };

  const unsubscribeCohortChange = onCloudTrialInferenceCohortChange((enabled) => {
    if (explicitCloudTrialInferenceEnabled !== null) return;
    syncWorkspaceGroupCohort(enabled);
  });

  const currentConfig = (): CloudPostHogConfig => {
    const enabled = effectiveCloudTrialInferenceEnabled();
    return enabled === config.cloudTrialInferenceEnabled
      ? config
      : { ...config, cloudTrialInferenceEnabled: enabled };
  };

  const getClient = () => {
    clientPromise ??= factory(config).catch((error) => {
      clientPromise = null;
      throw error;
    });
    return clientPromise;
  };

  const capture = (client: PostHogNodeClient, message: PostHogDirectEvent) => {
    client.capture({
      distinctId: message.distinct_id,
      event: message.event,
      properties: message.properties,
      timestamp: new Date(message.timestamp),
      uuid: message.uuid,
      // posthog-node rebuilds `$groups` from this option and drops a `$groups`
      // property passed without it.
      groups: { [POSTHOG_WORKSPACE_GROUP_TYPE]: config.stackId },
      disableGeoip: message.disableGeoip,
      sendFeatureFlags: message.sendFeatureFlags,
    });
  };

  // Group properties need PostHog's group analytics add-on. Send them anyway;
  // the history join relies on the plain event below. Both go straight to
  // posthog-node: TelemetryClient.track() accepts only generated contract
  // events, and these are Cloud-only.
  function captureAnnouncement(
    client: PostHogNodeClient,
    { startup, occurredAt }: { startup: WorkspaceStartup; occurredAt: string },
  ) {
    const activeConfig = currentConfig();
    announcedCohort = activeConfig.cloudTrialInferenceEnabled;
    client.groupIdentify({
      groupType: POSTHOG_WORKSPACE_GROUP_TYPE,
      groupKey: activeConfig.stackId,
      disableGeoip: true,
      properties: {
        stack_slug: startup.stackSlug,
        primary_host: startup.primaryHost,
        environment: activeConfig.environment,
        cloud_trial_inference_enabled: activeConfig.cloudTrialInferenceEnabled,
        cloud_trial_inference_cohort: cloudTrialInferenceCohort(activeConfig.cloudTrialInferenceEnabled),
      },
    });
    capture(
      client,
      buildWorkspaceStartedEvent(
        { installHash: startup.installHash, occurredAt },
        {
          app: startup.app,
          schemaVersion: startup.schemaVersion,
          installId: startup.installId,
          version: startup.version,
          ingestedAt: occurredAt,
        },
        activeConfig,
      ),
    );
  }

  return {
    get cloudTrialInferenceEnabled() {
      return effectiveCloudTrialInferenceEnabled();
    },

    setCloudTrialInferenceEnabled(enabled: boolean) {
      explicitCloudTrialInferenceEnabled = enabled;
      syncWorkspaceGroupCohort(enabled);
    },

    hashesPrivateRefs: false,

    captureEventContext: () => capturePostHogEventContext(),

    async send(batch: TelemetryOutgoingBatch): Promise<TelemetrySendResult> {
      const activeConfig = currentConfig();
      const meta = {
        app: batch.app,
        schemaVersion: batch.schemaVersion,
        installId: batch.installId,
        version: batch.version,
        ingestedAt: now().toISOString(),
      };
      const messages = batch.events
        .map(({ event, context }) =>
          buildPostHogDirectEvent(event, context as PostHogEventContext | undefined, meta, activeConfig),
        )
        .filter((message): message is PostHogDirectEvent => message !== null);
      if (messages.length === 0) return { kind: "ok" };

      let client: PostHogNodeClient;
      try {
        client = await getClient();
      } catch {
        // The package could not load. Retrying with backoff is safe: nothing
        // was captured yet, so no event can be sent twice.
        return { kind: "network" };
      }
      // A startup announcement that could not load the client goes out with
      // the first batch that can, so the history-join event is not lost.
      if (pendingAnnouncement) {
        const announcement = pendingAnnouncement;
        pendingAnnouncement = null;
        captureAnnouncement(client, announcement);
      }
      for (const message of messages) capture(client, message);
      try {
        await client.flush();
      } catch {
        // posthog-node already retried this request. It keeps events that hit
        // a network failure queued for its next flush and drops ones PostHog
        // rejected, so resending them from here could only duplicate events.
        console.warn(`[telemetry] PostHog flush failed for a batch of ${messages.length} event(s)`);
      }
      return { kind: "ok" };
    },

    async announceWorkspace(startup: WorkspaceStartup): Promise<void> {
      const announcement = { startup, occurredAt: now().toISOString() };
      let client: PostHogNodeClient;
      try {
        client = await getClient();
      } catch (error) {
        pendingAnnouncement = announcement;
        throw error;
      }
      captureAnnouncement(client, announcement);
      await client.flush();
    },

    async captureCloudEvent(input): Promise<void> {
      let client: PostHogNodeClient;
      try {
        client = await getClient();
      } catch {
        return;
      }
      const reqCtx = capturePostHogEventContext();
      const mergedContext: PostHogEventContext | undefined =
        reqCtx || input.contextOverride
          ? {
              ...(reqCtx ?? {}),
              ...(input.contextOverride?.userId ? { userId: input.contextOverride.userId } : {}),
              ...(input.contextOverride?.companyId ? { companyId: input.contextOverride.companyId } : {}),
              ...(input.contextOverride?.sessionId ? { sessionId: input.contextOverride.sessionId } : {}),
              ...(input.contextOverride?.windowId ? { windowId: input.contextOverride.windowId } : {}),
            }
          : undefined;
      const message = buildCloudDirectEvent(
        {
          event: input.event,
          occurredAt: now().toISOString(),
          properties: input.properties,
          setOncePersonProperties: input.setOncePersonProperties,
        },
        mergedContext,
        currentConfig(),
      );
      capture(client, message);
      try {
        await client.flush();
      } catch {
        console.warn(`[telemetry] PostHog flush failed for cloud event ${input.event}`);
      }
    },

    async shutdown(): Promise<void> {
      unsubscribeCohortChange();
      if (!clientPromise) return;
      const client = await clientPromise.catch(() => null);
      if (!client) return;
      await client.shutdown(POSTHOG_SHUTDOWN_TIMEOUT_MS);
    },
  };
}
