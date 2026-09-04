import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRP_V1_EVENT_TYPES,
  REDACTED_EVENT_VALUE,
  redactAgentAdapterConfig,
  redactEventPayload,
  redactSensitiveText,
  sanitizeRecord,
} from "../redaction.js";

describe("redaction", () => {
  it("keeps the discriminator allowlist in exact PRP v1 schema parity", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/paperclip-runner/protocol/schemas/event.schema.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { properties: { eventType: { enum: string[] } } };
    expect([...PRP_V1_EVENT_TYPES]).toEqual(schema.properties.eventType.enum);
  });

  it("preserves every discriminator in the cross-language replay stream", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/paperclip-runner/protocol/fixtures/replay/duplicate-event.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { events: Array<Record<string, unknown>> };

    for (const event of fixture.events) {
      const sanitized = redactEventPayload({ prpEvent: event });
      const envelope = sanitized?.prpEvent as Record<string, unknown>;
      expect(envelope.eventType).toBe(event.eventType);
      expect(envelope.sourceEventId).toBe(event.sourceEventId);
      expect(envelope.payload).toEqual(event.payload);
    }
  });

  it("redacts sensitive keys and nested secret values", () => {
    const input = {
      apiKey: "abc123",
      nested: {
        AUTH_TOKEN: "token-value",
        safe: "ok",
      },
      env: {
        OPENAI_API_KEY: "sk-openai",
        OPENAI_API_KEY_REF: {
          type: "secret_ref",
          secretId: "11111111-1111-1111-1111-111111111111",
          version: "aaa.bbb.ccc",
          projectionAllowlistKey: "aaa.bbb.ccc",
          token: "must-not-survive-reference-shape",
        },
        USER_API_KEY_REF: {
          type: "user_secret_ref",
          key: "OPENAI_API_KEY",
          password: "must-not-survive-user-reference-shape",
        },
        OPENAI_API_KEY_PLAIN: {
          type: "plain",
          value: "sk-plain",
        },
        PAPERCLIP_API_URL: "http://localhost:3100",
      },
    };

    const result = sanitizeRecord(input);

    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.nested).toEqual({
      AUTH_TOKEN: REDACTED_EVENT_VALUE,
      safe: "ok",
    });
    expect(result.env).toEqual({
      OPENAI_API_KEY: REDACTED_EVENT_VALUE,
      OPENAI_API_KEY_REF: {
        type: "secret_ref",
        secretId: "11111111-1111-1111-1111-111111111111",
      },
      USER_API_KEY_REF: {
        type: "user_secret_ref",
        key: "OPENAI_API_KEY",
      },
      OPENAI_API_KEY_PLAIN: {
        type: "plain",
        value: REDACTED_EVENT_VALUE,
      },
      PAPERCLIP_API_URL: "http://localhost:3100",
    });
  });

  it("redacts jwt-looking values even when key name is not sensitive", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = {
      session: jwt,
      opaque: "aaa.bbb.ccc",
      normal: "plain",
    };

    const result = sanitizeRecord(input);

    expect(result.session).toBe(REDACTED_EVENT_VALUE);
    expect(result.opaque).toBe(REDACTED_EVENT_VALUE);
    expect(result.normal).toBe("plain");
  });

  it("preserves Paperclip protocol schema identifiers", () => {
    expect(
      sanitizeRecord({
        schema: "paperclip.question_set.v1",
        nested: {
          schema: "paperclip.question_response.v1",
          runtimeSchema: "paperclip.runtime_request.v2",
          arbitraryProviderValue: "paperclip.question_set.v1",
        },
      }),
    ).toEqual({
      schema: "paperclip.question_set.v1",
      nested: {
        schema: "paperclip.question_response.v1",
        runtimeSchema: "paperclip.runtime_request.v2",
        arbitraryProviderValue: REDACTED_EVENT_VALUE,
      },
    });
  });

  it("preserves only known PRP v1 event discriminators inside validated envelopes", () => {
    const payload = {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        eventType: "tool.execution.started",
        payload: {
          eventType: "run.result.accepted",
          credential: "aaa.bbb.ccc",
        },
      },
      unrelated: {
        eventType: "workspace.file.referenced",
      },
    };

    const sanitized = redactEventPayload(payload);

    expect(sanitized).toEqual({
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        eventType: "tool.execution.started",
        payload: {
          eventType: REDACTED_EVENT_VALUE,
          credential: REDACTED_EVENT_VALUE,
        },
      },
      unrelated: {
        eventType: REDACTED_EVENT_VALUE,
      },
    });
    expect(redactEventPayload(sanitized)).toEqual(sanitized);
  });

  it("redacts unknown dotted event values even in a PRP-shaped envelope", () => {
    expect(
      redactEventPayload({
        schema: "paperclip.prp.event.v1",
        schemaVersion: 1,
        eventType: "attacker.supplied.token",
      })?.eventType,
    ).toBe(REDACTED_EVENT_VALUE);
  });

  it("does not trust discriminators inside a forged unknown schema", () => {
    expect(
      redactEventPayload({
        schema: "paperclip.attacker.control.v1",
        runtimeSchema: "paperclip.attacker.runtime.v1",
        schemaVersion: 1,
        eventType: "tool.execution.started",
      }),
    ).toEqual({
      schema: REDACTED_EVENT_VALUE,
      runtimeSchema: REDACTED_EVENT_VALUE,
      schemaVersion: 1,
      eventType: REDACTED_EVENT_VALUE,
    });
  });

  it("preserves native run span identities without weakening hostname redaction", () => {
    const spanNames = [
      "environment.workspace.realize",
      "native.coordinator.claim",
      "runner.transport.selected",
      "runner.prp.route.register",
      "runner.transport.connect",
      "runner.session.bootstrap",
      "runner.turn.submit",
      "runner.session.startup",
      "provider.turn.queue",
      "native.session.execute",
      "native.result.finalize",
      "task.run.measured",
    ];

    for (const span of spanNames) {
      const input = {
        schema: "paperclip.run-performance-span.v1",
        span,
        parentSpan: "native.session.execute",
        providerHostname: "api.openai.com",
      };
      const sanitized = redactEventPayload(input);

      expect(sanitized).toMatchObject({
        schema: input.schema,
        span,
        parentSpan: "native.session.execute",
        providerHostname: REDACTED_EVENT_VALUE,
      });
      expect(redactEventPayload(sanitized)).toEqual(sanitized);
    }

    expect(
      redactEventPayload({
        schema: "paperclip.run-performance-span.v1",
        span: "api.openai.com",
      })?.span,
    ).toBe(REDACTED_EVENT_VALUE);
    expect(
      redactEventPayload({
        schema: "paperclip.run-performance-span.v1",
        span: "runner.example.com",
      })?.span,
    ).toBe(REDACTED_EVENT_VALUE);
  });

  it("redacts payload objects while preserving null", () => {
    expect(redactEventPayload(null)).toBeNull();
    expect(redactEventPayload({ password: "hunter2", safe: "value" })).toEqual({
      password: REDACTED_EVENT_VALUE,
      safe: "value",
    });
  });

  it("redacts credentials in ordinary nested diagnostic strings", () => {
    const sanitized = redactEventPayload({
      message: "request failed with Authorization: Basic dXNlcjpwYXNz",
      diagnostic: {
        reason: "upstream returned Bearer live-provider-token",
        details: [
          "safe context",
          "proxyAuthorization Basic nested-proxy-secret",
          "aaa.bbb.ccc",
          ["Bearer nested-array-secret"],
        ],
      },
    });

    expect(sanitized).toEqual({
      message: `request failed with Authorization: ${REDACTED_EVENT_VALUE}`,
      diagnostic: {
        reason: `upstream returned Bearer ${REDACTED_EVENT_VALUE}`,
        details: [
          "safe context",
          `proxyAuthorization ${REDACTED_EVENT_VALUE}`,
          REDACTED_EVENT_VALUE,
          [`Bearer ${REDACTED_EVENT_VALUE}`],
        ],
      },
    });
    expect(redactEventPayload(sanitized)).toEqual(sanitized);
  });

  it("preserves authorization decision reasons in audit payloads", () => {
    expect(
      redactEventPayload({
        authorizationReason: "allow_scoped_agent_write",
        authorization: "Bearer secret",
        surface: "issue.comment.create",
      }),
    ).toEqual({
      authorizationReason: "allow_scoped_agent_write",
      authorization: REDACTED_EVENT_VALUE,
      surface: "issue.comment.create",
    });
  });

  /**
   * A removal receipt (PAP-17119) has to show what it revoked, so a fixed set of
   * count keys is exempt from the secret-key guard — but only while the value is
   * a number. The second half of this test is the point: the same key carrying
   * anything else is still blanked, so the exemption cannot be used to smuggle
   * material out under a familiar name.
   */
  it("keeps numeric removal-receipt counts but still redacts non-numeric values on the same keys", () => {
    expect(
      sanitizeRecord({
        secretsRevoked: 2,
        secretsRetainedShared: 0,
        credentialRefsCleared: 3,
        secretBindingsRemoved: 3,
        tokenIssuanceHashesCleared: 1,
        gatewayTokensRevoked: 0,
        appProfile: "deleted",
      }),
    ).toEqual({
      secretsRevoked: 2,
      secretsRetainedShared: 0,
      credentialRefsCleared: 3,
      secretBindingsRemoved: 3,
      tokenIssuanceHashesCleared: 1,
      gatewayTokensRevoked: 0,
      appProfile: "deleted",
    });

    expect(
      sanitizeRecord({
        secretsRevoked: "pasted-api-key-value",
        secretBindingsRemoved: { name: "tool_app.abc.headers_authorization" },
        tokenIssuanceHashesCleared: Number.NaN,
        gatewayTokensRevoked: ["pcgw_live_token"],
      }),
    ).toEqual({
      secretsRevoked: REDACTED_EVENT_VALUE,
      secretBindingsRemoved: REDACTED_EVENT_VALUE,
      tokenIssuanceHashesCleared: REDACTED_EVENT_VALUE,
      gatewayTokensRevoked: REDACTED_EVENT_VALUE,
    });
  });

  it("redacts common secret shapes from unstructured text", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const input = [
      "Authorization: Bearer live-bearer-token-value",
      `payload {"apiKey":"json-secret-value"}`,
      `paperclip {"PAPERCLIP_API_KEY":"paperclip-json-secret"}`,
      `escaped {\\"apiKey\\":\\"escaped-json-secret\\"}`,
      `export PAPERCLIP_API_KEY='paperclip-shell-secret'`,
      `GITHUB_TOKEN=${githubToken}`,
      `session=${jwt}`,
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(REDACTED_EVENT_VALUE);
    expect(result).not.toContain("live-bearer-token-value");
    expect(result).not.toContain("json-secret-value");
    expect(result).not.toContain("paperclip-json-secret");
    expect(result).not.toContain("escaped-json-secret");
    expect(result).not.toContain("paperclip-shell-secret");
    expect(result).not.toContain(githubToken);
    expect(result).not.toContain(jwt);
  });

  it("redacts authorization variants and standalone bearer credentials from diagnostic text", () => {
    const input = [
      "Authorization: Basic dXNlcjpwYXNz",
      "Authorization Basic uncolonized-secret",
      "proxyAuthorization Basic compound-secret",
      'Authorization Bearer abc"embedded-tail',
      'Authorization "Bearer quoted-secret"',
      'request failed with Bearer standalone"embedded-tail',
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result).toContain(`Authorization: ${REDACTED_EVENT_VALUE}`);
    expect(result).toContain(`Authorization ${REDACTED_EVENT_VALUE}`);
    expect(result).toContain(`proxyAuthorization ${REDACTED_EVENT_VALUE}`);
    expect(result).toContain(`Authorization "${REDACTED_EVENT_VALUE}"`);
    expect(result).toContain(`Bearer ${REDACTED_EVENT_VALUE}`);
    expect(result).not.toContain("dXNlcjpwYXNz");
    expect(result).not.toContain("uncolonized-secret");
    expect(result).not.toContain("compound-secret");
    expect(result).not.toContain("embedded-tail");
    expect(result).not.toContain("quoted-secret");
    expect(result).not.toContain("standalone-secret");
    expect(redactSensitiveText(result)).toBe(result);
  });

  it("redacts raw and escaped quote-delimited authorization values without leaking nested content", () => {
    const cases = [
      {
        input: 'prefix Authorization: Bearer "two word secret" suffix',
        expected: `prefix Authorization: ${REDACTED_EVENT_VALUE} suffix`,
      },
      {
        input: "prefix Authorization: Basic 'two word secret' suffix",
        expected: `prefix Authorization: ${REDACTED_EVENT_VALUE} suffix`,
      },
      {
        input: String.raw`prefix {\"Authorization\":\"Basic dXNlcjpwYXNz\"} suffix`,
        expected: String.raw`prefix {\"Authorization\":\"***REDACTED***\"} suffix`,
      },
      {
        input: String.raw`prefix Authorization: \"Bearer \\\"nested two word secret\\\"\" suffix`,
        expected: String.raw`prefix Authorization: \"***REDACTED***\" suffix`,
      },
    ];

    for (const { input, expected } of cases) {
      const result = redactSensitiveText(input);
      expect(result).toBe(expected);
      expect(result).not.toContain("two word secret");
      expect(result).not.toContain("dXNlcjpwYXNz");
      expect(redactSensitiveText(result)).toBe(result);
    }
  });

  it("redacts raw and serialized standalone bearer values without leaking quoted content", () => {
    const cases = [
      {
        input: 'prefix Bearer "two word secret" suffix',
        expected: `prefix Bearer "${REDACTED_EVENT_VALUE}" suffix`,
      },
      {
        input: "prefix Bearer 'two word secret' suffix",
        expected: `prefix Bearer '${REDACTED_EVENT_VALUE}' suffix`,
      },
      {
        input: String.raw`prefix Bearer \"two word secret\" suffix`,
        expected: String.raw`prefix Bearer \"***REDACTED***\" suffix`,
      },
      {
        input: String.raw`prefix Bearer \"outer \\\"nested secret\\\" value\" suffix`,
        expected: String.raw`prefix Bearer \"***REDACTED***\" suffix`,
      },
    ];

    for (const { input, expected } of cases) {
      const result = redactSensitiveText(input);
      expect(result).toBe(expected);
      expect(result).not.toContain("two word secret");
      expect(result).not.toContain("nested secret");
      expect(redactSensitiveText(result)).toBe(result);
    }
  });

  it("redacts token tails attached to raw and escaped closing credential quotes", () => {
    const cases = [
      {
        input: 'Authorization: Basic "abc"defg retry',
        expected: `Authorization: ${REDACTED_EVENT_VALUE}`,
      },
      {
        input: String.raw`Authorization: Basic \"abc\"defg retry`,
        expected: `Authorization: ${REDACTED_EVENT_VALUE}`,
      },
      {
        input: 'Bearer "abc"defg retry',
        expected: `Bearer "${REDACTED_EVENT_VALUE}"`,
      },
      {
        input: String.raw`Bearer \"abc\"defg retry`,
        expected: String.raw`Bearer \"***REDACTED***\"`,
      },
      {
        input: 'Authorization: Basic "abc"defg retry\nsafe context',
        expected: `Authorization: ${REDACTED_EVENT_VALUE}`,
      },
      {
        input:
          String.raw`Authorization: Basic \"abc\"defg retry` + "\nsafe context",
        expected: `Authorization: ${REDACTED_EVENT_VALUE}`,
      },
      {
        input: 'authorization="Bearer abc\ndef" status=401',
        expected: `authorization="${REDACTED_EVENT_VALUE}" status=401`,
      },
      {
        input: String.raw`authorization=\"Bearer abc
def\" status=401`,
        expected: String.raw`authorization=\"***REDACTED***\" status=401`,
      },
      {
        input: 'authorization="Bearer abc"\ndef" status=401',
        expected: `authorization="${REDACTED_EVENT_VALUE}" status=401`,
      },
      {
        input: String.raw`authorization=\"Bearer abc\"
def\" status=401`,
        expected: String.raw`authorization=\"***REDACTED***\" status=401`,
      },
      {
        input: 'authorization="Bearer abc"\ndef status=401',
        expected: `authorization="${REDACTED_EVENT_VALUE}"`,
      },
      {
        input: String.raw`authorization=\"Bearer abc\"
def status=401`,
        expected: String.raw`authorization=\"***REDACTED***\"`,
      },
      {
        input:
          'authorization="Bearer first-line"\nrequest failed with Bearer standalone"embedded-tail',
        expected: `authorization="${REDACTED_EVENT_VALUE}"\nrequest failed with Bearer ${REDACTED_EVENT_VALUE}`,
      },
      {
        input: String.raw`authorization=\"Bearer first-line\"
request failed with Bearer standalone\"embedded-tail`,
        expected: String.raw`authorization=\"***REDACTED***\"
request failed with Bearer ***REDACTED***`,
      },
      {
        input: String.raw`{\"authorization\":\"Bearer a\"b c\"} suffix`,
        expected: String.raw`{\"authorization\":\"***REDACTED***\"} suffix`,
      },
      {
        input: `{"authorization":"Bearer a"b c"} suffix`,
        expected: `{"authorization":"${REDACTED_EVENT_VALUE}"} suffix`,
      },
      {
        input: String.raw`{\"authorization\":\"Bearer a\" b c\"} suffix`,
        expected: String.raw`{\"authorization\":\"***REDACTED***\"} suffix`,
      },
      {
        input: `{"authorization":"Bearer a" b c"} suffix`,
        expected: `{"authorization":"${REDACTED_EVENT_VALUE}"} suffix`,
      },
    ];

    for (const { input, expected } of cases) {
      const result = redactSensitiveText(input);
      expect(result).toBe(expected);
      expect(result).not.toContain("abc");
      expect(result).not.toContain("defg");
      expect(result).not.toContain('a"b c');
      expect(result).not.toContain('a" b c');
      expect(redactSensitiveText(result)).toBe(result);
    }

    const sanitized = redactEventPayload({
      message: 'Authorization: Basic "abc"defg retry',
      malformedProviderText: '{"authorization":"Bearer a" b c"} suffix',
      authorization: 'Bearer a"b c"',
      nested: {
        diagnostics: [
          String.raw`Bearer \"abc\"defg retry`,
          String.raw`{\"authorization\":\"Bearer a\"b c\"} suffix`,
          String.raw`authorization=\"Bearer first-line
second-line\" status=401`,
          String.raw`authorization=\"Bearer first-line\"
second-line\" status=401`,
        ],
      },
    });
    expect(sanitized).toEqual({
      message: `Authorization: ${REDACTED_EVENT_VALUE}`,
      malformedProviderText: `{"authorization":"${REDACTED_EVENT_VALUE}"} suffix`,
      authorization: REDACTED_EVENT_VALUE,
      nested: {
        diagnostics: [
          String.raw`Bearer \"***REDACTED***\"`,
          String.raw`{\"authorization\":\"***REDACTED***\"} suffix`,
          String.raw`authorization=\"***REDACTED***\" status=401`,
          String.raw`authorization=\"***REDACTED***\" status=401`,
        ],
      },
    });
    expect(redactEventPayload(sanitized)).toEqual(sanitized);
  });

  it("redacts inline secrets from command metadata without hiding safe command text", () => {
    const input = {
      command:
        "custom-acp --token ghp_example_secret env OPENAI_API_KEY=sk-live-example custom-acp",
      commandArgs: [
        "--safe",
        "ok",
        "--token",
        "ghp_arg_secret",
        "--api-key=sk-inline-example",
      ],
      env: {
        PAPERCLIP_RESOLVED_COMMAND:
          "env OPENAI_API_KEY=sk-live-example custom-acp --token ghp_example_secret",
        SAFE_VALUE: "visible",
      },
    };

    const result = redactEventPayload(input);

    expect(result?.command).toBe(
      `custom-acp --token ${REDACTED_EVENT_VALUE} env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp`,
    );
    expect(result?.commandArgs).toEqual([
      "--safe",
      "ok",
      "--token",
      REDACTED_EVENT_VALUE,
      `--api-key=${REDACTED_EVENT_VALUE}`,
    ]);
    expect(result?.env).toEqual({
      PAPERCLIP_RESOLVED_COMMAND: `env OPENAI_API_KEY=${REDACTED_EVENT_VALUE} custom-acp --token ${REDACTED_EVENT_VALUE}`,
      SAFE_VALUE: "visible",
    });
  });

  it("redacts non-string command args after secret flags", () => {
    const result = redactEventPayload({
      commandArgs: ["--api-key", { nested: "secret-value" }, "safe-next"],
    });

    expect(result?.commandArgs).toEqual([
      "--api-key",
      REDACTED_EVENT_VALUE,
      "safe-next",
    ]);
  });

  it("does not treat bare args payloads as command args", () => {
    const result = redactEventPayload({
      args: ["--api-key", "not-a-command-secret"],
      argv: ["--api-key", "command-secret"],
    });

    expect(result?.args).toEqual(["--api-key", "not-a-command-secret"]);
    expect(result?.argv).toEqual(["--api-key", REDACTED_EVENT_VALUE]);
  });

  it("redacts every plaintext agent env binding while preserving secret references", () => {
    const plaintextValue = "adapter-env-value-must-not-leak";

    const result = redactAgentAdapterConfig({
      command: "pnpm agent:run",
      env: {
        EXISTING_VALUE: plaintextValue,
        NEW_VALUE: { type: "plain", value: plaintextValue },
        SECRET_REFERENCE: {
          type: "secret_ref",
          secretId: "55555555-5555-4555-8555-555555555555",
          version: "latest",
        },
        USER_SECRET_REFERENCE: {
          type: "user_secret_ref",
          key: "GITHUB_TOKEN",
        },
      },
    });

    expect(result).toEqual({
      command: "pnpm agent:run",
      env: {
        EXISTING_VALUE: { type: "plain", value: REDACTED_EVENT_VALUE },
        NEW_VALUE: { type: "plain", value: REDACTED_EVENT_VALUE },
        SECRET_REFERENCE: {
          type: "secret_ref",
          secretId: "55555555-5555-4555-8555-555555555555",
          version: "latest",
        },
        USER_SECRET_REFERENCE: {
          type: "user_secret_ref",
          key: "GITHUB_TOKEN",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(plaintextValue);
  });

  it("redacts non-env adapter keys while leaving env binding shapes intact", () => {
    const result = redactAgentAdapterConfig({
      command: "pnpm agent:run",
      apiKey: "adapter-level-secret",
      env: {
        API_KEY: "env-level-secret",
        AUTH_TOKEN: { type: "plain", value: "another-env-secret" },
      },
    });

    // Non-env keys still go through the shared payload sanitizer.
    expect(result.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(result.command).toBe("pnpm agent:run");

    // Env bindings keep their binding shape rather than collapsing to a bare
    // sentinel string, which is what a second sanitizer pass would produce for
    // these sensitive-looking key names.
    expect(result.env).toEqual({
      API_KEY: { type: "plain", value: REDACTED_EVENT_VALUE },
      AUTH_TOKEN: { type: "plain", value: REDACTED_EVENT_VALUE },
    });
  });

  it("redacts adapter configs that have no env block", () => {
    expect(redactAgentAdapterConfig({ command: "pnpm agent:run", apiKey: "secret" })).toEqual({
      command: "pnpm agent:run",
      apiKey: REDACTED_EVENT_VALUE,
    });
  });
});
