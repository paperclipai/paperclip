// The authenticated frame uses hex ciphertext: every plaintext byte becomes
// two wire bytes. Reserve space for both JSON envelopes and the GCM tag.
// Keep runnerd and the ACPX Rust transport in sync with this frame limit.
export const DURABLE_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const ENVELOPE_RESERVE_BYTES = 4 * 1024;
export const DURABLE_MAX_COMMAND_BYTES =
  Math.floor((DURABLE_MAX_FRAME_BYTES - ENVELOPE_RESERVE_BYTES) / 2) -
  ENVELOPE_RESERVE_BYTES;
