import { Client, credentials, Metadata, status } from "@grpc/grpc-js";
import {
  decodeCatchUpEvent,
  TypedEventStream,
  type CatchUpEvent,
} from "@photon-ai/advanced-imessage";
import {
  PhotonError,
  photonFailure,
  type PhotonLineAuthentication,
} from "./cloud.js";
import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";

export type PhotonRecoveryEvent =
  | CatchUpEvent
  | { type: "photon.ignored"; sequence: number };
export const PHOTON_CATCHUP_PATH =
  "/photon.imessage.v1.EventService/CatchUpEvents";

/** Pinned v2.1.0 protobuf envelope. The SDK decoder owns the event graph; this
 * reader retains sequence-only/new-variant frames that its public API drops. */
export function photonEnvelopeSequence(bytes: Uint8Array): number | undefined {
  let offset = 0;
  const integer = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length)
        throw new PhotonError(
          "invalid_response",
          "Truncated Photon recovery frame",
        );
      const byte = bytes[offset++];
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER))
          throw new PhotonError(
            "history_gap",
            "Photon recovery sequence exceeds the supported range",
          );
        return Number(value);
      }
    }
    throw new PhotonError(
      "invalid_response",
      "Invalid Photon recovery integer",
    );
  };
  let sequence: number | undefined;
  while (offset < bytes.length) {
    const tag = integer();
    if (tag === 8) {
      if (sequence !== undefined)
        throw new PhotonError(
          "invalid_response",
          "Duplicate Photon sequence field",
        );
      sequence = integer();
      continue;
    }
    const wire = tag & 7;
    if (wire === 0) integer();
    else if (wire === 1) offset += 8;
    else if (wire === 2) {
      const length = integer();
      offset += length;
    } else if (wire === 5) offset += 4;
    else
      throw new PhotonError(
        "invalid_response",
        "Unsupported Photon recovery frame",
      );
    if (offset > bytes.length)
      throw new PhotonError(
        "invalid_response",
        "Photon recovery field exceeds frame bounds",
      );
  }
  return sequence;
}
export function photonCatchUpRequest(sequence?: number): Buffer {
  if (sequence === undefined) return Buffer.alloc(0);
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new PhotonError("history_gap", "Invalid Photon recovery cursor");
  let remaining = BigInt(sequence);
  const bytes = [8];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.from(bytes);
}
export function decodePhotonRecoveryFrame(
  bytes: Buffer,
): PhotonRecoveryEvent | null {
  const sequence = photonEnvelopeSequence(bytes);
  let event: CatchUpEvent | undefined;
  try {
    event = decodeCatchUpEvent(bytes);
  } catch {
    throw new PhotonError(
      "invalid_response",
      "Photon recovery event could not be decoded",
    );
  }
  return (
    event ??
    (sequence !== undefined ? { type: "photon.ignored", sequence } : null)
  );
}

export class PhotonRecoveryTransport {
  private readonly client: Client;
  constructor(
    private readonly authentication: PhotonLineAuthentication,
    client?: Client,
  ) {
    this.client =
      client ??
      new Client(authentication.address, credentials.createSsl(), {
        "grpc.max_receive_message_length": MAX_ATTACHMENT_BYTES + 1024 * 1024,
      });
  }
  catchUp(sequence?: number): TypedEventStream<PhotonRecoveryEvent> {
    const controller = new AbortController();
    const { client, authentication } = this;
    async function* receive() {
      const metadata = new Metadata();
      metadata.set("authorization", `Bearer ${await authentication.token()}`);
      if (controller.signal.aborted) return;
      const call = client.makeServerStreamRequest(
        PHOTON_CATCHUP_PATH,
        photonCatchUpRequest,
        (bytes: Buffer) => bytes,
        sequence,
        metadata,
        { deadline: Date.now() + 60_000 },
      );
      const abort = () => call.cancel();
      controller.signal.addEventListener("abort", abort, { once: true });
      try {
        for await (const bytes of call) {
          const frame = decodePhotonRecoveryFrame(bytes as Buffer);
          if (frame) yield frame;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const code = (error as { code?: number }).code;
        if (code === status.OUT_OF_RANGE || code === status.FAILED_PRECONDITION)
          throw new PhotonError(
            "history_gap",
            "Photon cannot recover the saved cursor; reconnect after reviewing the history gap",
          );
        if (
          code === status.UNAUTHENTICATED ||
          code === status.PERMISSION_DENIED
        )
          throw new PhotonError(
            "credentials",
            "Photon rejected the selected line credentials; reconnect the channel",
          );
        if (code === status.RESOURCE_EXHAUSTED)
          throw new PhotonError(
            "quota",
            "Photon recovery is temporarily rate limited",
          );
        throw photonFailure(error);
      } finally {
        controller.signal.removeEventListener("abort", abort);
        call.cancel();
      }
    }
    return new TypedEventStream(receive(), async () => controller.abort());
  }
  close(): void {
    this.client.close();
  }
}
