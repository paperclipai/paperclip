import type { WebhookOptions } from "chat";
import { createChatSdkEndpointRuntime, ChatSdkEndpointNotRegisteredError, ChatRuntimeConstructionCleanup, type CreateChatSdkEndpointRuntimeOptions } from "./chat-sdk-runtime.js";
import { createVoiceRuntime, type ChatEndpointRuntime, type CreateVoiceRuntimeOptions } from "./voice/voice-runtime.js";

/** One lifecycle registry for the Chat SDK and hosted voice transports. */
export class ChatRuntime {
  private readonly endpoints = new Map<string, ChatEndpointRuntime>();
  private readonly retiringEndpoints = new Map<
    string,
    ChatEndpointRuntime
  >();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly constructionCleanup = new ChatRuntimeConstructionCleanup();
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

  /** Exact normal retirement ownership, never inferred from get() absence. */
  isRetiringEndpoint(endpointId: string, expected: object): boolean {
    return !this.endpoints.has(endpointId) && this.retiringEndpoints.get(endpointId) === expected;
  }

  /** Retirement failures retain their owner even after get/list hide it. */
  hasUnsettledLifecycle(): boolean {
    return this.retiringEndpoints.size > 0 || this.constructionCleanup.has() || this.lifecycleTails.size > 0;
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

  retainPendingConstructionCleanup(endpointId: string, cleanup: () => Promise<void>): void {
    this.constructionCleanup.retain(endpointId, cleanup);
  }

  async joinPendingConstructionCleanup(endpointId: string): Promise<void> {
    await this.enqueueLifecycle(endpointId, () => this.constructionCleanup.join(endpointId));
  }

  private async retireEndpoint(endpointId: string): Promise<boolean> {
    const previous = this.endpoints.get(endpointId) ?? this.retiringEndpoints.get(endpointId);
    const hadAbort = this.constructionCleanup.has(endpointId), errors: unknown[] = [];
    if (previous) {
      this.endpoints.delete(endpointId);
      this.retiringEndpoints.set(endpointId, previous);
      try { await previous.shutdown(); this.retiringEndpoints.delete(endpointId); }
      catch (error) { errors.push(error); }
    }
    try { await this.constructionCleanup.join(endpointId); }
    catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Chat runtime retirement remains incomplete");
    return Boolean(previous) || hadAbort;
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
    const abort = (primary: unknown): Promise<never> => this.constructionCleanup.abort(options.endpointId, options.onConstructionAborted, primary);
    if (this.shuttingDown) {
      return await this.enqueueLifecycle(options.endpointId, () => abort(new Error("Chat SDK runtime is shutting down")));
    }
    const generation = this.nextReplacementGeneration(options.endpointId);
    return await this.enqueueLifecycle(options.endpointId, async () => {
      let constructionStarted = false;
      try {
        this.assertReplacementCurrent(options.endpointId, generation);
        await this.retireEndpoint(options.endpointId);
        this.assertReplacementCurrent(options.endpointId, generation);
        constructionStarted = true;
        const next = createChatSdkEndpointRuntime(options);
        this.endpoints.set(options.endpointId, next);
        // Caller installs context before initialize starts any provider intake.
        return next;
      } catch (error) {
        if (!constructionStarted) return await abort(error);
        throw error; // Constructor entry is not never-created evidence.
      }
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
      ...this.constructionCleanup.endpointIds(),
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
