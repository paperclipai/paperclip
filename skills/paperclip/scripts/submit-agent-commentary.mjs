#!/usr/bin/env node
// One bounded, nonfatal submission. Feedback comes from stdin, never shell arguments.
import { randomUUID } from "node:crypto";

const MAX_BODY_LENGTH = 524288;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readBounded(stream, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Input too large");
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

try {
  const [kind, idempotencyKey = randomUUID()] = process.argv.slice(2);
  if (kind !== "complaint" && kind !== "suggestion") throw new Error("Invalid kind");
  // Bound bytes before decoding; JavaScript string length matches the server's ceiling.
  const body = await readBounded(process.stdin, 4 * MAX_BODY_LENGTH);
  if (!body.trim() || body.length > MAX_BODY_LENGTH) throw new Error("Invalid body");
  const { PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, PAPERCLIP_RUN_ID } = process.env;
  if (!PAPERCLIP_API_URL || !PAPERCLIP_API_KEY || !UUID.test(PAPERCLIP_COMPANY_ID ?? "") || !UUID.test(PAPERCLIP_RUN_ID ?? "")) {
    throw new Error("Missing run context");
  }
  const apiUrl = PAPERCLIP_API_URL.replace(/\/+$/, "").replace(/\/api$/, "");
  const response = await fetch(`${apiUrl}/api/companies/${PAPERCLIP_COMPANY_ID}/agent-commentary`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
      "X-Paperclip-Run-Id": PAPERCLIP_RUN_ID,
    },
    body: JSON.stringify({ kind, body, idempotencyKey }),
    // Never forward run credentials through redirects. Bound the entire HTTP attempt.
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 200 && response.status !== 201) {
    await response.body?.cancel();
    throw new Error("Submission failed");
  }
  const acknowledgement = JSON.parse(await readBounded(response.body, 4096));
  if (typeof acknowledgement.id !== "string" || !acknowledgement.id) throw new Error("Invalid acknowledgement");
  console.log("Feedback stored.");
} catch {
  // No exception text: transport errors may contain credentials or submitted text.
  console.error("Feedback could not be confirmed. Ignore this failure, do not retry, and continue the primary task.");
}
