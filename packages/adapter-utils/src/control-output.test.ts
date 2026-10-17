import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runChildProcess } from "./server-utils.js";
import {
  createSecretEnvRedactionControlStream,
  REDACTED_SECRET_ENV_VALUE,
} from "./secret-env-redaction.js";

const assistant = (content: string) => JSON.stringify({ role: "assistant", content });

describe("sanitized complete control-output records", () => {
  it.each(["stdout", "stderr"] as const)("delivers real %s controls once through split numeric data and unterminated EOF", async (stream) => {
    const record = JSON.stringify({ role: "assistant", content: "live", ignored: 123456 });
    const final = assistant("EOF");
    const logs: string[] = [];
    const controls: string[] = [];
    let resolved = false;
    const result = await runChildProcess(randomUUID(), process.execPath, ["-e", `
      const fs = require('node:fs');
      const record = ${JSON.stringify(record)};
      const fd = ${stream === "stdout" ? 1 : 2};
      const cut = record.indexOf('123456') + 3;
      fs.writeSync(fd, record.slice(0, cut));
      setTimeout(() => fs.writeSync(fd, record.slice(cut) + '\\n'), 20);
      setTimeout(() => fs.writeSync(fd, ${JSON.stringify(final)}), 40);
    `], {
      cwd: process.cwd(), env: { CLIENT_SECRET: "123456" }, timeoutSec: 3, graceSec: 1,
      onLog: async (pipe, text) => { if (pipe === stream) logs.push(text); },
      onControlOutput: async (pipe, records) => {
        expect(resolved).toBe(false);
        expect(pipe).toBe(stream);
        controls.push(records);
      },
    });
    resolved = true;
    expect(result.exitCode).toBe(0);
    expect(logs.join("")).toBe(result[stream]);
    expect(result[stream]).toContain('"ignored":***REDACTED***');
    expect(controls.join("").split("\n").map((line) => JSON.parse(line))).toEqual([
      { role: "assistant", content: "live", ignored: 0 }, JSON.parse(final),
    ]);
    expect(controls.join("")).not.toContain("123456");
  });

  it("emits complete records in order once, and emits the final unterminated record only at EOF", () => {
    const stream = createSecretEnvRedactionControlStream([], 4096);
    const first = assistant("first");
    const second = assistant("second");
    const final = assistant("final");
    expect(stream.push(first.slice(0, 11))).toBe("");
    expect(stream.push(first.slice(11) + "\n" + second + "\n" + final.slice(0, 8))).toBe(`${first}\n${second}\n`);
    expect(stream.push(final.slice(8))).toBe("");
    expect(stream.push("")).toBe("");
    expect(stream.flush()).toBe(final);
    expect(stream.flush()).toBe("");
  });

  it("sanitizes ignored numeric tokens into valid JSON while preserving unaffected record order", () => {
    const secret = "123456";
    const stream = createSecretEnvRedactionControlStream([secret], 4096);
    const first = JSON.stringify({ role: "assistant", content: "first", ignored: Number(secret) });
    const second = assistant("second");
    const split = first.indexOf(secret) + 3;
    expect(stream.push(first.slice(0, split))).toBe("");
    const out = stream.push(first.slice(split) + "\n" + second + "\n");
    expect(out.split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual([
      { role: "assistant", content: "first", ignored: 0 },
      { role: "assistant", content: "second" },
    ]);
    expect(out).not.toContain(secret);
    expect(stream.flush()).toBe("");
  });

  it("masks the entire string token, not just the protected substring", () => {
    const secret = "synthetic-control-string-secret";
    const stream = createSecretEnvRedactionControlStream([secret], 4096);
    const line = assistant(`prefix-${secret}-suffix`);
    const split = line.indexOf(secret) + 6;
    const out = stream.push(line.slice(0, split)) + stream.push(line.slice(split) + "\n") + stream.flush();
    expect(out).toBe(`${assistant(REDACTED_SECRET_ENV_VALUE)}\n`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("prefix-");
    expect(out).not.toContain("-suffix");
  });

  it("never repairs malformed quote-bearing originals into control events", () => {
    const secret = 'broken"quotation';
    const malformed = `{"role":"assistant","content":"${secret}"}`;
    const genuine = assistant("genuine");
    expect(() => JSON.parse(malformed)).toThrow();
    const stream = createSecretEnvRedactionControlStream([secret], 4096);
    const out = stream.push(`${malformed}\n${genuine}\n`) + stream.flush();
    expect(out).toBe(`${REDACTED_SECRET_ENV_VALUE}\n${genuine}\n`);
    expect(out).not.toContain(secret);
  });

  it("suppresses a protected span that covers JSON structure, then emits the next genuine record", () => {
    const protectedRecord = assistant("not an event");
    const genuine = assistant("genuine");
    const stream = createSecretEnvRedactionControlStream([protectedRecord], 4096);
    expect(stream.push(`${protectedRecord}\n${genuine}\n`)).toBe(`${REDACTED_SECRET_ENV_VALUE}\n${genuine}\n`);
    expect(stream.flush()).toBe("");
  });

  it("holds a cross-line secret prefix beyond the capture cap instead of reopening an apparent assistant record", () => {
    const falseRecord = assistant("protected apparent event");
    const secret = `private-prefix\n${falseRecord}\nprivate-suffix`;
    const prefix = secret.slice(0, -4);
    const genuine = assistant("genuine following record");
    const stream = createSecretEnvRedactionControlStream([secret], 12);
    const observed: string[] = [];
    // A complete apparent record lies inside an unresolved secret prefix, whose
    // size exceeds cap. Neither clipping nor a no-op push may authorize it.
    observed.push(stream.push(prefix));
    observed.push(stream.push(""));
    expect(observed).toEqual(["", ""]);
    observed.push(stream.push(secret.slice(-4) + "\n" + genuine + "\n"));
    observed.push(stream.flush());
    expect(observed.join("")).toBe(`${REDACTED_SECRET_ENV_VALUE}\n${REDACTED_SECRET_ENV_VALUE}\n${REDACTED_SECRET_ENV_VALUE}\n${genuine}\n`);
    for (const output of observed) {
      expect(output).not.toContain(secret);
      expect(output).not.toContain(falseRecord);
      expect(output).not.toContain("private-prefix");
      expect(output).not.toContain("private-suffix");
    }
  });

  it("suppresses the remainder of a clipped record and recovers at the next genuine newline-delimited record", () => {
    const falseSuffix = assistant("not a new record");
    const genuine = assistant("genuine");
    const stream = createSecretEnvRedactionControlStream([], 16);
    expect(stream.push("x".repeat(100))).toBe("");
    expect(stream.push(falseSuffix + "\n" + genuine + "\n")).toBe(`${genuine}\n`);
    expect(stream.flush()).toBe("");
  });

  it("does not promote a clipped valid-looking suffix into an unterminated EOF record", () => {
    const falseSuffix = assistant("not an EOF event");
    const stream = createSecretEnvRedactionControlStream([], falseSuffix.length);
    expect(stream.push("x".repeat(100) + falseSuffix)).toBe("");
    expect(stream.flush()).toBe("");
    expect(stream.flush()).toBe("");
  });

  it("inspects a complete batch before clipping retention even when records exceed cap", () => {
    const secret = "123456";
    const stream = createSecretEnvRedactionControlStream([secret], 8);
    const first = JSON.stringify({ role: "assistant", content: "first", ignored: Number(secret) });
    const second = assistant("second");
    expect(stream.push(`${first}\n${second}\n`)).toBe(
      `${JSON.stringify({ role: "assistant", content: "first", ignored: 0 })}\n${second}\n`,
    );
    expect(stream.flush()).toBe("");
  });

  it("never releases a matched raw cross-line secret at any chunk split", () => {
    const falseRecord = assistant("inside protected value");
    const secret = `secret-head\n${falseRecord}\nsecret-tail`;
    const genuine = assistant("genuine");
    const input = `${secret}\n${genuine}\n`;
    for (let split = 0; split <= input.length; split += 1) {
      const stream = createSecretEnvRedactionControlStream([secret], 4096);
      const observed = [stream.push(input.slice(0, split)), stream.push(input.slice(split)), stream.flush()];
      expect(observed.join("")).toBe(`${REDACTED_SECRET_ENV_VALUE}\n${REDACTED_SECRET_ENV_VALUE}\n${REDACTED_SECRET_ENV_VALUE}\n${genuine}\n`);
      for (const output of observed) {
        expect(output).not.toContain(secret);
        expect(output).not.toContain(falseRecord);
      }
    }
  });
});
