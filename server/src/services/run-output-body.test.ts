import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { assembleRunOutputBody } from "./run-output-body.js";
import { redactRegisteredSecretValues } from "./run-secret-redaction.js";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(text: string) {
  const bodyId = hash(text), body = { schema: "paperclip.output.body.v1", bodyId, sha256: bodyId, byteLength: String(Buffer.byteLength(text)), mediaType: "text/plain; charset=utf-8" };
  const chunks: Record<string, unknown>[] = [];
  for (let offset = 0; offset < text.length; offset += 8192) {
    const part = text.slice(offset, offset + 8192);
    chunks.push({ schema: "paperclip.output.body.chunk.v1", body, offset: String(offset), sha256: hash(part), text: part });
  }
  return { bodyId, chunks };
}
async function* stream(values: unknown[]) { yield* values; }
it("reconstructs and verifies one bounded body across pages, including a secret split across transport chunks", async () => {
  const secret = "registered-provider-key";
  const text = "a".repeat(8190) + secret + "z".repeat(2 * 1024 * 1024);
  const f = fixture(text);
  const actual = await assembleRunOutputBody(f.bodyId, stream(f.chunks));
  expect(actual).toBe(text);
  expect(redactRegisteredSecretValues(actual, [secret])).not.toContain(secret);
});
it("rejects missing, reordered, corrupt, wrong-body and oversized data", async () => {
  const f = fixture("a".repeat(20_000));
  await expect(assembleRunOutputBody(f.bodyId, stream([]))).rejects.toThrow("not found");
  await expect(assembleRunOutputBody(f.bodyId, stream(f.chunks.slice(0, 1)))).rejects.toThrow("not complete");
  for (const values of [
    [...f.chunks].reverse(),
    [{ ...f.chunks[0], text: "corrupt" }, ...f.chunks.slice(1)],
    [{ ...f.chunks[0], body: { ...(f.chunks[0]!.body as object), byteLength: "9999999" } }],
  ]) await expect(assembleRunOutputBody(f.bodyId, stream(values))).rejects.toThrow("verification");
  await expect(assembleRunOutputBody("0".repeat(64), stream(f.chunks))).rejects.toThrow("verification");
});
it("stops after the first verified content-addressed occurrence without loading later history", async () => {
  const f = fixture("a".repeat(20_000));
  async function* source() { yield* f.chunks; throw new Error("must not read later history"); }
  expect(await assembleRunOutputBody(f.bodyId, source())).toHaveLength(20_000);
});
