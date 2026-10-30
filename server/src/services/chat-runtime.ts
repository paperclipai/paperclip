import type { WebhookOptions } from "chat";
import { createChatSdkEndpointRuntime, ChatSdkEndpointNotRegisteredError, type CreateChatSdkEndpointRuntimeOptions } from "./chat-sdk-runtime.js";
import { createVoiceRuntime, type ChatEndpointRuntime, type CreateVoiceRuntimeOptions } from "./voice/voice-runtime.js";

/** One lifecycle registry for the Chat SDK and hosted voice transports. */
export class ChatRuntime {
  private readonly endpoints = new Map<string, ChatEndpointRuntime>();
  private readonly retiringEndpoints = new Map<
    string,
    ChatEndpointRuntime
  >();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly replacementGenerations = new Map<string, number>();
  private shuttingDown = false;

  get(endpointId: string): ChatEndpointRuntime | null {
    if (this.shuttingDown) return null;
    return this.endpoints.get(endpointId) ?? null;
  }

  list(): ChatEndpointRuntime[] {
    if (this.shuttingDown) return [];
    return [...this.endpoints.values()];
  }

  private enqueueLifecycle<T>(
    endpointId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.lifecycleTails.get(endpointId) ?? Promise.resolve();
    const result = previous.then(operation);
    // A failed shutdown must not poison the queue or release ownership of a
    // possibly still-running predecessor. Only an explicit later operation
    // retries retirement; callers still receive the original failure.
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleTails.set(endpointId, settled);
    void settled.then(() => {
      if (this.lifecycleTails.get(endpointId) === settled) {
        this.lifecycleTails.delete(endpointId);
      }
    });
    return result;
  }

  private async retireEndpoint(endpointId: string): Promise<boolean> {
    const previous =
      this.endpoints.get(endpointId) ?? this.retiringEndpoints.get(endpointId);
    if (!previous) return false;
    this.endpoints.delete(endpointId);
    this.retiringEndpoints.set(endpointId, previous);
    await previous.shutdown();
    this.retiringEndpoints.delete(endpointId);
    return true;
  }

  private nextReplacementGeneration(endpointId: string): number {
    const next = (this.replacementGenerations.get(endpointId) ?? 0) + 1;
    this.replacementGenerations.set(endpointId, next);
    return next;
  }

  private assertReplacementCurrent(
    endpointId: string,
    generation: number,
  ): void {
    if (this.shuttingDown) throw new Error("Chat SDK runtime is shutting down");
    if (this.replacementGenerations.get(endpointId) !== generation) {
      throw new Error(
        `Chat SDK runtime replacement for endpoint ${endpointId} was superseded`,
      );
    }
  }

  async replaceEndpoint(
    options: CreateChatSdkEndpointRuntimeOptions,
  ): Promise<ChatEndpointRuntime> {
    if (this.shuttingDown) throw new Error("Chat SDK runtime is shutting down");
    const generation = this.nextReplacementGeneration(options.endpointId);
    return await this.enqueueLifecycle(options.endpointId, async () => {
      this.assertReplacementCurrent(options.endpointId, generation);
      await this.retireEndpoint(options.endpointId);
      this.assertReplacementCurrent(options.endpointId, generation);
      const next = createChatSdkEndpointRuntime(options);
      this.endpoints.set(options.endpointId, next);
      // The service installs callback context before initialize() starts the
      // Discord gateway. Preserve that caller-owned initialization boundary.
      return next;
    });
  }

  async replaceVoiceEndpoint(options: CreateVoiceRuntimeOptions): Promise<ChatEndpointRuntime> {
    if (this.shuttingDown) throw new Error("Chat runtime is shutting down");
    const generation = this.nextReplacementGeneration(options.endpointId);
    return this.enqueueLifecycle(options.endpointId, async () => {
      this.assertReplacementCurrent(options.endpointId, generation);
      await this.retireEndpoint(options.endpointId);
      this.assertReplacementCurrent(options.endpointId, generation);
      const next = createVoiceRuntime(options);
      this.endpoints.set(options.endpointId, next);
      return next;
    });
  }

  async removeEndpoint(endpointId: string): Promise<boolean> {
    this.nextReplacementGeneration(endpointId);
    return await this.enqueueLifecycle(
      endpointId,
      async () => await this.retireEndpoint(endpointId),
    );
  }

  async handleWebhook(
    endpointId: string,
    request: Request,
    options?: WebhookOptions,
    responseDeadlineAt?: number,
  ): Promise<Response> {
    const runtime = this.get(endpointId);
    if (!runtime) throw new ChatSdkEndpointNotRegisteredError(endpointId);
    return await runtime.handleWebhook(request, options, responseDeadlineAt);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const endpointIds = new Set([
      ...this.endpoints.keys(),
      ...this.retiringEndpoints.keys(),
      ...this.lifecycleTails.keys(),
    ]);
    const results = await Promise.allSettled(
      [...endpointIds].map(
        async (endpointId) =>
          await this.enqueueLifecycle(
            endpointId,
            async () => await this.retireEndpoint(endpointId),
          ),
      ),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}

export function createChatRuntime() { return new ChatRuntime(); }
