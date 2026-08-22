// The shared host-to-sandbox write chunker for the Daytona pseudo-terminal (PTY)
// sessions. The provider PTY WebSocket rejects any single message over 65536
// bytes with WebSocket close code 1009 and closes the connection. `sendInput`
// sends a whole payload in one message, so a payload above the cap takes the
// channel down. Real duplex frames cross the cap (single frames of 127582 and
// 150416 bytes are observed). This module slices each payload into byte-bounded
// chunks under the cap and sends each chunk in order.

/**
 * The provider PTY WebSocket message cap, in bytes. The provider rejects a single
 * PTY message over this size with WebSocket close code 1009 and closes the
 * connection.
 */
export const PTY_MESSAGE_CAP_BYTES = 65536;

/**
 * The maximum byte length of one host-to-sandbox chunk. It holds about 5 KiB of
 * headroom under {@link PTY_MESSAGE_CAP_BYTES}, so a chunk never sits on the cap
 * boundary. A later change in how the provider counts message overhead does not
 * push one chunk over the cap and back into the close-code-1009 failure. The
 * headroom costs about nine percent more messages for a large payload.
 *
 * The chunker slices bytes, not string characters, so a chunk boundary can split
 * a multi-byte UTF-8 sequence. The read-side streaming `TextDecoder` rejoins a
 * split sequence, so a byte slice is safe. A string-index slice could split a
 * surrogate pair, so the chunker never slices by character.
 */
export const PTY_INPUT_CHUNK_BYTES = 60 * 1024;

/** The single UTF-8 encoder the chunker reuses for every string payload. */
const PTY_INPUT_TEXT_ENCODER = new TextEncoder();

/**
 * Send one host-to-sandbox payload as byte-bounded chunks under the provider
 * message cap. The function encodes a string payload to UTF-8 bytes, slices the
 * byte array into chunks of at most {@link PTY_INPUT_CHUNK_BYTES}, and calls
 * `sendInput` for each chunk in order.
 *
 * The loop is synchronous. `sendInput` reaches `ws.send` before its first `await`,
 * so a synchronous loop puts the chunks on the wire in order with no queue. The
 * function adds no `await` and no async queue, so the wire order matches the slice
 * order.
 *
 * Each `sendInput` call carries the `onError` handler. The handler runs at most
 * one time, because the function latches the first rejected chunk. After a chunk
 * rejects, the function sends no further chunk of this payload. A rejected send
 * never throws out of this function, so the caller's stream stays the single
 * result path.
 *
 * @param sendInput - Sends one raw byte chunk to the pseudo-terminal.
 * @param payload - The host-to-sandbox payload, as a string or raw bytes.
 * @param onError - Optional. The function calls it one time on the first rejected chunk.
 */
export function sendPtyInputInChunks(
  sendInput: (chunk: Uint8Array) => Promise<void>,
  payload: string | Uint8Array,
  onError?: () => void,
): void {
  const bytes = typeof payload === "string" ? PTY_INPUT_TEXT_ENCODER.encode(payload) : payload;
  let failed = false;
  const handleRejection = (): void => {
    // Report the first rejected chunk one time. A later chunk's rejection is a
    // no-op, so the caller sees one write error for the whole payload.
    if (failed) return;
    failed = true;
    onError?.();
  };
  for (let offset = 0; offset < bytes.length; offset += PTY_INPUT_CHUNK_BYTES) {
    // Stop sending the remaining chunks after a chunk rejects. The latch also
    // guards a rejection that a fake `sendInput` settles before the loop advances.
    if (failed) break;
    const chunk = bytes.subarray(offset, offset + PTY_INPUT_CHUNK_BYTES);
    void sendInput(chunk).catch(handleRejection);
  }
}
