import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { basePinoOptions } from "../middleware/logger.js";

describe("Tool gateway credential redaction across log record structure", () => {
  const GATEWAY_TOKEN =
    "pcgw_66666666-7777-8888-9999-000000000000.Z2F0ZXdheS1zZW50aW5lbC10d28";

  function productionLogger(chunks: string[]) {
    return pino(
      basePinoOptions,
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      }),
    );
  }

  it("redacts a child-logger binding that a later log call repeats under the same key", () => {
    const chunks: string[] = [];
    const root = productionLogger(chunks);

    root.child({ context: { gatewayToken: GATEWAY_TOKEN } }).info({ context: { phase: "invoke" } }, "repeated key");

    expect(chunks.join("")).not.toContain(GATEWAY_TOKEN);
  });

  it("redacts an unlisted credential header inside a nested header map", () => {
    const chunks: string[] = [];
    const root = productionLogger(chunks);
    const secret = "nested-connector-secret-value";

    root.info({ plugin: { connection: { headers: { "x-acme-connector-secret": secret, accept: "application/json" } } } }, "plugin metadata");

    const output = chunks.join("");
    expect(output).not.toContain(secret);
    expect(output).toContain("application/json");
  });
});
