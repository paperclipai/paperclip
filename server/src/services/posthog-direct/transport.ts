import type {
  TelemetryOutgoingBatch,
  TelemetrySendResult,
  TelemetryTransport,
} from "@paperclipai/shared/telemetry";
import type { CloudPostHogConfig } from "../cloud-posthog-config.js";
import {
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
  /** Sends `$groupidentify` and `cloud.workspace_started` for this start. */
  announceWorkspace(startup: WorkspaceStartup): Promise<void>;
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
    client.groupIdentify({
      groupType: POSTHOG_WORKSPACE_GROUP_TYPE,
      groupKey: config.stackId,
      disableGeoip: true,
      properties: {
        stack_slug: startup.stackSlug,
        primary_host: startup.primaryHost,
        environment: config.environment,
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
        config,
      ),
    );
  }

  return {
    hashesPrivateRefs: false,

    captureEventContext: () => capturePostHogEventContext(),

    async send(batch: TelemetryOutgoingBatch): Promise<TelemetrySendResult> {
      const meta = {
        app: batch.app,
        schemaVersion: batch.schemaVersion,
        installId: batch.installId,
        version: batch.version,
        ingestedAt: now().toISOString(),
      };
      const messages = batch.events
        .map(({ event, context }) =>
          buildPostHogDirectEvent(event, context as PostHogEventContext | undefined, meta, config),
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

    async shutdown(): Promise<void> {
      if (!clientPromise) return;
      const client = await clientPromise.catch(() => null);
      if (!client) return;
      await client.shutdown(POSTHOG_SHUTDOWN_TIMEOUT_MS);
    },
  };
}
