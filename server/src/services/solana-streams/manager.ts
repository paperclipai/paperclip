import { createCombinedFilter } from "./filters.js";
import type {
  SolanaStreamConfig,
  SolanaStreamEvent,
  SolanaStreamSubscriber,
  SolanaStreamSource,
  SolanaStream,
  SolanaStreamManager,
} from "./types.js";

export function createSolanaStreamManager(): SolanaStreamManager {
  const streams = new Map<string, SolanaStream>();

  return {
    createStream(config, source) {
      if (streams.has(config.id)) {
        throw new Error(`Stream ${config.id} already exists`);
      }
      if (!source) {
        throw new Error("Source required when not provided by factory");
      }
      const stream: SolanaStream = {
        config,
        source,
        subscribers: new Set(),
      };
      const combined = createCombinedFilter(config.filters);

      stream.unsubscribe = source.onEvent((event: SolanaStreamEvent) => {
        if (event.type === "block") {
          if (!combined.block(event.data)) return;
        } else if (event.type === "transaction") {
          if (!combined.transaction(event.data)) return;
        } else if (event.type === "account") {
          if (!combined.account(event.data)) return;
        }
        for (const sub of stream.subscribers) {
          try {
            sub(event);
          } catch {
            // ignore
          }
        }
      });

      streams.set(config.id, stream);
      return stream;
    },

    async deleteStream(streamId) {
      const stream = streams.get(streamId);
      if (!stream) return;
      await stream.source.stop();
      stream.unsubscribe?.();
      stream.subscribers.clear();
      streams.delete(streamId);
    },

    getStream(streamId) {
      return streams.get(streamId);
    },

    listStreams() {
      return Array.from(streams.values());
    },

    subscribe(streamId, listener) {
      const stream = streams.get(streamId);
      if (!stream) throw new Error(`Stream ${streamId} not found`);
      stream.subscribers.add(listener);
      return () => stream.subscribers.delete(listener);
    },

    async startStream(streamId) {
      const stream = streams.get(streamId);
      if (!stream) throw new Error(`Stream ${streamId} not found`);
      if (!stream.config.enabled) return;
      await stream.source.start();
    },

    async stopStream(streamId) {
      const stream = streams.get(streamId);
      if (!stream) throw new Error(`Stream ${streamId} not found`);
      await stream.source.stop();
    },

    async startAll() {
      for (const stream of streams.values()) {
        if (stream.config.enabled) {
          await stream.source.start();
        }
      }
    },

    async stopAll() {
      for (const stream of streams.values()) {
        await stream.source.stop();
      }
    },
  };
}
