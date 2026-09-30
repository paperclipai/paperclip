import { describe, expect, it } from "vitest";
import type { heartbeatRuns } from "@paperclipai/db";
import { collectRunFailureDiagnostics, collectRunFailureSecretValues, redactRunFailureSecretValues, sanitizeRunFailureDiagnostics, sanitizeRunFailureText } from "../run-failure-diagnostics.js";

type Run = typeof heartbeatRuns.$inferSelect;
const run = (overrides: Partial<Run> = {}) => ({ resultJson: null, ...overrides }) as Run;
const collect = (error: unknown) => collectRunFailureDiagnostics(run(), { error });

describe("run failure diagnostics", () => {
  it.each(["restore_permission_denied", "restore_lock_timeout", "restore_unsafe_archive", "restore_failed"])(
    "includes the saved %s classification without copying workspace paths or results", (code) => {
      const result = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics(run({ resultJson: {
        workspaceRestoreFailure: code, workspaceRestorePath: "/private/workspace",
        executionBeforeRestore: { errorMessage: "private provider response" },
      } }), {}));
      expect(result.execution).toEqual({ workspaceRestoreFailure: code });
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  it.each([null, false, 1, "private arbitrary code", { error: "private" }])(
    "omits unknown workspace restore classifications (%j)", (value) => {
      const result = collectRunFailureDiagnostics(run({ resultJson: { workspaceRestoreFailure: value } }), {});
      expect(result.execution).not.toHaveProperty("workspaceRestoreFailure");
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );

  it("includes only bounded ACP activity fields, not tool names, identities, or output", () => {
    const result = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics(run({ resultJson: {
      acpLastEventAgeMs: 14_000_000, acpObservedEventCount: 9, acpPendingToolCount: 2,
      acpToolInventoryComplete: false, acpToolNames: ["private command"], lastEvent: "private output",
    } }), {}));
    expect(result.execution).toEqual({
      acpLastEventAgeMs: 14_000_000, acpObservedEventCount: 9, acpPendingToolCount: 2,
      acpToolInventoryComplete: false,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each([null, -1, Infinity, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, "private", {}])(
    "omits invalid ACP activity fields (%j)", (value) => {
      const result = collectRunFailureDiagnostics(run({ resultJson: {
        acpLastEventAgeMs: value, acpObservedEventCount: value, acpPendingToolCount: value,
        acpToolInventoryComplete: value,
      } }), {});
      expect(result.execution).toEqual({});
    },
  );

  it("selects declared environment secrets under opaque names and common credential keys", () => {
    expect(collectRunFailureSecretValues({
      CUSTOM_BINDING: "bound-opaque-value", ACCESS_TOKEN: "plain-opaque-value", REGION: "us-east-1", EMPTY_KEY: "",
    }, ["CUSTOM_BINDING"])).toEqual(["bound-opaque-value", "plain-opaque-value", "us-east-1"]);
    expect(collectRunFailureSecretValues({ PATH: "/usr/bin", CUSTOM_BINDING: "opaque" }, [], true)).toEqual(["opaque"]);
    expect(collectRunFailureSecretValues({ PATH: "secret-override" }, ["PATH"], true)).toEqual(["secret-override"]);
  });

  it("redacts encoded credentials and URL passwords without expanding replacement markers", () => {
    const secret = 'opaque/"credential';
    const values = collectRunFailureSecretValues({ DATABASE_URL: `postgres://user:${encodeURIComponent(secret)}@example/db` });
    const result = redactRunFailureSecretValues({ text: `${secret} ${encodeURIComponent(secret)} ${JSON.stringify(secret)}`, status: 503 }, [...values, "REDACTED"]);
    expect(result.text).not.toContain("opaque");
    expect(result.status).toBe(503);
    expect(result.text).not.toContain("***[REDACTED]");
  });

  it("preserves known boolean and numeric settings without exempting unknown or declared secrets", () => {
    const env = { PAPERCLIP_DB_BACKUP_ENABLED: "false", PAPERCLIP_DB_BACKUP_RETENTION_DAYS: "1" };
    expect(collectRunFailureSecretValues(env, [], true)).toEqual([]);
    expect(collectRunFailureSecretValues(env, ["PAPERCLIP_DB_BACKUP_ENABLED"], true)).toEqual(["false"]);
    expect(collectRunFailureSecretValues({ CUSTOM_BINDING: "1" }, [], true)).toEqual(["1"]);
    expect(collectRunFailureSecretValues({ PAPERCLIP_DB_BACKUP_ENABLED: "opaque" }, [], true)).toEqual(["opaque"]);
  });
  it("preserves generic exceptions, numeric codes and nested network causes", () => {
    const root = Object.assign(new Error("network failed"), { code: "ECONNRESET", statusCode: 502, request_id: "req-123" });
    const outer = Object.assign(new TypeError("adapter failed", { cause: root }), { code: -32000 });
    const result = sanitizeRunFailureDiagnostics(collect(outer));
    expect(result.exceptions).toMatchObject([
      { name: "TypeError", message: "adapter failed", code: "-32000" },
      { name: "Error", message: "network failed", code: "ECONNRESET", status: 502, requestId: "req-123" },
    ]);
    expect(result.exceptions[0].stack).toContain("run-failure-diagnostics.test.ts");
  });

  it("bounds cyclic, deep, and string causes without inspecting arbitrary error objects", () => {
    const cyclic = new Error("cycle"); cyclic.cause = cyclic;
    expect(collect(cyclic)).toMatchObject({ exceptions: [{ message: "cycle" }], truncatedFields: ["exceptions.cycle"] });
    let error = new Error("leaf");
    for (let i = 0; i < 10; i++) error = new Error(`level-${i}`, { cause: error });
    expect(collect(error).exceptions).toHaveLength(4);
    expect(collect(error).truncatedFields).toContain("exceptions.depth");
    expect(collect(new Error("outer", { cause: "string cause" })).exceptions).toHaveLength(2);
    const getter = Object.defineProperty({ message: "valid message" }, "response", { get: () => { throw new Error("must not read"); } });
    expect(collect(getter).exceptions).toEqual([{ message: "valid message" }]);
    expect(collect({ arbitrary: "private payload" }).exceptions).toEqual([]);
    expect(collect(Object.defineProperty({}, "message", { get: () => { throw new Error("bad getter"); } })).exceptions).toEqual([]);
  });

  it("redacts credential forms before truncation in all diagnostic text", () => {
    const failure = collectRunFailureDiagnostics(run({ resultJson: {
      terminalSessionFailure: { category: "service", title: 'password="secret-password"', details: 'Authorization: Bearer secret-bearer' },
    } }), { error: Object.assign(new Error('apiKey="secret-api-key"'), { cause: new Error('token="secret-token"') }), adapterErrorMeta: { causeMessage: 'password="secret-password"' } });
    const result = sanitizeRunFailureDiagnostics(failure);
    expect(JSON.stringify(result)).not.toContain("secret-");
    expect(sanitizeRunFailureText('x'.repeat(90) + ' password="secret-at-cut-boundary"', 110)).not.toContain("secret-at");
    expect(sanitizeRunFailureText('pass\x1b[31mword="secret-colored"', 200)).not.toContain("secret-colored");
  });

  it("reports truncation, preserves UTF-16 pairs, and keeps the total payload bounded", () => {
    const huge = "😀".repeat(100_000);
    let error = Object.assign(new Error(huge), { stack: huge });
    for (let i = 0; i < 5; i++) error = Object.assign(new Error(huge, { cause: error }), { stack: huge });
    const result = sanitizeRunFailureDiagnostics(collectRunFailureDiagnostics(run({ resultJson: {
      terminalSessionFailure: { category: "service", title: huge, details: huge, truncatedFields: ["details", "private-field"] },
    } }), { error }));
    expect(String(result.provider.title).length).toBeLessThanOrEqual(4096);
    expect(String(result.provider.details).length).toBeLessThanOrEqual(12288);
    expect(JSON.stringify(result)).not.toMatch(/[\ud800-\udfff]/u);
    expect(result.truncatedFields).toContain("provider.details");
    expect(result.truncatedFields).toContain("exceptions.0.stack");
    expect(result.truncatedFields).not.toContain("provider.private-field");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(150_000);
  });

  it("keeps scalar native and legacy execution evidence and rejects non-finite durations", () => {
    const result = collectRunFailureDiagnostics(run({
      runtimeMode: "native", nativePhase: "turn", driverKind: "codex", driverVersion: "1.2.3",
      startedAt: new Date(1000), finishedAt: new Date(8500),
      resultJson: { stopReason: "failed", timeoutFired: true, effectiveTimeoutSec: 60, errorFamily: "transient_upstream", summary: "private prose" },
    }), { phase: "execute" });
    expect(result.execution).toMatchObject({ runtimeMode: "native", nativePhase: "turn", driverKind: "codex", driverVersion: "1.2.3", durationMs: 7500, timeoutFired: true, effectiveTimeoutSec: 60, errorFamily: "transient_upstream" });
    expect(JSON.stringify(result)).not.toContain("private prose");
    expect(collectRunFailureDiagnostics(run({ startedAt: new Date(NaN), finishedAt: new Date() }), {}).execution).not.toHaveProperty("durationMs");
  });
});
