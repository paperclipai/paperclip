import type { PhotonRecoveryEvent } from "./recovery-transport.js";
import type {
  GrpcAdvancedIMessage,
  LiveEvent,
  TypedEventStream,
} from "@photon-ai/advanced-imessage";
import { PhotonError } from "./cloud.js";
import { PhotonState } from "./state.js";

interface Checkpoint {
  schema: 1;
  lineId: string;
  sequence: number;
}
export interface PhotonReceiverOptions {
  client: GrpcAdvancedIMessage;
  state: PhotonState;
  lineId: string;
  intakeAfter: number;
  allocation?: "dedicated" | "shared";
  catchUp?(sequence?: number): TypedEventStream<PhotonRecoveryEvent>;
  /** Renewal verifies both the selected identity and the current endpoint lease. */
  assertOwned(): Promise<void>;
  admit(event: LiveEvent): Promise<void>;
  failure(error: unknown): Promise<void>;
  /** Production persists the cursor under the same transaction as its lease fence. */
  commitCheckpoint?(sequence: number): Promise<void>;
}

/** Live streams wake a serialized catch-up reader. Only that complete event log
 * advances the checkpoint, so cross-stream ordering can never skip an event. */
export class PhotonReceiver {
  private stopped = false;
  private streams: Array<TypedEventStream<LiveEvent>> = [];
  private running?: Promise<void>;
  private requested = false;
  private catchUpStream?: TypedEventStream<PhotonRecoveryEvent>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: PhotonReceiverOptions) {}
  start(): void {
    if (this.stopped || this.timer) return;
    const { client } = this.options;
    this.streams = [
      client.messages.subscribeEvents(),
      client.chats.subscribeEvents(),
      ...(this.options.allocation === "shared" ? [] : [client.groups.subscribeEvents()]),
      client.polls.subscribeEvents(),
    ];
    for (const stream of this.streams) {
      void (async () => {
        try {
          for await (const _event of stream) {
            if (this.stopped) break;
            this.request();
          }
          if (!this.stopped)
            await this.options.failure(
              new PhotonError("network", "Photon event stream disconnected"),
            );
        } catch (error) {
          if (!this.stopped) await this.options.failure(error);
        }
      })().catch(() => {});
    }
    this.timer = setInterval(() => this.request(), 15_000);
    this.timer.unref();
    this.request();
  }
  private request(): void {
    if (this.stopped) return;
    this.requested = true;
    if (this.running) return;
    this.running = (async () => {
      while (this.requested && !this.stopped) {
        this.requested = false;
        await this.catchUp();
      }
    })()
      .catch(async (error) => {
        if (!this.stopped) await this.options.failure(error);
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  /** Exposed for deterministic recovery tests, never an external route. */
  async catchUp(): Promise<void> {
    const { state, lineId, client, assertOwned, admit, intakeAfter } =
      this.options;
    await assertOwned();
    const original = await state.read<Checkpoint>("checkpoint");
    if (!original && (await state.read("receiver-initialized")))
      throw new PhotonError(
        "history_gap",
        "Photon receiver checkpoint is missing; operator recovery is required",
      );
    if (
      original &&
      (original.schema !== 1 ||
        original.lineId !== lineId ||
        !Number.isSafeInteger(original.sequence) ||
        original.sequence < 0)
    )
      throw new PhotonError(
        "history_gap",
        "Photon checkpoint is invalid; operator recovery is required",
      );
    const shared = this.options.allocation === "shared";
    let sequence = original?.sequence;
    let batchEvents = 0;
    const stream =
      this.options.catchUp?.(sequence) ?? client.events.catchUp(sequence);
    this.catchUpStream = stream;
    let completed = false;
    try {
      for await (const event of stream) {
        if (this.stopped) return;
        await assertOwned();
        if (event.type === "catchup.complete") {
          if (
            !Number.isSafeInteger(event.headSequence) ||
            event.headSequence < 0 ||
            (sequence !== undefined && (shared ? event.headSequence < sequence : event.headSequence !== sequence))
          )
            throw new PhotonError(
              "history_gap",
              "Photon history has a gap or reset; operator recovery is required",
            );
          // Shared gateway replay is project-filtered: sequence numbers are
          // increasing but not adjacent (the first live project event may be
          // > 1 billion). A complete replay barrier covers the filtered tail.
          // Commit shared batches only here, after every admission succeeds;
          // malformed ordering or interrupted replay keeps the previous cursor.
          sequence = shared ? event.headSequence : sequence ?? event.headSequence;
          await this.checkpoint(sequence);
          completed = true;
          break;
        }
        if (!Number.isSafeInteger(event.sequence) || event.sequence < 1)
          throw new PhotonError(
            "history_gap",
            "Photon returned an invalid event sequence",
          );
        if (++batchEvents > 100_000)
          throw new PhotonError("history_gap", "Photon replay exceeds the supported recovery window");
        if (shared && sequence !== undefined && event.sequence < sequence && event.sequence > (original?.sequence ?? -1))
          throw new PhotonError("history_gap", "Photon replay arrived out of order; the saved cursor was retained");
        if (sequence !== undefined && event.sequence <= sequence) continue;
        if (!shared && sequence !== undefined && event.sequence !== sequence + 1)
          throw new PhotonError(
            "history_gap",
            "Photon event history is incomplete; operator recovery is required",
          );
        // On the first connection, the server may retain only a tail of history.
        // Establish that boundary explicitly; it is never allowed after a cursor.
        sequence ??= event.sequence - 1;
        if (event.type !== "photon.ignored") {
          const occurredAt = new Date(event.occurredAt).getTime();
          if (!Number.isFinite(occurredAt))
            throw new PhotonError(
              "invalid_response",
              "Photon event timestamp is invalid",
            );
          if (occurredAt >= intakeAfter) await admit(event);
        }
        // admission must durably store or classify even irrelevant events.
        if (!shared) await this.checkpoint(event.sequence);
        sequence = event.sequence;
      }
      if (!completed && !this.stopped)
        throw new PhotonError(
          "network",
          "Photon catch-up ended before its checkpoint barrier",
        );
    } finally {
      await stream.close();
      if (this.catchUpStream === stream) this.catchUpStream = undefined;
    }
  }
  private async checkpoint(sequence: number): Promise<void> {
    await this.options.assertOwned();
    if (this.options.commitCheckpoint)
      return this.options.commitCheckpoint(sequence);
    await writePhotonCheckpoint(
      this.options.state,
      this.options.lineId,
      sequence,
    );
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.catchUpStream?.close();
    await Promise.allSettled(this.streams.map((stream) => stream.close()));
    // client.close interrupts a blocked catch-up RPC during runtime shutdown.
  }
}

export async function writePhotonCheckpoint(
  state: PhotonState,
  lineId: string,
  sequence: number,
): Promise<void> {
  await state.update<Checkpoint>("checkpoint", (current) => {
    if (current && (current.lineId !== lineId || current.sequence > sequence))
      throw new PhotonError(
        "history_gap",
        "Photon checkpoint ownership changed",
      );
    return { schema: 1, lineId, sequence };
  });
  await state.update(
    "receiver-initialized",
    (current) => current ?? { schema: 1, lineId },
  );
}
