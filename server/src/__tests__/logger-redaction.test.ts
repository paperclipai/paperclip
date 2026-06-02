import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";
import {
  HTTP_LOG_REDACT_PATHS,
  createLoggerRedactionOptions,
  redactLoggerObject,
} from "../middleware/logger-redaction.js";

class CaptureStream extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.chunks.push(chunk.toString("utf8"));
    callback();
  }
}

describe("logger redaction", () => {
  it("redacts bearer authorization and BetterAuth session cookies from emitted log lines", () => {
    const bearerToken = "dummy-bearer-token-aiva-2096";
    const sessionCookie = "__Secure-paperclip-default.session_token=dummy-session-token-aiva-2096";
    const setCookie = "__Secure-paperclip-default.session_token=dummy-set-cookie-token-aiva-2096; Path=/";
    const responseCookie = "__Secure-paperclip-default.session_token=dummy-response-token-aiva-2096; Path=/";
    const bodyToken = "dummy-body-session-token-aiva-2096";
    const messageToken = "dummy-message-session-token-aiva-2096";
    const errorToken = "dummy-error-session-token-aiva-2096";
    const stream = new CaptureStream();
    const logger = pino(
      {
        level: "debug",
        ...createLoggerRedactionOptions(),
      },
      stream,
    );

    logger.info(
      {
        req: {
          headers: {
            authorization: `Bearer ${bearerToken}`,
            cookie: `${sessionCookie}; locale=en`,
            "set-cookie": [setCookie],
          },
        },
        res: {
          headers: {
            "set-cookie": [responseCookie],
          },
        },
        reqBody: {
          nested: {
            session_token: bodyToken,
          },
        },
        err: new Error(`failed to resolve session_token=${errorToken}`),
      },
      `synthetic request log set-cookie: __Secure-paperclip-default.session_token=${messageToken}; Path=/`,
    );

    const output = stream.chunks.join("");
    expect(output).not.toContain(bearerToken);
    expect(output).not.toContain(sessionCookie);
    expect(output).not.toContain(setCookie);
    expect(output).not.toContain(responseCookie);
    expect(output).not.toContain(bodyToken);
    expect(output).not.toContain(messageToken);
    expect(output).not.toContain(errorToken);
    expect(output).toContain(REDACTED_EVENT_VALUE);
  });

  it("keeps explicit HTTP header redact paths at the Pino boundary", () => {
    expect(HTTP_LOG_REDACT_PATHS).toEqual([
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['set-cookie']",
      "res.headers['set-cookie']",
    ]);
  });

  it("recursively redacts session_token-bearing custom logger context", () => {
    expect(
      redactLoggerObject({
        errorContext: {
          reason: "validation",
          session_token: "dummy-error-context-session-token-aiva-2096",
        },
        reqQuery: {
          nested: {
            authorization: "Bearer dummy-query-bearer-aiva-2096",
          },
        },
      }),
    ).toEqual({
      errorContext: {
        reason: "validation",
        session_token: REDACTED_EVENT_VALUE,
      },
      reqQuery: {
        nested: {
          authorization: REDACTED_EVENT_VALUE,
        },
      },
    });
  });
});
