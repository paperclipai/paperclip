import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import pino from "pino";
import { OAUTH_REDACT_PATHS } from "../logger.js";

describe("oauthLogger", () => {
  it("redacts access_token, refresh_token, and code", async () => {
    // We don't spy on the real oauthLogger's output: the production logger
    // uses pino.transport({ targets }), which runs in a worker thread, so
    // process.stdout.write spying from the main test process can't see its
    // output. Instead we build a parallel pino logger using the exported
    // OAUTH_REDACT_PATHS and route it to an in-memory stream. This test
    // verifies the redact-path list itself is correct; pino's redact
    // behavior under transport workers is pino's responsibility.
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(c));
    const parent = pino({ level: "info" }, stream);

    // Sanity: import the real module so a regression in its file/export shape still fails the test.
    const real = await import("../logger.js");
    expect(real.oauthLogger).toBeDefined();
    const child = parent.child(
      { component: "oauth" },
      { redact: { paths: OAUTH_REDACT_PATHS, censor: "[REDACTED]" } },
    );

    child.info(
      { access_token: "ACCESS_SECRET", refresh_token: "REFRESH_SECRET", code: "CODE_VAL" },
      "test event",
    );

    // Flush
    await new Promise((r) => setImmediate(r));
    const all = Buffer.concat(chunks).toString("utf8");
    expect(all).not.toContain("ACCESS_SECRET");
    expect(all).not.toContain("REFRESH_SECRET");
    expect(all).not.toContain("CODE_VAL");
    expect(all).toContain("[REDACTED]");
    expect(all).toContain("oauth");
  });
});
